import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getAddress, isAddress } from 'ethers'
import { createPublicClient, custom } from 'viem'

// A plain hoisted object rather than a vi.fn: a mock whose implementation THROWS is reported by
// vitest as the test's own failure even when the code under test catches it, and the catching is
// exactly what one of these tests proves.
const world = vi.hoisted(() => ({ guards: {}, throwFor: null }))
vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: (name, chainId) => {
    if (world.throwFor === chainId) throw new Error('boom')
    return name === 'sanctionsGuard' ? world.guards[chainId] : undefined
  },
  // sources.js imports this for the roster filter; the mock replaces the whole module, so it has
  // to carry every export the module under test reaches for.
  isLocalOnlyChain: (id) => Number(id) === 1337,
}))

import {
  screeningSourcesFor,
  SOURCE_KINDS,
  CHAINALYSIS_ORACLES,
  ISSUER_FREEZE_LISTS,
} from '../../lib/screening/sources'

const ACCOUNT = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96'
const GUARD = '0x2Dc53d91A189be71DfE96Ea9BCFCF6aDDA77BC76'

// Since spec 110 the reads go through the chain seam, so the world is installed there rather
// than handed in as a provider. It is still answered at the SELECTOR — the encoding stays real,
// which is the whole point of this harness: `isBlacklisted` and `isBlackListed` differ by one
// letter and hash to different selectors, and only a real encode catches a source asking for
// the wrong one.
const seam = vi.hoisted(() => ({ client: null }))
vi.mock('../../lib/chains/publicClient', async (orig) => ({
  ...(await orig()),
  getPublicClient: () => seam.client,
}))

/** A read client that answers `eth_call` by selector, like the no-chain e2e world does. */
function providerAnswering(bySelector) {
  seam.client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method !== 'eth_call') throw new Error(`unexpected method ${method}`)
        const sel = String(params[0].data).slice(0, 10)
        if (!(sel in bySelector)) throw new Error(`no answer for ${sel}`)
        const v = bySelector[sel]
        if (v instanceof Error) throw v
        return `0x${'0'.repeat(63)}${v ? '1' : '0'}`
      },
    }),
  })
  // Returned so each call site reads unchanged: it is the availability gate the source takes.
  return seam.client
}
const SEL = {
  isAllowed: '0xbabcc539',
  isDenied: '0xe838dfbb',
  isSanctioned: '0xdf592f7d',
  isBlacklisted: '0xfe575a87',
  isBlackListed: '0xe47d6060',
}

describe('the source tables are provenance, not guesses', () => {
  it('every oracle and issuer address is a checksummed EVM address', () => {
    for (const a of Object.values(CHAINALYSIS_ORACLES)) {
      expect(isAddress(a)).toBe(true)
      expect(getAddress(a)).toBe(a)
    }
    for (const list of Object.values(ISSUER_FREEZE_LISTS)) {
      for (const t of list) {
        expect(isAddress(t.address)).toBe(true)
        expect(getAddress(t.address)).toBe(t.address)
        expect(['isBlacklisted', 'isBlackListed']).toContain(t.fn)
        expect(t.issuer).toBeTruthy()
      }
    }
  })

  it('names the Base oracle at its own address, distinct from the shared one', () => {
    expect(CHAINALYSIS_ORACLES[8453]).not.toBe(CHAINALYSIS_ORACLES[1])
    expect(CHAINALYSIS_ORACLES[1]).toBe(CHAINALYSIS_ORACLES[137])
  })

  it('lists no oracle and no issuer on Ethereum Classic or Mordor', () => {
    expect(CHAINALYSIS_ORACLES[61]).toBeUndefined()
    expect(CHAINALYSIS_ORACLES[63]).toBeUndefined()
    expect(ISSUER_FREEZE_LISTS[61]).toBeUndefined()
    expect(ISSUER_FREEZE_LISTS[63]).toBeUndefined()
  })
})

