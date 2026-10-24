/**
 * GutterToken API key store (spec 104) — the key, and only the key.
 *
 * A member on the GutterToken rail pays for their own model calls with a key they pasted. This module
 * is where that key lives and the ONLY module that hands it out in the clear. It follows the spec-069
 * RPC-credential precedent, not the spec-062 recovery vault: a GutterToken key is a revocable,
 * re-copyable credential over a bounded prepaid balance, so it is plaintext at rest like an RPC
 * provider key, and the panel says so in words.
 *
 * Three rules, each with a reason:
 *
 * 1. WALLET-SCOPED, NOT DEVICE-SCOPED. Sending a member's questions to a third party on that member's
 *    own credit is a decision about an ACCOUNT. A second account on the same browser must not inherit
 *    it — which is what a `fw_global_prefs` entry would do. Same call as `assistant_prefs`.
 *
 * 2. DELIBERATELY ABSENT FROM `lib/backup/syncedObjects.js`. The spec-032 backup is exportable
 *    plaintext-at-rest for everything except the key vault, and a credential that spends money must
 *    not ride it onto another device. A member re-enters the key per device; a test asserts the
 *    absence. Do not "fix" that by adding an entry there.
 *
 * 3. REDACTED AT EVERY BOUNDARY. `loadGutterTokenKey` exists for ONE caller — the transport in
 *    `providers/guttertoken.js`, which puts the key in an `Authorization` header. Every other
 *    consumer (the Settings row, the key sheet, the audit event) goes through
 *    `describeGutterTokenKey` / `redactGutterTokenKey`, which show `sk-…` plus the last FOUR
 *    characters and never more. Nothing in this module logs the key, throws it, or returns it inside
 *    an error object, and every fixed sentence below was written so that it cannot.
 *
 * The record is `{ v: 1, key, savedAt }`. `savedAt` is display metadata ("added 3 days ago"); the
 * version lets a future shape (a PRF-wrapped key, if product ever wants it) refuse to read this one
 * as its own.
 */
import { getUserPreference, removeUserPreference, saveUserPreference } from '../../utils/userStorage'
import { GUTTERTOKEN_BASE_URL } from './providers/guttertoken'

/** Wallet-scoped storage key. Versioned so a future shape change cannot be read as this one. */
export const GUTTERTOKEN_KEY_STORAGE_KEY = 'assistant_guttertoken_key_v1'

/** Shape bounds. GutterToken keys are `sk-…`; the length window is generous on purpose. */
export const GUTTERTOKEN_KEY_PREFIX = 'sk-'
export const GUTTERTOKEN_KEY_MIN_LENGTH = 12
export const GUTTERTOKEN_KEY_MAX_LENGTH = 512

/** How many trailing characters a redaction may show. Four, and never a different number. */
const REDACTION_TAIL = 4

/** Budget for the one `GET /v1/models` a save performs. Short: it is a liveness check, not a read. */
const TEST_TIMEOUT_MS = 8_000

const norm = (account) => (account ? String(account).toLowerCase() : null)

/** @type {{account: string, record: {key: string, savedAt: number|null}|null}|null} */
let snapshot = null
let revision = 0
const listeners = new Set()

// ---------------------------------------------------------------------------
// Pure helpers — no storage, no network
// ---------------------------------------------------------------------------

/**
 * Whether `key` has the shape of a GutterToken key. Errors are fixed sentences: none of them
 * interpolates the input, so a validation message can be shown or logged without a second thought.
 *
 * @param {unknown} key
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateGutterTokenKeyFormat(key) {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return { ok: false, error: 'Paste a GutterToken API key.' }
  }
  const trimmed = key.trim()
  if (/\s/.test(trimmed)) {
    return { ok: false, error: 'A GutterToken key has no spaces or line breaks in it. Check the paste.' }
  }
  if (!trimmed.startsWith(GUTTERTOKEN_KEY_PREFIX)) {
    return { ok: false, error: `A GutterToken key starts with "${GUTTERTOKEN_KEY_PREFIX}". This one does not.` }
  }
  if (trimmed.length < GUTTERTOKEN_KEY_MIN_LENGTH) {
    return { ok: false, error: 'That is too short to be a GutterToken key.' }
  }
  if (trimmed.length > GUTTERTOKEN_KEY_MAX_LENGTH) {
    return { ok: false, error: 'That is too long to be a GutterToken key.' }
  }
  return { ok: true }
}

/**
 * The only form of a key that may reach a screen, a log, or an audit field: `sk-…` plus the last
 * four characters. A key that does not validate shows NO tail at all — for a short or malformed
 * string, four characters could be most of the secret.
 *
 * @param {unknown} key
 * @returns {string}
 */
