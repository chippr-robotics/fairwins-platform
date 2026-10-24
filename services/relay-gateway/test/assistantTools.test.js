/**
 * The FairWins rail as ONE ROUND of a client-side tool loop (spec 104).
 *
 * Same build-the-app pattern as memberApi.test.js. What is asserted, and why each matters:
 *   · content BLOCKS are admitted under a strict allow-list, and every malformed shape is a 400
 *     that costs no upstream call — the gateway pays for every byte it forwards;
 *   · the GATEWAY attaches `tools`, filtered to the token's scopes; a client that sends its own is
 *     refused, because on this rail that is arbitrary text into the model under FairWins' key;
 *   · `surface` lands as a trailing text block on the last user message and never in `system`,
 *     which stays byte-identical across turns (the cache prefix);
 *   · a `tool_use` stop reason is a normal round, returned 200 with the blocks — not the 503 an
 *     empty reply used to be;
 *   · not one character of a message OR a tool result reaches a log line.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { createKillSwitch } from '../src/policy/killswitch.js'
import { testConfig, mockEngine, ORIGIN_SECRET, TEST_NOW } from './helpers.js'
import { MEMBER_API_ENV, memberApiProviders, memberToken } from './memberApiHelpers.js'
import { buildOpenApiDocument } from '../src/memberApi/openapi.js'
import {
  MAX_BLOCKS_PER_MESSAGE,
  MAX_MESSAGE_CHARS,
  MAX_REQUEST_CONTENT_CHARS,
  MAX_ROUNDS_CEILING,
  MAX_TOOL_RESULT_CHARS,
  parseChatRequest,
} from '../src/memberApi/assistant.js'
import { TOOL_DEFS, TOOL_NAMES, toolsForMessages } from '@fairwins/assistant-contract/tools'
import { buildSystemPrompt } from '@fairwins/assistant-contract/prompt'

const ASSISTANT_ENV = { ...MEMBER_API_ENV, ASSISTANT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' }

const TEXT_ANSWER = {
  content: [{ type: 'text', text: 'You have one open wager on Polygon.' }],
  model: 'claude-sonnet-5',
  usage: { input_tokens: 300, output_tokens: 20 },
  stop_reason: 'end_turn',
}

const TOOL_ANSWER = {
  content: [
    { type: 'thinking', thinking: '', signature: 'x' },
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'toolu_01A', name: 'get_wagers', input: { chainId: 137 } },
    { type: 'tool_use', id: 'toolu_01B', name: 'find_in_app', input: { query: 'wagers' } },
  ],
  model: 'claude-sonnet-5',
  usage: { input_tokens: 280, output_tokens: 60 },
  stop_reason: 'tool_use',
}

function mockAssistant(answer = TEXT_ANSWER) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, json: async () => answer }
  }
  impl.calls = calls
  return impl
}

function build({ env = {}, memberApiFetch = mockAssistant(), auditLines = [] } = {}) {
  const config = testConfig({ ...ASSISTANT_ENV, ...env })
  config.feeRouter = { ...config.feeRouter, address: null }
  const { app } = createApp(config, {
    providers: memberApiProviders(config),
    engineClient: mockEngine(),
    now: () => TEST_NOW,
    killSwitch: createKillSwitch(false),
    auditSink: (line) => auditLines.push(line),
    memberApiFetch,
  })
  return { app, config, memberApiFetch, auditLines }
}

const chat = (app, token, body) =>
  request(app).post('/v1/member/assistant/chat').set('X-Origin-Auth', ORIGIN_SECRET).set('Authorization', `Bearer ${token}`).send(body)

const sentBody = (fetchImpl) => JSON.parse(fetchImpl.calls.at(-1).init.body)

/** A well-formed second round: the model asked for two tools, the browser answers both. */
const ROUND_TWO = [
  { role: 'user', content: 'where are my wagers?' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_01A', name: 'get_wagers', input: { chainId: 137 } },
      { type: 'tool_use', id: 'toolu_01B', name: 'find_in_app', input: { query: 'wagers' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01A', content: '{"chains":{"137":{"state":"unreadable"}}}', is_error: false },
      { type: 'tool_result', tool_use_id: 'toolu_01B', content: '[{"path":"/wallet?tab=pay&view=wagers"}]' },
    ],
  },
]

// ---- accept ------------------------------------------------------------------------------------

describe('content blocks are admitted and forwarded', () => {
  it('forwards a tool round with the gateway’s own tools, tool_choice auto, and a frozen system prompt', async () => {
    const fetchImpl = mockAssistant()
    const { app } = build({ memberApiFetch: fetchImpl })
    const token = await memberToken()
    const res = await chat(app, token, { messages: ROUND_TWO, surface: '/wallet?tab=earn' })
    expect(res.status).toBe(200)
    expect(res.body.reply).toBe('You have one open wager on Polygon.')
    expect(res.body.stopReason).toBe('end_turn')
    expect(res.body.content).toEqual([{ type: 'text', text: 'You have one open wager on Polygon.' }])

    const sent = sentBody(fetchImpl)
    expect(sent.tool_choice).toEqual({ type: 'auto' })
    expect(sent.tools).toEqual(toolsForMessages(TOOL_DEFS))
    expect(sent.tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const t of sent.tools) expect(t.strict).toBe(true)
    // System prompt: the member-tools variant, byte-identical to the package's, no surface in it.
    expect(sent.system).toBe(buildSystemPrompt({ rail: 'fairwins', hasMemberTools: true }))
    expect(sent.system).not.toContain('/wallet?tab=earn')
    expect(sent.system).toMatch(/You have NOT performed any action/)
    // Earlier messages pass through unchanged (the tool_result gains an explicit is_error:false).
    expect(sent.messages[0]).toEqual(ROUND_TWO[0])
    expect(sent.messages[1]).toEqual(ROUND_TWO[1])
    expect(sent.messages[2].content.slice(0, 2)).toEqual([
      { ...ROUND_TWO[2].content[0] },
      { ...ROUND_TWO[2].content[1], is_error: false },
    ])
    // The surface is the LAST block of the LAST user message, as its own text block.
    expect(sent.messages[2].content.at(-1)).toEqual({ type: 'text', text: '[Context: the member is currently on /wallet?tab=earn]' })
    expect(sent.messages[2].content).toHaveLength(3)
  })

  it('turns a plain-string last message into blocks only when a surface is present', async () => {
    const fetchImpl = mockAssistant()
    const { app } = build({ memberApiFetch: fetchImpl })
    const token = await memberToken()
    await chat(app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(sentBody(fetchImpl).messages).toEqual([{ role: 'user', content: 'hi' }])
    await chat(app, token, { messages: [{ role: 'user', content: 'hi' }], surface: 'wallet/earn' })
    expect(sentBody(fetchImpl).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: '[Context: the member is currently on wallet/earn]' }] },
    ])
  })

  it('returns a tool_use round as 200 with the blocks and an empty reply — never a 503', async () => {
    const fetchImpl = mockAssistant(TOOL_ANSWER)
    const { app } = build({ memberApiFetch: fetchImpl })
    const token = await memberToken()
    const res = await chat(app, token, { messages: [{ role: 'user', content: 'where are my wagers?' }] })
    expect(res.status).toBe(200)
    expect(res.body.stopReason).toBe('tool_use')
    expect(res.body.reply).toBe('Let me check.')
    // Thinking blocks are dropped; text + tool_use pass through in order and in shape.
    expect(res.body.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_01A', name: 'get_wagers', input: { chainId: 137 } },
      { type: 'tool_use', id: 'toolu_01B', name: 'find_in_app', input: { query: 'wagers' } },
    ])
    expect(res.body.usage).toEqual({ inputTokens: 280, outputTokens: 60 })
  })

  it('returns a tool_use round with NO text at all as 200', async () => {
    const answer = { ...TOOL_ANSWER, content: TOOL_ANSWER.content.filter((b) => b.type !== 'text') }
    const { app } = build({ memberApiFetch: mockAssistant(answer) })
    const token = await memberToken()
    const res = await chat(app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.body.reply).toBe('')
    expect(res.body.content).toHaveLength(2)
  })

  it('still reports an empty end_turn as unavailable, and a tool_use with no tool_use blocks too', async () => {
    const empty = build({ memberApiFetch: mockAssistant({ content: [], stop_reason: 'end_turn' }) })
    const token = await memberToken()
    let res = await chat(empty.app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('assistant_unavailable')

    const inconsistent = build({ memberApiFetch: mockAssistant({ content: [{ type: 'text', text: 'hm' }], stop_reason: 'tool_use' }) })
    res = await chat(inconsistent.app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('assistant_unavailable')
  })
})

