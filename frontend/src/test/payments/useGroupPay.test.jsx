/**
 * useGroupPay — the submission half of group pay.
 *
 * What is actually being defended here:
 *
 *   1. A signer that CAN batch does exactly ONE submission — a passkey account gets one
 *      `sendCalls` carrying every payment, a vault gets one MultiSend proposal. Not N.
 *   2. A signer that cannot batch sends sequentially and NEVER stops at the first failure:
 *      every recipient gets its own reported outcome (the spec-062 sweep precedent).
 *   3. A userOpHash is not a transaction hash: a stalled batch reports `pending`, never `sent`.
 *   4. Screening runs per recipient at SUBMIT time, forced (a cached "clear" from a minute ago
 *      is not a submission-time fact). A restricted recipient stops a batch BEFORE anything is
 *      signed — an atomic batch cannot quietly drop a leg the member confirmed — and is SKIPPED
 *      with its reason on the sequential rail, where the others are genuinely independent.
 *   5. An acting account with no rail is refused with a reason, never signed for by the
 *      connected wallet (spec 088 FR-002).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { Interface } from 'ethers'

import { WalletContext } from '../../contexts/WalletContext'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const C = '0x3333333333333333333333333333333333333333'
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const TX = `0x${'ab'.repeat(32)}`

const erc20 = new Interface(['function transfer(address to, uint256 value) returns (bool)'])

// The wallet arrives through its context (the hook reads it directly, with a null fallback, so a
// send surface mounted without a provider degrades instead of crashing).
const wallet = {}
const wrapper = ({ children }) => (
  <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
)

const transfer = {}
vi.mock('../../hooks/useTransfer', () => ({
  useTransfer: () => transfer,
  TRANSFER_KIND: { NATIVE: 'native', STABLE: 'stable' },
}))

const active = {}
vi.mock('../../hooks/useActiveAccount', () => ({ useActiveAccount: () => active }))

const effective = {}
vi.mock('../../hooks/useEffectiveAccount', () => ({ useEffectiveAccount: () => effective }))

const screening = { statuses: {}, calls: [] }
vi.mock('../../hooks/useAddressScreening', () => ({
  useAddressScreening: () => ({
    screenOne: vi.fn(async (addr, chainId, opts) => {
      screening.calls.push({ addr, chainId, opts })
      return screening.statuses[String(addr).toLowerCase()] ?? 'clear'
    }),
  }),
}))

// Issue #1368 — the vault rail asks the vault's own guard whether a MultiSend delegatecall would
// survive it. Default here is the pre-#1368 world (unguarded / policy-free vault), so every
// existing vault assertion below is unchanged; the split tests flip it.
const preflight = { support: 'batch-ok', reason: null, detail: null, engine: 'none' }
const previewBatchSupport = vi.fn(async () => preflight)
vi.mock('../../lib/custody/batchPreflight', async (importOriginal) => ({
  ...(await importOriginal()),
  previewBatchSupport: (...a) => previewBatchSupport(...a),
}))

const store = { recordTransfer: vi.fn(), updateTransfer: vi.fn() }
vi.mock('../../lib/transfer/transferStore', () => ({
  recordTransfer: (...a) => store.recordTransfer(...a) ?? { id: 'rec1' },
  updateTransfer: (...a) => store.updateTransfer(...a),
  TRANSFER_STATUS: { COMPLETE: 'complete', FAILED: 'failed', IN_PROCESS: 'in_process' },
}))
vi.mock('../../data/ledger', () => ({ appendClientRecord: vi.fn() }))
vi.mock('../../data/ledger/sources/transferLedgerSource', () => ({
  transferRecordToEntry: () => ({ entryId: 'cl:1', refs: {} }),
}))

import { useGroupPay } from '../../hooks/useGroupPay'
import { GROUP_RAIL } from '../../lib/payments/groupPay'

const STABLE = { key: '137:usdc', chainId: 137, kind: 'erc20', address: USDC, symbol: 'USDC', decimals: 6, networkName: 'Polygon' }
const NATIVE = { key: '137:native', chainId: 137, kind: 'native', address: null, symbol: 'POL', decimals: 18, networkName: 'Polygon' }

const three = [
  { id: 'r0', address: A, amount: '1' },
  { id: 'r1', address: B, amount: '2.5' },
  { id: 'r2', address: C, amount: '3' },
]

const run = async (payload) => {
  const { result } = renderHook(() => useGroupPay(), { wrapper })
  let out
  await act(async () => { out = await result.current.submitGroup(payload).catch((e) => ({ error: e })) })
  return { out, hook: result }
}

beforeEach(() => {
  Object.assign(wallet, {
    address: '0xaaaAaAaaAAaAAAaaAaaaaaAAaaaaAAAAaAAAaAAa',
    chainId: 137,
    sendCalls: vi.fn(async () => ({ state: 'included', txHash: TX, sponsored: true })),
  })
  Object.assign(transfer, {
    isPasskey: true,
    send: vi.fn(async ({ to }) => ({ txHash: `${TX.slice(0, 20)}${to.slice(-4)}`, route: 'gasless', id: to })),
  })
  Object.assign(active, {
    identity: { mode: 'personal' },
    isVault: false, canActAsVault: false, isLegacy: false, isHardware: false,
    submit: vi.fn(async () => ({ kind: 'proposed', safeTxHash: '0xsafe' })),
  })
  Object.assign(preflight, { support: 'batch-ok', reason: null, detail: null, engine: 'none' })
  previewBatchSupport.mockClear()
  Object.assign(effective, { type: 'personal', address: wallet.address, isActingAccount: false })
  screening.statuses = {}
  screening.calls = []
  store.recordTransfer = vi.fn(() => ({ id: 'rec1' }))
  store.updateTransfer = vi.fn()
})

describe('rail selection', () => {
  it('reports the passkey batch rail for a passkey account acting as itself', () => {
    const { result } = renderHook(() => useGroupPay(), { wrapper })
    expect(result.current.rail).toBe(GROUP_RAIL.BATCH_PASSKEY)
  })

  it('reports the sequential rail for a classic wallet', () => {
    transfer.isPasskey = false
    const { result } = renderHook(() => useGroupPay(), { wrapper })
    expect(result.current.rail).toBe(GROUP_RAIL.SEQUENTIAL)
  })

  it('reports the vault proposal rail when acting as a vault on its network', () => {
    Object.assign(effective, { type: 'vault', address: '0xvault', isActingAccount: true })
    active.isVault = true
    active.canActAsVault = true
    const { result } = renderHook(() => useGroupPay(), { wrapper })
    expect(result.current.rail).toBe(GROUP_RAIL.VAULT_PROPOSAL)
  })
})

/*
 * Issue #1441 — the surfaces ask the hook whether the affordance should be offered at all, and
 * today the answer is always no. The RAILS above are untouched: withdrawing a control is not the
 * same as refusing a submission, and a group payment already in flight still reports its outcomes.
 */
