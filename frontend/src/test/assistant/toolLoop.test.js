/**
 * The tool loop (spec 104, research § 8.6).
 *
 * Asserted: a round's parallel `tool_use` blocks come back as ONE user message with every result in
 * the model's order; a failed read is `is_error: true` with the contract's wording; the rounds cap
 * holds and the last response is returned as-is; the event sequence a panel renders is start/done
 * per tool; and results are bounded against the request cap.
 */
import { describe, it, expect, vi } from 'vitest'
import { MAX_REQUEST_CONTENT_CHARS, MAX_TOOL_ROUNDS, UNKNOWN_NOT_EMPTY } from '@fairwins/assistant-contract'
import { MIN_RESULT_CHARS, contentChars, resultBudget, runToolRounds } from '../../lib/assistant/tools/toolLoop'

const TOOLS = [
  { name: 'get_gateway_status', exec: { kind: 'public' } },
  { name: 'get_wagers', exec: { kind: 'route' } },
  { name: 'find_in_app', exec: { kind: 'local' } },
]
const BASE = [{ role: 'user', content: 'what do I have?' }]

const text = (t) => ({ type: 'text', text: t })
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input })
const turn = (content, stopReason = 'end_turn', usage = { inputTokens: 10, outputTokens: 5 }) => ({ content, stopReason, model: 'm', usage })

/** A scripted model: answers each call from the queue, records what it was sent. */
function scripted(turns) {
  const calls = []
  const callModel = vi.fn(async ({ messages, tools }) => {
    calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools })
    if (turns.length === 0) throw new Error('model called more times than scripted')
    return turns.shift()
  })
  return { callModel, calls }
}

describe('runToolRounds', () => {
  it('returns immediately on a non-tool stop, with no events', async () => {
    const { callModel, calls } = scripted([turn([text('hello')])])
    const executeTool = vi.fn()
    const result = await runToolRounds({ callModel, executeTool, tools: TOOLS, baseMessages: BASE })
    expect(result).toMatchObject({ content: [text('hello')], stopReason: 'end_turn', model: 'm', roundsExhausted: false, rounds: 0, toolEvents: [] })
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(executeTool).not.toHaveBeenCalled()
    expect(calls[0].tools).toBe(TOOLS)
    expect(calls[0].messages).toEqual(BASE)
  })

  it('runs parallel tool_use blocks concurrently and returns all results in ONE user message, in order', async () => {
    const { callModel, calls } = scripted([
      turn([text('Let me check.'), use('t1', 'get_gateway_status'), use('t2', 'get_wagers', { first: 3 }), use('t3', 'find_in_app', { query: 'earn' })], 'tool_use'),
      turn([text('Done.')]),
    ])
    let inFlight = 0
    let maxInFlight = 0
    const executeTool = vi.fn(async ({ def, input, toolUseId }) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Distinct delays so completion order (find, wagers, status) is the REVERSE of the model's order.
      await new Promise((r) => setTimeout(r, { get_gateway_status: 40, get_wagers: 20, find_in_app: 1 }[def.name]))
      inFlight -= 1
      if (def.name === 'get_wagers') return { ok: false, error: { code: 'unreadable', reason: 'Polygon indexer did not answer', retryAfterSec: null } }
      return { ok: true, value: { tool: def.name, input, toolUseId } }
    })
    const events = []
    const result = await runToolRounds({ callModel, executeTool, tools: TOOLS, baseMessages: BASE, onToolEvent: (e) => events.push(e) })

    expect(maxInFlight).toBe(3)
    expect(result).toMatchObject({ content: [text('Done.')], roundsExhausted: false, rounds: 1 })
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 })

    const second = calls[1].messages
    expect(second).toHaveLength(3)
    expect(second[1]).toEqual({ role: 'assistant', content: calls[1].messages[1].content })
    expect(second[1].content[1]).toEqual(use('t1', 'get_gateway_status'))
    expect(second[2].role).toBe('user')
    expect(second[2].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2', 't3']) // the model's order, not completion order
    expect(second[2].content.every((b) => b.type === 'tool_result')).toBe(true)
    expect(second[2].content[0].is_error).toBe(false)
    expect(JSON.parse(second[2].content[0].content)).toMatchObject({ tool: 'get_gateway_status' })
    expect(second[2].content[1].is_error).toBe(true)
    expect(second[2].content[1].content).toContain('unreadable — Polygon indexer did not answer')
    expect(second[2].content[1].content).toContain(UNKNOWN_NOT_EMPTY)

    expect(events.map((e) => `${e.name}:${e.phase}${e.phase === 'done' ? `:${e.ok}:${e.code}` : ''}`)).toEqual([
      'get_gateway_status:start',
      'get_wagers:start',
      'find_in_app:start',
      'find_in_app:done:true:null',
      'get_wagers:done:false:unreadable',
      'get_gateway_status:done:true:null',
    ])
    expect(result.toolEvents).toEqual(events)
  })

  it('answers an unknown tool name and a throwing executor as is_error results, never a rejection', async () => {
    const { callModel, calls } = scripted([turn([use('t1', 'navigate', { to: '/x' }), use('t2', 'find_in_app')], 'tool_use'), turn([text('ok')])])
    const executeTool = vi.fn(async () => {
      throw new Error('0xdeadbeef boom')
    })
    const result = await runToolRounds({ callModel, executeTool, tools: TOOLS, baseMessages: BASE })
    expect(result.content).toEqual([text('ok')])
    const results = calls[1].messages[2].content
    expect(results[0]).toMatchObject({ tool_use_id: 't1', is_error: true })
    expect(results[0].content).toContain('unknown_tool')
    expect(results[1]).toMatchObject({ tool_use_id: 't2', is_error: true })
    expect(results[1].content).toContain('tool_failed')
    expect(JSON.stringify(results)).not.toContain('0xdeadbeef')
    expect(executeTool).toHaveBeenCalledTimes(1) // the unknown tool never reached the executor
  })

  it('stops after maxRounds and returns the last response as-is, unexecuted', async () => {
    const asking = () => turn([text('still reading…'), use('t', 'get_gateway_status')], 'tool_use')
    const { callModel } = scripted([asking(), asking(), asking(), asking(), asking(), asking()])
    const executeTool = vi.fn(async () => ({ ok: true, value: 1 }))
    const result = await runToolRounds({ callModel, executeTool, tools: TOOLS, baseMessages: BASE })
    expect(callModel).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1)
    expect(executeTool).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
    expect(result).toMatchObject({ roundsExhausted: true, rounds: MAX_TOOL_ROUNDS, stopReason: 'tool_use' })
    expect(result.content).toEqual([text('still reading…'), use('t', 'get_gateway_status')])
  })

  it('honours a smaller maxRounds', async () => {
    const asking = () => turn([use('t', 'get_gateway_status')], 'tool_use')
    const { callModel } = scripted([asking(), asking(), asking()])
    const result = await runToolRounds({ callModel, executeTool: async () => ({ ok: true, value: 1 }), tools: TOOLS, baseMessages: BASE, maxRounds: 1 })
    expect(callModel).toHaveBeenCalledTimes(2)
    expect(result.roundsExhausted).toBe(true)
  })

  it('treats a tool_use stop with no tool_use blocks as final', async () => {
    const { callModel } = scripted([turn([text('odd')], 'tool_use')])
    const result = await runToolRounds({ callModel, executeTool: vi.fn(), tools: TOOLS, baseMessages: BASE })
    expect(result).toMatchObject({ content: [text('odd')], roundsExhausted: false })
  })

  it('does not mutate baseMessages and keeps an unknown usage count null', async () => {
    const base = [{ role: 'user', content: 'q' }]
    const { callModel } = scripted([turn([use('t', 'find_in_app')], 'tool_use', { inputTokens: null, outputTokens: 4 }), turn([text('a')], 'end_turn', { inputTokens: null, outputTokens: null })])
    const result = await runToolRounds({ callModel, executeTool: async () => ({ ok: true, value: 'x' }), tools: TOOLS, baseMessages: base })
    expect(base).toHaveLength(1)
    expect(result.messages).toHaveLength(3)
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: 4 })
  })

  it('swallows a throwing onToolEvent', async () => {
    const { callModel } = scripted([turn([use('t', 'find_in_app')], 'tool_use'), turn([text('a')])])
    await expect(
      runToolRounds({ callModel, executeTool: async () => ({ ok: true, value: 1 }), tools: TOOLS, baseMessages: BASE, onToolEvent: () => { throw new Error('ui') } })
    ).resolves.toMatchObject({ content: [text('a')] })
  })
})

