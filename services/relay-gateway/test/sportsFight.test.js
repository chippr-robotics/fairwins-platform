/**
 * /v1/sports/fights/:gameId tests (spec 115 slice 3 — contracts/fight-api.md).
 *
 * Fixtures in test/fixtures/sports/fight/ are cut from REAL COMPLETED-CARD payloads read 2026-11-27:
 * UFC 334 (event 1345, 2026-11-14) and a 2025-06-14 card (event 1259) for a no contest. Venue frames are
 * real frames from the capture. NOTHING here is a live fight: every live field (round in progress, running
 * clock, mid-fight figures) is untested because it has never been observed (research R3, open).
 * Upstream load is asserted on the REQUESTS (URL and count), not only the answers.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server.js'
import { normName, pairKey } from '../src/sports/fightNames.js'
import { FIGURE_NAMES, FIGURE_KEYS, figureRow, parseUfcFight, parseUfcEvent, parseUfcFigures } from '../src/sports/ufc.js'
import { parseMmaScoreboard, espnDateRange } from '../src/sports/fight.js'
import { parseFightClaim } from '../src/sports/routes.js'
import { TRUST_BOUNDS } from '../src/sports/bounds.js'
import { normalizeGame } from '../src/polymarket/normalize.js'
import { testConfig, mockProviders, mockEngine, ORIGIN_SECRET } from './helpers.js'

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sports/fight')
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'))
const EV1345 = fx('ufc-event-1345.json')
const EV1259 = fx('ufc-event-1259.json')
const FIGHTS = { 13140: fx('ufc-fight-13140.json'), 13141: fx('ufc-fight-13141.json'), 13143: fx('ufc-fight-13143.json'), 13145: fx('ufc-fight-13145.json'), 12156: fx('ufc-fight-12156.json') }
const ESPN_1114 = fx('espn-mma-20261114.json')
const ESPN_0614 = fx('espn-mma-20250614.json')

// Real venue frames (capture 2026-11-27).
const F_KO = { gameId: 10751, leagueAbbreviation: 'ufc', homeTeam: 'Stephen Thompson', awayTeam: 'Charles Radtke', status: 'Final', score: '1-0|KO/TKO', elapsed: '02:54', period: 'FT', live: false, ended: true, finishedTimestamp: '2026-11-27T00:00:42.15Z' }
const F_DRAW = { gameId: 10805, leagueAbbreviation: 'ufc', homeTeam: 'Kevin Holland', awayTeam: 'Uroš Medic', status: 'Final', score: '0-0', elapsed: '05:00', period: 'FT', live: false, ended: true, finishedTimestamp: '2026-11-27T00:00:42.15Z' }
const F_CANCELED = { gameId: 10201, leagueAbbreviation: 'ufc', homeTeam: 'Amanda Nunes', awayTeam: 'Kayla Harrison', status: 'Canceled', elapsed: '00:00', period: 'CAN', live: false, ended: true, finishedTimestamp: '2026-11-27T00:00:42.15Z' }

class FakeWS {
  static instances = []
  constructor(url) {
    this.url = url
    FakeWS.instances.push(this)
  }
  close() {}
  send(o) {
    this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) })
  }
}
function fakeClock(ms) {
  const c = { ms, timers: [], seq: 0 }
  c.setTimer = (fn, d) => {
    const t = { id: ++c.seq, at: c.ms + d, fn }
    c.timers.push(t)
    return t.id
  }
  c.clearTimer = (id) => {
    c.timers = c.timers.filter((t) => t.id !== id)
  }
  c.advance = (d) => {
    const target = c.ms + d
    for (;;) {
      const due = c.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      c.timers = c.timers.filter((t) => t !== due)
      c.ms = due.at
      due.fn()
    }
    c.ms = target
  }
  return c
}
const jsonRes = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

/** The upstream router: ESPN MMA by `dates`, UFC events by id (anything else is the real empty answer), UFC fights by id. */
function makeApp({ env = {}, startAt = '2026-11-15T06:00:00Z', events = { 1345: EV1345 }, espn = { 20261114: ESPN_1114 }, fights = FIGHTS, down = {} } = {}) {
  FakeWS.instances = []
  const config = testConfig({ SPORTS_ENABLED: 'true', SPORTS_FIGHT_ENABLED: 'true', SPORTS_UFC_ANCHOR_ID: '1345', SPORTS_UFC_PROBE_MAX: '3', ...env })
  const clock = fakeClock(Date.parse(startAt))
  const calls = []
  const ctl = { espn, events, fights, down: { ...down } }
  const sportsFetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/mma/ufc/scoreboard')) {
      if (ctl.down.espn) return ctl.down.espn === 'throw' ? Promise.reject(new TypeError('down')) : jsonRes({}, ctl.down.espn)
      // ESPN answers for any range that CONTAINS the card's day (the fake is keyed by the day).
      const [from, to] = (/dates=([\d-]+)/.exec(u)?.[1] ?? '').split('-')
      const day = Object.keys(ctl.espn).find((d) => d >= from && d <= (to ?? from))
      return jsonRes(day ? ctl.espn[day] : { events: [] })
    }
    if (u.includes('/event/live/')) {
      if (ctl.down.ufc) return ctl.down.ufc === 'throw' ? Promise.reject(new TypeError('down')) : jsonRes({}, ctl.down.ufc)
      const id = /event\/live\/(\d+)\.json/.exec(u)[1]
      return jsonRes(ctl.events[id] ?? { LiveEventDetail: {} })
    }
    if (u.includes('/fight/live/')) {
      if (ctl.down.ufcFight) return jsonRes({}, 500)
      const id = /fight\/live\/(\d+)\.json/.exec(u)[1]
      return ctl.fights[id] ? jsonRes(ctl.fights[id]) : jsonRes({}, 404)
    }
    return jsonRes({}, 404)
  }
  const built = createApp(config, {
    providers: mockProviders(config),
    engineClient: mockEngine(),
    now: () => clock.ms / 1000,
    sportsWebSocket: FakeWS,
    sportsFetch,
    sportsTimers: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  })
  return { ...built, config, clock, calls, ctl }
}
const get = (app, p) => request(app).get(p).set('X-Origin-Auth', ORIGIN_SECRET)
const q = (s) => s.replaceAll(' ', '%20')
const GANE = q('?a=Ciryl Gane&b=Josh Hokit&start=2026-11-14T22:00:00Z')
async function warm(h, frames) {
  await get(h.app, '/v1/sports/games?ids=1') // opens the socket
  FakeWS.instances.at(-1).onopen?.()
  for (const f of frames) FakeWS.instances.at(-1).send(f)
}
const count = (h, re) => h.calls.filter((u) => re.test(u)).length

