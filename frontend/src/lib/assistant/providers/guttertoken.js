/**
 * GutterToken transport (spec 104) — `POST https://api.guttertokens.com/v1/messages`, browser-direct.
 *
 * THE MEMBER'S KEY, THE MEMBER'S CREDIT, THE MEMBER'S DEVICE. On this rail no FairWins service is in
 * the request path: the browser sends the conversation straight to GutterToken with the key the
 * member pasted, and GutterToken bills the member's own prepaid balance. That is why the design
 * (docs/research/guttertoken-assistant-integration.md P1) rejected forwarding through the gateway —
 * a key that transits FairWins is a key FairWins could be blamed for — and why nothing here is
 * logged: there is no server to keep a log honest.
 *
 * SAME BODY THE GATEWAY SENDS, SAME ERROR CONTRACT THE PANEL RENDERS. The request is the Anthropic
 * Messages shape (`model`, `max_tokens`, `system`, `messages`, and `tools` + `tool_choice: auto` when
 * the caller passes tools). Failures throw the same `AssistantError` the FairWins rail throws, so the
 * panel's honest-state rendering does not fork; two states are this rail's own:
 *
 *   'key_invalid'    401 — GutterToken did not accept the key (revoked, mistyped)
 *   'out_of_credit'  403 — the balance behind the key is empty
 *   'quota'          429 — rate limited, with Retry-After when sent
 *   'unavailable'    503 / model_unavailable / any 5xx — GutterToken could not answer
 *   'unreachable'    transport failure or timeout — could not ask, not "no answer"
 *   'rejected'       400 and other 4xx — the request was refused; `code` carries the error TYPE
 *
 * THE ERROR BODY IS NOT A MESSAGE. An upstream error's `message` field can quote the request — that
 * is the member's own text — so it is never read into an error, a log, or a toast. Only the bounded
 * `error.type` token is kept (as `code`), and every sentence a member sees is fixed here.
 *
 * There is no `/status` probe on this rail. GutterToken has no equivalent, so a transport failure
 * stands as 'unreachable': the honest answer, not a guess.
 */
import { ANTHROPIC_VERSION } from '@fairwins/assistant-contract'
import { AssistantError } from '../assistantClient'
import { validateTurnMessages } from '../messageShape'

// Re-exported so the loop and the conversation builder validate with the transport's own rule.
export { validateTurnMessages }

export const GUTTERTOKEN_BASE_URL = 'https://api.guttertokens.com'
/** Link-outs. Referral coding, if any, is a tenant-manifest concern (spec 072), not a literal here. */
export const GUTTERTOKEN_SIGNUP_URL = 'https://app.guttertokens.com/signup'
export const GUTTERTOKEN_BILLING_URL = 'https://app.guttertokens.com/billing'

export const GUTTERTOKEN_DEFAULT_MODEL = 'claude-opus-5'
/** Output ceiling per turn — the same 1024 the gateway defaults `ASSISTANT_MAX_TOKENS` to. */
export const GUTTERTOKEN_MAX_TOKENS = 1024

const TURN_TIMEOUT_MS = 45_000

/** Upstream error types that mean "the model is not there right now", whatever the status says. */
const UNAVAILABLE_TYPES = new Set(['model_unavailable', 'overloaded_error', 'api_error'])

/**
 * The upstream `error.type` if it is a short token, else null. This is the ONE field read out of an
 * error body, and the shape check is what keeps a free-text field from riding along under its name.
 */
function errorTypeOf(body) {
  const type = body?.error?.type
  return typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : null
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** Map a non-2xx upstream answer to the panel's error contract. Fixed sentences only. */
function upstreamError(status, errorType, retryAfterHeader) {
  if (status === 401) {
    return new AssistantError('GutterToken did not accept this key. It may have been revoked.', {
      state: 'key_invalid',
      code: errorType ?? 'authentication_error',
    })
  }
  if (status === 403) {
    return new AssistantError('Your GutterToken balance is empty. Top up at GutterToken and try again.', {
      state: 'out_of_credit',
      code: errorType ?? 'insufficient_quota',
    })
  }
  if (status === 429) {
    const retryAfter = Number(retryAfterHeader)
    return new AssistantError('GutterToken is rate-limiting requests from your network. Try again shortly.', {
      state: 'quota',
      code: errorType ?? 'rate_limit_error',
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
    })
  }
  if (status === 503 || status >= 500 || UNAVAILABLE_TYPES.has(errorType)) {
    return new AssistantError('GutterToken could not answer right now. Try again shortly.', {
      state: 'unavailable',
      code: errorType ?? `http_${status}`,
    })
  }
  return new AssistantError(
    status === 400
      ? 'GutterToken rejected this request.'
      : `GutterToken refused this request (HTTP ${status}).`,
    { state: 'rejected', code: errorType ?? (status === 400 ? 'bad_request' : `http_${status}`) }
  )
}

/**
 * One model turn on the GutterToken rail.
 *
 * @param {{
 *   apiKey: string,
 *   system: string,
 *   messages: Array<{role: 'user'|'assistant', content: string|Array<object>}>,
 *   tools?: Array<object>,           Messages-API tool shape (`toolsForMessages`); omitted when empty
 *   model?: string,
 *   maxTokens?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   baseUrl?: string,
 * }} args
 * @returns {Promise<{content: Array<object>, stopReason: string|null, model: string, usage: {inputTokens: number|null, outputTokens: number|null}}>}
 * @throws {AssistantError}
 */
export async function sendGutterTokenTurn({
  apiKey,
  system,
  messages,
  tools = [],
  model = GUTTERTOKEN_DEFAULT_MODEL,
  maxTokens = GUTTERTOKEN_MAX_TOKENS,
  timeoutMs = TURN_TIMEOUT_MS,
  fetchImpl = fetch,
  baseUrl = GUTTERTOKEN_BASE_URL,
}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new AssistantError('Add a GutterToken key to use your own credits.', { state: 'key_missing' })
  }
  const shape = validateTurnMessages(messages)
  if (!shape.ok) {
    throw new AssistantError('This conversation cannot be sent as it is. Start a new thread.', {
      state: 'rejected',
      code: shape.code,
    })
  }

  const body = {
    model,
    max_tokens: maxTokens,
    ...(typeof system === 'string' && system.length > 0 ? { system } : {}),
    messages,
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    // Auto only. Forced tool use buys nothing on a read-only surface and is refused by the newest tier.
    body.tool_choice = { type: 'auto' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        // The credential rides in a HEADER, never in the URL or the body.
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    // The exception text can quote the request. Keep the kind, drop the message.
    throw new AssistantError('GutterToken could not be reached from this device.', {
      state: 'unreachable',
      code: e?.name === 'AbortError' ? 'timeout' : 'network_error',
    })
  } finally {
    clearTimeout(timer)
  }

  const payload = await readJson(res)
  if (!res.ok) {
    throw upstreamError(res.status, errorTypeOf(payload), res.headers?.get?.('Retry-After'))
  }
  if (!payload || !Array.isArray(payload.content)) {
    throw new AssistantError('GutterToken returned a response this app could not read.', {
      state: 'unavailable',
      code: 'malformed_response',
    })
  }
  const inputTokens = payload.usage?.input_tokens
  const outputTokens = payload.usage?.output_tokens
  return {
    content: payload.content,
    stopReason: typeof payload.stop_reason === 'string' ? payload.stop_reason : null,
    model: typeof payload.model === 'string' ? payload.model : model,
    // Counts only, and an absent count stays null rather than becoming a zero.
    usage: {
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
    },
  }
}
