/**
 * Pure helpers for the funding-pool surfaces (spec 103): progress, votes, buckets, formatting.
 * No chain, no React — unit-tested directly.
 */
import { formatUnits } from '../evm/units'
const DAY = 86400
const HOUR = 3600

/** Percentage toward the goal, capped at 100. Returns 0 for a zero goal. */
export function progressPct(raised, goal) {
  const r = BigInt(raised ?? 0)
  const g = BigInt(goal ?? 0)
  if (g <= 0n) return 0
  if (r >= g) return 100
  return Number((r * 10000n) / g) / 100
}

/** Strict majority of `contributorCount`: ⌊N/2⌋ + 1 (0 while nobody has contributed). */
export function refundVotesNeeded(contributorCount) {
  const n = Number(contributorCount ?? 0)
  if (n <= 0) return 0
  return Math.floor(n / 2) + 1
}

/** Format a token amount for display with at most `maxFraction` decimals and no trailing zeros. */
export function formatAmount(value, decimals = 6, maxFraction = 2) {
  const s = formatUnits(BigInt(value ?? 0), decimals)
  const [int, frac = ''] = s.split('.')
  const trimmed = frac.slice(0, maxFraction).replace(/0+$/, '')
  const withGroups = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return trimmed ? `${withGroups}.${trimmed}` : withGroups
}

/**
 * Human sentence for time remaining until `deadline` (unix seconds).
 * Past ⇒ `pastText` (default "closed").
 */
export function timeLeft(deadline, now = Math.floor(Date.now() / 1000), pastText = 'closed') {
  const left = Number(deadline) - Number(now)
  if (!Number.isFinite(left) || left <= 0) return pastText
  if (left >= 2 * DAY) return `${Math.floor(left / DAY)} days left`
  if (left >= DAY) return '1 day left'
  if (left >= 2 * HOUR) return `${Math.floor(left / HOUR)} hours left`
  if (left >= HOUR) return '1 hour left'
  const mins = Math.max(1, Math.floor(left / 60))
  return `${mins} min left`
}

/** Contribution-window choices offered by the create form. */
export const WINDOW_CHOICES = [
  { id: '1d', label: '1 day', seconds: DAY },
  { id: '3d', label: '3 days', seconds: 3 * DAY },
  { id: '1w', label: '1 week', seconds: 7 * DAY },
  { id: '2w', label: '2 weeks', seconds: 14 * DAY },
  { id: '30d', label: '30 days', seconds: 30 * DAY },
]
export const DEFAULT_WINDOW_ID = '1w'
/** The organizer's settlement grace after contributions close (research R6). */
export const SETTLE_GRACE_SECONDS = 30 * DAY
/** The factory's bounds (`MAX_CONTRIBUTE_WINDOW` / `MAX_SETTLE_WINDOW` in FundingPoolFactory.sol). */
export const MAX_CONTRIBUTE_SECONDS = 30 * DAY
export const MAX_SETTLE_SECONDS = 180 * DAY
/**
 * How far inside a factory bound a form-time deadline is kept. The factory checks the bounds against
 * the timestamp of the block that MINES the create, and the form computed them earlier — a slow
 * confirmation on a choice sitting exactly at a bound would revert `BadDeadlines`. Applied here,
 * once, so the window labels stay true to their values.
 */
export const DEADLINE_MARGIN_SECONDS = HOUR
/** The on-chain cap is in BYTES (`MAX_PURPOSE_BYTES`), not characters — accents and emoji count for more. */
export const PURPOSE_MAX = 200

/** Derive the two absolute deadlines from a window choice, respecting the factory bounds. */
export function deadlinesFor(windowId, now = Math.floor(Date.now() / 1000)) {
  const choice = WINDOW_CHOICES.find((c) => c.id === windowId) ?? WINDOW_CHOICES.find((c) => c.id === DEFAULT_WINDOW_ID)
  const contributeDeadline = now + Math.min(choice.seconds, MAX_CONTRIBUTE_SECONDS - DEADLINE_MARGIN_SECONDS)
  const settleDeadline = Math.min(contributeDeadline + SETTLE_GRACE_SECONDS, now + MAX_SETTLE_SECONDS - DEADLINE_MARGIN_SECONDS)
  return { contributeDeadline, settleDeadline }
}

/** Active vs finished, for My Pools (FR-022). A refunding pool is finished once the member collected. */
export function bucketFor(summary) {
  const state = Number(summary?.state)
  if (state === 1) return 'finished'
  if (state === 2) return summary?.me?.canClaimRefund ? 'active' : 'finished'
  return 'active'
}

/** The one action that matters for a member on a pool row (FR-022). */
export function nextActionFor(summary, now = Math.floor(Date.now() / 1000)) {
  if (!summary) return null
  const state = Number(summary.state)
  const me = summary.me ?? {}
  if (state === 2) return me.canClaimRefund ? 'collect' : null
  if (state === 1) return null
  if (summary.isOrganizer) return 'close'
  if (Number(summary.contributeDeadline) > now) return 'contribute'
  if (Number(summary.settleDeadline) <= now) return 'poke'
  return me.hasContributed && !me.voted ? 'vote' : null
}

/** Validate the create form. Returns an error sentence or null. */
export function validateCreate({ purpose, goal }) {
  const p = String(purpose ?? '').trim()
  if (!p) return 'Give the pool a purpose so people know what they are chipping in for.'
  if (new TextEncoder().encode(p).length > PURPOSE_MAX) {
    return `Keep the purpose under ${PURPOSE_MAX} bytes — accents and emoji count for more than one.`
  }
  const g = Number(goal)
  if (!Number.isFinite(g) || g <= 0) return 'Set a goal amount above zero.'
  return null
}
