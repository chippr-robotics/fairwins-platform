/**
 * Tool executor (spec 104) — binds one tool definition's `exec` to this browser's transports.
 *
 * `exec` IS DATA, NOT A FUNCTION. The tool table in `@fairwins/assistant-contract` says WHAT a tool
 * reads (`{ kind: 'route', route: 'wagers', query: [...] }`); this module says HOW, for the member's
 * own browser: a `route` is a member-API GET with the session grant in a header, a `public` exec is
 * an unauthenticated GET on the same gateway, and `local` runs in-page against the nav search index.
 * The MCP server binds the same table to its own `fetch`, and the gateway to its module functions —
 * three transports, one table.
 *
 * EVERYTHING IS A RESULT, NOTHING IS A THROW. A tool that throws would end the member's turn with a
 * stack trace where an answer should be; a tool that fails must instead become an `is_error`
 * `tool_result` the model can report honestly ("Polygon indexer did not answer"). So every path out
 * of `executeTool` is `{ ok: true, value }` or `{ ok: false, error: { code, reason, retryAfterSec } }`,
 * and a genuinely unexpected exception is `tool_failed` — never a rejection.
 *
 * WHAT THE MODEL MAY CONTROL, AND WHAT IT MAY NOT. Tool inputs are model-authored, and a model can be
 * steered by text in a previous result (research § 8.5). So: a query key reaches the URL only if the
 * table lists it; a path parameter is substituted only if the table names it, and only as a single
 * safe segment (`../keys` is refused, not encoded); the route id maps to a path THIS file knows; and
 * no input can choose a host, a method, or a header. The session token is the only credential that
 * ever leaves, it goes to the configured gateway only, and `local` tools see no credential at all.
 *
 * `find_in_app` reads the SAME index the drawer's search uses and is subject to the same rule — the
 * index is descriptive, never authoritative. It ranks over the tenant-filtered nav (`NAV_GROUPS`),
 * so a tenant-hidden surface is not found; chain-hidden items are a render-time fact this module
 * cannot know, and a hit is a place the member CAN NAVIGATE TO, whose surface then self-discloses.
 */
import { TOOL_TIMEOUT_MS } from '@fairwins/assistant-contract'
import { relayerBaseUrl } from '../../relay/intentClient'
import { queryTerms, rankEntries } from '../../nav/navSearch'
import {
  NAV_DESTINATIONS,
  NAV_ITEM_TERMS,
  OFF_MENU_ITEMS,
  pathForDestination,
} from '../../../config/navSearchIndex'
import { HOME_ITEM, NAV_GROUPS, PORTFOLIO_ITEM, pathForNavItem } from '../../../config/appNav'

/**
 * Member-API route ids → gateway paths. Mirrors `ROUTES[].path` in
 * services/relay-gateway/src/memberApi/contract.js for the routes the tool table names. A route id
 * absent here fails as a tool error, not as a request to a guessed path.
 */
export const ROUTE_PATHS = Object.freeze({
  me: '/v1/member/me',
  membership: '/v1/member/membership',
  wagers: '/v1/member/wagers',
  fees: '/v1/member/fees',
})

/** Defaults for path parameters the model left out. Polygon is where Predict lives (spec 057). */
export const PATH_PARAM_DEFAULTS = Object.freeze({ chainId: 137 })

/** Most hits `find_in_app` returns — enough to choose from, few enough to fit a tool result. */
export const FIND_IN_APP_LIMIT = 8

/** The one sentence for a search that found nothing. It is a fact: the index is local and complete. */
export const FIND_IN_APP_EMPTY_NOTE =
  'Nothing in the app matched that. The app’s own map was searched, so this is not a network failure — the surface may go by a different name, or may not exist.'

