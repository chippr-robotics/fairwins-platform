import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createDaemonClient } from '../src/daemon.js'
import { createBridgeServer, hostIsAllowed, tokenMatches } from '../src/server.js'
import { startFakeDaemon, defaultDisk, PUBKEY, SIGNATURE } from './helpers.js'

const TOKEN = 'a'.repeat(64)
const ORIGIN = 'https://app.fairwins.example'
const DIGEST = `0x${'11'.repeat(32)}`

async function startBridge(daemonOpts, bridgeOpts = {}) {
  const daemon = await startFakeDaemon(daemonOpts)
  // Bind first on an ephemeral port, then build the handler with the real port for the Host check.
  const holder = {}
  const server = createBridgeServer({
    daemon: createDaemonClient({ socketPath: daemon.socketPath, signTimeoutMs: 2000 }),
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    port: () => holder.port,
    ...bridgeOpts,
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  holder.port = server.address().port
  return {
    daemon,
    port: holder.port,
    url: `http://127.0.0.1:${holder.port}`,
    async close() {
      await new Promise((r) => server.close(r))
      await daemon.close()
    },
  }
}

function call(b, route, { method = 'POST', body, token = TOKEN, origin = ORIGIN, headers = {} } = {}) {
  return fetch(`${b.url}${route}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
}

describe('construction refuses unsafe configurations', () => {
  test('no origins, or a short token, is a startup failure — never a wildcard', () => {
    const daemon = createDaemonClient({ socketPath: '/nonexistent' })
    assert.throws(() => createBridgeServer({ daemon, token: TOKEN, allowedOrigins: [], port: 1 }), /allowed origin/)
    assert.throws(() => createBridgeServer({ daemon, token: 'short', allowedOrigins: [ORIGIN], port: 1 }), /token/)
  })

  test('tokenMatches is exact', () => {
    assert.equal(tokenMatches(TOKEN, TOKEN), true)
    assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false)
    assert.equal(tokenMatches('', TOKEN), false)
    assert.equal(tokenMatches(undefined, TOKEN), false)
  })

  test('hostIsAllowed only names the loopback listener', () => {
    assert.equal(hostIsAllowed('127.0.0.1:7318', 7318), true)
    assert.equal(hostIsAllowed('localhost:7318', 7318), true)
    assert.equal(hostIsAllowed('evil.example:7318', 7318), false)
    assert.equal(hostIsAllowed('127.0.0.1:7319', 7318), false)
    assert.equal(hostIsAllowed(undefined, 7318), false)
  })
})

describe('the browser boundary', () => {
  let b
  before(async () => {
    b = await startBridge()
  })
  after(() => b.close())

  test('health answers without a token and says nothing about the disk', async () => {
    const res = await call(b, '/v1/health', { method: 'GET', token: null })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.service, 'sigil-bridge')
    assert.equal(json.disk, undefined)
    assert.equal(b.daemon.requests.length, 0, 'health must not touch the daemon')
  })

  test('an unlisted origin is refused with NO CORS headers and never reaches the daemon', async () => {
    const before = b.daemon.requests.length
    const res = await call(b, '/v1/status', { origin: 'https://evil.example' })
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    assert.equal(b.daemon.requests.length, before)
  })

  test('the preflight for the allowed origin opts in to private-network access', async () => {
    const res = await fetch(`${b.url}/v1/sign`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN)
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true')
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/)
  })

  test('a missing or wrong token is 401 and never reaches the daemon', async () => {
    const before = b.daemon.requests.length
    for (const token of [null, 'b'.repeat(64)]) {
      const res = await call(b, '/v1/sign', { token, body: { digest: DIGEST, chainId: 1, description: 'x' } })
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN, 'the page may read WHY it was refused')
    }
    assert.equal(b.daemon.requests.length, before)
  })

  test('a rebinding Host header is refused before anything else', async () => {
    // fetch() will not let a caller set Host, which is exactly why a rebinding page CAN'T either —
    // it can only send its own hostname. Reproduce that with a raw request.
    const before = b.daemon.requests.length
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: b.port, path: '/v1/status', method: 'POST',
          headers: { host: `evil.example:${b.port}`, origin: ORIGIN, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } },
        (res) => { res.resume(); resolve(res.statusCode) },
      )
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(status, 421)
    assert.equal(b.daemon.requests.length, before)
  })

  test('a non-JSON body is refused (no simple-request path to the handler)', async () => {
    const res = await fetch(`${b.url}/v1/sign`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
      body: JSON.stringify({ digest: DIGEST, chainId: 1, description: 'x' }),
    })
    assert.equal(res.status, 415)
  })

  test('there is no route that imports key material', async () => {
    for (const route of ['/v1/import-agent-shard', '/v1/import-child-shares', '/api/import-agent-shard']) {
      const res = await call(b, route, { body: { agent_shard_hex: 'aa'.repeat(32) } })
      assert.equal(res.status, 404, route)
    }
    assert.ok(!b.daemon.requests.some((r) => String(r.type).startsWith('Import')))
  })
})

describe('status and signing', () => {
  test('status reports the disk and its public key', async () => {
    const b = await startBridge()
    try {
      const json = await (await call(b, '/v1/status')).json()
      assert.equal(json.ok, true)
      assert.equal(json.daemon.version, '0.6.0')
      assert.deepEqual(json.disk, {
        detected: true,
        childId: '9e8d7c6b',
        publicKey: `0x${PUBKEY}`,
        presigsRemaining: 742,
        presigsTotal: 1000,
        daysUntilExpiry: 30,
        valid: true,
      })
    } finally {
      await b.close()
    }
  })

  test('a sign forwards exactly the digest, chain and description to the daemon', async () => {
    const b = await startBridge()
    try {
      const res = await call(b, '/v1/sign', {
        body: { digest: DIGEST, chainId: 137, description: 'Send 1 POL to 0xabc', expectedPublicKey: `0x${PUBKEY}` },
      })
      assert.equal(res.status, 200)
      const json = await res.json()
      assert.equal(json.signature, `0x${SIGNATURE}`)
      assert.equal(json.presigIndex, 258)
      assert.equal(json.presigsRemaining, 741)
      // The daemon's proof_hash is not a proof of execution today (sigil#67); it is never forwarded
      // under any name a client could mistake for one.
      assert.ok(!Object.keys(json).some((k) => /proof/i.test(k)), `no proof field: ${Object.keys(json)}`)
      const signReq = b.daemon.requests.find((r) => r.type === 'Sign')
      assert.deepEqual(signReq, { type: 'Sign', message_hash: DIGEST, chain_id: 137, description: 'Send 1 POL to 0xabc' })
    } finally {
      await b.close()
    }
  })

  test('each refusable disk state is refused BY NAME without burning a presignature', async () => {
    const cases = [
      [{ detected: false, child_pubkey: undefined }, 'no_disk'],
      [{ is_valid: false }, 'disk_invalid'],
      [{ presigs_remaining: 0 }, 'disk_exhausted'],
    ]
    for (const [override, code] of cases) {
      const b = await startBridge({ disk: defaultDisk(override) })
      try {
        const res = await call(b, '/v1/sign', { body: { digest: DIGEST, chainId: 1, description: 'x' } })
        assert.equal(res.status, 409, code)
        assert.equal((await res.json()).error.code, code)
        assert.ok(!b.daemon.requests.some((r) => r.type === 'Sign'), `${code}: no Sign may be sent`)
      } finally {
        await b.close()
      }
    }
  })

  test('the wrong disk is refused before it spends a presignature', async () => {
    const b = await startBridge()
    try {
      const res = await call(b, '/v1/sign', {
        body: { digest: DIGEST, chainId: 1, description: 'x', expectedPublicKey: `03${'ef'.repeat(32)}` },
      })
      assert.equal(res.status, 409)
      assert.equal((await res.json()).error.code, 'wrong_disk')
      assert.ok(!b.daemon.requests.some((r) => r.type === 'Sign'))
    } finally {
      await b.close()
    }
  })

  test('malformed requests are 400 and never reach the daemon', async () => {
    const b = await startBridge()
    try {
      const bodies = [
        { digest: '0x1234', chainId: 1, description: 'x' },
        { digest: DIGEST, chainId: -1, description: 'x' },
        { digest: DIGEST, chainId: 1, description: '' },
        { digest: DIGEST, chainId: 1, description: 'x', expectedPublicKey: 'nope' },
      ]
      for (const body of bodies) {
        const res = await call(b, '/v1/sign', { body })
        assert.equal(res.status, 400, JSON.stringify(body))
      }
      assert.ok(!b.daemon.requests.some((r) => r.type === 'Sign'))
    } finally {
      await b.close()
    }
  })

  test('an operator decline at --confirm is 403 and no signature is made', async () => {
    const seen = []
    const b = await startBridge(undefined, {
      confirm: async (req) => {
        seen.push(req)
        return false
      },
    })
    try {
      const res = await call(b, '/v1/sign', { body: { digest: DIGEST, chainId: 1, description: 'Approve USDC' } })
      assert.equal(res.status, 403)
      assert.equal((await res.json()).error.code, 'operator_declined')
      assert.equal(seen[0].description, 'Approve USDC')
      assert.ok(!b.daemon.requests.some((r) => r.type === 'Sign'))
    } finally {
      await b.close()
    }
  })

  test('a wrong-length signature from the daemon is not passed on', async () => {
    const b = await startBridge({ onSign: () => ({ type: 'SignResult', signature: 'ab'.repeat(65), presig_index: 1, proof_hash: '' }) })
    try {
      const res = await call(b, '/v1/sign', { body: { digest: DIGEST, chainId: 1, description: 'x' } })
      assert.equal(res.status, 502)
      assert.equal((await res.json()).error.code, 'daemon_protocol')
    } finally {
      await b.close()
    }
  })

  test('a daemon Error is surfaced as daemon_refused with its message', async () => {
    const b = await startBridge({ onSign: () => ({ type: 'Error', message: 'Disk rollback detected' }) })
    try {
      const res = await call(b, '/v1/sign', { body: { digest: DIGEST, chainId: 1, description: 'x' } })
      assert.equal(res.status, 502)
      const json = await res.json()
      assert.equal(json.error.code, 'daemon_refused')
      assert.match(json.error.message, /rollback/)
    } finally {
      await b.close()
    }
  })

  test('concurrent signatures are serialized, one presignature each', async () => {
    const b = await startBridge()
    try {
      const results = await Promise.all(
        [1, 2, 3].map((i) => call(b, '/v1/sign', { body: { digest: DIGEST, chainId: 1, description: `n${i}` } }).then((r) => r.json())),
      )
      const indexes = results.map((r) => r.presigIndex).sort()
      assert.deepEqual(indexes, [258, 259, 260])
      // Serialized means each Sign is preceded by its own status check, never two Signs back to back.
      const types = b.daemon.requests.map((r) => r.type)
      for (let i = 1; i < types.length; i += 1) {
        assert.ok(!(types[i] === 'Sign' && types[i - 1] === 'Sign'), 'two Signs were interleaved')
      }
    } finally {
      await b.close()
    }
  })

  test('tx-hash backfill forwards the presig index and hash', async () => {
    const b = await startBridge()
    try {
      const txHash = `0x${'22'.repeat(32)}`
      const res = await call(b, '/v1/tx-hash', { body: { presigIndex: 258, txHash } })
      assert.equal(res.status, 200)
      assert.deepEqual(b.daemon.requests.at(-1), { type: 'UpdateTxHash', presig_index: 258, tx_hash: txHash })
    } finally {
      await b.close()
    }
  })

  test('a daemon that is not running is 503 daemon_unreachable, not a crash', async () => {
    const b = await startBridge()
    await b.daemon.close()
    try {
      const res = await call(b, '/v1/status')
      assert.equal(res.status, 503)
      assert.equal((await res.json()).error.code, 'daemon_unreachable')
    } finally {
      await b.close().catch(() => {})
    }
  })
})
