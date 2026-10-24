/**
 * Assistant proxy — the model-provider leg of `POST /v1/member/assistant/chat` (specs 095 + 104).
 *
 * WHY RAW HTTP AND NOT THE ANTHROPIC SDK
 * The official SDK is the normal choice, and it is the wrong one here: adding a dependency to this
 * service edits the ROOT lockfile, which in this repo is a byte-gate event (spec 075 — a
 * lockfile-touching change has repeatedly dropped an optional platform binary and broken every Vite
 * build). This module needs exactly one endpoint, one request shape and a handful of response
 * fields, so it uses `fetch` against the documented Messages API instead. `fetchImpl` is injectable
 * so tests never touch the network.
 *
 * WHAT LEAVES THE DEVICE, AND WHAT IS NEVER WRITTEN DOWN
 * The member's messages — and, since spec 104, the tool results their own browser fetched — go to
 * the platform gateway and from there to the model provider, and nowhere else. This module NEVER
 * logs message content — not on success, not on failure, not in an error path. The audit event the
 * route emits carries counts only. Note that adding a content field to `audit/log.js`'s
 * FORBIDDEN_KEYS would not be a substitute for this: the guard drops keys it knows about, and the
 * actual rule is that content never reaches the logger at all.
 *
 * THE TOOL LOOP RUNS IN THE BROWSER; THIS GATEWAY IS ONE ROUND OF IT (spec 104, research § 8.2 T3).
 * The model may answer with `tool_use` blocks; the member's browser executes them — as ordinary
 * member-API requests under the session grant, public reads, or locally — and sends the results
 * back as `tool_result` blocks in the next request. Each round is therefore its own request here,
 * with its own quota hit and its own token reservation; the round cap is the multiplier and lives
 * in `ASSISTANT_MAX_ROUNDS`. Three consequences for this file:
 *   · `parseChatRequest` admits content BLOCKS under a strict allow-list. Anything it does not
 *     understand is refused with a 400 rather than forwarded at FairWins' expense.
 *   · THE GATEWAY ATTACHES THE TOOLS ITSELF, from `@fairwins/assistant-contract`, filtered to the
 *     token's scopes. A client never supplies `tools` on this rail — that would be arbitrary text
 *     into the model under FairWins' credential — and a request that tries is refused.
 *   · An empty reply is "unavailable" ONLY when the model was not asking for a tool. With
 *     `stop_reason: "tool_use"` an empty text is the normal shape of a round.
 *
 * WHAT THE ASSISTANT MAY AND MAY NOT DO
 * The system prompt (`@fairwins/assistant-contract/prompt`) is the whole of its instruction, it is
 * SERVER-SIDE, and a member cannot replace it — the `messages` array carries conversation only. It
 * is FROZEN per rail: the member's current screen is no longer interpolated into it (that rewrote
 * the cache prefix on every navigation) and rides instead as a trailing text block on the last user
 * message (`surfaceNote`).
 */
import {
  buildSystemPrompt,
  surfaceNote,
  SURFACE_MAX_CHARS,
} from '@fairwins/assistant-contract/prompt'
import {
  ALLOWED_CONTENT_BLOCK_TYPES,
  ANTHROPIC_VERSION,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_REQUEST_CONTENT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_ROUNDS,
  TOOL_DEFS,
  TOOL_NAMES,
  toolsForMessages,
} from '@fairwins/assistant-contract/tools'
import { GatewayError } from '../errors.js'

// Re-exported so openapi.js and the tests read the caps from the module that enforces them.
export { MAX_MESSAGES, MAX_MESSAGE_CHARS, MAX_BLOCKS_PER_MESSAGE, MAX_REQUEST_CONTENT_CHARS, MAX_TOOL_RESULT_CHARS, MAX_TOOL_ROUNDS }

/**
 * The hard ceiling on `ASSISTANT_MAX_TOKENS`, enforced at BOOT.
 *
 * A per-turn output ceiling is the only thing that bounds what a single request can cost, so it
 * must not itself be unbounded configuration: `ASSISTANT_MAX_TOKENS=1000000` would be a typo that
 * multiplies the bill by a thousand and reads, in an env file, exactly like the correct value. This
 * is a constant rather than another variable for the same reason — a cap an operator can raise is
 * not a cap. It is sized well above any answer this assistant should give (its whole job is short,
 * concrete replies) and well below anything that could be expensive on its own.
 */
export const MAX_TOKENS_CEILING = 4096

