/**
 * Readiness gate for the passkey full-stack e2e job — asserts on CONTENT, never on a 200.
 *
 * Every check here exists because its cheaper cousin has already lied to somebody:
 *
 *  - a TCP connect or an HTTP 200 from the bundler proves only that something is listening. The
 *    origin-lock nginx in front of production alto serves its own 200 that never reaches alto, and
 *    that is precisely the check that stayed green through the 2026-07-12 stall. So alto is asked
 *    `eth_supportedEntryPoints` and the answer must NAME the EntryPoint this chain has.
 *  - the relay gateway's /status returns `"status":"ok"` unconditionally, so "ok" is not evidence
 *    of anything. What is asked instead is a real sponsorship stub for this chain — which only
 *    answers when PAYMASTER_ADDRESS_<chainId> is configured — plus the kill switch being off.
 *  - a deployed paymaster with an empty EntryPoint deposit sponsors nothing; the deposit is read
 *    and must be positive, because "sponsored" is a claim about a pool that can pay.
 *
 * Dependency-free on purpose (node 22 globals only): this runs before Cypress and must not be able
 * to fail for a reason of its own.
 *
 *   node scripts/e2e/passkey-stack/wait-for-stack.js
 * env: RPC_URL CHAIN_ID ENTRYPOINT ACCOUNT_FACTORY PAYMASTER ALTO_URL GATEWAY_URL TIMEOUT_MS
 */
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545'
const CHAIN_ID = Number(process.env.CHAIN_ID || 80002)
const ENTRYPOINT = process.env.ENTRYPOINT || '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'
const ACCOUNT_FACTORY = process.env.ACCOUNT_FACTORY || ''
const PAYMASTER = process.env.PAYMASTER || ''
const ALTO_URL = process.env.ALTO_URL || 'http://127.0.0.1:4337'
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8787'
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 180000)

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method} -> ${JSON.stringify(body.error)}`)
  return body.result
}

/** Every check returns void or throws; the message it throws IS the diagnosis in the job log. */
const checks = [
  {
    name: 'chain answers as the expected network',
    async run() {
      const id = Number(await rpc(RPC_URL, 'eth_chainId'))
      if (id !== CHAIN_ID) throw new Error(`node reports chainId ${id}, expected ${CHAIN_ID}`)
    },
  },
  {
    name: 'EntryPoint v0.6 carries code',
    async run() {
      const code = await rpc(RPC_URL, 'eth_getCode', [ENTRYPOINT, 'latest'])
      if (!code || code === '0x') throw new Error(`no code at EntryPoint ${ENTRYPOINT}`)
    },
  },
  {
    name: 'account factory carries code',
    async run() {
      if (!ADDRESS_RE.test(ACCOUNT_FACTORY)) throw new Error('ACCOUNT_FACTORY is not set — the account stack deploy did not report one')
      const code = await rpc(RPC_URL, 'eth_getCode', [ACCOUNT_FACTORY, 'latest'])
      if (!code || code === '0x') throw new Error(`no code at accountFactory ${ACCOUNT_FACTORY}`)
    },
  },
  {
    name: 'paymaster deposit can pay for an operation',
    async run() {
      if (!ADDRESS_RE.test(PAYMASTER)) throw new Error('PAYMASTER is not set — the paymaster deploy did not report one')
      const code = await rpc(RPC_URL, 'eth_getCode', [PAYMASTER, 'latest'])
      if (!code || code === '0x') throw new Error(`no code at verifyingPaymaster ${PAYMASTER}`)
      // EntryPoint.balanceOf(paymaster) — selector 0x70a08231 + left-padded address.
      const data = '0x70a08231' + PAYMASTER.toLowerCase().replace(/^0x/, '').padStart(64, '0')
      const raw = await rpc(RPC_URL, 'eth_call', [{ to: ENTRYPOINT, data }, 'latest'])
      const deposit = BigInt(raw)
      if (deposit === 0n) throw new Error('paymaster EntryPoint deposit is 0 — nothing could be sponsored')
      console.log(`      deposit ${deposit} wei`)
    },
  },
  {
    name: 'alto serves THIS EntryPoint on THIS chain',
    async run() {
      const id = Number(await rpc(ALTO_URL, 'eth_chainId'))
      if (id !== CHAIN_ID) throw new Error(`alto reports chainId ${id}, expected ${CHAIN_ID}`)
      const eps = await rpc(ALTO_URL, 'eth_supportedEntryPoints')
      const listed = (Array.isArray(eps) ? eps : []).map((e) => String(e).toLowerCase())
      if (!listed.includes(ENTRYPOINT.toLowerCase())) {
        throw new Error(`alto supports [${listed.join(', ') || 'nothing'}], not ${ENTRYPOINT}`)
      }
    },
  },
  {
    name: 'relay gateway is up with sponsorship armed',
    async run() {
      const res = await fetch(`${GATEWAY_URL}/status`)
      const status = await res.json()
      if (status.status !== 'ok') throw new Error(`/status -> ${JSON.stringify(status).slice(0, 200)}`)
      if (status.killSwitch !== false) throw new Error('gateway boots with the kill switch ACTIVE — sponsorship would refuse every op')
    },
  },
  {
    name: 'the gateway will actually sponsor on this chain',
    async run() {
      // pm_getPaymasterStubData costs the pool nothing and touches no policy, but it only answers
      // when PAYMASTER_ADDRESS_<chainId> is configured — which is the fact under test.
      const res = await fetch(`${GATEWAY_URL}/v1/paymaster`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'pm_getPaymasterStubData',
          params: [{ sender: PAYMASTER }, ENTRYPOINT, `0x${CHAIN_ID.toString(16)}`],
        }),
      })
      const body = await res.json()
      const pmd = body?.result?.paymasterAndData
      if (!pmd) throw new Error(`no sponsorship stub: ${JSON.stringify(body).slice(0, 300)}`)
      if (!String(pmd).toLowerCase().startsWith(PAYMASTER.toLowerCase())) {
        throw new Error(`stub names paymaster ${String(pmd).slice(0, 42)}, expected ${PAYMASTER}`)
      }
    },
  },
]

async function main() {
  const deadline = Date.now() + TIMEOUT_MS
  for (const check of checks) {
    let lastError = 'never ran'
    let passed = false
    while (Date.now() < deadline) {
      try {
        await check.run()
        passed = true
        break
      } catch (e) {
        lastError = e.message
        await sleep(2000)
      }
    }
    if (!passed) {
      console.error(`::error::passkey stack not ready — ${check.name}: ${lastError}`)
      process.exit(1)
    }
    console.log(`  ✓ ${check.name}`)
  }
  console.log('passkey stack ready')
}

main().catch((e) => {
  console.error(`::error::readiness check crashed: ${e.stack || e.message}`)
  process.exit(1)
})
