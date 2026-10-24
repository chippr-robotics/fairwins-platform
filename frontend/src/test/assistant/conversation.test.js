/**
 * runAssistantTurn (spec 104) — the two rails through one loop.
 *
 * Asserted: the FairWins rail sends NO `tools` field (the gateway attaches its own); the GutterToken
 * rail sends the contract's tools and system prompt, narrowed when there is no grant; the surface
 * rides as a trailing block on the last user message and never in the system text; the thread is
 * bounded to MAX_MESSAGES text turns; an empty final answer is a named error; and a tool round on
 * either rail executes in the browser and feeds back one result message.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ethers } from 'ethers'
import { MAX_MESSAGES, TOOL_DEFS, buildSystemPrompt, surfaceNote } from '@fairwins/assistant-contract'
import { __resetAssistantSessionForTests, authorizeSession, sessionToken } from '../../lib/assistant/assistantClient'
import { __resetGutterTokenKeyForTests, saveGutterTokenKey } from '../../lib/assistant/guttertokenKeyStore'
import { buildBaseMessages, runAssistantTurn } from '../../lib/assistant/conversation'
import { response } from './helpers/http'

/**
 * Whether a mock-fetch URL targets GutterToken. CodeQL is right that a bare
 * `startsWith('https://api.guttertokens.com')` admits hosts like
 * api.guttertokens.com.evil.example even in a test double, so compare the
 * parsed ORIGIN — the same discipline the shipped transport gets for free by
 * only ever building its own URL.
 */
const isGutterTokenUrl = (url) => new URL(url).origin === 'https://api.guttertokens.com'


const BASE = 'https://relay.example'
const KEY = 'sk-gt-0123456789abcdefghijklmnopqrstuvwxyz'
const THREAD = [
  { role: 'user', content: 'hi', at: 1 },
  { role: 'assistant', content: 'hello', at: 2 },
  { role: 'user', content: 'where is earn?', at: 3 },
]

let wallet
let account
const signWith = (w) => (domain, types, message) => w.signTypedData(domain, types, message)

const text = (t) => ({ type: 'text', text: t })
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input })

/** GutterToken upstream answer. */
const gt = (content, stop_reason = 'end_turn') => response(200, { model: 'claude-opus-5', stop_reason, content, usage: { input_tokens: 3, output_tokens: 2 } })
/** Gateway answer, spec-104 shape. */
const gw = (content, stopReason = 'end_turn') => response(200, { model: 'claude-sonnet-5', stopReason, content, usage: { inputTokens: 3, outputTokens: 2 } })

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  __resetAssistantSessionForTests()
  __resetGutterTokenKeyForTests()
  wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  account = wallet.address
})

async function authorize() {
  await authorizeSession({ account, sign: signWith(wallet), now: Math.floor(Date.now() / 1000) })
  return sessionToken(account)
}

describe('buildBaseMessages', () => {
  it('keeps the last MAX_MESSAGES text turns, opening on the member, and appends the surface as a trailing block', () => {
    const long = Array.from({ length: 31 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
    const messages = buildBaseMessages(long, '/wallet?tab=earn')
    expect(messages.length).toBeLessThanOrEqual(MAX_MESSAGES)
    expect(messages[0].role).toBe('user')
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toEqual([text('m30'), text(surfaceNote('/wallet?tab=earn'))])
    // 31 turns → the last 20 open on an assistant turn, which is dropped → 19.
    expect(messages).toHaveLength(MAX_MESSAGES - 1)
    expect(messages[0].content).toBe('m12')
    // Only the last user turn carries blocks; everything else stays a plain string.
    for (const m of messages.slice(0, -1)) expect(typeof m.content).toBe('string')
  })

  it('leaves the last turn a plain string when there is no surface', () => {
    const messages = buildBaseMessages(THREAD, null)
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'where is earn?' },
    ])
  })

  it('drops non-text turns and refuses a thread that does not end on the member', () => {
    expect(buildBaseMessages([{ role: 'user', content: 'q' }, { role: 'user', content: [text('blocks')] }], null)).toEqual([{ role: 'user', content: 'q' }])
    expect(() => buildBaseMessages([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], null)).toThrow(expect.objectContaining({ state: 'rejected', code: 'no_prompt' }))
    expect(() => buildBaseMessages([], null)).toThrow(expect.objectContaining({ code: 'no_prompt' }))
  })
})

