/**
 * submitMarketOrder (spec 114 slice 5) — the ONE new signing-path call: the SDK's existing market-order method
 * on the same client both signer rails already use. These assert the exact SDK call (method, fill-and-kill,
 * numbers, options) and that a venue refusal is thrown rather than returned as "sent".
 */
import { describe, it, expect, vi } from 'vitest'
import { submitMarketOrder, submitRestingOrder, submitOrder, toSdkNumber, Side, OrderType } from '../../lib/predict/clobSession'

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

  it('leaves submitOrder (the fixed-price confirm\'s path) exactly as it was: GTC through createAndPostOrder', async () => {
    const c = client()
    await submitOrder(c, { tokenId: TOKEN, side: 'BUY', price: '0.5', size: '100', negRisk: false })
    expect(c.createAndPostOrder).toHaveBeenCalledWith({ tokenID: TOKEN, price: 0.5, side: Side.BUY, size: 100 }, { negRisk: false }, 'GTC')
  })
})

const ORDER = { tokenId: TOKEN, side: 'BUY', amount: '10', limitPrice: '0.5', negRisk: false, tickSize: '0.01' }
const outcome = (resp) => submitMarketOrder(client(resp), ORDER).then(
  (ok) => ({ ok }),
  (e) => ({ message: e.message, outcomeUnknown: e.outcomeUnknown, status: e.status }),
)

describe('what the venue\'s answer means — refused, unknown, or taken', () => {
  // The SDK never throws from the post: every failure comes back as `{ error, status? }`. These are the
  // shapes its HTTP helper produces (http-helpers/index.js#errorHandling).
  it('a 4xx is a definite refusal — nothing was placed, so it is NOT "outcome unknown"', async () => {
    expect(await outcome({ error: 'invalid signature', status: 400 })).toEqual({ message: 'invalid signature', outcomeUnknown: false, status: 400 })
    expect(await outcome({ error: 'Trading restricted in your region', status: 403 })).toMatchObject({ outcomeUnknown: false, status: 403 })
    expect(await outcome({ error: 'rate limited', status: 429 })).toMatchObject({ outcomeUnknown: false })
  })

  it('NO HTTP status (the connection failed or the answer never arrived): the order may have been received', async () => {
    expect(await outcome({ error: 'Network Error' })).toEqual({
      message: 'Polymarket did not confirm whether it received this order.',
      outcomeUnknown: true,
      status: undefined,
    })
    expect(await outcome({ error: 'timeout of 10000ms exceeded' })).toMatchObject({ outcomeUnknown: true })
  })

  it('a 5xx or a 408, JSON or an HTML error page: unknown — and the page is never the reason text', async () => {
    for (const resp of [
      { error: '<html><head><title>504 Gateway Time-out</title></head><body>cloudflare</body></html>', status: 504 },
      { error: 'internal error', status: 500 },
      { error: { message: 'bad gateway' }, status: 502 },
      { error: 'request timeout', status: 408 },
    ]) {
      const got = await outcome(resp)
      expect(got.outcomeUnknown).toBe(true)
      expect(got.message).toBe('Polymarket did not confirm whether it received this order.')
    }
  })

  it('an error body WITHOUT a string error is still a failure, never "order sent" (it used to be reported as done)', async () => {
    // errorHandling returns `{ error: <the body object>, status }` when the JSON body has no `error` key.
    expect(await outcome({ error: { detail: 'malformed order' }, status: 422 })).toEqual({
      message: 'Polymarket refused the order (HTTP 422).',
      outcomeUnknown: false,
      status: 422,
    })
    // …and an HTML 4xx (a challenge page) is a refusal whose page is not shown.
    const page = await outcome({ error: '<!DOCTYPE html><html>Attention Required</html>', status: 403 })
    expect(page).toMatchObject({ outcomeUnknown: false, message: 'Polymarket refused the order (HTTP 403).' })
  })

  it('`success: false` on a 200 is the venue\'s own no; a taken order is returned', async () => {
    expect(await outcome({ success: false, errorMsg: 'not enough balance', orderID: '' })).toMatchObject({ message: 'not enough balance', outcomeUnknown: false })
    expect(await outcome({ success: false })).toMatchObject({ message: 'The venue did not accept the order.', outcomeUnknown: false })
    expect(await outcome({ success: true, orderID: '0x1', status: 'matched' })).toEqual({ ok: { orderId: '0x1', status: 'matched', raw: { success: true, orderID: '0x1', status: 'matched' } } })
  })

  it('a THROW out of the SDK (the order could not be built, or the member declined to sign) is passed on untouched: nothing was sent', async () => {
    const c = client()
    c.createAndPostMarketOrder.mockRejectedValue(new Error('User rejected the request'))
    const err = await submitMarketOrder(c, ORDER).catch((e) => e)
    expect(err.message).toBe('User rejected the request')
    expect(err.outcomeUnknown).toBeUndefined()
  })
})