/**
 * The hard ceiling on `ASSISTANT_MAX_ROUNDS`, enforced at BOOT — the same reasoning one level up.
 *
 * The round cap is the multiplier on everything the per-turn ceiling bounds: a member turn that
 * runs the loop to its limit costs up to `rounds × one request`. Each round already draws its own
 * quota hit and its own token reservation, so this is not the only control, but it is the one
 * that decides how many of those a single question may spend. Twice the default, and no more.
 */
export const MAX_ROUNDS_CEILING = 8

const BLOCK_TYPES = new Set(ALLOWED_CONTENT_BLOCK_TYPES)
const KNOWN_TOOLS = new Set(TOOL_NAMES)
const TEXT_KEYS = new Set(['type', 'text'])
const TOOL_USE_KEYS = new Set(['type', 'id', 'name', 'input'])
const TOOL_RESULT_KEYS = new Set(['type', 'tool_use_id', 'content', 'is_error'])
/** What the provider mints (`toolu_…`) and what a browser might mint; nothing exotic. */
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Characters in the system text and the full tool table — the parts of a request the caller does not send. */
const FIXED_PROMPT_CHARS = buildSystemPrompt({ rail: 'fairwins', hasMemberTools: true }).length
const FIXED_TOOLS_CHARS = JSON.stringify(toolsForMessages(TOOL_DEFS)).length

/**
 * Worst-case tokens one request can cost, for the pre-flight budget reservation.
 *
 * An ESTIMATE, and only ever used as one: it decides how much headroom to hold while the call is in
 * flight, and is replaced by the provider's measured counts the moment they arrive. Input is
 * approximated at the conventional ~4 characters per token (English prose; other scripts run
 * denser, which is why this is a reservation and not an accounting figure), and output is charged
 * at the FULL ceiling, because that is genuinely the most the provider can return. The system text
 * and the WHOLE tool table are counted whatever the token's scopes — an over-estimate is the safe
 * direction for a reservation.
 *
 * @param {{messages: Array<{role: string, content: string|Array}>, surface?: string|null, maxTokens: number}} turn
 */
export function estimateTurnTokens({ messages, surface = null, maxTokens }) {
  return estimateFromChars({
    contentChars: contentChars(messages) + (surfaceNote(surface)?.length ?? 0),
    messageCount: messages.length,
    maxTokens,
  })
}

function estimateFromChars({ contentChars: chars, messageCount, maxTokens }) {
  // ~4 chars/token, plus a few tokens of per-message envelope the wire format adds.
  const inputTokens = Math.ceil((FIXED_PROMPT_CHARS + FIXED_TOOLS_CHARS + chars) / 4) + messageCount * 4
  return inputTokens + Math.max(0, Number(maxTokens) || 0)
}

/**
 * The largest reservation `estimateTurnTokens` can ever produce for a request `parseChatRequest`
 * would admit — the caps it enforces are what make that a finite number. Since spec 104 the
 * binding cap is `MAX_REQUEST_CONTENT_CHARS` (every character of content in one request), not
 * messages × per-message: a request full of tool results is bounded by the same total.
 *
 * Boot uses it to refuse a token budget that is smaller than one maximal request. Without that
 * check the budget would be a size limit in disguise: a well-formed request could be refused for
 * being long rather than for the budget being spent, which is a confusing answer to give a member
 * and an impossible one to act on from the outside.
 */
export function maxTurnTokens(maxTokens) {
  return estimateFromChars({
    contentChars: MAX_REQUEST_CONTENT_CHARS + (surfaceNote('x'.repeat(SURFACE_MAX_CHARS))?.length ?? 0),
    messageCount: MAX_MESSAGES,
    maxTokens,
  })
}

/** Characters of content across every message, string or blocks (the same accounting the parser did). */
function contentChars(messages) {
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += m.content.length
      continue
    }
    for (const b of m.content) {
      if (b.type === 'text') total += b.text.length
      else if (b.type === 'tool_use') total += JSON.stringify(b.input).length
      else if (b.type === 'tool_result') total += b.content.length
    }
  }
  return total
}

const bad = (msg) => new GatewayError(400, 'bad_request', msg)

/** The keys a block may carry, and no other — an unknown key is refused, not dropped. */
function checkKeys(block, allowed, where) {
  for (const k of Object.keys(block)) {
    if (!allowed.has(k)) throw bad(`${where} carries an unexpected key "${k}"`)
  }
}

/**
 * Validate one message's content blocks.
 *
 * @returns {{blocks: Array, chars: number, toolUseIds: string[], toolResultIds: string[]}}
 */
