// Spec 043 — client-side store of a member's vault references + labels. This is the ONLY custody data placed
// in the app-wide encrypted backup (spec 032). It is NOT authoritative over on-chain state: the vault lives on
// chain and is re-loadable by address; these records just remember which vaults a member belongs to and their
// member-authored labels (labels are client-side only, never on-chain). Identity is (chainId, address).

import { getAddress } from 'viem'
import { getUserPreference, saveUserPreference } from '../../utils/userStorage'

const STORAGE_KEY = 'custody_vault_references'

/** Normalize to a checksummed address, or null if invalid. */
export function normalizeVaultAddress(input) {
  try {
    return getAddress(String(input).trim())
  } catch {
    return null
  }
}

/** Stable identity key for a reference. */
export function vaultKey(chainId, address) {
  return `${Number(chainId)}:${normalizeVaultAddress(address)}`
}

function sanitize(entry) {
  const address = normalizeVaultAddress(entry?.address)
  const chainId = Number(entry?.chainId)
  if (!address || !Number.isFinite(chainId)) return null
  return {
    address,
    chainId,
    label: typeof entry.label === 'string' ? entry.label : '',
    addedAt: Number.isFinite(entry?.addedAt) ? entry.addedAt : 0,
    role: entry?.role === 'owner' ? 'owner' : 'watch',
  }
}

/** Load all vault references for a wallet (array). */
export function loadVaultReferences(account) {
  const raw = getUserPreference(account, STORAGE_KEY, [], true)
  if (!Array.isArray(raw)) return []
  return raw.map(sanitize).filter(Boolean)
}

/** Persist the full array (replaces). */
export function saveVaultReferences(account, refs) {
  const clean = (Array.isArray(refs) ? refs : []).map(sanitize).filter(Boolean)
  saveUserPreference(account, STORAGE_KEY, clean, true)
  return clean
}

/**
 * Insert or update one reference by (chainId, address). On update, `addedAt` is bumped to the edit time so a
 * fresh label/role edit wins the backup merge (mergeVaultReferences resolves conflicts by newest `addedAt`);
 * it never moves backwards. Returns the new array.
 */
export function upsertVaultReference(account, entry, nowMs = 0) {
  const next = sanitize(entry)
  if (!next) return loadVaultReferences(account)
  if (!next.addedAt) next.addedAt = nowMs
  const current = loadVaultReferences(account)
  const key = vaultKey(next.chainId, next.address)
  const idx = current.findIndex((r) => vaultKey(r.chainId, r.address) === key)
  if (idx === -1) {
    current.push(next)
  } else {
    // Bump addedAt so an edit is "newer" than the prior entry (and any other device's copy) at merge time.
    const addedAt = Math.max(current[idx].addedAt || 0, next.addedAt || 0)
    current[idx] = { ...current[idx], ...next, addedAt }
  }
  return saveVaultReferences(account, current)
}

/** Remove one reference by (chainId, address). */
export function removeVaultReference(account, chainId, address) {
  const key = vaultKey(chainId, address)
  const current = loadVaultReferences(account).filter((r) => vaultKey(r.chainId, r.address) !== key)
  return saveVaultReferences(account, current)
}

/**
 * Merge two reference arrays (used by the backup restore "merge" mode). Union by (chainId, address); the entry
 * with the greater `addedAt` wins its label/role (newest label wins). Pure — does not touch storage.
 * @returns {{ value: object[], conflicts: object[] }}
 */
export function mergeVaultReferences(current, incoming) {
  const byKey = new Map()
  for (const e of (current || []).map(sanitize).filter(Boolean)) byKey.set(vaultKey(e.chainId, e.address), e)
  const conflicts = []
  for (const raw of (incoming || []).map(sanitize).filter(Boolean)) {
    const key = vaultKey(raw.chainId, raw.address)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, raw)
    } else {
      const winner = raw.addedAt >= existing.addedAt ? raw : existing
      if (existing.label !== raw.label && existing.label && raw.label) {
        conflicts.push({ key, kept: winner.label, other: winner === raw ? existing.label : raw.label })
      }
      byKey.set(key, { ...winner, addedAt: Math.max(existing.addedAt, raw.addedAt) })
    }
  }
  return { value: Array.from(byKey.values()), conflicts }
}
