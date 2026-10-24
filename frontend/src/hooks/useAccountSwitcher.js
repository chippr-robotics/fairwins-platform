// Spec 062/063/085/088 — shared "acting account" switcher logic: the list of accounts a member
// can act as (personal wallet + multisig vaults + recovered legacy accounts + saved hardware
// accounts), which one is current, and how to switch.
//
// Spec 088: switching is ADDRESS-ONLY and INSTANT for every kind — no unlock dialog, no device
// ceremony, no passphrase. The public address is enough to view, receive, and navigate as the
// account. The signing ceremony is deferred to the moment a transaction actually needs a
// signature (CustodyContext's broker + the global SignerRequestHost).
// Used by the wallet header's biticon caret dropdown so the identity IS the switcher.
//
// Spec 102 (FR-016) — ONE entry per vault ADDRESS. A Safe on six networks was six entries with the
// same label; it is now one, carrying `chainIds` (every instance) and `chainId` (the pinned one),
// and choosing it hands the whole set to `operateAsVault` so the acting chain can follow the wallet.

import { useCallback, useMemo } from 'react'
import { useWallet } from './useWalletManagement'
import { useActiveAccount } from './useActiveAccount'
import { useCustodyVaults } from './useCustodyVaults'
import { useLegacyAccounts } from './useLegacyAccounts'
import { useHardwareAccounts } from './useHardwareAccounts'

export const ACCOUNT_KIND_TAG = { vault: 'Multisig', legacy: 'Recovered', hardware: 'Hardware' }
export const shortAccountAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

const vaultId = (address) => `vault:${String(address || '').toLowerCase()}`

export function useAccountSwitcher() {
  const { address } = useWallet()
  const { identity, operateAsPersonal, operateAsVault, operateAsLegacy, operateAsHardware } = useActiveAccount()
  const { groups } = useCustodyVaults()
  const legacyAccounts = useLegacyAccounts()
  const hardwareAccounts = useHardwareAccounts()

  const accounts = useMemo(() => {
    const list = [{ id: 'personal', kind: 'personal', address, label: 'Personal wallet' }]
    for (const g of groups || []) {
      if (g?.address) {
        list.push({
          id: vaultId(g.address),
          kind: 'vault',
          address: g.address,
          chainId: g.pinnedChainId,
          chainIds: g.chainIds,
          label: g.label || shortAccountAddr(g.address),
        })
      }
    }
    return list.concat(legacyAccounts, hardwareAccounts)
  }, [address, groups, legacyAccounts, hardwareAccounts])

  const currentId = useMemo(() => {
    if (identity.mode === 'vault') return vaultId(identity.vaultAddress)
    if (identity.mode === 'legacy') return `legacy:${String(identity.address).toLowerCase()}`
    if (identity.mode === 'hardware') return `hardware:${String(identity.address).toLowerCase()}`
    return 'personal'
  }, [identity])

  // Switch to an account — takes effect immediately for every kind (spec 088).
  const choose = useCallback(
    (acc) => {
      if (acc.kind === 'personal') return operateAsPersonal()
      if (acc.kind === 'vault') {
        return operateAsVault({ address: acc.address, chainIds: acc.chainIds, chainId: acc.chainId, label: acc.label })
      }
      if (acc.kind === 'legacy') return operateAsLegacy({ address: acc.address, kind: acc.entry?.kind, label: acc.label })
      if (acc.kind === 'hardware') return operateAsHardware({ address: acc.address, vendor: acc.vendor, label: acc.label })
      return undefined
    },
    [operateAsPersonal, operateAsVault, operateAsLegacy, operateAsHardware],
  )

  return {
    accounts,
    currentId,
    choose,
    // Only worth surfacing the caret when there's more than the personal wallet to choose from.
    hasChoices: accounts.length > 1,
  }
}

export default useAccountSwitcher
