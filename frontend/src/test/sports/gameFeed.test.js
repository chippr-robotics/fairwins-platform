/**
 * gameFeed (spec 115) — the one gateway read. Sorts every answer into ok / absent / failed and asserts on the
 * REQUEST (path, id encoding) as well as the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const gw = vi.hoisted(() => ({ url: 'http://gw.test' }))
vi.mock('../../lib/predict/predictClient', () => ({ predictGatewayUrl: () => gw.url }))

import { fetchGame, cadenceMs, pickRow, identityOf, POLL_MS, PRE_START_POLL_MS, __resetGameFeedForTests } from '../../lib/sports/gameFeed'
import { envelope, row, detail, LISTING, TEAMS_LISTING } from '../fixtures/sportsGames'

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

beforeEach(() => {
  gw.url = 'http://gw.test'
  __resetGameFeedForTests()
})

describe('cadence', () => {
  it('is 5 s in play, 30 s before the start or when unknown, and stops at ended', () => {
    expect(cadenceMs('in-progress')).toBe(POLL_MS)
    expect(POLL_MS).toBe(5000)
    expect(cadenceMs('scheduled')).toBe(PRE_START_POLL_MS)
    expect(PRE_START_POLL_MS).toBe(30_000)
    expect(cadenceMs(null)).toBe(30_000)
    expect(cadenceMs('ended')).toBeNull()
    expect(cadenceMs('other')).toBe(5000)
  })
})

describe('fetchGame', () => {
  it('asks GET /v1/sports/games/:id and nothing else', async () => {
    const f = vi.fn().mockResolvedValue(res(200, envelope(row({ detail: detail() }))))
    const out = await fetchGame(19618, { fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe('http://gw.test/v1/sports/games/19618')
    expect(out.kind).toBe('ok')
    expect(out.row.gameId).toBe(19618)
    expect(out.detail.state).toBe('read')
    expect(out.sources.venue.state).toBe('read')
  })

  it('encodes the id into the path', async () => {
    const f = vi.fn().mockResolvedValue(res(404, {}))
    await fetchGame('a/b?c', { fetchImpl: f })
    expect(f.mock.calls[0][0]).toBe('http://gw.test/v1/sports/games/a%2Fb%3Fc')
  })

  it('the envelope is pinned: a bare row as the whole body is a failure, not a game', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { serverNow: 5, ...row() }))
    expect((await fetchGame(19618, { fetchImpl: f })).kind).toBe('failed')
  })

  it('sends the listing\'s identity as query params, omitting any that is null', async () => {
    const f = vi.fn().mockResolvedValue(res(500, {}))
    await fetchGame(19618, { identity: identityOf(LISTING), fetchImpl: f })
    const u = new URL(f.mock.calls[0][0])
    expect(u.pathname).toBe('/v1/sports/games/19618')
    expect(Object.fromEntries(u.searchParams)).toEqual({ league: 'nfl', home: 'DAL', away: 'PHI', start: '2026-11-26T21:30:00Z' })
    await fetchGame(1, { identity: identityOf({ ...LISTING, startTime: null }), fetchImpl: f })
    expect(Object.fromEntries(new URL(f.mock.calls[1][0]).searchParams)).toEqual({ league: 'nfl', home: 'DAL', away: 'PHI' })
    await fetchGame(1, { fetchImpl: f })
    expect(f.mock.calls[2][0]).toBe('http://gw.test/v1/sports/games/1')
  })

  it('identityOf sends NONE for a teams-only listing, a missing listing, or a malformed code', () => {
    expect(identityOf(TEAMS_LISTING)).toEqual({})
    expect(identityOf(null)).toEqual({})
  })

  it('a PARTIAL identity sends none of league/home/away, and start is never sent alone (the gateway answers 400)', () => {
    expect(identityOf({ ...LISTING, home: { code: 'dal' } })).toEqual({})
    expect(identityOf({ ...LISTING, away: { name: 'Eagles', code: null } })).toEqual({})
    expect(identityOf({ ...LISTING, home: null })).toEqual({})
    expect(identityOf({ ...LISTING, league: null })).toEqual({})
    expect(identityOf({ ...LISTING, league: '' })).toEqual({})
    expect(identityOf({ gameId: 1, startTime: LISTING.startTime })).toEqual({})
  })

  it.each([
    ['sports_unconfigured', 503],
    ['sports_paused', 503],
    ['killswitch_active', 503],
  ])('503 error.code %s is absent', async (code, status) => {
    const f = vi.fn().mockResolvedValue(res(status, { error: { code, reason: 'x' } }))
    expect((await fetchGame(1, { fetchImpl: f })).kind).toBe('absent')
  })

  it('404 is absent (a gateway that predates the module)', async () => {
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockResolvedValue(res(404, {})) })).kind).toBe('absent')
  })

  it('a bare 503, a 503 with another code, a 429, a 500, a transport error and a non-game body are FAILED, not absent', async () => {
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockResolvedValue({ status: 503, ok: false, json: async () => { throw new Error('x') } }) })).kind).toBe('failed')
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockResolvedValue(res(503, { error: { code: 'upstream_unavailable' } })) })).kind).toBe('failed')
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockResolvedValue(res(429, { error: { code: 'quota_exceeded' } })) })).kind).toBe('failed')
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockResolvedValue(res(500, {})) })).kind).toBe('failed')
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockRejectedValue(new Error('net')) })).kind).toBe('failed')
    expect((await fetchGame(19618, { fetchImpl: vi.fn().mockResolvedValue(res(200, { games: [] })) })).kind).toBe('failed')
    expect((await fetchGame(19618, { fetchImpl: vi.fn().mockResolvedValue(res(200, { games: [row()] })) })).kind).toBe('failed') // no serverNow
  })

  it('with no gateway configured nothing is requested (SC-006)', async () => {
    gw.url = ''
    const f = vi.fn()
    expect((await fetchGame(1, { fetchImpl: f })).kind).toBe('absent')
    expect(f).not.toHaveBeenCalled()
  })

  it('pickRow finds the requested id and no other', () => {
    expect(pickRow({ games: [row({ gameId: 2 }), row({ gameId: 3 })] }, 3).gameId).toBe(3)
    expect(pickRow({ games: [row({ gameId: 2 })] }, 3)).toBeNull()
  })
})

describe('one request when the module is off (FR-013)', () => {
  const okBody = () => envelope(row())

  it('two reads of the same game at once share ONE request (StrictMode mounts an effect twice)', async () => {
    let release
    const f = vi.fn(() => new Promise((r) => { release = () => r(res(200, okBody())) }))
    const a = fetchGame(19618, { fetchImpl: f })
    const b = fetchGame(19618, { fetchImpl: f })
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(f).toHaveBeenCalledTimes(1)
    expect(ra.kind).toBe('ok')
    expect(rb).toBe(ra)
    // ...and the next read, after it finished, is a new request
    await fetchGame(19618, { fetchImpl: vi.fn().mockResolvedValue(res(200, okBody())) })
  })

  it('a gateway without the module is remembered: no later page asks at all', async () => {
    const f = vi.fn().mockResolvedValue(res(503, { error: { code: 'sports_unconfigured' } }))
    expect((await fetchGame(1, { fetchImpl: f })).kind).toBe('absent')
    expect((await fetchGame(2, { fetchImpl: f })).kind).toBe('absent')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a 404 from a gateway that predates the module is remembered too', async () => {
    const f = vi.fn().mockResolvedValue(res(404, {}))
    await fetchGame(1, { fetchImpl: f })
    await fetchGame(2, { fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a PAUSE is not remembered: it is lifted without a deploy, so the next page view asks', async () => {
    for (const code of ['sports_paused', 'killswitch_active']) {
      __resetGameFeedForTests()
      const f = vi.fn().mockResolvedValue(res(503, { error: { code } }))
      expect((await fetchGame(1, { fetchImpl: f })).kind).toBe('absent')
      expect((await fetchGame(1, { fetchImpl: f })).kind).toBe('absent')
      expect(f).toHaveBeenCalledTimes(2)
    }
  })

  it('an outage is never remembered as "off"', async () => {
    const f = vi.fn().mockResolvedValue(res(503, { error: { code: 'upstream_unavailable' } }))
    await fetchGame(1, { fetchImpl: f })
    await fetchGame(1, { fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(2)
  })
})

