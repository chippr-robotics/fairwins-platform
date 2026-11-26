/**
 * WHAT IS SHOWN IS WHAT IS SIGNED (spec 114 slice 5, FR-017/FR-018). The SDK takes `price` and `amount` as JS
 * numbers and rounds them by its own per-tick table before it signs. These tests build REAL orders with the
 * installed `@polymarket/clob-client` (a throwaway local key, no network — only the tick-size / neg-risk /
 * fee-rate LOOKUPS the client makes are stubbed) and require the pure BigInt twin to agree with them, then
 * require the ticket's own figures ("You pay at most", the price limit) to equal what the SDK built.
 */
import { describe, it, expect, vi } from 'vitest'
import { createWalletClient, http } from 'viem'
import { polygon } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  makeClobClient,
  marketOrderSignedAmounts,
  restingOrderSignedAmounts,
  toSdkNumber,
} from '../../lib/predict/clobSession'
import { planForTicket } from '../../lib/predict/ticketPlan'
import { liquid, bookReading, TOKEN } from './ticketFixtures'

// The suite-wide setup replaces the SDK with a stub (the real one is heavy to import in every worker). This one
// file needs the REAL package — it is the proof that the figures match what the SDK signs.
const SDK = await vi.importActual('@polymarket/clob-client')
const { OrderBuilder, Side, OrderType } = SDK

const wallet = () =>
  createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: polygon, transport: http('http://127.0.0.1:9') })

/** A real ClobClient (the one the app builds) with ONLY its three market lookups answered locally. */
function offlineClient(tickSize) {
  const client = makeClobClient(wallet(), { key: 'k', secret: 's', passphrase: 'p' }, { ClobClientImpl: SDK.ClobClient })
  client.getTickSize = async () => tickSize
  client.getNegRisk = async () => false
  client.getFeeRateBps = async () => 0
  return client
}