describe('FairWins rail', () => {
  it('sends the thread with the surface block and NO tools field, and returns the text', async () => {
    const token = await authorize()
    const fetchImpl = vi.fn().mockResolvedValue(gw([text('Earn is at /wallet?tab=earn')]))
    const result = await runAssistantTurn({ account, provider: 'fairwins', thread: THREAD, surface: '/app', sessionToken: token, relayerBase: BASE, fetchImpl })

    expect(result).toEqual({ reply: 'Earn is at /wallet?tab=earn', model: 'claude-sonnet-5', usage: { inputTokens: 3, outputTokens: 2 }, toolEvents: [], roundsExhausted: false })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE}/v1/member/assistant/chat`)
    expect(options.headers.Authorization).toBe(`Bearer ${token}`)
    const body = JSON.parse(options.body)
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('system')
    expect(body).not.toHaveProperty('surface')
    expect(body.messages[2].content).toEqual([text('where is earn?'), text(surfaceNote('/app'))])
  })

  it('reads the legacy flat { reply } gateway shape', async () => {
    const token = await authorize()
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { reply: 'plain', model: 'm', usage: {} }))
    await expect(runAssistantTurn({ account, provider: 'fairwins', thread: THREAD, sessionToken: token, relayerBase: BASE, fetchImpl })).resolves.toMatchObject({ reply: 'plain' })
  })

  it('executes a tool round in the browser against the same gateway and feeds one result message back', async () => {
    const token = await authorize()
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/v1/member/assistant/chat')) {
        return fetchImpl.mock.calls.filter((c) => c[0].endsWith('/assistant/chat')).length === 1
          ? gw([text('Checking.'), use('t1', 'get_membership'), use('t2', 'find_in_app', { query: 'morpho' })], 'tool_use')
          : gw([text('You are Gold. Lend is at /wallet?tab=earn&view=lend&focus=earn-lend')])
      }
      if (url.endsWith('/v1/member/membership')) return response(200, { tier: 3, tierName: 'Gold' })
      throw new Error(`unexpected ${url}`)
    })
    const events = []
    const result = await runAssistantTurn({ account, provider: 'fairwins', thread: THREAD, sessionToken: token, relayerBase: BASE, fetchImpl, onToolEvent: (e) => events.push(e) })

    expect(result.reply).toContain('You are Gold')
    expect(result.roundsExhausted).toBe(false)
    expect(events.filter((e) => e.phase === 'done').map((e) => [e.name, e.ok])).toEqual(expect.arrayContaining([['get_membership', true], ['find_in_app', true]]))

    const chatCalls = fetchImpl.mock.calls.filter((c) => c[0].endsWith('/assistant/chat'))
    expect(chatCalls).toHaveLength(2)
    const second = JSON.parse(chatCalls[1][1].body)
    expect(second).not.toHaveProperty('tools')
    expect(second.messages).toHaveLength(5)
    expect(second.messages[3].role).toBe('assistant')
    expect(second.messages[4].role).toBe('user')
    expect(second.messages[4].content.map((b) => [b.type, b.tool_use_id, b.is_error])).toEqual([['tool_result', 't1', false], ['tool_result', 't2', false]])
    expect(JSON.parse(second.messages[4].content[0].content)).toEqual({ tier: 3, tierName: 'Gold' })
    expect(JSON.parse(second.messages[4].content[1].content).hits[0].path).toContain('focus=')

    const membershipCall = fetchImpl.mock.calls.find((c) => c[0].endsWith('/v1/member/membership'))
    expect(membershipCall[1].headers.Authorization).toBe(`Bearer ${token}`)
  })

  it('surfaces the gateway’s error states unchanged', async () => {
    await authorize()
    const fetchImpl = vi.fn().mockResolvedValue(response(503, { error: { code: 'assistant_unconfigured', reason: 'off' } }))
    await expect(runAssistantTurn({ account, provider: 'fairwins', thread: THREAD, relayerBase: BASE, fetchImpl })).rejects.toMatchObject({ state: 'unconfigured' })
  })
})

describe('GutterToken rail', () => {
  it('sends the contract’s system prompt and the FULL tool set with a grant, surface as a trailing block', async () => {
    saveGutterTokenKey(account, KEY)
    const fetchImpl = vi.fn().mockResolvedValue(gt([text('answer')]))
    const result = await runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, surface: '/wallet?tab=settings', sessionToken: 'fw1.x.y', relayerBase: BASE, fetchImpl })

    expect(result).toEqual({ reply: 'answer', model: 'claude-opus-5', usage: { inputTokens: 3, outputTokens: 2 }, toolEvents: [], roundsExhausted: false })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.guttertokens.com/v1/messages')
    expect(options.headers.Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(options.body)
    expect(body.system).toBe(buildSystemPrompt({ rail: 'guttertoken', hasMemberTools: true }))
    expect(body.system).not.toContain('/wallet?tab=settings')
    expect(body.tools.map((t) => t.name)).toEqual(TOOL_DEFS.map((t) => t.name))
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(body.messages[2].content).toEqual([text('where is earn?'), text(surfaceNote('/wallet?tab=settings'))])
  })

  it('narrows to the public + local tools and the no-grant prompt when there is no session grant', async () => {
    saveGutterTokenKey(account, KEY)
    const fetchImpl = vi.fn().mockResolvedValue(gt([text('answer')]))
    await runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, sessionToken: null, relayerBase: BASE, fetchImpl })
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.system).toBe(buildSystemPrompt({ rail: 'guttertoken', hasMemberTools: false }))
    expect(body.tools.map((t) => t.name)).toEqual(TOOL_DEFS.filter((t) => t.auth !== 'grant').map((t) => t.name))
  })

  it('throws key_missing before any request when the rail is chosen and no key is saved', async () => {
    const fetchImpl = vi.fn()
    await expect(runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl })).rejects.toMatchObject({ state: 'key_missing' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers a member-data tool_use without a grant as an is_error result naming the grant, then returns the model’s text', async () => {
    saveGutterTokenKey(account, KEY)
    const fetchImpl = vi.fn(async (url) => {
      if (!isGutterTokenUrl(url)) throw new Error(`unexpected ${url}`)
      return fetchImpl.mock.calls.length === 1
        ? gt([use('t1', 'get_wagers', { first: 2 })], 'tool_use')
        : gt([text('I could not read your wagers without the read grant.')])
    })
    const events = []
    const result = await runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, sessionToken: null, relayerBase: BASE, fetchImpl, onToolEvent: (e) => events.push(e) })
    expect(result.reply).toContain('read grant')
    expect(events.at(-1)).toEqual({ name: 'get_wagers', phase: 'done', ok: false, code: 'no_grant' })
    const second = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(second.messages[4].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true })
    expect(second.messages[4].content[0].content).toContain('sign the 24-hour read grant')
    // The gateway was never contacted: no grant, no request.
    expect(fetchImpl.mock.calls.every((c) => isGutterTokenUrl(c[0]))).toBe(true)
  })

  it('maps upstream failures to the shared error contract', async () => {
    saveGutterTokenKey(account, KEY)
    await expect(runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl: vi.fn().mockResolvedValue(response(403, {})) })).rejects.toMatchObject({ state: 'out_of_credit' })
  })
})

describe('honesty at the end of the turn', () => {
  it('turns an empty final answer into unavailable/empty_reply — never a blank bubble', async () => {
    saveGutterTokenKey(account, KEY)
    await expect(runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl: vi.fn().mockResolvedValue(gt([])) })).rejects.toMatchObject({ state: 'unavailable', code: 'empty_reply' })
    await expect(runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl: vi.fn().mockResolvedValue(gt([text('')], 'end_turn')) })).rejects.toMatchObject({ code: 'empty_reply' })
  })

  it('names a refusal', async () => {
    saveGutterTokenKey(account, KEY)
    await expect(runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl: vi.fn().mockResolvedValue(gt([], 'refusal')) })).rejects.toMatchObject({ state: 'unavailable', code: 'refusal' })
  })

  it('reports rounds exhausted with whatever text the last response carried', async () => {
    saveGutterTokenKey(account, KEY)
    const fetchImpl = vi.fn().mockResolvedValue(gt([text('still looking…'), use('t', 'get_gateway_status')], 'tool_use'))
    const gateway = vi.fn().mockResolvedValue(response(200, { status: 'ok' }))
    const both = (url, opts) => (isGutterTokenUrl(url) ? fetchImpl(url, opts) : gateway(url, opts))
    const result = await runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl: both, maxRounds: 2 })
    expect(result).toMatchObject({ reply: 'still looking…', roundsExhausted: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(gateway).toHaveBeenCalledTimes(2)
  })

  it('names an exhausted loop that ended with no text at all', async () => {
    saveGutterTokenKey(account, KEY)
    const fetchImpl = vi.fn().mockResolvedValue(gt([use('t', 'find_in_app', { query: 'x' })], 'tool_use'))
    await expect(runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl, maxRounds: 1 })).rejects.toMatchObject({ state: 'unavailable', code: 'rounds_exhausted' })
  })

  it('refuses an unknown provider before doing anything', async () => {
    await expect(runAssistantTurn({ account, provider: 'openai', thread: THREAD, relayerBase: BASE, fetchImpl: vi.fn() })).rejects.toMatchObject({ state: 'rejected', code: 'no_provider' })
  })
})

describe('retention', () => {
  it('never persists a tool call or its result — the turn writes nothing at all', async () => {
    saveGutterTokenKey(account, KEY)
    const before = new Set(Object.keys(localStorage))
    const gateway = vi.fn().mockResolvedValue(response(200, { status: 'ok', memberApi: { enabled: true } }))
    const fetchImpl = vi.fn(async (url, opts) => {
      if (!isGutterTokenUrl(url)) return gateway(url, opts)
      return fetchImpl.mock.calls.filter((c) => isGutterTokenUrl(c[0])).length === 1
        ? gt([use('t1', 'get_gateway_status')], 'tool_use')
        : gt([text('The gateway is answering.')])
    })
    const result = await runAssistantTurn({ account, provider: 'guttertoken', thread: THREAD, relayerBase: BASE, fetchImpl })
    expect(result.reply).toBe('The gateway is answering.')
    expect(result.toolEvents.map((e) => e.phase)).toEqual(['start', 'done'])

    // The member's own data is not cached anywhere: the transient loop messages die with the turn.
    // A tool result in device storage would be a retention decision, not a cache (research § 8.6),
    // and `memoryStore` deliberately keeps text turns only — written by the PANEL, not by this call.
    expect(new Set(Object.keys(localStorage))).toEqual(before)
    const dump = JSON.stringify(Object.entries(localStorage))
    expect(dump).not.toContain('tool_result')
    expect(dump).not.toContain('tool_use')
    expect(dump).not.toContain('get_gateway_status')
  })
})
