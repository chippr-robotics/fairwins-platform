/**
 * Assistant preferences (spec 095) — the opt-in switch and the memory-retention switch.
 *
 * DEFAULT OFF, AND THAT IS THE WHOLE POINT. Nothing about the assistant runs, renders, or transmits
 * until the member turns it on: the launcher renders nothing, no session is authorised, and no
 * message leaves the device. "Off" here is not a UI state — it is the absence of the feature.
 *
 * WALLET-SCOPED, NOT DEVICE-SCOPED. Sending a member's questions to a model provider is a decision
 * about an ACCOUNT, not about a browser. A member who enabled the assistant on their own account
 * must not find it silently enabled after switching to an account that never opted in — which is
 * exactly what a `fw_global_prefs` entry would do. That is the opposite call from `nav_density`
 * (spec 081), and for the opposite reason: nothing here needs to be correct on first paint, because
 * there is nothing to render until a wallet resolves.
 *
 * DELIBERATELY ABSENT FROM `lib/backup/syncedObjects.js`. Consent to send conversations to a model
 * provider should be given on the device it is given from; restoring a backup onto a new phone must
 * not arrive with the assistant already on. A test asserts the absence.
 *
 * PROVIDER (spec 104). `provider` names WHO ANSWERS: 'fairwins' (the gateway, on the membership) or
 * 'guttertoken' (the member's own GutterToken key, browser-direct). It is a preference, not a
 * capability: whether the chosen rail can actually run is `resolveProvider.js`'s job, which also
 * holds the key and membership facts this module deliberately knows nothing about. The default is
 * 'fairwins' and anything else stored is read as the default — a foreign string must not be able to
 * route a conversation to a third party. The value is persisted ONLY when it differs from the
 * default, so a member who never touched the radio keeps a stored blob byte-identical to spec 095's
 * `{ enabled, retainMemory }`; absence means "FairWins", exactly as absence of `enabled` means off.
 *
 * Shaped like `lib/nav/navPreferences.js` otherwise — lazy snapshot, validating reader, monotonic
 * revision with a throw-swallowing notify, and a `__reset…ForTests()` export.
 */
import { getUserPreference, saveUserPreference } from '../../utils/userStorage'

/** Wallet-scoped storage key. */
export const ASSISTANT_PREFS_KEY = 'assistant_prefs'

/**
 * `enabled` is opt-in. `retainMemory` decides whether the conversation is kept on THIS DEVICE
 * between openings — it never controls what is sent, only what this device remembers, and the
 * panel's copy says so.
 */
export const DEFAULT_ASSISTANT_PREFS = Object.freeze({ enabled: false, retainMemory: true, provider: 'fairwins' })

/** The two rails a conversation can run on. Order is display order (the membership rail first). */
export const ASSISTANT_PROVIDERS = Object.freeze(['fairwins', 'guttertoken'])

const DEFAULT_PROVIDER = DEFAULT_ASSISTANT_PREFS.provider

/** A stored provider is honoured only when it names a rail this build knows; anything else is the default. */
const normalizeProvider = (value) => (ASSISTANT_PROVIDERS.includes(value) ? value : DEFAULT_PROVIDER)

/** @type {{account: string, value: {enabled: boolean, retainMemory: boolean, provider: string}}|null} */
let snapshot = null
let revision = 0
const listeners = new Set()

const norm = (account) => (account ? String(account).toLowerCase() : null)

/** A foreign shape is replaced by the defaults rather than trusted to decide whether we transmit. */
function read(account) {
  const raw = getUserPreference(account, ASSISTANT_PREFS_KEY, null, true)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_ASSISTANT_PREFS }
  return {
    // `=== true` and not truthiness: anything that is not an explicit yes is a no.
    enabled: raw.enabled === true,
    retainMemory: raw.retainMemory !== false,
    provider: normalizeProvider(raw.provider),
  }
}

/**
 * This account's preferences. Never returns null; a missing account yields the defaults, so a
 * disconnected app is indistinguishable from one that never opted in — which is correct.
 */
export function loadAssistantPrefs(account) {
  const key = norm(account)
  if (!key) return { ...DEFAULT_ASSISTANT_PREFS }
  if (!snapshot || snapshot.account !== key) snapshot = { account: key, value: read(account) }
  return snapshot.value
}

/** Whether the assistant is enabled for this account. The launcher's last gate. */
export function isAssistantEnabled(account) {
  return loadAssistantPrefs(account).enabled === true
}

/** Whether this device keeps the conversation between openings. */
export function isMemoryRetained(account) {
  return loadAssistantPrefs(account).retainMemory !== false
}

/** Which rail this account has chosen. Never null; a missing account yields the default rail. */
export function getAssistantProvider(account) {
  return loadAssistantPrefs(account).provider
}

/** Monotonic counter — React consumers re-derive from it. */
export function assistantPrefsRevision() {
  return revision
}

/** Subscribe to preference changes. Returns an unsubscribe function. */
export function subscribeAssistantPrefs(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
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

function write(account, next) {
  const key = norm(account)
  if (!key) return next
  snapshot = { account: key, value: next }
  // The default provider is stored as ABSENCE (see the header), so the blob of a member who never
  // chose a rail is unchanged from spec 095's shape.
  const { provider, ...rest } = next
  saveUserPreference(
    account,
    ASSISTANT_PREFS_KEY,
    provider === DEFAULT_PROVIDER ? rest : { ...rest, provider },
    true
  )
  notify()
  return next
}

/** Turn the assistant on or off for this account. */
export function setAssistantEnabled(account, enabled) {
  return write(account, { ...loadAssistantPrefs(account), enabled: enabled === true })
}

/** Turn on-device conversation retention on or off. */
export function setMemoryRetained(account, retain) {
  return write(account, { ...loadAssistantPrefs(account), retainMemory: retain !== false })
}

/**
 * Choose which rail answers for this account. An unknown value falls back to the default rail rather
 * than throwing: the radio that calls this can only offer the two known rails, so anything else is
 * a stale or foreign value, and the safe reading of "something we do not recognise" is FairWins.
 */
export function setAssistantProvider(account, provider) {
  return write(account, { ...loadAssistantPrefs(account), provider: normalizeProvider(provider) })
}

/** Test seam: forget the in-memory snapshot so the next read hits storage again. */
export function __resetAssistantPrefsForTests() {
  snapshot = null
  revision = 0
  listeners.clear()
}