// ---- the switch (FR-020) -----------------------------------------------------------------------------

describe('SPORTS_FIGHT_ENABLED', () => {
  it('off answers 503 sports_fight_unconfigured and touches no upstream, while the game routes still answer', async () => {
    const h = makeApp({ env: { SPORTS_FIGHT_ENABLED: 'false' } })
    const res = await get(h.app, '/v1/sports/fights/10751')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('sports_fight_unconfigured')
    expect(h.calls).toHaveLength(0)
    const games = await get(h.app, '/v1/sports/games?ids=19618')
    expect(games.status).toBe(200)
    expect(games.body.games[0].gameId).toBe(19618)
    expect((await get(h.app, '/v1/sports/games/19618')).status).toBe(200)
  })

  it('defaults to off, and the module being off wins (sports_unconfigured), then its killswitch', async () => {
    expect(testConfig({ SPORTS_ENABLED: 'true' }).fight.enabled).toBe(false)
    const off = makeApp({ env: { SPORTS_ENABLED: 'false' } })
    expect((await get(off.app, '/v1/sports/fights/10751')).body.error.code).toBe('sports_unconfigured')
    const paused = makeApp({ env: { SPORTS_KILLSWITCH: 'true' } })
    expect((await get(paused.app, '/v1/sports/fights/10751')).body.error.code).toBe('sports_paused')
  })

  it('turning it ON changes nothing about the game routes\' answers', async () => {
    const on = makeApp()
    const off = makeApp({ env: { SPORTS_FIGHT_ENABLED: 'false' } })
    const a = (await get(on.app, '/v1/sports/games?ids=19618')).body
    const b = (await get(off.app, '/v1/sports/games?ids=19618')).body
    expect(a).toEqual(b)
  })

  it('/status names the fight switch', async () => {
    const res = await get(makeApp().app, '/status')
    expect(res.body.sports.fight.enabled).toBe(true)
    expect((await get(makeApp({ env: { SPORTS_FIGHT_ENABLED: 'false' } }).app, '/status')).body.sports.fight).toEqual({ enabled: false })
  })

  it('validates the id and the claim before any upstream is touched', async () => {
    const h = makeApp()
    const bad = ['/v1/sports/fights/0', '/v1/sports/fights/x', '/v1/sports/fights/5?a=Only One', '/v1/sports/fights/5?a=A&b=Bb', '/v1/sports/fights/5?a=<b>x</b>&b=Josh Hokit', '/v1/sports/fights/5?a=Ciryl Gane&b=Josh Hokit&start=tomorrow', '/v1/sports/fights/5?a=Ciryl Gane&b=Josh Hokit&start=2020-01-01T00:00:00Z', '/v1/sports/fights/5?a=Ciryl Gane&b=Josh Hokit&start=2031-01-01T00:00:00Z', '/v1/sports/fights/5?start=2026-11-14T22:00:00Z']
    for (const p of bad) {
      const res = await get(h.app, q(p))
      expect(res.status, p).toBe(400)
      expect(res.body.error.code).toBe('invalid_params')
    }
    expect(h.calls).toHaveLength(0)
  })
})

