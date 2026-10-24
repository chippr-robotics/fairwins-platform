/**
 * Tool calls against a stub gateway (spec 095).
 *
 * The assertions that matter most here are the negative ones: a 503 must not become an empty list,
 * and a missing configuration must not become a plausible-looking answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/server.js'
import { TOOL_SNAPSHOT } from '../src/tools.js'
import { rpc, startStubGateway } from './helpers.js'

/**
 * What this server serves: every shared snapshot tool (the local one runs in the browser and is
 * never served here) plus the MCP-only build_intent. Derived rather than written as a literal —
 * mcp.test.js NAMES every tool, which is the assertion a new tool should have to update, and a
 * second copy of the count here only ever breaks for the same reason.
 */
const SERVED_TOOL_COUNT = TOOL_SNAPSHOT.filter((d) => d.auth !== 'local').length + 1

const TOKEN = 'fw1.eyJhY2NvdW50IjoiMHhhYmMifQ.c2ln'

const call = (handler, name, args = {}, ctx) => handler.handle(rpc(1, 'tools/call', { name, arguments: args }), ctx)
const textOf = (res) => res.result.content.map((c) => c.text).join('\n')

async function withGateway(routes, run) {
  const gateway = await startStubGateway(routes)
  try {
    const { handler } = buildServer({ env: { FAIRWINS_API_URL: gateway.url, FAIRWINS_API_TOKEN: TOKEN } })
    await run({ handler, gateway })
  } finally {
    await gateway.close()
  }
}

test('get_profile returns the gateway body and sends the token as a bearer header', async () => {
  const me = {
    account: '0xabc',
    keyId: `0x${'11'.repeat(32)}`,
    scopes: ['read:profile'],
    membership: { state: 'read', tier: 2, active: true },
    revocation: { revoked: false, durable: false },
  }
  await withGateway({ 'GET /v1/member/me': { body: me } }, async ({ handler, gateway }) => {
    const res = await call(handler, 'get_profile')
    assert.equal(res.result.isError, false)
    assert.deepEqual(JSON.parse(textOf(res)), me)
    assert.equal(gateway.requests[0].headers.authorization, `Bearer ${TOKEN}`)
    // A credential never travels in a URL.
    assert.ok(!gateway.requests[0].path.includes(TOKEN))
    assert.deepEqual(gateway.requests[0].query, {})
  })
})

test('get_wagers forwards chainId and preserves the per-chain three-state envelope verbatim', async () => {
  const body = {
    account: '0xabc',
    chains: {
      137: { state: 'read', wagers: [{ id: '1' }] },
      1: { state: 'unreadable', reason: 'the indexer did not answer' },
      8453: { state: 'not-configured' },
    },
    partial: true,
  }
  await withGateway({ 'GET /v1/member/wagers': { body } }, async ({ handler, gateway }) => {
    const res = await call(handler, 'get_wagers', { chainId: 137, first: 10 })
    assert.equal(res.result.isError, false)
    const parsed = JSON.parse(textOf(res))
    // Flattening this envelope is the defect: an unreadable chain must not lose its state.
    assert.equal(parsed.chains['1'].state, 'unreadable')
    assert.equal(parsed.chains['8453'].state, 'not-configured')
    assert.equal(parsed.partial, true)
    assert.deepEqual(gateway.requests[0].query, { chainId: '137', first: '10' })
  })
})

test('an upstream 503 is isError with the gateway’s own code, and says the answer is unknown', async () => {
  const routes = {
    'GET /v1/member/wagers': {
      status: 503,
      body: { error: { code: 'membership_unreadable', reason: 'membership could not be read' } },
    },
  }
  await withGateway(routes, async ({ handler }) => {
    const res = await call(handler, 'get_wagers')
    assert.equal(res.result.isError, true)
    const text = textOf(res)
    assert.match(text, /membership_unreadable/)
    assert.match(text, /membership could not be read/)
    assert.match(text, /UNKNOWN, not an empty result/)
    // Nothing that could be mistaken for data.
    assert.ok(!text.includes('"wagers"'))
  })
})

