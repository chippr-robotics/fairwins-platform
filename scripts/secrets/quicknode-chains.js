#!/usr/bin/env node
/**
 * scripts/secrets/quicknode-chains.js — derive and VERIFY per-chain URLs from a QuickNode
 * multichain endpoint.
 *
 * QuickNode multichain endpoints serve every network enabled on them from ONE name + ONE token;
 * the chain is selected by a hostname infix:
 *
 *     https://<name>.<slug>.quiknode.pro/<token>      (most networks)
 *     https://<name>.quiknode.pro/<token>             (Ethereum mainnet — legacy, infixless)
 *
 * Ethereum mainnet accepts BOTH forms. Measured 2026-09-01 against the live endpoint: the
 * infixless URL and the `ethereum-mainnet`-infixed one each answer eth_chainId 0x1. This table
 * derives the infixless form because that is what the estate's stored payload has always used;
 * the infixed form is not wrong, just a second spelling of the same route.
 *
 * The estate holds five such endpoints (QUICKNODE_RPC_001..005; the numbering scheme is documented
 * on `managed_secret_ids` in infra/terraform/environments/prod/terraform.tfvars). ⚠ THE NETWORK AN
 * ENDPOINT WAS CREATED ON TELLS YOU NOTHING ABOUT ITS REACH: the Admin API reports every one of the
 * five as `is_multichain: true`, and 001 — the source for chains 1/10/8453/42161 — is reported as
 * `chain: matic`. Reasoning from the base network is how the tfvars comment came to describe 001 as
 * "base eth". Ask the chain, don't infer it.
 *
 * This tool exists because the failure mode of a hand-derived URL is the bad kind: a wrong infix
 * answers 200 WITH ANOTHER CHAIN'S STATE, not 401 — indistinguishable from working until funds move
 * on the wrong network. So derivation and verification live together, and verification asserts
 * eth_chainId. Measured 2026-09-01: chains 1, 10, 8453 and 42161 all PASS off endpoint 001.
 *
 * Usage (payload arrives on STDIN — never as argv, which is world-readable in /proc):
 *
 *   gcloud secrets versions access latest --secret=QUICKNODE_RPC_001_API \
 *     | node scripts/secrets/quicknode-chains.js --verify 1,10,8453,42161
 *
 * Output is one line per chain, REDACTED (host + chain verdict only — the token never reaches
 * stdout, spec 097 rule 4). `--print-env <chains>` additionally writes the derived URLS to fd 3
 * (and only fd 3), so a caller that genuinely needs the values redirects that fd into an env
 * file with restrictive permissions and nothing lands in a terminal scrollback by accident:
 *
 *   ... | node scripts/secrets/quicknode-chains.js --print-env 1,10 3>build.env
 *
 * `--provision <chains>` is the third mode, and the one that changes the estate: it derives,
 * VERIFIES, and only then adds the derived URL as a new version of that chain's own Secret Manager
 * container (`secretId` below). Verification is not a courtesy here — writing an unverified URL
 * stores a credential that answers 200 for the wrong chain, which is indistinguishable from a
 * working one until funds move on the wrong network — so a chain that fails --verify is NEVER
 * written, and one bad chain does not stop the others being reported:
 *
 *   gcloud secrets versions access latest --secret=QUICKNODE_RPC_001_API \
 *     | node scripts/secrets/quicknode-chains.js --provision 1,10,8453,42161
 *
 * The payload reaches `gcloud` on STDIN and is written WITHOUT a trailing newline: it never
 * touches argv (world-readable in /proc), never touches disk, and never reaches a log. A trailing
 * byte matters — infra/vm/common/fetch-secrets.sh emits `VAR='<payload>'` verbatim, so a stored
 * newline would land inside the quoted value.
 *
 * Non-EVM endpoints (003 sol, 004 btc, 005 zec) have no eth_chainId; --verify refuses chains it
 * has no slug for rather than guessing. This file is deliberately dependency-free (spec 097
 * rule 2: an npm dependency here re-resolves the root lockfile).
 */

