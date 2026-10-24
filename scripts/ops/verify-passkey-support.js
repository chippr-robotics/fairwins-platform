#!/usr/bin/env node
/**
 * verify-passkey-support.js — is the passkey account stack (spec 041 + 050) actually
 * deployable / live on a given network?
 *
 * Why this exists
 * ---------------
 * `capabilities.passkeyAccounts` in `frontend/src/config/networks.js` is a claim about the
 * chain: that a member can create a Coinbase-Smart-Wallet-style account from a WebAuthn
 * credential, that the account address matches every other network (FR-023), and that a
 * UserOp can actually be included. Four things have to be true on-chain for that claim to
 * hold, and none of them can be assumed from "it's an EVM chain":
 *
 *   1. Arachnid CREATE2 proxy      — without it the factory cannot land at the SAME address
 *                                    everywhere, so account addresses would diverge per chain.
 *   2. EntryPoint v0.6             — the vendored CoinbaseSmartWallet v1.1.0 is pinned to
 *                                    v0.6; a chain without it needs a self-deploy first.
 *   3. FairWins accountFactory     — deployed (or deployable, given 1) at the FR-023 address.
 *   4. A working P-256 path        — RIP-7212 precompile (cheap) or WebAuthnSol's inlined FCL
 *                                    Solidity fallback (works everywhere, costs ~10x more gas).
 *
 * Plus one off-chain prerequisite that is config, not chain state: an ERC-4337 **bundler**
 * endpoint (`VITE_BUNDLER_URLS_<NET>`). A chain can be perfectly capable and still have the
 * passkey option hidden because nothing will relay the UserOp. This script reports that too,
 * so "why is passkey off on X" always has one answer.
 *
 * Usage
 * -----
 *   node scripts/ops/verify-passkey-support.js                 # every configured network
 *   node scripts/ops/verify-passkey-support.js --chain 8453    # one network
 *   node scripts/ops/verify-passkey-support.js --json          # machine-readable
 *   node scripts/ops/verify-passkey-support.js --strict        # exit non-zero if a network
 *                                                              # CLAIMS passkey support it
 *                                                              # cannot back on-chain
 *
 * Default exit code is 0 — "chain 61 has no EntryPoint" is a finding, not a failure. `--strict`
 * is the CI/gating mode: it fails only when a network is configured with a bundler (so the app
 * would offer passkey login there) while the chain cannot support it.
 *
 * Reads RPC endpoints from the environment when present (VITE_RPC_URL_* / <CHAIN>_RPC_URL),
 * otherwise falls back to the same public nodes config/networks.js defaults to. Mirrors
 * `scripts/ops/verify-protocol-addresses.js` in shape and, for the same reason, keeps its
 * targets as a plain literal: an ops guard that imported the config it checks could be fooled
 * by a bad import.
 */

/* eslint-disable no-console */

const { createHash } = require('node:crypto')

// Arachnid CREATE2 deterministic-deployment proxy — canonical singleton (deploy-account-stack.js).
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
// Canonical ERC-4337 EntryPoint v0.6 — the version the vendored account is pinned to.
const ENTRYPOINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'
// FairWins CoinbaseSmartWalletFactory — CREATE2 salt `fairwins.041.account-stack.v1`. Identical on
// every network by construction (FR-023); recorded in deployments/polygon-chain137-v2.json.
const ACCOUNT_FACTORY = '0xd519C25e9dEd0DAC586B764574100479CB318734'

// sha256 of the runtime bytecode each address MUST carry, taken from Polygon 137 (the network the
// stack is live on). "Something has code at this address" is not the question worth asking — a
// same-address contract belonging to something else is exactly the failure mode a deterministic
// deployment invites, and it would pass a naive eth_getCode check while bricking every UserOp.
// A hash mismatch is therefore reported as an IMPOSTER, never as "deployed".
const EXPECTED_CODE_SHA256 = {
  [CREATE2_DEPLOYER.toLowerCase()]: 'e0af82ad2e5188285db8ba0b2ae054d13f0fd4fe325c48c7f2dace48454404b9',
  [ENTRYPOINT_V06.toLowerCase()]: '009b0281380fb08973d2b8e55936c0d55f5a1d65ddc5713944420e119455620c',
  [ACCOUNT_FACTORY.toLowerCase()]: '3df5866afdb206ea0c1dec0d399c9b57b0614ffeced7ecaf8ffe29f811a7a8d7',
}
// RIP-7212 P-256 verification precompile + a known-good vector from the RIP test set. A chain
// that returns 1 has the cheap path; anything else falls back to WebAuthnSol's inlined FCL.
const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100'
const P256_VECTOR =
  '0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023' + // sha256 msg hash
  '2ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e18' + // r
  '4cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd76' + // s
  '2927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838' + // x
  'c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e' //  y