// ---- results -------------------------------------------------------------------------------------------

describe('a decision with three judges (UFC 334, Gane v Hokit, by claim)', () => {
  it('card leads status/round/clock; UFC leads result and figures; every figure is a number or null under OUR keys', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    const res = await get(h.app, '/v1/sports/fights/13140' + GANE)
    expect(res.status).toBe(200)
    expect(res.body.sources).toEqual({ venue: { state: 'unreadable', reason: 'connecting', label: 'Polymarket' }, card: { state: 'read', label: 'ESPN' }, figures: { state: 'read', label: 'UFC' } })
    const f = res.body.fight
    expect(f).toMatchObject({ gameId: 13140, source: 'card', status: 'ended', round: 5, clock: '5:00', weightClass: 'Heavyweight', venue: null })
    expect(f.fighters).toEqual([{ name: 'Ciryl Gane' }, { name: 'Josh Hokit' }])
    expect(f.result).toEqual({
      source: 'figures',
      outcome: 'win',
      winner: 0,
      method: 'Decision - Unanimous',
      endingRound: 5,
      endingTime: '5:00',
      judges: [
        { name: 'Adrian Castro', scores: [48, 47] },
        { name: "Sal D'amato", scores: [48, 47] },
        { name: 'Chris Lee', scores: [48, 47] },
      ],
    })
    expect(f.rounds.map((r) => r.round)).toEqual([1, 2, 3, 4, 5])
    for (const r of f.rounds) {
      expect(r.figures).toHaveLength(2)
      for (const fig of r.figures) expect(Object.keys(fig)).toEqual(FIGURE_NAMES)
    }
    // Gane, round 1: the source's own figures, unchanged (TotalStrikesLanded 41, SigStrikesLanded 41).
    expect(f.rounds[0].figures[0]).toMatchObject({ totalStrikesLanded: 41, sigStrikesLanded: 41, headStrikesLanded: 34, knockdowns: 0 })
    expect(f.overall).toHaveLength(2)
    expect(Object.keys(f.overall[0])).toEqual(FIGURE_NAMES)
    // Nothing derived: no keys beyond the fixed list, and no score/lead/winning field anywhere in the body.
    expect(JSON.stringify(res.body)).not.toMatch(/accuracy|lead|winning|likely|total":/i)
    expect(res.body.fight.scheduledRounds).toBe(ESPN_1114.events[0].competitions.find((c) => c.competitors.some((x) => x.athlete.displayName === 'Ciryl Gane')).format.regulation.periods)
  })

  it('the identity\'s order decides every pair: swapping the claim swaps names, winner index, judges and figures', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    const a = (await get(h.app, '/v1/sports/fights/13140' + GANE)).body.fight
    const b = (await get(h.app, '/v1/sports/fights/13140' + q('?a=Josh Hokit&b=Ciryl Gane&start=2026-11-14T22:00:00Z'))).body.fight
    expect(b.fighters).toEqual([{ name: 'Josh Hokit' }, { name: 'Ciryl Gane' }])
    expect(b.result.winner).toBe(1)
    expect(b.result.judges[0].scores).toEqual([47, 48])
    expect(b.rounds[0].figures).toEqual([a.rounds[0].figures[1], a.rounds[0].figures[0]])
    expect(b.overall).toEqual([a.overall[1], a.overall[0]])
  })
})