describe('request budget', () => {
  it('counts content characters across strings, text blocks, tool inputs and tool results', () => {
    expect(
      contentChars([
        { role: 'user', content: 'abcd' },
        { role: 'assistant', content: [text('xy'), use('t', 'n', { q: 'zz' })] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '123' }] },
      ])
    ).toBe(4 + 2 + JSON.stringify({ q: 'zz' }).length + 3)
  })

  it('splits what is left of the request cap evenly, never above the per-result cap or below the floor', () => {
    expect(resultBudget([{ role: 'user', content: 'q' }], 1)).toBeLessThanOrEqual(12_000)
    const nearlyFull = [{ role: 'user', content: 'x'.repeat(MAX_REQUEST_CONTENT_CHARS - 1000) }]
    expect(resultBudget(nearlyFull, 2)).toBe(500)
    expect(resultBudget(nearlyFull, 10)).toBe(MIN_RESULT_CHARS)
  })

  it('keeps a round of huge results under the request cap and says they were cut', async () => {
    const huge = 'w'.repeat(50_000)
    const { callModel, calls } = scripted([turn([use('t1', 'get_wagers'), use('t2', 'get_wagers'), use('t3', 'get_wagers')], 'tool_use'), turn([text('a')])])
    await runToolRounds({ callModel, executeTool: async () => ({ ok: true, value: huge }), tools: TOOLS, baseMessages: BASE })
    const next = calls[1].messages
    expect(contentChars(next)).toBeLessThanOrEqual(MAX_REQUEST_CONTENT_CHARS)
    for (const block of next[2].content) expect(block.content).toMatch(/\[truncated: \d+ more characters\]$/)
  })
})
