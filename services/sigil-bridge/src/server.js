// Spec 111 — the loopback HTTP face of the Sigil daemon, for a browser tab on this computer.
//
// Sigil's own constitution puts every HTTP listener OUTSIDE its trusted computing base (Principle I,
// III; SECURITY.md invariant 3: "a remote client builds its own transport, out of TCB, against a
// deliberately chosen interface"). This is that transport. It is deliberately narrow, and each
// narrowing is a defence against a named attacker:
//
//   * a malicious WEB PAGE in another tab    → Origin allowlist (no wildcard, ever) + a bearer
//                                              pairing token the page cannot know + JSON-only bodies
//   * DNS REBINDING (evil.example → 127.0.0.1) → the Host header must name the loopback listener
//   * another LOCAL USER                      → token file 0600; the daemon socket is still guarded
//                                              by its own group permission underneath us
//   * key exfiltration                        → there is no route that accepts or returns key
//                                              material; the daemon client has no import function
//
// What this bridge does NOT add is a second consent step by default: Sigil's consent is the disk
// being physically present, one presignature burned per signature. `--confirm` adds an operator
// prompt on this terminal for members who want a human "yes" on every signature as well.

import http from 'node:http'
import crypto from 'node:crypto'
import { DaemonError } from './daemon.js'

export const BRIDGE_VERSION = '1.0.0'
const MAX_BODY = 8 * 1024
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const HEX_PUBKEY = /^(0x)?(02|03)[0-9a-fA-F]{64}$/
const HEX_SIG = /^[0-9a-fA-F]{128}$/

export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const fail = (status, code, message) => {
  throw new BridgeError(status, code, message)
}

/** Constant-time token comparison that does not leak the expected length through an early exit. */
export function tokenMatches(presented, expected) {
  const a = crypto.createHash('sha256').update(String(presented ?? '')).digest()
  const b = crypto.createHash('sha256').update(String(expected)).digest()
  return crypto.timingSafeEqual(a, b) && String(presented ?? '').length === String(expected).length
}

/** Normalize an origin for comparison (scheme + host + port, lowercased, no trailing slash). */
export function normalizeOrigin(value) {
  try {
    const u = new URL(String(value))
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin.toLowerCase()
  } catch {
    return null
  }
}

/** Whether a Host header names this listener on a loopback name (DNS-rebinding defence). */
export function hostIsAllowed(hostHeader, port, extraHosts = []) {
  if (!hostHeader) return false
  const host = String(hostHeader).toLowerCase()
  const names = ['127.0.0.1', 'localhost', '[::1]', ...extraHosts.map((h) => String(h).toLowerCase())]
  return names.some((n) => host === `${n}:${port}` || (port === 80 && host === n))
}

const describe = (text, max = 200) => {
  const s = String(text ?? '').replace(/[^\x20-\x7E]/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const strip0x = (h) => String(h).replace(/^0x/i, '').toLowerCase()

function diskView(status) {
  return {
    detected: Boolean(status.detected),
    childId: status.child_id ?? null,
    publicKey: status.child_pubkey ? `0x${strip0x(status.child_pubkey)}` : null,
    presigsRemaining: status.presigs_remaining ?? null,
    presigsTotal: status.presigs_total ?? null,
    daysUntilExpiry: status.days_until_expiry ?? null,
    valid: status.is_valid ?? null,
  }
}

function daemonFailure(err) {
  if (err instanceof BridgeError) return err
  if (err instanceof DaemonError) {
    if (err.kind === 'unreachable') return new BridgeError(503, 'daemon_unreachable', err.message)
    if (err.kind === 'timeout') return new BridgeError(504, 'daemon_timeout', err.message)
    if (err.kind === 'refused') return new BridgeError(502, 'daemon_refused', err.message)
    return new BridgeError(502, 'daemon_protocol', err.message)
  }
  return new BridgeError(500, 'internal', 'The bridge failed unexpectedly.')
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '')
  // Requiring JSON makes every POST a CORS-preflighted request: a page cannot send a "simple"
  // text/plain form post here and have it reach the handler before the Origin check.
  if (!type.toLowerCase().startsWith('application/json')) {
    fail(415, 'bad_request', 'Requests must be application/json.')
  }
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) fail(413, 'bad_request', 'Request body too large.')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail(400, 'bad_request', 'Request body is not valid JSON.')
  }
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./daemon.js').createDaemonClient>} opts.daemon
 * @param {string} opts.token the pairing token (required)
 * @param {string[]} opts.allowedOrigins exact origins allowed to call (required, non-empty)
 * @param {number|(() => number)} opts.port the port this listener is bound to (for the Host check);
 *   a function when the port is only known after `listen(0)`
 * @param {string[]} [opts.extraHosts] additional Host names, only when bound beyond loopback
 * @param {(req: { description: string, digest: string, chainId: number, childId: string|null }) => Promise<boolean>} [opts.confirm]
 * @param {(line: string) => void} [opts.log]
 */
