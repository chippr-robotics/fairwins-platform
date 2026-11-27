/** FightReading (spec 115 slice 3): trust by source on the server clock; never-live unconstructible; no derivation. */
import { describe, it, expect } from 'vitest'
import { fromFight, reclassifyFight, unknownFight, readFigures, readResult, FIGHT_TRUST_BOUNDS, FIGURE_KEYS } from '../../lib/sports/fightReading'
import { fight, figures, DECISION, ROUND1, SERVER_NOW } from '../fixtures/sportsFights'

const at = (source, ageMs, over = {}) => fight({ source, confirmedAt: SERVER_NOW - ageMs, ...over })

describe('bounds (mirror of the gateway TRUST_BOUNDS)', () => {
  it('card live ≤ 30 s / delayed ≤ 120 s; figures never live / 120 s; venue never live / 75 s', () => {
    expect(FIGHT_TRUST_BOUNDS.card).toEqual({ liveMs: 30_000, delayedMs: 120_000 })
    expect(FIGHT_TRUST_BOUNDS.figures).toEqual({ liveMs: null, delayedMs: 120_000 })
    expect(FIGHT_TRUST_BOUNDS.venue).toEqual({ liveMs: null, delayedMs: 75_000 })
    expect(Object.isFrozen(FIGHT_TRUST_BOUNDS)).toBe(true)
  })
})

describe('state from age, by source', () => {
  it.each([
    ['card', 0, 'live'], ['card', 30_000, 'live'], ['card', 30_001, 'delayed'], ['card', 120_000, 'delayed'], ['card', 120_001, 'last-known'],
    ['figures', 120_000, 'delayed'], ['figures', 120_001, 'last-known'],
    ['venue', 75_000, 'delayed'], ['venue', 75_001, 'last-known'],
  ])('%s %i ms old is %s', (source, age, state) => {
    expect(fromFight(at(source, age), SERVER_NOW, 5).state).toBe(state)
  })

  it.each(['figures', 'venue'])('a %s reading is NEVER live, at any age or after any reclassification', (source) => {
    for (const age of [0, 1, 500, 5000, 30_000, 60_000]) {
      const r = fromFight(at(source, age), SERVER_NOW, 100)
      expect(r.isLive).toBe(false)
      expect(r.state).not.toBe('live')
      for (const now of [0, 100, 101, 1000, 40_000, 1e7]) expect(reclassifyFight(r, now).state).not.toBe('live')
    }
    expect(fromFight(at(source, -9000), SERVER_NOW, 0).state).toBe('delayed') // a future confirmation clamps, it does not become live
  })

  it('a card reading walks live → delayed → last-known as time passes', () => {
    const r = fromFight(at('card', 1000), SERVER_NOW, 1000)
    expect(r.state).toBe('live')
    expect(reclassifyFight(r, 1000 + 40_000).state).toBe('delayed')
    expect(reclassifyFight(r, 1000 + 130_000).state).toBe('last-known')
    expect(reclassifyFight(r, 1500)).toBe(r)
  })

  it('no source, no confirmation, no serverNow ⇒ unknown with NO figures', () => {
    for (const r of [fromFight(fight({ source: null }), SERVER_NOW, 0), fromFight(fight({ confirmedAt: null }), SERVER_NOW, 0), fromFight(fight(), null, 0), fromFight(null, SERVER_NOW, 0), fromFight(fight({ source: 'other' }), SERVER_NOW, 0)]) {
      expect(r.state).toBe('unknown')
      for (const k of ['rounds', 'overall', 'result', 'fighters', 'round', 'clock', 'status', 'source']) expect(r).not.toHaveProperty(k)
    }
    expect(unknownFight().ageMs()).toBeNull()
  })

  it('readings are frozen; the device clock is not read', () => {
    expect(Object.isFrozen(fromFight(fight(), SERVER_NOW, 0))).toBe(true)
    const r = fromFight(at('card', 60_000), SERVER_NOW, 500)
    expect(r.ageMs(500)).toBe(60_000)
  })
})

