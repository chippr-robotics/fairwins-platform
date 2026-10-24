#!/usr/bin/env node
/**
 * Measure the block a CREATE2-deployed contract was created in, from PUBLIC sources only.
 *
 * ── WHY THIS EXISTS (spec 104 T-101, issue #1432) ────────────────────────────────────────────
 * `deployBlocks.<name>` is the lower bound every log scan in this repo starts from, and every
 * consumer degrades the same way — `record.deployBlocks?.X || 0` — so a MISSING entry does not
 * fail, it starts the scan at block 0 and hangs silently. `CLAUDE.md` already records that exact
 * failure for `safeProposalHub`. The entry therefore has to be recorded, and recorded correctly:
 * a block LATER than the contract's first event quietly misses the oldest members' records, which
 * is worse than the hang because nothing looks wrong.
 *
 * The obvious way to measure it — binary-search `eth_getCode` across history — needs an ARCHIVE
 * node. Measured 2026-09-06 against the endpoints this repo actually ships in
 * `config/networks.js`: only Mordor's public node answers historical `eth_getCode`. Ethereum,
 * Optimism, Base and Arbitrum (publicnode/allnodes) refuse it without a paid token, and Polygon's
 * is pruned. So the archive route cannot be the primary one, and an approach that needs a paid key
 * is an approach nobody runs.
 *
 * This script uses a route that needs no archive node and no API key, and that PROVES its answer
 * rather than estimating it:
 *
 *   1. Read the deployer EOA and the target address out of `deployments/`.
 *   2. Ask a Blockscout instance for the deployer's own transaction list (an EOA's txlist is
 *      indexed even on instances whose INTERNAL-transaction indexing is incomplete — Polygon's is,
 *      which is why `getcontractcreation` and `is_contract` both answer wrongly there for a
 *      CREATE2 contract, and why neither can be used).
 *   3. For each tx sent to the deterministic CREATE2 deployer, recompute
 *      `CREATE2(deployer, salt, keccak(initcode))` from THAT TX'S OWN CALLDATA.
 *   4. The tx whose recomputed address equals the target is the deployment. Its block is the
 *      answer, and the match is arithmetic — not a claim by an indexer we would have to trust.
 *
 * Step 4 is the point: an explorer can be wrong or behind (Polygon's says `is_contract: false`
 * for a contract with 1357 bytes of code), but keccak over the calldata cannot be. The explorer is
 * used only to ENUMERATE candidate transactions; the identification is done here.
 *
 * Usage:
 *   node scripts/ops/find-deploy-block.js --contract accountFactory
 *   node scripts/ops/find-deploy-block.js --contract accountFactory --chain 137 --write
 *   node scripts/ops/find-deploy-block.js --contract accountFactory --topic0 0x… --verify-before
 *
 * `--write` records `deployBlocks.<contract>` into the matching `deployments/*.json`. It REFUSES
 * to write a block later than the first event when `--topic0` is supplied, because that is the
 * silent-loss case above.
 */

const fs = require('fs')
const path = require('path')
const { keccak256, getCreate2Address } = require('ethers')

/** The canonical deterministic CREATE2 deployer (Arachnid), used by this repo's deploy scripts. */
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

/**
 * Blockscout instances, per chain. These are read-only, keyless and public.
 * A chain absent here simply cannot be measured this way and is reported as such — never guessed.
 */
const BLOCKSCOUT = {
  1: 'https://eth.blockscout.com',
  10: 'https://optimism.blockscout.com',
  61: 'https://etc.blockscout.com',
  63: 'https://etc-mordor.blockscout.com',
  137: 'https://polygon.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
}

const DEPLOYMENTS = path.join(__dirname, '..', '..', 'deployments')

function loadRecords() {
  return fs
    .readdirSync(DEPLOYMENTS)
    .filter((f) => f.endsWith('-v2.json'))
    .map((f) => ({ file: path.join(DEPLOYMENTS, f), json: JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, f), 'utf8')) }))
}

async function getJson(url, { timeoutMs = 45000, tries = 3 } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
      return await res.json()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw lastErr
}

/**
 * Enumerate the deployer's transactions to the CREATE2 deployer and identify the one that
 * produced `target`. Returns `{ block, timestamp, hash }` or null when no tx matches.
 */
