/**
 * submitMarketOrder (spec 114 slice 5) — the ONE new signing-path call: the SDK's existing market-order method
 * on the same client both signer rails already use. These assert the exact SDK call (method, fill-and-kill,
 * numbers, options) and that a venue refusal is thrown rather than returned as "sent".
 */
import { describe, it, expect, vi } from 'vitest'
import { submitMarketOrder, submitOrder, toSdkNumber, Side, OrderType } from '../../lib/predict/clobSession'

const TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563'

function client(resp = { success: true, orderID: '0xabc', status: 'matched' }) {
  return {
    createAndPostMarketOrder: vi.fn().mockResolvedValue(resp),
    createAndPostOrder: vi.fn().mockResolvedValue(resp),
  }
}

describe('submitMarketOrder', () => {
  it('calls createAndPostMarketOrder, fill-and-kill, with NUMBER amount/price and the plan\'s tick + negRisk', async () => {
    const c = client()
    const out = await submitMarketOrder(c, { tokenId: TOKEN, side: 'BUY', amount: '50', limitPrice: '0.95', negRisk: true, tickSize: '0.01' })
    expect(c.createAndPostMarketOrder).toHaveBeenCalledTimes(1)
    expect(c.createAndPostOrder).not.toHaveBeenCalled()
    expect(c.createAndPostMarketOrder).toHaveBeenCalledWith(
      { tokenID: TOKEN, side: Side.BUY, amount: 50, price: 0.95, orderType: OrderType.FAK },
      { tickSize: '0.01', negRisk: true },
      OrderType.FAK,
    )
    const [order] = c.createAndPostMarketOrder.mock.calls[0]
    expect(typeof order.amount).toBe('number')
    expect(typeof order.price).toBe('number')
    expect(out).toEqual({ orderId: '0xabc', status: 'matched', raw: { success: true, orderID: '0xabc', status: 'matched' } })
  })

  it('never uses fill-or-kill', async () => {
    const c = client()
    await submitMarketOrder(c, { tokenId: TOKEN, side: 'SELL', amount: '87.71', limitPrice: '0.57', negRisk: false, tickSize: '0.001' })
    const [order, , type] = c.createAndPostMarketOrder.mock.calls[0]
    expect(order.orderType).toBe('FAK')
    expect(type).toBe('FAK')
    expect(order.side).toBe(Side.SELL)
    expect(order.amount).toBe(87.71)
  })

  it('refuses to submit an amount that does not survive the number conversion — nothing is sent', async () => {
    const c = client()
    await expect(
      submitMarketOrder(c, { tokenId: TOKEN, side: 'BUY', amount: '0.1234567890123456789', limitPrice: '0.5', negRisk: false, tickSize: '0.01' }),
    ).rejects.toThrow(/survive/)
    await expect(
      submitMarketOrder(c, { tokenId: TOKEN, side: 'BUY', amount: '10', limitPrice: 'abc', negRisk: false, tickSize: '0.01' }),
    ).rejects.toThrow()
    expect(c.createAndPostMarketOrder).not.toHaveBeenCalled()
  })

  it('throws a venue refusal (with raw + status kept) instead of returning it as an order sent', async () => {
    const c = client({ error: 'no orders found to match with FAK order', status: 400 })
    await expect(
      submitMarketOrder(c, { tokenId: TOKEN, side: 'BUY', amount: '10', limitPrice: '0.5', negRisk: false, tickSize: '0.01' }),
    ).rejects.toMatchObject({ message: /no orders found/, status: 400, raw: { status: 400 } })
    const c2 = client({ success: false, errorMsg: 'not enough balance', orderID: '' })
    await expect(
      submitMarketOrder(c2, { tokenId: TOKEN, side: 'BUY', amount: '10', limitPrice: '0.5', negRisk: false, tickSize: '0.01' }),
    ).rejects.toThrow(/not enough balance/)
  })

  it('leaves submitOrder (the resting path) exactly as it was: GTC through createAndPostOrder', async () => {
    const c = client()
    await submitOrder(c, { tokenId: TOKEN, side: 'BUY', price: '0.5', size: '100', negRisk: false })
    expect(c.createAndPostOrder).toHaveBeenCalledWith({ tokenID: TOKEN, price: 0.5, side: Side.BUY, size: 100 }, { negRisk: false }, 'GTC')
  })
})

describe('toSdkNumber', () => {
  it('is the guard the call above relies on', () => {
    expect(toSdkNumber('0.57')).toBe(0.57)
  })
})