describe('screeningSourcesFor', () => {
  beforeEach(() => {
    world.guards = {}
    world.throwFor = null
  })

  it('returns nothing for a non-EVM or nonsense id — never a guessed source', () => {
    expect(screeningSourcesFor('bitcoin')).toEqual([])
    expect(screeningSourcesFor(null)).toEqual([])
    expect(screeningSourcesFor(-5)).toEqual([])
  })

  it('returns nothing for a chain with no guard, no oracle and no issuer (Mordor)', () => {
    expect(screeningSourcesFor(63)).toEqual([])
  })

  it('includes the FairWins guard only where the contracts config says it is deployed', () => {
    expect(screeningSourcesFor(137).map((s) => s.kind)).not.toContain(SOURCE_KINDS.GUARD)
    world.guards[137] = GUARD
    const kinds = screeningSourcesFor(137).map((s) => s.kind)
    expect(kinds).toEqual([SOURCE_KINDS.GUARD, SOURCE_KINDS.ORACLE, SOURCE_KINDS.ISSUER])
  })

  it('lists both issuer lists on Ethereum, with stable ids', () => {
    const ids = screeningSourcesFor(1).map((s) => s.id)
    expect(ids).toEqual(['chainalysis-oracle:1', 'issuer-freeze:1:USDC', 'issuer-freeze:1:USDT'])
  })

  it('a source that throws on an unknown chain lookup is dropped, not fabricated', () => {
    world.throwFor = 8453
    expect(screeningSourcesFor(8453).map((s) => s.kind)).toEqual([SOURCE_KINDS.ORACLE, SOURCE_KINDS.ISSUER])
  })
})

describe('source reads — one selector, one fact', () => {
  beforeEach(() => {
    world.guards = { 137: GUARD }
    world.throwFor = null
  })

  it('guard: isAllowed=false is flagged, and isDenied only explains it', async () => {
    const guard = screeningSourcesFor(137).find((s) => s.kind === SOURCE_KINDS.GUARD)
    const denied = await guard.read(providerAnswering({ [SEL.isAllowed]: false, [SEL.isDenied]: true }), ACCOUNT)
    expect(denied.flagged).toBe(true)
    expect(denied.detail).toMatch(/deny list/)

    const refused = await guard.read(providerAnswering({ [SEL.isAllowed]: false, [SEL.isDenied]: false }), ACCOUNT)
    expect(refused.flagged).toBe(true)
    expect(refused.detail).toMatch(/refused by the FairWins guard/)
  })

  it('guard: still screens when only isAllowed is answered (the no-chain e2e world)', async () => {
    const guard = screeningSourcesFor(137).find((s) => s.kind === SOURCE_KINDS.GUARD)
    const r = await guard.read(providerAnswering({ [SEL.isAllowed]: false }), ACCOUNT)
    expect(r.flagged).toBe(true)
    const ok = await guard.read(providerAnswering({ [SEL.isAllowed]: true }), ACCOUNT)
    expect(ok).toEqual({ flagged: false, detail: null })
  })

  it('oracle: isSanctioned=true is flagged and names the list', async () => {
    const oracle = screeningSourcesFor(1).find((s) => s.kind === SOURCE_KINDS.ORACLE)
    const r = await oracle.read(providerAnswering({ [SEL.isSanctioned]: true }), ACCOUNT)
    expect(r.flagged).toBe(true)
    expect(r.detail).toMatch(/OFAC/)
    expect(await oracle.read(providerAnswering({ [SEL.isSanctioned]: false }), ACCOUNT)).toEqual({ flagged: false, detail: null })
  })

  it('issuer: uses the exact selector each issuer spells, and says whose freeze it is', async () => {
    const [usdc, usdt] = screeningSourcesFor(1).filter((s) => s.kind === SOURCE_KINDS.ISSUER)
    const frozen = await usdc.read(providerAnswering({ [SEL.isBlacklisted]: true }), ACCOUNT)
    expect(frozen.flagged).toBe(true)
    expect(frozen.detail).toMatch(/frozen by Circle/)
    // Tether's selector differs — answering Circle's does NOT satisfy it.
    await expect(usdt.read(providerAnswering({ [SEL.isBlacklisted]: true }), ACCOUNT)).rejects.toThrow()
    const t = await usdt.read(providerAnswering({ [SEL.isBlackListed]: false }), ACCOUNT)
    expect(t.flagged).toBe(false)
  })

  it('a read that reverts REJECTS — the caller turns that into unreadable, never into clear', async () => {
    const oracle = screeningSourcesFor(1).find((s) => s.kind === SOURCE_KINDS.ORACLE)
    await expect(oracle.read(providerAnswering({}), ACCOUNT)).rejects.toThrow()
  })
})