function parseBlocks(content, i, role) {
  if (content.length === 0) throw bad(`messages[${i}].content must not be an empty array`)
  if (content.length > MAX_BLOCKS_PER_MESSAGE) {
    throw bad(`messages[${i}].content has ${content.length} blocks; at most ${MAX_BLOCKS_PER_MESSAGE} per message`)
  }
  const blocks = []
  const toolUseIds = []
  const toolResultIds = []
  let chars = 0
  content.forEach((b, j) => {
    const where = `messages[${i}].content[${j}]`
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(`${where} must be an object`)
    if (!BLOCK_TYPES.has(b.type)) {
      throw bad(`${where}.type must be one of ${ALLOWED_CONTENT_BLOCK_TYPES.join(', ')}`)
    }
    if (b.type === 'text') {
      checkKeys(b, TEXT_KEYS, where)
      if (typeof b.text !== 'string' || b.text.length === 0) throw bad(`${where}.text must be a non-empty string`)
      if (b.text.length > MAX_MESSAGE_CHARS) throw bad(`${where}.text exceeds ${MAX_MESSAGE_CHARS} characters`)
      chars += b.text.length
      blocks.push({ type: 'text', text: b.text })
      return
    }
    if (b.type === 'tool_use') {
      // A tool_use is the MODEL's turn: it can only ever appear in an assistant message.
      if (role !== 'assistant') throw bad(`${where} is a tool_use block, which only an assistant message may carry`)
      checkKeys(b, TOOL_USE_KEYS, where)
      if (typeof b.id !== 'string' || !TOOL_USE_ID_RE.test(b.id)) throw bad(`${where}.id must be a short id string`)
      if (typeof b.name !== 'string' || !KNOWN_TOOLS.has(b.name)) {
        throw bad(`${where}.name is not a tool this gateway offers (${TOOL_NAMES.join(', ')})`)
      }
      if (!b.input || typeof b.input !== 'object' || Array.isArray(b.input)) throw bad(`${where}.input must be an object`)
      const serialised = JSON.stringify(b.input)
      if (serialised.length > MAX_MESSAGE_CHARS) throw bad(`${where}.input exceeds ${MAX_MESSAGE_CHARS} characters`)
      if (toolUseIds.includes(b.id)) throw bad(`${where}.id repeats an id already used in this message`)
      chars += serialised.length
      toolUseIds.push(b.id)
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: JSON.parse(serialised) })
      return
    }
    // tool_result — the BROWSER's answer to a tool_use: only a user message may carry one.
    if (role !== 'user') throw bad(`${where} is a tool_result block, which only a user message may carry`)
    checkKeys(b, TOOL_RESULT_KEYS, where)
    if (typeof b.tool_use_id !== 'string' || !TOOL_USE_ID_RE.test(b.tool_use_id)) {
      throw bad(`${where}.tool_use_id must be the id of a tool_use block in the preceding assistant message`)
    }
    if (typeof b.content !== 'string') throw bad(`${where}.content must be a string`)
    if (b.content.length > MAX_TOOL_RESULT_CHARS) {
      throw bad(`${where}.content exceeds ${MAX_TOOL_RESULT_CHARS} characters; truncate it client-side and say so`)
    }
    if (b.is_error !== undefined && typeof b.is_error !== 'boolean') throw bad(`${where}.is_error must be a boolean`)
    if (toolResultIds.includes(b.tool_use_id)) throw bad(`${where}.tool_use_id answers a tool_use already answered in this message`)
    chars += b.content.length
    toolResultIds.push(b.tool_use_id)
    blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error === true })
  })
  return { blocks, chars, toolUseIds, toolResultIds }
}

/**
 * Validate the member's request. Throws before anything is sent upstream, so a malformed body never
 * costs a token.
 *
 * Message `content` is a non-empty string (the pre-104 shape, still the common case) or an array of
 * blocks from `ALLOWED_CONTENT_BLOCK_TYPES` under strict shape checks: a `tool_use` needs
 * `id`/`name`/`input`, names a tool this gateway offers, and appears only in an assistant message;
 * a `tool_result` needs `tool_use_id` + string `content` (+ optional boolean `is_error`), appears
 * only in a user message, and must answer a `tool_use` from the IMMEDIATELY preceding assistant
 * message — every such `tool_use` must be answered exactly once. Unknown keys and unknown block types
 * are refused. The conversation starts and ends with a user turn (a trailing assistant message is a
 * prefill, which the model tier rejects upstream and which this rail has no use for).
 *
 * @returns {{messages: Array<{role: string, content: string|Array}>, surface: string|null, contentChars: number}}
 */
