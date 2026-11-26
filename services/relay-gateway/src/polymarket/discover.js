/**
 * Quick-filter topic selection for the Predict surface (spec 114, research R16).
 *
 * `selectTopics` is PURE: given the venue's most-traded events it picks up to `max` tags by MARGINAL
 * day volume, so two tags that name the same events yield one topic and no list of synonyms has to
 * be maintained. Nothing here touches the network.
 */
import { decimalString, plainText } from './normalize.js'
import { isCategoryTagSlug } from './categories.js'

/** Tags that describe a market's mechanics, not its subject. Compared case-insensitively. */
export const MECHANICS_DENYLIST = Object.freeze([
  'recurring',
  'games',
  'hit-price',
  'crypto-prices',
  'up-or-down',
  'hide-from-new',
  '5m',
  '15m',
  'earn-4',
])
const EARN_RE = /^earn-\d+$/i
/** The venue's own spelling is sent back as `tag_slug`, so mixed case is legal. */
export const TOPIC_SLUG_RE = /^[A-Za-z0-9-]{1,64}$/
const SUB_HOUR_MS = 60 * 60 * 1000
const RECURRENCE_SHORT_RE = /^\d+m$/i
const LABEL_MAX = 40
const MICRO = 1_000_000n

/** A non-negative number/decimal as integer micro-units (extra decimals truncated); 0n when absent. */
export function volumeMicro(v) {
  const s = decimalString(v)
  if (s == null) return 0n
  const [i, f = ''] = s.split('.')
  return BigInt(i) * MICRO + BigInt(f.slice(0, 6).padEnd(6, '0'))
}

/** Micro-units -> trimmed decimal string ("1820443.9", "5"). */
export function microToDecimal(n) {
  const whole = n / MICRO
  const frac = (n % MICRO).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : String(whole)
}

/**
 * Sub-hour = it ends more than zero and at most sixty minutes after it starts, OR its series
 * recurrence is a minutes cadence (5m, 15m). A match has a zero or multi-day span (FR-002c).
 */
export function isSubHourEvent(e) {
  const series = Array.isArray(e?.series) ? e.series : []
  if (series.some((s) => typeof s?.recurrence === 'string' && RECURRENCE_SHORT_RE.test(s.recurrence))) return true
  const start = Date.parse(e?.startTime)
  const end = Date.parse(e?.endDate)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  const span = end - start
  return span > 0 && span <= SUB_HOUR_MS
}

/**
 * @param {object[]} events raw Gamma events (most-traded first is typical, order is irrelevant)
 * @param {{max?: number, minShare?: number, excludeSlugs?: Iterable<string>, isCategoryTag?: (slug: string) => boolean}} [opts]
 *   `excludeSlugs` is ADDITIVE to MECHANICS_DENYLIST; `minShare` is the floor as a share of the
 *   considered events' total day volume (default 1%).
 * @returns {{slug: string, label: string, events: number, volume24h: string}[]}
 */
export function selectTopics(events, { max = 8, minShare = 0.01, excludeSlugs = [], isCategoryTag = isCategoryTagSlug } = {}) {
  if (!Array.isArray(events)) return []
  const denied = new Set([...MECHANICS_DENYLIST, ...excludeSlugs].map((s) => String(s).toLowerCase()))
  const skip = (t) =>
    t.forceHide === true || denied.has(t.slug.toLowerCase()) || EARN_RE.test(t.slug) || isCategoryTag(t.slug)

  // Considered events: not sub-hour, with a positive day volume.
  const considered = []
  for (const e of events) {
    if (!e || typeof e !== 'object' || isSubHourEvent(e)) continue
    const micro = volumeMicro(e.volume24hr)
    if (micro <= 0n) continue
    considered.push({ micro, tags: Array.isArray(e.tags) ? e.tags : [] })
  }
  const total = considered.reduce((a, e) => a + e.micro, 0n)
  const floor = (total * BigInt(Math.round(Math.max(0, minShare) * 1e6))) / MICRO

  // tag slug -> { label, members: event indexes }
  const byTag = new Map()
  considered.forEach((e, idx) => {
    const seen = new Set()
    for (const t of e.tags) {
      if (!t || typeof t.slug !== 'string' || !TOPIC_SLUG_RE.test(t.slug) || seen.has(t.slug) || skip(t)) continue
      seen.add(t.slug)
      const entry = byTag.get(t.slug) ?? { label: null, members: [] }
      entry.label ??= plainText(t.label, LABEL_MAX)
      entry.members.push(idx)
      byTag.set(t.slug, entry)
    }
  })

  const covered = new Set()
  const picked = []
  const remaining = new Set(byTag.keys())
  // Ranking is by FOCUS, not by raw volume: marginal day volume divided by the square root of the
  // events it is spread over (owner's decision, 2026-11-26). Raw volume favours a wide tag
  // ("finance", seventeen events) over a narrow one carrying nearly as much ("fed", three), and a
  // quick filter is most useful when it narrows to one subject. vol/sqrt(n) orders the same as
  // vol^2/n, which is compared by cross-multiplying in BigInt so no float enters the choice.
  const outranks = (a, b) => {
    const left = a.vol * a.vol * BigInt(b.count)
    const right = b.vol * b.vol * BigInt(a.count)
    if (left !== right) return left > right
    if (a.vol !== b.vol) return a.vol > b.vol
    return a.slug < b.slug
  }
  while (picked.length < max && remaining.size > 0) {
    let best = null
    for (const slug of remaining) {
      let vol = 0n
      let count = 0
      for (const idx of byTag.get(slug).members) {
        if (covered.has(idx)) continue
        vol += considered[idx].micro
        count += 1
      }
      // The floor is on what a topic CARRIES, and it filters candidates rather than ending the
      // search: under focus ranking a tiny single-event tag can outscore a wide tag that clears
      // the floor, and stopping at the first would hide the second.
      if (vol <= 0n || vol < floor) continue
      const candidate = { slug, vol, count }
      if (best == null || outranks(candidate, best)) best = candidate
    }
    if (best == null) break
    for (const idx of byTag.get(best.slug).members) covered.add(idx)
    remaining.delete(best.slug)
    picked.push({
      slug: best.slug,
      label: byTag.get(best.slug).label ?? best.slug.slice(0, LABEL_MAX),
      events: best.count,
      volume24h: microToDecimal(best.vol),
    })
  }
  return picked
}
