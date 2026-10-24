/**
 * One assistant turn, end to end (spec 104) — thread → messages → rail → tool loop → text.
 *
 * This is the function the panel calls. It owns the four decisions that must be made the same way
 * on both rails, so that neither the panel nor a rail makes them twice:
 *
 * THE THREAD IS TEXT, AND STAYS TEXT. The input is `memoryStore`'s shape — text turns — bounded to the
 * contract's `MAX_MESSAGES`, and the output is a text reply. Tool calls and results exist only
 * inside this call, in the loop's transient message list; nothing here writes them anywhere. A wager
 * envelope in device storage would be a retention decision, not a cache (research § 8.6).
 *
 * THE SURFACE RIDES ON THE LAST USER TURN, NEVER IN THE SYSTEM PROMPT. The model's cache is a
 * byte-prefix match over tools → system → messages, and interpolating the member's current path into
 * the system text rewrote that prefix on every navigation. `surfaceNote(surface)` is appended as a
 * SEPARATE trailing text block on the last user message, so the system text is frozen and the
 * member's own words stay their own block.
 *
 * WHO SENDS THE TOOLS DEPENDS ON THE RAIL. On GutterToken the browser is the only client, so it
 * sends `tools` (`selectTools` narrows to the public set when there is no read grant). On FairWins
 * the GATEWAY attaches the tool definitions itself and a client-supplied `tools` field would be
 * arbitrary text into the model at FairWins' expense — so the browser sends NONE, and only keeps the
 * definitions to bind the `tool_use` blocks that come back. Same loop, same executor, either way.
 *
 * AN EMPTY ANSWER IS NOT AN ANSWER. A final response with no text after a non-tool stop throws
 * `unavailable` / `empty_reply` (or `refusal`), so the panel renders an honest sentence and never a
 * blank bubble.
 */
import {
  MAX_MESSAGES,
  TOOL_DEFS,
  buildSystemPrompt,
  selectTools,
  surfaceNote,
  toolsForMessages,
} from '@fairwins/assistant-contract'
import { ASSISTANT_SESSION_SCOPES, AssistantError, sendChat } from './assistantClient'
import { loadGutterTokenKey } from './guttertokenKeyStore'
import { textOfContent, validateTurnMessages } from './messageShape'
import { sendGutterTokenTurn } from './providers/guttertoken'
import { executeTool as defaultExecuteTool } from './tools/executor'
import { runToolRounds } from './tools/toolLoop'

const isTextTurn = (m) =>
  m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0

/**
 * The model-bound message list for a text thread: the last `MAX_MESSAGES` text turns, opening on the
 * member, with the surface note as a trailing block on the last user turn.
 *
 * Exported for the tests; the panel never calls it directly.
 *
 * @param {Array<{role: string, content: string}>} thread
 * @param {string|null} surface
 * @param {{maxMessages?: number}} [options]
 */
export function buildBaseMessages(thread, surface, { maxMessages = MAX_MESSAGES } = {}) {
  let turns = (Array.isArray(thread) ? thread : []).filter(isTextTurn).slice(-maxMessages)
  // A conversation opens on the member. Trimming can leave an assistant turn first; drop it rather
  // than send a shape the API refuses.
  while (turns.length > 0 && turns[0].role !== 'user') turns = turns.slice(1)
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    throw new AssistantError('There is no question to send.', { state: 'rejected', code: 'no_prompt' })
  }
  const messages = turns.map((m) => ({ role: m.role, content: m.content }))
  const note = surfaceNote(surface)
  if (typeof note === 'string' && note.length > 0) {
    const last = messages[messages.length - 1]
    messages[messages.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: last.content },
        { type: 'text', text: note },
      ],
    }
  }
  return messages
}

