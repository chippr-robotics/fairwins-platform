/**
 * Tool executor (spec 104) — every exec kind, bound to a fake gateway and the real nav index.
 *
 * What is asserted: a `route` tool never fires without the grant and puts the grant in a header; a
 * `public` tool substitutes only the parameters the table names and refuses an unsafe segment;
 * `find_in_app` returns REAL index paths with focus markers and says in words when nothing matched;
 * and nothing — not a thrown error, not a bad table entry — ever escapes as a rejection.
 */
import { describe, it, expect, vi } from 'vitest'
import { TOOL_DEFS, toolDef } from '@fairwins/assistant-contract'
import {
  FIND_IN_APP_EMPTY_NOTE,
  FIND_IN_APP_LIMIT,
  PATH_PARAM_DEFAULTS,
  ROUTE_PATHS,
  executeTool,
  findInApp,
} from '../../lib/assistant/tools/executor'
import { hangingFetch, response } from './helpers/http'

const BASE = 'https://relay.example'
const TOKEN = 'fw1.grant.sig'

const run = (name, input, extra = {}) =>
  executeTool({ def: toolDef(name), input, relayerBase: BASE, fetchImpl: vi.fn().mockResolvedValue(response(200, { fine: true })), timeoutMs: 50, ...extra })

describe('route tools (grant)', () => {
  it('maps every route id the table uses to a gateway path', () => {
    for (const def of TOOL_DEFS.filter((d) => d.exec.kind === 'route')) {
      expect(ROUTE_PATHS[def.exec.route], `route ${def.exec.route}`).toMatch(/^\/v1\/member\//)
    }
  })

  it('refuses without the grant, before any request, with the sentence the panel renders', async () => {
    const fetchImpl = vi.fn()
    const result = await run('get_wagers', {}, { fetchImpl, sessionToken: null })
    expect(result).toEqual({
      ok: false,
      error: { code: 'no_grant', reason: 'sign the 24-hour read grant to let the assistant read your own data', retryAfterSec: null },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('GETs the route with the grant in a header and only the listed query keys', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { chains: [] }))
    const result = await run('get_wagers', { chainId: 137, first: 5, evil: 'x', account: '0xother' }, { fetchImpl, sessionToken: TOKEN })
    expect(result).toEqual({ ok: true, value: { chains: [] } })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE}/v1/member/wagers?chainId=137&first=5`)
    expect(options.method).toBe('GET')
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(url).not.toContain(TOKEN)
  })

  it('sends no query string for a tool without inputs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { tier: 2 }))
    await run('get_membership', { chainId: 1 }, { fetchImpl, sessionToken: TOKEN })
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/v1/member/membership`)
  })

  it('returns the gateway’s own nested error on a non-2xx, with Retry-After', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(429, { error: { code: 'quota_exceeded', reason: 'too many reads' } }, { 'Retry-After': '30' }))
    await expect(run('get_fees', {}, { fetchImpl, sessionToken: TOKEN })).resolves.toEqual({
      ok: false,
      error: { code: 'quota_exceeded', reason: 'too many reads', retryAfterSec: 30 },
    })
  })

  it('names an HTTP status when the gateway sent no error envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(502, undefined))
    await expect(run('get_profile', {}, { fetchImpl, sessionToken: TOKEN })).resolves.toMatchObject({ ok: false, error: { code: 'http_502' } })
  })

  it('reports unreachable and timeout as results, not rejections', async () => {
    await expect(run('get_profile', {}, { fetchImpl: vi.fn().mockRejectedValue(new Error('down')), sessionToken: TOKEN })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unreachable' },
    })
    await expect(run('get_profile', {}, { fetchImpl: hangingFetch(), sessionToken: TOKEN })).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } })
  })

  it('reports an unset gateway as a result', async () => {
    await expect(run('get_profile', {}, { relayerBase: '', sessionToken: TOKEN })).resolves.toMatchObject({ ok: false, error: { code: 'relayer_unset' } })
  })
})

describe('public tools (no auth)', () => {
  it('sends no Authorization header and substitutes the default chain', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { markets: [] }))
    await run('get_prediction_markets', { q: 'election' }, { fetchImpl, sessionToken: TOKEN })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE}/v1/polymarket/${PATH_PARAM_DEFAULTS.chainId}/markets?q=election`)
    expect(options.headers.Authorization).toBeUndefined()
  })

  it('substitutes a supplied path parameter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, {}))
    await run('get_prediction_markets', { chainId: 137, next: 'abc' }, { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/v1/polymarket/137/markets?next=abc`)
  })

  it('refuses a path parameter that is not a single safe segment', async () => {
    const fetchImpl = vi.fn()
    await expect(run('get_prediction_markets', { chainId: '../member/keys' }, { fetchImpl })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    await expect(run('get_prediction_markets', { chainId: '137?x=1' }, { fetchImpl })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads /status and /v1/perps/pairs without a token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { status: 'ok' }))
    await run('get_gateway_status', {}, { fetchImpl })
    await run('get_perps_pairs', {}, { fetchImpl })
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([`${BASE}/status`, `${BASE}/v1/perps/pairs`])
  })
})