test('a 429 carries the Retry-After the gateway set', async () => {
  const routes = {
    'GET /v1/member/fees': {
      status: 429,
      headers: { 'retry-after': '30' },
      body: { error: { code: 'quota_exceeded', reason: 'global member API quota exceeded' } },
    },
  }
  await withGateway(routes, async ({ handler }) => {
    const res = await call(handler, 'get_fees')
    assert.equal(res.result.isError, true)
    assert.match(textOf(res), /quota_exceeded/)
    assert.match(textOf(res), /Retry after 30s/)
  })
})

test('with FAIRWINS_API_URL unset the server still answers, with a configuration error', async () => {
  const { handler, api } = buildServer({ env: {} })
  assert.equal(api.configured, false)

  // The protocol still works — that is the point of not exiting on a missing env.
  const listed = await handler.handle(rpc(9, 'tools/list'))
  assert.equal(listed.result.tools.length, SERVED_TOOL_COUNT)

  const res = await call(handler, 'get_profile')
  assert.equal(res.result.isError, true)
  assert.match(textOf(res), /api_unconfigured/)
  assert.match(textOf(res), /FAIRWINS_API_URL/)
})

test('with no token the member tools say so, while the public ones still work', async () => {
  await startStubGateway({ 'GET /v1/perps/pairs': { body: { pairs: [], sources: {} } } }).then(async (gateway) => {
    try {
      const { handler } = buildServer({ env: { FAIRWINS_API_URL: gateway.url } })

      const denied = await call(handler, 'get_membership')
      assert.equal(denied.result.isError, true)
      assert.match(textOf(denied), /token_missing/)
      assert.match(textOf(denied), /Settings ▸ API access/)

      const allowed = await call(handler, 'get_perps_pairs')
      assert.equal(allowed.result.isError, false)
      assert.equal(gateway.requests.at(-1).headers.authorization, undefined)
    } finally {
      await gateway.close()
    }
  })
})

test('build_intent posts action/chainId/params and never sends an account of its own', async () => {
  const built = {
    action: 'createWager',
    chainId: 137,
    authOnly: false,
    typedData: { domain: { name: 'FairWins Wager' }, types: {}, primaryType: 'CreateWager', message: { creator: '0xabc' } },
    target: '0xregistry',
    submitVia: { relay: '/v1/intents', selfSubmit: 'submit it yourself' },
  }
  await withGateway({ 'POST /v1/member/intents/build': { body: built } }, async ({ handler, gateway }) => {
    const res = await call(handler, 'build_intent', { action: 'createWager', chainId: 137, params: { stake: '1' } })
    assert.equal(res.result.isError, false)
    assert.deepEqual(JSON.parse(textOf(res)), built)

    const sent = gateway.requests[0]
    assert.equal(sent.method, 'POST')
    assert.deepEqual(Object.keys(sent.body).sort(), ['action', 'chainId', 'params'])
    assert.deepEqual(sent.body.params, { stake: '1' })
  })
})

test('a refused action is reported with its reason, not retried into something else', async () => {
  const routes = {
    'POST /v1/member/intents/build': {
      status: 400,
      body: { error: { code: 'action_not_relayable', reason: 'invalidateNonce is deliberately not built or relayed here' } },
    },
  }
  await withGateway(routes, async ({ handler }) => {
    const res = await call(handler, 'build_intent', { action: 'invalidateNonce', chainId: 137 })
    assert.equal(res.result.isError, true)
    assert.match(textOf(res), /action_not_relayable/)
    assert.match(textOf(res), /deliberately not built/)
  })
})

test('get_gateway_status and get_prediction_markets are public reads', async () => {
  const routes = {
    'GET /status': { body: { status: 'ok', memberApi: { enabled: true, assistant: { configured: false } } } },
    'GET /v1/polymarket/137/markets': { body: { markets: [{ question: 'will it rain' }], next: null } },
  }
  await withGateway(routes, async ({ handler, gateway }) => {
    const status = await call(handler, 'get_gateway_status')
    assert.equal(status.result.isError, false)
    assert.match(textOf(status), /memberApi/)

    const markets = await call(handler, 'get_prediction_markets', { q: 'rain' })
    assert.equal(markets.result.isError, false)
    assert.deepEqual(gateway.requests.at(-1).query, { q: 'rain' })
    assert.equal(gateway.requests.at(-1).path, '/v1/polymarket/137/markets')
    for (const request of gateway.requests) assert.equal(request.headers.authorization, undefined)
  })
})