export function redactGutterTokenKey(key) {
  if (!validateGutterTokenKeyFormat(key).ok) return `${GUTTERTOKEN_KEY_PREFIX}…`
  return `${GUTTERTOKEN_KEY_PREFIX}…${String(key).trim().slice(-REDACTION_TAIL)}`
}

// ---------------------------------------------------------------------------
// Persistence + in-memory snapshot
// ---------------------------------------------------------------------------

/** A foreign shape reads as "no key" — it is never handed to a transport on the chance it is one. */
function readRecord(account) {
  const raw = getUserPreference(account, GUTTERTOKEN_KEY_STORAGE_KEY, null, true)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.v !== 1 || !validateGutterTokenKeyFormat(raw.key).ok) return null
  const savedAt = Number(raw.savedAt)
  return { key: String(raw.key).trim(), savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : null }
}

function record(account) {
  const key = norm(account)
  if (!key) return null
  if (!snapshot || snapshot.account !== key) snapshot = { account: key, record: readRecord(account) }
  return snapshot.record
}

function notify() {
  revision += 1
  for (const listener of listeners) {
    try {
      listener(revision)
    } catch {
      // A bad subscriber must not break the save.
    }
  }
}

/** Whether this account has a key saved on this device. The gate `resolveProvider` reads. */
export function hasGutterTokenKey(account) {
  return record(account) !== null
}

/**
 * THE KEY IN THE CLEAR. For `providers/guttertoken.js` only — it goes into an `Authorization`
 * header and nowhere else. UI code wanting to show the key uses `describeGutterTokenKey`; there is
 * no legitimate reason for a component to hold the clear value, and a test greps for callers.
 *
 * @returns {string|null}
 */
export function loadGutterTokenKey(account) {
  return record(account)?.key ?? null
}

/**
 * What a screen may know about the stored key: that one exists, its redacted form, and when it was
 * saved. Never the key.
 *
 * @returns {{present: boolean, redacted: string|null, savedAt: number|null}}
 */
export function describeGutterTokenKey(account) {
  const rec = record(account)
  if (!rec) return { present: false, redacted: null, savedAt: null }
  return { present: true, redacted: redactGutterTokenKey(rec.key), savedAt: rec.savedAt }
}

/**
 * Persist a key for this account after shape validation. The transport test (`testGutterTokenKey`)
 * is a separate, explicit step — the key sheet runs it before calling this, but an unreachable
 * GutterToken must not make a correct key unsaveable (spec 069's rule: save with the failure shown).
 *
 * @returns {{ok: true, redacted: string} | {ok: false, error: string}}
 */
export function saveGutterTokenKey(account, key) {
  const acct = norm(account)
  if (!acct) return { ok: false, error: 'Connect a wallet before saving a GutterToken key.' }
  const shape = validateGutterTokenKeyFormat(key)
  if (!shape.ok) return shape
  const trimmed = String(key).trim()
  const rec = { key: trimmed, savedAt: Date.now() }
  snapshot = { account: acct, record: rec }
  saveUserPreference(account, GUTTERTOKEN_KEY_STORAGE_KEY, { v: 1, key: rec.key, savedAt: rec.savedAt }, true)
  notify()
  return { ok: true, redacted: redactGutterTokenKey(trimmed) }
}

/** Forget this account's key on this device. A no-op without a wallet. */
export function removeGutterTokenKey(account) {
  const acct = norm(account)
  if (!acct) return
  snapshot = { account: acct, record: null }
  removeUserPreference(account, GUTTERTOKEN_KEY_STORAGE_KEY, true)
  notify()
}

