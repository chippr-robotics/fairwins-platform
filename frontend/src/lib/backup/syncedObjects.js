// Spec 032 — the registry of user-authored objects included in a backup. Each declares how to load/apply it,
// whether it is network-scoped (its elements carry chainId), and how it merges. Adding a future object
// (tokens, DAOs) = one entry here with networkScoped set truthfully — no backup/restore redesign (FR-016).

import { loadAddressBook, saveAddressBook, mergeBook } from '../addressBook/addressBookStore'
import { getUserPreference, saveUserPreference } from '../../utils/userStorage'
import {
  loadVaultReferences,
  saveVaultReferences,
  mergeVaultReferences,
} from '../custody/vaultReferences'
import {
  listClientRecordsAllChains,
  mergeClientRecordsAllChains,
} from '../../data/ledger/ledgerClientStore'
import { readVaultEnvelope, writeVaultEnvelope, hasVault } from '../openChallenge/codeVault'
import {
  loadCreationRecords,
  applyCreationRecords,
  mergeCreationRecords,
} from '../custody/vaultCreationRecords'
import {
  loadLegacyRecoveredKeys,
  saveLegacyRecoveredKeys,
  mergeLegacyRecoveredKeys,
} from '../recovery/legacyRecoveredKeysStore'
import {
  loadMiniAppState,
  applyMiniAppState,
  mergeMiniAppState,
} from '../miniapps/store'
import {
  loadHardwareAccounts,
  saveHardwareAccounts,
  mergeHardwareAccounts,
} from '../hardware/hardwareAccountsStore'

const PREF_KEYS = {
  recentSearches: 'recent_searches',
  favoriteMarkets: 'favorite_markets',
  defaultSlippage: 'default_slippage',
  polymarketCategories: 'polymarket_categories',
}
const PREF_DEFAULTS = { recentSearches: [], favoriteMarkets: [], defaultSlippage: 0.5, polymarketCategories: [] }