test('a per-call token overrides the process token for that call only', async () => {
  await withGateway({ 'GET /v1/member/me': { body: { account: '0xdef' } } }, async ({ handler, gateway }) => {
    await call(handler, 'get_profile', {}, { token: 'fw1.other.token' })
    assert.equal(gateway.requests[0].headers.authorization, 'Bearer fw1.other.token')
    await call(handler, 'get_profile')
    assert.equal(gateway.requests[1].headers.authorization, `Bearer ${TOKEN}`)
  })
})

test('an unreachable gateway is reported as unreachable, not as no data', async () => {
  // A port that is closed: the connection is refused immediately.
  const gateway = await startStubGateway({})
  const url = gateway.url
  await gateway.close()

  const { handler } = buildServer({ env: { FAIRWINS_API_URL: url, FAIRWINS_API_TOKEN: TOKEN } })
  const res = await call(handler, 'get_membership')
  assert.equal(res.result.isError, true)
  assert.match(textOf(res), /api_unreachable/)
  assert.match(textOf(res), /UNKNOWN, not an empty result/)
})

test('a bounded timeout ends a hung read rather than hanging the agent', async () => {
  const gateway = await startStubGateway({ 'GET /v1/member/me': () => new Promise(() => {}) })
  try {
    const { handler } = buildServer({
      env: { FAIRWINS_API_URL: gateway.url, FAIRWINS_API_TOKEN: TOKEN, FAIRWINS_TIMEOUT_MS: '150' },
    })
    const res = await call(handler, 'get_profile')
    assert.equal(res.result.isError, true)
    assert.match(textOf(res), /api_timeout/)
  } finally {
    await gateway.close()
  }
})

// ── spec 104: the shared definitions come from the vendored snapshot ─────────────────────────

test('every shared tool is served EXACTLY as the snapshot defines it, and the local one is not served', async () => {
  const { TOOL_SNAPSHOT } = await import('../src/tools.js')
  const { handler } = buildServer({ env: {} })
  const { tools } = (await handler.handle(rpc(1, 'tools/list'))).result
  const byName = new Map(tools.map((t) => [t.name, t]))

  for (const def of TOOL_SNAPSHOT) {
    if (def.auth === 'local') {
      // find_in_app searches the SPA's navigation index in the browser; there is no gateway route
      // behind it, so this server must not advertise it.
      assert.equal(byName.has(def.name), false, `${def.name} is browser-local and must not be served here`)
      const res = await call(handler, def.name)
      assert.equal(res.error.code, -32602)
      continue
    }
    const served = byName.get(def.name)
    assert.ok(served, `${def.name} is in the snapshot but not served`)
    assert.equal(served.title, def.title)
    assert.equal(served.description, def.description)
    assert.deepEqual(served.inputSchema, def.inputSchema)
  }
  // build_intent is the one MCP-only tool: defined in tools.js, deliberately absent from the
  // snapshot (the in-app assistant must not carry a tool that returns something signable).
  assert.ok(byName.has('build_intent'))
  assert.equal(TOOL_SNAPSHOT.some((d) => d.name === 'build_intent'), false)
  assert.equal(tools.length, TOOL_SNAPSHOT.filter((d) => d.auth !== 'local').length + 1)
})

test('a snapshot tool bound to a route this server cannot map fails at boot, not in a call', async () => {
  const { ROUTE_PATHS, TOOL_SNAPSHOT } = await import('../src/tools.js')
  for (const def of TOOL_SNAPSHOT) {
    if (def.exec.kind === 'route') assert.ok(ROUTE_PATHS[def.exec.route], `${def.name} names route "${def.exec.route}" with no path here`)
  }
})
