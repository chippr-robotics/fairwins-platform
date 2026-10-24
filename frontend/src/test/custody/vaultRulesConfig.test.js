// Spec 105 (T-002/T-005) — one semantic config, realized per chain. Proves the banded everyday
// lane (an over-cap send SKIPS it and falls to the full-vote lane via matchPreview), the honest
// inapplicable disclosure on a chain with no stable, and drift comparison that names fields.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/custody/policyTemplates', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    starterStableAsset: vi.fn((chainId) =>
      Number(chainId) === 137
        ? { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC', decimals: 6 }
        : null,
    ),
  }
})

import {
  realizeRules,
  sanitizeSemanticRules,
  isEmptySemanticRules,
  describeSemanticRules,
  compareRealizedRules,
  describeDuration,
  DEFAULT_SEMANTIC_RULES,
  ALLOWED_MONEY,
  BIG_SENDS,
} from '../../lib/custody/vaultRulesConfig'
import { matchPreview, ANY_ASSET } from '../../lib/custody/policyV2'

const O1 = '0x2222222222222222222222222222222222222222'
const O2 = '0x3333333333333333333333333333333333333333'
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

describe('realizeRules on a chain with a stable (137)', () => {
  const { rules, cooldown, inapplicable, summary } = realizeRules(137, DEFAULT_SEMANTIC_RULES, [O1, O2])

  it('builds the three lanes: banded everyday, full-vote big-send, full-vote catch-all', () => {
    expect(rules).toHaveLength(3)
    expect(rules[0].banded).toBe(true)
    expect(rules[0].perTxLimit).toBe(500_000000n)
    expect(rules[0].windowLimit).toBe(500_000000n)
    expect(rules[1].asset).toBe(USDC) // identical scope — the engine's one fall-through
    expect(rules[1].approvalsRequired).toBe(2)
    expect(rules[2].asset).toBe(ANY_ASSET)
    expect(rules[2].approvalsRequired).toBe(2)
    expect(cooldown).toBe(3600)
    expect(inapplicable).toEqual([])
    expect(summary.length).toBeGreaterThan(0)
  })

  it('an under-cap send matches the everyday lane with no approvers needed', () => {
    const m = matchPreview(rules, { to: USDC, value: 0n, data: transferData(O2, 100_000000n) })
    expect(m.matched).toBe(true)
    expect(m.ruleIndex).toBe(0)
  })

  it('an OVER-cap send skips the band and lands on the full-vote lane', () => {
    const m = matchPreview(rules, { to: USDC, value: 0n, data: transferData(O2, 900_000000n) }, { approvedBy: [] })
    expect(m.matched).toBe(true)
    expect(m.ruleIndex).toBe(1)
    expect(m.approverFailure).toBeTruthy() // needs every owner
  })

  it('permissive allowed-money keeps the starter-style catch-all', () => {
    const r = realizeRules(137, { ...DEFAULT_SEMANTIC_RULES, allowedMoney: ALLOWED_MONEY.EVERYTHING }, [O1, O2])
    const catchAll = r.rules[r.rules.length - 1]
    expect(catchAll.asset).toBe(ANY_ASSET)
    expect(catchAll.approvalsRequired).toBe(0)
  })

  it('big-sends follow-allowed drops the explicit lane (over-cap falls to the catch-all)', () => {
    const r = realizeRules(137, { ...DEFAULT_SEMANTIC_RULES, bigSends: BIG_SENDS.FOLLOW_ALLOWED }, [O1, O2])
    expect(r.rules).toHaveLength(2)
  })
})

describe('a chain with NO configured stable', () => {
  it('realizes cooldown + catch-all and DISCLOSES the inapplicable tiles', () => {
    const r = realizeRules(61, DEFAULT_SEMANTIC_RULES, [O1, O2])
    expect(r.stable).toBeNull()
    expect(r.inapplicable).toEqual(['dailyCap', 'bigSends'])
    expect(r.rules).toHaveLength(1)
    expect(r.rules[0].asset).toBe(ANY_ASSET)
  })
})

describe('sanitize / describe', () => {
  it('rejects a non-numeric cap with a member-facing message', () => {
    expect(() => realizeRules(137, { ...DEFAULT_SEMANTIC_RULES, dailyCapAmount: 'lots' }, [O1])).toThrow(/plain number/)
  })
  it('empty semantic rules install nothing anywhere', () => {
    expect(isEmptySemanticRules({ dailyCapAmount: '', cooldownSeconds: 0, allowedMoney: 'everything' })).toBe(true)
    expect(isEmptySemanticRules(DEFAULT_SEMANTIC_RULES)).toBe(false)
  })
  it('summary lines are plain language and chain-independent', () => {
    const lines = describeSemanticRules(DEFAULT_SEMANTIC_RULES, 2)
    expect(lines.join(' ')).toMatch(/24 hours/)
    expect(lines.join(' ')).toMatch(/all 2 owners/)
  })
  it('describeDuration reads naturally', () => {
    expect(describeDuration(3600)).toBe('1 hour')
    expect(describeDuration(0)).toBe('No wait')
    expect(describeDuration(86400)).toBe('1 day')
  })
  it('sanitize falls back to safe defaults for unknown enum values', () => {
    const s = sanitizeSemanticRules({ allowedMoney: 'garbage', bigSends: 'garbage' })
    expect(s.allowedMoney).toBe(ALLOWED_MONEY.STABLE)
    expect(s.bigSends).toBe(BIG_SENDS.EVERYONE)
  })
})

describe('compareRealizedRules (drift, FR-013)', () => {
  const realized = realizeRules(137, DEFAULT_SEMANTIC_RULES, [O1, O2])
  it('matches an identical on-chain set', () => {
    expect(compareRealizedRules(realized, { rules: realized.rules, cooldown: 3600 }).matches).toBe(true)
  })
  it('names the differing field, never a merged value', () => {
    const changed = { rules: realized.rules.map((r, i) => (i === 0 ? { ...r, windowLimit: 1n } : r)), cooldown: 3600 }
    const d = compareRealizedRules(realized, changed)
    expect(d.matches).toBe(false)
    expect(d.differences).toEqual(['rule-1'])
    expect(compareRealizedRules(realized, { rules: realized.rules, cooldown: 60 }).differences).toContain('cooldown')
    expect(compareRealizedRules(realized, { rules: realized.rules.slice(1), cooldown: 3600 }).differences).toContain('rule-count')
  })
})

function transferData(to, amount) {
  // keccak('transfer(address,uint256)')[0:4] + args
  const sel = '0xa9059cbb'
  const addr = to.slice(2).toLowerCase().padStart(64, '0')
  const amt = amount.toString(16).padStart(64, '0')
  return sel + addr + amt
}
