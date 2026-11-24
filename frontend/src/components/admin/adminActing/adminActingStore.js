/**
 * Who the operations console is acting AS, and which owner key signs for it.
 *
 * Two independent choices, held outside React so they survive moving between the Control Room
 * and an app (they are separate routes):
 *
 *  - `safeAddress` — the Safe whose authority the console uses. Persisted, device-scoped: it is a
 *    public contract address, so remembering it costs nothing and saves pasting it every visit.
 *  - `hardwareSigner` — a Ledger/Trezor/Sigil session (spec 085 `HardwareSigner`) used as the
 *    owner key instead of the connected wallet. MEMORY ONLY, never persisted, and its transport is
 *    CLOSED when it is dropped (the CustodyContext rule: a session left open keeps the device
 *    claimed and unreachable to other tabs until it is unplugged).
 *
 * Neither is ever synced (`lib/backup/syncedObjects.js`): a Safe choice is a property of the
 * device someone administers from, and a device session cannot leave the browser at all.
 */
export const ADMIN_SAFE_PREF_KEY = 'fw_admin_acting_safe'

let state = { safeAddress: readSafe(), hardwareSigner: null }
const listeners = new Set()

function readSafe() {
  try {
    const v = globalThis.localStorage?.getItem(ADMIN_SAFE_PREF_KEY)
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null
  } catch {
    return null
  }
}

function writeSafe(v) {
  try {
    if (v) globalThis.localStorage?.setItem(ADMIN_SAFE_PREF_KEY, v)
    else globalThis.localStorage?.removeItem(ADMIN_SAFE_PREF_KEY)
  } catch {
    /* storage blocked — the choice still holds for this session */
  }
}

function emit() {
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      /* one bad listener must not block the rest */
    }
  }
}

function closeSession(signer) {
  try {
    signer?.session?.close?.()?.catch?.(() => {})
  } catch {
    /* releasing a dead transport must never break a switch */
  }
}

export function subscribeAdminActing(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAdminActing() {
  return state
}

/** Act as `address` (a Safe), or pass null to act as the signing account itself. */
export function setAdminSafe(address) {
  const next = address || null
  if (next === state.safeAddress) return
  writeSafe(next)
  state = { ...state, safeAddress: next }
  emit()
}

/** Use a device-backed signer as the owner key, or null to fall back to the connected wallet. */
export function setAdminHardwareSigner(signer) {
  if (signer === state.hardwareSigner) return
  if (state.hardwareSigner && state.hardwareSigner.session !== signer?.session) closeSession(state.hardwareSigner)
  state = { ...state, hardwareSigner: signer || null }
  emit()
}

/** Test seam: reset to the persisted state with no device session. */
export function resetAdminActingForTests() {
  closeSession(state.hardwareSigner)
  state = { safeAddress: readSafe(), hardwareSigner: null }
  emit()
}