const micro = (decimal) => {
  const [w, f = ''] = String(decimal).split('.')
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'))
}
const decimal = (m) => {
  const n = BigInt(m)
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${n / 1_000_000n}.${frac}` : String(n / 1_000_000n)
}

describe('marketOrderSignedAmounts — pinned to the real SDK (createMarketOrder on a ClobClient)', () => {
  const cases = [
    ['BUY', '50', '0.95', '0.01'],
    ['BUY', '12.34', '0.57', '0.01'],
    ['BUY', '12.345', '0.57', '0.01'], // the SDK floors the USDC input to cents: 12.34
    ['BUY', '0.99', '0.935', '0.001'],
    ['BUY', '250.5', '0.062', '0.001'],
    ['BUY', '33.33', '0.3333', '0.0001'],
    ['SELL', '87.71', '0.57', '0.01'],
    ['SELL', '10.999', '0.935', '0.001'], // shares floor to hundredths: 10.99
    ['SELL', '5', '0.0042', '0.0001'],
  ]
  it.each(cases)('%s %s @ %s on a %s tick: the built order carries the amounts the review shows', async (side, amount, price, tick) => {
    const client = offlineClient(tick)
    const order = await client.createMarketOrder(
      { tokenID: TOKEN, side: side === 'BUY' ? Side.BUY : Side.SELL, amount: toSdkNumber(amount), price: toSdkNumber(price), orderType: OrderType.FAK },
      { tickSize: tick, negRisk: false },
    )
    const signed = marketOrderSignedAmounts({ side, amount, limitPrice: price, tickSize: tick })
    expect(order.makerAmount).toBe(signed.makerUnits.toString())
    expect(order.takerAmount).toBe(signed.takerUnits.toString())
    expect(order.signature).toMatch(/^0x[0-9a-f]+$/i) // really signed, locally
  })

  it('a buy is signed for the amount rounded DOWN to cents, and the figure says so (12.345 -> 12.34)', () => {
    const s = marketOrderSignedAmounts({ side: 'BUY', amount: '12.345', limitPrice: '0.57', tickSize: '0.01' })
    expect(s.maker).toBe('12.34')
  })

  it('refuses what the SDK would refuse: a price outside [tick, 1 - tick], an unknown tick, a non-decimal', () => {
    expect(marketOrderSignedAmounts({ side: 'BUY', amount: '10', limitPrice: '1', tickSize: '0.01' })).toBeNull()
    expect(marketOrderSignedAmounts({ side: 'BUY', amount: '10', limitPrice: '0', tickSize: '0.01' })).toBeNull()
    expect(marketOrderSignedAmounts({ side: 'BUY', amount: '10', limitPrice: '0.5', tickSize: '0.05' })).toBeNull()
    expect(marketOrderSignedAmounts({ side: 'BUY', amount: '1e3', limitPrice: '0.5', tickSize: '0.01' })).toBeNull()
    expect(marketOrderSignedAmounts({ side: 'BUY', amount: '0.004', limitPrice: '0.5', tickSize: '0.01' })).toBeNull()
  })

  // The SDK derives the taker amount in floating point; this twin is exact. Measured over 200,000 orders
  // (2026-11-26): the MAKER amount never differed; a taker amount under 100,000 never differed; from there to a
  // billion it differed, in about 1 order in 50, by one step of the last decimal the SDK signs on that tick;
  // beyond a billion the SDK runs out of precision. The bounds below are that measurement, so a release that
  // drifts further — or at ordinary sizes at all — fails here.
  const UNIT = 1_000_000n
  const EXACT_BELOW = 100_000n * UNIT
  const ONE_STEP_BELOW = 1_000_000_000n * UNIT
  const amountStep = { '0.1': 1_000n, '0.01': 100n, '0.001': 10n, '0.0001': 1n } // micro-units per signed decimal

  it('agrees with the SDK across random orders on every tick: the maker amount ALWAYS, the taker amount exactly at ordinary sizes and within one signed decimal at very large ones', async () => {
    const builder = new OrderBuilder(wallet(), 137, 0)
    // mulberry32. The linear generator this replaced has low bits that cycle with period 4, and the loop drew
    // four numbers per order — so `seed % 4` picked the SAME tick and `seed % 2` the SAME side every time: all
    // 240 "random orders on every tick" were sells on the 0.01 tick. Hence the `seen` counts at the bottom.
    let a = 20261126
    const next = () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const rnd = (n) => Math.floor(next() * n)
    const ticks = { '0.1': 1, '0.01': 2, '0.001': 3, '0.0001': 4 }
    const seen = { ordinary: 0, large: 0, largeDrifted: 0, huge: 0, ticks: new Set(), sides: new Set() }
    for (let i = 0; i < 1500; i++) {
      const tick = Object.keys(ticks)[rnd(4)]
      const pd = ticks[tick]
      const steps = 10 ** pd
      // A third of the prices sit on the edges of the grid — where a small price turns a modest amount into a
      // very large share count.
      const priceUnits = i % 3 === 0 ? [1, 2, 3, steps - 1][rnd(4)] : 1 + rnd(steps - 1)
      const price = (priceUnits / steps).toFixed(pd).replace(/0+$/, '').replace(/\.$/, '')
      // Amounts from cents to ten million, with .99 and whole-dollar endings over-represented.
      const magnitude = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000][rnd(8)]
      let cents = 1 + rnd(magnitude)
      if (i % 5 === 1) cents = Math.floor(cents / 100) * 100 + 99
      if (i % 5 === 2) cents = Math.floor(cents / 100) * 100 + 100
      const amount = (cents / 100).toFixed(2)
      const side = rnd(2) ? 'BUY' : 'SELL'
      const built = await builder.buildMarketOrder(
        { tokenID: TOKEN, side: side === 'BUY' ? Side.BUY : Side.SELL, amount: toSdkNumber(amount), price: toSdkNumber(price), orderType: OrderType.FAK },
        { tickSize: tick, negRisk: i % 2 === 0 },
      )
      const signed = marketOrderSignedAmounts({ side, amount, limitPrice: price, tickSize: tick })
      const at = { i, side, amount, price, tick }
      seen.ticks.add(tick)
      seen.sides.add(side)
      // What the member GIVES is exact, always: it is the "You pay at most" / "You sell up to" figure.
      expect({ ...at, maker: built.makerAmount }).toEqual({ ...at, maker: signed.makerUnits.toString() })
      const diff = BigInt(built.takerAmount) - signed.takerUnits
      const abs = diff < 0n ? -diff : diff
      if (signed.takerUnits < EXACT_BELOW) {
        seen.ordinary++
        expect({ ...at, taker: built.takerAmount }).toEqual({ ...at, taker: signed.takerUnits.toString() })
      } else if (signed.takerUnits < ONE_STEP_BELOW) {
        seen.large++
        if (abs !== 0n) seen.largeDrifted++
        expect({ ...at, withinOneStep: abs <= amountStep[tick] }).toEqual({ ...at, withinOneStep: true })
      } else {
        seen.huge++
        // Past a billion only the scale is asserted: the two agree to better than one part in a trillion.
        expect({ ...at, close: abs * 1_000_000_000_000n <= signed.takerUnits }).toEqual({ ...at, close: true })
      }
    }
    // Every branch really ran — a fuzz that never reaches a range proves nothing about it — and the drift it
    // allows for is one that actually occurs.
    expect([...seen.ticks].sort()).toEqual(['0.0001', '0.001', '0.01', '0.1'])
    expect([...seen.sides].sort()).toEqual(['BUY', 'SELL'])
    expect(seen.ordinary).toBeGreaterThan(900)
    expect(seen.large).toBeGreaterThan(200)
    expect(seen.largeDrifted).toBeGreaterThan(0)
    expect(seen.huge).toBeGreaterThan(5)
  }, 120_000)

  it('the drift is real and is the SDK\'s: $72.99 at one tick of a 0.0001 market is signed one millionth of a share short', async () => {
    // 72.99 ÷ 0.0001 = 729,900 exactly. In floating point the SDK lands a hair under and floors.
    const builder = new OrderBuilder(wallet(), 137, 0)
    const built = await builder.buildMarketOrder(
      { tokenID: TOKEN, side: Side.BUY, amount: 72.99, price: 0.0001, orderType: OrderType.FAK },
      { tickSize: '0.0001', negRisk: false },
    )
    const signed = marketOrderSignedAmounts({ side: 'BUY', amount: '72.99', limitPrice: '0.0001', tickSize: '0.0001' })
    expect(built.makerAmount).toBe('72990000')
    expect(signed.makerUnits).toBe(72_990_000n)
    expect(signed.takerUnits).toBe(729_900_000_000n)
    expect(BigInt(built.takerAmount) - signed.takerUnits).toBe(-1n)
  })
})

describe('a resting order is signed on the tick it was REVIEWED on, or not at all', () => {
  it('the venue\'s tick has become coarser than the reviewed one: the SDK refuses instead of rounding the member\'s price', async () => {
    // Reviewed at 57.5¢ on a 0.001 tick; by the time the order is built the venue's tick is 0.01.
    const client = offlineClient('0.01')
    await expect(
      client.createOrder({ tokenID: TOKEN, side: Side.BUY, size: 10, price: 0.575 }, { tickSize: '0.001', negRisk: false }),
    ).rejects.toThrow(/invalid tick size/)
  })

  it('WITHOUT the tick the same order is built at a different price than the member named — which is why it is passed', async () => {
    const client = offlineClient('0.01')
    const order = await client.createOrder({ tokenID: TOKEN, side: Side.BUY, size: 10, price: 0.575 }, { negRisk: false })
    // 10 shares: a 57.5¢ order would give 5.75 USDC. The SDK rounded the price to the 0.01 grid instead.
    expect(order.makerAmount).not.toBe('5750000')
  })
})

describe('restingOrderSignedAmounts — pinned to the real SDK (createOrder)', () => {
  it.each([
    ['BUY', '87.71', '0.57', '0.01'],
    ['BUY', '5', '0.935', '0.001'],
    ['SELL', '20.5', '0.0042', '0.0001'],
    ['SELL', '10.999', '0.4', '0.01'],
  ])('%s %s @ %s on a %s tick', async (side, shares, price, tick) => {
    const builder = new OrderBuilder(wallet(), 137, 0)
    const order = await builder.buildOrder(
      { tokenID: TOKEN, side: side === 'BUY' ? Side.BUY : Side.SELL, size: toSdkNumber(String(Math.floor(Number(shares) * 100) / 100)), price: toSdkNumber(price) },
      { tickSize: tick, negRisk: false },
    )
    const signed = restingOrderSignedAmounts({ side, shares, limitPrice: price, tickSize: tick })
    expect(order.makerAmount).toBe(signed.makerUnits.toString())
    expect(order.takerAmount).toBe(signed.takerUnits.toString())
  })
})

describe('the ticket’s figures ARE the signed order', () => {
  // Several amounts and both tick sizes; each is planned from a live book, then the SDK builds the order.
  const books = {
    '0.01': () => liquid({ tickSize: '0.01' }),
    '0.001': () =>
      bookReading({ tickSize: '0.001', asks: [['0.940', '200'], ['0.941', '1200'], ['0.965', '12.5']], bids: [['0.935', '300']] }),
  }
  it.each([
    ['0.01', '50'],
    ['0.01', '12.34'],
    ['0.01', '1999.99'], // deeper than the first level: a worse limit than the best ask
    ['0.001', '25'],
    ['0.001', '333.33'],
    ['0.001', '5.05'],
  ])('tick %s, typed $%s: "You pay at most" is the built maker amount and the limit is the signed price', async (tick, typed) => {
    const view = planForTicket({ reading: books[tick](), side: 'buy', typed })
    expect(view.status).toBe('ok')
    const client = offlineClient(tick)
    const order = await client.createMarketOrder(
      { tokenID: TOKEN, side: Side.BUY, amount: toSdkNumber(view.signed.amount), price: toSdkNumber(view.limitPrice), orderType: OrderType.FAK },
      { tickSize: tick, negRisk: false },
    )
    // What the review shows as "You pay at most" ...
    expect(decimal(order.makerAmount)).toBe(view.payAtMost)
    // ... and what the venue will enforce as the limit: the signed amounts imply a price within one tick above the
    // named limit and no further, so no tick-aligned level above the limit can be filled.
    const implied = (BigInt(order.makerAmount) * 1_000_000n) / BigInt(order.takerAmount)
    expect(implied >= micro(view.limitPrice)).toBe(true)
    expect(implied < micro(view.limitPrice) + micro(tick)).toBe(true)
    expect(order.side).toBe(0)
  })

  it('a SELL: the shares shown are the shares signed, at the named limit', async () => {
    const view = planForTicket({ reading: liquid(), side: 'sell', typed: '87.71' })
    expect(view.status).toBe('ok')
    const order = await offlineClient('0.01').createMarketOrder(
      { tokenID: TOKEN, side: Side.SELL, amount: toSdkNumber(view.signed.amount), price: toSdkNumber(view.limitPrice), orderType: OrderType.FAK },
      { tickSize: '0.01', negRisk: false },
    )
    expect(decimal(order.makerAmount)).toBe(view.sellShares)
    expect(BigInt(order.takerAmount)).toBe(micro(view.limitPrice) * micro(view.sellShares) / 1_000_000n)
  })

  it('when the SDK rounds the typed amount, the review carries the ROUNDED figure and says it differs', () => {
    const view = planForTicket({ reading: liquid(), side: 'buy', typed: '12.345' })
    expect(view.status).toBe('ok')
    expect(view.payAtMost).toBe('12.34')
    expect(view.rounded).toBe(true)
    expect(view.signed.amount).toBe('12.34')
  })
})

describe('toSdkNumber — the one string → number boundary', () => {
  it('round-trips plain decimals and refuses anything that would be signed as something else', () => {
    expect(toSdkNumber('50.25')).toBe(50.25)
    expect(toSdkNumber('0.935')).toBe(0.935)
    expect(toSdkNumber('007.500')).toBe(7.5)
    expect(() => toSdkNumber('0.1234567890123456789')).toThrow(/survive/)
    expect(() => toSdkNumber('1e3')).toThrow(/plain decimal/)
    expect(() => toSdkNumber('')).toThrow()
    expect(() => toSdkNumber('abc')).toThrow()
  })
})