// Mirrors frontend/src/config/networks.js (chainId → rpc env vars + public defaults) and the
// per-network bundler env var name from the same file. `fallbackRpc` is a LIST because a probe
// that reports "unknown" when one public node is having a bad day tells an operator nothing —
// the first endpoint that answers with the right chain id wins.
const TARGETS = {
  1: {
    name: 'Ethereum',
    rpc: ['VITE_RPC_URL_MAINNET', 'MAINNET_RPC_URL'],
    fallbackRpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
    bundlerEnv: 'VITE_BUNDLER_URLS_MAINNET',
  },
  10: {
    name: 'Optimism',
    rpc: ['VITE_RPC_URL_OPTIMISM', 'OPTIMISM_RPC_URL'],
    fallbackRpc: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    bundlerEnv: 'VITE_BUNDLER_URLS_OPTIMISM',
  },
  61: {
    name: 'Ethereum Classic',
    rpc: ['VITE_RPC_URL_ETC', 'ETC_RPC_URL'],
    fallbackRpc: ['https://etc.etcdesktop.com'], // etc.rivet.link removed — NXDOMAIN
    bundlerEnv: 'VITE_BUNDLER_URLS_ETC',
  },
  63: {
    name: 'Ethereum Classic Mordor',
    rpc: ['VITE_RPC_URL_MORDOR', 'MORDOR_RPC_URL'],
    fallbackRpc: ['https://rpc.mordor.etccooperative.org'],
    bundlerEnv: 'VITE_BUNDLER_URLS_MORDOR',
  },
  137: {
    name: 'Polygon',
    rpc: ['VITE_RPC_URL_POLYGON', 'POLYGON_RPC_URL'],
    fallbackRpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    bundlerEnv: 'VITE_BUNDLER_URLS_POLYGON',
  },
  8453: {
    name: 'Base',
    rpc: ['VITE_RPC_URL_BASE', 'BASE_RPC_URL'],
    fallbackRpc: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    bundlerEnv: 'VITE_BUNDLER_URLS_BASE',
  },
  42161: {
    name: 'Arbitrum One',
    rpc: ['VITE_RPC_URL_ARBITRUM', 'ARBITRUM_RPC_URL'],
    fallbackRpc: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    bundlerEnv: 'VITE_BUNDLER_URLS_ARBITRUM',
  },
  11155111: {
    name: 'Sepolia',
    rpc: ['VITE_RPC_URL_SEPOLIA', 'SEPOLIA_RPC_URL'],
    fallbackRpc: ['https://ethereum-sepolia-rpc.publicnode.com'],
    bundlerEnv: 'VITE_BUNDLER_URLS_SEPOLIA',
  },
  560048: {
    name: 'Hoodi',
    rpc: ['VITE_RPC_URL_HOODI', 'HOODI_RPC_URL'],
    fallbackRpc: ['https://ethereum-hoodi-rpc.publicnode.com'],
    bundlerEnv: 'VITE_BUNDLER_URLS_HOODI',
  },
  80002: {
    name: 'Polygon Amoy',
    rpc: ['VITE_RPC_URL_AMOY', 'AMOY_RPC_URL'],
    // The frontend's build default (rpc-amoy.polygon.technology) is listed first for parity, but
    // it has been intermittently unreachable — hence the second entry.
    fallbackRpc: ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy-bor-rpc.publicnode.com'],
    bundlerEnv: 'VITE_BUNDLER_URLS_AMOY',
  },
}

const endpointsFor = (t) => {
  const override = t.rpc.map((k) => process.env[k]).find(Boolean)
  return override ? [override] : t.fallbackRpc
}

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error))
  return body.result
}

/**
 * Probe one address: does it carry code, and is that code the code we expect?
 * Returns 'missing' | 'ok' | 'imposter'.
 */
async function probeCode(url, address) {
  const code = await rpcCall(url, 'eth_getCode', [address, 'latest'])
  if (typeof code !== 'string' || code === '0x' || code === '0x0') return 'missing'
  const sha = createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex')
  return sha === EXPECTED_CODE_SHA256[address.toLowerCase()] ? 'ok' : 'imposter'
}

/**
 * Probe RIP-7212 by CALLing the precompile with a valid vector. Absent ⇒ the call returns empty
 * (an address with no code), so a `0x` result and a revert both mean "no precompile" — never an
 * error we should surface as a broken network.
 */
async function probeP256(url) {
  try {
    const ret = await rpcCall(url, 'eth_call', [{ to: P256_PRECOMPILE, data: P256_VECTOR }, 'latest'])
    return typeof ret === 'string' && ret !== '0x' && BigInt(ret) === 1n
  } catch {
    return false
  }
}