describe('a KO (Thompson v Radtke), named by the venue\'s own frame', () => {
  it('no claim is needed; the result has a method, ending round and time and NO judges; the venue block carries its own text', async () => {
    const h = makeApp()
    await warm(h, [F_KO])
    const res = await get(h.app, '/v1/sports/fights/10751')
    const f = res.body.fight
    expect(f).toMatchObject({ source: 'card', status: 'ended', round: 3, clock: '2:54' })
    expect(f.fighters).toEqual([{ name: 'Stephen Thompson' }, { name: 'Charles Radtke' }])
    expect(f.result).toEqual({ source: 'figures', outcome: 'win', winner: 0, method: 'KO/TKO', endingRound: 3, endingTime: '2:54', judges: [] })
    expect(f.venue).toMatchObject({ status: 'ended', scoreText: '1-0|KO/TKO', clock: '02:54' })
    expect(f.rounds).toHaveLength(3)
  })
})

describe('a draw (Holland v Medic, majority) — a result with no winner', () => {
  it('outcome draw, winner null, the judges\' scores kept; ESPN\'s both-false is NOT what says "draw"', async () => {
    const h = makeApp()
    await warm(h, [F_DRAW])
    const f = (await get(h.app, '/v1/sports/fights/10805')).body.fight
    expect(f.status).toBe('ended')
    expect(f.result).toMatchObject({ source: 'figures', outcome: 'draw', winner: null, method: 'Decision - Majority', endingRound: 3 })
    expect(f.result.judges).toHaveLength(3)
    // ESPN's own competitors carry winner:false/false for this fight — and for a fight not yet fought:
    const [c] = parseMmaScoreboard(ESPN_1114).filter((x) => normName(x.names[0]) === 'kevin holland')
    expect(c.winner).toBeNull()
  })

  it('with the UFC source down the draw is NOT guessed: the result is absent, never "no winner so a draw"', async () => {
    const h = makeApp({ down: { ufc: 'throw' } })
    await warm(h, [F_DRAW])
    const res = await get(h.app, '/v1/sports/fights/10805')
    expect(res.body.sources.figures).toMatchObject({ state: 'unreadable', reason: 'upstream_unreachable', label: 'UFC' })
    expect(res.body.fight.status).toBe('ended')
    expect(res.body.fight.result).toBeNull()
    expect(res.body.fight.rounds).toBeNull()
  })
})

describe('a no contest (Craig v Bellato, 2025 card)', () => {
  it('outcome no-contest, no winner, the source\'s method text, no judges', async () => {
    const h = makeApp({ startAt: '2025-06-15T12:00:00Z', events: { 1259: EV1259 }, espn: { 20250614: ESPN_0614 }, env: { SPORTS_UFC_ANCHOR_ID: '1259' } })
    await get(h.app, '/v1/sports/games?ids=1')
    const res = await get(h.app, '/v1/sports/fights/12156' + q('?a=Paul Craig&b=Rodolfo Bellato&start=2025-06-14T23:00:00Z'))
    expect(res.status).toBe(200)
    const f = res.body.fight
    expect(f).toMatchObject({ source: 'card', status: 'ended', round: 1, clock: '4:59' })
    expect(f.result).toMatchObject({ source: 'figures', outcome: 'no-contest', winner: null, method: 'Could Not Continue', endingRound: 1 })
    expect(f.result.judges).toEqual([])
    expect(f.rounds).toHaveLength(1)
  })
})

describe('cancelled', () => {
  it('a venue-only cancelled fight is a result with no winner, said by the venue and no one else', async () => {
    const h = makeApp({ down: { espn: 'throw', ufc: 'throw' } })
    await warm(h, [F_CANCELED])
    const res = await get(h.app, '/v1/sports/fights/10201')
    expect(res.body.fight).toMatchObject({ source: 'venue', status: 'cancelled', round: null, clock: '00:00' })
    expect(res.body.fight.result).toEqual({ source: 'venue', outcome: 'cancelled', winner: null, method: null, endingRound: null, endingTime: null, judges: [] })
    expect(res.body.sources.card).toMatchObject({ state: 'unreadable' })
    expect(res.body.sources.figures).toMatchObject({ state: 'unreadable' })
  })

  it('REAL disagreement: the venue says "Canceled" for Nunes v Harrison while ESPN and UFC say it was fought — the leading sources win, the venue\'s word rides beside', async () => {
    const h = makeApp()
    await warm(h, [F_CANCELED])
    const f = (await get(h.app, '/v1/sports/fights/10201')).body.fight
    expect(f).toMatchObject({ source: 'card', status: 'ended', round: 4, clock: '1:29' })
    expect(f.venue).toMatchObject({ status: 'cancelled' })
    expect(f.result).toMatchObject({ source: 'figures', outcome: 'win', method: 'Submission', endingRound: 4 })
    expect(f.fighters.map((x) => x.name)).toEqual(['Amanda Nunes', 'Kayla Harrison'])
    expect(f.result.winner).toBe(1) // Harrison is the venue's AWAY fighter, second in the pair
  })
})

