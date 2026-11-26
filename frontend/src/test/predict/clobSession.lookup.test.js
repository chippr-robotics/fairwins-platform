/**
 * lookupOrder (spec 114 slice 6) — look ONE order up with the member's own session. It never posts and never
 * signs, and it separates three outcomes the tracker must not confuse: found, absent (with the trades read),
 * unreadable (not a fact about the order). The SDK's HTTP helper RETURNS errors as `{ error, status? }`, and
 * `getTrades` THROWS on one (it spreads `response.data`) — both are exercised.
 *
 * ASSUMPTIONS about the venue, none verifiable without a funded account (listed in the slice report):
 * a missing order answers 404 or null/empty; a found order carries `status`, `size_matched`, `asset_id`, `side`.
 */
import { describe, it, expect, vi } from 'vitest'
import { lookupOrder } from '../../lib/predict/clobSession'

const REF = { orderId: '0xAbC', tokenId: '111', side: 'BUY', since: 1_700_000_000_000 }
const client = (over = {}) => ({
  getOrder: vi.fn().mockResolvedValue({ id: '0xabc', status: 'LIVE', size_matched: '0', asset_id: '111', side: 'BUY' }),
  getTrades: vi.fn().mockResolvedValue([]),
  postOrder: vi.fn(),
  createOrder: vi.fn(),
  createMarketOrder: vi.fn(),
  ...over,
})
const neverWrites = (c) => {
  expect(c.postOrder).not.toHaveBeenCalled()
  expect(c.createOrder).not.toHaveBeenCalled()
  expect(c.createMarketOrder).not.toHaveBeenCalled()
}

describe('lookupOrder', () => {
  it('found: the venue\'s record comes back, id compared case-insensitively; trades are not even read', async () => {
    const c = client()
    const out = await lookupOrder(c, REF)
    expect(out).toMatchObject({ kind: 'found', order: { status: 'LIVE' } })
    expect(c.getOrder).toHaveBeenCalledWith('0xAbC')
    expect(c.getTrades).not.toHaveBeenCalled()
    neverWrites(c)
  })

  it('an answer about a DIFFERENT order (other id, token or side) is unreadable, never adopted', async () => {
    for (const answer of [
      { id: '0xdef', status: 'LIVE', asset_id: '111', side: 'BUY' },
      { id: '0xabc', status: 'LIVE', asset_id: '999', side: 'BUY' },
      { id: '0xabc', status: 'LIVE', asset_id: '111', side: 'SELL' },
    ]) {
      expect(await lookupOrder(client({ getOrder: vi.fn().mockResolvedValue(answer) }), REF)).toEqual({ kind: 'unreadable' })
    }
  })

  it('a 404, null or empty answer is absent — and then the member\'s trades for the token are read, narrowed on the request', async () => {
    for (const answer of [{ error: 'order not found', status: 404 }, null, {}]) {
      const c = client({ getOrder: vi.fn().mockResolvedValue(answer) })
      const out = await lookupOrder(c, REF)
      expect(out).toEqual({ kind: 'absent', trades: [] })
      expect(c.getTrades).toHaveBeenCalledWith({ asset_id: '111', after: String(1_700_000_000 - 60) })
      neverWrites(c)
    }
  })

  it('absent returns the trades that refer to THIS order (as taker or maker) and no others', async () => {
    const trades = [
      { id: 't1', taker_order_id: '0xABC', size: '5', status: 'MATCHED' },
      { id: 't2', taker_order_id: '0xother', maker_orders: [{ order_id: '0xabc', matched_amount: '2' }] },
      { id: 't3', taker_order_id: '0xother', maker_orders: [{ order_id: '0xzzz', matched_amount: '9' }] },
    ]
    const out = await lookupOrder(client({ getOrder: vi.fn().mockResolvedValue(null), getTrades: vi.fn().mockResolvedValue(trades) }), REF)
    expect(out.trades.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('every other failure is unreadable — a transport error, a 5xx, a throw, an unrecognised shape, a trades read that fails', async () => {
    const cases = [
      client({ getOrder: vi.fn().mockResolvedValue({ error: 'Network Error' }) }),
      client({ getOrder: vi.fn().mockResolvedValue({ error: 'bad gateway', status: 502 }) }),
      client({ getOrder: vi.fn().mockRejectedValue(new Error('boom')) }),
      client({ getOrder: vi.fn().mockResolvedValue({ unexpected: true }) }),
      client({ getOrder: vi.fn().mockResolvedValue('<html>') }),
      client({ getOrder: vi.fn().mockResolvedValue(null), getTrades: vi.fn().mockRejectedValue(new TypeError('not iterable')) }),
      client({ getOrder: vi.fn().mockResolvedValue(null), getTrades: vi.fn().mockResolvedValue({ error: 'x' }) }),
    ]
    for (const c of cases) expect(await lookupOrder(c, REF)).toEqual({ kind: 'unreadable' })
  })
})
