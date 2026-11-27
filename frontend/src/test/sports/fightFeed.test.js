/** fightFeed (spec 115 slice 3): the request, the claim's validation, and — above all — that the fight module's
 *  absence is remembered SEPARATELY from the game module's (FR-020). */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const gw = vi.hoisted(() => ({ url: 'http://gw.test' }))
vi.mock('../../lib/predict/predictClient', () => ({ predictGatewayUrl: () => gw.url }))

import { fetchFight, fightIdentityOf, fightCadenceMs, listingFighters, __resetFightFeedForTests } from '../../lib/sports/fightFeed'
import { fetchGame, __resetGameFeedForTests } from '../../lib/sports/gameFeed'
import { fight, fightEnvelope, FIGHT_LISTING } from '../fixtures/sportsFights'
import { envelope, row } from '../fixtures/sportsGames'

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const NOW = Date.parse('2026-11-27T12:00:00Z')

beforeEach(() => {
  gw.url = 'http://gw.test'
  __resetFightFeedForTests()
  __resetGameFeedForTests()
})

describe('cadence', () => {
  it('5 s in progress, 30 s before the start / cancelled / unknown, stop at ended', () => {
    expect(fightCadenceMs('in-progress')).toBe(5000)
    expect(fightCadenceMs('scheduled')).toBe(30_000)
    expect(fightCadenceMs('cancelled')).toBe(30_000)
    expect(fightCadenceMs(null)).toBe(30_000)
    expect(fightCadenceMs('ended')).toBeNull()
  })
})

describe('the claim', () => {
  it('a and b from the listing\'s teams, start when it is inside the gateway window', () => {
    expect(fightIdentityOf(FIGHT_LISTING, NOW)).toEqual({ a: 'Ciryl Gane', b: 'Josh Hokit', start: '2026-11-14T22:00:00Z' })
  })
  it('start outside [now − 45 d, now + 30 d] is dropped, the names stay', () => {
    expect(fightIdentityOf({ ...FIGHT_LISTING, startTime: '2026-08-01T00:00:00Z' }, NOW)).toEqual({ a: 'Ciryl Gane', b: 'Josh Hokit' })
    expect(fightIdentityOf({ ...FIGHT_LISTING, startTime: '2027-03-01T00:00:00Z' }, NOW)).toEqual({ a: 'Ciryl Gane', b: 'Josh Hokit' })
    expect(fightIdentityOf({ ...FIGHT_LISTING, startTime: 'nonsense' }, NOW)).toEqual({ a: 'Ciryl Gane', b: 'Josh Hokit' })
  })
  it('both names or neither: one missing, too short, too long or with a forbidden character sends NONE', () => {
    const t = (a, b) => ({ ...FIGHT_LISTING, teams: [{ name: a }, { name: b }] })
    expect(fightIdentityOf(t('Ciryl Gane', null), NOW)).toEqual({})
    expect(fightIdentityOf(t('X', 'Josh Hokit'), NOW)).toEqual({})
    expect(fightIdentityOf(t('A'.repeat(61), 'Josh Hokit'), NOW)).toEqual({})
    expect(fightIdentityOf(t('Ciryl <Gane>', 'Josh Hokit'), NOW)).toEqual({})
    expect(fightIdentityOf(t('Ciryl Gane', 'Josh 2 Hokit'), NOW)).toEqual({})
    expect(fightIdentityOf(null, NOW)).toEqual({})
  })
  it('accepts the contract\'s characters: letters with marks, space, . \' ’ -', () => {
    const t = (a, b) => ({ ...FIGHT_LISTING, startTime: null, teams: [{ name: a }, { name: b }] })
    expect(fightIdentityOf(t('Jiří Procházka', "Sean O’Malley"), NOW)).toEqual({ a: 'Jiří Procházka', b: 'Sean O’Malley' })
    expect(fightIdentityOf(t('Max Holloway Jr.', "D'Arce-Smith"), NOW)).toEqual({ a: 'Max Holloway Jr.', b: "D'Arce-Smith" })
  })
  it('uses the venue\'s stated home/away order when that is what the listing gives', () => {
    expect(listingFighters({ league: 'ufc', home: { name: 'Josh Hokit' }, away: { name: 'Ciryl Gane' } })).toEqual(['Josh Hokit', 'Ciryl Gane'])
    expect(listingFighters(null)).toEqual([null, null])
  })
})

