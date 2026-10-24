/** The MCP protocol handler: handshake, listings, resources, prompts (spec 095). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/server.js'
import { PROTOCOL_VERSION } from '../src/mcp.js'
import { RESOURCE_URIS } from '../src/resources.js'
import { rpc, startStubGateway } from './helpers.js'

const OPENAPI_DOC = {
  openapi: '3.1.0',
  info: { title: 'FairWins Member API', version: '1.0.0' },
  paths: { '/v1/member/me': { get: { operationId: 'getMe' } } },
}

async function withServer(routes, run) {
  const gateway = await startStubGateway(routes)
  try {
    const { handler, api } = buildServer({ env: { FAIRWINS_API_URL: gateway.url, FAIRWINS_API_TOKEN: 'fw1.grant.sig' } })
    await run({ handler, api, gateway })
  } finally {
    await gateway.close()
  }
}

test('initialize answers with the protocol version, all three capabilities, and the server identity', async () => {
  await withServer({}, async ({ handler }) => {
    const res = await handler.handle(rpc(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } }))
    assert.equal(res.jsonrpc, '2.0')
    assert.equal(res.id, 1)
    assert.equal(res.result.protocolVersion, '2025-06-18')
    assert.deepEqual(Object.keys(res.result.capabilities).sort(), ['prompts', 'resources', 'tools'])
    assert.equal(res.result.serverInfo.name, 'fairwins-mcp')
    // The manifest carries no version field (release-computed, spec 076 FR-008; this package is
    // never published), so an unreleased checkout reports the literal 'unreleased'.
    assert.match(res.result.serverInfo.version, /^(\d+\.\d+\.\d+|unreleased)$/)
    // The instructions must state the custody position, because a client shows them to the model.
    assert.match(res.result.instructions, /never ask the member for a private key/i)
  })
})

test('initialize echoes an older protocol revision it can speak, and names its own otherwise', async () => {
  await withServer({}, async ({ handler }) => {
    const older = await handler.handle(rpc(1, 'initialize', { protocolVersion: '2024-11-05' }))
    assert.equal(older.result.protocolVersion, '2024-11-05')
    const unknown = await handler.handle(rpc(2, 'initialize', { protocolVersion: '1999-01-01' }))
    assert.equal(unknown.result.protocolVersion, PROTOCOL_VERSION)
  })
})

test('notifications are never answered, known or unknown', async () => {
  await withServer({}, async ({ handler }) => {
    assert.equal(await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
    assert.equal(await handler.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null)
    assert.equal(await handler.handle({ jsonrpc: '2.0', method: 'no/such/notification' }), null)
    // A malformed notification is still not answered — there is no id to answer to.
    assert.equal(await handler.handle({ jsonrpc: '9.9', method: 'notifications/initialized' }), null)
  })
})

test('ping answers with an empty result and an unknown method is -32601', async () => {
  await withServer({}, async ({ handler }) => {
    assert.deepEqual((await handler.handle(rpc(1, 'ping'))).result, {})
    const missing = await handler.handle(rpc(2, 'resources/subscribe', { uri: 'x' }))
    assert.equal(missing.error.code, -32601)
    assert.match(missing.error.message, /unknown method/)
  })
})

test('tools/list returns nine named tools, each with a JSON Schema input', async () => {
  await withServer({}, async ({ handler }) => {
    const { tools } = (await handler.handle(rpc(1, 'tools/list'))).result
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'build_intent',
        'get_fees',
        'get_gateway_status',
        'get_membership',
        'get_perps_pairs',
        'get_prediction_markets',
        'get_profile',
        'get_token_news',
        'get_wagers',
      ]
    )
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
      assert.equal(tool.inputSchema.type, 'object')
      assert.equal(typeof tool.inputSchema.properties, 'object')
      // The handler function must never leave this process.
      assert.equal(tool.call, undefined)
    }
    // The one tool that returns something signable has to say who signs it.
    const build = tools.find((t) => t.name === 'build_intent')
    assert.match(build.description, /cannot sign and will not sign/i)
    assert.match(build.description, /signs it in their own wallet/i)
  })
})

test('no tool takes an account parameter — the account is whoever signed the token', async () => {
  await withServer({}, async ({ handler }) => {
    const { tools } = (await handler.handle(rpc(1, 'tools/list'))).result
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {})
      for (const forbidden of ['account', 'address', 'owner', 'token']) {
        assert.ok(!props.includes(forbidden), `${tool.name} must not accept "${forbidden}"`)
      }
    }
  })
})

test('resources/list names the three resources with their mime types', async () => {
  await withServer({}, async ({ handler }) => {
    const { resources } = (await handler.handle(rpc(1, 'resources/list'))).result
    assert.deepEqual(resources.map((r) => r.uri).sort(), [RESOURCE_URIS.guide, RESOURCE_URIS.openapi, RESOURCE_URIS.status])
    assert.equal(resources.find((r) => r.uri === RESOURCE_URIS.openapi).mimeType, 'application/json')
    assert.equal(resources.find((r) => r.uri === RESOURCE_URIS.guide).mimeType, 'text/markdown')
  })
})

test('resources/read fairwins://openapi passes the gateway document through unchanged and needs no token', async () => {
  await withServer({ 'GET /v1/member/openapi.json': { body: OPENAPI_DOC } }, async ({ handler, gateway }) => {
    const res = await handler.handle(rpc(1, 'resources/read', { uri: RESOURCE_URIS.openapi }))
    const [content] = res.result.contents
    assert.equal(content.uri, RESOURCE_URIS.openapi)
    assert.equal(content.mimeType, 'application/json')
    assert.deepEqual(JSON.parse(content.text), OPENAPI_DOC)
    // The specification is public: sending a member's credential to fetch it would be gratuitous.
    assert.equal(gateway.requests[0].headers.authorization, undefined)
  })
})

test('a failed resource read is an ERROR carrying the gateway code, never an empty document', async () => {
  const routes = {
    'GET /v1/member/openapi.json': {
      status: 503,
      body: { error: { code: 'member_api_unconfigured', reason: 'the member API is not enabled on this gateway' } },
    },
  }
  await withServer(routes, async ({ handler }) => {
    const res = await handler.handle(rpc(1, 'resources/read', { uri: RESOURCE_URIS.openapi }))
    assert.equal(res.result, undefined)
    assert.match(res.error.message, /member_api_unconfigured/)
    assert.equal(res.error.data.code, 'member_api_unconfigured')
  })
})

test('fairwins://guide is embedded, so it reads with the gateway unreachable', async () => {
  const { handler } = buildServer({ env: {} })
  const res = await handler.handle(rpc(1, 'resources/read', { uri: RESOURCE_URIS.guide }))
  const [content] = res.result.contents
  assert.equal(content.mimeType, 'text/markdown')
  assert.match(content.text, /Settings ▸ API access/)
  assert.match(content.text, /It \*\*cannot\*\*: sign anything/)
})

test('an unknown resource uri is -32002, and names what does exist', async () => {
  await withServer({}, async ({ handler }) => {
    const res = await handler.handle(rpc(1, 'resources/read', { uri: 'fairwins://nope' }))
    assert.equal(res.error.code, -32002)
    assert.deepEqual(res.error.data.available.sort(), [RESOURCE_URIS.guide, RESOURCE_URIS.openapi, RESOURCE_URIS.status])
  })
})

test('prompts/list and prompts/get build a user message that forbids acting on the member’s behalf', async () => {
  await withServer({}, async ({ handler }) => {
    const { prompts } = (await handler.handle(rpc(1, 'prompts/list'))).result
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['portfolio-briefing', 'wager-review'])
    assert.deepEqual(prompts.find((p) => p.name === 'wager-review').arguments.map((a) => a.name), ['chainId'])

    const got = await handler.handle(rpc(2, 'prompts/get', { name: 'wager-review', arguments: { chainId: 137 } }))
    const [message] = got.result.messages
    assert.equal(message.role, 'user')
    assert.equal(message.content.type, 'text')
    assert.match(message.content.text, /chain 137/)
    assert.match(message.content.text, /you cannot sign/i)
    // The honesty rule has to survive into the template, or a briefing quietly invents an absence.
    assert.match(message.content.text, /unreadable/)

    const briefing = await handler.handle(rpc(3, 'prompts/get', { name: 'portfolio-briefing' }))
    assert.match(briefing.result.messages[0].content.text, /never ask me for a private key/i)

    const missing = await handler.handle(rpc(4, 'prompts/get', { name: 'no-such-prompt' }))
    assert.equal(missing.error.code, -32602)
  })
})

test('tools/call with an unknown tool is -32602 and lists the real ones', async () => {
  await withServer({}, async ({ handler }) => {
    const res = await handler.handle(rpc(1, 'tools/call', { name: 'drain_wallet', arguments: {} }))
    assert.equal(res.error.code, -32602)
    assert.ok(res.error.data.available.includes('get_profile'))
  })
})