// ---- each source fails alone ------------------------------------------------------------------------

describe('each source fails alone and is named', () => {
  it('ESPN down: card unreadable, the row falls back to UFC\'s own status/ending round and clock, the result and figures still read', async () => {
    const h = makeApp({ down: { espn: 'throw' } })
    await warm(h, [F_KO])
    const res = await get(h.app, '/v1/sports/fights/10751')
    expect(res.body.sources.card).toEqual({ state: 'unreadable', reason: 'upstream_unreachable', label: 'ESPN' })
    expect(res.body.sources.figures.state).toBe('read')
    expect(res.body.fight).toMatchObject({ source: 'figures', status: 'ended', round: 3, clock: '2:54', weightClass: expect.any(String) })
    expect(res.body.fight.result.method).toBe('KO/TKO')
  })

  it('ESPN 5xx is named upstream_error', async () => {
    const h = makeApp({ down: { espn: 503 } })
    await warm(h, [F_KO])
    expect((await get(h.app, '/v1/sports/fights/10751')).body.sources.card).toEqual({ state: 'unreadable', reason: 'upstream_error', label: 'ESPN' })
  })

  it('UFC down: figures unreadable; card still leads; the result is ESPN\'s single winner flag with NO method/judges/figures', async () => {
    const h = makeApp({ down: { ufc: 'throw' } })
    await warm(h, [F_KO])
    const res = await get(h.app, '/v1/sports/fights/10751')
    expect(res.body.sources.figures).toEqual({ state: 'unreadable', reason: 'upstream_unreachable', label: 'UFC' })
    expect(res.body.fight).toMatchObject({ source: 'card', status: 'ended', round: 3, clock: '2:54', rounds: null, overall: null })
    expect(res.body.fight.result).toEqual({ source: 'card', outcome: 'win', winner: 0, method: null, endingRound: null, endingTime: null, judges: [] })
  })

  it('the UFC fight read failing alone drops the whole figures source (result included) and names it', async () => {
    const h = makeApp({ down: { ufcFight: true } })
    await warm(h, [F_KO])
    const res = await get(h.app, '/v1/sports/fights/10751')
    expect(res.body.sources.figures).toEqual({ state: 'unreadable', reason: 'upstream_error', label: 'UFC' })
    expect(res.body.fight.result.source).toBe('card')
  })

  it('the venue down: card + figures still answer from a claim, and the venue source is named', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    const res = await get(h.app, '/v1/sports/fights/13140' + GANE)
    expect(res.body.sources.venue.state).toBe('unreadable')
    expect(res.body.fight.source).toBe('card')
  })
})

describe('matching is by BOTH names, exactly one or not-matched', () => {
  it('unknown fighters: not-matched on both sources, an all-null fight, and the claim is never echoed', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    const res = await get(h.app, '/v1/sports/fights/99' + q('?a=Nobody Known&b=Also Unknown&start=2026-11-14T22:00:00Z'))
    expect(res.body.sources.card).toEqual({ state: 'not-matched', reason: 'no_candidate', label: 'ESPN' })
    expect(res.body.sources.figures).toEqual({ state: 'not-matched', reason: 'no_candidate', label: 'UFC' })
    expect(res.body.fight).toMatchObject({ source: null, status: null, round: null, clock: null, confirmedAt: null, result: null, rounds: null, fighters: [{ name: null }, { name: null }] })
    expect(JSON.stringify(res.body)).not.toContain('Nobody')
  })

  it('one fighter right and one wrong is not a match (never nearest)', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    const res = await get(h.app, '/v1/sports/fights/99' + q('?a=Ciryl Gane&b=Somebody Else&start=2026-11-14T22:00:00Z'))
    expect(res.body.sources.card.state).toBe('not-matched')
    expect(res.body.sources.figures.state).toBe('not-matched')
  })

  it('two ESPN fights for the same pair is ambiguous, not the first', async () => {
    const sb = structuredClone(ESPN_1114)
    sb.events[0].competitions.push(structuredClone(sb.events[0].competitions[0]))
    const h = makeApp({ espn: { 20261114: sb } })
    await warm(h, [F_KO])
    expect((await get(h.app, '/v1/sports/fights/10751')).body.sources.card).toEqual({ state: 'not-matched', reason: 'ambiguous', label: 'ESPN' })
  })

  it('a rematch on another card is ambiguous with no start, and resolved by a start', async () => {
    const other = structuredClone(EV1345)
    other.LiveEventDetail.EventId = 1346
    other.LiveEventDetail.StartTime = '2026-11-15T20:00Z' // a second card inside the same window, same pair
    const h = makeApp({ events: { 1345: EV1345, 1346: other } })
    await warm(h, [F_KO])
    expect((await get(h.app, '/v1/sports/fights/10751')).body.sources.figures).toEqual({ state: 'not-matched', reason: 'ambiguous', label: 'UFC' })
  })

  it('names are compared normalised: diacritics, case, punctuation, trailing space', () => {
    expect(normName('Uroš Medić')).toBe(normName('uros medic'))
    expect(normName("Tre'ston  Vines ")).toBe(normName("TRE'STON VINES"))
    expect(normName('Levi Rodrigues Jr.')).toBe(normName('Levi Rodrigues Jr'))
    expect(normName('   ')).toBeNull()
    expect(pairKey('A Bee', 'C Dee')).toBe(pairKey('c dee', 'a bee'))
    expect(pairKey('A Bee', 'a bee')).toBeNull()
  })
})

