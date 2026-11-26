/**
 * Polymarket CLOB -> gateway DTO normalization for the /v1/polymarket/* Predict proxy (spec 057).
 *
 * The gateway never passes Polymarket's response shape through to clients: every field the SPA
 * consumes is mapped here, so upstream schema drift breaks THIS module's tests, not the frontend.
 * Monetary amounts always travel as {amount, currency} pairs (USDC) — never a bare number.
 */

import { categoryForTags } from './categories.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x[0-9a-fA-F]*$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
// CLOB token ids are large decimal strings (uint256). Allow 1-78 digits.
const TOKEN_ID_RE = /^\d{1,78}$/
const CURSOR_MAX = 512

/** Polymarket runs only on Polygon (137). Anything else soft-fails as unsupported_chain (FR-018). */
const SUPPORTED_CHAIN = 137

export const isSupportedChain = (chainId) => Number(chainId) === SUPPORTED_CHAIN
export const isAddress = (v) => typeof v === 'string' && ADDRESS_RE.test(v)
export const isTokenId = (v) => typeof v === 'string' && TOKEN_ID_RE.test(v)
export const isHex = (v) => typeof v === 'string' && HEX_RE.test(v)
export const isBytes32 = (v) => typeof v === 'string' && BYTES32_RE.test(v)
export const isCursor = (v) => v == null || (typeof v === 'string' && v.length > 0 && v.length <= CURSOR_MAX)

/** Deep link to the exact market on Polymarket (never-stranded fallback). */
export function polymarketMarketUrl(slug) {
  return slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com'
}

/** {amount, currency:'USDC'} or null. Callers render explicit "no price / illiquid" states for null. */
export function usdcQuote(amount) {
  if (amount == null || amount === '') return null
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) return null
  return { amount: String(amount), currency: 'USDC' }
}

/** A price in [0,1] (probability) as a string, or null. */
function normalizePrice(p) {
  const n = Number(p)
  if (!Number.isFinite(n) || n < 0 || n > 1) return null
  return String(p)
}

/** One market outcome/token -> {name, tokenId, price}, or null when unusable. */
function normalizeOutcome(raw) {
  if (!raw) return null
  const tokenId = String(raw.token_id ?? raw.tokenId ?? raw.asset_id ?? '')
  if (!isTokenId(tokenId)) return null
  return {
    name: typeof raw.outcome === 'string' && raw.outcome !== '' ? raw.outcome : (raw.name ?? 'Outcome'),
    tokenId,
    price: normalizePrice(raw.price),
  }
}

/**
 * One CLOB market -> Market DTO, or null when the record is unusable (dropped upstream of the client
 * so a single malformed market never breaks the grid). Defensive against field-name drift.
 */
export function normalizeMarket(raw) {
  if (!raw) return null
  const conditionId = raw.condition_id ?? raw.conditionId ?? raw.id
  if (typeof conditionId !== 'string' || conditionId === '') return null
  const tokensRaw = Array.isArray(raw.tokens) ? raw.tokens : Array.isArray(raw.outcomes) ? raw.outcomes : []
  const outcomes = tokensRaw.map(normalizeOutcome).filter(Boolean)
  const closed = Boolean(raw.closed) || raw.active === false || raw.accepting_orders === false
  const slug = typeof raw.market_slug === 'string' ? raw.market_slug : (typeof raw.slug === 'string' ? raw.slug : null)
  return {
    conditionId,
    question: typeof raw.question === 'string' && raw.question !== '' ? raw.question : (raw.title ?? conditionId),
    category: typeof raw.category === 'string' ? raw.category : null,
    slug,
    outcomes,
    volume: usdcQuote(raw.volume ?? raw.volume_num ?? null),
    endDate: typeof raw.end_date_iso === 'string' ? raw.end_date_iso : (typeof raw.endDate === 'string' ? raw.endDate : null),
    negRisk: Boolean(raw.neg_risk ?? raw.negRisk),
    // Non-tradable markets show an honest state instead of a buy/sell affordance that would fail.
    tradable: !closed && outcomes.length > 0,
    polymarketUrl: polymarketMarketUrl(slug),
  }
}

