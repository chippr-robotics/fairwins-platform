/**
 * GutterToken transport (spec 104) — request shape and the error state machine.
 *
 * Two invariants beyond the mapping table: the key rides in a header and nowhere else, and neither
 * the key nor the upstream error body's `message` (which can quote the member) ever appears in a
 * thrown error.
 */
import { describe, it, expect, vi } from 'vitest'
import { ANTHROPIC_VERSION } from '@fairwins/assistant-contract'
import { AssistantError } from '../../lib/assistant/assistantClient'
import {
  GUTTERTOKEN_BASE_URL,
  GUTTERTOKEN_BILLING_URL,
  GUTTERTOKEN_DEFAULT_MODEL,
  GUTTERTOKEN_MAX_TOKENS,
  GUTTERTOKEN_SIGNUP_URL,
  sendGutterTokenTurn,
  validateTurnMessages,
} from '../../lib/assistant/providers/guttertoken'
import { hangingFetch, response } from './helpers/http'

const KEY = 'sk-gt-0123456789abcdefghijklmnopqrstuvwxyz'
const MEMBER_TEXT = 'my secret question about 0xdeadbeef'
const MESSAGES = [{ role: 'user', content: MEMBER_TEXT }]

const ok = (overrides = {}) =>
  response(200, {
    id: 'msg_1',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Earn lives at /wallet?tab=earn' }],
    usage: { input_tokens: 12, output_tokens: 7 },
    ...overrides,
  })

const send = (fetchImpl, args = {}) =>
  sendGutterTokenTurn({ apiKey: KEY, system: 'SYSTEM', messages: MESSAGES, fetchImpl, timeoutMs: 50, ...args })

describe('constants', () => {
  it('names the host, the link-outs, the model and the output ceiling', () => {
    expect(GUTTERTOKEN_BASE_URL).toBe('https://api.guttertokens.com')
    expect(GUTTERTOKEN_SIGNUP_URL).toBe('https://app.guttertokens.com/signup')
    expect(GUTTERTOKEN_BILLING_URL).toBe('https://app.guttertokens.com/billing')
    expect(GUTTERTOKEN_DEFAULT_MODEL).toBe('claude-opus-5')
    expect(GUTTERTOKEN_MAX_TOKENS).toBe(1024)
  })
})

describe('request', () => {
  it('POSTs the Messages shape with the key in a header and returns content + counts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const result = await send(fetchImpl)

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Earn lives at /wallet?tab=earn' }],
      stopReason: 'end_turn',
      model: 'claude-opus-5',
      usage: { inputTokens: 12, outputTokens: 7 },
    })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.guttertokens.com/v1/messages')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(options.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(options.headers['content-type']).toBe('application/json')
    expect(url).not.toContain(KEY)
    expect(options.body).not.toContain(KEY)
    expect(JSON.parse(options.body)).toEqual({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: 'SYSTEM',
      messages: MESSAGES,
    })
  })

  it('omits tools and tool_choice when there are no tools, and sends both with auto when there are', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    await send(fetchImpl, { tools: [] })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('tools')
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('tool_choice')

    const tools = [{ name: 'find_in_app', description: 'd', input_schema: { type: 'object', properties: {}, required: [] }, strict: true }]
    await send(fetchImpl, { tools })
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(body.tools).toEqual(tools)
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  it('honours model and maxTokens overrides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    await send(fetchImpl, { model: 'claude-sonnet-5', maxTokens: 256 })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 256 })
  })

  it('accepts block-array content and tool_result turns', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok())
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: '[Context: /app]' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_gateway_status', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
    ]
    await expect(send(fetchImpl, { messages })).resolves.toBeTruthy()
  })

  it('reports absent usage counts as null, never zero', async () => {
    const result = await send(vi.fn().mockResolvedValue(ok({ usage: undefined })))
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null })
  })
})

describe('refusals before any request', () => {
  it('throws key_missing without a key', async () => {
    const fetchImpl = vi.fn()
    await expect(send(fetchImpl, { apiKey: '' })).rejects.toMatchObject({ state: 'key_missing' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws rejected for a malformed thread without spending credit', async () => {
    const fetchImpl = vi.fn()
    await expect(send(fetchImpl, { messages: [{ role: 'assistant', content: 'x' }] })).rejects.toMatchObject({ state: 'rejected', code: 'first_not_user' })
    await expect(send(fetchImpl, { messages: [{ role: 'user', content: [{ type: 'image' }] }] })).rejects.toMatchObject({ state: 'rejected', code: 'bad_content' })
    await expect(send(fetchImpl, { messages: [] })).rejects.toMatchObject({ state: 'rejected', code: 'no_messages' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(validateTurnMessages(MESSAGES)).toEqual({ ok: true })
  })
})

describe('upstream status mapping', () => {
  const upstreamBody = (type) => ({ type: 'error', error: { type, message: `Invalid request: "${MEMBER_TEXT}" with ${KEY}` } })

  it.each([
    [401, 'authentication_error', 'key_invalid'],
    [403, 'permission_error', 'out_of_credit'],
    [429, 'rate_limit_error', 'quota'],
    [400, 'invalid_request_error', 'rejected'],
    [404, 'not_found_error', 'rejected'],
    [500, 'api_error', 'unavailable'],
    [503, 'model_unavailable', 'unavailable'],
    [529, 'overloaded_error', 'unavailable'],
  ])('HTTP %i (%s) → %s, carrying the type as code and never the message', async (status, type, state) => {
    let thrown
    try {
      await send(vi.fn().mockResolvedValue(response(status, upstreamBody(type), { 'Retry-After': '17' })))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(AssistantError)
    expect(thrown.state).toBe(state)
    expect(thrown.code).toBe(type)
    const everything = `${thrown.message}|${thrown.code}|${thrown.state}`
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain(MEMBER_TEXT)
    expect(everything).not.toContain('0xdeadbeef')
    if (status === 429) expect(thrown.retryAfterSeconds).toBe(17)
  })

  it('maps a 400 whose type is a model_unavailable token to unavailable', async () => {
    await expect(send(vi.fn().mockResolvedValue(response(400, upstreamBody('model_unavailable'))))).rejects.toMatchObject({ state: 'unavailable' })
  })

  it('ignores an error type that is not a short token', async () => {
    const body = { error: { type: `free text mentioning ${MEMBER_TEXT}` } }
    let thrown
    try {
      await send(vi.fn().mockResolvedValue(response(400, body)))
    } catch (e) {
      thrown = e
    }
    expect(thrown.code).toBe('bad_request')
    expect(thrown.message).not.toContain(MEMBER_TEXT)
  })

  it('maps a network failure to unreachable with the kind, not the exception text', async () => {
    let thrown
    try {
      await send(vi.fn().mockRejectedValue(new Error(`TypeError: failed to fetch with ${KEY}`)))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toMatchObject({ state: 'unreachable', code: 'network_error' })
    expect(thrown.message).not.toContain(KEY)
  })

  it('maps a timeout to unreachable/timeout', async () => {
    await expect(send(hangingFetch())).rejects.toMatchObject({ state: 'unreachable', code: 'timeout' })
  })

  it('treats a 200 without a content array as unavailable, never a reply', async () => {
    await expect(send(vi.fn().mockResolvedValue(response(200, { reply: 'text but wrong shape' })))).rejects.toMatchObject({
      state: 'unavailable',
      code: 'malformed_response',
    })
    await expect(send(vi.fn().mockResolvedValue(response(200, undefined)))).rejects.toMatchObject({ state: 'unavailable' })
  })
})
