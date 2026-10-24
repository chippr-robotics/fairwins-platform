/**
 * Spec 067 T075/T076 — the bridge status machine.
 *
 * This suite is deliberately hostile to the happy path. The failure this feature is least allowed
 * to have is a transfer shown as finished when the destination network has not delivered, so the
 * matrix below spends most of its length on the ways a bridge does NOT complete: a "filled" upstream
 * with no fill transaction, an expiry, a refund, a reverted origin transaction, a gateway outage, a
 * chain read that returns nothing, and a late transfer with no service reachable at all.
 *
 * Covered:
 *   - the full state matrix (FR-009), including partial evidence and backwards-observation guards;
 *   - `needs_attention` as a NON-terminal state that still resolves both ways (FR-011);
 *   - gateway status fetch + its honest-unavailable taxonomy;
 *   - the on-chain fallback that keeps an in-flight bridge resolvable without the gateway (FR-053);
 *   - a simulated APP RESTART: the module graph is torn down and re-imported, and the transfer's
 *     true status is recovered from the persisted ledger alone (FR-010, SC-004).
 *
 * No network and no chain: fetch is stubbed and providers are plain objects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toEventSelector } from 'viem'
import { encodeEventLog } from '../../../test/helpers/encodeEventLog'
import {
  BRIDGE_POLL_INTERVAL_MS,
  BRIDGE_STATUS_SOURCE,
  BridgeStatusUnavailable,
  SPOKE_POOL_ABI,
  bridgeStatusAvailable,
  deriveBridgeState,
  evidenceFromGatewayStatus,
  fetchBridgeStatus,
  isPastExpectedBy,
  isTerminalBridgeState,
  listLiveBridges,
  readOnChainEvidence,
  reconcileBridge,
  reconcileBridges,
  spokePoolAddress,
} from '../bridgeStatus'
import {
  BRIDGE_STATE,
  captureBridgeSubmission,
  listBridgeEntries,
} from '../../../data/ledger/sources/bridgeLedgerSource'
import { LEDGER_STATUS } from '../../../data/ledger/constants'
import { __clearClientLedger } from '../../../data/ledger/ledgerClientStore'

// Fixture logs are built from the SAME fragments the module parses, via the shared viem helper —
// `Interface.encodeEventLog` has no single viem twin (spec 110). SPOKE_POOL_ABI is the parsed form.
const encodeSpokeLog = (name, values) => encodeEventLog(SPOKE_POOL_ABI, name, values)
const spokeTopic = (name) => toEventSelector(SPOKE_POOL_ABI.find((i) => i.type === 'event' && i.name === name))

const BASE = 'https://relayer.fairwins.example'
const ACCOUNT = '0xAbCd000000000000000000000000000000000001'
const ORIGIN = 137
const DESTINATION = 1
const DEPOSIT_ID = '123456'
const SRC_TX = `0x${'11'.repeat(32)}`
const DST_TX = `0x${'22'.repeat(32)}`
const REFUND_TX = `0x${'33'.repeat(32)}`
const NOW = 1_800_000_000_000
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const MEMBER = '0x1111111111111111111111111111111111111111'

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** A gateway status DTO, shaped exactly as `services/relay-gateway/src/bridge/status.js` serves it. */
const dto = (over = {}) => ({
  originChainId: ORIGIN,
  depositId: DEPOSIT_ID,
  state: 'in_flight',
  upstreamStatus: 'pending',
  fillTxHash: null,
  refundTxHash: null,
  depositTxHash: SRC_TX,
  destinationChainId: DESTINATION,
  fetchedAt: new Date(NOW).toISOString(),
  stale: false,
  ...over,
})

/** Capture a real, persisted submission so reconciliation runs against the true store. */
function submit(over = {}) {
  return captureBridgeSubmission(ACCOUNT, ORIGIN, {
    depositId: DEPOSIT_ID,
    destinationChainId: DESTINATION,
    srcTxHash: SRC_TX,
    amountRaw: '1000000000',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    feeAmountRaw: '0',
    recipient: MEMBER,
    expectedBy: NOW + 600_000,
    ...over,
  })
}

const entryFor = (account = ACCOUNT) =>
  listBridgeEntries(account, ORIGIN).find((e) => e.depositId === DEPOSIT_ID)