/** Monotonic counter — React consumers re-derive from it. */
export function gutterTokenKeyRevision() {
  return revision
}

/** Subscribe to key add/remove. Returns an unsubscribe function. Listeners receive the revision, never the key. */
export function subscribeGutterTokenKey(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---------------------------------------------------------------------------
// The one network call: does GutterToken accept this key?
// ---------------------------------------------------------------------------

/**
 * Model ids out of a `/v1/models` body. GutterToken mirrors the Anthropic shape (`{ data: [{ id }] }`);
 * a plain `{ models: [...] }` is accepted too. Anything else yields an empty list rather than a throw:
 * the status code already said the key was accepted.
 */
function modelIdsOf(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((id) => typeof id === 'string' && id.length > 0)
}

/**
 * Ask GutterToken whether it accepts `key`, with one bounded `GET /v1/models`.
 *
 * Every outcome is a fixed sentence keyed by a state the key sheet renders. The response BODY is
 * read only on success (for the model list): an error body may say anything, and the status code
 * carries every fact the member needs. The key never appears in the result, in a thrown error, or
 * in a log — a transport exception is swallowed to a state, because `fetch` errors can quote the
 * request.
 *
 * @param {string} key
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, baseUrl?: string}} [options]
 * @returns {Promise<{ok: true, models: string[]} | {ok: false, state: 'key_invalid'|'unreachable'|'quota'|'unavailable'|'rejected', message: string}>}
 */
export async function testGutterTokenKey(key, { fetchImpl = fetch, timeoutMs = TEST_TIMEOUT_MS, baseUrl = GUTTERTOKEN_BASE_URL } = {}) {
  const shape = validateGutterTokenKeyFormat(key)
  if (!shape.ok) return { ok: false, state: 'rejected', message: shape.error }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${String(key).trim()}`, Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch {
    return {
      ok: false,
      state: 'unreachable',
      message: 'GutterToken could not be reached from this device. The key was not checked.',
    }
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401) {
    return { ok: false, state: 'key_invalid', message: 'GutterToken did not accept this key. It may have been revoked.' }
  }
  if (res.status === 429) {
    return { ok: false, state: 'quota', message: 'GutterToken is rate-limiting requests from your network. Try again shortly.' }
  }
  if (res.status >= 500) {
    return { ok: false, state: 'unavailable', message: 'GutterToken is not answering right now. Try again shortly.' }
  }
  if (!res.ok) {
    return {
      ok: false,
      state: 'rejected',
      message: `GutterToken refused the check (HTTP ${res.status}). The key was not saved as verified.`,
    }
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    // A body that is not JSON is not a failure here: the status already said the key was accepted,
    // and the model list is the only thing that is lost. `body` stays null and yields an empty list.
  }
  return { ok: true, models: modelIdsOf(body) }
}

/**
 * Ask GutterToken whether it still accepts the key THIS DEVICE holds for `account`.
 *
 * The Assistant tab's "Test" button, and the reason it exists here rather than in the card: a
 * component testing the stored key would have to read it out first, and the clear key has exactly
 * one legitimate caller (`conversation.js`, for an `Authorization` header) — a rule a test enforces
 * by scanning for callers. So the store tests its own key and hands back only the outcome.
 *
 * No key saved is its own answer, not a network call.
 *
 * @param {string} account
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, baseUrl?: string}} [options]
 * @returns {Promise<{ok: true, models: string[]} | {ok: false, state: string, message: string}>}
 */
export async function testStoredGutterTokenKey(account, options = {}) {
  const stored = loadGutterTokenKey(account)
  if (!stored) {
    return { ok: false, state: 'key_missing', message: 'No GutterToken key is saved on this device.' }
  }
  return testGutterTokenKey(stored, options)
}

/** Test seam: forget the in-memory snapshot and subscribers so the next read hits storage again. */
export function __resetGutterTokenKeyForTests() {
  snapshot = null
  revision = 0
  listeners.clear()
}
