/**
 * The client-side tool loop (spec 104, research § 8.6) — bounded rounds, parallel calls, one result
 * message per round, and no fabricated ending.
 *
 * The Messages API has no loop of its own: the model answers `stop_reason: 'tool_use'` with one or
 * more `tool_use` blocks, the CLIENT runs them and sends the results back as `tool_result` blocks in
 * a single user turn, and the model continues. This module is that loop, written once for both
 * rails: `callModel` is the rail (gateway or GutterToken) and `executeTool` is the browser's
 * executor; the loop knows neither.
 *
 * FOUR RULES:
 *
 * 1. ALL `tool_use` BLOCKS OF A ROUND RUN CONCURRENTLY, and ALL their results go back in ONE user
 *    message, in the model's own order. Splitting them across turns is a protocol error; dropping a
 *    failed one is a lie by omission.
 * 2. A FAILED READ IS `is_error: true` WITH THE CONTRACT'S HONEST WORDING (`failedResultText`), never
 *    a thrown exception, never an empty string. "Polygon indexer did not answer" is an answer.
 * 3. A RESULT IS BOUNDED, TWICE: per result (`MAX_TOOL_RESULT_CHARS`) and per request — the gateway
 *    refuses a body over `MAX_REQUEST_CONTENT_CHARS` with a 400 the loop cannot recover from, so a
 *    round's results share what is left of that cap evenly. A wager list is not allowed to blow the
 *    context, the member's credit, or the next request, and the truncation marker says it happened.
 * 4. AT MOST `maxRounds` TOOL ROUNDS. The response after the last permitted round is returned AS IT
 *    IS, with `roundsExhausted: true`, and its unexecuted `tool_use` blocks are simply not run — the
 *    caller renders whatever text it carries and says the assistant ran out of reads. A loop that
 *    kept going on the member's credit would be the one thing worse than stopping early.
 *
 * The loop never persists anything. Tool results are the member's own data, and `memoryStore` keeps
 * text only (research § 8.6) — the transient `messages` array returned here is for the caller's
 * turn and dies with it.
 */
import {
  MAX_REQUEST_CONTENT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_ROUNDS,
  toolResultBlock,
} from '@fairwins/assistant-contract'

const isToolUse = (block) => block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'

/**
 * The fewest characters one result may be cut to. Enough for `failedResultText`'s whole sentence
 * — a failure that is truncated into "This read did not succ" has lost the one fact it carried.
 */
export const MIN_RESULT_CHARS = 400

/** Characters of content in a message list — what the gateway's `MAX_REQUEST_CONTENT_CHARS` counts. */
export function contentChars(messages) {
  let total = 0
  for (const m of messages) {
    if (typeof m?.content === 'string') {
      total += m.content.length
      continue
    }
    for (const block of Array.isArray(m?.content) ? m.content : []) {
      if (typeof block?.text === 'string') total += block.text.length
      else if (typeof block?.content === 'string') total += block.content.length
      else if (block?.type === 'tool_use') total += JSON.stringify(block.input ?? {}).length
    }
  }
  return total
}

/**
 * How large each of this round's `count` results may be so the NEXT request stays under the
 * gateway's request-content cap. Per-result first (`MAX_TOOL_RESULT_CHARS`), then the shared
 * budget split evenly, never below `MIN_RESULT_CHARS`. Splitting evenly rather than first-come is
 * what keeps a huge wager list from starving the parallel status read beside it.
 */
export function resultBudget(messagesSoFar, count, { requestCap = MAX_REQUEST_CONTENT_CHARS, perResult = MAX_TOOL_RESULT_CHARS } = {}) {
  const remaining = requestCap - contentChars(messagesSoFar)
  const share = Math.floor(remaining / Math.max(1, count))
  return Math.max(MIN_RESULT_CHARS, Math.min(perResult, share))
}