async function findCreate2Deploy({ base, deployer, target }) {
  assertHex(deployer, 20, 'deployer address')
  assertHex(target, 20, 'contract address')
  const wanted = target.toLowerCase()
  let page = 1
  // Blockscout pages at 10k; a deployer with more history than this pages through rather than
  // silently truncating — a truncated list would read as "not deployed here", a false absence.
  for (;;) {
    const body = await getJson(
      `${base}/api?module=account&action=txlist&address=${deployer}&sort=asc&page=${page}&offset=10000`
    )
    const rows = Array.isArray(body?.result) ? body.result : []
    if (body?.status !== '1' && rows.length === 0) {
      if (page === 1) throw new Error(body?.message || 'txlist unavailable')
      return null
    }
    for (const tx of rows) {
      if ((tx.to || '').toLowerCase() !== CREATE2_DEPLOYER.toLowerCase()) continue
      const input = String(tx.input || '').replace(/^0x/, '')
      if (input.length <= 64) continue
      let addr
      try {
        addr = getCreate2Address(CREATE2_DEPLOYER, '0x' + input.slice(0, 64), keccak256('0x' + input.slice(64)))
      } catch {
        continue
      }
      if (addr.toLowerCase() === wanted) {
        return { block: Number(tx.blockNumber), timestamp: Number(tx.timeStamp), hash: tx.hash }
      }
    }
    if (rows.length < 10000) return null
    page += 1
  }
}

/** Earliest block carrying `topic0` for `address`, via Blockscout's full-history getLogs. */
async function firstEventBlock({ base, address, topic0 }) {
  assertHex(address, 20, 'contract address')
  assertHex(topic0, 32, 'topic0')
  const body = await getJson(
    `${base}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${address}&topic0=${topic0}`,
    { timeoutMs: 120000 }
  )
  const rows = Array.isArray(body?.result) ? body.result : []
  if (rows.length === 0) return { count: 0, first: null }
  const blocks = rows.map((r) => parseInt(r.blockNumber, 16))
  return { count: rows.length, first: Math.min(...blocks) }
}

/**
 * Contract names come from `--contract` and are used as a JSON key and a search token. Only
 * identifier characters are accepted, and anything else is REFUSED rather than escaped: this
 * value decides which key gets rewritten in a record of on-chain authority, and a refusal is
 * legible where a silently-escaped oddity is not.
 */
function assertSafeContractName(contract) {
  if (!/^[A-Za-z0-9_]+$/.test(String(contract))) {
    throw new Error(`unsafe contract name: ${contract}`)
  }
}

/**
 * Shape-check a value before it is interpolated into a request URL.
 *
 * Two reasons, and the second is the one that bites. An `&` in either value would silently add a
 * query parameter — the same injection family CodeQL caught in the regexes. And a merely
 * MALFORMED address needs rejecting just as firmly: the enumeration below would find no matching
 * transaction and report "no CREATE2 transaction produces <target>", which reads as a measured
 * absence rather than as a typo. A confident wrong answer is the failure this whole tool exists
 * to prevent, so a bad input has to stop rather than answer.
 */
function assertHex(value, bytes, what) {
  // Length checked separately so the pattern stays STATIC — see the regex-injection note above.
  const v = String(value)
  if (!/^0x[0-9a-fA-F]*$/.test(v) || v.length !== 2 + bytes * 2) {
    throw new Error(`${what} must be 0x followed by ${bytes * 2} hex characters; got: ${value}`)
  }
}

/**
 * Insert `deployBlocks.<contract>` by editing the file's TEXT, not by re-serialising it.
 *
 * A `JSON.parse` → `JSON.stringify` round-trip rewrites bytes it was never asked to touch: it
 * un-escapes `\u2014`/`\u2026` and normalises trailing newlines, which on the first run here
 * reformatted Mordor's key-compromise write-off note and mainnet's final byte. Those diffs are
 * semantically identical and completely unwanted — a record of on-chain authority is the last
 * file that should carry incidental churn, because the next reader cannot tell it was incidental.
 */