/** Market-list body -> {markets, next}. */
export function normalizeMarketPage(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  const markets = list.map(normalizeMarket).filter(Boolean)
  const next = typeof body?.next_cursor === 'string' && body.next_cursor !== '' && body.next_cursor !== 'LTE=' ? body.next_cursor : null
  return { markets, next }
}

/** Parse a Gamma stringified-JSON array field (outcomes/outcomePrices/clobTokenIds) -> array, or []. */
function parseJsonArray(v) {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * One Gamma API market -> Market DTO (the discovery/browse source; live tradable markets by volume,
 * with search). Gamma encodes outcomes/prices/token-ids as stringified JSON arrays that we zip
 * together; field names are camelCase. Returns null when unusable.
 */
export function normalizeGammaMarket(raw) {
  if (!raw) return null
  const conditionId = raw.conditionId ?? raw.condition_id
  if (typeof conditionId !== 'string' || conditionId === '') return null
  const names = parseJsonArray(raw.outcomes)
  const tokenIds = parseJsonArray(raw.clobTokenIds)
  const prices = parseJsonArray(raw.outcomePrices)
  const outcomes = names
    .map((name, i) => {
      const tokenId = String(tokenIds[i] ?? '')
      if (!isTokenId(tokenId)) return null
      return { name: typeof name === 'string' ? name : `Outcome ${i + 1}`, tokenId, price: normalizePrice(prices[i]) }
    })
    .filter(Boolean)
  const closed = Boolean(raw.closed) || raw.active === false
  const slug = typeof raw.slug === 'string' ? raw.slug : null
  return {
    conditionId,
    question: typeof raw.question === 'string' && raw.question !== '' ? raw.question : (raw.title ?? conditionId),
    category: typeof raw.category === 'string' ? raw.category : null,
    slug,
    outcomes,
    volume: usdcQuote(raw.volumeNum ?? raw.volume ?? null),
    endDate: typeof raw.endDate === 'string' ? raw.endDate : null,
    negRisk: Boolean(raw.negRisk),
    tradable: !closed && outcomes.length > 0,
    polymarketUrl: polymarketMarketUrl(slug),
  }
}

/**
 * Assemble a Gamma market page. `q` filters by question text (Gamma /markets has no free-text param, so
 * we filter the volume-ranked page server-side); `next` is the next offset when the page was full.
 */
export function normalizeGammaPage(body, { q = '', offset = 0, limit = 100 } = {}) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
  let markets = list.map(normalizeGammaMarket).filter(Boolean).filter((m) => m.tradable)
  const needle = q.trim().toLowerCase()
  if (needle) markets = markets.filter((m) => m.question.toLowerCase().includes(needle))
  const next = list.length >= limit ? String(offset + limit) : null
  return { markets, next }
}

/**
 * Live fee schedule for a token -> {tokenId, feeRateBps, takerOnly}. Polymarket instructs clients to
 * read fees live (never hardcode; research D3). Returns null when the schedule is missing so the
 * client blocks signing (FR-010) rather than guessing. `fd = {r, e, to}` is the CLOB market-info shape.
 */
export function normalizeFeeRate(body, tokenId) {
  const fd = body?.fd ?? body?.fee ?? body
  const rate = Number(fd?.r ?? fd?.fee_rate_bps ?? fd?.feeRateBps ?? fd?.base_fee ?? NaN)
  if (!Number.isFinite(rate) || rate < 0) return null
  return {
    tokenId: isTokenId(String(tokenId)) ? String(tokenId) : null,
    // Platform taker fee rate in bps (the additive builder fee is layered on client-side from config).
    feeRateBps: Math.round(rate),
    takerOnly: fd?.to == null ? true : Boolean(fd.to),
  }
}

