import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * The roster regression from issue #1458's QA round.
 *
 * Chain 1337 is `isTestnet: true`, so every testnet build's cohort contained it; it carries a
 * `sanctionsGuard` in the contracts config; and its endpoint is `http://127.0.0.1:8545`. A
 * deployed testnet build therefore asked a source it could never reach, reported it to the member
 * as "could not be read", and — correctly, by the rule that an unanswered list is not a clear one
 * — could never show green. Three of four sources unreadable, forever, on a build where the other
 * two networks answered fine.
 *
 * These tests drive the filter directly rather than the ambient cohort, because the cohort a test
 * run happens to resolve is not the thing under test: the rule is "a sandbox is never a source",
 * and it must hold in a build whose cohort contains one.
 */
const world = vi.hoisted(() => ({ cohort: [], local: new Set([1337]) }))

vi.mock('../../config/networks', () => ({
  cohortChainIds: () => world.cohort,
}))
vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: () => undefined,
  isLocalOnlyChain: (id) => world.local.has(Number(id)),
}))

import { screeningChainIds } from '../../lib/screening/sources'

describe('screeningChainIds — the cohort, minus what no shipped build can reach', () => {
  beforeEach(() => {
    world.cohort = []
    world.local = new Set([1337])
  })

  it('drops the local sandbox from a testnet cohort that contains it', () => {
    world.cohort = [80002, 63, 11155111, 560048, 1337]
    expect(screeningChainIds()).toEqual([80002, 63, 11155111, 560048])
  })

  it('keeps every real network, in cohort order', () => {
    world.cohort = [1, 10, 137, 8453, 42161]
    expect(screeningChainIds()).toEqual([1, 10, 137, 8453, 42161])
  })

  it('never widens the cohort — it can only subtract', () => {
    world.cohort = [63]
    const roster = screeningChainIds()
    expect(roster.every((id) => world.cohort.includes(id))).toBe(true)
  })

  it('would fail if the filter were dropped (the sandbox is the whole point)', () => {
    world.cohort = [1337]
    expect(screeningChainIds()).toEqual([])
  })
})