/**
 * Run one turn.
 *
 * @param {{
 *   account: string,
 *   provider: 'fairwins'|'guttertoken',
 *   thread: Array<{role: 'user'|'assistant', content: string}>,   text turns, last one the member's
 *   surface?: string|null,
 *   membershipActive?: boolean,    informational — the rail was resolved before this call
 *   sessionToken?: string|null,    the 24-hour read grant, when the member has signed one
 *   onToolEvent?: (event) => void,
 *   relayerBase?: string,
 *   fetchImpl?: typeof fetch,
 *   executeTool?: typeof defaultExecuteTool,   test seam
 *   maxRounds?: number,
 * }} args
 * @returns {Promise<{reply: string, model: string|null, usage: {inputTokens: number|null, outputTokens: number|null}, toolEvents: Array, roundsExhausted: boolean}>}
 * @throws {AssistantError}
 */
export async function runAssistantTurn({
  account,
  provider,
  thread,
  surface = null,
  membershipActive = false, // eslint-disable-line no-unused-vars -- the rail is decided by resolveProvider; kept so the panel's call shape is stable
  sessionToken = null,
  onToolEvent,
  relayerBase,
  fetchImpl = fetch,
  executeTool = defaultExecuteTool,
  maxRounds,
}) {
  if (provider !== 'fairwins' && provider !== 'guttertoken') {
    throw new AssistantError('No assistant rail is available for this account.', { state: 'rejected', code: 'no_provider' })
  }
  const baseMessages = buildBaseMessages(thread, surface)
  const shape = validateTurnMessages(baseMessages)
  if (!shape.ok) {
    throw new AssistantError('This conversation cannot be sent as it is. Start a new thread.', { state: 'rejected', code: shape.code })
  }

  const hasGrant = typeof sessionToken === 'string' && sessionToken.length > 0
  const scopes = hasGrant ? [...ASSISTANT_SESSION_SCOPES] : []
  // What the model is OFFERED (GutterToken rail only — see header) is the selected set. What the
  // loop can BIND is the whole table: if the model calls a member-data tool it was not offered, the
  // executor answers `no_grant` with the sentence that tells the member what to do, and the panel
  // sees a `no_grant` tool event it can turn into the grant sheet. Answering `unknown_tool` there
  // would hide the one fact that unblocks the member.
  const offered = selectTools({ hasGrant, scopes })

  let callModel
  if (provider === 'guttertoken') {
    const apiKey = loadGutterTokenKey(account)
    if (!apiKey) {
      throw new AssistantError('Add a GutterToken key to use your own credits.', { state: 'key_missing' })
    }
    const system = buildSystemPrompt({ rail: 'guttertoken', hasMemberTools: hasGrant })
    const wireTools = toolsForMessages(offered)
    callModel = ({ messages }) => sendGutterTokenTurn({ apiKey, system, messages, tools: wireTools, fetchImpl })
  } else {
    // FairWins: no `tools` field — the gateway attaches its own (see header).
    callModel = ({ messages }) => sendChat({ account, messages, baseUrl: relayerBase, fetchImpl })
  }

  const bound = ({ def, input }) => executeTool({ def, input, account, sessionToken, relayerBase, fetchImpl })

  const result = await runToolRounds({
    callModel,
    executeTool: bound,
    tools: TOOL_DEFS,
    baseMessages,
    ...(maxRounds != null ? { maxRounds } : {}),
    onToolEvent,
  })

  const reply = textOfContent(result.content)
  if (reply.length === 0) {
    // Nothing to render is not an empty bubble; it is a named failure. An exhausted loop that ended
    // on a tool request has no text either, and the member is told the assistant ran out of reads.
    if (result.roundsExhausted) {
      throw new AssistantError('The assistant ran out of reads before it could answer. Ask again, more narrowly.', {
        state: 'unavailable',
        code: 'rounds_exhausted',
      })
    }
    throw new AssistantError(
      result.stopReason === 'refusal'
        ? 'The assistant declined to answer that. Rephrase, or ask a person.'
        : 'The assistant returned no answer. Try again shortly.',
      { state: 'unavailable', code: result.stopReason === 'refusal' ? 'refusal' : 'empty_reply' }
    )
  }

  return {
    reply,
    model: result.model,
    usage: result.usage,
    toolEvents: result.toolEvents,
    roundsExhausted: result.roundsExhausted === true,
  }
}
