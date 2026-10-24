// Spec 105 — per-vault creation records: the chain-independent facts that make deploying the SAME
// vault address to another network possible later (owners AT CREATION, threshold, saltNonce, the
// member's one semantic rules config). Public parameters only — never key material, never a secret.
//
// Records are IMMUTABLE once written: owner changes live on-chain, not here; the record is the
// initializer replay input, and editing it would silently repoint "Add a network" at a different
// address. The store is account-scoped and non-network-scoped (registered in
// lib/backup/syncedObjects.js — the record is precisely the facts no single chain holds), merge is
// union-by-address with existing-entry-wins, so two devices can never disagree about a vault's
// creation parameters. Absence is a first-class state: a vault loaded by address has no record and
// "Add a network" says so honestly (FR-018) instead of guessing an initializer.

import { getAddress } from 'viem'
import { getUserPreference, saveUserPreference } from '../../utils/userStorage'

const STORAGE_KEY = 'vault_creation_records'
export const CREATION_RECORD_VERSION = 1

function normalizeAddress(input) {
  try {
    return getAddress(String(input).trim())
  } catch {
    return null
  }
}

/** Sanitize one record; null if structurally invalid. */
export function sanitizeCreationRecord(entry) {
  const address = normalizeAddress(entry?.address)
  if (!address) return null
  const owners = Array.isArray(entry?.owners) ? entry.owners.map(normalizeAddress) : []
  if (owners.length === 0 || owners.some((o) => !o)) return null
  const threshold = Number(entry?.threshold)
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) return null
  // saltNonce is stored as a decimal STRING so BigInt-sized values survive JSON.
  let saltNonce
  try {
    saltNonce = BigInt(entry?.saltNonce).toString()
  } catch {
    return null
  }
  const presetType = ['joint', 'controlled', 'complex'].includes(entry?.presetType)
    ? entry.presetType
    : 'complex'
  return {
    address,
    owners,
    threshold,
    saltNonce,
    presetType,
    rules: entry?.rules && typeof entry.rules === 'object' ? entry.rules : null,
    createdAt: Number.isFinite(entry?.createdAt) ? entry.createdAt : 0,
    v: CREATION_RECORD_VERSION,
  }
}

/** All creation records for a member account (array). */
export function loadCreationRecords(account) {
  const raw = getUserPreference(account, STORAGE_KEY, [], true)
  if (!Array.isArray(raw)) return []
  return raw.map(sanitizeCreationRecord).filter(Boolean)
}

/** The record for one vault address, or null (absence is a first-class state — FR-018). */
export function getCreationRecord(account, vaultAddress) {
  const address = normalizeAddress(vaultAddress)
  if (!address) return null
  return loadCreationRecords(account).find((r) => r.address === address) || null
}

/** Two records describe the same creation iff every replay-relevant field matches. */
export function creationRecordsEqual(a, b) {
  if (!a || !b) return false
  return (
    a.address === b.address &&
    a.threshold === b.threshold &&
    a.saltNonce === b.saltNonce &&
    a.owners.length === b.owners.length &&
    a.owners.every((o, i) => o === b.owners[i])
  )
}

/**
 * Persist a new record. Writing the same record twice is a no-op; writing a DIFFERING record for
 * an address that already has one throws — a record is the replay input for a deployed address
 * and can never legitimately change.
 */
export function saveCreationRecord(account, entry) {
  const next = sanitizeCreationRecord(entry)
  if (!next) throw new Error('Invalid creation record')
  const current = loadCreationRecords(account)
  const existing = current.find((r) => r.address === next.address)
  if (existing) {
    if (!creationRecordsEqual(existing, next)) {
      throw new Error(`A different creation record already exists for ${next.address}`)
    }
    return existing
  }
  saveUserPreference(account, STORAGE_KEY, [...current, next], true)
  return next
}

/**
 * Backup merge: union by address, EXISTING entry wins (records are immutable, so the entry this
 * device already trusts stays authoritative; a genuinely identical incoming record changes
 * nothing, and a conflicting one is reported rather than silently adopted).
 */
export function mergeCreationRecords(current, incoming) {
  const base = (Array.isArray(current) ? current : []).map(sanitizeCreationRecord).filter(Boolean)
  const have = new Map(base.map((r) => [r.address, r]))
  const conflicts = []
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const rec = sanitizeCreationRecord(raw)
    if (!rec) continue
    const existing = have.get(rec.address)
    if (!existing) {
      have.set(rec.address, rec)
    } else if (!creationRecordsEqual(existing, rec)) {
      conflicts.push({ key: rec.address, kind: 'creation-record-mismatch' })
    }
  }
  // Deterministic order so merge(a,b) and merge(b,a) persist identical arrays (modulo the winner rule).
  const value = [...have.values()].sort((a, b) => a.address.localeCompare(b.address))
  return { value, conflicts }
}

/** Replace-mode apply for the backup seam (still refuses to lose a local record silently). */
export function applyCreationRecords(account, value, mode) {
  if (mode === 'replace') {
    const clean = (Array.isArray(value) ? value : []).map(sanitizeCreationRecord).filter(Boolean)
    const { value: merged, conflicts } = mergeCreationRecords(clean, loadCreationRecords(account))
    saveUserPreference(account, STORAGE_KEY, merged, true)
    return { conflicts }
  }
  const { value: merged, conflicts } = mergeCreationRecords(loadCreationRecords(account), value)
  saveUserPreference(account, STORAGE_KEY, merged, true)
  return { conflicts }
}