/** Ordered list of synced objects. */
export const syncedObjects = [
  {
    key: 'addressBook',
    label: 'Address book',
    networkScoped: true, // every SavedAddress carries chainId; identity is (address, chainId)
    load: (account) => loadAddressBook(account),
    // mode: 'replace' overwrites; 'merge' is additive by (address, chainId) and returns notes/nickname conflicts.
    apply: (account, value, mode) => {
      if (mode === 'replace') {
        saveAddressBook(account, value)
        return { conflicts: [] }
      }
      const { book, conflicts } = mergeBook(loadAddressBook(account), value)
      saveAddressBook(account, book)
      return { conflicts }
    },
    merge: (current, incoming) => mergeBook(current, incoming),
  },
  {
    key: 'preferences',
    label: 'Preferences',
    networkScoped: false, // global, no chainId
    load: (account) => {
      const out = {}
      for (const [field, storageKey] of Object.entries(PREF_KEYS)) {
        out[field] = getUserPreference(account, storageKey, PREF_DEFAULTS[field], true)
      }
      return out
    },
    // preferences are scalars/lists → last-writer-wins (the incoming value replaces) for both modes.
    apply: (account, value, _mode) => {
      for (const [field, storageKey] of Object.entries(PREF_KEYS)) {
        if (value && value[field] !== undefined) saveUserPreference(account, storageKey, value[field], true)
      }
      return { conflicts: [] }
    },
    merge: (_current, incoming) => ({ value: incoming, conflicts: [] }),
  },
  {
    // Spec 043 — custody vault references + labels. Network-scoped: identity is (chainId, address).
    key: 'vaultReferences',
    label: 'Vault references',
    networkScoped: true,
    load: (account) => loadVaultReferences(account),
    apply: (account, value, mode) => {
      if (mode === 'replace') {
        saveVaultReferences(account, value)
        return { conflicts: [] }
      }
      const { value: merged, conflicts } = mergeVaultReferences(loadVaultReferences(account), value)
      saveVaultReferences(account, merged)
      return { conflicts }
    },
    merge: (current, incoming) => mergeVaultReferences(current, incoming),
  },
  {
    // Spec 105 — per-vault CREATION records (owners at creation, threshold, saltNonce, the one
    // semantic rules config): the chain-independent facts that let "Add a network" land the SAME
    // address later. NON-network-scoped by design — the record is precisely what no single chain
    // holds. Records are immutable; merge is union-by-address with existing-entry-wins, and a
    // conflicting incoming record is reported, never silently adopted. Public parameters only.
    key: 'vaultCreationRecords',
    label: 'Vault creation records',
    networkScoped: false,
    load: (account) => loadCreationRecords(account),
    apply: (account, value, mode) => applyCreationRecords(account, value, mode),
    merge: (current, incoming) => mergeCreationRecords(current, incoming),
  },
  {
    // Spec 051 — client-only activity ledger records (failed gasless ops,
    // transfer history, earn action captures): the part of the audit trail
    // that cannot be re-derived from public chain data (FR-010). On-chain
    // entries are deliberately NOT in the bundle — they re-derive (FR-009).
    key: 'activityLedger',
    label: 'Activity history',
    networkScoped: true, // every record carries chainId
    load: (account) => listClientRecordsAllChains(account),
    // Records are append-only value objects, so BOTH modes union by entryId:
    // a "replace" that deleted history would violate the append-only audit
    // guarantee (FR-008). Identical ids are identical records — conflict-free.
    apply: (account, value, _mode) => {
      mergeClientRecordsAllChains(account, value)
      return { conflicts: [] }
    },
    merge: (current, incoming) => {
      const have = new Set((current || []).map((r) => r.entryId))
      const fresh = (incoming || []).filter((r) => r?.entryId && !have.has(r.entryId))
      return { value: [...(current || []), ...fresh], conflicts: [] }
    },
  },
  {
    // Spec 024/037 follow-up — the open-challenge recovery-code vault. Passkeys sync across
    // devices but the vault is device-local localStorage, so a new device / reinstall lost every
    // saved four-word code (the exact "passkey users can't recover their codes" gap). Riding this
    // channel restores them, because the vault's at-rest envelope is encrypted under the account's
    // key material and the SAME account re-derives that key on any device (passkey master seed or
    // wallet signature). The value put in the bundle is the OPAQUE ciphertext envelope — the codes
    // never enter the backup channel in cleartext, and this stays consistent whether or not the
    // member has ever run a manual backup (auto-backup carries it too).
    key: 'openChallengeCodes',
    label: 'Recovery codes',
    networkScoped: false, // the envelope is opaque ciphertext; code entries are not identity-keyed by chain
    load: (account) => readVaultEnvelope(account),
    // Ciphertext envelopes from the same account share a key but use per-write nonces over
    // different entry sets, so they can't be unioned without the (async, ceremony-gated) vault
    // key that this synchronous path deliberately never holds. Both modes therefore RESTORE the
    // backed-up envelope only when this device has no local vault, and NEVER clobber existing
    // local codes — recovery is purely additive from the member's perspective.
    apply: (account, value, _mode) => {
      if (value && !hasVault(account)) writeVaultEnvelope(account, value)
      return { conflicts: [] }
    },
    merge: (current, incoming) => ({ value: current || incoming || null, conflicts: [] }),
  },
  {
    // Spec 062 — recovered legacy accounts. The value is a map of
    // passphrase-ENCRYPTED vault entries (ciphertext blobs only; no plaintext
    // key material), so it is safe to place in the backup. Not network-scoped:
    // a legacy EOA address is the same across every EVM chain, so entries are
    // keyed by address alone.
    key: 'legacyRecoveredKeys',
    label: 'Recovered accounts',
    networkScoped: false,
    load: (account) => loadLegacyRecoveredKeys(account),
    apply: (account, value, mode) => {
      if (mode === 'replace') {
        saveLegacyRecoveredKeys(account, value)
        return { conflicts: [] }
      }
      const { value: merged, conflicts } = mergeLegacyRecoveredKeys(loadLegacyRecoveredKeys(account), value)
      saveLegacyRecoveredKeys(account, merged)
      return { conflicts }
    },
    merge: (current, incoming) => mergeLegacyRecoveredKeys(current, incoming),
  },
  {
    // Spec 073 — per-app mini-app state, one entry for ALL apps rather than one
    // per app: the installed set is open-ended, so a listing added next week has
    // to ride this backup without editing this file.
    //
    // Not network-scoped. App data is chain-agnostic unless an app namespaces
    // its own keys by chain, and declaring it scoped would make the restore UI
    // offer a per-network choice the data cannot honor.
    //
    // Contains app state only — never a package, never key material, never
    // anything privileged (see the module header of lib/miniapps/store.js).
    key: 'miniAppState',
    label: 'Mini-app data',
    networkScoped: false,
    load: (account) => loadMiniAppState(account),
    apply: (account, value, mode) => applyMiniAppState(account, value, mode),
    merge: (current, incoming) => mergeMiniAppState(current, incoming),
  },
  {
    // Spec 085 — saved hardware-wallet accounts. The value is PUBLIC metadata only
    // (address, vendor, derivation path, label) — no key material exists to protect,
    // because the keys never leave the device. Not network-scoped: a hardware EOA
    // address is the same across every EVM chain, so entries are keyed by address alone.
    key: 'hardwareAccounts',
    label: 'Hardware wallet accounts',
    networkScoped: false,
    load: (account) => loadHardwareAccounts(account),
    apply: (account, value, mode) => {
      if (mode === 'replace') {
        saveHardwareAccounts(account, value)
        return { conflicts: [] }
      }
      const { value: merged, conflicts } = mergeHardwareAccounts(loadHardwareAccounts(account), value)
      saveHardwareAccounts(account, merged)
      return { conflicts }
    },
    merge: (current, incoming) => mergeHardwareAccounts(current, incoming),
  },
]

export default syncedObjects
