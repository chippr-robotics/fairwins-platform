/**
 * Event → market adapters (spec 114, slice 3).
 *
 * The browse list speaks in events and rows; the existing detail sheet and trade ticket (spec 057)
 * still speak in the spec-057 market DTO. This is the one translation, kept pure so it can be tested
 * without a component. Prices are passed through as the gateway's strings — never parsed here.
 *
 * `negRisk` is the EVENT's flag (`mutuallyExclusive` is the gateway's `negRisk`): the order's exchange
 * contract depends on it, and a row does not carry it.
 */
import { categoryLabel } from './categories'

export function marketFromRow(event, row) {
  if (!event || !row) return null
  const several = (Number(event.marketCount) || 0) > 1 || (event.markets?.length ?? 0) > 1
  const question = several && row.label ? `${event.title} — ${row.label}` : event.title
  return {
    conditionId: row.conditionId,
    question,
    category: categoryLabel(event.category),
    slug: event.slug,
    endDate: event.endDate ?? null,
    // Per-MARKET traded volume (both outcomes share it): decimal strings, or null when the venue did not state
    // it — and null when an older gateway has no such field. A stated "0" stays "0"; null is never drawn as $0.
    volume: row.volume ?? null,
    volume24h: row.volume24h ?? null,
    // `negRisk` selects WHICH exchange contract the order is signed for, so it comes from the
    // market row itself and is never inferred from the event. A row that does not state it cannot
    // be traded from here: an order signed for the wrong exchange is simply rejected, and a guess
    // is how that happens. Null over a guess.
    tradable: Boolean(row.tradable) && typeof row.negRisk === 'boolean',
    negRisk: row.negRisk === true,
    polymarketUrl: event.slug ? `https://polymarket.com/event/${event.slug}` : 'https://polymarket.com',
    outcomes: (row.outcomes || []).map((o) => ({ name: o.name, tokenId: o.tokenId, price: o.price ?? null })),
  }
}

/** The row the title opens: the first tradable one, else the first, else null. */
/**
 * A spec-057 market (the older `/markets` route) → a one-market event, for a gateway that has not
 * been rolled out with the spec-114 `/events` route yet. The app and the gateway deploy on
 * different trains; without this the Predict tab would read "temporarily unavailable" for the
 * whole window between them. Remove once every deployed gateway serves `/events`.
 * Numbers the older route does not carry stay null; nothing is invented.
 */
export function eventFromMarket(market) {
  if (!market || typeof market.conditionId !== 'string') return null
  const outcomes = (market.outcomes || []).map((o) => ({ name: o.name, tokenId: o.tokenId, price: o.price ?? null }))
  return {
    slug: market.slug || market.conditionId,
    title: market.question,
    category: null,
    volume: market.volume?.amount ?? null,
    volume24h: null,
    endDate: market.endDate ?? null,
    mutuallyExclusive: false,
    marketCount: 1,
    live: null,
    markets: [
      {
        conditionId: market.conditionId,
        label: market.question,
        tradable: Boolean(market.tradable),
        negRisk: Boolean(market.negRisk),
        outcomes,
        bestBid: null,
        bestAsk: null,
        lastTradePrice: null,
        displayPrice: outcomes[0]?.price ?? null,
        tickSize: null,
        minOrderSize: null,
      },
    ],
  }
}

export function defaultRow(event) {
  const rows = event?.markets || []
  return rows.find((r) => r.tradable) || rows[0] || null
}
