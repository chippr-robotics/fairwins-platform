// Spec 085 — the backup-synced store of a member's saved hardware-wallet accounts. It holds ONLY
// public artifacts — address, vendor, derivation path, label, addedAt — never key material, never an
// xpub, never a device identifier beyond the vendor name (FR-005). Per-account, keyed by lowercased
// address so a given hardware account is stored once. This module owns the storage key + value shape;
// the imperative CRUD facade (`hardwareWalletVault` in hardwareAccounts.js) reads/writes through the
// same key, so there is a single source of truth. Mirrors legacyRecoveredKeysStore (spec 062).

import { getUserPreference, saveUserPreference } from '../../utils/userStorage'

// Per-account userStorage key (resolves to fw_user_<owner>_hardware_accounts).
export const HARDWARE_ACCOUNTS_STORAGE_KEY = 'hardware_accounts'

// Spec 111 added 'sigil' (MPC floppy signer). Its `path` is `sigil:<child id>` — one account per disk.
export const HARDWARE_VENDORS = Object.freeze(['ledger', 'trezor', 'sigil'])

const isEntry = (e) =>
  e &&
  typeof e === 'object' &&
  typeof e.address === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(e.address) &&
  HARDWARE_VENDORS.includes(e.vendor) &&
  typeof e.path === 'string'

const lower = (a) => String(a).toLowerCase()

// Change notification so React surfaces (useHardwareAccounts) re-read after any mutation,
// including one made by another component. Module-local pub/sub, same idea as the endpoint
// store's revision counter (spec 069).
let revision = 0
const listeners = new Set()

export function getHardwareAccountsRevision() {
  return revision
}

/** Subscribe to store mutations. Returns an unsubscribe function (useSyncExternalStore-shaped). */
export function subscribeHardwareAccounts(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitChange() {
  revision += 1
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      /* one bad listener must not block the rest */
    }
  }
}

/** Load the hardware-accounts map for an owner: { [lowerAddress]: Entry }. */
export function loadHardwareAccounts(account) {
  const raw = getUserPreference(account, HARDWARE_ACCOUNTS_STORAGE_KEY, {}, true)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (isEntry(v)) out[lower(k)] = v
  }
  return out
}

/** Persist the full map (replaces). */
export function saveHardwareAccounts(account, map) {
  const clean = {}
  for (const [k, v] of Object.entries(map || {})) {
    if (isEntry(v)) clean[lower(k)] = v
  }
  saveUserPreference(account, HARDWARE_ACCOUNTS_STORAGE_KEY, clean, true)
  emitChange()
  return clean
}

/**
 * Merge two hardware-account maps (backup restore "merge" mode). Union by lowercased address; on the
 * same address the entry with the newer `addedAt` wins. `conflicts` lists addresses present on both
 * sides that disagree about vendor or path (informational — the newer save is kept). Pure.
 * @returns {{ value: Record<string, object>, conflicts: Array<{ address: string }> }}
 */
export function mergeHardwareAccounts(current, incoming) {
  const out = {}
  const conflicts = []
  for (const [k, v] of Object.entries(current || {})) {
    if (isEntry(v)) out[lower(k)] = v
  }
  for (const [k, v] of Object.entries(incoming || {})) {
    if (!isEntry(v)) continue
    const key = lower(k)
    const existing = out[key]
    if (!existing) {
      out[key] = v
      continue
    }
    if (existing.vendor !== v.vendor || existing.path !== v.path) conflicts.push({ address: key })
    out[key] = (v.addedAt || 0) >= (existing.addedAt || 0) ? v : existing
  }
  return { value: out, conflicts }
}