/** One Data-API position -> {tokenId, conditionId, outcome, size, value, bestBid, negRisk}, or null. `negRisk` is boolean only when the venue stated one, else null. */
export function normalizePosition(raw) {
  if (!raw) return null
  const tokenId = String(raw.asset ?? raw.token_id ?? raw.tokenId ?? '')
  if (!isTokenId(tokenId)) return null
  const size = Number(raw.size ?? raw.balance ?? 0)
  if (!Number.isFinite(size) || size <= 0) return null
  return {
    tokenId,
    conditionId: typeof raw.conditionId === 'string' ? raw.conditionId : (raw.condition_id ?? null),
    outcome: typeof raw.outcome === 'string' ? raw.outcome : null,
    size: String(size),
    // Data-API uses camelCase currentValue + curPrice (the current mark, our sell-price proxy).
    value: usdcQuote(raw.currentValue ?? raw.current_value ?? raw.value ?? null),
    bestBid: usdcQuote(raw.curPrice ?? raw.price ?? null),
    // true/false ONLY when the venue stated a boolean; an omitted flag is null, not a stated false.
    negRisk: [raw.negativeRisk, raw.negRisk].find((v) => typeof v === 'boolean') ?? null,
  }
}

/** One open order -> {orderId, tokenId, side, price, size, remaining}, or null. */
export function normalizeOpenOrder(raw) {
  if (!raw) return null
  const orderId = raw.id ?? raw.order_id ?? raw.orderHash
  if (typeof orderId !== 'string' || orderId === '') return null
  return {
    orderId,
    tokenId: String(raw.asset_id ?? raw.token_id ?? ''),
    side: raw.side === 'SELL' || raw.side === 1 ? 'SELL' : 'BUY',
    price: normalizePrice(raw.price),
    size: String(raw.original_size ?? raw.size ?? '0'),
    remaining: String(raw.size_remaining ?? raw.remaining ?? raw.size ?? '0'),
  }
}

export function normalizePositionsList(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  return { positions: list.map(normalizePosition).filter(Boolean) }
}

export function normalizeOpenOrdersList(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  return { orders: list.map(normalizeOpenOrder).filter(Boolean) }
}

/**
 * Validate a client-submitted signed CLOB order body (shape only — the signature is proven on-chain
 * by Polymarket; we refuse obviously malformed input before spending the write quota / upstream call).
 * When `expectedBuilder` is set, the order's `builder` field MUST equal it (or the zero bytes32 when
 * unattributed) so the client can't strip/alter attribution.
 */
export function validateOrderBody(body, expectedBuilder) {
  const order = body?.order
  if (!order || !isAddress(order.maker)) return 'invalid_order'
  if (!isTokenId(String(order.tokenId ?? ''))) return 'invalid_order'
  if (order.side !== 'BUY' && order.side !== 'SELL' && order.side !== 0 && order.side !== 1) return 'invalid_order'
  if (!isHex(body?.signature) || body.signature.length < 4) return 'invalid_order'
  if (order.builder != null && !isBytes32(order.builder)) return 'invalid_order'
  if (expectedBuilder && order.builder != null && order.builder.toLowerCase() !== expectedBuilder.toLowerCase()) {
    return 'builder_mismatch'
  }
  return null
}

/** Validate a cancel body: an order id/hash string + the trader address. */
export function validateCancelBody(body) {
  if (typeof body?.orderId !== 'string' || body.orderId === '') return 'invalid_order'
  if (!isAddress(body?.address)) return 'invalid_address'
  return null
}

// ---- spec 114: live-markets reads (events, books, price history) ---------------------------------
//
// Rules that run through everything below (each has gone wrong in this codebase before):
//  - A number the venue omitted is `null`, never "0"/0. A zero is a claim; an absence is not.
//  - Decimals travel as STRINGS and are never parsed to a float and re-printed when the venue
//    already sent a string. Arithmetic (the display price) is done in integers.
//  - Text only: no `image`, `icon` or markup field is ever forwarded (research R14).