describe('availability (#1441)', () => {
  it('is withdrawn on every rail while GROUP_PAY_ENABLED is false', () => {
    for (const [isPasskey, actingType] of [[true, 'personal'], [false, 'personal']]) {
      transfer.isPasskey = isPasskey
      effective.type = actingType
      const { result } = renderHook(() => useGroupPay(), { wrapper })
      expect(result.current.available).toBe(false)
      expect(result.current.unavailableCode).toBe('withdrawn')
      expect(result.current.unavailableReason).toMatch(/not available yet/i)
    }
  })

  it('still submits a group payment it is handed — the withdrawal is a UI decision, not a refusal', async () => {
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(out.summary).toMatchObject({ sent: 3, failed: 0 })
  })
})

describe('passkey batch rail', () => {
  it('submits ONE sendCalls carrying every recipient (ERC-20)', async () => {
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(wallet.sendCalls).toHaveBeenCalledTimes(1)
    const [calls] = wallet.sendCalls.mock.calls[0]
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.target)).toEqual([USDC, USDC, USDC])
    const decoded = calls.map((c) => erc20.decodeFunctionData('transfer', c.data))
    expect(decoded.map((d) => d[0].toLowerCase())).toEqual([A, B, C])
    expect(decoded.map((d) => d[1])).toEqual([1000000n, 2500000n, 3000000n])
    expect(out.summary).toMatchObject({ sent: 3, failed: 0, skipped: 0, rail: GROUP_RAIL.BATCH_PASSKEY })
    expect(out.outcomes.every((o) => o.status === 'sent' && o.txHash === TX)).toBe(true)
  })

  it('submits ONE sendCalls of native value moves', async () => {
    const { out } = await run({ asset: NATIVE, recipients: three.slice(0, 2) })
    const [calls] = wallet.sendCalls.mock.calls[0]
    expect(calls).toEqual([
      { target: A, data: '0x', value: 1000000000000000000n },
      { target: B, data: '0x', value: 2500000000000000000n },
    ])
    expect(out.summary.sent).toBe(2)
  })

  it('records one activity entry per recipient, not one per batch', async () => {
    await run({ asset: STABLE, recipients: three })
    expect(store.recordTransfer).toHaveBeenCalledTimes(3)
    expect(store.updateTransfer).toHaveBeenCalledTimes(3)
  })

  it('reports a stalled batch as pending with the userOp reference and NO transaction hash', async () => {
    wallet.sendCalls = vi.fn(async () => ({ state: 'stalled', userOpHash: '0xuop', sponsored: true }))
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(out.outcomes.every((o) => o.status === 'pending' && o.txHash === null)).toBe(true)
    expect(out.outcomes[0].userOpHash).toBe('0xuop')
    expect(out.summary).toMatchObject({ sent: 0, pending: 3 })
  })

  it('reports a failed batch as failed for every recipient with the venue reason', async () => {
    wallet.sendCalls = vi.fn(async () => ({ state: 'failed', reason: 'insufficient allowance' }))
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(out.outcomes.every((o) => o.status === 'failed')).toBe(true)
    expect(out.outcomes[0].reason).toMatch(/insufficient allowance/)
    expect(out.summary).toMatchObject({ sent: 0, failed: 3 })
  })

  it('does not claim gasless when the batch was not sponsored', async () => {
    wallet.sendCalls = vi.fn(async () => ({ state: 'included', txHash: TX, sponsored: false }))
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(out.summary.route).toBe('self')
  })
})

