// Gateway `/events` DTOs (spec 114 contracts/gateway-predict-api.md), already normalised.
export const mkRow = (over = {}) => ({
  conditionId: '0xc1',
  label: 'Row',
  tradable: true,
  negRisk: false,
  outcomes: [
    { name: 'Yes', tokenId: '111', price: '0.935' },
    { name: 'No', tokenId: '222', price: '0.065' },
  ],
  bestBid: '0.93',
  bestAsk: '0.94',
  lastTradePrice: '0.93',
  displayPrice: '0.935',
  tickSize: '0.01',
  minOrderSize: '5',
  ...over,
})

export const mkEvent = (over = {}) => ({
  slug: 'an-event',
  title: 'An Event',
  category: 'economy',
  volume: '61605847.12',
  volume24h: '1820443.9',
  endDate: '2026-12-10T12:00:00Z',
  mutuallyExclusive: true,
  marketCount: 1,
  markets: [mkRow()],
  ...over,
})

export const FED = mkEvent({
  slug: 'fed-decision-in-december',
  title: 'Fed Decision in December?',
  marketCount: 6,
  markets: [
    mkRow({ conditionId: '0xf1', label: '25 bps increase', displayPrice: '0.935' }),
    mkRow({ conditionId: '0xf2', label: 'No change', displayPrice: '0.05' }),
    mkRow({ conditionId: '0xf3', label: '50+ bps decrease', displayPrice: '0.004' }),
    mkRow({ conditionId: '0xf4', label: '25 bps decrease', displayPrice: null }),
  ],
})

export const RAIN = mkEvent({
  slug: 'rain-london',
  title: 'Will it rain in London tomorrow?',
  category: 'world',
  volume: null,
  endDate: null,
  marketCount: 1,
  markets: [mkRow({ conditionId: '0xr1', label: 'Will it rain in London tomorrow?', displayPrice: '0.62' })],
})

export const envelope = (over = {}) => ({
  confirmedAt: '2026-11-26T02:10:00.000Z',
  serverNow: '2026-11-26T02:10:09.000Z',
  stale: false,
  ...over,
})

// ── Event detail (`/events/:slug`) fixtures — spec 114 slice 4 ──

/** `n` rows, most likely LAST on purpose (the page must rank them), each with its own Yes/No tokens. */
export const mkRows = (n, { negRisk = false } = {}) =>
  Array.from({ length: n }, (_, i) =>
    mkRow({
      conditionId: `0xr${i}`,
      label: `Row ${i}`,
      negRisk,
      outcomes: [
        { name: 'Yes', tokenId: `y${i}`, price: String(((i + 1) / (n + 1)).toFixed(3)) },
        { name: 'No', tokenId: `n${i}`, price: String((1 - (i + 1) / (n + 1)).toFixed(3)) },
      ],
      displayPrice: String(((i + 1) / (n + 1)).toFixed(3)),
    }),
  )

export const mkDetail = (over = {}) => {
  const markets = over.markets ?? mkRows(3)
  return {
    slug: 'fed-decision-in-december',
    title: 'Fed Decision in December?',
    category: 'economy',
    volume: '61605847.12',
    volume24h: '1820443.9',
    endDate: '2030-12-10T12:00:00Z',
    mutuallyExclusive: true,
    marketCount: markets.length,
    live: null,
    description: 'Resolves to the FOMC target range announced on the decision date.',
    resolutionSource: 'https://www.federalreserve.gov/monetarypolicy.htm',
    status: 'open',
    ...over,
    markets,
  }
}

/** The full `/events/:slug` body: the event itself plus the envelope. */
export const detailBody = (over = {}, env = {}) => ({ ...mkDetail(over), ...envelope(env) })
