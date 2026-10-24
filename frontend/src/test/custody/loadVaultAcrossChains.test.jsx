// Spec 068 — loading a vault by address searches EVERY custody network.
//
// Motivated by a real failure: a live 2-of-3 Safe on Mordor
// (0x06612FfFf31eB0d56A1C694eb5F878ad6d850c16) could not be loaded from the app while connected to
// another network, because load only ever looked at the connected chain. A member holding a vault
// address should not have to already know — or guess by hopping networks — which chain it is on.
//
// The other half of this is honesty about failure: a chain we could not reach must be reported as
// unchecked, never folded into "no vault found", or one dead RPC tells a member their vault is gone.
//
// Spec 102 (US2/FR-003) — EVERY match is stored, not one "picked" chain: a Safe on Mordor and
// Polygon becomes one vault with two instances. `picked` survives only as the instance the caller
// confirms against; `added` lists every chain stored; `probeVault` adds new networks to a held vault
// and `forgetVault` removes it from all of them.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const VAULT = '0x06612FfFf31eB0d56A1C694eb5F878ad6d850c16'
const ME = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'
const OTHER1 = '0x740e1CA9906A64a7c536575def196d2858DAA9E6'
const OTHER2 = '0x1aF8c2453C3166e3A71E4F18179F40bd73EF9aE4'

let walletCtx = { address: ME, chainId: 137, provider: { tag: 'wallet' }, signer: {}, loginMethod: 'eoa' }
let references = []
const upsert = vi.fn()
// chainId -> state | Error
let chainState = {}

vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))
const removeRef = vi.fn()
vi.mock('../../lib/custody/vaultReferences', () => ({
  loadVaultReferences: () => references,
  upsertVaultReference: (...a) => upsert(...a),
  removeVaultReference: (...a) => removeRef(...a),
}))
vi.mock('../../utils/blockchainService', () => ({ getProvider: (id) => ({ tag: `rpc-${id}` }) }))
vi.mock('../../lib/custody/policy', () => ({ readPolicy: vi.fn(), summarizeRules: vi.fn() }))
vi.mock('../../lib/custody/policyV2', () => ({
  getPolicyStatus: vi.fn(async () => 'none'),
  readPolicyV2: vi.fn(),
}))
// Fake chain reader: the REAL findVaultAcrossChains runs over it (via its injectable `load` seam),
// so the fan-out, match selection and unreachable/absent distinction are the code under test —
// only the RPC layer is faked.
const fakeLoad = async (address, chainId) => {
  const entry = chainState[Number(chainId)]
  if (entry instanceof Error) throw entry
  if (!entry) return { address, chainId: Number(chainId), isSafe: false, reason: 'no-contract' }
  return { address, chainId: Number(chainId), isSafe: true, ...entry }
}

vi.mock('../../lib/custody/safeVault', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createVault: vi.fn(),
    buildCreateVaultTx: vi.fn(),
    loadVault: (...a) => fakeLoad(...a),
    findVaultAcrossChains: (addr, ids, opts) => actual.findVaultAcrossChains(addr, ids, { ...opts, load: fakeLoad }),
  }
})

import { useCustodyVaults } from '../../hooks/useCustodyVaults'

const safeOnMordor = { owners: [ME, OTHER1, OTHER2], threshold: 2, nonce: 0, version: '1.3.0' }

beforeEach(() => {
  vi.clearAllMocks()
  references = []
  chainState = {}
  walletCtx = { address: ME, chainId: 137, provider: { tag: 'wallet' }, signer: {}, loginMethod: 'eoa' }
})

