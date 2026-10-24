import { describe, it, expect } from 'vitest'
import {
  progressPct, refundVotesNeeded, formatAmount, timeLeft, deadlinesFor, bucketFor, nextActionFor, validateCreate,
  MAX_CONTRIBUTE_SECONDS, MAX_SETTLE_SECONDS, SETTLE_GRACE_SECONDS, DEADLINE_MARGIN_SECONDS,
  WINDOW_CHOICES, DEFAULT_WINDOW_ID, PURPOSE_MAX,
} from '../../lib/funding/progress'

// Pure helpers behind the funding-pool surfaces (spec 103).

describe('progressPct', () => {
  it('caps at 100, handles zero goal, keeps two decimals', () => {
    expect(progressPct(0n, 100n)).toBe(0)
    expect(progressPct(33n, 100n)).toBe(33)
    expect(progressPct(1n, 3n)).toBe(33.33)
    expect(progressPct(100n, 100n)).toBe(100)
    expect(progressPct(250n, 100n)).toBe(100)
    expect(progressPct(5n, 0n)).toBe(0)
  })
})

describe('refundVotesNeeded — strict majority ⌊N/2⌋+1 (FR-016)', () => {
  it.each([[0, 0], [1, 1], [2, 2], [3, 2], [4, 3], [5, 3], [10, 6], [11, 6]])('N=%i → %i', (n, needed) => {
    expect(refundVotesNeeded(n)).toBe(needed)
  })
})

describe('formatAmount', () => {
  it('formats base units with grouping and no trailing zeros', () => {
    expect(formatAmount(1_000_000n, 6)).toBe('1')
    expect(formatAmount(1_250_000n, 6)).toBe('1.25')
    expect(formatAmount(1_234_567_890n, 6)).toBe('1,234.56')
    expect(formatAmount(0n, 6)).toBe('0')
    expect(formatAmount(10n ** 18n, 18)).toBe('1')
  })
})

describe('timeLeft', () => {
  const now = 1_000_000
  it('reads as a sentence and reports the past honestly', () => {
    expect(timeLeft(now + 3 * 86400, now)).toBe('3 days left')
    expect(timeLeft(now + 86400 + 10, now)).toBe('1 day left')
    expect(timeLeft(now + 5 * 3600, now)).toBe('5 hours left')
    expect(timeLeft(now + 3600, now)).toBe('1 hour left')
    expect(timeLeft(now + 120, now)).toBe('2 min left')
    expect(timeLeft(now - 1, now)).toBe('closed')
    expect(timeLeft(now - 1, now, 'contributions closed')).toBe('contributions closed')
  })
})

describe('deadlinesFor', () => {
  it('derives both absolute deadlines inside the factory bounds for every window choice', () => {
    const now = 1_700_000_000
    for (const c of WINDOW_CHOICES) {
      const { contributeDeadline, settleDeadline } = deadlinesFor(c.id, now)
      expect(contributeDeadline).toBeGreaterThan(now)
      expect(contributeDeadline).toBeLessThanOrEqual(now + 30 * 86400)
      expect(settleDeadline).toBeGreaterThan(contributeDeadline)
      expect(settleDeadline).toBeLessThanOrEqual(now + 180 * 86400)
    }
    expect(deadlinesFor('nope', now)).toEqual(deadlinesFor(DEFAULT_WINDOW_ID, now))
  })

  it('keeps the window labels true and applies the bound margin once, in deadlinesFor', () => {
    const now = 1_700_000_000
    const thirty = WINDOW_CHOICES.find((c) => c.id === '30d')
    // The option IS 30 days — the margin is not hidden inside the value.
    expect(thirty.seconds).toBe(MAX_CONTRIBUTE_SECONDS)
    // A choice sitting on the factory bound is pulled inside it by exactly the named margin.
    expect(deadlinesFor('30d', now).contributeDeadline).toBe(now + MAX_CONTRIBUTE_SECONDS - DEADLINE_MARGIN_SECONDS)
    // A choice well inside the bound is untouched.
    expect(deadlinesFor('1w', now).contributeDeadline).toBe(now + 7 * 86400)
    // The settle deadline is contribute + grace, capped inside the settle bound by the same margin.
    expect(deadlinesFor('1w', now).settleDeadline).toBe(now + 7 * 86400 + SETTLE_GRACE_SECONDS)
    expect(deadlinesFor('30d', now).settleDeadline).toBeLessThanOrEqual(now + MAX_SETTLE_SECONDS - DEADLINE_MARGIN_SECONDS)
  })
})

describe('bucketFor / nextActionFor (FR-022)', () => {
  const base = { state: 0, isOrganizer: false, contributeDeadline: 2000, settleDeadline: 3000, me: { hasContributed: false, voted: false, canClaimRefund: false } }
  it('buckets closed and fully-refunded pools as finished, refunding-with-balance as active', () => {
    expect(bucketFor({ ...base, state: 1 })).toBe('finished')
    expect(bucketFor({ ...base, state: 2, me: { canClaimRefund: true } })).toBe('active')
    expect(bucketFor({ ...base, state: 2, me: { canClaimRefund: false } })).toBe('finished')
    expect(bucketFor(base)).toBe('active')
  })
  it('picks the one next action per role and state', () => {
    expect(nextActionFor({ ...base, isOrganizer: true }, 1000)).toBe('close')
    expect(nextActionFor(base, 1000)).toBe('contribute')
    expect(nextActionFor({ ...base, me: { hasContributed: true, voted: false } }, 2500)).toBe('vote')
    expect(nextActionFor({ ...base, me: { hasContributed: true, voted: true } }, 2500)).toBe(null)
    expect(nextActionFor(base, 3500)).toBe('poke')
    expect(nextActionFor({ ...base, state: 2, me: { canClaimRefund: true } }, 1000)).toBe('collect')
    expect(nextActionFor({ ...base, state: 2, me: { canClaimRefund: false } }, 1000)).toBe(null)
    expect(nextActionFor({ ...base, state: 1 }, 1000)).toBe(null)
  })
})

describe('validateCreate', () => {
  it('requires a purpose within the byte bound and a positive goal', () => {
    expect(validateCreate({ purpose: '', goal: '10' })).toMatch(/purpose/i)
    expect(validateCreate({ purpose: 'x'.repeat(PURPOSE_MAX + 1), goal: '10' })).toMatch(/under/)
    expect(validateCreate({ purpose: 'é'.repeat(101), goal: '10' })).toMatch(/under/)
    expect(validateCreate({ purpose: 'Party', goal: '0' })).toMatch(/goal/i)
    expect(validateCreate({ purpose: 'Party', goal: 'abc' })).toMatch(/goal/i)
    expect(validateCreate({ purpose: ' Party ', goal: '12.5' })).toBeNull()
  })
})