const EVENT_SLUG_RE = /^[a-z0-9-]{1,160}$/
const DECIMAL_RE = /^\d+(\.\d+)?$/
const DESCRIPTION_MAX = 4000
const RESOLUTION_SOURCE_MAX = 500
const TEXT_MAX = 500
const LIVE_TEXT_MAX = 20
export const SUMMARY_MARKET_CAP = 4
export const BOOK_DEPTH_CAP = 25
/** The venue's own rule for the headline probability: midpoint while the spread is at most 10c. */
const MAX_MID_SPREAD_MICRO = 100_000n

/** Range id -> the venue's `interval` + `fidelity` (minutes per point). */
export const HISTORY_RANGES = Object.freeze({
  '1h': { interval: '1h', fidelity: '1' },
  '1d': { interval: '1d', fidelity: '5' },
  '1w': { interval: '1w', fidelity: '30' },
  '1m': { interval: '1m', fidelity: '180' },
  max: { interval: 'max', fidelity: '720' },
})

/** Sort id -> the venue's `order` + `ascending` (probed 2026-11-26: startDate/endDate both accepted). */
export const EVENT_SORTS = Object.freeze({
  volume24h: { order: 'volume24hr', ascending: 'false' },
  newest: { order: 'startDate', ascending: 'false' },
  closing: { order: 'endDate', ascending: 'true' },
})

export const isEventSlug = (v) => typeof v === 'string' && EVENT_SLUG_RE.test(v)
export const isRange = (v) => typeof v === 'string' && Object.hasOwn(HISTORY_RANGES, v)
export const isSort = (v) => typeof v === 'string' && Object.hasOwn(EVENT_SORTS, v)

/**
 * A non-negative decimal as a string, or null. A string that already is one is returned
 * UNCHANGED (never parsed and re-printed); a finite number is printed without exponent notation.
 */
export function decimalString(v) {
  if (typeof v === 'string') return DECIMAL_RE.test(v) ? v : null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  const s = String(v)
  if (!/e/i.test(s)) return s
  return v.toFixed(8).replace(/\.?0+$/, '')
}

/** A probability in [0,1] as a string, or null (omitted, empty, non-numeric or out of range). */
function probabilityString(v) {
  const s = decimalString(v)
  if (s == null) return null
  return Number(s) <= 1 ? s : null
}

/** "0.935" -> 935000n (micro-units); null when it has more than 6 decimals (cannot be exact). */
function toMicro(s) {
  if (typeof s !== 'string' || !DECIMAL_RE.test(s)) return null
  const [i, f = ''] = s.split('.')
  if (f.length > 6) return null
  return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0'))
}

/** Tenth-of-micro units (7 decimals) -> trimmed decimal string. */
function fromTenthMicro(n) {
  const whole = n / 10_000_000n
  const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : String(whole)
}

/**
 * The headline probability (FR-015): the midpoint of best bid/ask while the spread is at most
 * 10c, else the last trade; null when neither is derivable. Integer arithmetic only — 0.93 and
 * 0.94 give exactly "0.935", never 0.9350000000000001.
 */
export function displayPrice(bestBid, bestAsk, lastTradePrice) {
  const bid = toMicro(bestBid)
  const ask = toMicro(bestAsk)
  if (bid != null && ask != null && ask >= bid && ask - bid <= MAX_MID_SPREAD_MICRO) {
    return fromTenthMicro((bid + ask) * 5n)
  }
  return lastTradePrice ?? null
}

/** Plain text, control characters removed, capped by code points; null when empty/not a string. */
export function plainText(v, max) {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  if (cleaned.trim() === '') return null
  const points = Array.from(cleaned)
  return points.length > max ? points.slice(0, max).join('') : cleaned
}

/**
 * In-play state (FR-002b): `{ score, period, elapsed }` (each plain text <= 20 chars, or null when the
 * venue omitted or blanked it) ONLY when the venue says `live === true && ended !== true`; else null.
 * A status the venue did not give is never invented.
 */