const VAULT = '0x4444444444444444444444444444444444444444'

describe('vault rail', () => {
  beforeEach(() => {
    Object.assign(effective, { type: 'vault', address: VAULT, isActingAccount: true })
    active.identity = { mode: 'vault', vaultAddress: VAULT, chainId: 137 }
    active.isVault = true
    active.canActAsVault = true
  })

  it('creates exactly ONE proposal carrying every payment', async () => {
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(active.submit).toHaveBeenCalledTimes(1)
    const [payload] = active.submit.mock.calls[0]
    expect(payload.batch).toHaveLength(3)
    expect(payload.batch.map((c) => c.to)).toEqual([USDC, USDC, USDC])
    expect(transfer.send).not.toHaveBeenCalled()
    expect(wallet.sendCalls).not.toHaveBeenCalled()
    expect(out.summary).toMatchObject({ proposed: 3, sent: 0, rail: GROUP_RAIL.VAULT_PROPOSAL })
    expect(out.outcomes.every((o) => o.status === 'proposed' && o.safeTxHash === '0xsafe')).toBe(true)
  })

  it('marks every recipient failed — not half-sent — when the proposal itself fails', async () => {
    active.submit = vi.fn(async () => { throw new Error('vault is on another network') })
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(out.outcomes.every((o) => o.status === 'failed')).toBe(true)
    expect(out.summary.failed).toBe(3)
  })

  it('asks the vault’s own guard before choosing the batch shape', async () => {
    await run({ asset: STABLE, recipients: three })
    expect(previewBatchSupport).toHaveBeenCalledWith(VAULT, 137)
  })

  /*
   * Issue #1368 — the whole point. A vault whose policy guard denies delegatecall would approve
   * the MultiSend proposal and then revert executing it. Fall back to one proposal per recipient,
   * at CONSECUTIVE nonces (same-nonce proposals are mutually exclusive on a Safe, so only one
   * payment could ever land).
   */
  describe('policy-guarded vault (batch denied)', () => {
    beforeEach(() => { Object.assign(preflight, { support: 'batch-denied', reason: "This vault's policy does not allow batched transactions.", engine: 'v2' }) })

    it('creates N proposals — one per recipient — instead of one MultiSend', async () => {
      let n = 7
      active.submit = vi.fn(async (p) => ({ kind: 'proposed', safeTxHash: `0xsafe${p.nonce ?? n}`, nonce: p.nonce ?? n }))
      const { out } = await run({ asset: STABLE, recipients: three })
      expect(active.submit).toHaveBeenCalledTimes(3)
      expect(active.submit.mock.calls.every(([p]) => p.batch === undefined)).toBe(true)
      expect(active.submit.mock.calls.map(([p]) => p.to)).toEqual([USDC, USDC, USDC])
      expect(out.summary).toMatchObject({ proposed: 3, rail: GROUP_RAIL.VAULT_PROPOSAL, shape: 'split' })
      expect(out.outcomes.map((o) => o.status)).toEqual(['proposed', 'proposed', 'proposed'])
    })

    it('queues them at consecutive nonces so every one of them can execute', async () => {
      let next = 7
      active.submit = vi.fn(async (p) => {
        const nonce = p.nonce ?? next
        next = nonce + 1
        return { kind: 'proposed', safeTxHash: `0xsafe${nonce}`, nonce }
      })
      await run({ asset: STABLE, recipients: three })
      expect(active.submit.mock.calls.map(([p]) => p.nonce)).toEqual([undefined, 8, 9])
    })

    it('a failed proposal does not abort the rest, and does not leave a nonce gap', async () => {
      let next = 7
      let seen = 0
      active.submit = vi.fn(async (p) => {
        seen += 1
        if (seen === 1) throw new Error('rejected in the wallet')
        const nonce = p.nonce ?? next
        next = nonce + 1
        return { kind: 'proposed', safeTxHash: `0xsafe${nonce}`, nonce }
      })
      const { out } = await run({ asset: STABLE, recipients: three })
      expect(out.outcomes.map((o) => o.status)).toEqual(['failed', 'proposed', 'proposed'])
      // The failed one consumed no nonce, so the next attempt re-uses the slot rather than
      // skipping it — a gap would make every later proposal unexecutable.
      expect(active.submit.mock.calls.map(([p]) => p.nonce)).toEqual([undefined, undefined, 8])
    })

    it('a flagged recipient is SKIPPED, not a whole-batch refusal — these payments are independent', async () => {
      screening.statuses[B.toLowerCase()] = 'restricted'
      active.submit = vi.fn(async () => ({ kind: 'proposed', safeTxHash: '0xsafe', nonce: 7 }))
      const { out } = await run({ asset: STABLE, recipients: three })
      expect(active.submit).toHaveBeenCalledTimes(2)
      expect(out.outcomes.map((o) => o.status)).toEqual(['proposed', 'skipped', 'proposed'])
    })
  })

  it('an UNREADABLE guard also splits — an unconfirmed policy is never assumed to allow a batch', async () => {
    Object.assign(preflight, { support: 'unknown', reason: "Could not confirm the vault's policy allows a batch.", engine: 'foreign' })
    active.submit = vi.fn(async () => ({ kind: 'proposed', safeTxHash: '0xsafe', nonce: 3 }))
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(active.submit).toHaveBeenCalledTimes(3)
    expect(out.summary.shape).toBe('split')
    expect(out.summary.batchSupport).toBe('unknown')
  })

  it('exposes the resolved shape so the confirm screen can say which one it will create', async () => {
    Object.assign(preflight, { support: 'batch-denied', reason: 'nope', engine: 'v2' })
    const { hook } = await run({ asset: STABLE, recipients: three })
    expect(hook.current.vaultBatch?.support).toBe('batch-denied')
  })
})