// ---- a claim cannot poison -----------------------------------------------------------------------------

describe('identity claim', () => {
  it('the venue\'s own frame wins: a claim for OTHER fighters changes nothing', async () => {
    const h = makeApp()
    await warm(h, [F_KO])
    const truth = (await get(h.app, '/v1/sports/fights/10751')).body.fight
    const lie = (await get(h.app, '/v1/sports/fights/10751' + q('?a=Ciryl Gane&b=Josh Hokit&start=2026-11-14T22:00:00Z'))).body.fight
    expect(lie).toEqual(truth)
  })

  it('a claim for a gameId the venue has NOT named is used for that request only: the next request for the same gameId gets nothing', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    const claimed = (await get(h.app, '/v1/sports/fights/13140' + GANE)).body.fight
    expect(claimed.source).toBe('card')
    const plain = (await get(h.app, '/v1/sports/fights/13140')).body
    expect(plain.fight).toMatchObject({ source: null, result: null, rounds: null })
    expect(plain.sources.card).toEqual({ state: 'not-matched', reason: 'no_identity', label: 'ESPN' })
    // and a different gameId claiming the same fighters learns nothing from the first
    const other = (await get(h.app, '/v1/sports/fights/777')).body.fight
    expect(other.source).toBeNull()
  })

  it('a lying claim only misleads its own request: it cannot make a gameId return another fight to anyone else', async () => {
    const h = makeApp()
    await warm(h, [F_KO])
    await get(h.app, '/v1/sports/fights/555' + GANE) // 555 is unnamed: it is told "Gane v Hokit"
    const named = (await get(h.app, '/v1/sports/fights/10751')).body.fight
    expect(named.fighters.map((x) => x.name)).toEqual(['Stephen Thompson', 'Charles Radtke'])
  })

  it('a non-UFC venue frame makes the fight route not-covered (never a UFC lookup)', async () => {
    const h = makeApp()
    await warm(h, [{ ...F_KO, gameId: 321, leagueAbbreviation: 'cs2' }])
    const res = await get(h.app, '/v1/sports/fights/321')
    expect(res.body.sources.card).toMatchObject({ state: 'not-covered' })
    expect(res.body.sources.figures).toMatchObject({ state: 'not-covered' })
    expect(h.calls).toHaveLength(0)
  })

  it('parseFightClaim: shape only, start bounded to [-45 d, +30 d]', () => {
    const now = Date.parse('2026-11-27T00:00:00Z')
    expect(parseFightClaim({}, now)).toBeNull()
    expect(parseFightClaim({ a: 'Ciryl Gane', b: "Tre'ston Vines", start: '2026-11-30T00:00:00Z' }, now)).toMatchObject({ a: 'Ciryl Gane', startMs: Date.parse('2026-11-30T00:00:00Z') })
    expect(() => parseFightClaim({ a: 'Ciryl Gane', b: 'Josh Hokit', start: '2027-02-01T00:00:00Z' }, now)).toThrow()
    expect(() => parseFightClaim({ a: ['x', 'y'], b: 'Josh Hokit' }, now)).toThrow()
  })
})

// ---- the number of upstream requests ---------------------------------------------------------------------

