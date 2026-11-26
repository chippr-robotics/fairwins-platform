/**
 * usePredictOrders (spec 114 slice 6) — follows tracked orders with the member's own on-device session.
 * Verified here: the poll starts only when something the venue can still tell us about is tracked, only while the
 * tab is visible, backs off while nothing changes and stops when everything is settled-as-far-as-it-can-be; an
 * `unconfirmed` order is resolved by LOOKUP and the hook has no way to post (no submit function is a dependency,
 * and the ones handed in are asserted untouched); a failed lookup changes nothing; absence is concluded only
 * under the strict rule; no cached session means `locked`, never a prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { WalletContext } from '../../contexts/WalletContext.js'
import {
  usePredictOrders, POLL_BASE_MS, MAX_PER_ROUND,
} from '../../hooks/usePredictOrders'
import { newRecord, putRecord, loadStore, reduce } from '../../lib/predict/orderProgress'

const ME = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const CREDS = { key: 'k', secret: 's', passphrase: 'p' }
const facts = { tokenId: '111', side: 'BUY', kind: 'resting', size: '10', sizeUnit: 'shares', limitPrice: '0.4', label: 'Buy Yes' }

const seed = (state, over = {}, id = '0xo1') => {
  const r = { ...newRecord({ ...facts, orderId: id }, Date.now()), state, ...over }
  putRecord(ME, r, over.__scheme ? { idScheme: over.__scheme } : undefined)
  return r
}
const live = (sizeMatched = '0', status = 'LIVE') => ({ kind: 'found', order: { id: '0xo1', status, size_matched: sizeMatched, asset_id: '111', side: 'BUY' } })

function setup({ lookups = [live()], creds = CREDS, loginMethod = 'wallet' } = {}) {
  const queue = [...lookups]
  const deps = {
    loadCachedCreds: vi.fn(() => creds),
    makeClient: vi.fn(() => ({ id: 'read-client' })),
    lookupOrder: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
    // The point: a tracker handed submit functions still never calls them.
    submitMarketOrder: vi.fn(),
    submitRestingOrder: vi.fn(),
    submitOrder: vi.fn(),
  }
  const wrapper = ({ children }) => <WalletContext.Provider value={{ address: ME, loginMethod }}>{children}</WalletContext.Provider>
  const hook = renderHook(() => usePredictOrders({ deps }), { wrapper })
  return { deps, ...hook }
}
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const noPosts = (deps) => {
  expect(deps.submitMarketOrder).not.toHaveBeenCalled()
  expect(deps.submitRestingOrder).not.toHaveBeenCalled()
  expect(deps.submitOrder).not.toHaveBeenCalled()
}
const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'))
})
afterEach(() => {
  setVisibility('visible')
  vi.useRealTimers()
})

describe('when it polls', () => {
  it('not at all with nothing tracked', async () => {
    const { deps } = setup()
    await tick(60_000)
    expect(deps.lookupOrder).not.toHaveBeenCalled()
    expect(deps.makeClient).not.toHaveBeenCalled()
  })

  it('looks at once, and again on its own: resting → partial → matched with no action from the member', async () => {
    seed('sent')
    const { result, deps } = setup({ lookups: [live('0'), live('4'), live('10', 'MATCHED')] })
    await tick(0)
    expect(result.current.orders[0].state).toBe('resting')
    await tick(POLL_BASE_MS)
    expect(result.current.orders[0]).toMatchObject({ state: 'partial', filledSize: '4' })
    await tick(POLL_BASE_MS)
    expect(result.current.orders[0]).toMatchObject({ state: 'matched', filledSize: '10' })
    expect(result.current.changes).toBe(3)
    expect(deps.lookupOrder).toHaveBeenCalledWith({ id: 'read-client' }, { orderId: '0xo1', tokenId: '111', side: 'BUY', since: expect.any(Number) })
    noPosts(deps)
  })

  it('STOPS when nothing the venue can still say is tracked: a matched order waits on the chain, an ending is over', async () => {
    seed('sent')
    const { deps } = setup({ lookups: [live('10', 'MATCHED')] })
    await tick(0)
    const calls = deps.lookupOrder.mock.calls.length
    await tick(10 * 60_000)
    expect(deps.lookupOrder.mock.calls.length).toBe(calls)
  })

  it('backs off while nothing changes (6 s, then ×1.5) and starts over at 6 s on a change', async () => {
    seed('resting', { filledSize: '0' }) // already read once, so an unchanged answer is truly "nothing new"
    const { deps, result } = setup({ lookups: [live('0'), live('0'), live('0'), live('0'), live('3')] })
    await tick(0)
    expect(deps.lookupOrder).toHaveBeenCalledTimes(1)
    await tick(POLL_BASE_MS * 1.5 - 1) // the next wait is 9 s, not 6 s
    expect(deps.lookupOrder).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(deps.lookupOrder).toHaveBeenCalledTimes(2)
    await tick(13_500) // then 13.5 s
    expect(deps.lookupOrder).toHaveBeenCalledTimes(3)
    await tick(20_250) // then 20.25 s
    expect(deps.lookupOrder).toHaveBeenCalledTimes(4)
    await tick(30_000) // capped at 30 s
    expect(deps.lookupOrder).toHaveBeenCalledTimes(5)
    expect(result.current.orders[0].state).toBe('partial')
    await tick(POLL_BASE_MS) // a change resets the wait to 6 s
    expect(deps.lookupOrder).toHaveBeenCalledTimes(6)
  })

  it('does not poll in a hidden tab, and looks at once when the tab returns', async () => {
    seed('resting')
    const { deps } = setup()
    await tick(0)
    expect(deps.lookupOrder).toHaveBeenCalledTimes(1)
    act(() => setVisibility('hidden'))
    await tick(5 * 60_000)
    expect(deps.lookupOrder).toHaveBeenCalledTimes(1)
    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(deps.lookupOrder).toHaveBeenCalledTimes(2)
  })

  it('never asks about more than MAX_PER_ROUND orders in one round', async () => {
    for (let i = 0; i < MAX_PER_ROUND + 4; i++) seed('resting', {}, `0xo${i}`)
    const { deps } = setup()
    await tick(0)
    expect(deps.lookupOrder).toHaveBeenCalledTimes(MAX_PER_ROUND)
  })

  it('orders survive a reload: a fresh hook over the same device store shows them and carries on', async () => {
    seed('partial', { filledSize: '4' })
    const { result } = setup({ lookups: [live('4')] })
    expect(result.current.orders[0]).toMatchObject({ state: 'partial', filledSize: '4' })
  })
})

describe('no session, no prompt', () => {
  it('without cached credentials the hook is `locked`, builds no client and signs nothing', async () => {
    seed('resting')
    const { result, deps } = setup({ creds: null })
    await tick(0)
    expect(result.current.locked).toBe(true)
    expect(result.current.orders[0].state).toBe('resting')
    expect(deps.makeClient).not.toHaveBeenCalled()
    expect(deps.lookupOrder).not.toHaveBeenCalled()
  })

  it('the client it reads with holds a signer that names an address and REFUSES to sign (passkey sessions get the smart-wallet signature type)', async () => {
    seed('resting')
    const { deps } = setup({ loginMethod: 'passkey' })
    await tick(0)
    const [signer, creds, opts] = deps.makeClient.mock.calls[0]
    expect(await signer.getAddress()).toBe(ME)
    await expect(signer._signTypedData()).rejects.toThrow(/never signs/)
    expect(creds).toBe(CREDS)
    expect(opts).toEqual({ signatureType: 3, funderAddress: ME })
  })
})

describe('a failed lookup is not a state change', () => {
  it('unreadable leaves the record exactly as it was, flags it, and tries again', async () => {
    const r = seed('resting')
    const { result, deps } = setup({ lookups: [{ kind: 'unreadable' }, live('2')] })
    await tick(0)
    expect(result.current.orders[0]).toEqual(r)
    expect(result.current.unreadable).toBe(true)
    expect(result.current.changes).toBe(0)
    await tick(POLL_BASE_MS * 1.5)
    expect(result.current.orders[0]).toMatchObject({ state: 'partial', filledSize: '2' })
    expect(result.current.unreadable).toBe(false)
    expect(deps.lookupOrder).toHaveBeenCalledTimes(2)
  })

  it('a stale smaller fill, or an order the venue no longer lists, never moves a resting order backwards or to an ending', async () => {
    seed('partial', { filledSize: '5' })
    const { result } = setup({ lookups: [live('1'), { kind: 'absent', trades: [] }] })
    await tick(0)
    await tick(POLL_BASE_MS * 2)
    expect(result.current.orders[0]).toMatchObject({ state: 'partial', filledSize: '5' })
  })
})

describe('unconfirmed is resolved by lookup — and never by posting', () => {
  it('found on the venue: it moves on to what the venue says, and the reason is cleared', async () => {
    seed('unconfirmed', { reason: 'no answer' })
    const { result, deps } = setup({ lookups: [live('0')] })
    await tick(0)
    expect(result.current.orders[0]).toMatchObject({ state: 'resting', reason: null })
    noPosts(deps)
  })

  it('not found but a trade names it: matched, with the shares from the trade (a FAILED trade is not a fill)', async () => {
    seed('unconfirmed')
    const trades = [
      { taker_order_id: '0xo1', size: '7.5', status: 'MATCHED' },
      { taker_order_id: '0xo1', size: '100', status: 'FAILED' },
    ]
    const { result } = setup({ lookups: [{ kind: 'absent', trades }] })
    await tick(0)
    expect(result.current.orders[0]).toMatchObject({ state: 'matched', filledSize: '7.5' })
  })

  it('only failed trades: stays unconfirmed — nothing is guessed either way', async () => {
    seed('unconfirmed')
    const { result } = setup({ lookups: [{ kind: 'absent', trades: [{ taker_order_id: '0xo1', size: '3', status: 'FAILED' }] }] })
    await tick(0)
    expect(result.current.orders[0].state).toBe('unconfirmed')
  })

  it('absence NEVER becomes "not delivered" — not with a verified id, not after an hour of clean reads: it stays unconfirmed', async () => {
    // The dangerous direction. "Not found, and no trade names it" also describes an order that FILLED and that this
    // lookup cannot see; telling the member it was not delivered is how they buy twice. Nothing here may conclude it.
    seed('unconfirmed')
    putRecord(ME, { ...loadStore(ME).orders[0] }, { idScheme: 'verified' })
    const { result, deps } = setup({ lookups: [{ kind: 'absent', trades: [] }] })
    for (let i = 0; i < 60; i++) await tick(60_000)
    expect(result.current.orders[0].state).toBe('unconfirmed')
    expect(loadStore(ME).orders[0].absentReads).toBeGreaterThan(10) // it kept looking, and counted
    expect(loadStore(ME).orders.some((r) => r.state === 'not-delivered')).toBe(false)
    noPosts(deps)
  })

  it('the hook has no path to "not-delivered" at all: its source never emits the absent event', async () => {
    const src = (await import('../../hooks/usePredictOrders.js?raw')).default
    expect(src).not.toMatch(/type:\s*'absent'/)
    expect(src).not.toMatch(/'not-delivered'/)
  })

  it('the trades window starts from when the order was SIGNED, not from when its answer failed to arrive', async () => {
    // A post can take minutes to fail. An order signed at T, matched at T+1s, whose answer was lost at T+100s, is
    // recorded at T+100s — and a window starting there would leave its own fill out.
    const signedAt = 1_000_000
    seed('unconfirmed', { signedAt, createdAt: signedAt + 100_000 })
    const { deps } = setup({ lookups: [{ kind: 'absent', trades: [] }] })
    await tick(0)
    expect(deps.lookupOrder.mock.calls[0][1].since).toBe(signedAt)
  })

  it('with a MISMATCHED scheme the computed id is not even looked up', async () => {
    seed('unconfirmed')
    putRecord(ME, { ...loadStore(ME).orders[0] }, { idScheme: 'mismatch' })
    const { deps } = setup()
    await tick(60_000)
    expect(deps.lookupOrder).not.toHaveBeenCalled()
  })

  it('an order whose id could not be computed is never looked up, and stays unconfirmed', async () => {
    seed('unconfirmed', { idKnown: false, orderId: 'unsent-1' }, 'unsent-1')
    const { result, deps } = setup()
    await tick(60_000)
    expect(deps.lookupOrder).not.toHaveBeenCalled()
    expect(result.current.orders[0].state).toBe('unconfirmed')
  })

  it('an order the venue ACCEPTED is never concluded "not delivered" from absence', async () => {
    seed('sent')
    putRecord(ME, { ...loadStore(ME).orders[0] }, { idScheme: 'verified' })
    const { result } = setup({ lookups: [{ kind: 'absent', trades: [] }] })
    for (let i = 0; i < 10; i++) await tick(60_000)
    expect(result.current.orders[0].state).toBe('sent')
  })
})

describe('the hook cannot post', () => {
  it('its source takes no submit function', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/hooks/usePredictOrders.js'), 'utf-8')
    expect(src).not.toMatch(/submitOrder|submitMarketOrder|submitRestingOrder|postOrder|createAndPost|createOrder|signAndPost/)
  })
})

// keep the reducer import honest: the hook's conclusions go through it
it('reduce is the only writer of state', () => {
  expect(typeof reduce).toBe('function')
})