/** Build a real, ABI-encoded SpokePool log so the fallback is exercised through actual decoding. */
function fillLog({ name = 'FilledV3Relay', depositId = DEPOSIT_ID, originChainId = ORIGIN, txHash = DST_TX, fillType = 0 } = {}) {
  const values =
    name === 'FilledV3Relay'
      ? [
          USDC_POLYGON, USDC_ETHEREUM, 1_000_000n, 996_500n, originChainId, originChainId, Number(depositId),
          1_800_003_600, 0, '0x0000000000000000000000000000000000000000', MEMBER, MEMBER, MEMBER, '0x',
          [MEMBER, '0x', 996_500n, fillType],
        ]
      : [
          `0x${'00'.repeat(12)}${USDC_POLYGON.slice(2)}`,
          `0x${'00'.repeat(12)}${USDC_ETHEREUM.slice(2)}`,
          1_000_000n, 996_500n, originChainId, originChainId, BigInt(depositId),
          1_800_003_600, 0, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(12)}${MEMBER.slice(2)}`,
          `0x${'00'.repeat(12)}${MEMBER.slice(2)}`, `0x${'00'.repeat(12)}${MEMBER.slice(2)}`, `0x${'00'.repeat(32)}`,
          [`0x${'00'.repeat(12)}${MEMBER.slice(2)}`, `0x${'00'.repeat(32)}`, 996_500n, fillType],
        ]
  const encoded = encodeSpokeLog(name, values)
  return { ...encoded, transactionHash: txHash, address: spokePoolAddress(DESTINATION) }
}

function depositLog({ depositId = DEPOSIT_ID } = {}) {
  const encoded = encodeSpokeLog('V3FundsDeposited', [
    USDC_POLYGON, USDC_ETHEREUM, 1_000_000n, 996_500n, DESTINATION, Number(depositId),
    1_799_999_900, 1_800_003_600, 0, MEMBER, MEMBER, '0x0000000000000000000000000000000000000000', '0x',
  ])
  return { ...encoded, transactionHash: SRC_TX, address: spokePoolAddress(ORIGIN) }
}

beforeEach(() => {
  __clearClientLedger()
  vi.stubEnv('VITE_RELAYER_URL', BASE)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  __clearClientLedger()
})

// ---------------------------------------------------------------------------------------------
describe('deriveBridgeState — the full matrix (FR-009)', () => {
  const derive = (over) => deriveBridgeState({ now: NOW, expectedBy: NOW + 600_000, ...over })

  it('holds at submitted while nothing has been observed', () => {
    const r = derive({ current: BRIDGE_STATE.SUBMITTED, evidence: {} })
    expect(r.state).toBe(BRIDGE_STATE.SUBMITTED)
    expect(r.changed).toBe(false)
    expect(r.reason).toBe('unchanged')
  })

  it('a mined origin transaction gives source_confirmed, not in flight', () => {
    const r = derive({ current: BRIDGE_STATE.SUBMITTED, evidence: { sourceMined: true, depositIndexed: false } })
    expect(r.state).toBe(BRIDGE_STATE.SOURCE_CONFIRMED)
    expect(r.changed).toBe(true)
  })

  it('an indexed deposit gives in_flight', () => {
    const r = derive({ current: BRIDGE_STATE.SOURCE_CONFIRMED, evidence: { sourceMined: true, depositIndexed: true } })
    expect(r.state).toBe(BRIDGE_STATE.IN_FLIGHT)
  })

  it('DELIVERED requires a destination transaction hash and nothing else produces it', () => {
    const withHash = derive({ current: BRIDGE_STATE.IN_FLIGHT, evidence: { depositIndexed: true, dstTxHash: DST_TX } })
    expect(withHash.state).toBe(BRIDGE_STATE.DELIVERED)
    expect(withHash.dstTxHash).toBe(DST_TX)
    expect(withHash.reason).toBe('destination_fill')

    // The dangerous input: an upstream that SAYS filled but hands over no fill transaction. It is an
    // under-claim by design — the transfer stays in flight until the hash exists.
    const claimOnly = derive({
      current: BRIDGE_STATE.IN_FLIGHT,
      evidence: { depositIndexed: true, upstreamStatus: 'filled', dstTxHash: null },
    })
    expect(claimOnly.state).toBe(BRIDGE_STATE.IN_FLIGHT)
    expect(claimOnly.changed).toBe(false)
  })

  it('a long-elapsed transfer is never completed by the clock alone', () => {
    const r = derive({ current: BRIDGE_STATE.IN_FLIGHT, evidence: {}, expectedBy: NOW - 1, now: NOW + 86_400_000 })
    expect(r.state).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(r.state).not.toBe(BRIDGE_STATE.DELIVERED)
  })

  it('REFUNDED requires a refund transaction hash', () => {
    const withHash = derive({ current: BRIDGE_STATE.IN_FLIGHT, evidence: { refundTxHash: REFUND_TX } })
    expect(withHash.state).toBe(BRIDGE_STATE.REFUNDED)
    expect(withHash.refundTxHash).toBe(REFUND_TX)

    const expiredOnly = derive({ current: BRIDGE_STATE.IN_FLIGHT, evidence: { expired: true, refundTxHash: null } })
    expect(expiredOnly.state).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(expiredOnly.reason).toBe('upstream_expired')
  })

  it('a reverted origin transaction is FAILED and is judged before any other evidence', () => {
    const r = derive({ current: BRIDGE_STATE.SUBMITTED, evidence: { sourceMined: true, sourceReverted: true, dstTxHash: DST_TX } })
    expect(r.state).toBe(BRIDGE_STATE.FAILED)
    expect(r.failureReason).toMatch(/did not go through/i)
  })

  it('past expectedBy an in-flight transfer needs attention, and the clock never beats settlement', () => {
    const late = derive({ current: BRIDGE_STATE.IN_FLIGHT, evidence: { depositIndexed: true }, expectedBy: NOW - 1 })
    expect(late.state).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(late.reason).toBe('past_expected_by')

    const lateButDelivered = derive({
      current: BRIDGE_STATE.IN_FLIGHT,
      evidence: { depositIndexed: true, dstTxHash: DST_TX },
      expectedBy: NOW - 1,
    })
    expect(lateButDelivered.state).toBe(BRIDGE_STATE.DELIVERED)
  })

  it('needs_attention is NOT terminal — it still resolves to delivered or refunded (FR-011)', () => {
    expect(isTerminalBridgeState(BRIDGE_STATE.NEEDS_ATTENTION)).toBe(false)

    const delivered = derive({
      current: BRIDGE_STATE.NEEDS_ATTENTION,
      evidence: { dstTxHash: DST_TX },
      expectedBy: NOW - 1,
    })
    expect(delivered.state).toBe(BRIDGE_STATE.DELIVERED)

    const refunded = derive({
      current: BRIDGE_STATE.NEEDS_ATTENTION,
      evidence: { refundTxHash: REFUND_TX },
      expectedBy: NOW - 1,
    })
    expect(refunded.state).toBe(BRIDGE_STATE.REFUNDED)
  })

  it('needs_attention stays put while it is still late and nothing new is known', () => {
    const r = derive({ current: BRIDGE_STATE.NEEDS_ATTENTION, evidence: { depositIndexed: true }, expectedBy: NOW - 1 })
    expect(r.state).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(r.changed).toBe(false)
  })

  it.each([BRIDGE_STATE.DELIVERED, BRIDGE_STATE.REFUNDED, BRIDGE_STATE.FAILED])(
    '%s is terminal: no later evidence moves it',
    (state) => {
      expect(isTerminalBridgeState(state)).toBe(true)
      const r = derive({ current: state, evidence: { refundTxHash: REFUND_TX, dstTxHash: DST_TX, sourceReverted: true } })
      expect(r.state).toBe(state)
      expect(r.changed).toBe(false)
      expect(r.reason).toBe('terminal')
    },
  )

  it('never walks a transfer backwards on a stale or partial observation', () => {
    const r = derive({ current: BRIDGE_STATE.IN_FLIGHT, evidence: { sourceMined: true, depositIndexed: false } })
    expect(r.state).toBe(BRIDGE_STATE.IN_FLIGHT)
    expect(r.changed).toBe(false)
  })

  it('treats an unrecognised current state as submitted rather than trusting it', () => {
    const r = derive({ current: 'probably_fine', evidence: { depositIndexed: true } })
    expect(r.state).toBe(BRIDGE_STATE.IN_FLIGHT)
  })

  it('has a usable default when called with nothing at all', () => {
    expect(deriveBridgeState().state).toBe(BRIDGE_STATE.SUBMITTED)
  })

  it('isPastExpectedBy ignores a missing or zero window instead of treating it as elapsed', () => {
    expect(isPastExpectedBy(null, NOW)).toBe(false)
    expect(isPastExpectedBy(0, NOW)).toBe(false)
    expect(isPastExpectedBy(NOW + 1, NOW)).toBe(false)
    expect(isPastExpectedBy(NOW, NOW)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
describe('evidenceFromGatewayStatus', () => {
  it('takes the gateway HASHES, not its verdict', () => {
    const e = evidenceFromGatewayStatus(dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: DST_TX }))
    expect(e.dstTxHash).toBe(DST_TX)
    expect(e.depositIndexed).toBe(true)
    expect(e.source).toBe(BRIDGE_STATUS_SOURCE.GATEWAY)
  })

  it('a hash-free "delivered" cannot promote anything', () => {
    const e = evidenceFromGatewayStatus(dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: null }))
    expect(e.dstTxHash).toBeNull()
    expect(deriveBridgeState({ current: BRIDGE_STATE.IN_FLIGHT, evidence: e, now: NOW }).state).toBe(BRIDGE_STATE.IN_FLIGHT)
  })

  it('carries refund and expiry through unchanged', () => {
    expect(evidenceFromGatewayStatus(dto({ state: 'refunded', refundTxHash: REFUND_TX })).refundTxHash).toBe(REFUND_TX)
    expect(evidenceFromGatewayStatus(dto({ state: 'expired' })).expired).toBe(true)
  })

  it('an unrecognised upstream vocabulary proves only that the deposit exists', () => {
    const e = evidenceFromGatewayStatus(dto({ state: null, upstreamStatus: 'somethingNew' }))
    expect(e.depositIndexed).toBe(true)
    expect(e.dstTxHash).toBeNull()
    expect(e.upstreamStatus).toBe('somethingNew')
  })

  it('answers a junk body with no evidence at all', () => {
    expect(evidenceFromGatewayStatus(null).source).toBe(BRIDGE_STATUS_SOURCE.NONE)
    expect(evidenceFromGatewayStatus('nope').depositIndexed).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
describe('fetchBridgeStatus', () => {
  it('asks the gateway on the ORIGIN chain path with the deposit id as a query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(200, dto()))
    vi.stubGlobal('fetch', fetchImpl)
    const body = await fetchBridgeStatus({ originChainId: ORIGIN, depositId: DEPOSIT_ID })
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/v1/bridge/137/status?depositId=123456`, expect.any(Object))
    expect(body.upstreamStatus).toBe('pending')
  })

  it('an unconfigured gateway is a stated capability-off verdict and never touches the network', async () => {
    vi.stubEnv('VITE_RELAYER_URL', '')
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const err = await fetchBridgeStatus({ originChainId: ORIGIN, depositId: DEPOSIT_ID }).catch((e) => e)
    expect(err).toBeInstanceOf(BridgeStatusUnavailable)
    expect(err.code).toBe('unconfigured')
    expect(err.disabled).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('separates "operator turned it off" from "try again"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(503, { error: { code: 'bridge_disabled', reason: 'off' } })))
    const off = await fetchBridgeStatus({ originChainId: ORIGIN, depositId: DEPOSIT_ID }).catch((e) => e)
    expect(off.disabled).toBe(true)
    expect(off.retryable).toBe(false)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(503, { error: { code: 'upstream_unavailable', reason: 'down' } })))
    const later = await fetchBridgeStatus({ originChainId: ORIGIN, depositId: DEPOSIT_ID }).catch((e) => e)
    expect(later.disabled).toBe(false)
    expect(later.retryable).toBe(true)
  })

  it('reports a network failure as retryable rather than as an answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const err = await fetchBridgeStatus({ originChainId: ORIGIN, depositId: DEPOSIT_ID }).catch((e) => e)
    expect(err.code).toBe('network_error')
    expect(err.retryable).toBe(true)
  })

  it('refuses a Bitcoin (string) network id and a non-numeric deposit id before any request', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const chain = await fetchBridgeStatus({ originChainId: 'bitcoin', depositId: DEPOSIT_ID }).catch((e) => e)
    expect(chain.code).toBe('unsupported_chain')
    const deposit = await fetchBridgeStatus({ originChainId: ORIGIN, depositId: 'abc' }).catch((e) => e)
    expect(deposit.code).toBe('invalid_deposit')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('bridgeStatusAvailable needs both a bridging network and a configured gateway', () => {
    expect(bridgeStatusAvailable(ORIGIN)).toBe(true)
    expect(bridgeStatusAvailable(61)).toBe(false) // Ethereum Classic — no Across deployment (FR-006c)
    expect(bridgeStatusAvailable('bitcoin')).toBe(false)
    vi.stubEnv('VITE_RELAYER_URL', '')
    expect(bridgeStatusAvailable(ORIGIN)).toBe(false)
  })

  it('polls on a member-visible cadence rather than a hot loop', () => {
    expect(BRIDGE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000)
  })
})

