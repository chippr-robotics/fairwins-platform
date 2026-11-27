/**
 * gameFeed (spec 115) — the one gateway read. Sorts every answer into ok / absent / failed and asserts on the
 * REQUEST (path, id encoding) as well as the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const gw = vi.hoisted(() => ({ url: 'http://gw.test' }))
vi.mock('../../lib/predict/predictClient', () => ({ predictGatewayUrl: () => gw.url }))

import { fetchGame, cadenceMs, pickRow, POLL_MS, PRE_START_POLL_MS } from '../../lib/sports/gameFeed'
import { envelope, row, detail } from '../fixtures/sportsGames'

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

beforeEach(() => {
  gw.url = 'http://gw.test'
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

  it('accepts the row as the whole body, too (the contract does not pin the single-game shape)', async () => {
    const f = vi.fn().mockResolvedValue(res(200, { serverNow: 5, ...row() }))
    expect((await fetchGame(19618, { fetchImpl: f })).kind).toBe('ok')
  })

  it.each([
    ['sports_unconfigured', 503],
    ['sports_paused', 503],
  ])('503 %s is absent', async (code, status) => {
    const f = vi.fn().mockResolvedValue(res(status, { error: code }))
    expect((await fetchGame(1, { fetchImpl: f })).kind).toBe('absent')
  })

  it('404 is absent (a gateway that predates the module)', async () => {
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockResolvedValue(res(404, {})) })).kind).toBe('absent')
  })

  it('a bare 503, a 500, a transport error and a non-game body are FAILED, not absent', async () => {
    expect((await fetchGame(1, { fetchImpl: vi.fn().mockResolvedValue({ status: 503, ok: false, json: async () => { throw new Error('x') } }) })).kind).toBe('failed')
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
