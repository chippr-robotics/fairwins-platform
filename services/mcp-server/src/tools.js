/**
 * The tools this MCP server offers (specs 095 + 104).
 *
 * Eight tools. Six read, one quotes typed data, one reports the gateway's own health. There is
 * deliberately no tool that submits anything, and there cannot be one: the member API this server
 * talks to has no write route, and this process holds no key.
 *
 * WHERE THE DEFINITIONS COME FROM (spec 104). The shared tools' `name`/`title`/`description`/
 * `inputSchema` are READ from `toolDefs.snapshot.json` beside this file — a vendored copy of
 * `@fairwins/assistant-contract`'s `TOOL_DEFS`, the one table the in-app assistant and this server
 * both offer to a model. This server may take NO dependency and is deliberately outside the npm
 * workspace (spec 095 R4), so it cannot import the package; the snapshot is the same shape the repo
 * uses for the EIP-712 structs, and `services/relay-gateway/test/mcpToolParity.test.js` fails the
 * moment it drifts from the package in either direction. Only the transport BINDINGS live here: how
 * each `exec` becomes a `fetch`. Never edit a description in the snapshot by hand — change the
 * package and re-vendor.
 *
 * `build_intent` IS MCP-ONLY AND IS DEFINED HERE, NOT IN THE SNAPSHOT. It is the one tool that
 * returns something a member could sign, and the in-app assistant deliberately does not carry it
 * (research § 8.4): in the browser the member CAN sign, and the first in-app tool that returns typed
 * data would be followed by a request for a button that signs it. Here the boundary is physical —
 * an MCP client holds no wallet — so the quote is safe to hand over, and the description says who
 * signs it. The right in-app shape is a v2 `prepare_action` that deep-links to the surface owning
 * the action, with its own security lifecycle.
 *
 * `find_in_app` IS IN THE SNAPSHOT AND IS NOT SERVED HERE. It is `auth: 'local'` — it searches the
 * SPA's own navigation index in the member's browser, and there is no gateway route behind it. The
 * snapshot is skipped for every local tool, on purpose; a client asking for it gets the ordinary
 * "unknown tool" answer naming the real ones.
 *
 * HOW A FAILURE IS REPORTED. `isError: true` with the gateway's own error code and reason in the
 * text — never an empty array, never a zero, never a cheerful "nothing found". The distinction an
 * agent needs is exactly the one a failed read destroys: "this member has no wagers on Polygon" and
 * "the Polygon indexer did not answer" are different facts, and only one of them is safe to repeat
 * to a member. The member API preserves that distinction per chain (`read` / `not-configured` /
 * `unreadable`) and these tools pass the envelope through untouched rather than flattening it. The
 * closing sentence of `failed()` is the same text `@fairwins/assistant-contract/results` uses for
 * the in-app loop; the parity test asserts the two stay identical.
 *
 * WHY THE SCHEMAS ARE SMALL. Every tool that needs a member's authority takes NO account
 * parameter: the account is whichever one signed the bearer token. A tool that accepted an address
 * would be inviting an agent to ask about someone else, and the gateway would refuse it anyway —
 * better that the shape make it unaskable.
 *
 * PAYMENT IS SOMETHING THESE TOOLS REPORT, NEVER SOMETHING THEY DO (spec 096). A priced operation
 * called without an accepted payment answers `402` with a machine-readable offer, and that offer is
 * handed to the agent WHOLE — this process cannot sign it. An agent that can pay retries the same
 * tool with an `X-PAYMENT` header (HTTP mode), which is forwarded upstream verbatim. No tool takes a
 * payment as an ARGUMENT: an argument is model-authored text, and the one thing a model must never
 * be able to author on its own is a transfer authorization.
 */
import { readFileSync } from 'node:fs'
import { ApiError, PaymentRequiredError } from './api.js'

/** The vendored table. Read once at load; a malformed snapshot fails the process, not a call. */
export const TOOL_SNAPSHOT = Object.freeze(
  JSON.parse(readFileSync(new URL('./toolDefs.snapshot.json', import.meta.url), 'utf8'))
)

/**
 * The member-API path for each `exec.route` id the snapshot names.
 *
 * The snapshot carries the gateway's ROUTE IDS (`contract.js` `ROUTES[].id`), not paths, because
 * paths belong to the gateway. This server cannot import that file either, so the id→path map is
 * restated here and `mcpToolParity.test.js` asserts every entry equals `routeOf(id).path` on the
 * gateway — a route renamed on one side fails a test, not a member.
 */