/** A path segment a model may supply: one token, no separators, no traversal. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/

const fail = (code, reason, retryAfterSec = null) => ({ ok: false, error: { code, reason, retryAfterSec } })

// ---------------------------------------------------------------------------
// HTTP execs — route (grant) and public (none)
// ---------------------------------------------------------------------------

/** Append the input keys the table lists, and only those. Missing or null keys are simply absent. */
function queryString(allowed, input) {
  if (!Array.isArray(allowed) || allowed.length === 0) return ''
  const params = new URLSearchParams()
  for (const key of allowed) {
    const value = input?.[key]
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const out = params.toString()
  return out ? `?${out}` : ''
}

/**
 * Substitute `{name}` (or `:name`) placeholders. `pathParams` may be a list of names or a
 * `{ name: default }` map; the value comes from the input, then that map, then `PATH_PARAM_DEFAULTS`.
 * Returns `{ path }` or `{ error }` — a bad value is refused, never encoded into a request.
 */
function substitutePath(path, pathParams, input) {
  const names = Array.isArray(pathParams) ? pathParams : Object.keys(pathParams || {})
  const defaults = Array.isArray(pathParams) ? {} : pathParams || {}
  let out = path
  for (const name of names) {
    const raw = input?.[name] ?? defaults[name] ?? PATH_PARAM_DEFAULTS[name]
    if (raw === undefined || raw === null) {
      return { error: fail('missing_input', `the "${name}" value is required and has no default`) }
    }
    const value = String(raw)
    if (!SAFE_SEGMENT.test(value)) {
      return { error: fail('invalid_input', `the "${name}" value is not something this tool can look up`) }
    }
    out = out.split(`{${name}}`).join(encodeURIComponent(value)).split(`:${name}`).join(encodeURIComponent(value))
  }
  return { path: out }
}

async function readBody(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** One bounded GET. Non-2xx becomes the gateway's own `{ error: { code, reason } }` where it sent one. */
async function httpGet({ url, headers, fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
  } catch (e) {
    return e?.name === 'AbortError'
      ? fail('timeout', `did not answer within ${Math.round(timeoutMs / 1000)} seconds`)
      : fail('unreachable', 'the gateway could not be reached from this device')
  } finally {
    clearTimeout(timer)
  }

  const body = await readBody(res)
  if (!res.ok) {
    const retryAfter = Number(res.headers?.get?.('Retry-After'))
    const code = typeof body?.error?.code === 'string' ? body.error.code : `http_${res.status}`
    const reason =
      typeof body?.error?.reason === 'string' ? body.error.reason : `the gateway answered HTTP ${res.status}`
    return fail(code, reason, Number.isFinite(retryAfter) ? retryAfter : null)
  }
  if (body === null) return fail('unreadable_response', 'the gateway answered, but not with something this app could read')
  return { ok: true, value: body }
}

// ---------------------------------------------------------------------------
// Local exec — find_in_app over the nav search index
// ---------------------------------------------------------------------------

/** Searchable entries: nav items (with their synonyms), the off-menu items, and every destination. */
function navEntries() {
  const items = [HOME_ITEM, PORTFOLIO_ITEM, ...NAV_GROUPS.flatMap((group) => group.items), ...OFF_MENU_ITEMS]
  const itemEntries = items.map((item) => ({
    kind: 'item',
    id: item.id,
    navId: item.id,
    label: item.label,
    summary: null,
    keywords: NAV_ITEM_TERMS[item.id] || [],
  }))
  const destinationEntries = NAV_DESTINATIONS.map((d) => ({ kind: 'destination', ...d }))
  return [...itemEntries, ...destinationEntries]
}

function hitOf(entry) {
  return {
    id: entry.id,
    label: entry.label,
    summary: entry.summary ?? null,
    // A destination carries `focus=<id>` so the surface flashes on arrival; an item is its section.
    path: entry.kind === 'destination' ? pathForDestination(entry) : pathForNavItem(entry.id),
    navId: entry.navId,
  }
}

/**
 * Search the app's own map. Exported for the tests and for any surface that wants the same answer
 * the assistant gets.
 *
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {{query: string, hits: Array<{id: string, label: string, summary: string|null, path: string, navId: string}>, note: string|null}}
 */
export function findInApp(query, { limit = FIND_IN_APP_LIMIT } = {}) {
  const text = typeof query === 'string' ? query.trim() : ''
  const terms = queryTerms(text)
  const hits = terms.length ? rankEntries(navEntries(), terms).slice(0, limit).map(hitOf) : []
  return { query: text, hits, note: hits.length === 0 ? FIND_IN_APP_EMPTY_NOTE : null }
}

const LOCAL_TOOLS = Object.freeze({
  find_in_app: (input) => findInApp(input?.query),
})

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * Execute one tool call from the model.
 *
 * @param {{
 *   def: {name: string, auth: 'grant'|'none'|'local', exec: object},
 *   input: object,
 *   account?: string|null,
 *   sessionToken?: string|null,   the 24-hour read grant; required for `route` execs
 *   relayerBase?: string,         defaults to the build's relayer
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} args
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, error: {code: string, reason: string, retryAfterSec: number|null}}>}
 */
export async function executeTool({
  def,
  input,
  account = null, // eslint-disable-line no-unused-vars -- reserved: the member identity is the grant's, not a tool input
  sessionToken = null,
  relayerBase,
  fetchImpl = fetch,
  timeoutMs = TOOL_TIMEOUT_MS,
}) {
  try {
    const exec = def?.exec
    if (!exec || typeof exec !== 'object') return fail('unknown_tool', 'this tool has no execution binding in this app')
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}

    if (exec.kind === 'local') {
      const run = LOCAL_TOOLS[def.name]
      if (!run) return fail('unknown_tool', `"${def.name}" is not a tool this app can run locally`)
      return { ok: true, value: run(args) }
    }

    if (exec.kind !== 'route' && exec.kind !== 'public') {
      return fail('unknown_tool', 'this tool has an execution kind this app does not know')
    }

    const base = (relayerBase != null ? relayerBase : relayerBaseUrl()).replace(/\/$/, '')
    if (!base) return fail('relayer_unset', 'this build has no gateway configured, so nothing can be read')

    if (exec.kind === 'route') {
      if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
        return fail('no_grant', 'sign the 24-hour read grant to let the assistant read your own data')
      }
      const path = ROUTE_PATHS[exec.route]
      if (!path) return fail('unknown_route', `"${String(exec.route)}" is not a member-API route this app knows`)
      return httpGet({
        url: `${base}${path}${queryString(exec.query, args)}`,
        // The credential rides in a HEADER, never in the URL (spec 069's rule).
        headers: { Authorization: `Bearer ${sessionToken}`, Accept: 'application/json' },
        fetchImpl,
        timeoutMs,
      })
    }

    // public
    if ((exec.method || 'GET') !== 'GET') return fail('unknown_tool', 'public tools are reads; this one is not a GET')
    if (typeof exec.path !== 'string' || !exec.path.startsWith('/')) {
      return fail('unknown_tool', 'this tool names a path this app will not request')
    }
    const substituted = substitutePath(exec.path, exec.pathParams, args)
    if (substituted.error) return substituted.error
    return httpGet({
      url: `${base}${substituted.path}${queryString(exec.query, args)}`,
      headers: { Accept: 'application/json' },
      fetchImpl,
      timeoutMs,
    })
  } catch {
    // A thrown exception's text can quote the model's input, which can quote the member. Keep the fact.
    return fail('tool_failed', 'this tool failed in a way the app did not expect')
  }
}