describe('negRisk — which exchange the signature is for', () => {
  it('is passed when stated and LEFT OUT when not, so the SDK asks the venue instead of signing a guessed false', async () => {
    for (const [given, options] of [
      [true, { tickSize: '0.01', negRisk: true }],
      [false, { tickSize: '0.01', negRisk: false }],
      [undefined, { tickSize: '0.01' }],
      [null, { tickSize: '0.01' }],
    ]) {
      const c = client()
      await submitMarketOrder(c, { ...ORDER, negRisk: given })
      expect(c.createAndPostMarketOrder.mock.calls[0][1]).toStrictEqual(options)
      const r = client()
      await submitRestingOrder(r, { tokenId: TOKEN, side: 'BUY', price: '0.57', size: '87.71', negRisk: given, tickSize: '0.01' })
      expect(r.createAndPostOrder.mock.calls[0][1]).toStrictEqual(options)
    }
  })
})

describe('submitRestingOrder — a price the member named', () => {
  it('posts GTC through createAndPostOrder with NUMBER price/size and the REVIEWED tick', async () => {
    const c = client({ success: true, orderID: '0xrest', status: 'live' })
    const out = await submitRestingOrder(c, { tokenId: TOKEN, side: 'SELL', price: '0.575', size: '20.5', negRisk: true, tickSize: '0.001' })
    expect(c.createAndPostOrder).toHaveBeenCalledWith(
      { tokenID: TOKEN, price: 0.575, side: Side.SELL, size: 20.5 },
      { tickSize: '0.001', negRisk: true },
      OrderType.GTC,
    )
    expect(c.createAndPostMarketOrder).not.toHaveBeenCalled()
    expect(out).toEqual({ orderId: '0xrest', status: 'live', raw: { success: true, orderID: '0xrest', status: 'live' } })
  })

  it('a refusal or an unread answer is thrown, never reported as an order placed', async () => {
    const refused = await submitRestingOrder(client({ error: 'invalid price', status: 400 }), { tokenId: TOKEN, side: 'BUY', price: '0.57', size: '10', tickSize: '0.01' }).catch((e) => e)
    expect(refused).toMatchObject({ message: 'invalid price', outcomeUnknown: false })
    const lost = await submitRestingOrder(client({ error: 'Network Error' }), { tokenId: TOKEN, side: 'BUY', price: '0.57', size: '10', tickSize: '0.01' }).catch((e) => e)
    expect(lost.outcomeUnknown).toBe(true)
  })

  it('refuses a price or size that does not survive the number conversion — nothing is sent', async () => {
    const c = client()
    await expect(submitRestingOrder(c, { tokenId: TOKEN, side: 'BUY', price: 'unusable', size: '10', tickSize: '0.01' })).rejects.toThrow()
    expect(c.createAndPostOrder).not.toHaveBeenCalled()
  })
})

describe('toSdkNumber', () => {
  it('is the guard the call above relies on', () => {
    expect(toSdkNumber('0.57')).toBe(0.57)
  })
})
