/**
 * /v1/sports/* live game proxy tests (spec 115 — contracts/gateway-sports-api.md).
 *
 * Both upstreams are injected: a fake WebSocket constructor + fake timers for the venue feed, and
 * a recording fetch for ESPN. Fixtures in test/fixtures/sports/ are cut from a capture taken
 * 2026-11-27 during PHI @ DAL (venue game 19618, ESPN 401873080); research.md R1-R3 describes it.
 * Every test that talks about upstream load asserts on the REQUESTS made (URL and count), not only
 * on the answer.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server.js'
import { createKillSwitch } from '../src/policy/killswitch.js'
import { createVenueFeed } from '../src/sports/venueFeed.js'
import { matchEvent, espnCode } from '../src/sports/match.js'
import { deriveYardLine, intOrNull, parseScoreboard, parseSummary, parseVenueFrame, normalizeSituation } from '../src/sports/normalize.js'
import { TRUST_BOUNDS } from '../src/sports/bounds.js'
import { normalizeGame, normalizeEvent } from '../src/polymarket/normalize.js'
import { testConfig, mockProviders, mockEngine, ORIGIN_SECRET, TEST_NOW } from './helpers.js'

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sports')
const fx = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'))
const SCOREBOARD = fx('espn-scoreboard-nfl.json')
const SUMMARY = fx('espn-summary-nfl.json')
const SUMMARY_FINAL = fx('espn-summary-nfl-final.json')
const SITUATIONS = fx('espn-situations-401873080.json')

// Venue frames as the feed sends them (captured 2026-11-27; only the NFL one is trimmed of nothing).
const NFL_FRAME = { gameId: 19618, leagueAbbreviation: 'nfl', turn: 'phi', homeTeam: 'DAL', awayTeam: 'PHI', turnProviderId: '26', status: 'InProgress', score: '10-28', elapsed: '9:44', period: 'Q3', live: true, ended: false }
const VAL_FRAME = { gameId: 1830762, leagueAbbreviation: 'val', homeTeam: 'Fluxo W7M', awayTeam: 'Elevate', status: 'running', score: '000-000|1-1|Bo3', period: '1/3', live: true, ended: false }
const CRICKET_FRAME = { metadataGameId: 'id2703917576109864', leagueAbbreviation: 'cricket', score: '192-15', period: 'Live', live: true, ended: false }
// The venue's ended-game shape: `ended: true` is the field the parser keys on (the NFL status word is not asserted).
const ENDED_FRAME = { gameId: 19620, leagueAbbreviation: 'nfl', homeTeam: 'DET', awayTeam: 'CHI', status: 'Final', score: '39-35', period: 'VFT', live: false, ended: true }

// ---- harness -------------------------------------------------------------------------------------

class FakeWS {
  static instances = []
  constructor(url) {
    this.url = url
    this.closed = false
    FakeWS.instances.push(this)
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  send(obj) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) })
  }
  drop() {
    this.onclose?.({ code: 1006 })
  }
}

function fakeClock(startMs) {
  const clock = { ms: startMs, timers: [], seq: 0 }
  clock.setTimer = (fn, ms) => {
    const t = { id: ++clock.seq, at: clock.ms + ms, fn }
    clock.timers.push(t)
    return t.id
  }
  clock.clearTimer = (id) => {
    clock.timers = clock.timers.filter((t) => t.id !== id)
  }
  clock.advance = (ms) => {
    const target = clock.ms + ms
    for (;;) {
      const due = clock.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clock.timers = clock.timers.filter((t) => t !== due)
      clock.ms = due.at
      due.fn()
    }
    clock.ms = target
  }
  return clock
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function makeApp({ env = {}, scoreboard = SCOREBOARD, summary = SUMMARY, fetchImpl } = {}) {
  FakeWS.instances = []
  const config = testConfig({ SPORTS_ENABLED: 'true', ...env })
  const clock = fakeClock(TEST_NOW * 1000)
  const calls = []
  const ctl = { scoreboard, summary, fail: false }
  const sportsFetch =
    fetchImpl ??
    (async (url) => {
      calls.push(String(url))
      if (ctl.fail) throw new TypeError('network down')
      if (String(url).includes('/scoreboard')) return jsonRes(ctl.scoreboard)
      if (String(url).includes('/summary')) return jsonRes(ctl.summary)
      return jsonRes({}, 404)
    })
  const killSwitch = createKillSwitch(false)
  const built = createApp(config, {
    providers: mockProviders(config),
    engineClient: mockEngine(),
    // deps.now is UNIX SECONDS; the fake clock is ms, so both read the same instant.
    now: () => clock.ms / 1000,
    killSwitch,
    sportsWebSocket: FakeWS,
    sportsFetch,
    sportsTimers: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  })
  return { ...built, config, clock, calls, ctl, killSwitch }
}

const get = (app, p) => request(app).get(p).set('X-Origin-Auth', ORIGIN_SECRET)
const LIST = '/v1/sports/games?ids=19618'
const DETAIL = '/v1/sports/games/19618'

/** Make a request, open the socket it caused, push frames, return nothing. */
async function warm(h, frames) {
  await get(h.app, LIST)
  FakeWS.instances.at(-1).open()
  for (const f of frames) FakeWS.instances.at(-1).send(f)
}