export function parseChatRequest(body) {
  // THE GATEWAY OWNS THESE. `tools` is arbitrary text into the model under FairWins' credential and
  // `system` is the instruction set a member must not be able to replace — both are refused, not
  // ignored, because a client that sends them believes it configured something.
  for (const owned of ['tools', 'system', 'tool_choice', 'model']) {
    if (body && Object.prototype.hasOwnProperty.call(body, owned)) {
      throw bad(`body.${owned} is not accepted: the gateway attaches the ${owned === 'tools' ? 'tool table' : owned} itself`)
    }
  }
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    throw bad('body.messages must be a non-empty array')
  }
  if (messages.length > MAX_MESSAGES) {
    throw bad(`at most ${MAX_MESSAGES} messages per request; summarise older turns client-side`)
  }
  let total = 0
  let pendingToolUses = [] // tool_use ids the NEXT user message must answer
  const clean = messages.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad(`messages[${i}] must be an object`)
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw bad(`messages[${i}].role must be "user" or "assistant"`)
    }
    for (const k of Object.keys(m)) {
      if (k !== 'role' && k !== 'content') throw bad(`messages[${i}] carries an unexpected key "${k}"`)
    }

    let out
    let toolUseIds = []
    let toolResultIds = []
    if (typeof m.content === 'string') {
      if (m.content.length === 0) throw bad(`messages[${i}].content must be a non-empty string or an array of blocks`)
      if (m.content.length > MAX_MESSAGE_CHARS) throw bad(`messages[${i}].content exceeds ${MAX_MESSAGE_CHARS} characters`)
      total += m.content.length
      out = { role: m.role, content: m.content }
    } else if (Array.isArray(m.content)) {
      const parsed = parseBlocks(m.content, i, m.role)
      total += parsed.chars
      toolUseIds = parsed.toolUseIds
      toolResultIds = parsed.toolResultIds
      out = { role: m.role, content: parsed.blocks }
    } else {
      throw bad(`messages[${i}].content must be a non-empty string or an array of blocks`)
    }

    // Pairing: a tool_result answers a tool_use in the preceding assistant message, and every
    // tool_use is answered. Checked here so the member gets a 400 naming the block, rather than the
    // provider's 400 laundered into a 503 "unavailable" that reads as an outage.
    if (m.role === 'user') {
      const pending = new Set(pendingToolUses)
      for (const id of toolResultIds) {
        if (!pending.has(id)) throw bad(`messages[${i}] answers tool_use "${id}", which the preceding assistant message did not make`)
        pending.delete(id)
      }
      if (pending.size > 0) {
        throw bad(`messages[${i}] leaves tool_use ${[...pending].map((id) => `"${id}"`).join(', ')} unanswered; every tool_use needs a tool_result in the next user message`)
      }
      pendingToolUses = []
    } else {
      if (pendingToolUses.length > 0) {
        throw bad(`messages[${i}] follows an assistant message whose tool_use blocks were never answered`)
      }
      pendingToolUses = toolUseIds
    }
    return out
  })
  if (total > MAX_REQUEST_CONTENT_CHARS) {
    throw bad(`the request carries ${total} characters of content; at most ${MAX_REQUEST_CONTENT_CHARS} per request — trim tool results or summarise older turns`)
  }
  // The API requires the conversation to start with a user turn, and this rail always ends on one.
  if (clean[0].role !== 'user') throw bad('the first message must be from the user')
  if (clean[clean.length - 1].role !== 'user') throw bad('the last message must be from the user')
  const surface = typeof body?.surface === 'string' ? body.surface.slice(0, SURFACE_MAX_CHARS) : null
  return { messages: clean, surface, contentChars: total }
}

/**
 * The messages as sent upstream: the surface note, when there is one, appended as a SEPARATE
 * trailing text block on the last user message. Never merged into the member's own text and never
 * placed in `system`.
 */
export function withSurfaceNote(messages, surface) {
  const note = surfaceNote(surface)
  if (!note) return messages
  const last = messages[messages.length - 1]
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content]
  blocks.push({ type: 'text', text: note })
  return [...messages.slice(0, -1), { role: last.role, content: blocks }]
}

/**
 * @param {object} config full gateway config (reads .memberApi.assistant)
 * @param {{fetchImpl?: typeof fetch}} [deps]
 */
