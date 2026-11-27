/**
 * GameReading (spec 115) — four states derived from age on the SERVER's clock; `unknown` carries no figures;
 * a wrong state cannot be built; a wrong device clock changes nothing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { fromRow, fromListed, reclassify, unknown, readScore, readStatus, detailAgeMs, TRUST_BOUNDS } from '../../lib/sports/gameReading'
import { stamp } from '../../lib/markets/serverClock'
import { row, venueRow, SERVER_NOW } from '../fixtures/sportsGames'

const LIVE_MS = TRUST_BOUNDS.plays.liveMs
const DELAYED_MS = TRUST_BOUNDS.plays.delayedMs

const at = (ageMs) => row({ confirmedAt: SERVER_NOW - ageMs })

afterEach(() => vi.useRealTimers())

describe('bounds (mirror of the gateway TRUST_BOUNDS)', () => {
  it('plays: live ≤ 30 s, delayed ≤ 120 s; venue: never live, delayed ≤ 75 s', () => {
    expect(TRUST_BOUNDS.plays).toEqual({ liveMs: 30_000, delayedMs: 120_000 })
    expect(TRUST_BOUNDS.venue).toEqual({ liveMs: null, delayedMs: 75_000 })
    expect(Object.isFrozen(TRUST_BOUNDS)).toBe(true)
  })
})

describe('a venue reading is NEVER live', () => {
  it.each([0, 1, 1000, 5000, 15_000, 30_000])('venue row confirmed %i ms ago is delayed, not live', (age) => {
    const r = fromRow(venueRow({ confirmedAt: SERVER_NOW - age }), SERVER_NOW, 100)
    expect(r.source).toBe('venue')
    expect(r.state).toBe('delayed')
    expect(r.isLive).toBe(false)
  })
  it.each([
    [75_000, 'delayed'],
    [75_001, 'last-known'],
    [600_000, 'last-known'],
  ])('venue row %i ms old is %s', (age, state) => {
    expect(fromRow(venueRow({ confirmedAt: SERVER_NOW - age }), SERVER_NOW, 100).state).toBe(state)
  })
  it('stays out of live when reclassified at any later or earlier time, and with a future confirmation', () => {
    const r = fromRow(venueRow({ confirmedAt: SERVER_NOW + 9000 }), SERVER_NOW, 1000)
    expect(r.state).toBe('delayed')
    for (const now of [0, 1000, 1001, 2000, 40_000, 76_000, 1e7]) expect(reclassify(r, now).isLive).toBe(false)
  })
  it('no exported constructor takes a state, so a live venue reading cannot be written', async () => {
    const mod = await import('../../lib/sports/gameReading')
    expect(Object.keys(mod).sort()).toEqual(['TRUST_BOUNDS', 'deriveState', 'detailAgeMs', 'fromListed', 'fromRow', 'readScore', 'readStatus', 'reclassify', 'unknown'])
    // even a row that claims to be the venue's while carrying a play-source shape is judged by its `source`
    expect(fromRow({ ...row(), source: 'venue', confirmedAt: SERVER_NOW }, SERVER_NOW, 0).isLive).toBe(false)
  })
  it('the venue block on a plays row does not change that row\'s own state', () => {
    const r = fromRow(row({ venue: { score: { home: 21, away: 10 }, changedAt: SERVER_NOW - 100_000 }, agree: false }), SERVER_NOW, 0)
    expect(r.state).toBe('live')
    expect(r.venue.score).toEqual({ home: 21, away: 10 })
    expect(r.venue.changedAt).toBe(SERVER_NOW - 100_000)
  })
  it('a venue block is carried only on a plays row', () => {
    expect(fromRow(venueRow({ venue: { score: { home: 1, away: 2 } } }), SERVER_NOW, 0).venue).toBeNull()
    expect(fromRow(row(), SERVER_NOW, 0).venue).toBeNull()
  })
  it('changedAt is the venue-source field only', () => {
    expect(fromRow(venueRow(), SERVER_NOW, 0).changedAt).toBe(SERVER_NOW - 40_000)
    expect(fromRow(row({ changedAt: 5 }), SERVER_NOW, 0).changedAt).toBeNull()
    expect(fromRow(row(), SERVER_NOW, 0)).not.toHaveProperty('confirmedBy')
  })
})

describe('the event listing as a venue reading (fromListed)', () => {
  const listed = { status: 'in-progress', scoreText: '10-28', period: 'Q3', clock: '10:39' }
  const st = (ageMs, receivedAt = 0) => stamp({ confirmedAt: new Date(SERVER_NOW - ageMs).toISOString(), serverNow: new Date(SERVER_NOW).toISOString() }, receivedAt)
  it('is never live, whatever the listing\'s age, and keeps the venue\'s text unparsed with no score', () => {
    for (const age of [0, 500, 10_000]) {
      const r = fromListed(listed, st(age), 0)
      expect(r.state).toBe('delayed')
      expect(r.source).toBe('venue')
      expect(r.score).toBeNull()
      expect(r.scoreText).toBe('10-28')
    }
    expect(fromListed(listed, st(200_000), 0).state).toBe('last-known')
  })
  it('is unknown (so nothing is shown) when the age cannot be measured or there is no listing', () => {
    expect(fromListed(listed, null, 0).state).toBe('unknown')
    expect(fromListed(listed, stamp({}, 0), 0).state).toBe('unknown')
    expect(fromListed(null, st(0), 0).state).toBe('unknown')
  })
})

describe('state from age', () => {
  it.each([
    [0, 'live'],
    [LIVE_MS, 'live'],
    [LIVE_MS + 1, 'delayed'],
    [DELAYED_MS, 'delayed'],
    [DELAYED_MS + 1, 'last-known'],
    [3_600_000, 'last-known'],
  ])('a row confirmed %i ms before serverNow is %s', (age, state) => {
    const r = fromRow(at(age), SERVER_NOW, 100)
    expect(r.state).toBe(state)
    expect(r.isLive).toBe(state === 'live')
  })

  it('walks live → delayed → last-known as the monotonic clock advances, with no new answer', () => {
    const r = fromRow(at(1000), SERVER_NOW, 1000)
    expect(r.state).toBe('live')
    const later = reclassify(r, 1000 + 35_000)
    expect(later.state).toBe('delayed')
    expect(later.score).toEqual({ home: 28, away: 10 })
    expect(reclassify(later, 1000 + 130_000).state).toBe('last-known')
  })

  it('returns the SAME object when the state has not changed', () => {
    const r = fromRow(at(0), SERVER_NOW, 0)
    expect(reclassify(r, 5000)).toBe(r)
  })

  it('a future confirmation (clock skew between the gateway sources) clamps to age 0, not to negative-fresh nonsense', () => {
    const r = fromRow(row({ confirmedAt: SERVER_NOW + 5000 }), SERVER_NOW, 0)
    expect(r.ageMs(0)).toBe(0)
    expect(r.state).toBe('live')
  })
})

describe('unknown carries no figures', () => {
  it('has no score, period, clock, status or stamp key at all', () => {
    const u = unknown('x')
    for (const k of ['score', 'scoreText', 'period', 'clock', 'status', 'possession', 'stamp', 'confirmedAt', 'source', 'venue']) {
      expect(u).not.toHaveProperty(k)
    }
    expect(u.isLive).toBe(false)
    expect(u.ageMs()).toBeNull()
  })

  it.each([
    ['a row with no confirmedAt', row({ confirmedAt: null }), SERVER_NOW],
    ['an envelope with no serverNow', row(), null],
    ['a row that is not an object', null, SERVER_NOW],
    ['a row with source null (nobody spoke for the game)', row({ source: null }), SERVER_NOW],
    ['a row with an unrecognised source', row({ source: 'carrier-pigeon' }), SERVER_NOW],
    ['a gateway "nothing for this id" row (every field null)', { gameId: 7, source: null, status: null, score: null, period: null, clock: null, confirmedAt: null }, SERVER_NOW],
  ])('%s is unknown, never fresh', (_, r, now) => {
    const reading = fromRow(r, now, 0)
    expect(reading.state).toBe('unknown')
    expect(reading).not.toHaveProperty('score')
  })

  it('reclassify leaves unknown alone', () => {
    const u = unknown()
    expect(reclassify(u, 1e9)).toBe(u)
  })
})

describe('figures are only what was given', () => {
  it('keeps a score only when both sides are integers; a zero that was reported stays a zero', () => {
    expect(readScore({ home: 0, away: 0 })).toEqual({ home: 0, away: 0 })
    expect(readScore({ home: 3, away: null })).toBeNull()
    expect(readScore({ home: '3', away: '2' })).toBeNull()
    expect(readScore({ home: 2.5, away: 1 })).toBeNull()
    expect(readScore(null)).toBeNull()
    expect(fromRow(row({ score: null }), SERVER_NOW, 0).score).toBeNull()
  })

  it('keeps the venue scoreText as text, unparsed, when the score is not two integers', () => {
    const r = fromRow(row({ score: null, scoreText: '6-4, 3-2' }), SERVER_NOW, 0)
    expect(r.score).toBeNull()
    expect(r.scoreText).toBe('6-4, 3-2')
  })

  it('maps a known status, carries an unknown one as the venue\'s own words, never as a guess', () => {
    expect(readStatus('in-progress')).toEqual({ status: 'in-progress', statusText: null })
    expect(readStatus('Delayed - Weather')).toEqual({ status: 'other', statusText: 'Delayed - Weather' })
    expect(readStatus(null)).toEqual({ status: null, statusText: null })
    expect(readStatus('')).toEqual({ status: null, statusText: null })
  })

  it('treats a blank period or clock as absent, and an unrecognised possession as null', () => {
    const r = fromRow(row({ period: '  ', clock: '', possession: 'neither' }), SERVER_NOW, 0)
    expect(r.period).toBeNull()
    expect(r.clock).toBeNull()
    expect(r.possession).toBeNull()
  })

  it('readings are frozen', () => {
    expect(Object.isFrozen(fromRow(row(), SERVER_NOW, 0))).toBe(true)
    expect(Object.isFrozen(unknown())).toBe(true)
  })
})

describe('the device clock is never read', () => {
  it('a device set an hour wrong and then a year wrong changes no state', () => {
    vi.useFakeTimers()
    const base = new Date('2026-11-26T02:00:00Z')
    vi.setSystemTime(base)
    const a = fromRow(at(60_000), SERVER_NOW, 500)
    vi.setSystemTime(new Date(base.getTime() + 3_600_000))
    const b = fromRow(at(60_000), SERVER_NOW, 500)
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'))
    const c = fromRow(at(60_000), SERVER_NOW, 500)
    for (const r of [a, b, c]) {
      expect(r.state).toBe('delayed')
      expect(r.ageMs(500)).toBe(60_000)
    }
  })

  it('a detail block is aged by the same rule', () => {
    expect(detailAgeMs(SERVER_NOW - 7000, SERVER_NOW, 100, 100)).toBe(7000)
    expect(detailAgeMs(SERVER_NOW - 7000, SERVER_NOW, 100, 4100)).toBe(11_000)
    expect(detailAgeMs(null, SERVER_NOW, 100, 100)).toBeNull()
  })
})