// ---- module state --------------------------------------------------------------------------------

describe('module state', () => {
  it('off answers 503 sports_unconfigured on both routes and touches no upstream', async () => {
    const h = makeApp({ env: { SPORTS_ENABLED: 'false' } })
    for (const p of [LIST, DETAIL, '/v1/sports/games?ids=junk']) {
      const res = await get(h.app, p)
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('sports_unconfigured')
    }
    expect(FakeWS.instances).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('module killswitch answers 503 sports_paused; the global one answers killswitch_active; neither connects', async () => {
    const paused = makeApp({ env: { SPORTS_KILLSWITCH: 'true' } })
    const res = await get(paused.app, LIST)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('sports_paused')
    expect(FakeWS.instances).toHaveLength(0)

    const g = makeApp()
    g.killSwitch.set(true)
    const res2 = await get(g.app, DETAIL)
    expect(res2.status).toBe(503)
    expect(res2.body.error.code).toBe('killswitch_active')
    expect(FakeWS.instances).toHaveLength(0)
  })

  it('validates ids before any upstream is touched', async () => {
    const h = makeApp()
    const bad = ['/v1/sports/games', '/v1/sports/games?ids=', '/v1/sports/games?ids=abc', '/v1/sports/games?ids=0', '/v1/sports/games?ids=1,,2', `/v1/sports/games?ids=${Array.from({ length: 11 }, (_, i) => i + 1).join(',')}`, '/v1/sports/games?ids=1&ids=2', '/v1/sports/games/0', '/v1/sports/games/x1']
    for (const p of bad) {
      const res = await get(h.app, p)
      expect(res.status, p).toBe(400)
      expect(res.body.error.code).toBe('invalid_params')
    }
    expect(FakeWS.instances).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it('answers 429 with Retry-After and does not spend quota on a refused module', async () => {
    const h = makeApp({ env: { SPORTS_QUOTA_PER_IP: '2' } })
    await get(h.app, LIST)
    await get(h.app, LIST)
    const res = await get(h.app, LIST)
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
    const off = makeApp({ env: { SPORTS_ENABLED: 'false', SPORTS_QUOTA_PER_IP: '1' } })
    await get(off.app, LIST)
    await get(off.app, LIST)
    expect((await get(off.app, LIST)).status).toBe(503)
  })

  it('/status carries a sports block with no game content', async () => {
    const h = makeApp()
    const res = await get(h.app, '/status')
    expect(res.body.sports).toMatchObject({ enabled: true, killed: false, playsEnabled: true, scoreboardTtlMs: 10_000, summaryTtlMs: 5_000, idleCloseMs: 300_000 })
    const off = await get(makeApp({ env: { SPORTS_ENABLED: 'false' } }).app, '/status')
    expect(off.body.sports).toMatchObject({ enabled: false, venue: null })
  })

  it('clamps the cache TTLs to the floors', () => {
    const c = testConfig({ SPORTS_SCOREBOARD_TTL_MS: '1', SPORTS_SUMMARY_TTL_MS: '1' })
    expect(c.sports.scoreboardTtlMs).toBe(10_000)
    expect(c.sports.summaryTtlMs).toBe(5_000)
  })

  it('refuses a malformed upstream URL at boot when enabled', () => {
    expect(() => testConfig({ SPORTS_ENABLED: 'true', SPORTS_VENUE_WS_URL: 'ftp://x' })).toThrow(/SPORTS_VENUE_WS_URL/)
    expect(() => testConfig({ SPORTS_ENABLED: 'true', SPORTS_ESPN_BASE_URL: 'nope' })).toThrow(/SPORTS_ESPN_BASE_URL/)
  })
})

// ---- rows ----------------------------------------------------------------------------------------

describe('GET /v1/sports/games', () => {
  it('an unknown id is an all-null row; the request does not wait for the socket and opens it once', async () => {
    const h = makeApp()
    const [a, b, c] = await Promise.all([get(h.app, LIST), get(h.app, LIST), get(h.app, '/v1/sports/games?ids=19618,5')])
    expect(a.status).toBe(200)
    expect(a.body.sources.venue).toEqual({ state: 'unreadable', reason: 'connecting' }) // the socket never opened and the request still answered
    expect(b.body.games[0]).toEqual({ gameId: 19618, league: null, status: null, score: null, scoreText: null, period: null, clock: null, possession: null, confirmedAt: null, confirmedBy: null, agree: null })
    expect(c.body.games.map((g) => g.gameId)).toEqual([19618, 5])
    expect(FakeWS.instances).toHaveLength(1)
    expect(FakeWS.instances[0].url).toBe('wss://sports-api.polymarket.com/ws')
    expect(h.calls).toHaveLength(0) // nothing to cross-check, so ESPN is not asked
  })

  it('NFL: venue score is away-home, possession from `turn`, and the ESPN cross-check agrees (one upstream call for N requests)', async () => {
    const h = makeApp()
    await warm(h, [NFL_FRAME])
    const [r1, r2, r3] = await Promise.all([get(h.app, LIST), get(h.app, LIST), get(h.app, LIST)])
    const g = r1.body.games[0]
    expect(g).toMatchObject({ gameId: 19618, league: 'nfl', status: 'in-progress', score: { home: 28, away: 10 }, period: 'Q3', clock: '9:44', possession: 'away', confirmedBy: 'both', agree: true })
    expect(g.confirmedAt).toBe(TEST_NOW * 1000)
    expect(r1.body.sources).toEqual({ venue: { state: 'read' }, plays: { state: 'read' } })
    expect(r2.body.games[0]).toEqual(g)
    expect(r3.body.serverNow).toBe(TEST_NOW * 1000)
    expect(h.calls).toEqual(['https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'])
  })

  it('a non-integer score is null with scoreText, and an uncovered league reads no ESPN', async () => {
    const h = makeApp()
    await warm(h, [VAL_FRAME])
    const res = await get(h.app, '/v1/sports/games?ids=1830762')
    expect(res.body.games[0]).toMatchObject({ gameId: 1830762, league: 'val', status: 'in-progress', score: null, scoreText: '000-000|1-1|Bo3', period: '1/3', possession: null, confirmedBy: 'venue', agree: null })
    expect(res.body.sources.plays).toEqual({ state: 'not-needed' })
    expect(h.calls).toHaveLength(0)
  })

  it('an integer-looking score in a league whose order was never verified is NOT guessed', async () => {
    const h = makeApp()
    await warm(h, [{ ...VAL_FRAME, gameId: 7, leagueAbbreviation: 'cbb', score: '35-39', period: 'H1', elapsed: '01:03' }])
    const g = (await get(h.app, '/v1/sports/games?ids=7')).body.games[0]
    expect(g.score).toBeNull()
    expect(g.scoreText).toBe('35-39')
  })

  it('where both agree the newer confirmation counts: a fresh ESPN read re-confirms an older venue frame', async () => {
    const h = makeApp()
    await warm(h, [NFL_FRAME])
    h.clock.advance(40_000)
    const g = (await get(h.app, LIST)).body.games[0]
    expect(g).toMatchObject({ confirmedBy: 'both', agree: true, confirmedAt: TEST_NOW * 1000 + 40_000 })
  })

  it('where the sources disagree the venue score is returned and agree is false', async () => {
    const sb = structuredClone(SCOREBOARD)
    sb.events[0].competitions[0].competitors.find((c) => c.homeAway === 'away').score = '7'
    const h = makeApp({ scoreboard: sb })
    await warm(h, [NFL_FRAME])
    const g = (await get(h.app, LIST)).body.games[0]
    expect(g.score).toEqual({ home: 28, away: 10 })
    expect(g.agree).toBe(false)
    expect(g.confirmedBy).toBe('venue')
  })

  it('a game ESPN does not list exactly once is not-matched and the row is still the venue row', async () => {
    const h = makeApp()
    await warm(h, [{ ...NFL_FRAME, gameId: 99, homeTeam: 'ZZZ', awayTeam: 'YYY' }])
    const res = await get(h.app, '/v1/sports/games/99')
    expect(res.body.games[0].detail).toEqual({ state: 'not-matched', reason: 'no_candidate' })
    expect(res.body.games[0]).toMatchObject({ score: { home: 28, away: 10 }, confirmedBy: 'venue', agree: null })
  })

  it('ESPN down while the venue is up: the plays source is named unreadable and its data omitted', async () => {
    const h = makeApp()
    h.ctl.fail = true
    await warm(h, [NFL_FRAME])
    const res = await get(h.app, LIST)
    expect(res.body.sources).toEqual({ venue: { state: 'read' }, plays: { state: 'unreadable', reason: 'upstream_unreachable' } })
    expect(res.body.games[0]).toMatchObject({ score: { home: 28, away: 10 }, confirmedBy: 'venue', agree: null })
    // A failure is cached for the window: a viewer polling does not hammer a down upstream.
    await get(h.app, LIST)
    expect(h.calls).toHaveLength(1)
  })

  it('an ESPN 5xx is named upstream_error', async () => {
    const h = makeApp({ fetchImpl: async () => jsonRes({}, 503) })
    await warm(h, [NFL_FRAME])
    expect((await get(h.app, LIST)).body.sources.plays).toEqual({ state: 'unreadable', reason: 'upstream_error' })
  })

  it('venue down while ESPN is up: the last frame keeps its OWN age (ESPN disagrees, so it cannot refresh it), the venue source is named, plays still read', async () => {
    const sb = structuredClone(SCOREBOARD)
    sb.events[0].competitions[0].competitors.find((c) => c.homeAway === 'away').score = '7'
    const h = makeApp({ scoreboard: sb })
    await warm(h, [NFL_FRAME])
    const t0 = h.clock.ms
    FakeWS.instances[0].drop()
    h.clock.advance(500)
    const res = await get(h.app, LIST)
    expect(res.body.sources.venue).toEqual({ state: 'unreadable', reason: 'reconnecting' })
    expect(res.body.sources.plays).toEqual({ state: 'read' })
    expect(res.body.games[0].confirmedAt).toBe(t0) // not refreshed by the ESPN read
    h.clock.advance(19_500) // the backoff has since opened a new socket that has not connected
    const later = await get(h.app, LIST)
    expect(later.body.sources.venue).toEqual({ state: 'unreadable', reason: 'connecting' })
    expect(later.body.serverNow - later.body.games[0].confirmedAt).toBe(20_000)
  })

  it('PLAYS disabled: sources.plays off, detail off, and ESPN is never asked', async () => {
    const h = makeApp({ env: { SPORTS_PLAYS_ENABLED: 'false' } })
    await warm(h, [NFL_FRAME])
    const list = await get(h.app, LIST)
    expect(list.body.sources.plays).toEqual({ state: 'off' })
    const det = await get(h.app, DETAIL)
    expect(det.body.games[0].detail).toEqual({ state: 'off' })
    expect(det.body.games[0].score).toEqual({ home: 28, away: 10 })
    expect(h.calls).toHaveLength(0)
  })

  it('scoreboard cache: >=10 s, then one more call', async () => {
    const h = makeApp()
    await warm(h, [NFL_FRAME])
    await get(h.app, LIST)
    h.clock.advance(9_000)
    await get(h.app, LIST)
    expect(h.calls).toHaveLength(1)
    h.clock.advance(1_500)
    await get(h.app, LIST)
    expect(h.calls).toHaveLength(2)
  })

  it('nothing is polled for a game nobody is asking about', async () => {
    const h = makeApp()
    await warm(h, [NFL_FRAME])
    await get(h.app, LIST)
    const n = h.calls.length
    h.clock.advance(120_000)
    expect(h.calls).toHaveLength(n)
  })

  it('forwards no URL, image or markup field from either source', async () => {
    const sb = structuredClone(SCOREBOARD)
    for (const c of sb.events[0].competitions[0].competitors) Object.assign(c.team, { logo: 'https://a.espncdn.com/x.png', links: [{ href: 'https://example.invalid/' }] })
    const sum = structuredClone(SUMMARY)
    sum.drives.current.plays[0].text = ' Rush <img src=x> for 4 yards\u0007'
    sum.drives.current.plays[0].headshot = { href: 'https://a.espncdn.com/h.png' }
    const h = makeApp({ scoreboard: sb, summary: sum })
    await warm(h, [NFL_FRAME])
    const res = await get(h.app, DETAIL)
    const body = JSON.stringify(res.body)
    expect(body).not.toMatch(/https?:/)
    expect(body).not.toContain('\u0007')
    expect(res.body.games[0].detail.plays.every((p) => typeof p.text === 'string')).toBe(true)
  })
})

// ---- detail --------------------------------------------------------------------------------------

describe('GET /v1/sports/games/:gameId', () => {
  it('situation, newest-first plays (<=12), sides from the drive, behindVenue false; one summary call for N viewers', async () => {
    const h = makeApp()
    await warm(h, [NFL_FRAME])
    const rs = await Promise.all([get(h.app, DETAIL), get(h.app, DETAIL), get(h.app, DETAIL)])
    const d = rs[0].body.games[0].detail
    expect(d.state).toBe('read')
    expect(d.behindVenue).toBe(false)
    expect(d.plays.length).toBeLessThanOrEqual(12)
    expect(d.plays.length).toBeGreaterThan(0)
    const ids = d.plays.map((p) => Number(p.id))
    expect(ids).toEqual([...ids].sort((a, b) => b - a)) // newest first
    expect(d.plays[0]).toMatchObject({ id: '4018730802806', period: 'Q3', clock: '6:38', scoring: false, side: 'home' })
    expect(d.situation).toMatchObject({ possession: 'away', yardLine: 75, yardLineText: 'PHI 25', down: 2, distance: 6, downDistanceText: '2nd & 6 at PHI 25', lineToGain: 69, redZone: false })
    expect(d.confirmedAt).toBe(TEST_NOW * 1000)
    expect(h.calls.filter((u) => u.includes('/summary'))).toEqual(['https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401873080'])
    expect(h.calls.filter((u) => u.includes('/scoreboard'))).toHaveLength(1)
    expect(rs[2].body.games[0].detail).toEqual(d)
  })

  it('summary cache >= 5 s; scoring plays are flagged', async () => {
    const h = makeApp()
    await warm(h, [NFL_FRAME])
    const d1 = (await get(h.app, DETAIL)).body.games[0].detail
    expect(d1.plays.some((p) => p.scoring)).toBe(true)
    h.clock.advance(4_000)
    await get(h.app, DETAIL)
    expect(h.calls.filter((u) => u.includes('/summary'))).toHaveLength(1)
    h.clock.advance(1_500)
    await get(h.app, DETAIL)
    expect(h.calls.filter((u) => u.includes('/summary'))).toHaveLength(2)
  })

  it('behindVenue is true when ESPN has not caught up with the venue', async () => {
    const sb = structuredClone(SCOREBOARD)
    sb.events[0].competitions[0].competitors.find((c) => c.homeAway === 'home').score = '21'
    const h = makeApp({ scoreboard: sb })
    await warm(h, [NFL_FRAME])
    const g = (await get(h.app, DETAIL)).body.games[0]
    expect(g.detail.behindVenue).toBe(true)
    expect(g.agree).toBe(false)
    expect(g.score).toEqual({ home: 28, away: 10 })
  })

  it('a summary that fails alone is named and its data omitted; the venue row is unaffected', async () => {
    const h = makeApp({
      fetchImpl: async (url) => {
        h.calls.push(String(url))
        return String(url).includes('/summary') ? jsonRes({}, 500) : jsonRes(SCOREBOARD)
      },
    })
    await warm(h, [NFL_FRAME])
    const g = (await get(h.app, DETAIL)).body.games[0]
    expect(g.detail).toEqual({ state: 'unreadable', reason: 'upstream_error' })
    expect(g.score).toEqual({ home: 28, away: 10 })
  })

  it('an uncovered league is not-covered; a game the venue has not spoken about is not-matched (no identity)', async () => {
    const h = makeApp()
    await warm(h, [VAL_FRAME])
    expect((await get(h.app, '/v1/sports/games/1830762')).body.games[0].detail).toEqual({ state: 'not-covered' })
    const none = await get(h.app, '/v1/sports/games/4242')
    expect(none.body.games[0].detail).toEqual({ state: 'not-matched', reason: 'no_identity' })
    expect(none.body.games[0].score).toBeNull()
  })

  it('an ended game is read once more and then frozen: no further upstream calls, however long it is asked about', async () => {
    const sb = structuredClone(SCOREBOARD)
    const h = makeApp({ scoreboard: sb, summary: SUMMARY_FINAL })
    await warm(h, [ENDED_FRAME])
    const first = (await get(h.app, '/v1/sports/games/19620')).body.games[0]
    expect(first.status).toBe('ended')
    expect(first.score).toEqual({ home: 35, away: 39 }) // away-home: 39-35, DET (home) 35
    expect(first.detail.state).toBe('read')
    expect(first.detail.situation).toBeNull()
    expect(first.agree).toBe(true)
    const after = h.calls.length
    expect(h.calls.filter((u) => u.includes('/summary'))).toHaveLength(1)
    h.clock.advance(600_000)
    const again = (await get(h.app, '/v1/sports/games/19620')).body.games[0]
    const list = (await get(h.app, '/v1/sports/games?ids=19620')).body.games[0]
    expect(h.calls).toHaveLength(after)
    expect(again.detail).toEqual(first.detail)
    expect(list.score).toEqual({ home: 35, away: 39 })
  })

  it('an ended game seen first by the LIST is frozen too, and the detail then takes its single final summary read', async () => {
    const h = makeApp({ summary: SUMMARY_FINAL })
    await warm(h, [ENDED_FRAME])
    await get(h.app, '/v1/sports/games?ids=19620')
    h.clock.advance(60_000)
    await get(h.app, '/v1/sports/games?ids=19620')
    expect(h.calls.filter((u) => u.includes('/scoreboard'))).toHaveLength(1) // frozen: the second list read made no call
    const d = (await get(h.app, '/v1/sports/games/19620')).body.games[0].detail
    expect(d.state).toBe('read')
    expect(h.calls.filter((u) => u.includes('/summary'))).toHaveLength(1)
  })
})

// ---- the venue feed lifecycle --------------------------------------------------------------------

describe('venue feed', () => {
  function feed(extra = {}) {
    FakeWS.instances = []
    const clock = fakeClock(1_000_000)
    const f = createVenueFeed({ url: 'ws://x.invalid/ws', parseFrame: parseVenueFrame, WebSocketImpl: FakeWS, now: () => clock.ms, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra })
    return { f, clock }
  }

  it('is lazy: constructing opens nothing, the first touch opens one socket, further touches reuse it', () => {
    const { f } = feed()
    expect(FakeWS.instances).toHaveLength(0)
    f.touch()
    f.touch()
    f.touch()
    expect(FakeWS.instances).toHaveLength(1)
    expect(f.state()).toEqual({ state: 'unreadable', reason: 'connecting' })
    FakeWS.instances[0].open()
    expect(f.state()).toEqual({ state: 'read' })
  })

  it('keeps the newest frame per game with its receive time; ignores null control frames, junk and cricket-style frames with no integer id', () => {
    const { f, clock } = feed()
    f.touch()
    const ws = FakeWS.instances[0]
    ws.open()
    ws.send('null')
    ws.send('not json {')
    ws.send(CRICKET_FRAME)
    ws.send(NFL_FRAME)
    clock.advance(5_000)
    ws.send({ ...NFL_FRAME, score: '10-35' })
    const hit = f.read(19618)
    expect(hit.frame.score).toEqual({ home: 35, away: 10 })
    expect(hit.at).toBe(1_005_000)
    expect(f.status().games).toBe(1)
    expect(f.read(404)).toBeNull()
  })

  it('reconnects with capped exponential backoff, resets after an open, and never throws to a caller', () => {
    const { f, clock } = feed({ backoffBaseMs: 1_000, backoffMaxMs: 4_000 })
    f.touch()
    FakeWS.instances[0].open()
    FakeWS.instances[0].drop()
    expect(f.state()).toEqual({ state: 'unreadable', reason: 'reconnecting' })
    expect(FakeWS.instances).toHaveLength(1)
    clock.advance(999)
    expect(FakeWS.instances).toHaveLength(1)
    clock.advance(1)
    expect(FakeWS.instances).toHaveLength(2) // after 1 s
    FakeWS.instances[1].drop() // never opened: next delay doubles
    clock.advance(1_999)
    expect(FakeWS.instances).toHaveLength(2)
    clock.advance(1)
    expect(FakeWS.instances).toHaveLength(3) // after 2 s
    FakeWS.instances[2].drop()
    clock.advance(4_000)
    expect(FakeWS.instances).toHaveLength(4) // 4 s
    FakeWS.instances[3].drop()
    clock.advance(4_000) // capped at 4 s, not 8
    expect(FakeWS.instances).toHaveLength(5)
    FakeWS.instances[4].open()
    FakeWS.instances[4].drop()
    clock.advance(1_000) // reset to base after a successful open
    expect(FakeWS.instances).toHaveLength(6)
  })

  it('a constructor that throws is a state, not an exception', () => {
    FakeWS.instances = []
    const clock = fakeClock(0)
    const f = createVenueFeed({
      url: 'ws://x.invalid',
      parseFrame: parseVenueFrame,
      WebSocketImpl: function Boom() {
        throw new Error('boom')
      },
      now: () => clock.ms,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    expect(() => f.touch()).not.toThrow()
    expect(f.state()).toEqual({ state: 'unreadable', reason: 'reconnecting' })
  })

  it('closes after 5 idle minutes, forgets its frames, does not reconnect, and reopens on the next request', () => {
    const { f, clock } = feed()
    f.touch()
    const ws = FakeWS.instances[0]
    ws.open()
    ws.send(NFL_FRAME)
    clock.advance(299_000)
    f.touch() // a request inside the window restarts the idle clock
    clock.advance(299_000)
    expect(ws.closed).toBe(false)
    expect(f.read(19618)).not.toBeNull()
    clock.advance(1_001)
    expect(ws.closed).toBe(true)
    expect(f.state()).toEqual({ state: 'unreadable', reason: 'not_connected' })
    expect(f.read(19618)).toBeNull()
    ws.drop() // a late close event from the dead socket schedules nothing
    clock.advance(120_000)
    expect(FakeWS.instances).toHaveLength(1)
    f.touch()
    expect(FakeWS.instances).toHaveLength(2)
  })

  it('stops reconnecting when nobody is asking any more', () => {
    const { f, clock } = feed()
    f.touch()
    FakeWS.instances[0].open()
    FakeWS.instances[0].drop()
    clock.advance(300_000) // idle timer fires inside the backoff cycle
    const n = FakeWS.instances.length
    clock.advance(600_000)
    expect(FakeWS.instances).toHaveLength(n)
    expect(f.status().phase).toBe('closed')
  })
})

// ---- units ---------------------------------------------------------------------------------------

describe('numbers exist only where a source gave one', () => {
  it('intOrNull rejects what Number() would turn into 0', () => {
    for (const v of ['', ' ', null, undefined, false, [], {}, 'x', '1.5', -1, 1.5, NaN, Infinity]) expect(intOrNull(v), String(v)).toBeNull()
    expect(intOrNull('0')).toBe(0)
    expect(intOrNull(0)).toBe(0)
    expect(intOrNull('28')).toBe(28)
  })

  it('a blank ESPN score is null, not 0, and a blank frame field is null', () => {
    const sb = structuredClone(SCOREBOARD)
    sb.events[0].competitions[0].competitors[0].score = ''
    delete sb.events[0].competitions[0].competitors[1].score
    const [e] = parseScoreboard(sb)
    expect(e.home.score).toBeNull()
    expect(e.away.score).toBeNull()
    const f = parseVenueFrame({ gameId: 1, leagueAbbreviation: 'nfl', homeTeam: 'DAL', awayTeam: 'PHI', score: '', period: '', elapsed: '  ', live: true }, 5)
    expect(f).toMatchObject({ score: null, scoreText: null, period: null, clock: null, status: 'in-progress' })
  })

  it('venue status words vary by league and map to three values or null', () => {
    const s = (o) => parseVenueFrame({ gameId: 1, leagueAbbreviation: 'x', ...o }, 0).status
    expect(s({ status: 'InProgress', live: true, ended: false })).toBe('in-progress')
    expect(s({ status: 'inprogress', live: true, ended: false })).toBe('in-progress')
    expect(s({ status: 'running', live: true, ended: false })).toBe('in-progress')
    expect(s({ status: 'Scheduled', live: false, ended: false })).toBe('scheduled')
    expect(s({ status: 'Final', live: false, ended: true })).toBe('ended')
    expect(s({ status: 'Canceled', live: false, ended: true })).toBeNull() // a canceled game did not end
    expect(s({ status: 'weird', live: false, ended: false })).toBeNull()
  })
})

describe('yard line (research R3): derived from the text, cross-checked against ESPN\'s own number, tested on every captured situation', () => {
  const { home, away, situations } = SITUATIONS
  it('has captured samples on both sides of the ball', () => {
    expect(situations.length).toBeGreaterThanOrEqual(6)
    expect(situations.some((s) => s.possession === home.id)).toBe(true)
    expect(situations.some((s) => s.possession === away.id)).toBe(true)
  })

  it('every captured situation derives, and the axis equals ESPN\'s numeric yardLine (0 = home goal line)', () => {
    for (const s of situations) {
      const axis = deriveYardLine(s, home, away)
      expect(axis, s.possessionText).not.toBeNull()
      expect(axis).toBe(s.yardLine)
      const sit = normalizeSituation(s, home, away)
      expect(sit.yardLine).toBe(axis)
      expect(sit.possession).toBe(s.possession === home.id ? 'home' : 'away')
      // the line to gain is `distance` yards toward the goal being attacked, and appears in the sentence's own terms
      expect(sit.lineToGain).toBe(sit.possession === 'home' ? axis + s.distance : axis - s.distance)
    }
  })

  it('own-side text maps by side: "PHI 25" (away) is 75, "DAL 41" (home) is 41, opponent-side flips', () => {
    expect(deriveYardLine({ possessionText: 'PHI 25', yardLine: 75 }, home, away)).toBe(75)
    expect(deriveYardLine({ possessionText: 'DAL 41', yardLine: 41 }, home, away)).toBe(41)
    expect(deriveYardLine({ possessionText: 'PHI 40', yardLine: 60 }, home, away)).toBe(60)
    expect(deriveYardLine({ possessionText: '50', yardLine: 50 }, home, away)).toBe(50)
  })

  it('is null — not a guess — when the two readings disagree, the team is unknown, or the text is absent', () => {
    expect(deriveYardLine({ possessionText: 'PHI 25', yardLine: 25 }, home, away)).toBeNull() // conflict
    expect(deriveYardLine({ possessionText: 'ZZZ 25', yardLine: 25 }, home, away)).toBeNull()
    expect(deriveYardLine({ yardLine: 75 }, home, away)).toBeNull()
    expect(deriveYardLine({ possessionText: '', yardLine: '' }, home, away)).toBeNull()
    expect(deriveYardLine({ possessionText: 'PHI 0', yardLine: 100 }, home, away)).toBeNull()
  })

  it('a line to gain beyond the goal line is null; between plays (nothing reported) the situation is null', () => {
    const s = normalizeSituation({ possession: away.id, possessionText: 'DAL 4', yardLine: 4, down: 1, distance: 10, downDistanceText: '1st & Goal at DAL 4' }, home, away)
    expect(s.yardLine).toBe(4)
    expect(s.lineToGain).toBeNull() // away attacks 0: 4 - 10 is off the field
    expect(normalizeSituation({}, home, away)).toBeNull()
    expect(normalizeSituation(null, home, away)).toBeNull()
  })
})

describe('matching: anything short of exactly one is not-matched', () => {
  const ev = (id, home, away, startMs = null) => ({ id, startMs, home: { code: home }, away: { code: away } })
  it('aliases are the two observed differences only', () => {
    expect(espnCode('nfl', 'was')).toBe('WSH')
    expect(espnCode('nfl', 'LA')).toBe('LAR')
    expect(espnCode('nfl', 'dal')).toBe('DAL')
    expect(espnCode('nfl', '')).toBeNull()
  })
  it('matches exactly one, refuses zero, two, swapped sides, and a start time outside +-30 min', () => {
    const events = [ev('1', 'DAL', 'PHI', 1_000_000), ev('2', 'WSH', 'KC'), ev('3', 'WSH', 'KC')]
    expect(matchEvent({ league: 'nfl', homeCode: 'DAL', awayCode: 'PHI' }, events)).toMatchObject({ state: 'matched', event: { id: '1' } })
    expect(matchEvent({ league: 'nfl', homeCode: 'WAS', awayCode: 'KC' }, events)).toEqual({ state: 'not-matched', reason: 'ambiguous' })
    expect(matchEvent({ league: 'nfl', homeCode: 'PHI', awayCode: 'DAL' }, events)).toEqual({ state: 'not-matched', reason: 'no_candidate' })
    expect(matchEvent({ league: 'nfl', homeCode: 'DAL', awayCode: 'PHI', startMs: 1_000_000 + 31 * 60_000 }, events)).toEqual({ state: 'not-matched', reason: 'no_candidate' })
    expect(matchEvent({ league: 'nfl', homeCode: 'DAL', awayCode: 'PHI', startMs: 1_000_000 + 29 * 60_000 }, events).state).toBe('matched')
    expect(matchEvent({ league: 'nfl', homeCode: null, awayCode: 'PHI' }, events)).toEqual({ state: 'not-matched', reason: 'no_team_codes' })
  })
})

describe('summary parsing', () => {
  it('orders by sequence, dedupes by id, caps at 12, and leaves side null for a drive of an unknown team', () => {
    const plays = Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), sequenceNumber: String(1000 * (i + 1)), text: `p${i}`, period: { number: 1 }, clock: { displayValue: '1:00' } }))
    const out = parseSummary({
      header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: '6' } }, { homeAway: 'away', team: { id: '21' } }] }] },
      drives: { previous: [{ team: { id: '99' }, plays: plays.slice(0, 10) }, { team: { id: '6' }, plays: plays.slice(8, 20) }] },
    })
    expect(out.plays).toHaveLength(12)
    expect(out.plays[0].id).toBe('119')
    expect(new Set(out.plays.map((p) => p.id)).size).toBe(12)
    expect(out.plays[0].side).toBe('home')
    expect(parseSummary({ drives: { previous: [{ team: { id: '99' }, plays: plays.slice(0, 2) }] } }).plays[0].side).toBeNull()
    expect(parseSummary({}).plays).toEqual([])
  })
})