export function createAssistantClient(config, { fetchImpl = fetch } = {}) {
  const a = config.memberApi.assistant

  return {
    /** Whether a request right now could be served at all. Public, non-secret. */
    configured: Boolean(a.enabled && a.apiKey),

    /** Rounds per member turn the browser loop may run against this gateway. Public config. */
    maxRounds: a.maxRounds ?? MAX_TOOL_ROUNDS,

    /**
     * One round. `tools` is the Messages-API array the ROUTE built from the token's scopes — this
     * function never reads a tool list off the request.
     *
     * @param {{messages: Array, surface: string|null, tools?: Array}} req
     * @returns {Promise<{reply: string, content: Array, stopReason: string|null, model: string, usage: {inputTokens: number|null, outputTokens: number|null}}>}
     * @throws {GatewayError} 503 assistant_unconfigured | 503 assistant_unavailable
     */
    async chat({ messages, surface, tools = [] }) {
      if (!a.enabled || !a.apiKey) {
        throw new GatewayError(503, 'assistant_unconfigured', 'the assistant is not enabled on this gateway')
      }

      const hasMemberTools = tools.some((t) => TOOL_DEFS.find((d) => d.name === t.name)?.auth === 'grant')
      const upstream = {
        model: a.model,
        max_tokens: a.maxTokens,
        system: buildSystemPrompt({ rail: 'fairwins', hasMemberTools }),
        messages: withSurfaceNote(messages, surface),
        // `tool_choice` without `tools` is itself a 400 upstream, so both travel together or not
        // at all. `auto` only: forced tool use is rejected on the newest model tier and buys
        // nothing here (research § 8.6).
        ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto' } } : {}),
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), a.timeoutMs)
      let res
      try {
        res = await fetchImpl(`${a.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': a.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(upstream),
          signal: controller.signal,
        })
      } catch {
        // Timeout or transport failure. The member is told the service is unreachable — never an
        // invented reply, which is the one failure mode an assistant must not have.
        throw new GatewayError(503, 'assistant_unavailable', 'the assistant service could not be reached; try again shortly')
      } finally {
        clearTimeout(timer)
      }

      if (!res.ok) {
        // The upstream status is operational information; its BODY may echo the member's own text,
        // so it is never read, never logged and never forwarded.
        console.warn(`[relay-gateway] assistant upstream answered HTTP ${res.status}`)
        throw new GatewayError(503, 'assistant_unavailable', 'the assistant service is temporarily unavailable; try again shortly')
      }

      let payload
      try {
        payload = await res.json()
      } catch {
        throw new GatewayError(503, 'assistant_unavailable', 'the assistant service returned an unreadable response')
      }

      const stopReason = typeof payload?.stop_reason === 'string' ? payload.stop_reason : null

      // Pass through TEXT and TOOL_USE blocks only, each re-shaped to exactly the keys the browser
      // loop needs. Thinking blocks (and anything newer) belong to the provider and are dropped: a
      // block this gateway does not understand is not forwarded to a client that will echo it back.
      const content = []
      if (Array.isArray(payload?.content)) {
        for (const b of payload.content) {
          if (b?.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text })
          else if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string' && b.input && typeof b.input === 'object') {
            content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
          }
        }
      }
      const reply = content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      const toolUses = content.filter((b) => b.type === 'tool_use').length

      if (stopReason === 'tool_use' ? toolUses === 0 : !reply) {
        // A declined or empty answer is reported as unavailable rather than as a blank reply: a
        // chat bubble containing nothing reads as "the assistant had nothing to say", which is a
        // different claim from "the assistant did not answer". A round that ASKS FOR A TOOL is the
        // one case where empty text is the normal shape, and then the tool_use blocks are the answer.
        throw new GatewayError(
          503,
          'assistant_unavailable',
          stopReason === 'refusal'
            ? 'the assistant declined to answer that; rephrase, or ask a person'
            : 'the assistant returned no answer; try again shortly'
        )
      }

      return {
        reply,
        content,
        stopReason,
        model: typeof payload?.model === 'string' ? payload.model : a.model,
        // Counts only — never content. Absent counts stay null rather than becoming 0.
        usage: {
          inputTokens: Number.isFinite(payload?.usage?.input_tokens) ? payload.usage.input_tokens : null,
          outputTokens: Number.isFinite(payload?.usage?.output_tokens) ? payload.usage.output_tokens : null,
        },
      }
    },
  }
}