export function normalizeLive(raw) {
  if (raw?.live !== true || raw?.ended === true) return null
  return {
    score: plainText(raw.score, LIVE_TEXT_MAX),
    period: plainText(raw.period, LIVE_TEXT_MAX),
    elapsed: plainText(raw.elapsed, LIVE_TEXT_MAX),
  }
}

const isResolved = (raw) => raw?.closed === true && raw?.umaResolutionStatus === 'resolved'

/**
 * One Gamma market inside an event -> MarketRow, or null when it has no condition id.
 * `detail` adds `winner` to resolved rows: the outcome whose price is exactly 1 on a closed,
 * UMA-resolved market; null when that cannot be determined (never guessed).
 */
export function normalizeMarketRow(raw, { detail = false } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const conditionId = raw.conditionId ?? raw.condition_id
  if (typeof conditionId !== 'string' || conditionId === '') return null
  const names = parseJsonArray(raw.outcomes)
  const tokenIds = parseJsonArray(raw.clobTokenIds)
  const prices = parseJsonArray(raw.outcomePrices)
  const outcomes = names
    .map((name, i) => {
      const tokenId = String(tokenIds[i] ?? '')
      if (!isTokenId(tokenId)) return null
      return {
        name: typeof name === 'string' ? name : `Outcome ${i + 1}`,
        tokenId,
        price: probabilityString(prices[i]),
      }
    })
    .filter(Boolean)
  const bestBid = probabilityString(raw.bestBid)
  const bestAsk = probabilityString(raw.bestAsk)
  const lastTradePrice = probabilityString(raw.lastTradePrice)
  const row = {
    conditionId,
    label: plainText(raw.groupItemTitle, TEXT_MAX) ?? plainText(raw.question, TEXT_MAX) ?? conditionId,
    tradable: raw.closed !== true && raw.active !== false && raw.acceptingOrders !== false && outcomes.length > 0,
    // The MARKET's own flag (it selects the exchange contract an order is signed for) — never the event's.
    negRisk: Boolean(raw.negRisk ?? raw.neg_risk),
    outcomes,
    // Per MARKET (both outcomes share it); null when the venue row omits it, never "0".
    volume: decimalString(raw.volume) ?? decimalString(raw.volumeNum),
    volume24h: decimalString(raw.volume24hr),
    bestBid,
    bestAsk,
    lastTradePrice,
    displayPrice: displayPrice(bestBid, bestAsk, lastTradePrice),
    tickSize: decimalString(raw.orderPriceMinTickSize),
    minOrderSize: decimalString(raw.orderMinSize),
  }
  if (detail && isResolved(raw)) {
    const winners = outcomes.filter((o) => o.price != null && Number(o.price) === 1)
    row.winner = winners.length === 1 ? winners[0].name : null
  }
  return row
}

/** Sort key for "most likely first": the Yes outcome's price (else the first outcome's); null last. */
function likelihood(row) {
  const yes = row.outcomes.find((o) => typeof o.name === 'string' && o.name.toLowerCase() === 'yes') ?? row.outcomes[0]
  return yes?.price != null ? Number(yes.price) : -1
}

function eventStatus(raw, rows) {
  if (raw.closed === true) {
    return rows.length > 0 && rows.every((r) => r.winner !== undefined) ? 'resolved' : 'closed'
  }
  return raw.active === false ? 'closed' : 'open'
}

/**
 * One Gamma event -> EventSummary (default) or EventDetail (`detail: true`), or null when it has no
 * slug/title. Summary: at most four rows, tradable first then by Yes price descending, with the
 * total in `marketCount`. Detail: every row (venue order) plus description, resolutionSource,
 * status, and `winner` on resolved rows.
 */
