/**
 * Sponsored-paymaster endpoint tests (spec 050): POST /v1/paymaster (ERC-7677).
 * Chain/provider access mocked via DI; signing is real (local ethers key standing in for KMS).
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { ethers } from 'ethers'
import { createApp } from '../src/server.js'
import { createKillSwitch } from '../src/policy/killswitch.js'
import { testConfig, mockProviders, mockEngine, ORIGIN_SECRET, TEST_NOW } from './helpers.js'
import { getHash, PAYMASTER_AND_DATA_MIN_LEN } from '../src/paymaster/build.js'

const now = () => TEST_NOW
const PM = ethers.getAddress('0x' + '11'.repeat(20))
const ENTRYPOINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'
// Hardhat well-known account #1 key — TEST ONLY.
const SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const SIGNER_ADDR = new ethers.Wallet(SIGNER_KEY).address

function pmConfig(extra = {}) {
  return testConfig({
    PAYMASTER_ADDRESS_137: PM,
    PM_SIGNER_PRIVATE_KEY: SIGNER_KEY,
    PM_MAX_COST_WEI: '2000000000000000000',
    PM_ACCOUNT_QUOTA_PER_MIN: '3',
    ...extra,
  })
}

function build({ config = pmConfig(), providers, killSwitch = createKillSwitch(false) } = {}) {
  const { app } = createApp(config, {
    // Deposit defaults AMPLE here so the grant-path tests keep testing what they test; the
    // deposit-gate describe below covers empty/low/unreadable pools explicitly.
    providers: providers ?? mockProviders(config, { depositWei: 10n ** 18n }),
    engineClient: mockEngine(),
    now,
    killSwitch,
    auditSink: () => {},
  })
  return app
}

function userOp(over = {}) {
  return {
    sender: ethers.getAddress('0x' + '22'.repeat(20)),
    nonce: '0x0',
    initCode: '0x',
    callData: '0x1234',
    callGasLimit: '0x186a0', // 100000
    verificationGasLimit: '0x30d40', // 200000
    preVerificationGas: '0xc350', // 50000
    maxFeePerGas: '0x3b9aca00', // 1 gwei
    maxPriorityFeePerGas: '0x3b9aca00',
    paymasterAndData: '0x',
    signature: '0x',
    ...over,
  }
}

const rpc = (app, method, params) =>
  request(app).post('/v1/paymaster').set('X-Origin-Auth', ORIGIN_SECRET).send({ jsonrpc: '2.0', id: 7, method, params })

function unpack(paymasterAndData) {
  const b = ethers.getBytes(paymasterAndData)
  return {
    paymaster: ethers.getAddress(ethers.hexlify(b.slice(0, 20))),
    validUntil: Number(ethers.toBigInt(b.slice(20, 26))),
    validAfter: Number(ethers.toBigInt(b.slice(26, 32))),
    signature: ethers.hexlify(b.slice(32)),
  }
}

describe('POST /v1/paymaster (spec 050)', () => {
  it('pm_getPaymasterStubData returns a full-length stub (no policy, no signing)', async () => {
    const res = await rpc(build(), 'pm_getPaymasterStubData', [userOp(), ENTRYPOINT, '0x89'])
    expect(res.status).to.equal(200)
    const pnd = res.body.result.paymasterAndData
    expect(ethers.getBytes(pnd).length).to.equal(PAYMASTER_AND_DATA_MIN_LEN) // 97 bytes
    expect(unpack(pnd).paymaster).to.equal(PM)
  })

  it('grants sponsorship with a signature recoverable to the signer (matches contract getHash)', async () => {
    const op = userOp()
    const res = await rpc(build(), 'pm_getPaymasterData', [op, ENTRYPOINT, '0x89'])
    expect(res.status).to.equal(200)
    const { paymaster, validUntil, validAfter, signature } = unpack(res.body.result.paymasterAndData)
    expect(paymaster).to.equal(PM)
    expect(validUntil).to.equal(TEST_NOW + 180)
    // recompute the exact digest the contract checks and recover the signer
    const hash = getHash(op, { paymaster: PM, chainId: 137, validUntil, validAfter })
    const recovered = ethers.verifyMessage(ethers.getBytes(hash), signature)
    expect(recovered).to.equal(SIGNER_ADDR)
  })

  it('refuses an unsupported chain (no paymaster configured) — self-submit', async () => {
    const res = await rpc(build(), 'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x13882']) // 80002 Amoy, no PM addr
    expect(res.body.error.data.code).to.equal('paymaster_unsupported_chain')
  })

  it('refuses a mismatched EntryPoint', async () => {
    const res = await rpc(build(), 'pm_getPaymasterData', [userOp(), '0x' + '99'.repeat(20), '0x89'])
    expect(res.body.error.data.code).to.equal('entrypoint_mismatch')
  })

  it('refuses when the killswitch is active', async () => {
    const app = build({ killSwitch: createKillSwitch(true) })
    const res = await rpc(app, 'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'])
    expect(res.body.error.data.code).to.equal('killswitch_active')
  })

  it('refuses an op over the per-op cost ceiling', async () => {
    // 350000 gas * 1e13 maxFee = 3.5e18 wei > 2e18 ceiling
    const res = await rpc(build(), 'pm_getPaymasterData', [userOp({ maxFeePerGas: '0x9184e72a000' }), ENTRYPOINT, '0x89'])
    expect(res.body.error.data.code).to.equal('cost_ceiling_exceeded')
  })

  it('refuses a sanctioned account (fail-closed) but leaves self-submit', async () => {
    const config = pmConfig()
    const app = build({ config, providers: mockProviders(config, { allowed: false }) })
    const res = await rpc(app, 'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'])
    expect(res.body.error.data.code).to.equal('sanctioned_signer')
  })

  it('enforces the per-account burst quota', async () => {
    const app = build() // PM_ACCOUNT_QUOTA_PER_MIN=3
    const op = userOp()
    for (let i = 0; i < 3; i++) {
      const ok = await rpc(app, 'pm_getPaymasterData', [op, ENTRYPOINT, '0x89'])
      expect(ok.body.result?.paymasterAndData, `call ${i}`).to.be.a('string')
    }
    const res = await rpc(app, 'pm_getPaymasterData', [op, ENTRYPOINT, '0x89'])
    expect(res.body.error.data.code).to.equal('quota_exceeded')
    expect(res.headers['retry-after']).to.be.a('string')
  })

  it('origin-locks the endpoint (missing X-Origin-Auth => 403)', async () => {
    const res = await request(build())
      .post('/v1/paymaster')
      .send({ jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterStubData', params: [userOp(), ENTRYPOINT, '0x89'] })
    expect(res.status).to.equal(403)
  })

  // US4 — sponsorship deposit runway on /status (operator-only).
  it('reports paymasterDepositRunwayHrs on /status for a chain with a paymaster', async () => {
    const app = build({ providers: mockProviders(pmConfig(), { depositWei: 5_000_000_000_000_000_000n }) }) // 5 native
    const res = await request(app).get('/status').set('X-Origin-Auth', ORIGIN_SECRET)
    expect(res.status).to.equal(200)
    // 5e18 deposit / 5e16 peak-burn-per-hr default = 100 hrs
    expect(res.body.chains['137'].paymasterDepositRunwayHrs).to.equal(100)
    // a chain WITHOUT a configured paymaster reports null
    expect(res.body.chains['80002'].paymasterDepositRunwayHrs).to.equal(null)
  })
})

/**
 * Deposit gate (the 2026-08-26 incident): production's EntryPoint deposit was ZERO and the grant
 * path signed anyway — members hit the bundler's raw AA31 mid-purchase. The gate refuses at the
 * endpoint (whose refusal the SPA answers by self-funding), with estate-rule semantics: definite
 * shortfall refuses, unreadable does not.
 */
