/**
 * The estate-wide wager read (spec 110 Phase 4, T040 — issue #1595).
 *
 * The thing under test is the honesty of the three states, because the fetcher it wraps answers
 * `[]` for two different situations and THROWS for a third. Flattening those into "no wagers
 * here" is what would let the app tell a member they have nothing on Base when Base was simply
 * unreachable.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  readWagersAcrossEstate,
  wagerEstateChainIds,
  wagersFrom,
  unreadableNetworks,
  isPartial,
  tagWagers,
} from '../../lib/wagers/estateWagers'
import { cohortChainIds } from '../../config/networks'

/*
 * The test build is the TESTNET cohort. Its roster is asserted below rather than assumed, because
 * every chain id here is load-bearing: 63/80002 carry a wager contract, 11155111 (Sepolia) does
 * not — which is the real `not-deployed` case, not a contrived one.
 */
const MORDOR = 63
const AMOY = 80002
const SEPOLIA = 11155111
const wager = (id) => ({ id, contractAddress: '0xfactory' })
const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('readWagersAcrossEstate', () => {
  it('reads every named chain and tags each wager with the chain it came from', async () => {
    const fetchForChain = vi.fn(async (_addr, chainId) => [wager(`w-${chainId}`)])
    const readings = await readWagersAcrossEstate(ADDR, { chainIds: [MORDOR, AMOY], fetchForChain })

    expect(readings.map((r) => r.status)).toEqual(['read', 'read'])
    const all = wagersFrom(readings)
    expect(all.map((m) => [m.id, m.chainId])).toEqual([['w-63', MORDOR], ['w-80002', AMOY]])
    // The chain-qualified id is what stops two chains' wager #1 from colliding in one list.
    expect(new Set(all.map((m) => m.uniqueId)).size).toBe(2)
  })

  /*
   * THE ONE THAT MATTERS. A chain that cannot be reached contributes no wagers — and saying so is
   * the whole point: it is NOT the same as the member having none there, and `unreadableNetworks`
   * is what a surface uses to say which network it could not ask.
   */
  it('isolates a failing chain: the others still answer, and the failure is NAMED', async () => {
    const fetchForChain = vi.fn(async (_addr, chainId) => {
      if (chainId === AMOY) throw new Error('endpoint down')
      return [wager(`w-${chainId}`)]
    })
    const readings = await readWagersAcrossEstate(ADDR, { chainIds: [MORDOR, AMOY, SEPOLIA], fetchForChain })

    expect(readings.find((r) => r.chainId === AMOY).status).toBe('unreadable')
    expect(readings.find((r) => r.chainId === AMOY).reason).toMatch(/endpoint down/)
    // The unreadable chain carries NO value at all — there is nowhere for a `?? 0` to live.
    expect(readings.find((r) => r.chainId === AMOY).value).toBeUndefined()
    // Sepolia is in the cohort and carries no wager contract: a DEFINITE answer, not a failure.
    expect(readings.find((r) => r.chainId === SEPOLIA).status).toBe('not-deployed')
    expect(wagersFrom(readings).map((m) => m.chainId)).toEqual([MORDOR])

    expect(unreadableNetworks(readings)).toEqual(['Polygon Amoy'])
    expect(isPartial(readings)).toBe(true)
  })

  it('a chain that answers with no wagers is a READ, not a failure', async () => {
    const fetchForChain = vi.fn(async () => [])
    const readings = await readWagersAcrossEstate(ADDR, { chainIds: [MORDOR], fetchForChain })
    expect(readings[0].status).toBe('read')
    expect(readings[0].value).toEqual([])
    expect(isPartial(readings)).toBe(false)
  })

  /*
   * A chain with no wager contract is asked NOTHING. The fetcher would have answered `[]` — a
   * claim about the member — where the truth is a fact about the chain.
   */
  it('never asks a chain that carries no wager contract', async () => {
    const fetchForChain = vi.fn(async () => [wager('nope')])
    const readings = await readWagersAcrossEstate(ADDR, { chainIds: [SEPOLIA], fetchForChain })
    expect(readings.map((r) => r.status)).toEqual(['not-deployed'])
    expect(fetchForChain, 'the fetcher would have answered [] — a claim about the member').not.toHaveBeenCalled()
  })

  it('a chain that does not answer in time is unreadable, not an empty list', async () => {
    const fetchForChain = vi.fn(() => new Promise(() => {})) // never settles
    const readings = await readWagersAcrossEstate(ADDR, { chainIds: [MORDOR], fetchForChain, deadlineMs: 20 })
    expect(readings[0].status).toBe('unreadable')
    expect(readings[0].reason).toMatch(/did not answer in time/)
    expect(unreadableNetworks(readings)).toEqual(['Ethereum Classic Mordor'])
  })

  it('never rejects, however many chains fail', async () => {
    const fetchForChain = vi.fn(async () => { throw new Error('all dead') })
    await expect(
      readWagersAcrossEstate(ADDR, { chainIds: [MORDOR, AMOY], fetchForChain }),
    ).resolves.toHaveLength(2)
  })

  it('asks nothing without an address', async () => {
    const fetchForChain = vi.fn()
    const readings = await readWagersAcrossEstate(null, { chainIds: [MORDOR], fetchForChain })
    expect(fetchForChain).not.toHaveBeenCalled()
    expect(readings.every((r) => r.status === 'read')).toBe(true)
  })
})

describe('tagWagers', () => {
  it('survives an empty or missing list', () => {
    expect(tagWagers(null, MORDOR)).toEqual([])
    expect(tagWagers([], MORDOR)).toEqual([])
  })
})

/*
 * THE ROSTER IS NOT THE RAW COHORT (issue #1595 follow-up).
 *
 * `isLocalOnlyChain`'s own docstring states the obligation: a shipped build can never reach
 * `http://127.0.0.1:8545`, so a read routed there is a guaranteed failure, and a caller that
 * would report that failure to a member as a degraded state must exclude the chain first. The
 * wager list is such a caller — without this every shipped testnet build named "Hardhat" as a
 * network it could not read, permanently, about a node that was never the member's.
 *
 * The test build's `VITE_NETWORK_ID` is 63 (vite.config.js), so it is NOT a local build and 1337
 * must be absent. The exception is covered by the assertion below it: the rule is written against
 * `getCurrentChainId()`, so a build pointed at the sandbox keeps it.
 */
describe('wagerEstateChainIds', () => {
  const HARDHAT = 1337

  it('drops the local-only sandbox from a build that is not itself local', () => {
    // The premise, asserted rather than assumed: 1337 IS in this build's cohort, so its absence
    // from the roster is this filter doing work and not an accident of the test cohort.
    expect(cohortChainIds()).toContain(HARDHAT)
    expect(wagerEstateChainIds()).not.toContain(HARDHAT)
  })

  it('keeps every other cohort chain', () => {
    const roster = wagerEstateChainIds()
    for (const id of cohortChainIds()) {
      if (id !== HARDHAT) expect(roster).toContain(id)
    }
  })

  it('is what the read defaults to, so the cache and the read agree', async () => {
    const seen = []
    const fetchForChain = vi.fn(async (_addr, chainId) => { seen.push(chainId); return [] })
    await readWagersAcrossEstate(ADDR, { fetchForChain })
    // Only chains with a wager contract reach the fetcher; none of them may be the sandbox.
    expect(seen).not.toContain(HARDHAT)
    expect(seen.length).toBeGreaterThan(0)
  })
})