export function normalizeEvent(raw, { detail = false } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const slug = raw.slug
  const title = plainText(raw.title, TEXT_MAX)
  if (!isEventSlug(slug) || title == null) return null
  const rawMarkets = Array.isArray(raw.markets) ? raw.markets : []
  const rows = rawMarkets.map((m) => normalizeMarketRow(m, { detail })).filter(Boolean)
  const base = {
    slug,
    title,
    category: categoryForTags(raw.tags),
    volume: decimalString(raw.volume),
    volume24h: decimalString(raw.volume24hr),
    endDate: typeof raw.endDate === 'string' && raw.endDate !== '' ? raw.endDate : null,
    mutuallyExclusive: Boolean(raw.negRisk),
    marketCount: rows.length,
    live: normalizeLive(raw),
  }
  if (!detail) {
    const ranked = rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => Number(b.row.tradable) - Number(a.row.tradable) || likelihood(b.row) - likelihood(a.row) || a.i - b.i)
      .map(({ row }) => row)
    return { ...base, markets: ranked.slice(0, SUMMARY_MARKET_CAP) }
  }
  const marketSource = rawMarkets.find((m) => typeof m?.resolutionSource === 'string' && m.resolutionSource !== '')?.resolutionSource
  return {
    ...base,
    description: plainText(raw.description, DESCRIPTION_MAX) ?? '',
    resolutionSource: plainText(raw.resolutionSource || marketSource, RESOLUTION_SOURCE_MAX),
    status: eventStatus(raw, rows),
    markets: rows,
  }
}

/**
 * Events list body (an array from /events, or {events,pagination} from /public-search) ->
 * {events, next}. Closed events are not listed. `next` is the next numeric cursor when the venue
 * says there is more (a full page for /events; `pagination.hasMore` for search), else null.
 */
export function normalizeEventPage(body, { offset = 0, limit = 20 } = {}) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : []
  const events = list
    .filter((e) => e?.closed !== true)
    .map((e) => normalizeEvent(e))
    .filter(Boolean)
  const more = Array.isArray(body) ? list.length >= limit : body?.pagination?.hasMore === true
  return { events, next: more ? String(offset + limit) : null }
}

/** [price, size] string pairs, venue strings preserved exactly; malformed levels are dropped. */
function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return null
  const out = []
  for (const l of levels) {
    const price = decimalString(l?.price)
    const size = decimalString(l?.size)
    if (price == null || size == null) continue
    out.push([price, size])
  }
  // The venue sends WORST-first (best is last). Sort by price rather than trusting that order, so a
  // venue that changes direction cannot silently invert the book. Bids high->low, asks low->high.
  out.sort((a, b) => (side === 'bids' ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0])))
  return out.slice(0, BOOK_DEPTH_CAP)
}

/**
 * One CLOB /book body -> Book, or null when it is not a readable book (no token id, or bids/asks
 * not arrays). A null is an UNREADABLE token upstream — never an empty book. A genuinely empty
 * book (both arrays present and empty) is a real read and stays `[]`.
 */
export function normalizeBook(raw) {
  if (!raw || typeof raw !== 'object') return null
  const tokenId = String(raw.asset_id ?? '')
  if (!isTokenId(tokenId)) return null
  const bids = normalizeLevels(raw.bids, 'bids')
  const asks = normalizeLevels(raw.asks, 'asks')
  if (bids == null || asks == null) return null
  const ts = Number(raw.timestamp)
  return {
    tokenId,
    bids,
    asks,
    tickSize: decimalString(raw.tick_size),
    minOrderSize: decimalString(raw.min_order_size),
    lastTradePrice: probabilityString(raw.last_trade_price),
    venueTime: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
    venueHash: typeof raw.hash === 'string' && raw.hash !== '' ? raw.hash : null,
  }
}

/** CLOB /prices-history body -> [{t, p}] (unix seconds, price string). Empty is `[]`, not an error. */
export function normalizeHistory(body) {
  const list = Array.isArray(body?.history) ? body.history : []
  const points = []
  for (const h of list) {
    const t = Number(h?.t)
    const p = probabilityString(h?.p)
    if (!Number.isInteger(t) || t <= 0 || p == null) continue
    points.push({ t, p })
  }
  return points
}