async function checkNetwork(chainId, target) {
  const bundlerUrls = (process.env[target.bundlerEnv] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const result = {
    chainId: Number(chainId),
    name: target.name,
    rpc: null,
    bundlerEnv: target.bundlerEnv,
    bundlerConfigured: bundlerUrls.length > 0,
    create2Deployer: null,
    entryPoint: null,
    accountFactory: null,
    p256Precompile: null,
    error: null,
  }

  const failures = []
  for (const url of endpointsFor(target)) {
    try {
      const onChainId = await rpcCall(url, 'eth_chainId', [])
      if (Number(BigInt(onChainId)) !== Number(chainId)) {
        // Wrong chain behind the endpoint — never probe it, the answers would describe
        // another chain's state entirely.
        failures.push(`${url}: reports chain ${Number(BigInt(onChainId))}`)
        continue
      }
      result.rpc = url
      result.create2Deployer = await probeCode(url, CREATE2_DEPLOYER)
      result.entryPoint = await probeCode(url, ENTRYPOINT_V06)
      result.accountFactory = await probeCode(url, ACCOUNT_FACTORY)
      result.p256Precompile = await probeP256(url)
      return result
    } catch (e) {
      failures.push(`${url}: ${e.message}`)
    }
  }
  result.error = `no usable RPC — ${failures.join('; ')}`
  return result
}

/**
 * Classify a probed network. The distinction that matters is LIVE (a member can use passkeys
 * today) vs READY (the chain supports the stack; only our own deploy/config is missing) vs
 * BLOCKED (the chain itself cannot host the stack without a self-deployed EntryPoint).
 */
function classify(r) {
  if (r.error) return { status: 'unknown', reason: r.error }
  const imposters = ['create2Deployer', 'entryPoint', 'accountFactory'].filter((k) => r[k] === 'imposter')
  if (imposters.length > 0) {
    return {
      status: 'imposter',
      reason: `${imposters.join(', ')} carries UNEXPECTED bytecode — a different contract sits at the canonical address`,
    }
  }
  if (r.entryPoint !== 'ok') {
    return {
      status: 'blocked',
      reason: `no EntryPoint v0.6 at ${ENTRYPOINT_V06} — self-deploy required before the stack can run`,
    }
  }
  if (r.create2Deployer !== 'ok' && r.accountFactory !== 'ok') {
    return {
      status: 'blocked',
      reason: 'no Arachnid CREATE2 proxy — the factory cannot land at the shared FR-023 address',
    }
  }
  if (r.accountFactory !== 'ok') {
    return { status: 'deployable', reason: 'chain supports the stack; accountFactory not deployed yet' }
  }
  if (!r.bundlerConfigured) {
    return { status: 'ready', reason: `stack deployed; ${r.bundlerEnv} unset so the option stays hidden` }
  }
  return { status: 'live', reason: 'stack deployed and a bundler is configured' }
}

function render(results) {
  const pad = (s, n) => String(s).padEnd(n)
  // Code probes are tri-state; booleans (7212, bundler) collapse to the same glyphs.
  const mark = (v) => {
    if (v === null) return ' ?  '
    if (v === 'ok' || v === true) return ' ✓  '
    if (v === 'imposter') return ' !! '
    return ' ✗  '
  }
  console.log('\nPasskey account stack — per-network capability probe (spec 041 / 050)\n')
  console.log(
    `${pad('chain', 28)}${pad('CREATE2', 9)}${pad('EntryPt', 9)}${pad('Factory', 9)}${pad('7212', 8)}${pad('bundler', 9)}status`
  )
  console.log('-'.repeat(96))
  for (const r of results) {
    const c = classify(r)
    console.log(
      `${pad(`${r.name} (${r.chainId})`, 28)}${pad(mark(r.create2Deployer), 9)}${pad(mark(r.entryPoint), 9)}` +
        `${pad(mark(r.accountFactory), 9)}${pad(mark(r.p256Precompile), 8)}${pad(mark(r.bundlerConfigured), 9)}${c.status}`
    )
    if (c.status !== 'live') console.log(`${' '.repeat(28)}↳ ${c.reason}`)
  }
  console.log(
    '\nlive = usable today · ready = deployed, needs a bundler URL · deployable = run deploy-account-stack.js' +
      '\nblocked = chain lacks a prerequisite · !! = wrong bytecode at a canonical address (investigate)' +
      '\n7212 ✗ = still works, via WebAuthnSol’s inlined FCL fallback (materially higher verification gas)\n'
  )
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const strict = args.includes('--strict')
  const chainArg = args.indexOf('--chain')
  const chains = chainArg >= 0 ? [args[chainArg + 1]] : Object.keys(TARGETS)

  const results = []
  for (const chainId of chains) {
    const target = TARGETS[chainId]
    if (!target) {
      console.error(`Unknown chain ${chainId} — known: ${Object.keys(TARGETS).join(', ')}`)
      process.exitCode = 1
      return
    }
    results.push(await checkNetwork(chainId, target))
  }

  if (json) {
    console.log(JSON.stringify(results.map((r) => ({ ...r, ...classify(r) })), null, 2))
  } else {
    render(results)
  }

  if (strict) {
    // Only a DISHONEST configuration fails: the app would offer passkey login on a chain that
    // cannot back it. Missing deploys and missing bundlers are reported, never gating.
    const dishonest = results.filter((r) => r.bundlerConfigured && ['blocked', 'deployable'].includes(classify(r).status))
    if (dishonest.length > 0) {
      console.error(
        `\n${dishonest.length} network(s) advertise passkey support they cannot back:\n  ` +
          dishonest.map((r) => `${r.name} (${r.chainId}) — ${classify(r).reason}`).join('\n  ')
      )
      process.exitCode = 1
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