describe('POST /v1/paymaster — deposit gate', () => {
  it('refuses with paymaster_deposit_low when the pool cannot cover the worst-case prefund', async () => {
    // The production state verbatim: balanceOf(paymaster) = 0.
    const config = pmConfig()
    const app = build({ config, providers: mockProviders(config, { depositWei: 0n }) })
    const res = await rpc(app, 'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'])
    expect(res.body.error.data.code).to.equal('paymaster_deposit_low')
    expect(res.body.error.message).to.match(/self-submit/)
  })

  it('signs when the deposit covers the v0.6 worst-case prefund (verification counted three times)', async () => {
    // userOp(): cgl 100k, vgl 200k, pvg 50k, maxFee 1 gwei → prefund = (100k + 3×200k + 50k) gas
    // = 750k gas × 1 gwei = 7.5e14 wei. EXACTLY the prefund must pass (the gate refuses strictly
    // below it); one wei below must refuse — proving the gate uses the ×3 prefund the EntryPoint
    // charges, not the flat totalGas sum.
    const need = 750_000n * 10n ** 9n
    const config = pmConfig()
    const ok = await rpc(
      build({ config, providers: mockProviders(config, { depositWei: need }) }),
      'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'],
    )
    expect(ok.body.result?.paymasterAndData, 'exact prefund sponsors').to.be.a('string')
    const low = await rpc(
      build({ config, providers: mockProviders(config, { depositWei: need - 1n }) }),
      'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'],
    )
    expect(low.body.error.data.code).to.equal('paymaster_deposit_low')
  })

  it('an UNREADABLE deposit does not refuse — an RPC blip is not an empty pool', async () => {
    const config = pmConfig()
    const providers = mockProviders(config, { depositWei: 10n ** 18n })
    const original = providers[137].call.bind(providers[137])
    providers[137].call = async (tx) => {
      if (String(tx.data).startsWith('0x70a08231')) throw new Error('rpc timeout')
      return original(tx)
    }
    const res = await rpc(build({ config, providers }), 'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'])
    expect(res.body.result?.paymasterAndData, 'sponsorship stays offered on an unconfirmed read').to.be.a('string')
  })

  it('a pool-empty refusal does not consume the member sponsorship quota', async () => {
    // ONE app, ONE quota store (3/min): three refused-for-deposit attempts, then the pool is
    // topped up (the balanceOf answer flips) — the grant must succeed. If the refusals had
    // burned quota, this fourth call would be quota_exceeded, so the test can actually fail.
    // The gate caches deposit reads for 30s of its injected clock; TEST_NOW is frozen, so the
    // flip must bust the cache by answering differently at the provider, and the cache window
    // is why the refusals themselves cost at most one read.
    const config = pmConfig()
    let depositAnswer = 0n
    const providers = mockProviders(config, { depositWei: 0n })
    const original = providers[137].call.bind(providers[137])
    providers[137].call = async (tx) => {
      if (String(tx.data).startsWith('0x70a08231')) {
        return '0x' + depositAnswer.toString(16).padStart(64, '0')
      }
      return original(tx)
    }
    let t = 0
    const clockNow = () => TEST_NOW + t
    const { app } = createApp(config, {
      providers,
      engineClient: mockEngine(),
      now: clockNow,
      killSwitch: createKillSwitch(false),
      auditSink: () => {},
    })
    for (let i = 0; i < 3; i += 1) {
      const r = await rpc(app, 'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'])
      expect(r.body.error.data.code).to.equal('paymaster_deposit_low')
    }
    depositAnswer = 10n ** 18n
    // 31s: past the gate's 30s read cache but INSIDE the 60s quota window — so if the three
    // refusals had burned quota, this call would be quota_exceeded, not a fresh window.
    t += 31
    const res = await rpc(app, 'pm_getPaymasterData', [userOp(), ENTRYPOINT, '0x89'])
    expect(res.body.result?.paymasterAndData, 'refusals must not have consumed the quota').to.be.a('string')
  })
})