export function createBridgeHandler({ daemon, token, allowedOrigins, port, extraHosts = [], confirm = null, log = () => {} }) {
  if (!token || String(token).length < 32) throw new Error('A pairing token of at least 32 characters is required.')
  const portOf = typeof port === 'function' ? port : () => port
  const origins = new Set((allowedOrigins || []).map(normalizeOrigin).filter(Boolean))
  if (origins.size === 0) throw new Error('At least one allowed origin is required; the bridge never serves a wildcard.')

  // One signature at a time. The daemon burns a presignature and rewrites the disk per signature;
  // serializing here means two tabs can never interleave on the same floppy.
  let signQueue = Promise.resolve()
  const serialized = (fn) => {
    const run = signQueue.then(fn, fn)
    signQueue = run.catch(() => {})
    return run
  }

  const routes = {
    'GET /v1/health': async () => ({ service: 'sigil-bridge', version: BRIDGE_VERSION }),

    'POST /v1/status': async () => {
      const pong = await daemon.ping()
      const status = await daemon.diskStatus()
      return { daemon: { version: pong.version ?? null }, disk: diskView(status) }
    },

    'POST /v1/sign': async (body) => {
      const digest = String(body.digest ?? '')
      if (!HEX32.test(digest)) fail(400, 'bad_request', '`digest` must be a 0x-prefixed 32-byte hex hash.')
      const chainId = Number(body.chainId ?? 0)
      if (!Number.isInteger(chainId) || chainId < 0 || chainId > 0xffffffff) {
        fail(400, 'bad_request', '`chainId` must be an integer between 0 and 4294967295.')
      }
      const description = describe(body.description)
      if (!description) fail(400, 'bad_request', '`description` is required; it is written to the disk usage log.')
      const expected = body.expectedPublicKey == null ? null : String(body.expectedPublicKey)
      if (expected !== null && !HEX_PUBKEY.test(expected)) {
        fail(400, 'bad_request', '`expectedPublicKey` must be a 33-byte compressed public key.')
      }

      return serialized(async () => {
        // Check the disk BEFORE asking for a signature, so every refusable state is refused
        // without burning a presignature, and is named rather than surfaced as daemon prose.
        const disk = diskView(await daemon.diskStatus())
        if (!disk.detected) fail(409, 'no_disk', 'No Sigil disk is inserted.')
        if (disk.valid === false) fail(409, 'disk_invalid', 'The inserted Sigil disk has expired or failed validation.')
        if (disk.presigsRemaining === 0) fail(409, 'disk_exhausted', 'The inserted Sigil disk has no presignatures left.')
        if (expected && disk.publicKey && strip0x(expected) !== strip0x(disk.publicKey)) {
          fail(409, 'wrong_disk', 'The inserted Sigil disk is not the one this account belongs to.')
        }

        if (confirm) {
          const ok = await confirm({ description, digest, chainId, childId: disk.childId })
          if (!ok) fail(403, 'operator_declined', 'The signature was declined at the bridge.')
        }

        const res = await daemon.sign({ digestHex: digest, chainId, description })
        const signature = strip0x(res.signature)
        if (!HEX_SIG.test(signature)) fail(502, 'daemon_protocol', 'The Sigil daemon returned a signature of the wrong length.')
        log(`signed presig #${res.presig_index} on disk ${disk.childId ?? '?'} (chain ${chainId}): ${description}`)
        return {
          signature: `0x${signature}`,
          presigIndex: res.presig_index,
          // The daemon's `proof_hash` is deliberately NOT forwarded: today it is a hash of public
          // data, not a proof of execution (chippr-robotics/sigil#67). Passing it on under a
          // "proof" name would invite a client to treat it as one.
          presigsRemaining: disk.presigsRemaining == null ? null : Math.max(0, disk.presigsRemaining - 1),
        }
      })
    },

    'POST /v1/tx-hash': async (body) => {
      const presigIndex = Number(body.presigIndex)
      if (!Number.isInteger(presigIndex) || presigIndex < 0) fail(400, 'bad_request', '`presigIndex` must be a non-negative integer.')
      const txHash = String(body.txHash ?? '')
      if (!HEX32.test(txHash)) fail(400, 'bad_request', '`txHash` must be a 0x-prefixed 32-byte hex hash.')
      await daemon.updateTxHash({ presigIndex, txHashHex: txHash })
      return { recorded: true }
    },
  }

  return async function handle(req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      res.end(JSON.stringify(body))
    }

    // 1. DNS rebinding: a page that resolved its own hostname to 127.0.0.1 still sends its own
    //    hostname in Host. Refuse before anything else, CORS headers included.
    if (!hostIsAllowed(req.headers.host, portOf(), extraHosts)) {
      return send(421, { ok: false, error: { code: 'bad_host', message: 'Unexpected Host header.' } })
    }

    // 2. Origin: a browser always sends one cross-origin. An unlisted origin gets no CORS headers
    //    and no handler — its page cannot even read the refusal.
    const rawOrigin = req.headers.origin
    const origin = rawOrigin ? normalizeOrigin(rawOrigin) : null
    if (rawOrigin && (!origin || !origins.has(origin))) {
      return send(403, { ok: false, error: { code: 'origin_not_allowed', message: 'This origin may not use the bridge.' } })
    }
    const cors = origin
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : {}

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'authorization, content-type',
        // Chrome's Private/Local Network Access: a public https page reaching 127.0.0.1 is only
        // allowed when the loopback server opts in on the preflight.
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
      })
      return res.end()
    }

    const url = new URL(req.url, 'http://bridge.local')
    const key = `${req.method} ${url.pathname}`
    const route = routes[key]
    try {
      if (!route) fail(404, 'not_found', 'No such route.')
      if (key !== 'GET /v1/health') {
        const auth = String(req.headers.authorization || '')
        const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!tokenMatches(presented, token)) fail(401, 'unauthorized', 'Missing or wrong pairing token.')
      }
      const body = req.method === 'POST' ? await readJson(req) : {}
      const result = await route(body)
      return send(200, { ok: true, ...result }, cors)
    } catch (err) {
      const e = daemonFailure(err)
      if (e.status >= 500) log(`error ${e.code}: ${e.message}`)
      return send(e.status, { ok: false, error: { code: e.code, message: e.message } }, cors)
    }
  }
}

export function createBridgeServer(opts) {
  return http.createServer(createBridgeHandler(opts))
}
