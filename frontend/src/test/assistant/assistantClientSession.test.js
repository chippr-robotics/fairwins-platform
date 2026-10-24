/**
 * The spec-104 additions to the spec-095 transport: `sessionToken(account)` and block-shaped chat.
 *
 * `sessionToken` is the ONE way the clear grant leaves this module, and it exists for exactly one
 * caller — the tool executor, which puts it in an `Authorization` header on a member-API GET. So the
 * contract asserted here is narrow on purpose: it answers for THIS account only, it answers null
 * rather than throwing when there is no usable session (the executor then reports `no_grant`, which
 * is the fact that unblocks the member), and it goes away with the session.
 *
 * The chat assertions cover what the tool loop needs and spec 095 never sent: a message whose
 * content is a block array goes out verbatim, a `tool_use` answer comes back with its raw `content`
 * and `stopReason` and is NOT treated as an empty reply, and this rail still sends no `tools` field
 * of its own — the gateway attaches those, and a client-supplied table would be arbitrary text into
 * the model at FairWins' expense.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  __resetAssistantSessionForTests,
  authorizeSession,
  clearSession,
  hasSession,
  sendChat,
  sessionToken,
} from '../../lib/assistant/assistantClient'
import { response } from './helpers/http'

const BASE = 'https://relay.example'
const text = (t) => ({ type: 'text', text: t })

let wallet
let account
const sign = (domain, types, message) => wallet.signTypedData(domain, types, message)

beforeEach(() => {
  localStorage.clear()
  __resetAssistantSessionForTests()
  wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  account = wallet.address
})

describe('sessionToken', () => {
  it('is null with no session at all — never a throw, so the executor can report no_grant', () => {
    expect(sessionToken(account)).toBeNull()
    expect(sessionToken(null)).toBeNull()
    expect(sessionToken(undefined)).toBeNull()
  })

  it('returns the encoded grant once the member has signed one', async () => {
    await authorizeSession({ account, sign })
    const token = sessionToken(account)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
    expect(hasSession(account)).toBe(true)
  })

  it('answers for this account only, case-insensitively', async () => {
    await authorizeSession({ account, sign })
    expect(sessionToken(account.toLowerCase())).toBe(sessionToken(account))
    expect(sessionToken(account.toUpperCase())).toBe(sessionToken(account))
    expect(sessionToken('0x0000000000000000000000000000000000000001')).toBeNull()
  })

  it('goes away with the session', async () => {
    await authorizeSession({ account, sign })
    clearSession()
    expect(sessionToken(account)).toBeNull()
  })

  it('is not written to storage — module memory only', async () => {
    await authorizeSession({ account, sign })
    const token = sessionToken(account)
    const stored = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])
    expect(stored).not.toContain(token)
  })
})

describe('sendChat with block content', () => {
  it('sends a block-array message verbatim, with no tools field of its own', async () => {
    await authorizeSession({ account, sign })
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { model: 'm', stopReason: 'end_turn', content: [text('hi')] }))
    const messages = [
      { role: 'user', content: [text('q'), text('note')] },
      { role: 'assistant', content: [text('looking'), { type: 'tool_use', id: 't1', name: 'get_fees', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"bps":0}' }] },
    ]
    const result = await sendChat({ account, messages, baseUrl: BASE, fetchImpl })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.messages).toEqual(messages)
    expect(body).not.toHaveProperty('tools')
    expect(result).toMatchObject({ reply: 'hi', stopReason: 'end_turn', model: 'm' })
    expect(result.content).toEqual([text('hi')])
  })

  it('passes a tool_use answer through with no text, instead of calling it an empty reply', async () => {
    await authorizeSession({ account, sign })
    const content = [{ type: 'tool_use', id: 't1', name: 'get_gateway_status', input: {} }]
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { model: 'm', stopReason: 'tool_use', content }))
    const result = await sendChat({ account, messages: [{ role: 'user', content: 'q' }], baseUrl: BASE, fetchImpl })
    expect(result).toMatchObject({ reply: '', stopReason: 'tool_use' })
    expect(result.content).toEqual(content)
  })

  it('still refuses an answer that is neither text nor a tool request', async () => {
    await authorizeSession({ account, sign })
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { model: 'm', stopReason: 'tool_use', content: [] }))
    await expect(sendChat({ account, messages: [{ role: 'user', content: 'q' }], baseUrl: BASE, fetchImpl })).rejects.toMatchObject({
      state: 'unavailable',
      code: 'empty_reply',
    })
  })

  it('reads the snake_case stop_reason a gateway may send', async () => {
    await authorizeSession({ account, sign })
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { model: 'm', stop_reason: 'end_turn', content: [text('hi')] }))
    await expect(sendChat({ account, messages: [{ role: 'user', content: 'q' }], baseUrl: BASE, fetchImpl })).resolves.toMatchObject({
      stopReason: 'end_turn',
    })
  })
})