describe('find_in_app (local)', () => {
  it('returns real index hits with focus markers, no network, no token', async () => {
    const fetchImpl = vi.fn()
    const result = await run('find_in_app', { query: 'morpho' }, { fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.value.note).toBeNull()
    const lend = result.value.hits.find((h) => h.id === 'earn-lend')
    expect(lend).toEqual({
      id: 'earn-lend',
      label: 'Lend',
      summary: 'Deposit into a Morpho vault and earn interest.',
      path: '/wallet?tab=earn&view=lend&focus=earn-lend',
      navId: 'earn',
    })
  })

  it('finds off-menu items by their synonyms ("rpc" → Network)', () => {
    const { hits } = findInApp('rpc')
    expect(hits.some((h) => h.navId === 'network')).toBe(true)
    const network = hits.find((h) => h.id === 'network')
    if (network) expect(network.path).toBe('/wallet?tab=network')
  })

  it('finds a nav item by its own label and routes to its section', () => {
    const { hits } = findInApp('protect')
    expect(hits[0]).toMatchObject({ id: 'custody', navId: 'custody', path: '/wallet?tab=custody' })
  })

  it('caps the hit list', () => {
    const { hits } = findInApp('a') // a broad prefix
    expect(hits.length).toBeLessThanOrEqual(FIND_IN_APP_LIMIT)
  })

  it('says in words when nothing matched — a fact about the local index, not a failure', async () => {
    const result = await run('find_in_app', { query: 'xyzzyplughquux' })
    expect(result).toEqual({ ok: true, value: { query: 'xyzzyplughquux', hits: [], note: FIND_IN_APP_EMPTY_NOTE } })
    expect(FIND_IN_APP_EMPTY_NOTE).toMatch(/not a network failure/)
  })

  it('treats a missing or non-string query as nothing matched', async () => {
    await expect(run('find_in_app', {})).resolves.toMatchObject({ ok: true, value: { hits: [] } })
    await expect(run('find_in_app', { query: 42 })).resolves.toMatchObject({ ok: true, value: { hits: [] } })
    await expect(run('find_in_app', null)).resolves.toMatchObject({ ok: true, value: { hits: [] } })
  })
})

describe('nothing escapes', () => {
  it('turns an unknown or malformed definition into a result', async () => {
    await expect(executeTool({ def: null, input: {}, relayerBase: BASE })).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
    await expect(executeTool({ def: { name: 'x', exec: { kind: 'teleport' } }, input: {}, relayerBase: BASE })).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
    await expect(executeTool({ def: { name: 'x', exec: { kind: 'local' } }, input: {}, relayerBase: BASE })).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
    await expect(executeTool({ def: { name: 'x', exec: { kind: 'route', route: 'keys' } }, input: {}, relayerBase: BASE, sessionToken: TOKEN })).resolves.toMatchObject({ ok: false, error: { code: 'unknown_route' } })
    await expect(executeTool({ def: { name: 'x', exec: { kind: 'public', method: 'POST', path: '/x' } }, input: {}, relayerBase: BASE })).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
    await expect(executeTool({ def: { name: 'x', exec: { kind: 'public', method: 'GET', path: 'https://evil.example/x' } }, input: {}, relayerBase: BASE })).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
  })

  it('turns a thrown exception into tool_failed without its text', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('secret 0xdeadbeef exploded')
    })
    const result = await run('get_gateway_status', {}, { fetchImpl })
    expect(result.ok).toBe(false)
    expect(['unreachable', 'tool_failed']).toContain(result.error.code)
    expect(JSON.stringify(result)).not.toContain('0xdeadbeef')

    const bad = await executeTool({
      def: { name: 'get_gateway_status', exec: { kind: 'public', method: 'GET', path: '/status' } },
      input: {},
      relayerBase: BASE,
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 200, headers: null, json: () => { throw new Error('0xdeadbeef') } }),
    })
    expect(bad).toMatchObject({ ok: false })
    expect(JSON.stringify(bad)).not.toContain('0xdeadbeef')
  })
})