describe('trust bounds', () => {
  it('are one frozen constant, venue wider than plays because the venue feed has no heartbeat', () => {
    expect(Object.isFrozen(TRUST_BOUNDS)).toBe(true)
    expect(TRUST_BOUNDS.venue.liveMs).toBeGreaterThan(TRUST_BOUNDS.plays.liveMs)
    for (const b of Object.values(TRUST_BOUNDS)) expect(b.delayedMs).toBeGreaterThan(b.liveMs)
  })
})

// ---- the event listing's game --------------------------------------------------------------------

describe('EventRow.game', () => {
  const GAMMA_GAME = {
    gameId: 19618,
    startTime: '2026-11-26T21:30:00Z',
    sport: { sport: 'nfl', ordering: 'away' },
    teams: [
      { name: 'Philadelphia Eagles', league: 'nfl', abbreviation: 'phi', alias: 'Eagles', ordering: 'away', logo: 'https://x.invalid/a.png', color: '#008282' },
      { name: 'Dallas Cowboys', league: 'nfl', abbreviation: 'dal', alias: 'Cowboys', ordering: 'home', logo: 'https://x.invalid/b.png' },
    ],
  }
  it('names the game, sides only from the venue\'s own ordering, codes upper-case, nothing else forwarded', () => {
    expect(normalizeGame(GAMMA_GAME)).toEqual({
      gameId: 19618,
      league: 'nfl',
      startTime: '2026-11-26T21:30:00Z',
      home: { name: 'Cowboys', code: 'DAL' },
      away: { name: 'Eagles', code: 'PHI' },
    })
  })
  it('is null when the event names no game, whatever else it carries', () => {
    expect(normalizeGame({ title: 'Will X happen?' })).toBeNull()
    expect(normalizeGame({ gameId: null })).toBeNull()
    expect(normalizeGame({ gameId: 0 })).toBeNull()
    expect(normalizeGame({ gameId: 'abc' })).toBeNull()
    expect(normalizeGame({ gameId: 1.5 })).toBeNull()
    expect(normalizeGame(null)).toBeNull()
  })
  it('never guesses home/away: missing, duplicated or partial ordering gives teams[] in the venue order', () => {
    const noOrder = { ...GAMMA_GAME, teams: GAMMA_GAME.teams.map(({ ordering, ...t }) => t) }
    const both = { ...GAMMA_GAME, teams: GAMMA_GAME.teams.map((t) => ({ ...t, ordering: 'home' })) }
    const one = { ...GAMMA_GAME, teams: [GAMMA_GAME.teams[0]] }
    for (const g of [normalizeGame(noOrder), normalizeGame(both)]) {
      expect(g.home).toBeUndefined()
      expect(g.away).toBeUndefined()
      expect(g.teams.map((t) => t.code)).toEqual(['PHI', 'DAL'])
    }
    expect(normalizeGame(one).teams).toHaveLength(1)
    expect(normalizeGame({ gameId: 5 })).toEqual({ gameId: 5, league: null, startTime: null, teams: [] })
  })
  it('a bad code or start time becomes null, not a guess', () => {
    const g = normalizeGame({ ...GAMMA_GAME, startTime: 'tomorrow', teams: GAMMA_GAME.teams.map((t) => ({ ...t, abbreviation: '<b>' })) })
    expect(g.startTime).toBeNull()
    expect(g.home.code).toBeNull()
  })
  it('rides every EventRow: null for a futures market, the game for a game market', () => {
    const base = { slug: 'nfl-phi-dal-2026-11-26', title: 'Eagles vs. Cowboys', markets: [] }
    expect(normalizeEvent({ ...base, ...GAMMA_GAME }).game.gameId).toBe(19618)
    expect(normalizeEvent(base).game).toBeNull()
    expect(normalizeEvent({ ...base, ...GAMMA_GAME }, { detail: true }).game.league).toBe('nfl')
  })
})
