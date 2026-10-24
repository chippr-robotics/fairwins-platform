/**
 * The wagmi rail + the disclosure surface (spec 107, #1470/#1471).
 *
 * #1470's property: RETARGETING HAPPENS PER REQUEST. Transports are built at module evaluation,
 * before anything can have been minted, so a URL baked at build time would be stale forever. The
 * fetchFn consults the store on every call — which also means rotation swaps tokens with no
 * transport rebuild, and losing the credential falls back to the viem-resolved URL mid-flight.
 *
 * #1471's property: FOUR OF THE FIVE STATES ARE SILENCE. Only `degraded` (issuance TRIED and
 * FAILED) earns a sentence. A `declined` chain — the gateway said 404, no keyed endpoint exists —
 * is NORMAL and renders nothing: ETC and Mordor reading public capacity is their correct
 * permanent state, and apologising for it would be the false-degradation twin of the false zero.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ensureIssuedAccess,
  issuedFetchFor,
  issuedAccessState,
  __resetIssuedAccessForTests,
} from '../../lib/network/issuedAccess'
import { useIssuedAccessDisclosure } from '../../hooks/useIssuedAccessDisclosure'

const ISSUED_URL = 'https://issued.example.quiknode.pro'
const ok = (over = {}) => ({
  ok: true, status: 200,
  json: async () => ({
    endpoint: ISSUED_URL, credential: 'jwt-live',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    permits: ['eth_call'], tier: 'anonymous', keyId: 'k1', ...over,
  }),
})
const mint = async (chainId, impl) => {
  ensureIssuedAccess(chainId, { fetchImpl: impl })
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  __resetIssuedAccessForTests()
  vi.stubEnv('VITE_RELAYER_URL', 'https://relay.example')
  // The background mint inside issuedFetchFor uses GLOBAL fetch (deliberately not the injected
  // transport fetch — see the lib). Stub it so no test ever touches a network; a 503 here just
  // means "nothing gets issued", which is exactly the state the pass-through tests want.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
})

describe('issuedFetchFor — the wagmi rail (#1470)', () => {
  it('passes through untouched while nothing is issued', async () => {
    const calls = []
    const impl = vi.fn(async (url, init) => { calls.push({ url, init }); return ok() })
    const fetchFn = issuedFetchFor(137, { fetchImpl: impl })
    await fetchFn('https://public.example/rpc', { method: 'POST', body: '{}' })
    // First call went to the PUBLIC url (nothing issued yet)…
    expect(calls[0].url).toBe('https://public.example/rpc')
    expect(new Headers(calls[0].init?.headers || {}).get('authorization')).toBeNull()
  })

  it('retargets to the issued endpoint with the token, PER REQUEST', async () => {
    const impl = vi.fn(async () => ok())
    await mint(137, impl)
    const rpcCalls = []
    const rpcImpl = vi.fn(async (url, init) => { rpcCalls.push({ url, init }); return { ok: true, json: async () => ({}) } })
    const fetchFn = issuedFetchFor(137, { fetchImpl: rpcImpl })
    await fetchFn('https://public.example/rpc', { method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(rpcCalls[0].url).toBe(ISSUED_URL)
    expect(new Headers(rpcCalls[0].init.headers).get('authorization')).toBe('Bearer jwt-live')
    // …and the original content-type survived the header merge.
    expect(new Headers(rpcCalls[0].init.headers).get('content-type')).toBe('application/json')
  })

  it('falls back to the viem-resolved URL the moment the credential is gone', async () => {
    const impl = vi.fn(async () => ok({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
    await mint(137, impl)
    const rpcCalls = []
    const fetchFn = issuedFetchFor(137, { fetchImpl: vi.fn(async (url) => { rpcCalls.push(url); return ok() }) })
    await fetchFn('https://public.example/rpc', {})
    expect(rpcCalls[0]).toBe('https://public.example/rpc') // expired reads as absent, honestly
  })

  it('never sends the token to the public URL', async () => {
    // The retarget and the header are one decision: token WITH issued URL, or neither.
    const impl = vi.fn(async () => ok())
    await mint(137, impl)
    const seen = []
    const fetchFn = issuedFetchFor(1, { fetchImpl: vi.fn(async (url, init) => { seen.push({ url, init }); return ok() }) })
    await fetchFn('https://public.example/rpc', {}) // chain 1 has nothing issued
    expect(seen.some((c) => new Headers(c.init?.headers || {}).get('authorization'))).toBe(false)
  })
})

describe('issuedAccessState — five states (#1471)', () => {
  it('dormant with no gateway configured', () => {
    vi.stubEnv('VITE_RELAYER_URL', '')
    expect(issuedAccessState(137)).toBe('dormant')
  })

  it('acquiring before anything has settled, active once minted', async () => {
    expect(issuedAccessState(137)).toBe('acquiring')
    await mint(137, vi.fn(async () => ok()))
    expect(issuedAccessState(137)).toBe('active')
  })

  it('DECLINED on a 404 — normal, permanent, not a degradation', async () => {
    await mint(63, vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    expect(issuedAccessState(63)).toBe('declined')
  })

  it('DEGRADED on an outage — the one state worth a sentence', async () => {
    await mint(137, vi.fn(async () => { throw new Error('gateway down') }))
    expect(issuedAccessState(137)).toBe('degraded')
  })
})

function Probe({ chainIds }) {
  const { names } = useIssuedAccessDisclosure(chainIds)
  return names.length ? <p role="status" data-testid="issued-access-degraded">{names.join(', ')}</p> : <p data-testid="silent">ok</p>
}

describe('useIssuedAccessDisclosure — silence discipline', () => {
  it('says nothing for declined, dormant-adjacent and healthy chains', async () => {
    await mint(63, vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    await mint(137, vi.fn(async () => ok()))
    render(<Probe chainIds={[137, 63, 1]} />)
    expect(screen.getByTestId('silent')).toBeInTheDocument()
  })

  it('names EXACTLY the degraded chains, as a status, not an alert', async () => {
    await mint(137, vi.fn(async () => { throw new Error('down') }))
    await mint(63, vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    render(<Probe chainIds={[137, 63]} />)
    const el = screen.getByTestId('issued-access-degraded')
    expect(el).toHaveTextContent('Polygon')
    expect(el).not.toHaveTextContent('Mordor') // declined stays silent even beside a degradation
    expect(el.getAttribute('role')).toBe('status') // perceivable, never an alarm
  })
})
