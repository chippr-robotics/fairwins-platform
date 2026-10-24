import { describe, it, expect } from 'vitest'
import { decodeActivity } from '../../hooks/useFundingPools'

const POOL = '0x5067457698Fd6Fa1C6964e416b3f42713513B3dD'
const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
// `{ name, args }` — the shape `eventScanHandle(...).interface.parseLog` returns (spec 110). It
// used to be ethers' `{ fragment: { name }, args }`; a fixture keeping that shape would be
// describing a decoder the code no longer uses.
const ev = (name, args, blockNumber, index) => ({ name, args, blockNumber, index, transactionHash: `0xtx${blockNumber}${index}` })

describe('decodeActivity — the clone log → feed entries (FR-009)', () => {
  it('decodes every event kind, newest first, with an address-derived alias', () => {
    const entries = decodeActivity([
      ev('Contributed', { contributor: A, amount: 10n, contributedTotal: 10n, totalRaised: 10n }, 5, 0),
      ev('RefundVoted', { contributor: A, votes: 1n, needed: 2n }, 6, 1),
      ev('RefundingStarted', { reason: 2n }, 6, 2),
      ev('RefundClaimed', { contributor: A, amount: 10n }, 7, 0),
      ev('PoolClosed', { organizer: A, amount: 0n }, 8, 0),
      { name: null, args: null }, // an undecodable log is skipped, not a crash
    ], POOL)
    expect(entries.map((e) => e.kind)).toEqual(['close', 'refund', 'refunding', 'vote', 'contribute'])
    expect(entries[4]).toMatchObject({ actor: A, amount: 10n, blockNumber: 5, logIndex: 0 })
    expect(entries[2]).toMatchObject({ reason: 'majority', actor: null, alias: null })
    expect(entries[3]).toMatchObject({ votes: 1, needed: 2 })
    expect(typeof entries[4].alias).toBe('string')
    expect(entries[4].alias.length).toBeGreaterThan(0)
  })
})
