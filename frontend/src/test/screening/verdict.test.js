import { describe, it, expect } from 'vitest'
import {
  deriveVerdict,
  describeVerdict,
  countReadings,
  verdictOnChain,
  worstVerdict,
  VERDICTS,
  VERDICT_LABELS,
} from '../../lib/screening/verdict'

const read = (chainId, flagged, label = 'Chainalysis sanctions oracle', detail = null) => ({
  id: `${label}:${chainId}`, kind: 'x', label, chainId, address: '0x', status: 'read', flagged, detail,
})
const unreadable = (chainId, label = 'Circle USDC freeze list', reason = 'timed out') => ({
  id: `${label}:${chainId}`, kind: 'x', label, chainId, address: '0x', status: 'unreadable', reason,
})
const names = { 1: 'Ethereum', 137: 'Polygon', 8453: 'Base' }
const nameFor = (id) => names[id] || `chain ${id}`

describe('deriveVerdict — the green one is the hard one', () => {
  it('is SCREENED only when every source answered and none flagged', () => {
    expect(deriveVerdict([read(1, false), read(137, false)])).toBe(VERDICTS.SCREENED)
  })

  it('is FLAGGED when ANY single source says so, whatever the rest say', () => {
    expect(deriveVerdict([read(1, false), read(137, true), read(8453, false)])).toBe(VERDICTS.FLAGGED)
    // Even alongside unreadables: a positive fact from one list stands on its own.
    expect(deriveVerdict([unreadable(1), read(137, true)])).toBe(VERDICTS.FLAGGED)
  })

  it('is PARTIAL — never SCREENED — when a source could not be read', () => {
    expect(deriveVerdict([read(1, false), unreadable(137)])).toBe(VERDICTS.PARTIAL)
  })

  it('is UNSCREENED when nothing answered, or nothing was asked', () => {
    expect(deriveVerdict([unreadable(1), unreadable(137)])).toBe(VERDICTS.UNSCREENED)
    expect(deriveVerdict([])).toBe(VERDICTS.UNSCREENED)
  })

  it('never lets an unreadable count as an answer', () => {
    const c = countReadings([read(1, false), unreadable(137), unreadable(8453)])
    expect(c).toEqual({ read: 1, flagged: 0, unreadable: 2, total: 3 })
  })

  it('has a word for every verdict (never colour alone)', () => {
    for (const v of Object.values(VERDICTS)) expect(typeof VERDICT_LABELS[v]).toBe('string')
  })
})

describe('describeVerdict — the sentence names what the verdict rests on', () => {
  it('names the flagging list AND its network', () => {
    const result = { verdict: VERDICTS.FLAGGED, readings: [read(1, false), read(8453, true, 'Circle USDC freeze list', 'frozen by Circle')] }
    const s = describeVerdict(result, nameFor)
    expect(s).toMatch(/flagged by sanctions screening/)
    expect(s).toContain('Circle USDC freeze list on Base')
    expect(s).not.toContain('Ethereum')
  })

  it('counts sources and networks for a clean bill', () => {
    const result = { verdict: VERDICTS.SCREENED, readings: [read(1, false), read(1, false, 'Circle USDC freeze list'), read(137, false)] }
    expect(describeVerdict(result, nameFor)).toBe('All 3 lists on 2 networks answered clear.')
  })

  it('gives counts on a partial screen, and leaves the names to the detail (#1458 QA round)', () => {
    const result = { verdict: VERDICTS.PARTIAL, readings: [read(1, false), unreadable(137, 'FairWins sanctions guard')] }
    const s = describeVerdict(result, nameFor)
    expect(s).toBe('1 of 2 lists answered clear; 1 could not be read — not a clean bill.')
    // The summary must stay a sentence, not a roll-call: naming every unreachable source is what
    // turned this line into a paragraph on a build where three of four could not be read.
    expect(s).not.toContain('FairWins sanctions guard')
  })

  it('names the uncovered networks even when sources existed and none answered', () => {
    const result = { verdict: VERDICTS.UNSCREENED, readings: [unreadable(137, 'FairWins sanctions guard')], uncovered: [61] }
    const s = describeVerdict(result, (id) => (id === 61 ? 'Ethereum Classic' : `chain ${id}`))
    expect(s).toContain('no source answered')
    expect(s).toContain('No screening source covers Ethereum Classic')
  })

  it('names the uncovered networks when there was nothing to ask', () => {
    const result = { verdict: VERDICTS.UNSCREENED, readings: [], uncovered: [61] }
    expect(describeVerdict(result, (id) => (id === 61 ? 'Ethereum Classic' : `chain ${id}`))).toContain(
      'No screening source covers Ethereum Classic',
    )
  })
})

describe("verdictOnChain — one network's answer, from the whole-estate readings", () => {
  it("derives that chain's verdict from only that chain's readings", () => {
    const result = { readings: [read(1, false), read(137, true), unreadable(8453)] }
    expect(verdictOnChain(result, 1).verdict).toBe(VERDICTS.SCREENED)
    expect(verdictOnChain(result, 137).verdict).toBe(VERDICTS.FLAGGED)
    expect(verdictOnChain(result, 8453).verdict).toBe(VERDICTS.UNSCREENED)
  })

  it('returns null when nothing screens that chain — never a verdict about silence', () => {
    expect(verdictOnChain({ readings: [read(1, false)] }, 61)).toBeNull()
  })
})

describe('worstVerdict — the contact-level flag', () => {
  it('ranks a flag above a gap, and a gap above a clean bill', () => {
    expect(worstVerdict([VERDICTS.SCREENED, VERDICTS.FLAGGED, VERDICTS.PARTIAL])).toBe(VERDICTS.FLAGGED)
    expect(worstVerdict([VERDICTS.SCREENED, VERDICTS.PARTIAL])).toBe(VERDICTS.PARTIAL)
    expect(worstVerdict([VERDICTS.SCREENED, VERDICTS.UNSCREENED])).toBe(VERDICTS.UNSCREENED)
    expect(worstVerdict([VERDICTS.SCREENED, VERDICTS.SCREENED])).toBe(VERDICTS.SCREENED)
  })

  it('is null when nothing has answered yet, so a pending sweep never reads as clear', () => {
    expect(worstVerdict([])).toBeNull()
    expect(worstVerdict([null, undefined])).toBeNull()
  })
})
