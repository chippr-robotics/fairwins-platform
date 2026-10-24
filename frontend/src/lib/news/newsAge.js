/**
 * Coarse, honest age label for a news item (spec 109 FR-004) — the vendor's own freshness varies
 * by asset (research R3), so the age is always shown and always approximate on purpose.
 * Lives in lib/ rather than the component file so the card exports only components
 * (react-refresh/only-export-components).
 */
export function newsAgeLabel(publishedAt, now = Date.now()) {
  const t = Date.parse(publishedAt)
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.floor((now - t) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/**
 * Recency bucket for a news item (spec 109 presentation).
 *
 * Three buckets, because a feed whose rows all carry equal weight makes a one-hour report and a
 * three-month price-prediction piece look like the same claim. The boundaries are coarse on
 * purpose — same reason the age label is: the vendor's freshness varies by asset (research R3),
 * so a finer grid would imply a precision the data does not have.
 *
 * An unparseable date sorts and buckets as OLDEST rather than newest: the normalizer already drops
 * undated items, so this only ever catches something malformed, and burying it is the safe error.
 */
const DAY_MS = 86_400_000

export function newsBucket(publishedAt, now = Date.now()) {
  const t = Date.parse(publishedAt)
  if (!Number.isFinite(t)) return 'earlier'
  const age = now - t
  if (age < DAY_MS) return 'today'
  if (age < 7 * DAY_MS) return 'week'
  return 'earlier'
}

export const NEWS_BUCKET_LABELS = {
  today: 'Today',
  week: 'This week',
  earlier: 'Earlier',
}