// ---- tools are the gateway's, filtered by scope -------------------------------------------------

describe('the gateway attaches the tool table itself', () => {
  it('filters grant tools by the token’s scopes', async () => {
    const fetchImpl = mockAssistant()
    const { app } = build({ memberApiFetch: fetchImpl })

    const wagersOnly = await memberToken({ scopes: ['assistant:chat', 'read:wagers'] })
    expect((await chat(app, wagersOnly, { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200)
    expect(sentBody(fetchImpl).tools.map((t) => t.name)).toEqual(['find_in_app', 'get_gateway_status', 'get_perps_pairs', 'get_prediction_markets', 'get_token_news', 'get_wagers'])
    expect(sentBody(fetchImpl).system).toBe(buildSystemPrompt({ rail: 'fairwins', hasMemberTools: true }))

    const chatOnly = await memberToken({ scopes: ['assistant:chat'] })
    expect((await chat(app, chatOnly, { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(200)
    expect(sentBody(fetchImpl).tools.map((t) => t.name)).toEqual(['find_in_app', 'get_gateway_status', 'get_perps_pairs', 'get_prediction_markets', 'get_token_news'])
    // ...and the prompt then says so.
    expect(sentBody(fetchImpl).system).toBe(buildSystemPrompt({ rail: 'fairwins', hasMemberTools: false }))
    expect(sentBody(fetchImpl).system).toMatch(/NO access to this member’s own data/)
  })

  it('refuses client-supplied tools, system, tool_choice and model with 400 and no upstream call', async () => {
    const fetchImpl = mockAssistant()
    const { app } = build({ memberApiFetch: fetchImpl })
    const token = await memberToken()
    for (const owned of ['tools', 'system', 'tool_choice', 'model']) {
      const res = await chat(app, token, { messages: [{ role: 'user', content: 'hi' }], [owned]: [] })
      expect(res.status, owned).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
      expect(res.body.error.reason).toContain(owned)
    }
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

// ---- reject ------------------------------------------------------------------------------------

describe('parseChatRequest rejects every malformed block shape', () => {
  const user = (content) => ({ role: 'user', content })
  const assistant = (content) => ({ role: 'assistant', content })
  const use = (id, name = 'get_fees', input = {}) => ({ type: 'tool_use', id, name, input })
  const result = (id, content = 'ok') => ({ type: 'tool_result', tool_use_id: id, content })
  const reject = (messages, re) => expect(() => parseChatRequest({ messages })).toThrow(re)

  it('unknown block types and unknown keys', () => {
    reject([user([{ type: 'image', source: {} }])], /type must be one of text, tool_use, tool_result/)
    reject([user([{ type: 'text', text: 'hi', cache_control: {} }])], /unexpected key "cache_control"/)
    reject([user('hi'), assistant([{ ...use('a'), extra: 1 }]), user([result('a')])], /unexpected key "extra"/)
    reject([user('hi'), assistant([use('a')]), user([{ ...result('a'), signature: '0x' }])], /unexpected key "signature"/)
    reject([{ role: 'user', content: 'hi', name: 'x' }], /unexpected key "name"/)
  })

  it('text blocks: non-empty strings under the cap', () => {
    reject([user([{ type: 'text', text: '' }])], /non-empty string/)
    reject([user([{ type: 'text', text: 1 }])], /non-empty string/)
    reject([user([{ type: 'text', text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }])], /exceeds 4000/)
    reject([user([])], /must not be an empty array/)
    reject([user(null)], /non-empty string or an array/)
    reject([user({ text: 'x' })], /non-empty string or an array/)
  })

  it('tool_use: assistant-only, id/name/input, known tool names, serialised input under the cap', () => {
    reject([user([use('a')])], /only an assistant message may carry/)
    reject([user('hi'), assistant([{ type: 'tool_use', name: 'get_fees', input: {} }]), user([result('a')])], /\.id must be/)
    reject([user('hi'), assistant([use('bad id!')]), user([result('bad id!')])], /\.id must be/)
    reject([user('hi'), assistant([use('a', 'build_intent')]), user([result('a')])], /not a tool this gateway offers/)
    reject([user('hi'), assistant([use('a', 'drain_wallet')]), user([result('a')])], /not a tool this gateway offers/)
    // spec 109: get_token_news is IN the table, so its tool_use round-trips the same validator
    // that refuses build_intent — the news tool rides the existing loop, not a side channel.
    expect(() =>
      parseChatRequest({
        messages: [
          user('hi'),
          assistant([use('a', 'get_token_news', { chainId: 61, asset: 'native', slug: 'ethereum-classic' })]),
          user([result('a')]),
        ],
      }),
    ).not.toThrow()
    reject([user('hi'), assistant([{ type: 'tool_use', id: 'a', name: 'get_fees' }]), user([result('a')])], /input must be an object/)
    reject([user('hi'), assistant([use('a', 'get_fees', [])]), user([result('a')])], /input must be an object/)
    reject([user('hi'), assistant([use('a', 'get_wagers', { q: 'x'.repeat(MAX_MESSAGE_CHARS) })]), user([result('a')])], /input exceeds/)
    reject([user('hi'), assistant([use('a'), use('a')]), user([result('a')])], /repeats an id/)
  })

  it('tool_result: user-only, string content under the cap, boolean is_error', () => {
    reject([user('hi'), assistant([result('a')])], /only a user message may carry/)
    reject([user('hi'), assistant([use('a')]), user([{ type: 'tool_result', content: 'x' }])], /tool_use_id must be/)
    reject([user('hi'), assistant([use('a')]), user([{ type: 'tool_result', tool_use_id: 'a', content: { a: 1 } }])], /content must be a string/)
    reject([user('hi'), assistant([use('a')]), user([result('a', 'x'.repeat(MAX_TOOL_RESULT_CHARS + 1))])], /exceeds 12000/)
    reject([user('hi'), assistant([use('a')]), user([{ ...result('a'), is_error: 'yes' }])], /is_error must be a boolean/)
    reject([user('hi'), assistant([use('a')]), user([result('a'), result('a')])], /already answered/)
  })

  it('pairing: every tool_use answered by the next user message, and nothing else answered', () => {
    reject([user('hi'), assistant([use('a')]), user('thanks')], /leaves tool_use "a" unanswered/)
    reject([user('hi'), assistant([use('a'), use('b')]), user([result('a')])], /leaves tool_use "b" unanswered/)
    reject([user('hi'), assistant('sure'), user([result('ghost')])], /did not make/)
    reject([user('hi'), assistant([use('a')]), assistant('and'), user([result('a')])], /never answered/)
    // A correctly paired round parses.
    expect(() => parseChatRequest({ messages: [user('hi'), assistant([use('a'), use('b')]), user([result('b'), result('a')])] })).not.toThrow()
  })

  it('conversation shape: first and last from the user, message and block counts, total content', () => {
    reject([assistant('hi')], /first message must be from the user/)
    reject([user('hi'), assistant('there')], /last message must be from the user/)
    reject([user(Array.from({ length: MAX_BLOCKS_PER_MESSAGE + 1 }, () => ({ type: 'text', text: 'x' })))], /at most 16 per message/)
    // Seven 3,900-character messages are each under the per-block cap and over the request cap.
    const many = Array.from({ length: 7 }, () => user('x'.repeat(3900)))
    reject(many, new RegExp(`at most ${MAX_REQUEST_CONTENT_CHARS} per request`))
  })

  it('costs no upstream call when refused over HTTP', async () => {
    const fetchImpl = mockAssistant()
    const { app } = build({ memberApiFetch: fetchImpl })
    const token = await memberToken()
    const res = await chat(app, token, { messages: [user('hi'), assistant([use('a')]), user('thanks')] })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

// ---- logs --------------------------------------------------------------------------------------

describe('no message or tool-result content reaches a log', () => {
  it('audits counts only, on a round full of identifiable text', async () => {
    const auditLines = []
    const { app } = build({ auditLines, memberApiFetch: mockAssistant(TOOL_ANSWER) })
    const token = await memberToken()
    const secretQuestion = 'a very identifiable question about wager 4242'
    const secretResult = 'IDENTIFIABLE-TOOL-RESULT-PAYLOAD-9f8e7d'
    const messages = [
      { role: 'user', content: secretQuestion },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'get_wagers', input: { chainId: 137 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: secretResult, is_error: true }] },
    ]
    const res = await chat(app, token, { messages, surface: '/wallet?tab=pay&secret=surface' })
    expect(res.status).toBe(200)
    const joined = auditLines.join('\n')
    expect(joined).toContain('member_api_assistant_chat')
    expect(joined).toContain('"messageCount":3')
    expect(joined).toContain('"toolUseCount":2')
    expect(joined).toContain('"stopReason":"tool_use"')
    for (const leak of [secretQuestion, secretResult, 'secret=surface', 'Let me check', 'toolu_x', 'fw1.', '"chainId":137']) {
      expect(joined, `leaked: ${leak}`).not.toContain(leak)
    }
  })
})

// ---- rounds config + status + openapi -----------------------------------------------------------

describe('ASSISTANT_MAX_ROUNDS', () => {
  it('defaults to 4, is exported on /status, and is hard-capped at boot', async () => {
    const { app } = build()
    const status = await request(app).get('/status')
    expect(status.body.memberApi.assistant).toEqual({ configured: true, maxRounds: 4 })

    const eight = build({ env: { ASSISTANT_MAX_ROUNDS: '8' } })
    expect((await request(eight.app).get('/status')).body.memberApi.assistant.maxRounds).toBe(8)

    expect(() => testConfig({ ...ASSISTANT_ENV, ASSISTANT_MAX_ROUNDS: String(MAX_ROUNDS_CEILING + 1) })).toThrow(/ASSISTANT_MAX_ROUNDS=9/)
    expect(() => testConfig({ ...ASSISTANT_ENV, ASSISTANT_MAX_ROUNDS: '0' })).toThrow(/ASSISTANT_MAX_ROUNDS=0/)
    // Not validated while the assistant is off, like the rest of the block.
    expect(() => testConfig({ ...MEMBER_API_ENV, ASSISTANT_MAX_ROUNDS: '99' })).not.toThrow()
  })

  it('documents the tool table and the loop caps in the OpenAPI document', () => {
    const { config } = build({ env: { ASSISTANT_MAX_ROUNDS: '3' } })
    const doc = buildOpenApiDocument(config, { assistantConfigured: true })
    expect(doc['x-fairwins-tools'].map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const t of doc['x-fairwins-tools']) {
      const def = TOOL_DEFS.find((d) => d.name === t.name)
      expect(t.auth).toBe(def.auth)
      expect(t.scope).toBe(def.scope)
      expect(t.strict).toBe(true)
      expect(t.input_schema).toEqual(toolsForMessages([def])[0].input_schema)
    }
    expect(doc['x-fairwins-assistant'].maxRounds).toBe(3)
    expect(doc['x-fairwins-assistant'].maxToolResultChars).toBe(MAX_TOOL_RESULT_CHARS)
    expect(doc.info.description).toContain('tool rounds per turn: 3')
    const req = doc.components.schemas.AssistantChatRequest
    expect(req.properties.messages.items.properties.content.oneOf).toHaveLength(2)
    expect(doc.components.schemas.AssistantToolUseBlock.properties.name.enum).toEqual([...TOOL_NAMES])
    expect(doc.components.schemas.AssistantChatResponse.required).toEqual(['reply', 'content', 'stopReason', 'model', 'usage'])
  })
})