describe('loadByAddress — cross-chain search', () => {
  it('finds a vault on a network other than the connected one', async () => {
    chainState = { 63: safeOnMordor } // live on Mordor; wallet is on Polygon
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(VAULT, 'Admin Safe')
    })

    expect(loaded.chainId).toBe(63)
    expect(loaded.threshold).toBe(2)
    expect(loaded.owners).toHaveLength(3)
    expect(loaded.owner).toBe(true) // the connected account is one of the three owners
    // The saved reference must record the vault's OWN chain, not the connected one.
    expect(upsert).toHaveBeenCalledWith(ME, expect.objectContaining({ chainId: 63, role: 'owner' }), expect.anything())
  })

  it('accepts a Safe older than v1.4.1 (the live admin vault is v1.3.0)', async () => {
    chainState = { 63: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(VAULT)
    })
    expect(loaded.version).toBe('1.3.0')
    expect(loaded.isSafe).toBe(true)
  })

  it('marks a non-owner as view-only', async () => {
    chainState = { 63: { ...safeOnMordor, owners: [OTHER1, OTHER2] } }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(VAULT)
    })
    expect(loaded.owner).toBe(false)
    expect(upsert).toHaveBeenCalledWith(ME, expect.objectContaining({ role: 'watch' }), expect.anything())
  })

  it('accepts an EIP-3770-prefixed paste ("ETCM:0x…") and searches with the bare address', async () => {
    chainState = { 63: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(`ETCM:${VAULT}`, 'Admin Safe')
    })
    expect(loaded.isSafe).toBe(true)
    expect(loaded.chainId).toBe(63)
    expect(upsert).toHaveBeenCalledWith(ME, expect.objectContaining({ chainId: 63 }), expect.anything())
  })

  it('uses a recognized prefix as the chain hint, outranking the connected chain', async () => {
    // Same address is a Safe on Mordor AND Polygon; wallet is on Polygon. A member who pasted
    // "ETCM:…" said which one they meant — the connected-chain preference must not override it.
    chainState = { 63: safeOnMordor, 137: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(`ETCM:${VAULT}`)
    })
    expect(loaded.chainId).toBe(63)
  })

  it('strips an unrecognized prefix and still searches everywhere', async () => {
    chainState = { 63: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(`weirdchain:${VAULT}`)
    })
    expect(loaded.chainId).toBe(63)
  })

  it('an explicit member choice still outranks the pasted prefix', async () => {
    chainState = { 63: safeOnMordor, 137: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(`ETCM:${VAULT}`, '', 0, { preferredChainId: 137 })
    })
    expect(loaded.chainId).toBe(137)
  })

  it('adds EVERY network the address is a Safe on, confirming against the connected chain (spec 102)', async () => {
    chainState = { 63: safeOnMordor, 137: { ...safeOnMordor, owners: [OTHER1, OTHER2] } }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(VAULT, 'Admin Safe')
    })
    expect(loaded.chainId).toBe(137) // the instance to confirm against: wallet is on Polygon
    expect(loaded.matches).toHaveLength(2)
    expect([...loaded.added].sort((a, b) => a - b)).toEqual([63, 137])
    // BOTH references stored, role computed PER INSTANCE (owner on Mordor, view-only on Polygon).
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenCalledWith(ME, expect.objectContaining({ chainId: 63, role: 'owner', label: 'Admin Safe' }), expect.anything())
    expect(upsert).toHaveBeenCalledWith(ME, expect.objectContaining({ chainId: 137, role: 'watch', label: 'Admin Safe' }), expect.anything())
    expect(loaded.owner).toBe(false) // the picked (Polygon) instance's role
  })

  it('a single-network vault stores exactly one reference (byte-identical to before)', async () => {
    chainState = { 63: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(VAULT)
    })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(loaded.added).toEqual([63])
  })

  it('honours an explicit chain choice over the connected one', async () => {
    chainState = { 63: safeOnMordor, 137: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(VAULT, '', 0, { preferredChainId: 63 })
    })
    expect(loaded.chainId).toBe(63)
  })

  it('reports not-found only for networks it could actually reach', async () => {
    chainState = { 63: new Error('RPC down') } // unreachable, and nothing anywhere else
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(
      act(async () => {
        await result.current.loadByAddress(VAULT)
      }),
    ).rejects.toThrow(/could not be reached/i)
  })

  it('says plainly when the address is a Safe on no reachable network', async () => {
    chainState = {} // every chain reachable, none holds a Safe
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(
      act(async () => {
        await result.current.loadByAddress(VAULT)
      }),
    ).rejects.toThrow(/no Safe vault found at this address on any supported network/i)
  })

  it('still loads from a reachable chain when another chain is down', async () => {
    chainState = { 63: safeOnMordor, 137: new Error('RPC down') }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let loaded
    await act(async () => {
      loaded = await result.current.loadByAddress(VAULT)
    })
    expect(loaded.chainId).toBe(63)
    expect(loaded.added).toEqual([63])
    expect(loaded.unreachable.map((u) => u.chainId)).toContain(137)
    expect(upsert).not.toHaveBeenCalledWith(ME, expect.objectContaining({ chainId: 137 }), expect.anything())
  })
})

describe('probeVault — "Check again" for a vault already held (spec 102 US2.4)', () => {
  it('adds ONLY the networks that are new and leaves held references untouched', async () => {
    references = [{ chainId: 63, address: VAULT, label: 'Admin Safe', role: 'owner', addedAt: 1 }]
    chainState = { 63: safeOnMordor, 137: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let out
    await act(async () => {
      out = await result.current.probeVault(VAULT)
    })
    expect(out.added).toEqual([137])
    expect(out.unreachable).toEqual([])
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledWith(ME, expect.objectContaining({ chainId: 137, role: 'owner' }), expect.anything())
  })

  it('reports still-unreachable networks and adds nothing when nothing is new', async () => {
    references = [{ chainId: 63, address: VAULT, label: '', role: 'owner', addedAt: 1 }]
    chainState = { 63: safeOnMordor, 137: new Error('RPC down') }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let out
    await act(async () => {
      out = await result.current.probeVault(VAULT)
    })
    expect(out.added).toEqual([])
    expect(out.unreachable.map((u) => u.chainId)).toEqual([137])
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('forgetVault — removes the vault from EVERY network (spec 102 FR-015)', () => {
  it('removes each (chainId, address) reference for the address, case-insensitively', async () => {
    references = [
      { chainId: 63, address: VAULT, label: '', role: 'owner', addedAt: 1 },
      { chainId: 137, address: VAULT.toLowerCase(), label: '', role: 'watch', addedAt: 1 },
      { chainId: 137, address: OTHER1, label: 'Other', role: 'watch', addedAt: 1 },
    ]
    chainState = { 63: safeOnMordor, 137: safeOnMordor }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.forgetVault(VAULT)
    })
    expect(removeRef).toHaveBeenCalledTimes(2)
    expect(removeRef).toHaveBeenCalledWith(ME, 63, VAULT)
    expect(removeRef).toHaveBeenCalledWith(ME, 137, VAULT.toLowerCase())
    expect(removeRef).not.toHaveBeenCalledWith(ME, 137, OTHER1)
  })
})
