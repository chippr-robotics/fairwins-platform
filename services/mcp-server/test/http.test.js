/** The HTTP transport: healthz, /mcp, the per-request bearer override, and what is refused (spec 095). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../src/server.js'
import { createHttpTransport, bearerFrom } from '../src/transport/http.js'
import { parseMessage, toErrorResponse } from '../src/jsonrpc.js'
import { postMcp, rpc, startStubGateway } from './helpers.js'

const TOKEN = 'fw1.env.token'

/** Start the real transport in front of the real handler, on an ephemeral port. */
async function withHttp(routes, run, env = {}) {
  const gateway = await startStubGateway(routes)
  const { handler } = buildServer({
    env: { FAIRWINS_API_URL: gateway.url, FAIRWINS_API_TOKEN: TOKEN, ...env },
  })
  const server = createHttpTransport({
    handle: handler.handle,
    parse: parseMessage,
    onParseError: (err) => toErrorResponse(null, err),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run({ base, gateway })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await gateway.close()
  }
}

test('GET /healthz answers { status: "ok" }', async () => {
  await withHttp({}, async ({ base }) => {
    const res = await fetch(`${base}/healthz`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
  })
})

test('POST /mcp carries one JSON-RPC message and returns its answer', async () => {
  await withHttp({}, async ({ base }) => {
    const { status, body } = await postMcp(base, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))
    assert.equal(status, 200)
    assert.equal(body.id, 1)
    assert.equal(body.result.serverInfo.name, 'fairwins-mcp')
  })
})

test('a per-request Authorization header overrides the env token, for that request only', async () => {
  await withHttp({ 'GET /v1/member/me': { body: { account: '0xabc' } } }, async ({ base, gateway }) => {
    await postMcp(base, rpc(1, 'tools/call', { name: 'get_profile', arguments: {} }), {
      authorization: 'Bearer fw1.caller.token',
    })
    assert.equal(gateway.requests[0].headers.authorization, 'Bearer fw1.caller.token')

    await postMcp(base, rpc(2, 'tools/call', { name: 'get_profile', arguments: {} }))
    assert.equal(gateway.requests[1].headers.authorization, `Bearer ${TOKEN}`)
  })
})

test('a notification is answered with 202 and no body', async () => {
  await withHttp({}, async ({ base }) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(res.status, 202)
    assert.equal(await res.text(), '')
  })
})

test('malformed JSON comes back as a JSON-RPC parse error addressed to null, not an HTTP 400', async () => {
  await withHttp({}, async ({ base }) => {
    const { status, body } = await postMcp(base, '{ not json')
    assert.equal(status, 200)
    assert.equal(body.id, null)
    assert.equal(body.error.code, -32700)
  })
})

test('an oversized body is refused with 413 and the nested error shape', async () => {
  await withHttp({}, async ({ base }) => {
    const huge = JSON.stringify(rpc(1, 'tools/call', { name: 'build_intent', arguments: { blob: 'x'.repeat(400_000) } }))
    const { status, body } = await postMcp(base, huge)
    assert.equal(status, 413)
    assert.equal(body.error.code, 'too_large')
  })
})

test('unknown paths 404 and a GET on /mcp is 405 — both with a machine-readable code', async () => {
  await withHttp({}, async ({ base }) => {
    const missing = await fetch(`${base}/v1/anything`)
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'not_found')

    const wrongMethod = await fetch(`${base}/mcp`)
    assert.equal(wrongMethod.status, 405)
    assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed')
  })
})

test('no CORS header is ever sent — agents are not browsers, and a wildcard here would be scriptable', async () => {
  await withHttp({}, async ({ base }) => {
    const health = await fetch(`${base}/healthz`, { headers: { origin: 'https://evil.example' } })
    assert.equal(health.headers.get('access-control-allow-origin'), null)

    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(rpc(1, 'ping')),
    })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    assert.equal(res.headers.get('access-control-allow-credentials'), null)
    // And a preflight is not answered into existence either.
    const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS' })
    assert.equal(preflight.status, 405)
    assert.equal(preflight.headers.get('access-control-allow-methods'), null)
  })
})

test('bearerFrom reads the header case-insensitively and treats a malformed one as absent', () => {
  assert.equal(bearerFrom({ authorization: 'Bearer abc' }), 'abc')
  assert.equal(bearerFrom({ authorization: 'bearer   abc  ' }), 'abc')
  assert.equal(bearerFrom({ authorization: 'Basic abc' }), null)
  assert.equal(bearerFrom({}), null)
  assert.equal(bearerFrom({ authorization: 'Bearer' }), null)
  // The scheme and the credential have to be separated — "Bearerabc" is not a bearer header.
  assert.equal(bearerFrom({ authorization: 'Bearerabc' }), null)
  assert.equal(bearerFrom({ authorization: 'Bearer  a b  ' }), 'a b')
  assert.equal(bearerFrom({ Authorization: 'BEARER abc' }), 'abc')
  assert.equal(bearerFrom({ authorization: 42 }), null)
})

test('bearerFrom stays linear on a hostile header rather than backtracking over it', () => {
  // A long run of spaces followed by a credential `.` cannot match to the end is the rejecting
  // input a `/^Bearer\s+(.+)$/` costs quadratic time on: every one of the n ways to split the run
  // between `\s+` and `.+` is tried and fails. Node hands us up to --max-http-header-size bytes of
  // whatever a caller sent, so the answer has to be cheap as well as correct.
  const hostile = (n) => `Bearer${' '.repeat(n)}a\nb`
  assert.equal(bearerFrom({ authorization: hostile(16) }), null)
  // A line terminator INSIDE the separating whitespace was always fine, and still is.
  assert.equal(bearerFrom({ authorization: 'Bearer \n x' }), 'x')

  const elapsed = (n) => {
    const started = process.hrtime.bigint()
    bearerFrom({ authorization: hostile(n) })
    return Number(process.hrtime.bigint() - started)
  }
  elapsed(1000) // warm the function up so the first measurement is not the compile
  // One sample per size is at the mercy of a GC pause or scheduler preemption on a shared CI
  // runner (observed: 54µs -> 453µs, 8.4x on 4x input, against a function that is linear).
  // Noise only ever ADDS time, so the minimum over a few runs is the honest estimate of the
  // curve's shape at each size.
  const best = (n) => Math.min(...Array.from({ length: 5 }, () => elapsed(n)))
  const small = Math.max(best(20_000), 1)
  const large = best(80_000)
  // Four times the input. Quadratic would be ~16x; the generous ceiling here is about proving the
  // shape of the curve, not about timing precision on a shared runner.
  assert.ok(large < small * 8, `expected linear-ish growth, got ${small}ns -> ${large}ns`)
})