/**
 * chainId → { slug, envName, secretId }. `slug: null` means the infix is OMITTED (Ethereum
 * mainnet). Extend deliberately; --verify proves a new slug against the chain before anyone
 * configures it.
 *
 * - `envName`  the FRONTEND build variable the derived URL belongs in (config/networks.js).
 *              A `VITE_` value compiles into the public bundle (spec 097 rule 5), so ONLY a
 *              domain-restricted QuickNode endpoint may ever be set there — never the archive
 *              credential this table provisions.
 * - `secretId` the WORKSTATION Secret Manager container that holds this chain's per-chain URL,
 *              or `null` where no per-chain endpoint is provisioned. It is the join between this
 *              table and scripts/secrets/registry.js, and `--provision` refuses a chain with no
 *              container rather than inventing a secret id.
 */
export const EVM_CHAIN_SLUGS = Object.freeze({
  // `slug: null` derives the legacy infixless host. The `ethereum-mainnet` infix is an equally
  // valid spelling (both verified 2026-09-01); do not "fix" this to the infixed form without
  // re-verifying, since the stored payloads and this table have to agree on one.
  1: { slug: null, envName: 'VITE_RPC_URL_MAINNET', secretId: 'fairwins-quicknode-ethereum-url' },
  10: { slug: 'optimism', envName: 'VITE_RPC_URL_OPTIMISM', secretId: 'fairwins-quicknode-optimism-url' },
  // 137 already had a per-chain container before this table gained secretIds. It is deliberately
  // NOT re-provisioned by --provision: the SAME payload also reaches alto as its ONLY RPC endpoint
  // (via the separate node-facing QUICKNODE_POLYGON_API), and alto has no failover. Repointing
  // Polygon is a deliberate rotation with the bundler in scope, never a side effect of filling in
  // the other four chains.
  137: { slug: 'matic', envName: 'VITE_RPC_URL_POLYGON', secretId: 'fairwins-quicknode-polygon-url' },
  8453: { slug: 'base-mainnet', envName: 'VITE_RPC_URL_BASE', secretId: 'fairwins-quicknode-base-url' },
  42161: { slug: 'arbitrum-mainnet', envName: 'VITE_RPC_URL_ARBITRUM', secretId: 'fairwins-quicknode-arbitrum-url' },
  // No per-chain Amoy endpoint is provisioned: there is no Amoy-cohort node, and the fork tests
  // that read AMOY_RPC_URL run against the public endpoint. `null` is the honest answer, and it
  // makes --provision refuse rather than write a chain nobody asked for.
  80002: { slug: 'matic-amoy', envName: 'VITE_RPC_URL_AMOY', secretId: null },
})

const URL_RE = /^https:\/\/([a-z0-9-]+)(?:\.([a-z0-9-]+))?\.quiknode\.pro\/([A-Za-z0-9_-]+)\/?\s*$/

/**
 * Split a multichain endpoint URL into { name, token }, tolerating both the infixed and the
 * infixless (Ethereum-mainnet-base) shapes. Throws on anything that is not a quiknode.pro URL —
 * deriving from an unrecognised payload would silently produce garbage hostnames.
 */
export function parseEndpoint(url) {
  const m = URL_RE.exec(String(url).trim())
  if (!m) throw new Error('payload is not a https://<name>[.<network>].quiknode.pro/<token> URL')
  return { name: m[1], token: m[3] }
}

/** Compose the URL for one chain from a parsed endpoint. */
export function deriveChainUrl(endpoint, chainId) {
  const entry = EVM_CHAIN_SLUGS[chainId]
  if (!entry) throw new Error(`no QuickNode slug is mapped for chainId ${chainId} — add it to EVM_CHAIN_SLUGS deliberately`)
  const { name, token } = endpoint
  return entry.slug === null
    ? `https://${name}.quiknode.pro/${token}/`
    : `https://${name}.${entry.slug}.quiknode.pro/${token}/`
}

/** Redact for display: host only, token replaced. */
export function redact(url) {
  return url.replace(/(quiknode\.pro\/)[^/]+/, '$1<redacted>')
}

async function ethChainId(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (!body?.result) throw new Error(`no result (${JSON.stringify(body?.error ?? body).slice(0, 120)})`)
  return Number.parseInt(body.result, 16)
}

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

/**
 * Add `url` as a new version of `secretId`, by piping it to gcloud's stdin.
 *
 * Deliberately shells out rather than using a client library — spec 097 rule 2: an npm dependency
 * in this tree re-resolves the root lockfile and drops the platform rolldown binary. The VM reads
 * secrets the same way, so there is one mechanism and one set of failure modes.
 */
