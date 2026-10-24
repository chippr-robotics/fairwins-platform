// Spec 102 (T006, FR-016) — the account switcher lists ONE entry per vault ADDRESS. A Safe on three
// networks was three identical entries; it is now one carrying every chain, pinned to the wallet's
// chain where the vault is on it, and choosing it hands the whole set to `operateAsVault`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { groupVaults } from '../../lib/custody/vaultGroups'

const TREASURY = '0x1111111111111111111111111111111111111111'
const SAVINGS = '0x2222222222222222222222222222222222222222'
const ME = '0x9999999999999999999999999999999999999999'

let walletChainId = 8453
let vaults = []
let identity = { mode: 'personal' }
const operateAsVault = vi.fn()
const operateAsPersonal = vi.fn()

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => ({ address: ME, chainId: walletChainId }) }))
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ identity, operateAsPersonal, operateAsVault, operateAsLegacy: vi.fn(), operateAsHardware: vi.fn() }),
}))
vi.mock('../../hooks/useCustodyVaults', () => ({
  useCustodyVaults: () => ({ vaults, groups: groupVaults(vaults, { walletChainId }) }),
}))
vi.mock('../../hooks/useLegacyAccounts', () => ({ useLegacyAccounts: () => [] }))
vi.mock('../../hooks/useHardwareAccounts', () => ({ useHardwareAccounts: () => [] }))

import { useAccountSwitcher } from '../../hooks/useAccountSwitcher'

const inst = (address, chainId, label = '') => ({ address, chainId, label, isSafe: true, reachable: true, owners: [ME], threshold: 1, owner: true })

beforeEach(() => {
  vi.clearAllMocks()
  walletChainId = 8453
  identity = { mode: 'personal' }
  vaults = [inst(TREASURY, 137, 'Treasury'), inst(SAVINGS, 63, 'Savings'), inst(TREASURY.toLowerCase(), 8453), inst(TREASURY, 10)]
})

describe('useAccountSwitcher — one entry per vault address (spec 102)', () => {
  it('lists each vault once with every chain and the pinned chain', () => {
    const { result } = renderHook(() => useAccountSwitcher())
    const vaultEntries = result.current.accounts.filter((a) => a.kind === 'vault')
    expect(vaultEntries).toHaveLength(2)
    expect(vaultEntries[0]).toMatchObject({
      id: `vault:${TREASURY.toLowerCase()}`,
      address: TREASURY,
      label: 'Treasury',
      chainIds: [137, 8453, 10],
      chainId: 8453, // the wallet is on Base and the vault is there
    })
    expect(vaultEntries[1]).toMatchObject({ address: SAVINGS, chainIds: [63], chainId: 63, label: 'Savings' })
    expect(result.current.hasChoices).toBe(true)
  })

  it('passes the whole chain set to operateAsVault when chosen', () => {
    const { result } = renderHook(() => useAccountSwitcher())
    const treasury = result.current.accounts.find((a) => a.address === TREASURY)
    act(() => result.current.choose(treasury))
    expect(operateAsVault).toHaveBeenCalledWith({ address: TREASURY, chainIds: [137, 8453, 10], chainId: 8453, label: 'Treasury' })
  })

  it('marks the acting vault current regardless of address case', () => {
    identity = { mode: 'vault', vaultAddress: TREASURY.toUpperCase().replace('0X', '0x'), chainIds: [137], chainId: 137 }
    const { result } = renderHook(() => useAccountSwitcher())
    const treasury = result.current.accounts.find((a) => a.address === TREASURY)
    expect(result.current.currentId).toBe(treasury.id)
  })

  it('falls back to the short address as the label when no instance has one', () => {
    vaults = [inst(SAVINGS, 63), inst(SAVINGS, 137)]
    const { result } = renderHook(() => useAccountSwitcher())
    const entry = result.current.accounts.find((a) => a.kind === 'vault')
    expect(entry.label).toBe('0x2222…2222')
  })
})
