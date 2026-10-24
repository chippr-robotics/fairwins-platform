// Spec 068 US1 (T012) — the vault list is the member's whole custody estate, across chains.
// Covers: no connected-chain filter (FR-003), per-vault chain identity (FR-002), per-vault failure
// isolation, and the `onVaultChain` flag every action gates on (FR-004).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const VAULT_MORDOR = '0x1111111111111111111111111111111111111111'
const VAULT_POLYGON = '0x2222222222222222222222222222222222222222'
const VAULT_UNKNOWN_CHAIN = '0x3333333333333333333333333333333333333333'
const ME = '0x9999999999999999999999999999999999999999'

let walletCtx = { address: ME, chainId: 137, provider: { tag: 'wallet' }, signer: null, loginMethod: 'eoa' }
let references = []
const loadVault = vi.fn()
const getProvider = vi.fn((chainId) => ({ tag: `rpc-${chainId}` }))

vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))
vi.mock('../../lib/custody/vaultReferences', () => ({
  loadVaultReferences: () => references,
  upsertVaultReference: vi.fn(),
  removeVaultReference: vi.fn(),
}))
vi.mock('../../lib/custody/safeVault', () => ({
  loadVault: (...args) => loadVault(...args),
  createVault: vi.fn(),
  buildCreateVaultTx: vi.fn(),
  isVaultOwner: (state, account) => (state.owners || []).some((o) => o.toLowerCase() === account.toLowerCase()),
}))
vi.mock('../../utils/blockchainService', () => ({ getProvider: (...args) => getProvider(...args) }))
vi.mock('../../lib/custody/policy', () => ({ readPolicy: vi.fn(), summarizeRules: vi.fn() }))
vi.mock('../../lib/custody/policyV2', () => ({
  getPolicyStatus: vi.fn(async () => 'none'),
  readPolicyV2: vi.fn(),
}))

import { useCustodyVaults } from '../../hooks/useCustodyVaults'

const safeState = (address) => ({ isSafe: true, address, owners: [ME], threshold: 1, version: '1.4.1' })

beforeEach(() => {
  vi.clearAllMocks()
  walletCtx = { address: ME, chainId: 137, provider: { tag: 'wallet' }, signer: null, loginMethod: 'eoa' }
  references = [
    { chainId: 63, address: VAULT_MORDOR, label: 'Team treasury', role: 'owner' },
    { chainId: 137, address: VAULT_POLYGON, label: 'Family savings', role: 'owner' },
  ]
  loadVault.mockImplementation(async (address) => safeState(address))
})

describe('useCustodyVaults — multi-chain', () => {
  it('lists vaults from every chain while connected to one of them (FR-003)', async () => {
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.vaults).toHaveLength(2))
    expect(result.current.vaults.map((v) => v.address)).toEqual([VAULT_MORDOR, VAULT_POLYGON])
  })

  it('still lists saved vaults when the connected chain has no custody at all (FR-005)', async () => {
    walletCtx = { ...walletCtx, chainId: 1 }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.vaults).toHaveLength(2))
    expect(result.current.vaults.every((v) => v.onVaultChain === false)).toBe(true)
  })

  it('labels each vault with its own chain and flags which one the wallet is on (FR-002/FR-004)', async () => {
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.vaults).toHaveLength(2))
    const [mordor, polygon] = result.current.vaults

    expect(mordor.chainName).toMatch(/mordor/i)
    expect(mordor.isTestnet).toBe(true)
    expect(mordor.onVaultChain).toBe(false)

    expect(polygon.chainName).toBe('Polygon')
    expect(polygon.isTestnet).toBe(false)
    expect(polygon.onVaultChain).toBe(true)
  })

  it('reads each vault through a provider for ITS chain, not the connected one', async () => {
    renderHook(() => useCustodyVaults())
    await waitFor(() => expect(loadVault).toHaveBeenCalledTimes(2))
    // Off-chain vault: a read provider for chain 63. On-chain vault: the wallet provider.
    expect(loadVault).toHaveBeenCalledWith(VAULT_MORDOR, 63, { tag: 'rpc-63' })
    expect(loadVault).toHaveBeenCalledWith(VAULT_POLYGON, 137, { tag: 'wallet' })
    expect(getProvider).toHaveBeenCalledWith(63)
  })

  it('isolates a failing chain to its own row and keeps the rest of the list', async () => {
    loadVault.mockImplementation(async (address, chainId) => {
      if (chainId === 63) throw new Error('RPC unreachable')
      return safeState(address)
    })
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.vaults).toHaveLength(2))

    const [mordor, polygon] = result.current.vaults
    expect(mordor.reachable).toBe(false)
    expect(mordor.loadError).toMatch(/unreachable/i)
    expect(mordor.chainName).toMatch(/mordor/i) // identity survives an unreadable chain
    expect(polygon.reachable).toBe(true)
    expect(polygon.isSafe).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('labels an unrecognized chain honestly instead of guessing a default network', async () => {
    references = [{ chainId: 424242, address: VAULT_UNKNOWN_CHAIN, label: 'Mystery', role: 'watch' }]
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.vaults).toHaveLength(1))
    expect(result.current.vaults[0].chainName).toBe('Chain 424242')
    expect(result.current.vaults[0].chainKnown).toBe(false)
  })

  it('exposes one GROUP per address over the per-chain instances, pinned to the wallet chain (spec 102)', async () => {
    references = [
      { chainId: 63, address: VAULT_MORDOR, label: 'Team treasury', role: 'owner' },
      { chainId: 137, address: VAULT_MORDOR, label: 'Team treasury', role: 'owner' },
      { chainId: 137, address: VAULT_POLYGON, label: 'Family savings', role: 'owner' },
    ]
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.vaults).toHaveLength(3))
    expect(result.current.groups).toHaveLength(2)
    const [treasury, savings] = result.current.groups
    expect(treasury.chainIds).toEqual([63, 137])
    expect(treasury.networkLine).toBe('2 networks')
    expect(treasury.pinnedChainId).toBe(137)
    expect(treasury.threshold).toEqual({ value: 1, of: 1 })
    expect(savings.networkLine).toBe('Polygon')
  })

  it('activeVault is the selected address\'s instance on the connected chain, else its pinned one', async () => {
    references = [
      { chainId: 63, address: VAULT_MORDOR, label: 'Team treasury', role: 'owner' },
      { chainId: 137, address: VAULT_MORDOR, label: 'Team treasury', role: 'owner' },
    ]
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.vaults).toHaveLength(2))
    act(() => result.current.selectVault(VAULT_MORDOR))
    expect(result.current.activeVault.chainId).toBe(137) // wallet is on Polygon

    walletCtx = { ...walletCtx, chainId: 1 } // a chain the vault is NOT on → first instance
    const off = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(off.result.current.vaults).toHaveLength(2))
    act(() => off.result.current.selectVault(VAULT_MORDOR))
    expect(off.result.current.activeVault.chainId).toBe(63)
  })

  it('clears the list when no account is connected', async () => {
    walletCtx = { ...walletCtx, address: null }
    const { result } = renderHook(() => useCustodyVaults())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.vaults).toEqual([])
  })
})
