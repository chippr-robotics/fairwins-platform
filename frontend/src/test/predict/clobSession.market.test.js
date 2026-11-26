/**
 * submitMarketOrder (spec 114 slice 5) — the ONE new signing-path call: the SDK's existing market-order method
 * on the same client both signer rails already use. These assert the exact SDK call (method, fill-and-kill,
 * numbers, options) and that a venue refusal is thrown rather than returned as "sent".
 */
import { describe, it, expect, vi } from 'vitest'
import { submitMarketOrder, submitRestingOrder, submitOrder, toSdkNumber, Side, OrderType } from '../../lib/predict/clobSession'

const TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563'

const SIGNED = { salt: '1', maker: '0x1', signer: '0x1', taker: '0x0', tokenId: TOKEN, makerAmount: '1', takerAmount: '2', expiration: '0', nonce: '0', feeRateBps: '0', side: 0, signatureType: 0, signature: '0xsig' }

// The ticket's two submit functions BUILD then POST (so the order's id is known before the post); the old
// one-call methods stay on the fake only to assert they are never used by them.
function client(resp = { success: true, orderID: '0xabc', status: 'matched' }) {
  return {
    getNegRisk: vi.fn().mockResolvedValue(false),
    createMarketOrder: vi.fn().mockResolvedValue(SIGNED),
    createOrder: vi.fn().mockResolvedValue(SIGNED),
    postOrder: vi.fn().mockResolvedValue(resp),
    createAndPostMarketOrder: vi.fn().mockResolvedValue(resp),
    createAndPostOrder: vi.fn().mockResolvedValue(resp),
  }
}
const HASH = /^0x[0-9a-f]{64}$/i

describe('submitMarketOrder', () => {
  it('builds with createMarketOrder, then posts the SAME order fill-and-kill — NUMBER amount/price, the plan\'s tick + negRisk', async () => {
    const c = client()
    const out = await submitMarketOrder(c, { tokenId: TOKEN, side: 'BUY', amount: '50', limitPrice: '0.95', negRisk: true, tickSize: '0.01' })
    expect(c.createMarketOrder).toHaveBeenCalledTimes(1)
    expect(c.postOrder).toHaveBeenCalledTimes(1)
    expect(c.createAndPostMarketOrder).not.toHaveBeenCalled()
    expect(c.createAndPostOrder).not.toHaveBeenCalled()
    expect(c.createMarketOrder).toHaveBeenCalledWith(
      { tokenID: TOKEN, side: Side.BUY, amount: 50, price: 0.95, orderType: OrderType.FAK },
      { tickSize: '0.01', negRisk: true },
    )
    expect(c.postOrder).toHaveBeenCalledWith(SIGNED, OrderType.FAK)
    const [order] = c.createMarketOrder.mock.calls[0]
    expect(typeof order.amount).toBe('number')
    expect(typeof order.price).toBe('number')
    expect(out).toEqual({ orderId: '0xabc', status: 'matched', orderHash: expect.stringMatching(HASH), raw: { success: true, orderID: '0xabc', status: 'matched' } })
  })

  it('never uses fill-or-kill', async () => {
    const c = client()
    await submitMarketOrder(c, { tokenId: TOKEN, side: 'SELL', amount: '87.71', limitPrice: '0.57', negRisk: false, tickSize: '0.001' })
    const [order] = c.createMarketOrder.mock.calls[0]
    const [, type] = c.postOrder.mock.calls[0]
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
    expect(c.createMarketOrder).not.toHaveBeenCalled()
    expect(c.postOrder).not.toHaveBeenCalled()
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
    expect(await outcome({ success: true, orderID: '0x1', status: 'matched' })).toEqual({ ok: { orderId: '0x1', status: 'matched', orderHash: expect.stringMatching(HASH), raw: { success: true, orderID: '0x1', status: 'matched' } } })
  })

  it('a THROW out of the SDK (the order could not be built, or the member declined to sign) is passed on untouched: nothing was sent', async () => {
    const c = client()
    c.createMarketOrder.mockRejectedValue(new Error('User rejected the request'))
    const err = await submitMarketOrder(c, ORDER).catch((e) => e)
    expect(err.message).toBe('User rejected the request')
    expect(err.outcomeUnknown).toBeUndefined()
    expect(c.postOrder).not.toHaveBeenCalled()
  })

  it('an answer that never arrived carries the order\'s id, computed before the post, so it can be looked up', async () => {
    const err = await submitMarketOrder(client({ error: 'Network Error' }), ORDER).catch((e) => e)
    expect(err.outcomeUnknown).toBe(true)
    expect(err.orderHash).toMatch(HASH)
  })
})