function writeDeployBlock(file, contract, block) {
  assertSafeContractName(contract)
  const text = fs.readFileSync(file, 'utf8')
  const entry = `"${contract}": ${block}`

  const existing = text.match(/(\n(\s*)"deployBlocks":\s*\{)([\s\S]*?)(\n\s*\})/)
  if (existing) {
    const [full, open, indent, body, close] = existing
    // Located by string search and a STATIC regex on the remainder — never by a pattern built
    // from `contract`. Interpolating an argument into a RegExp is regex injection (CodeQL flagged
    // exactly this), and escaping it would leave a sanitiser that has to stay correct forever;
    // not building the pattern at all leaves nothing to get wrong.
    const keyAt = body.indexOf(`"${contract}"`)
    if (keyAt !== -1) {
      const tail = body.slice(keyAt + contract.length + 2)
      const value = tail.match(/^(\s*:\s*)(\d+)/)
      if (value) {
        // Replace just the digits, leaving every other byte alone.
        const start = keyAt + contract.length + 2 + value[1].length
        const replaced = body.slice(0, start) + block + body.slice(start + value[2].length)
        fs.writeFileSync(file, text.replace(full, open + replaced + close))
        return
      }
    }
    const sep = body.trim() === '' ? '' : ','
    fs.writeFileSync(file, text.replace(full, `${open}${body}${sep}\n${indent}  ${entry}${close}`))
    return
  }

  // No deployBlocks object at all: append one before the record's final closing brace, matching
  // the file's own trailing-newline convention rather than imposing one.
  const lastBrace = text.lastIndexOf('}')
  const before = text.slice(0, lastBrace).replace(/\s*$/, '')
  const after = text.slice(lastBrace)
  fs.writeFileSync(file, `${before},\n  "deployBlocks": {\n    ${entry}\n  }\n${after}`)
}

async function main() {
  const args = process.argv.slice(2)
  const arg = (name, fallback = null) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? fallback : args[i + 1]
  }
  const contract = arg('contract')
  const onlyChain = arg('chain') ? Number(arg('chain')) : null
  const topic0 = arg('topic0')
  const write = args.includes('--write')

  // An operator typo should read as a usage error, not a stack trace.
  if (contract && !/^[A-Za-z0-9_]+$/.test(contract)) {
    console.error(`--contract must be an identifier (letters, digits, underscore); got: ${contract}`)
    process.exit(2)
  }
  if (!contract) {
    console.error('usage: find-deploy-block.js --contract <name> [--chain <id>] [--topic0 <hash>] [--write]')
    process.exit(2)
  }

  const records = loadRecords().filter((r) => r.json?.contracts?.[contract])
  let failures = 0

  for (const rec of records) {
    const chainId = Number(rec.json.chainId)
    if (onlyChain && chainId !== onlyChain) continue
    const target = rec.json.contracts[contract]
    // ETC's record carries no `deployer`. The CREATE2 address depends on the deterministic
    // deployer, salt and initcode — NOT on the EOA that sent the tx — so an override is a
    // hypothesis to be TESTED by the recomputation below, never an assumption baked into a result.
    const deployer = rec.json.deployer || arg('deployer')
    const base = BLOCKSCOUT[chainId]
    const label = `${rec.json.network} (${chainId})`
    const recorded = rec.json.deployBlocks?.[contract]

    if (!base) {
      console.log(`${label}: no public Blockscout instance configured — NOT measurable this way${recorded ? ` (recorded ${recorded})` : ''}`)
      continue
    }
    if (!deployer) {
      console.log(`${label}: no deployer recorded — cannot enumerate candidate transactions`)
      continue
    }

    try {
      const found = await findCreate2Deploy({ base, deployer, target })
      if (!found) {
        console.log(`${label}: no CREATE2 transaction from ${deployer} produces ${target}`)
        continue
      }
      let note = ''
      if (topic0) {
        const { count, first } = await firstEventBlock({ base, address: target, topic0 })
        note = ` · events=${count}${first === null ? '' : ` first=${first}`}`
        if (first !== null && found.block > first) {
          console.error(`${label}: REFUSING — deploy block ${found.block} is AFTER the first event ${first}`)
          failures += 1
          continue
        }
      }
      console.log(
        `${label}: ${contract} deployed at block ${found.block} (${new Date(found.timestamp * 1000).toISOString()}) tx ${found.hash}${note}`
      )
      if (write) {
        writeDeployBlock(rec.file, contract, found.block)
        console.log(`  → recorded in ${path.basename(rec.file)}`)
      }
    } catch (err) {
      console.log(`${label}: could not measure — ${err.message}`)
    }
  }
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