/** One `tool_result` block from an executor outcome, via the contract's own builder. */
function resultBlock(toolUseId, outcome, max) {
  if (outcome?.ok === true) return toolResultBlock({ toolUseId, ok: true, value: outcome.value, max })
  const error = outcome?.error || { code: 'tool_failed', reason: 'this tool failed in a way the app did not expect' }
  return toolResultBlock({ toolUseId, ok: false, error, max })
}

/** Sum two nullable counts: unknown + known stays unknown on the unknown side, never a zero. */
function addCount(a, b) {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return null
  return (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0)
}

/**
 * Run the loop.
 *
 * @param {{
 *   callModel: (args: {messages: Array, tools: Array}) => Promise<{content: Array, stopReason: string|null, model?: string, usage?: {inputTokens: number|null, outputTokens: number|null}}>,
 *   executeTool: (args: {def: object, input: object, toolUseId: string}) => Promise<{ok: boolean, value?: unknown, error?: object}>,
 *   tools: Array<{name: string}>,   the tool DEFINITIONS in scope — the rail decides how (or whether) to send them
 *   baseMessages: Array,
 *   maxRounds?: number,
 *   onToolEvent?: (event: {name: string, phase: 'start'|'done', ok?: boolean, code?: string|null}) => void,
 * }} args
 * @returns {Promise<{content: Array, stopReason: string|null, model: string|null, usage: {inputTokens: number|null, outputTokens: number|null}, toolEvents: Array, roundsExhausted: boolean, rounds: number, messages: Array}>}
 */
export async function runToolRounds({
  callModel,
  executeTool,
  tools = [],
  baseMessages,
  maxRounds = MAX_TOOL_ROUNDS,
  onToolEvent,
}) {
  const messages = [...baseMessages]
  const toolEvents = []
  const defsByName = new Map((tools || []).map((def) => [def.name, def]))
  let usage = { inputTokens: null, outputTokens: null }
  let model = null

  const emit = (event) => {
    toolEvents.push(event)
    if (typeof onToolEvent === 'function') {
      try {
        onToolEvent(event)
      } catch {
        // A rendering hiccup must not end the member's turn.
      }
    }
  }

  const finish = (result, rounds, roundsExhausted) => ({
    content: result.content,
    stopReason: result.stopReason,
    model,
    usage,
    toolEvents,
    roundsExhausted,
    rounds,
    messages,
  })

  for (let round = 0; ; round += 1) {
    const result = await callModel({ messages, tools })
    if (typeof result?.model === 'string') model = result.model
    usage = {
      inputTokens: addCount(usage.inputTokens, result?.usage?.inputTokens),
      outputTokens: addCount(usage.outputTokens, result?.usage?.outputTokens),
    }

    const content = Array.isArray(result?.content) ? result.content : []
    const toolUses = result?.stopReason === 'tool_use' ? content.filter(isToolUse) : []
    if (toolUses.length === 0) return finish({ ...result, content }, round, false)
    if (round >= maxRounds) return finish({ ...result, content }, round, true)

    // Budget the results against what the next request will already carry: the thread so far plus
    // the assistant content that asked for them.
    const max = resultBudget([...messages, { role: 'assistant', content }], toolUses.length)

    const results = await Promise.all(
      toolUses.map(async (block) => {
        emit({ name: block.name, phase: 'start' })
        let outcome
        const def = defsByName.get(block.name)
        if (!def) {
          outcome = { ok: false, error: { code: 'unknown_tool', reason: `"${block.name}" is not a tool this app offers`, retryAfterSec: null } }
        } else {
          try {
            outcome = await executeTool({ def, input: block.input ?? {}, toolUseId: block.id })
          } catch {
            outcome = { ok: false, error: { code: 'tool_failed', reason: 'this tool failed in a way the app did not expect', retryAfterSec: null } }
          }
        }
        const ok = outcome?.ok === true
        emit({ name: block.name, phase: 'done', ok, code: ok ? null : outcome?.error?.code ?? 'tool_failed' })
        return resultBlock(block.id, outcome, max)
      })
    )

    messages.push({ role: 'assistant', content }, { role: 'user', content: results })
  }
}