describe('negRisk — which exchange the signature is for', () => {
  it('is passed when stated; when NOT stated the venue is asked for that token and its answer is passed — never a guessed false', async () => {
    for (const given of [true, false]) {
      const c = client()
      await submitMarketOrder(c, { ...ORDER, negRisk: given })
      expect(c.getNegRisk).not.toHaveBeenCalled()
      expect(c.createMarketOrder.mock.calls[0][1]).toStrictEqual({ tickSize: '0.01', negRisk: given })
    }
    for (const unstated of [undefined, null]) {
      const c = client()
      c.getNegRisk.mockResolvedValue(true)
      await submitMarketOrder(c, { ...ORDER, negRisk: unstated })
      expect(c.getNegRisk).toHaveBeenCalledWith(TOKEN)
      expect(c.createMarketOrder.mock.calls[0][1]).toStrictEqual({ tickSize: '0.01', negRisk: true })
      const r = client()
      r.getNegRisk.mockResolvedValue(true)
      await submitRestingOrder(r, { tokenId: TOKEN, side: 'BUY', price: '0.57', size: '87.71', negRisk: unstated, tickSize: '0.01' })
      expect(r.createOrder.mock.calls[0][1]).toStrictEqual({ tickSize: '0.01', negRisk: true })
    }
  })

  it('a venue that cannot say which exchange stops the order before anything is signed or sent', async () => {
    const c = client()
    c.getNegRisk.mockRejectedValue(new Error('neg risk lookup failed'))
    await expect(submitMarketOrder(c, { ...ORDER, negRisk: undefined })).rejects.toThrow(/neg risk/)
    expect(c.createMarketOrder).not.toHaveBeenCalled()
    expect(c.postOrder).not.toHaveBeenCalled()
  })

  it('an exchange answer that is not a boolean REFUSES the order: nothing is built, signed or posted (never a guessed false)', async () => {
    for (const answer of [undefined, null, 'false', 0]) {
      const c = client()
      c.getNegRisk.mockResolvedValue(answer)
      await expect(submitMarketOrder(c, { ...ORDER, negRisk: undefined })).rejects.toThrow(/Nothing was signed/)
      await expect(
        submitRestingOrder(c, { tokenId: TOKEN, side: 'BUY', price: '0.57', size: '10', negRisk: undefined, tickSize: '0.01' }),
      ).rejects.toThrow(/Nothing was signed/)
      for (const fn of Object.values(c)) if (fn !== c.getNegRisk) expect(fn).not.toHaveBeenCalled()
    }
  })
})

describe('submitRestingOrder — a price the member named', () => {
  it('builds with createOrder then posts GTC — NUMBER price/size and the REVIEWED tick', async () => {
    const c = client({ success: true, orderID: '0xrest', status: 'live' })
    const out = await submitRestingOrder(c, { tokenId: TOKEN, side: 'SELL', price: '0.575', size: '20.5', negRisk: true, tickSize: '0.001' })
    expect(c.createOrder).toHaveBeenCalledWith(
      { tokenID: TOKEN, price: 0.575, side: Side.SELL, size: 20.5 },
      { tickSize: '0.001', negRisk: true },
    )
    expect(c.postOrder).toHaveBeenCalledWith(SIGNED, OrderType.GTC)
    expect(c.createAndPostMarketOrder).not.toHaveBeenCalled()
    expect(c.createAndPostOrder).not.toHaveBeenCalled()
    expect(out).toEqual({ orderId: '0xrest', status: 'live', orderHash: expect.stringMatching(HASH), raw: { success: true, orderID: '0xrest', status: 'live' } })
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
    expect(c.createOrder).not.toHaveBeenCalled()
  })
})

describe('toSdkNumber', () => {
  it('is the guard the call above relies on', () => {
    expect(toSdkNumber('0.57')).toBe(0.57)
  })
})
