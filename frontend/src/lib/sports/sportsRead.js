/**
 * One gateway read for the sports routes (spec 115) — the machinery the game feed and the fight feed share,
 * and NOTHING they must not: each feed makes its OWN reader, so what one remembers (a module that is not
 * there) never stops the other asking (FR-020: the fight view off must not touch the game view, nor the reverse).
 *
 * A reader sorts every answer into exactly three outcomes — `ok` (whatever the caller's `parse` made of the body, or `failed` when it makes nothing), `absent`
 * (the module is off or the gateway predates it: draw NOTHING, FR-013) and `failed` (transport, timeout, an
 * outage, an answer that does not parse: keep what is on screen and let it age) — and keeps two things:
 *
 *  - `inflight`: a read already on its way is SHARED (StrictMode mounts an effect twice in development, and two
 *    surfaces can mount for the same id);
 *  - `missing`: the gateway said the module is not there (404, or a 503 carrying one of THIS reader's
 *    `rememberCodes`) — a fact about the DEPLOYMENT, kept until reload. A pause (`sports_paused`,
 *    `killswitch_active`) is "absent" for now but deliberately not remembered: it is lifted without a deploy.
 */
import { predictGatewayUrl } from '../predict/predictClient'

const FETCH_TIMEOUT_MS = 8_000
const PAUSE_CODES = ['sports_paused', 'killswitch_active']

export function createSportsReader({ rememberCodes }) {
  const remember = new Set(rememberCodes)
  const off = new Set([...rememberCodes, ...PAUSE_CODES])
  const inflight = new Map()
  let missing = false

  async function run(doFetch, url, parse) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await doFetch(url, { signal: controller.signal })
      if (res.status === 404) {
        missing = true
        return { kind: 'absent' }
      }
      if (res.status === 503) {
        let code = null
        try {
          code = (await res.json())?.error?.code ?? null
        } catch {
          /* a 503 with no body is an outage, not the module speaking */
        }
        if (remember.has(code)) missing = true
        // Only the module's own words mean "off". A bare 503 is a gateway/proxy outage: keep trying.
        return off.has(code) ? { kind: 'absent' } : { kind: 'failed' }
      }
      if (!res.ok) return { kind: 'failed' }
      const parsed = parse(await res.json())
      return parsed ? { kind: 'ok', ...parsed } : { kind: 'failed' }
    } catch {
      return { kind: 'failed' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /** `path` is everything after the gateway base, query included. */
    read(path, { parse, fetchImpl } = {}) {
      const base = predictGatewayUrl()
      if (!base || missing) return Promise.resolve({ kind: 'absent' })
      const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
      if (!doFetch) return Promise.resolve({ kind: 'failed' })
      const url = `${base}${path}`
      const running = inflight.get(url)
      if (running) return running
      const p = run(doFetch, url, parse).finally(() => inflight.delete(url))
      inflight.set(url, p)
      return p
    },
    reset() {
      inflight.clear()
      missing = false
    },
  }
}
