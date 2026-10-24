/**
 * Honest tool-result wording — the MCP server's sentences, made reusable (spec 104, research § 8.3).
 *
 * The one thing a tool result must never do is turn a failed read into an empty one. "This member
 * has no wagers on Polygon" and "the Polygon indexer did not answer" are different facts, and only
 * one of them is safe to repeat to a member; a loop that returns `[]` or `0` for the second has
 * destroyed the distinction before the model ever saw it. So a failure is a `tool_result` with
 * `is_error: true` whose text names the code, the gateway's own reason, and — in so many words —
 * that the answer is UNKNOWN. The closing sentence is copied verbatim from
 * `services/mcp-server/src/tools.js#failed`, and a gateway test asserts the two stay identical.
 */
import { MAX_TOOL_RESULT_CHARS } from './tools.js'

/** The sentence that stops an agent reading a failure as "none". Verbatim from the MCP server. */
export const UNKNOWN_NOT_EMPTY =
  'This is an UNKNOWN, not an empty result. Do not report it as "none", "zero" or "no records"; ' +
  'say that the data could not be read and, where it matters, offer to try again.'

/** The text of a successful result: a string as-is, anything else as readable JSON. */
export function okResultText(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'null'
  return JSON.stringify(value, null, 2)
}

/**
 * The text of a failed result.
 *
 * `code` is machine-readable and stable, `reason` is the gateway's own words, `retryAfterSec` (when
 * the failure was a quota) tells the model how long "try again" means.
 *
 * @param {{code?: string, reason?: string, retryAfterSec?: number|null}} failure
 */
export function failedResultText({ code = 'tool_failed', reason = 'no reason was given', retryAfterSec = null } = {}) {
  const retry = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? ` Retry after ${retryAfterSec}s.` : ''
  return `This read did not succeed: ${code} — ${reason}${retry}\n\n${UNKNOWN_NOT_EMPTY}`
}

/**
 * Cut a result to `max` characters and SAY SO. A silently truncated JSON envelope would read to the
 * model as a shorter list, which is a fabricated fact; the marker names exactly how much is missing.
 */
export function truncateResultText(text, max = MAX_TOOL_RESULT_CHARS) {
  const s = typeof text === 'string' ? text : okResultText(text)
  if (s.length <= max) return s
  const marker = (n) => `\n[truncated: ${n} more characters]`
  // Leave room for the marker itself so the block stays under `max`.
  let keep = Math.max(0, max - marker(s.length).length)
  let out = s.slice(0, keep) + marker(s.length - keep)
  while (out.length > max && keep > 0) {
    keep -= 1
    out = s.slice(0, keep) + marker(s.length - keep)
  }
  return out
}

/**
 * One Messages-API `tool_result` block.
 *
 * @param {{toolUseId: string, ok: boolean, value?: unknown, error?: {code?: string, reason?: string, retryAfterSec?: number|null}, max?: number}} r
 * @returns {{type: 'tool_result', tool_use_id: string, content: string, is_error: boolean}}
 */
export function toolResultBlock({ toolUseId, ok, value, error, max = MAX_TOOL_RESULT_CHARS }) {
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) {
    throw new TypeError('toolResultBlock: toolUseId must be the non-empty id of the tool_use block it answers')
  }
  const content = ok ? truncateResultText(okResultText(value), max) : truncateResultText(failedResultText(error ?? {}), max)
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: !ok }
}