// ---------------------------------------------------------------------------------------------
describe('readOnChainEvidence — the gateway-free fallback (FR-053)', () => {
  const originProvider = (over = {}) => ({
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, logs: [depositLog()] }),
    ...over,
  })
  const destProvider = (logs = []) => ({
    getBlockNumber: vi.fn().mockResolvedValue(20_000_000),
    getLogs: vi.fn().mockResolvedValue(logs),
  })

  it('reads a fill from the destination chain and reports it as the delivery evidence', async () => {
    const dest = destProvider([fillLog()])
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider(),
      destinationProvider: dest,
    })
    expect(e.dstTxHash).toBe(DST_TX)
    expect(e.depositIndexed).toBe(true)
    expect(e.sourceReverted).toBe(false)
    expect(deriveBridgeState({ current: BRIDGE_STATE.IN_FLIGHT, evidence: e, now: NOW }).state).toBe(BRIDGE_STATE.DELIVERED)
  })

  it('reads the post-rename FilledRelay vocabulary too', async () => {
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider(),
      destinationProvider: destProvider([fillLog({ name: 'FilledRelay' })]),
    })
    expect(e.dstTxHash).toBe(DST_TX)
  })

  it('accepts a slow fill — the asset landed, which is what delivered means', async () => {
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider(),
      destinationProvider: destProvider([fillLog({ fillType: 2 })]),
    })
    expect(e.dstTxHash).toBe(DST_TX)
  })

  it('constrains the log filter to the fill events, so a slow-fill REQUEST can never read as a delivery', async () => {
    const dest = destProvider([])
    await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider(),
      destinationProvider: dest,
    })
    const [filter] = dest.getLogs.mock.calls[0]
    expect(filter.address).toBe(spokePoolAddress(DESTINATION))
    expect(filter.topics[0]).toEqual([
      spokeTopic('FilledV3Relay'),
      spokeTopic('FilledRelay'),
    ])
    expect(filter.topics[1]).toBe(`0x${ORIGIN.toString(16).padStart(64, '0')}`)
    expect(filter.topics[2]).toBe(`0x${Number(DEPOSIT_ID).toString(16).padStart(64, '0')}`)
    expect(filter.fromBlock).toBeLessThan(20_000_000)
  })

  it('ignores a fill belonging to a different deposit', async () => {
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider(),
      destinationProvider: destProvider([fillLog({ depositId: '999999' })]),
    })
    expect(e.dstTxHash).toBeNull()
  })

  it('a reverted origin transaction is read as such, and no fill is looked for on a dead deposit', async () => {
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider({ getTransactionReceipt: vi.fn().mockResolvedValue({ status: 0, logs: [] }) }),
      destinationProvider: destProvider([]),
    })
    expect(e.sourceReverted).toBe(true)
    expect(e.depositIndexed).toBe(false)
    expect(deriveBridgeState({ current: BRIDGE_STATE.SUBMITTED, evidence: e, now: NOW }).state).toBe(BRIDGE_STATE.FAILED)
  })

  it('an unmined origin transaction is unknown, not failed', async () => {
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider({ getTransactionReceipt: vi.fn().mockResolvedValue(null) }),
      destinationProvider: destProvider([]),
    })
    expect(e.sourceMined).toBeNull()
    expect(e.sourceReverted).toBeNull()
    expect(e.empty).toBe(true)
  })

  it('an RPC that refuses the range yields no evidence rather than a negative result', async () => {
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider({ getTransactionReceipt: vi.fn().mockRejectedValue(new Error('rate limited')) }),
      destinationProvider: { getBlockNumber: vi.fn().mockResolvedValue(20_000_000), getLogs: vi.fn().mockRejectedValue(new Error('range too wide')) },
    })
    expect(e.dstTxHash).toBeNull()
    expect(e.empty).toBe(true)
    // …and that non-answer leaves the transfer exactly where it was.
    expect(deriveBridgeState({ current: BRIDGE_STATE.IN_FLIGHT, evidence: e, now: NOW }).changed).toBe(false)
  })

  it('never asserts a refund from chain reads alone', async () => {
    const e = await readOnChainEvidence({
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      depositId: DEPOSIT_ID,
      srcTxHash: SRC_TX,
      originProvider: originProvider(),
      destinationProvider: destProvider([]),
    })
    expect(e.refundTxHash).toBeNull()
  })

  it('refuses a Bitcoin origin id outright (FR-006)', async () => {
    await expect(readOnChainEvidence({ originChainId: 'bitcoin', destinationChainId: DESTINATION, depositId: DEPOSIT_ID }))
      .rejects.toBeInstanceOf(BridgeStatusUnavailable)
  })
})

