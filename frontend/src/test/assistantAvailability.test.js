/**
 * "The assistant service could not be reached" must not be said when the truth is knowable.
 *
 * Reported 2026-08-26 on fairwins.app. Measured against the live gateway that day:
 *
 *   GET  /status                        200, and NO `memberApi` block
 *   POST /v1/member/assistant/chat      404 (Express default handler)
 *   the 404 advertises                  Access-Control-Allow-Headers: Content-Type
 *
 * The chat request must send `Authorization`, which is not CORS-safelisted, so it needs a
 * preflight — and that allow-list does not permit it. The browser rejects the preflight, `fetch`
 * throws, and the SPA reported a network failure for what was really "this deployment does not
 * offer the member API". Those need different actions from the reader, so they must read
 * differently.
 *
 * `/status` is unauthenticated, sends no `Authorization`, needs no preflight, and every gateway
 * build serves it — so it can answer where the chat request cannot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { probeAssistantAvailability } from '../lib/assistant/assistantClient'

const BASE = 'https://relay.example.test'

/** The live gateway's /status on the day of the report, trimmed to what the probe reads. */
const STATUS_WITHOUT_MODULE = {
  status: 'ok',
  chains: { 137: { rpc: 'up' } },
  killSwitch: false,
  perps: { enabled: true },
}
const statusWith = (memberApi) => ({ ...STATUS_WITHOUT_MODULE, memberApi })

function mockStatus(body, { ok = true, throws = false } = {}) {
  globalThis.fetch = vi.fn(async () => {
    if (throws) throw new TypeError('Failed to fetch')
    return { ok, json: async () => body }
  })
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
beforeEach(() => {
  vi.restoreAllMocks()
})

describe('probeAssistantAvailability names what is actually wrong', () => {
  it('a gateway with no memberApi block is NOT OFFERED HERE, not unreachable', async () => {
    mockStatus(STATUS_WITHOUT_MODULE)
    const err = await probeAssistantAvailability(BASE)
    expect(err).toBeTruthy()
    expect(err.state).toBe('unconfigured')
    expect(err.code).toBe('member_api_absent')
    // The member is told the service IS reachable — so they stop debugging their connection.
    expect(err.message).toMatch(/reachable/i)
    expect(err.message).toMatch(/does not offer/i)
  })

  it('the module present but disabled says so', async () => {
    mockStatus(statusWith({ enabled: false, killSwitch: false, assistant: { configured: true } }))
    const err = await probeAssistantAvailability(BASE)
    expect(err.state).toBe('unconfigured')
    expect(err.code).toBe('member_api_unconfigured')
    expect(err.message).toMatch(/not enabled on this deployment/i)
  })

  it('a killswitch reads as switched off right now, not as never offered', async () => {
    mockStatus(statusWith({ enabled: false, killSwitch: true, assistant: { configured: true } }))
    const err = await probeAssistantAvailability(BASE)
    expect(err.message).toMatch(/switched off/i)
    // "right now" matters: this one is expected to come back, the others are not.
    expect(err.message).toMatch(/right now/i)
  })

  it('an enabled module with no model credential says THAT, not "unreachable"', async () => {
    mockStatus(statusWith({ enabled: true, killSwitch: false, assistant: { configured: false } }))
    const err = await probeAssistantAvailability(BASE)
    expect(err.code).toBe('assistant_unconfigured')
    expect(err.message).toMatch(/no model provider configured/i)
  })

  it('a healthy module returns null — the transport failure really was the transport', async () => {
    mockStatus(statusWith({ enabled: true, killSwitch: false, assistant: { configured: true } }))
    expect(await probeAssistantAvailability(BASE)).toBeNull()
  })

  it('an unreadable /status returns null, so the original "unreachable" stands', async () => {
    // The probe must never manufacture a diagnosis. If it cannot read the gateway either, then
    // "could not be reached" is the honest answer rather than a guess.
    mockStatus(null, { throws: true })
    expect(await probeAssistantAvailability(BASE)).toBeNull()

    mockStatus({}, { ok: false })
    expect(await probeAssistantAvailability(BASE)).toBeNull()

    mockStatus(null)
    expect(await probeAssistantAvailability(BASE)).toBeNull()
  })

  it('reads /status, and sends no Authorization header with it', async () => {
    // The point of using /status is that it needs no preflight. Adding a credential here would
    // reintroduce exactly the preflight that made the chat request unreadable.
    mockStatus(statusWith({ enabled: true, killSwitch: false, assistant: { configured: true } }))
    await probeAssistantAvailability(BASE)
    const [url, options] = globalThis.fetch.mock.calls[0]
    expect(url).toBe(`${BASE}/status`)
    expect(options?.headers).toBeUndefined()
  })
})
