// Spec 111 — where this DEVICE reaches its local Sigil bridge, and the pairing token it presents.
//
// The token is a local credential: it authorizes this browser to ask the bridge on this computer
// for signatures while a Sigil disk is inserted. It is therefore held under the spec-069 RPC
// credential rules, not the spec-085 hardware-account store:
//
//   * device-scoped (`fw_global_prefs.sigil_bridge`) — it pairs THIS browser with THIS computer's
//     bridge, and means nothing on another device;
//   * deliberately ABSENT from `lib/backup/syncedObjects.js` (a test asserts it) — a backup that
//     carried it would hand a signing credential to every device the member restores onto;
//   * never in a URL (it rides the Authorization header) and redacted at every display boundary.
//
// The saved Sigil ACCOUNT (address, vendor, path, label) still lives in the spec-085 store as
// public metadata; only the pairing lives here.

import { getGlobalPreference, saveGlobalPreference } from '../../utils/userStorage'
import { CSP_RPC_GRANTS } from '../network/endpointStore'

export const SIGIL_BRIDGE_PREF_KEY = 'sigil_bridge'
export const DEFAULT_SIGIL_BRIDGE_URL = 'http://127.0.0.1:7318'
const TOKEN_SHAPE = /^[0-9a-fA-F]{32,256}$/

let revision = 0
const listeners = new Set()
const emit = () => {
  revision += 1
  for (const l of listeners) l()
}
export const subscribeSigilBridge = (l) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const getSigilBridgeRevision = () => revision

/**
 * Validate a bridge URL: loopback only (the bridge exists to reach THIS computer), on a host the
 * production CSP actually grants over http. Returns the normalized origin or throws a sentence.
 */
export function normalizeBridgeUrl(value) {
  let u
  try {
    u = new URL(String(value || '').trim())
  } catch {
    throw new Error('Enter the bridge address, for example http://127.0.0.1:7318.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('The bridge address must start with http:// or https://.')
  }
  if (!CSP_RPC_GRANTS.httpHosts.includes(u.hostname)) {
    throw new Error('The Sigil bridge runs on this computer: use http://127.0.0.1 or http://localhost.')
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new Error('Enter only the bridge address (scheme, host and port), with nothing after it.')
  }
  return u.origin
}

export function normalizeBridgeToken(value) {
  const t = String(value || '').trim()
  if (!TOKEN_SHAPE.test(t)) {
    throw new Error('Paste the pairing token from the bridge’s token file (a long hexadecimal string).')
  }
  return t.toLowerCase()
}

/** `…` + the last 4 characters. The only form a token may take on screen or in a log. */
export function redactBridgeToken(token) {
  const t = String(token || '')
  return t ? `…${t.slice(-4)}` : ''
}

/** @returns {{ url: string, token: string } | null} */
export function loadSigilBridge() {
  const raw = getGlobalPreference(SIGIL_BRIDGE_PREF_KEY, null)
  if (!raw || typeof raw !== 'object') return null
  try {
    return { url: normalizeBridgeUrl(raw.url), token: normalizeBridgeToken(raw.token) }
  } catch {
    return null
  }
}

export function saveSigilBridge({ url, token }) {
  const value = { url: normalizeBridgeUrl(url), token: normalizeBridgeToken(token) }
  saveGlobalPreference(SIGIL_BRIDGE_PREF_KEY, value)
  emit()
  return value
}

export function clearSigilBridge() {
  saveGlobalPreference(SIGIL_BRIDGE_PREF_KEY, null)
  emit()
}