describe('nothing derived, nothing invented', () => {
  it('a figure is a non-negative integer or null: a reported 0 stays 0, absent stays null, junk is null', () => {
    const f = readFigures({ knockdowns: 0, sigStrikesLanded: 12, sigStrikesAttempted: null, reversals: '3', takedownsLanded: -1, controlSeconds: 2.5 })
    expect(f.knockdowns).toBe(0)
    expect(f.sigStrikesLanded).toBe(12)
    expect(f.sigStrikesAttempted).toBeNull()
    expect(f.reversals).toBeNull()
    expect(f.takedownsLanded).toBeNull()
    expect(f.controlSeconds).toBeNull()
  })
  it('carries exactly the contract keys and nothing else (no accuracy, no sum, no lead)', () => {
    const f = readFigures({ ...ROUND1[0], accuracy: 55, lead: true, total: 99 })
    expect(Object.keys(f)).toEqual([...FIGURE_KEYS])
    expect(FIGURE_KEYS).toHaveLength(16)
  })
  it('rounds are the source\'s own, sorted, only those with both fighters; none ⇒ null, not []', () => {
    const r = fromFight(fight({ rounds: [{ round: 2, figures: ROUND1 }, { round: 1, figures: ROUND1 }, { round: 3, figures: [ROUND1[0]] }] }), SERVER_NOW, 0)
    expect(r.rounds.map((x) => x.round)).toEqual([1, 2])
    expect(fromFight(fight({ rounds: [] }), SERVER_NOW, 0).rounds).toBeNull()
    expect(fromFight(fight({ rounds: null }), SERVER_NOW, 0).overall).toBeNull()
  })
  it('the result: winner is an index only for a win; judges need two integer scores; draw/no-contest/cancelled have no winner', () => {
    expect(readResult(DECISION).winner).toBe(0)
    expect(readResult({ ...DECISION, outcome: 'draw', winner: 0 }).winner).toBeNull()
    expect(readResult({ ...DECISION, winner: 5 }).winner).toBeNull()
    expect(readResult({ outcome: 'cancelled', source: 'venue' }).judges).toEqual([])
    expect(readResult({ ...DECISION, judges: [{ name: 'A', scores: [48] }, { name: 'B', scores: [47, 48] }] }).judges).toHaveLength(1)
    expect(readResult({ outcome: 'forfeit' }).outcome).toBeNull()
    expect(readResult(null)).toBeNull()
  })
  it('the venue block is carried only while another source leads; changedAt only on a venue reading', () => {
    const v = { status: 'cancelled', scoreText: null, clock: null, changedAt: SERVER_NOW - 5000 }
    expect(fromFight(fight({ venue: v }), SERVER_NOW, 0).venue.status).toBe('cancelled')
    expect(fromFight(at('venue', 5000, { venue: v, changedAt: 7 }), SERVER_NOW, 0).venue).toBeNull()
    expect(fromFight(at('venue', 5000, { changedAt: 7 }), SERVER_NOW, 0).changedAt).toBe(7)
    expect(fromFight(fight({ changedAt: 7 }), SERVER_NOW, 0).changedAt).toBeNull()
  })
  it('cancelled is a status; an unrecognised one is carried as the source\'s words', () => {
    expect(fromFight(fight({ status: 'cancelled' }), SERVER_NOW, 0).status).toBe('cancelled')
    expect(fromFight(fight({ status: 'Weigh-in' }), SERVER_NOW, 0).statusText).toBe('Weigh-in')
  })
  it('unknown fighters are {name:null}, never invented', () => {
    const r = fromFight(fight({ fighters: [{ name: null }, { name: null }] }), SERVER_NOW, 0)
    expect(r.fighters.map((f) => f.name)).toEqual([null, null])
    expect(figures()).toBeTruthy()
  })
})