export const ROUTE_PATHS = Object.freeze({
  me: '/v1/member/me',
  membership: '/v1/member/membership',
  wagers: '/v1/member/wagers',
  fees: '/v1/member/fees',
  buildIntent: '/v1/member/intents/build',
})

/**
 * A tool result: plain text content, which every MCP client can render.
 *
 * When the call spent a payment (spec 096), the receipt is a SECOND content block rather than
 * something merged into the data — the first block stays exactly what the gateway answered. The
 * receipt says "broadcast", not "final", because that is all the gateway can honestly claim at the
 * moment it serves the request: the settlement transaction has been accepted by the relay engine,
 * and a chain has not yet confirmed it.
 */
function ok(value, settlement = null) {
  const content = [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  if (settlement) {
    content.push({
      type: 'text',
      text:
        'A payment was settled for this call (x402). Receipt, as the gateway reported it:\n' +
        `${JSON.stringify(settlement.decoded ?? { opaque: settlement.raw }, null, 2)}\n\n` +
        'The transaction has been BROADCAST, not confirmed. Do not describe it to a member as final, ' +
        'and do not retry this call on the assumption that nothing was charged.',
    })
  }
  return { content, isError: false }
}

/**
 * A `402 Payment Required` answer, said plainly (spec 096).
 *
 * The whole `accepts` list goes back verbatim, because the agent has to sign against exactly those
 * values — the amount, the asset, the recipient, the network and the token's own EIP-712 domain.
 * Summarising it would be inviting the agent to sign something slightly different, which the gateway
 * would then refuse.
 *
 * `isError: true` is correct here: no data was served. But it is a PRICE, not an outage, so the text
 * says which it is — an agent that reads this as a failed read will report "unavailable" about a
 * resource that is available for a tenth of a cent.
 */
function paymentRequired(err) {
  const why = err.paymentError ? `\nThe gateway named this reason: ${err.paymentError}.` : ''
  return {
    content: [
      {
        type: 'text',
        text:
          'This operation is PRICED and no accepted payment accompanied the request (HTTP 402, x402 ' +
          `protocol version ${err.x402Version ?? 'unstated'}).${why}\n\n` +
          'THIS SERVER CANNOT PAY. It holds no key and signs nothing, so it can neither create the ' +
          'payment authorization below nor authorise one on anybody’s behalf.\n\n' +
          'If you can sign, you may settle this yourself per the x402 protocol: sign an EIP-3009 ' +
          '`transferWithAuthorization` for one of the offers below, under that token’s own EIP-712 ' +
          'domain (`extra.name` / `extra.version`), and retry the SAME call with the resulting ' +
          'base64 PaymentPayload in an `X-PAYMENT` header — this server forwards it upstream ' +
          'unaltered and returns the settlement receipt. Otherwise a FairWins member can hand you a ' +
          'capability token instead (Settings ▸ API access): a valid token is checked first and is ' +
          'never charged.\n\n' +
          `Resource: ${JSON.stringify(err.resource ?? null)}\n` +
          `accepts: ${JSON.stringify(err.accepts, null, 2)}`,
      },
    ],
    isError: true,
  }
}

/**
 * A failed tool call, said plainly.
 *
 * The code is included because it is machine-readable and stable, the reason because it is the
 * gateway's own words, and the closing sentence because an agent reading only the first line must
 * still not conclude that the answer was "none".
 */
function failed(err) {
  if (err instanceof PaymentRequiredError) return paymentRequired(err)
  const code = err instanceof ApiError ? err.code : 'tool_failed'
  const reason = err instanceof ApiError ? err.reason : (err?.message ?? String(err))
  const retry = err instanceof ApiError && err.retryAfterSec ? ` Retry after ${err.retryAfterSec}s.` : ''
  return {
    content: [
      {
        type: 'text',
        text:
          `This read did not succeed: ${code} — ${reason}${retry}\n\n` +
          'This is an UNKNOWN, not an empty result. Do not report it as "none", "zero" or "no records"; ' +
          'say that the data could not be read and, where it matters, offer to try again.',
      },
    ],
    isError: true,
  }
}

/**
 * Run a tool body, turning any thrown failure into an honest `isError` result.
 *
 * `ctx` is the per-request context the transport built. `opts()` parks any settlement receipt on it,
 * so this reads it back after a success and the HTTP transport can return the original header bytes
 * to whoever paid.
 */
async function attempt(fn, ctx) {
  try {
    const value = await fn()
    return ok(value, ctx?.settlement ?? null)
  } catch (err) {
    return failed(err)
  }
}

/** The query object for a call: only the names `exec.query` declares, only when the agent set them. */
function pickQuery(exec, args) {
  const query = {}
  for (const k of exec.query ?? []) query[k] = args?.[k]
  return query
}

/**
 * Substitute `{param}` segments of a public path from the arguments, falling back to the schema's
 * own `default`. A non-integer where an integer is declared falls back too — the old hand-written
 * binding did exactly this for `chainId` (Polymarket is Polygon-only, so 137 is the only value that
 * ever works), and an argument is never allowed to introduce a path separator.
 */
function fillPath(def, args) {
  let path = def.exec.path
  for (const p of def.exec.pathParams ?? []) {
    const prop = def.inputSchema.properties?.[p] ?? {}
    let v = args?.[p]
    if (prop.type === 'integer' && !Number.isInteger(v)) v = prop.default
    if (v === undefined || v === null) v = prop.default
    path = path.replace(`{${p}}`, encodeURIComponent(String(v)))
  }
  return path
}

/**
 * @param {{api: ReturnType<import('./api.js').createApiClient>}} deps
 * @returns {Array<{name: string, title: string, description: string, inputSchema: object, call: Function}>}
 */
export function createTools({ api }) {
  /**
   * Per-call context carries the HTTP transport's per-request token override, if there was one —
   * and, since spec 096, an `X-PAYMENT` payload the caller wants forwarded and a place to park the
   * settlement receipt that comes back. Both are per-request and neither is ever stored.
   */
  const opts = (ctx) => ({
    token: ctx?.token,
    xPayment: ctx?.xPayment,
    onSettlement: ctx ? (settlement) => { ctx.settlement = settlement } : null,
  })

  /** Bind one snapshot definition to this server's transport, by its `exec.kind`. */
  const bind = (def) => {
    const shape = { name: def.name, title: def.title, description: def.description, inputSchema: def.inputSchema }
    if (def.exec.kind === 'route') {
      const path = ROUTE_PATHS[def.exec.route]
      if (!path) {
        throw new Error(`[fairwins-mcp] snapshot tool "${def.name}" names route "${def.exec.route}", which ROUTE_PATHS does not map`)
      }
      return { ...shape, call: (args, ctx) => attempt(() => api.get(path, { ...opts(ctx), query: pickQuery(def.exec, args) }), ctx) }
    }
    if (def.exec.kind === 'public') {
      // Public reads carry no token and, having no principal, can carry no settlement receipt.
      return { ...shape, call: (args, _ctx) => attempt(() => api.get(fillPath(def, args), { auth: 'none', query: pickQuery(def.exec, args) })) }
    }
    throw new Error(`[fairwins-mcp] snapshot tool "${def.name}" has exec.kind "${def.exec.kind}", which this server cannot bind`)
  }

  // Every non-local snapshot tool is served; a local one is skipped (see the header). A snapshot
  // entry with an unknown kind or an unmapped route fails HERE, at boot, not in a member's call.
  const shared = TOOL_SNAPSHOT.filter((def) => def.auth !== 'local').map(bind)

  const buildIntent = {
    name: 'build_intent',
    title: 'Build unsigned typed data for a platform action',
    description:
      'Ask the gateway to assemble the EIP-712 typed data for a FairWins action (creating or accepting a ' +
      'wager, joining a pool, and so on) and return it UNSIGNED.\n\n' +
      'THIS SERVER CANNOT SIGN AND WILL NOT SIGN. It holds no key, no seed and no wallet, and nothing in ' +
      'this tool submits a transaction. What comes back is a quote for a signature: the member signs it in ' +
      'their own wallet, and then either relays it through the gateway or submits it themselves. Present the ' +
      'typed data to the member for review — including the amounts, the deadlines and the contract that will ' +
      'verify it — and never ask a member for a private key or a recovery phrase in order to "complete" this. ' +
      'The actor field is forced to the token’s own account; you cannot build an action on behalf of anyone ' +
      'else. Requires the build:intents scope.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The platform action to build, e.g. "createWager". The full list is in the fairwins://openapi resource.',
        },
        chainId: { type: 'integer', description: 'The chain the action will run on.' },
        params: {
          type: 'object',
          description:
            'The action’s own fields. The actor address is ignored if supplied — it is always the token’s account.',
          additionalProperties: true,
        },
      },
      required: ['action', 'chainId'],
      additionalProperties: false,
    },
    call: (args, ctx) =>
      attempt(
        () =>
          api.post(ROUTE_PATHS.buildIntent, {
            ...opts(ctx),
            body: { action: args?.action, chainId: args?.chainId, params: args?.params ?? {} },
          }),
        ctx
      ),
  }

  return [...shared, buildIntent]
}

/** The wire form of a tool, as `tools/list` returns it — the handler never leaves this process. */
export function describeTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
}
