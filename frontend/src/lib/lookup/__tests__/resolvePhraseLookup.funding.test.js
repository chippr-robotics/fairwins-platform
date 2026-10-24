import { describe, it, expect, vi } from 'vitest'
import { resolvePhraseLookup } from '../resolvePhraseLookup.js'

// Spec 102, FR-021: the unified four-word lookup also checks the funding-pool factory and reports which
// kind it found — never opening the wrong pool type silently, and never saying "no match" when the
// funding source could not be checked.

const PHRASE = 'river amber tiger kite'
const notFound = async () => ({ status: 'not-found', reason: 'none' })
const poolMiss = async () => ({ notFound: true, reason: 'unknown' })
const fundingHit = async () => ({ summary: { address: '0xF', purpose: 'Party', state: 0 } })
const wagerHit = async () => ({ summary: { address: '0xW', state: 0, slotsRemaining: 3, acceptDeadline: 0, isCreator: false, hasJoined: false } })

describe('resolvePhraseLookup — funding pools', () => {
  it('reports kind "funding" when only the funding factory matches', async () => {
    const res = await resolvePhraseLookup({ phrase: PHRASE, deps: { lookupChallenge: notFound, resolvePool: poolMiss, resolveFunding: fundingHit } })
    expect(res.kind).toBe('funding')
    expect(res.match.address).toBe('0xF')
  })

  it('a wager pool wins, and the funding pool rides along as a second row', async () => {
    const res = await resolvePhraseLookup({ phrase: PHRASE, deps: { lookupChallenge: notFound, resolvePool: wagerHit, resolveFunding: fundingHit } })
    expect(res.kind).toBe('pool')
    expect(res.funding.address).toBe('0xF')
  })

  it('a funding source that errored is a lookup-failed, not a "none"', async () => {
    const res = await resolvePhraseLookup({
      phrase: PHRASE,
      deps: { lookupChallenge: notFound, resolvePool: poolMiss, resolveFunding: async () => { throw new Error('rpc') } },
    })
    expect(res).toEqual({ kind: 'lookup-failed', sources: ['funding'] })
  })

  it('without a funding resolver, behaviour is unchanged (none)', async () => {
    const res = await resolvePhraseLookup({ phrase: PHRASE, deps: { lookupChallenge: notFound, resolvePool: poolMiss } })
    expect(res).toEqual({ kind: 'none' })
  })

  it('an unavailable funding factory reads as not-found, not as an error', async () => {
    const res = await resolvePhraseLookup({
      phrase: PHRASE,
      deps: { lookupChallenge: notFound, resolvePool: poolMiss, resolveFunding: async () => ({ notFound: true, reason: 'unavailable' }) },
    })
    expect(res).toEqual({ kind: 'none' })
    expect(vi.isMockFunction(notFound)).toBe(false)
  })
})
