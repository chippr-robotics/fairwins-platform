// Shared fixtures for the amount-first ticket tests (spec 114 slice 5): a reading built the way the feed builds
// one. `age` is how long ago the GATEWAY says it confirmed the book (0 = live, 6000 = delayed, 31000 = last
// known), expressed the way the real feed expresses it — the gap between `confirmedAt` and `serverNow` — and
// stamped with the CURRENT monotonic time, so a reading stays in its state for the length of a test.
import { classify } from '../../lib/markets/priceReading'
import { stamp, monotonicNow } from '../../lib/markets/serverClock'

export const TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
export const NO_TOKEN = '52114319501245915516055106046884209969926127482827954674443846427813813222426'

const T0 = Date.parse('2026-11-26T02:10:00.000Z')

export function bookReading({ asks = [], bids = [], tickSize = '0.01', minOrderSize = '5', age = 0, price = '0.5', tokenId = TOKEN } = {}) {
  const now = monotonicNow()
  const s = stamp({ confirmedAt: new Date(T0).toISOString(), serverNow: new Date(T0 + age).toISOString() }, now)
  return classify({ price, asks, bids, stamp: s, extra: { tickSize, minOrderSize, tokenId } }, now)
}

/** A liquid YES book: asks 0.94 / 0.95 / 0.96, bids 0.93 / 0.92. */
export const liquid = (over = {}) =>
  bookReading({
    asks: [['0.94', '200'], ['0.95', '1200'], ['0.96', '12.5']],
    bids: [['0.93', '300'], ['0.92', '5120']],
    price: '0.935', // the venue's midpoint rule: (0.93 + 0.94) / 2
    ...over,
  })
