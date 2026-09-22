/**
 * `lib/chains/logRange.js#getLogsRange` — the bisect-on-reject log scan (spec 110 T028).
 *
 * It had no test of its own while it lived in a DAO connector, despite two host hooks depending on
 * it to read the MembershipManager and the CallsignRegistry. The behaviour worth pinning is what
 * it does when a provider REFUSES a range, because that is the only path anybody exercises in
 * anger and the one where getting it wrong is silent: return fewer logs than exist and the surface
 * renders a smaller number, not an error.
 *
 * Every assertion here is on the REQUESTS the reader received, not just the returned array — a
 * scan that happened to return the right logs by asking for the wrong ranges would pass otherwise.
 */
import { describe, it, expect, vi } from 'vitest'
import { getLogsRange } from '../../lib/chains/logRange'

const ADDRESS = `0x${'ab'.repeat(20)}`

/** A reader that refuses any range wider than `cap`, the way a public RPC does. */
function cappedReader(cap, logsByBlock = {}) {
  const calls = []
  return {
    calls,
    async getLogs({ address, topics, fromBlock, toBlock }) {
      calls.push({ address, topics, fromBlock, toBlock })
      if (toBlock - fromBlock + 1 > cap) throw new Error('query returned more than 10000 results')
      const out = []
      for (let b = fromBlock; b <= toBlock; b += 1) if (logsByBlock[b]) out.push(logsByBlock[b])
      return out
    },
  }
}

describe('getLogsRange', () => {
  it('asks once and returns, when the provider accepts the range', async () => {
    const reader = cappedReader(10_000, { 5: { id: 'a' }, 9: { id: 'b' } })
    const logs = await getLogsRange(reader, ADDRESS, 1, 10, 2000, [])
    expect(logs).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]).toEqual({ address: ADDRESS, topics: [], fromBlock: 1, toBlock: 10 })
  })

  it('halves a refused range until it is accepted, and loses no log at the seam', async () => {
    // The off-by-one that matters: the halves must be [from..mid] and [mid+1..to]. A log sitting
    // exactly on the boundary is the one a wrong split drops, and dropping it is invisible.
    const logsByBlock = {}
    for (let b = 1; b <= 64; b += 1) logsByBlock[b] = { block: b }
    const reader = cappedReader(8, logsByBlock)

    const logs = await getLogsRange(reader, ADDRESS, 1, 64, 1, [])
    expect(logs.map((l) => l.block)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1))

    // Every accepted request was within the cap, and the union covers [1..64] exactly once.
    const accepted = reader.calls.filter((c) => c.toBlock - c.fromBlock + 1 <= 8)
    const covered = []
    for (const c of accepted) for (let b = c.fromBlock; b <= c.toBlock; b += 1) covered.push(b)
    expect(covered.sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1))
  })

  it('stops bisecting at minSpan and lets the real error through', async () => {
    // Below minSpan the provider is not complaining about width any more, so halving again would
    // turn a genuine failure into a quiet partial result.
    const reader = { calls: [], async getLogs(f) { this.calls.push(f); throw new Error('boom') } }
    await expect(getLogsRange(reader, ADDRESS, 1, 100, 2000, [])).rejects.toThrow('boom')
    expect(reader.calls).toHaveLength(1) // 100 blocks is already under minSpan — no bisect at all
  })

  it('propagates rather than returning a short list when the failure is not about range', async () => {
    const reader = {
      calls: [],
      async getLogs(f) {
        this.calls.push(f)
        throw new Error('execution reverted')
      },
    }
    await expect(getLogsRange(reader, ADDRESS, 1, 10_000, 100, [])).rejects.toThrow('execution reverted')
    // It DID try to bisect (the width invites it) and still ended in a throw, never [].
    expect(reader.calls.length).toBeGreaterThan(1)
  })

  it('passes the topic filter through unchanged, including the empty one', async () => {
    const reader = cappedReader(10_000)
    const topics = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]
    await getLogsRange(reader, ADDRESS, 1, 10, 2000, topics)
    expect(reader.calls[0].topics).toBe(topics)

    const bare = cappedReader(10_000)
    await getLogsRange(bare, ADDRESS, 1, 10, 2000, [])
    // `[]` means "every event from this address" and must not become undefined on the way through.
    expect(bare.calls[0].topics).toEqual([])
  })

  it('works with any reader exposing getLogs — the duck type the hooks rely on', async () => {
    // `eventScanHandle(...).provider` and an ethers provider both satisfy this, which is why the
    // already-converted hooks could keep calling it unchanged through the move.
    const handleShaped = { getLogs: vi.fn(async () => [{ id: 'x' }]) }
    await expect(getLogsRange(handleShaped, ADDRESS, 1, 10, 2000, [])).resolves.toEqual([{ id: 'x' }])
    expect(handleShaped.getLogs).toHaveBeenCalledWith({
      address: ADDRESS,
      topics: [],
      fromBlock: 1,
      toBlock: 10,
    })
  })
})