// ---------------------------------------------------------------------------------------------
describe('reconcileBridge — persistence and the degradation ladder', () => {
  it('promotes to delivered and settles the ledger only with a destination hash', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: DST_TX }))))

    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW })
    expect(r.source).toBe(BRIDGE_STATUS_SOURCE.GATEWAY)
    expect(r.to).toBe(BRIDGE_STATE.DELIVERED)
    expect(r.applied).toBe(true)

    const after = entryFor()
    expect(after.state).toBe(BRIDGE_STATE.DELIVERED)
    expect(after.status).toBe(LEDGER_STATUS.SETTLED)
    expect(after.dstTxHash).toBe(DST_TX)
  })

  it('leaves a hash-free "filled" PENDING and in flight', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: null }))))

    await reconcileBridge(ACCOUNT, entryFor(), { now: NOW })
    const after = entryFor()
    expect(after.state).toBe(BRIDGE_STATE.IN_FLIGHT)
    expect(after.status).toBe(LEDGER_STATUS.PENDING)
    expect(after.dstTxHash).toBeNull()
  })

  it('records a refund as CANCELLED once the returning transaction is known', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'refunded', upstreamStatus: 'refunded', refundTxHash: REFUND_TX }))))

    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW })
    expect(r.to).toBe(BRIDGE_STATE.REFUNDED)
    const after = entryFor()
    expect(after.status).toBe(LEDGER_STATUS.CANCELLED)
    expect(after.refundTxHash).toBe(REFUND_TX)
  })

  it('an expired-but-unrefunded deposit is needs_attention, still PENDING, and still resolvable', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'expired', upstreamStatus: 'expired' }))))
    // An expiry takes the same second opinion a late transfer does; the chain has no fill either.
    const readChain = vi.fn().mockResolvedValue({ source: BRIDGE_STATUS_SOURCE.CHAIN, sourceMined: true, depositIndexed: true, dstTxHash: null, refundTxHash: null, empty: false })
    await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(readChain).toHaveBeenCalledTimes(1)
    expect(entryFor().state).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(entryFor().status).toBe(LEDGER_STATUS.PENDING)

    // …and the very next poll, once the refund exists, resolves it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'refunded', upstreamStatus: 'refunded', refundTxHash: REFUND_TX }))))
    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(r.from).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(r.to).toBe(BRIDGE_STATE.REFUNDED)
    expect(entryFor().status).toBe(LEDGER_STATUS.CANCELLED)
  })

  it('falls back to the chain when the gateway is down — a gateway outage strands nothing (FR-053)', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('gateway unreachable')))
    const readChain = vi.fn().mockResolvedValue({
      source: BRIDGE_STATUS_SOURCE.CHAIN,
      sourceMined: true,
      sourceReverted: false,
      depositIndexed: true,
      dstTxHash: DST_TX,
      refundTxHash: null,
      expired: false,
      empty: false,
    })

    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(r.gatewayError).toBeInstanceOf(BridgeStatusUnavailable)
    expect(r.source).toBe(BRIDGE_STATUS_SOURCE.CHAIN)
    expect(entryFor().state).toBe(BRIDGE_STATE.DELIVERED)
    expect(entryFor().status).toBe(LEDGER_STATUS.SETTLED)
  })

  it('skips the gateway entirely when it is not configured, and still resolves from chain', async () => {
    submit()
    vi.stubEnv('VITE_RELAYER_URL', '')
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const readChain = vi.fn().mockResolvedValue({
      source: BRIDGE_STATUS_SOURCE.CHAIN, sourceMined: true, depositIndexed: true, dstTxHash: DST_TX, refundTxHash: null, empty: false,
    })
    await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(entryFor().state).toBe(BRIDGE_STATE.DELIVERED)
  })

  it('with NOTHING reachable a late transfer still becomes needs_attention, not a silent spinner', async () => {
    submit({ expectedBy: NOW - 1 })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const readChain = vi.fn().mockRejectedValue(new Error('no rpc'))

    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(r.source).toBe(BRIDGE_STATUS_SOURCE.NONE)
    expect(r.gatewayError).toBeTruthy()
    expect(r.chainError).toBeTruthy()
    expect(r.to).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(entryFor().state).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(entryFor().status).toBe(LEDGER_STATUS.PENDING)
  })

  it('checks the chain before calling a late transfer stuck — a lagging gateway is overruled upward', async () => {
    submit({ expectedBy: NOW - 1 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'in_flight', upstreamStatus: 'pending' }))))
    const readChain = vi.fn().mockResolvedValue({
      source: BRIDGE_STATUS_SOURCE.CHAIN, sourceMined: true, depositIndexed: true, dstTxHash: DST_TX, refundTxHash: null, empty: false,
    })

    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(readChain).toHaveBeenCalledTimes(1)
    expect(r.to).toBe(BRIDGE_STATE.DELIVERED)
    expect(entryFor().status).toBe(LEDGER_STATUS.SETTLED)
  })

  it('a second opinion that finds nothing changes nothing — the transfer is honestly late', async () => {
    submit({ expectedBy: NOW - 1 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'in_flight', upstreamStatus: 'pending' }))))
    const readChain = vi.fn().mockResolvedValue({
      source: BRIDGE_STATUS_SOURCE.CHAIN, sourceMined: true, depositIndexed: true, dstTxHash: null, refundTxHash: null, empty: false,
    })

    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(r.to).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(entryFor().status).toBe(LEDGER_STATUS.PENDING)
  })

  it('does not take a second opinion on a transfer that is still inside its window', async () => {
    submit({ expectedBy: NOW + 600_000 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto())))
    const readChain = vi.fn()
    await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, readChain })
    expect(readChain).not.toHaveBeenCalled()
  })

  it('is idempotent: re-observing the same state writes nothing and re-notifies nothing', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto())))
    const onTransition = vi.fn()

    const first = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, onTransition })
    expect(first.changed).toBe(true)
    const second = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW, onTransition })
    expect(second.changed).toBe(false)
    expect(second.applied).toBe(false)
    expect(onTransition).toHaveBeenCalledTimes(1)
  })

  it('does not spend a request on an already-settled transfer', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: DST_TX }))))
    await reconcileBridge(ACCOUNT, entryFor(), { now: NOW })

    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const r = await reconcileBridge(ACCOUNT, entryFor(), { now: NOW })
    expect(r.from).toBe(BRIDGE_STATE.DELIVERED)
    expect(r.changed).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a failing notification hook never breaks reconciliation', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: DST_TX }))))
    const r = await reconcileBridge(ACCOUNT, entryFor(), {
      now: NOW,
      onTransition: () => { throw new Error('notification failed') },
    })
    expect(r.applied).toBe(true)
    expect(entryFor().state).toBe(BRIDGE_STATE.DELIVERED)
  })

  it('ignores an entry with no account, no deposit id, or a non-EVM origin', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    expect((await reconcileBridge('', { depositId: DEPOSIT_ID, originChainId: ORIGIN })).applied).toBe(false)
    expect((await reconcileBridge(ACCOUNT, { originChainId: ORIGIN })).applied).toBe(false)
    expect((await reconcileBridge(ACCOUNT, { depositId: DEPOSIT_ID, originChainId: 'bitcoin' })).applied).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
describe('reconcileBridges — the on-load sweep', () => {
  it('reconciles only the live transfers and never throws on one bad entry', async () => {
    submit()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: DST_TX }))))
    const results = await reconcileBridges(ACCOUNT, ORIGIN, { now: NOW })
    expect(results).toHaveLength(1)
    expect(results[0].to).toBe(BRIDGE_STATE.DELIVERED)

    // Settled now — the next sweep has nothing live to do.
    expect(listLiveBridges(ACCOUNT, ORIGIN)).toHaveLength(0)
    expect(await reconcileBridges(ACCOUNT, ORIGIN, { now: NOW })).toHaveLength(0)
  })

  it('returns nothing for a missing account or a non-EVM chain id', async () => {
    expect(await reconcileBridges('', ORIGIN)).toEqual([])
    expect(await reconcileBridges(ACCOUNT, 'bitcoin')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
describe('SC-004 / FR-010 — an in-flight bridge survives the app closing', () => {
  it('recovers its TRUE status after a simulated restart, with no session state carried over', async () => {
    // ---- session 1: the member submits a bridge and closes the app while it is in flight -------
    submit({ expectedBy: NOW + 600_000 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'in_flight', upstreamStatus: 'pending' }))))
    await reconcileBridge(ACCOUNT, entryFor(), { now: NOW })
    expect(entryFor().state).toBe(BRIDGE_STATE.IN_FLIGHT)
    expect(entryFor().status).toBe(LEDGER_STATUS.PENDING)

    // ---- the app closes: every module is torn down and re-imported fresh ----------------------
    // Only localStorage survives, which is exactly the guarantee FR-010 makes. Nothing about this
    // transfer's progress lived in the session that started it.
    vi.resetModules()
    const fresh = await import('../bridgeStatus')
    const freshLedger = await import('../../../data/ledger/sources/bridgeLedgerSource')
    vi.stubEnv('VITE_RELAYER_URL', BASE)

    // The bridge is still there, still pending, read back from disk by code that never saw it sent.
    const recovered = fresh.listLiveBridges(ACCOUNT, ORIGIN)
    expect(recovered).toHaveLength(1)
    expect(recovered[0].depositId).toBe(DEPOSIT_ID)
    expect(recovered[0].state).toBe(freshLedger.BRIDGE_STATE.IN_FLIGHT)
    expect(recovered[0].srcTxHash).toBe(SRC_TX)

    // ---- session 2: it delivered while the app was closed, and the sweep on load learns that ---
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto({ state: 'delivered', upstreamStatus: 'filled', fillTxHash: DST_TX }))))
    const results = await fresh.reconcileBridges(ACCOUNT, ORIGIN, { now: NOW + 3_600_000 })
    expect(results).toHaveLength(1)
    expect(results[0].from).toBe(freshLedger.BRIDGE_STATE.IN_FLIGHT)
    expect(results[0].to).toBe(freshLedger.BRIDGE_STATE.DELIVERED)

    const settled = freshLedger.listBridgeEntries(ACCOUNT, ORIGIN)[0]
    expect(settled.state).toBe(freshLedger.BRIDGE_STATE.DELIVERED)
    expect(settled.status).toBe(LEDGER_STATUS.SETTLED)
    expect(settled.dstTxHash).toBe(DST_TX)
  })

  it('recovers a transfer that went LATE while the app was closed, without the gateway', async () => {
    submit({ expectedBy: NOW + 60_000 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(200, dto())))
    await reconcileBridge(ACCOUNT, entryFor(), { now: NOW })
    expect(entryFor().state).toBe(BRIDGE_STATE.IN_FLIGHT)

    vi.resetModules()
    const fresh = await import('../bridgeStatus')
    vi.stubEnv('VITE_RELAYER_URL', '') // gateway gone since the member was last here

    const results = await fresh.reconcileBridges(ACCOUNT, ORIGIN, {
      now: NOW + 86_400_000,
      readChain: vi.fn().mockResolvedValue({ source: 'chain', sourceMined: true, depositIndexed: true, dstTxHash: null, refundTxHash: null, empty: false }),
    })
    expect(results[0].to).toBe(BRIDGE_STATE.NEEDS_ATTENTION)

    const after = listBridgeEntries(ACCOUNT, ORIGIN)[0]
    expect(after.state).toBe(BRIDGE_STATE.NEEDS_ATTENTION)
    expect(after.status).toBe(LEDGER_STATUS.PENDING)
    expect(after.srcTxHash).toBe(SRC_TX) // the recourse link the member is owed (FR-011)
  })
})