describe('sequential rail', () => {
  beforeEach(() => { transfer.isPasskey = false })

  it('sends once per recipient through the existing engine', async () => {
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(transfer.send).toHaveBeenCalledTimes(3)
    expect(transfer.send.mock.calls.map((c) => c[0].to)).toEqual([A, B, C])
    expect(transfer.send.mock.calls.map((c) => c[0].amount)).toEqual(['1', '2.5', '3'])
    expect(wallet.sendCalls).not.toHaveBeenCalled()
    expect(out.summary).toMatchObject({ sent: 3, failed: 0, rail: GROUP_RAIL.SEQUENTIAL })
  })

  it('CONTINUES past a failure and reports a per-recipient outcome for each', async () => {
    transfer.send = vi.fn(async ({ to }) => {
      if (to === B) throw new Error('nonce too low')
      return { txHash: TX, route: 'gasless' }
    })
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(transfer.send).toHaveBeenCalledTimes(3)
    expect(out.outcomes.map((o) => o.status)).toEqual(['sent', 'failed', 'sent'])
    expect(out.outcomes[1].reason).toMatch(/nonce too low/)
    expect(out.summary).toMatchObject({ sent: 2, failed: 1, skipped: 0 })
  })

  it('reports a still-confirming send as pending rather than sent', async () => {
    transfer.send = vi.fn(async () => ({ pending: true, userOpHash: '0xuop', txHash: null }))
    const { out } = await run({ asset: STABLE, recipients: three.slice(0, 1) })
    expect(out.outcomes[0].status).toBe('pending')
    expect(out.summary.pending).toBe(1)
  })
})