async function addSecretVersion(secretId, url, project) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gcloud',
      ['secrets', 'versions', 'add', secretId, `--project=${project}`, '--data-file=-'],
      // stderr is inherited so an IAM failure is diagnosable; stdout is swallowed because gcloud
      // echoes the version resource name, not the payload — but there is no reason to print it.
      { stdio: ['pipe', 'ignore', 'inherit'] },
    )
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`gcloud exited ${code}`))))
    // No trailing newline: see the header. The payload is the URL and nothing else.
    child.stdin.end(url)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const verifyIdx = args.indexOf('--verify')
  const printIdx = args.indexOf('--print-env')
  const provisionIdx = args.indexOf('--provision')
  const modeIdx = [verifyIdx, printIdx, provisionIdx].find((i) => i !== -1)
  if (modeIdx === undefined) {
    console.error(
      'usage: ... | quicknode-chains.js --verify <chainIds,csv>\n'
      + '                              | --print-env <chainIds,csv> 3>out.env\n'
      + '                              | --provision <chainIds,csv>',
    )
    process.exit(2)
  }
  const chains = (args[modeIdx + 1] || '')
    .split(',').map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite)
  if (chains.length === 0) {
    console.error('no chainIds given')
    process.exit(2)
  }

  const project = process.env.FW_SECRETS_PROJECT || 'chippr-bots-site-wp'

  // Resolve every container BEFORE touching the network, so a chain with no provisioned endpoint
  // fails as a usage error rather than half way through a run that has already written others.
  if (provisionIdx !== -1) {
    const unprovisionable = chains.filter((c) => !EVM_CHAIN_SLUGS[c]?.secretId)
    if (unprovisionable.length > 0) {
      console.error(
        `no per-chain secret container is declared for chain(s) ${unprovisionable.join(', ')}. `
        + 'Add one to EVM_CHAIN_SLUGS, scripts/secrets/registry.js and both tfvars lists first — '
        + 'a secret written to an id nothing grants is unreadable at use time.',
      )
      process.exit(2)
    }
  }

  const endpoint = parseEndpoint(await readStdin())
  let failed = 0

  for (const chainId of chains) {
    const url = deriveChainUrl(endpoint, chainId)
    if (printIdx !== -1) {
      // fd 3 only — see the header. If fd 3 is not open this throws EBADF, which is the correct
      // outcome: the caller has not said where the credential should go, so it goes nowhere.
      const { envName } = EVM_CHAIN_SLUGS[chainId]
      const { writeSync } = await import('node:fs')
      writeSync(3, `${envName}=${url}\n`)
    }
    let verified = false
    try {
      const got = await ethChainId(url)
      if (got === chainId) {
        verified = true
        console.log(`PASS  chain ${chainId}  ${redact(url)}`)
      } else {
        failed += 1
        console.log(`FAIL  chain ${chainId}  ${redact(url)}  answered eth_chainId ${got} — WRONG CHAIN (a mis-derived infix returns 200, not 401)`)
      }
    } catch (e) {
      failed += 1
      console.log(`FAIL  chain ${chainId}  ${redact(url)}  unreachable/invalid: ${e.message}`)
    }

    // ONLY a verified URL is stored. An unverified one is the dangerous kind of wrong: it answers
    // 200 with another chain's state, so storing it would put a plausible-looking credential where
    // every later reader trusts it. A failure here is skipped, named, and counted.
    if (provisionIdx !== -1) {
      const { secretId } = EVM_CHAIN_SLUGS[chainId]
      if (!verified) {
        console.log(`SKIP  chain ${chainId}  ${secretId} not written — the derived URL did not verify`)
        continue
      }
      try {
        await addSecretVersion(secretId, url, project)
        console.log(`WROTE chain ${chainId}  ${secretId} <- new version (payload never printed)`)
      } catch (e) {
        failed += 1
        console.log(`FAIL  chain ${chainId}  could not add a version to ${secretId}: ${e.message}`)
      }
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

// Import-safe: tests import the pure helpers without running the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FATAL: ${e.message}`)
    process.exit(1)
  })
}