describe('upstream request counts are a function of fights being viewed', () => {
  it('N concurrent viewers of one finished fight: one ESPN read, the discovery probe once, ONE fight read', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    const rs = await Promise.all(Array.from({ length: 6 }, () => get(h.app, '/v1/sports/fights/13140' + GANE)))
    expect(rs.every((r) => r.status === 200 && r.body.fight.source === 'card')).toBe(true)
    // discovery: anchor 1345 (a card) then probeMax=3 empty ids past it = 4 event reads, once
    expect(h.calls.filter((u) => /\/event\/live\/\d+\.json/.test(u)).map((u) => /(\d+)\.json/.exec(u)[1])).toEqual(['1345', '1346', '1347', '1348'])
    expect(count(h, /\/mma\/ufc\/scoreboard\?dates=20261113-20261115$/)).toBe(1)
    expect(count(h, /\/fight\/live\/13140\.json$/)).toBe(1)
  })

  it('a final fight and a final card are read once for good; ESPN follows its cache floor; discovery refresh costs probeMax, not the card again', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    await get(h.app, '/v1/sports/fights/13140' + GANE)
    const afterFirst = h.calls.length
    h.clock.advance(5_000)
    await get(h.app, '/v1/sports/fights/13140' + GANE)
    expect(h.calls.length).toBe(afterFirst) // inside every TTL: nothing
    h.clock.advance(6_000) // past the 10 s scoreboard floor
    await get(h.app, '/v1/sports/fights/13140' + GANE)
    expect(h.calls.length).toBe(afterFirst + 1)
    expect(h.calls.at(-1)).toMatch(/scoreboard/)
    h.clock.advance(7 * 3_600_000) // past the 6 h discovery TTL (the viewer keeps the socket warm)
    await get(h.app, '/v1/sports/fights/13140' + GANE)
    const events = h.calls.filter((u) => /\/event\/live\//.test(u)).map((u) => /(\d+)\.json/.exec(u)[1])
    expect(events).toEqual(['1345', '1346', '1347', '1348', '1346', '1347', '1348']) // the card 1345 is NOT re-read
    expect(count(h, /\/fight\/live\/13140\.json$/)).toBe(1)
  })

  it('nothing is read for a viewer nobody is: no timers poll, and a scheduled fight asks for no figures', async () => {
    const h = makeApp()
    await get(h.app, '/v1/sports/games?ids=1')
    await get(h.app, '/v1/sports/fights/13140' + GANE)
    const n = h.calls.length
    h.clock.advance(3_600_000)
    expect(h.calls).toHaveLength(n)
  })

  it('a discovery failure is cached briefly, not hammered, and named', async () => {
    const h = makeApp({ down: { ufc: 'throw' } })
    await get(h.app, '/v1/sports/games?ids=1')
    await Promise.all([get(h.app, '/v1/sports/fights/13140' + GANE), get(h.app, '/v1/sports/fights/13140' + GANE)])
    expect(count(h, /\/event\/live\//)).toBe(1)
    const res = await get(h.app, '/v1/sports/fights/13140' + GANE)
    expect(res.body.sources.figures).toEqual({ state: 'unreadable', reason: 'upstream_unreachable', label: 'UFC' })
    expect(res.body.fight.source).toBe('card') // ESPN alone still answers
  })

  it('ESPN dates are built from a card\'s own start time as a three-day range', () => {
    expect(espnDateRange(Date.parse('2026-11-14T22:00:00Z'))).toBe('20261113-20261115')
    expect(espnDateRange(Date.parse('2026-12-05T01:00:00Z'))).toBe('20261204-20261206')
  })
})

// ---- units ------------------------------------------------------------------------------------------------

describe('figures: only what the source reported, as numbers, under our own keys (FR-018)', () => {
  it('absent, blank, null or odd is null; a reported 0 stays 0; no source-only field leaks', () => {
    const row = figureRow({ Knockdowns: 0, SigStrikesLanded: '', SigStrikesAttempted: null, TakedownsLanded: 'x', Reversals: 2, SigStrikesAccuracy: 69.1, NeutralTime: '20:19', ControlTime: '1:05' })
    expect(Object.keys(row)).toEqual(FIGURE_NAMES)
    expect(row).toMatchObject({ knockdowns: 0, sigStrikesLanded: null, sigStrikesAttempted: null, takedownsLanded: null, reversals: 2, totalStrikesLanded: null, controlSeconds: 65 })
    expect(figureRow(null)).toEqual(Object.fromEntries(FIGURE_NAMES.map((k) => [k, null])))
    expect(figureRow({ ControlTime: '' }).controlSeconds).toBeNull()
    for (const theirs of Object.values(FIGURE_KEYS)) expect(FIGURE_NAMES).not.toContain(theirs)
  })

  it('a round the source never reported is absent; a missing fighter row is an all-null row, not zeros', () => {
    const body = { LiveFightDetail: { Status: 'Final', OfficialStats: true, RoundStats: [{ FighterId: 1, Rounds: [{ RoundNumber: 2, Knockdowns: 1 }] }], FightStats: [] } }
    const out = parseUfcFigures(body, [1, 2])
    expect(out.rounds).toHaveLength(1)
    expect(out.rounds[0].round).toBe(2)
    expect(out.rounds[0].figures[0].knockdowns).toBe(1)
    expect(Object.values(out.rounds[0].figures[1]).every((v) => v === null)).toBe(true)
    expect(out.overall).toBeNull()
    expect(parseUfcFigures({}, [1, 2])).toBeNull()
  })

  it('the three live fields are carried as null where the source sends null (the only state ever observed)', () => {
    const ev = parseUfcEvent(EV1345)
    expect(ev.live).toEqual({ fightId: null, round: null, elapsed: null })
    expect(parseUfcEvent({ LiveEventDetail: {} })).toBeNull()
  })
})

describe('UFC fight parsing (real completed fights)', () => {
  const fights = Object.fromEntries([...EV1345.LiveEventDetail.FightCard, ...EV1259.LiveEventDetail.FightCard].map((f) => [f.FightId, parseUfcFight(f)]))
  it('outcomes: win, draw (majority), no contest; draw and no contest carry no winner', () => {
    expect(fights[13140]).toMatchObject({ outcome: 'win', winner: 0, scheduledRounds: 5, weightClass: 'Heavyweight' })
    expect(fights[13143]).toMatchObject({ outcome: 'draw', winner: null })
    expect(fights[12156]).toMatchObject({ outcome: 'no-contest', winner: null })
    expect(fights[13145].result.judges).toEqual([])
    expect(fights[13143].result.judges).toHaveLength(3)
  })
})

describe('ESPN MMA scoreboard parsing (real completed fights)', () => {
  it('reads state, round, clock, scheduled rounds, weight class and exactly-one winner; filler for an unfought fight is null', () => {
    const [thompson] = parseMmaScoreboard(ESPN_1114).filter((c) => normName(c.names[0]) === 'stephen thompson')
    expect(thompson).toMatchObject({ state: 'ended', completed: true, round: 3, clock: '2:54', winner: 0 })
    const sched = parseMmaScoreboard({ events: [{ competitions: [{ id: '1', competitors: [{ athlete: { displayName: 'A One' }, winner: false }, { athlete: { displayName: 'B Two' }, winner: false }], status: { period: 0, displayClock: '-', type: { state: 'pre', completed: false } }, format: { regulation: { periods: 3 } }, type: { abbreviation: 'Lightweight' } }] }] })[0]
    expect(sched).toMatchObject({ state: 'scheduled', round: null, clock: null, winner: null, scheduledRounds: 3, weightClass: 'Lightweight' })
  })
  it('`post` that is not `completed` is not "ended"', async () => {
    const sb = structuredClone(ESPN_1114)
    for (const c of sb.events[0].competitions) c.status.type.completed = false
    const h = makeApp({ espn: { 20261114: sb } })
    await warm(h, [F_KO])
    const res = await get(h.app, '/v1/sports/fights/10751')
    expect(res.body.fight.source).toBe('card')
    expect(res.body.fight.status).toBeNull()
  })
})

describe('trust bounds for the fight sources', () => {
  it('are in the ONE constant: card like plays, figures never live, venue unchanged', () => {
    expect(TRUST_BOUNDS.card).toEqual({ liveMs: 30_000, delayedMs: 120_000 })
    expect(TRUST_BOUNDS.figures).toEqual({ liveMs: null, delayedMs: 120_000 })
    expect(TRUST_BOUNDS.venue.liveMs).toBeNull()
  })
})

describe('EventRow.game for a fight listing (real closed listing, series 38)', () => {
  it('names the fight with two fighters and the venue\'s ordering; codes are meaningless abbreviations and ride unchanged', () => {
    const g = normalizeGame(fx('gamma-ufc-listing-10924.json'))
    expect(g).toEqual({
      gameId: 10924,
      league: 'ufc',
      startTime: '2026-11-21T15:00:00Z',
      listed: { status: 'ended', scoreText: '1-0|KO/TKO', period: 'FT', clock: '00:24' },
      home: { name: 'Diyar Nurgozhay', code: 'DIY' },
      away: { name: 'Alik Lorenz', code: 'ALI8' },
    })
  })
})