describe('screening at submit time', () => {
  it('force-screens every recipient on the chain the value moves on', async () => {
    await run({ asset: STABLE, recipients: three })
    expect(screening.calls).toHaveLength(3)
    expect(screening.calls.map((c) => c.addr)).toEqual([A, B, C])
    expect(screening.calls.every((c) => c.chainId === 137 && c.opts?.force === true)).toBe(true)
  })

  it('refuses a batch containing a restricted recipient BEFORE anything is signed', async () => {
    screening.statuses[B.toLowerCase()] = 'restricted'
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(wallet.sendCalls).not.toHaveBeenCalled()
    expect(out.error).toBeTruthy()
    expect(out.error.message).toMatch(/sanctions|screening/i)
    expect(out.error.message).toContain(B)
  })

  it('skips a restricted recipient on the sequential rail and pays the rest', async () => {
    transfer.isPasskey = false
    screening.statuses[B.toLowerCase()] = 'restricted'
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(transfer.send).toHaveBeenCalledTimes(2)
    expect(out.outcomes.map((o) => o.status)).toEqual(['sent', 'skipped', 'sent'])
    expect(out.outcomes[1].reason).toMatch(/sanctions|screening/i)
    expect(out.summary).toMatchObject({ sent: 2, skipped: 1, failed: 0 })
  })

  it('does not skip anyone when screening is merely unavailable', async () => {
    transfer.isPasskey = false
    screening.statuses[B.toLowerCase()] = 'uncertain'
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(out.summary.sent).toBe(3)
  })
})

describe('refusals', () => {
  it('refuses a derived acting account with a reason and signs nothing', async () => {
    Object.assign(effective, { type: 'derived', address: '0xderived', isActingAccount: true })
    const { out } = await run({ asset: STABLE, recipients: three })
    expect(out.error).toBeTruthy()
    expect(wallet.sendCalls).not.toHaveBeenCalled()
    expect(transfer.send).not.toHaveBeenCalled()
    expect(active.submit).not.toHaveBeenCalled()
  })

  it('refuses a non-EVM recipient that reached submission, naming the network', async () => {
    const { out } = await run({
      asset: STABLE,
      recipients: [{ id: 'r0', address: A, amount: '1' }, { id: 'r1', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '1' }],
    })
    expect(out.error.message).toMatch(/bitcoin/i)
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('refuses a non-EVM ASSET (Bitcoin) outright — group pay is EVM-only this release', async () => {
    const { out } = await run({
      asset: { key: 'bitcoin:native', chainId: 'bitcoin', kind: 'btc-native', symbol: 'BTC', decimals: 8 },
      recipients: three,
    })
    expect(out.error.message).toMatch(/bitcoin/i)
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('refuses an empty recipient list', async () => {
    const { out } = await run({ asset: STABLE, recipients: [] })
    expect(out.error).toBeTruthy()
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })
})
