/**
 * Display formatting for Predict event cards (spec 114). Every function returns '—' or null for an
 * unknown input — an unknown is never rendered as zero (FR-012).
 */

export function formatPercent(displayPrice) {
  if (displayPrice == null || displayPrice === '') return '—'
  const pct = Number(displayPrice) * 100
  if (!Number.isFinite(pct)) return '—'
  if (pct < 1) return '<1%'
  if (pct >= 99.5 && pct < 100) return '>99%'
  return Math.round(pct) + '%'
}

export function formatCents(price) {
  if (price == null || price === '') return '—'
  const cents = Number(price) * 100
  if (!Number.isFinite(cents)) return '—'
  if (cents < 0.5) return '<1¢'
  return Math.round(cents) + '¢'
}

export function formatVolume(volume) {
  if (volume == null || volume === '') return null
  const n = Number(volume)
  if (!Number.isFinite(n) || n < 0) return null
  const compact = (v, suffix) => '$' + String(Math.round(v * 10) / 10) + suffix
  if (n >= 1e9) return compact(n / 1e9, 'B')
  if (n >= 1e6) return compact(n / 1e6, 'M')
  if (n >= 1e3) return compact(n / 1e3, 'K')
  return '$' + String(Math.round(n))
}

export function formatClosing(endDate) {
  if (!endDate) return null
  const d = new Date(endDate)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
