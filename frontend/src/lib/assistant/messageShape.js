/**
 * Message shape for a model turn (spec 104) — shared by both rails and the tool loop.
 *
 * Before spec 104 a message was `{ role, content: string }` and nothing else. The tool loop adds two
 * more shapes to the same list: an assistant turn whose content is the model's own block array
 * (`text` + `tool_use`), and a user turn that is a list of `tool_result` blocks. One validator for
 * the whole list, used by the GutterToken transport before it spends the member's credit and by the
 * conversation builder before it asks either rail, so a malformed thread is refused here with a
 * named code instead of upstream with a 400 whose body may echo the member's text.
 *
 * The allowed block types come from `@fairwins/assistant-contract` — the same allow-list the
 * gateway's `parseChatRequest` enforces on the FairWins rail — so a block the gateway would refuse
 * is refused on the GutterToken rail as well, and the two rails cannot drift on what a message is.
 */
import { ALLOWED_CONTENT_BLOCK_TYPES } from '@fairwins/assistant-contract'

const ROLES = new Set(['user', 'assistant'])
const BLOCK_TYPES = new Set(ALLOWED_CONTENT_BLOCK_TYPES)

/** The text of a message's content: the string itself, or the `text` blocks joined. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function validBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false
  if (!BLOCK_TYPES.has(block.type)) return false
  if (block.type === 'text') return typeof block.text === 'string' && block.text.length > 0
  if (block.type === 'tool_use') return typeof block.id === 'string' && typeof block.name === 'string'
  if (block.type === 'tool_result') return typeof block.tool_use_id === 'string'
  return true
}

/**
 * Validate a message list bound for a model.
 *
 * Rules: a non-empty array; each `{ role: 'user'|'assistant', content }` where content is a non-empty
 * string or a non-empty array of allowed blocks; the first turn is the member's. The list is not
 * capped here — the conversation builder bounds the TEXT thread to `MAX_MESSAGES`, and tool rounds
 * legitimately append beyond that.
 *
 * @param {unknown} messages
 * @returns {{ok: true} | {ok: false, code: string, error: string}}
 */
export function validateTurnMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, code: 'no_messages', error: 'There is nothing to send.' }
  }
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) {
      return { ok: false, code: 'bad_role', error: `Message ${i} has no valid role.` }
    }
    if (typeof m.content === 'string') {
      if (m.content.length === 0) return { ok: false, code: 'empty_content', error: `Message ${i} is empty.` }
      continue
    }
    if (!Array.isArray(m.content) || m.content.length === 0 || !m.content.every(validBlock)) {
      return { ok: false, code: 'bad_content', error: `Message ${i} carries content this app does not send.` }
    }
  }
  if (messages[0].role !== 'user') {
    return { ok: false, code: 'first_not_user', error: 'A conversation starts with the member.' }
  }
  return { ok: true }
}