describe('fetchFight', () => {
  it('asks GET /v1/sports/fights/:id with the claim, and returns the fight and envelope', async () => {
    const f = vi.fn().mockResolvedValue(res(200, fightEnvelope(fight())))
    const out = await fetchFight(13140, { identity: fightIdentityOf(FIGHT_LISTING, NOW), fetchImpl: f })
    const u = new URL(f.mock.calls[0][0])
    expect(u.pathname).toBe('/v1/sports/fights/13140')
    expect(Object.fromEntries(u.searchParams)).toEqual({ a: 'Ciryl Gane', b: 'Josh Hokit', start: '2026-11-14T22:00:00Z' })
    expect(out.kind).toBe('ok')
    expect(out.fight.gameId).toBe(13140)
    expect(out.sources.figures.label).toBe('UFC')
  })
  it('a body that is not this fight (or has no serverNow) is a failure', async () => {
    expect((await fetchFight(1, { fetchImpl: vi.fn().mockResolvedValue(res(200, fightEnvelope(fight()))) })).kind).toBe('failed')
    __resetFightFeedForTests()
    expect((await fetchFight(13140, { fetchImpl: vi.fn().mockResolvedValue(res(200, { fight: fight() })) })).kind).toBe('failed')
  })
  it('shares an in-flight read', async () => {
    const f = vi.fn().mockResolvedValue(res(200, fightEnvelope(fight())))
    await Promise.all([fetchFight(13140, { fetchImpl: f }), fetchFight(13140, { fetchImpl: f })])
    expect(f).toHaveBeenCalledTimes(1)
  })
  it.each(['sports_fight_unconfigured', 'sports_unconfigured', 'sports_paused', 'killswitch_active'])('503 %s is absent', async (code) => {
    expect((await fetchFight(1, { fetchImpl: vi.fn().mockResolvedValue(res(503, { error: { code } })) })).kind).toBe('absent')
  })
  it('a bare 503, a 429 and a 500 are failures, not absence', async () => {
    for (const r of [res(503, { error: { code: 'upstream_unavailable' } }), res(429, {}), res(500, {})]) {
      expect((await fetchFight(1, { fetchImpl: vi.fn().mockResolvedValue(r) })).kind).toBe('failed')
    }
  })
  it('no gateway configured: nothing is requested', async () => {
    gw.url = ''
    const f = vi.fn()
    expect((await fetchFight(1, { fetchImpl: f })).kind).toBe('absent')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('the two modules are remembered separately (FR-020)', () => {
  it('the fight route off is remembered for fights and does NOT stop the game feed asking', async () => {
    const off = vi.fn().mockResolvedValue(res(503, { error: { code: 'sports_fight_unconfigured' } }))
    expect((await fetchFight(1, { fetchImpl: off })).kind).toBe('absent')
    expect((await fetchFight(2, { fetchImpl: off })).kind).toBe('absent')
    expect(off).toHaveBeenCalledTimes(1) // remembered: the second fight never asked
    const game = vi.fn().mockResolvedValue(res(200, envelope(row())))
    expect((await fetchGame(19618, { fetchImpl: game })).kind).toBe('ok')
    expect(game).toHaveBeenCalledTimes(1)
  })
  it('the game module missing (404) is remembered for games and does NOT stop the fight feed asking', async () => {
    const gone = vi.fn().mockResolvedValue(res(404, {}))
    expect((await fetchGame(19618, { fetchImpl: gone })).kind).toBe('absent')
    expect((await fetchGame(19619, { fetchImpl: gone })).kind).toBe('absent')
    expect(gone).toHaveBeenCalledTimes(1)
    const f = vi.fn().mockResolvedValue(res(200, fightEnvelope(fight())))
    expect((await fetchFight(13140, { fetchImpl: f })).kind).toBe('ok')
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('a pause is not remembered by either', async () => {
    const paused = vi.fn().mockResolvedValue(res(503, { error: { code: 'sports_paused' } }))
    await fetchFight(1, { fetchImpl: paused })
    await fetchFight(1, { fetchImpl: paused })
    expect(paused).toHaveBeenCalledTimes(2)
  })
})
