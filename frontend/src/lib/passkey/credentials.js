/**
 * WebAuthn credential ceremonies for passkey accounts (spec 041, T016).
 *
 * Wraps the browser WebAuthn API (navigator.credentials) with:
 *  - capability detection (FR-004: the login surface offers passkeys only
 *    where genuinely usable, with an honest reason otherwise),
 *  - typed errors (contracts/passkey-connector.md error taxonomy),
 *  - PRF extension request at creation (feeds prfKeys.js, FR-012),
 *  - duplicate-signup steering (edge case: existing credential → sign-in).
 *
 * The private key NEVER leaves the platform authenticator; this module only
 * handles credential IDs, public keys, and assertion outputs.
 *
 * NATIVE CHANNELS (spec 102): on a native runtime the ceremonies run through
 * the platform credential bridge instead of `navigator.credentials` (the
 * embedded WebView is not a reliable WebAuthn citizen on either OS). The
 * selection lives HERE, in `resolveCredentialManager`, and the bridge is
 * credentials-shaped — every caller above this file is rail-blind, and the
 * relying party stays the tenant's web origin so the SAME passkey serves web
 * and native (FR-003).
 */
import { getRuntime, nativeCapability, NATIVE_CAPABILITIES, RUNTIMES } from '../native/runtime'
import { nativeCredentialManager } from '../native/nativeCredentials'

const RP_NAME = 'FairWins'
const CREDENTIALS_KEY = 'fairwins.passkey.credentials.v1'

/** Typed error: the user dismissed/cancelled the platform ceremony. Clean abort. */
export class CeremonyCancelled extends Error {
  constructor(message = 'Passkey prompt was cancelled') {
    super(message)
    this.name = 'CeremonyCancelled'
  }
}

/**
 * Typed error: the ceremony was answered by a DIFFERENT credential than the one
 * the member picked.
 *
 * Deliberately not a CeremonyCancelled. `ConnectModal` treats that as a clean
 * abort and resets the step WITHOUT surfacing the message, so classifying this
 * as a cancellation would swallow the explanation entirely and leave the member
 * looking at a chooser that silently reappeared.
 */
export class CredentialMismatch extends Error {
  constructor(message) {
    super(message)
    this.name = 'CredentialMismatch'
  }
}

/** Typed error: no usable authenticator/WebAuthn support in this context. */
export class AuthenticatorUnavailable extends Error {
  constructor(reason) {
    super(`Passkeys are not available: ${reason}`)
    this.name = 'AuthenticatorUnavailable'
    this.reason = reason
  }
}

/**
 * Typed error: the platform never answered the ceremony.
 *
 * DISTINCT FROM CeremonyCancelled ON PURPOSE. A cancellation is the member
 * saying no; this is the device saying nothing at all — no prompt, no
 * rejection — and telling someone they cancelled a prompt they never saw is a
 * lie that also hides the fault.
 */
export class CeremonyUnanswered extends Error {
  constructor(message = 'The device never answered the passkey prompt — no sign-in sheet appeared. Try again, or use another sign-in method.') {
    super(message)
    this.name = 'CeremonyUnanswered'
  }
}

/**
 * How long to wait for the platform before giving the member back control.
 *
 * `navigator.credentials.get()` is NOT guaranteed to settle. When the platform
 * declines to show its UI at all — observed in the installed PWA on Android,
 * where the same code in a browser tab shows the sheet normally — the promise
 * stays pending forever. Everything above it then hangs with it: the connector
 * never returns, WalletContext's in-flight guard is never released by its
 * `finally`, and every later attempt is refused with "a connection attempt is
 * already in progress" until the app is restarted. One unanswered prompt
 * becomes a permanent lockout.
 *
 * Two minutes is longer than any real ceremony (biometric prompts are seconds)
 * and short enough that a member is not stuck staring at nothing.
 */
export const CEREMONY_TIMEOUT_MS = 120_000

/**
 * The deadline for a PINNED attempt that has a discoverable fallback behind it.
 *
 * Shorter than the full ceremony deadline on purpose: this attempt is only
 * waiting to find out whether the platform will show anything at all, and a
 * platform that is going to show its sheet shows it immediately. Long enough
 * that a member who did get a sheet and is working through a biometric is not
 * cut off; if they are slower than this the fallback simply reopens a chooser,
 * which is a re-prompt rather than a failure.
 */
export const PINNED_CEREMONY_TIMEOUT_MS = 30_000

/**
 * Run a credential ceremony with a deadline. The AbortController is what
 * actually ends it — the WebAuthn `timeout` field is only a hint the platform
 * may ignore, which is precisely the failure being guarded against — and the
 * abort is distinguished from a member's own cancellation so the error can
 * tell the truth about which happened.
 */
async function withCeremonyDeadline(run, {
  timeoutMs = CEREMONY_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // THE SIGNAL IS WEB-ONLY. The native adapter exists to absorb JSON-clone
  // hazards across the Capacitor boundary (a Uint8Array PRF salt is mangled by
  // the plugin's own `JSON.parse(JSON.stringify(...))`); an AbortSignal is not
  // serializable at all and could fail the call outright. It is a courtesy in
  // any case — the deadline is enforced by the race, not by the abort — so on
  // native the key is omitted entirely rather than sent as undefined.
  abortable = getRuntime() === RUNTIMES.WEB,
} = {}) {
  const controller = abortable && typeof AbortController === 'function' ? new AbortController() : undefined
  let timer

  // RACED, not merely aborted. Aborting asks the platform to stop and trusts it
  // to reject — but a platform that never answered the ceremony is exactly one
  // that may never answer the abort either, and then the promise is still
  // pending and nothing has been fixed. The deadline therefore rejects on its
  // own account; the abort is a courtesy sent alongside it.
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimer(() => {
      try {
        controller?.abort()
      } catch {
        // An abort the platform refuses changes nothing — the race is already lost to us.
      }
      reject(new CeremonyUnanswered())
    }, timeoutMs)
  })

  const running = run({ signal: controller?.signal, timeoutMs })
  // The deadline may win while the ceremony rejects later; that late rejection
  // is expected and must not surface as an unhandled one.
  Promise.resolve(running).catch(() => {})

  try {
    return await Promise.race([running, deadline])
  } finally {
    clearTimer(timer)
  }
}

/** Map raw WebAuthn/DOM exceptions onto the typed taxonomy. */
function mapCeremonyError(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return new CeremonyCancelled()
  if (err?.name === 'NotSupportedError' || err?.name === 'SecurityError') {
    return new AuthenticatorUnavailable(err.message || err.name)
  }
  return err
}

/**
 * Which credential manager runs the ceremony. Web: the browser's own —
 * byte-identical to the pre-102 path. Native: the platform bridge, offered
 * ONLY when the runtime seam confirms the plugin (an honest
 * AuthenticatorUnavailable with the seam's reason otherwise, never a dead
 * ceremony against a WebView API that is not there).
 */
function resolveCredentialManager() {
  if (getRuntime() === RUNTIMES.WEB) return globalThis.navigator?.credentials
  const capability = nativeCapability(NATIVE_CAPABILITIES.PASSKEY_CEREMONY)
  if (capability.state !== 'available') throw new AuthenticatorUnavailable(capability.reason)
  return nativeCredentialManager()
}

/**
 * Capability detection (FR-004). Returns:
 *   { available: boolean, reason?: string, platformAuthenticator?: boolean }
 * `reason` is user-displayable ("this browser doesn't support passkeys").
 */
export async function detectCapability(env = globalThis) {
  // Native runtime: the WebView's own WebAuthn objects are irrelevant — the
  // platform bridge is the ceremony, and the seam's three-state answer is the
  // honest capability (spec 102, contract §2).
  if (getRuntime() !== RUNTIMES.WEB) {
    const capability = nativeCapability(NATIVE_CAPABILITIES.PASSKEY_CEREMONY)
    return capability.state === 'available'
      ? { available: true, platformAuthenticator: true }
      : { available: false, reason: capability.reason }
  }
  const pk = env?.window?.PublicKeyCredential ?? env?.PublicKeyCredential
  if (!pk || !(env?.navigator?.credentials ?? env?.window?.navigator?.credentials)) {
    return { available: false, reason: 'This browser does not support passkeys.' }
  }
  try {
    const platformAuthenticator = await pk.isUserVerifyingPlatformAuthenticatorAvailable()
    if (!platformAuthenticator) {
      // Cross-device (hybrid) passkeys may still work; keep the option but note it.
      return { available: true, platformAuthenticator: false }
    }
    return { available: true, platformAuthenticator: true }
  } catch {
    return { available: false, reason: 'Passkey support could not be confirmed on this device.' }
  }
}

/** Local, non-authoritative record of credentials created/used on this browser. */
export function knownCredentials(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage.getItem(CREDENTIALS_KEY) || '[]')
  } catch {
    return []
  }
}

export function rememberCredential(entry, storage = globalThis.localStorage) {
  const list = knownCredentials(storage).filter((c) => c.credentialId !== entry.credentialId)
  list.push({ ...entry, updatedAt: Date.now() })
  storage.setItem(CREDENTIALS_KEY, JSON.stringify(list))
}

/**
 * Merge-update a credential record by credentialId (spec 045, FR-005).
 * Unlike rememberCredential (which replaces the whole entry), this never
 * drops fields the partial update doesn't carry — in particular `publicKey`,
 * which cannot be recovered from an assertion ceremony. Sign-in uses this to
 * keep the book transact-complete without needing the key again.
 */
export function upsertCredential(partial, storage = globalThis.localStorage) {
  if (!partial?.credentialId) return
  const list = knownCredentials(storage)
  const existing = list.find((c) => c.credentialId === partial.credentialId)
  const merged = { ...existing, ...stripUndefined(partial), updatedAt: Date.now() }
  const rest = list.filter((c) => c.credentialId !== partial.credentialId)
  rest.push(merged)
  storage.setItem(CREDENTIALS_KEY, JSON.stringify(rest))
  return merged
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null))
}

/**
 * A record can back transactions only when the ceremony can be pinned to a
 * credential AND the P-256 key is known (the WebAuthn owner needs both).
 * Records failing this are legacy/partial writes; the signing layer refuses
 * them with a plain-language error instead of crashing inside the signer.
 */
export function isTransactComplete(record) {
  return Boolean(record?.credentialId && record?.publicKey?.x && record?.publicKey?.y)
}

export function forgetCredential(credentialId, storage = globalThis.localStorage) {
  const list = knownCredentials(storage).filter((c) => c.credentialId !== credentialId)
  storage.setItem(CREDENTIALS_KEY, JSON.stringify(list))
}

/**
 * Duplicate-signup steering (edge case): true when this browser already knows
 * a FairWins credential — the UI should steer to sign-in, keeping an explicit
 * "create another account" escape hatch.
 */
export function hasExistingCredential(storage = globalThis.localStorage) {
  return knownCredentials(storage).length > 0
}

/**
 * How a saved passkey should be labelled in the PLATFORM's own list (Google
 * Password Manager, iCloud Keychain, a browser's passkey settings).
 *
 * Every FairWins passkey used to be created as "FairWins account", so a member
 * with four of them saw four identical rows and had to guess. The account
 * address is the only thing that tells them apart, and it is public, so it is
 * what goes in the name.
 */
export function passkeyAccountNames(address) {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`
  // Platforms differ on which field they render as the row's title, so BOTH
  // carry the address — whichever one is shown, the member can tell them apart.
  return { name: short, displayName: `FairWins · ${short}` }
}

/**
 * Ask the platform to rename a saved passkey to the account it actually signs
 * for. Best-effort and COSMETIC: it never throws and never blocks sign-in, and
 * it reports why when it could not run rather than pretending it did.
 *
 * Why it happens after the ceremony rather than during it: the address is
 * derived from the public key the ceremony produces, so at `credentials.create`
 * time there is nothing truthful to name the passkey. `signalCurrentUserDetails`
 * exists for exactly this and is keyed by the user handle — which is why
 * createCredential now keeps it, and why getAssertion surfaces it so a passkey
 * created before any of this can still be healed on its next sign-in.
 */
export async function nameCredentialForAccount({ userId, address, deps = {} } = {}) {
  if (!userId || !address) return { updated: false, reason: 'no user handle or address to name with' }

  const PK = deps.PublicKeyCredential ?? globalThis.PublicKeyCredential
  const signal = PK?.signalCurrentUserDetails
  if (typeof signal !== 'function') {
    return { updated: false, reason: 'this platform cannot rename a saved passkey' }
  }

  const rpId = deps.rpId ?? globalThis.location?.hostname
  if (!rpId) return { updated: false, reason: 'no relying party id in this context' }

  try {
    await signal.call(PK, { rpId, userId, ...passkeyAccountNames(address) })
    return { updated: true }
  } catch (err) {
    // A rename failing must never cost a member their sign-in.
    return { updated: false, reason: err?.message || String(err) }
  }
}

const b64url = (buf) => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Create a new passkey (WebAuthn registration ceremony) for account sign-up.
 * Requests the PRF extension (FR-012) and a platform authenticator with user
 * verification. Returns { credentialId, publicKey: {x, y}, prfCapable, label }.
 *
 * `deps` is injectable for tests: { credentials, rpId }.
 */
export async function createCredential({ label, userName = 'FairWins account', timeoutMs, deps = {} } = {}) {
  const credentials = deps.credentials ?? resolveCredentialManager()
  if (!credentials) throw new AuthenticatorUnavailable('no credential manager in this context')

  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = crypto.getRandomValues(new Uint8Array(16))

  let cred
  try {
    cred = await withCeremonyDeadline(({ signal, timeoutMs: ms }) => credentials.create({
      ...(signal ? { signal } : {}),
      publicKey: {
        timeout: ms,
        rp: { name: RP_NAME, ...(deps.rpId ? { id: deps.rpId } : {}) },
        user: { id: userId, name: userName, displayName: userName },
        challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256 only
        authenticatorSelection: {
          residentKey: 'required', // discoverable: sign-in without typing anything
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: new Uint8Array(32) } } },
      },
    }), { timeoutMs, ...(deps.timers || {}) })
  } catch (err) {
    throw mapCeremonyError(err)
  }
  if (!cred) throw new CeremonyCancelled()

  const response = cred.response
  // P-256 public key: prefer the standard getPublicKey() (SPKI DER), whose
  // uncompressed point is the last 65 bytes (0x04 || x || y).
  const spki = new Uint8Array(response.getPublicKey())
  const point = spki.slice(-65)
  if (point[0] !== 0x04) throw new AuthenticatorUnavailable('unexpected public key encoding')
  const toHex = (u8) => '0x' + Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
  const publicKey = { x: toHex(point.slice(1, 33)), y: toHex(point.slice(33, 65)) }

  const ext = cred.getClientExtensionResults?.() ?? {}
  const prfCapable = Boolean(ext.prf?.enabled ?? ext.prf?.results)

  // The user handle is KEPT, not discarded. It is the only key the platform
  // accepts for renaming a saved passkey later (`signalCurrentUserDetails`),
  // and the account address it will name does not exist yet — it is derived
  // from the public key this ceremony just produced.
  const entry = {
    credentialId: cred.id,
    publicKey,
    prfCapable,
    label: label || 'This device',
    userId: b64url(userId),
  }
  return entry
}

/**
 * Run an assertion (WebAuthn "get") ceremony over a 32-byte challenge.
 * When `credentialId` is set the request pins that credential. When unpinned,
 * every credential in the local book is offered via `allowCredentials` so the
 * platform MUST present a chooser — Brave/Chromium silently assert the first
 * discoverable credential on a bare request, which locked users out of all
 * but their first account (spec 045, US3). Only a browser with no local book
 * (fresh device) falls back to the bare discoverable-credential request.
 *
 * `discoverable: true` deliberately skips the local-book `allowCredentials`
 * even when the book is non-empty, issuing a bare discoverable request so the
 * platform offers EVERY FairWins passkey on the device — including ones this
 * browser has never recorded (issue #849: "several passkeys on one device").
 * The in-app "Use a different passkey…" escape uses this; the app still never
 * silently guesses because the platform's own chooser makes the pick.
 *
 * `prfSalt` (optional Uint8Array(32)) also evaluates the PRF extension.
 * Returns the raw fields the signing layer needs:
 *   { credentialId, signature, authenticatorData, clientDataJSON, prfOutput? }
 */
export async function getAssertion({ challenge, credentialId, prfSalt, discoverable = false, timeoutMs, deps = {} }) {
  const credentials = deps.credentials ?? resolveCredentialManager()
  if (!credentials) throw new AuthenticatorUnavailable('no credential manager in this context')

  const pinnedIds = credentialId
    ? [credentialId]
    : discoverable
      ? []
      : (deps.knownCredentials ?? knownCredentials)(deps.storage).map((c) => c.credentialId)
  const allowCredentials = []
  for (const id of pinnedIds) {
    try {
      if (id) allowCredentials.push({ type: 'public-key', id: base64urlToBytes(id) })
    } catch {
      // Malformed stored id — skip rather than abort the whole ceremony.
    }
  }

  const request = (allow, ms) =>
    withCeremonyDeadline(
      ({ signal, timeoutMs: deadline }) =>
        credentials.get({
          ...(signal ? { signal } : {}),
          publicKey: {
            challenge,
            userVerification: 'required',
            timeout: deadline,
            ...(allow.length ? { allowCredentials: allow } : {}),
            ...(prfSalt ? { extensions: { prf: { eval: { first: prfSalt } } } } : {}),
          },
        }),
      { timeoutMs: ms, ...(deps.timers || {}) }
    )

  // A PINNED REQUEST CAN GO UNANSWERED WHILE A DISCOVERABLE ONE WORKS, and the
  // member cannot tell the difference from a dead button.
  //
  // `allowCredentials` narrows the request to specific credential ids, and the
  // platform routes it only to a provider that holds one of them. On Android a
  // device can have several passkey providers; a credential sitting in one the
  // request is not dispatched to means NO provider claims it, so no sheet
  // appears at all — no prompt, no rejection, nothing to cancel. Observed in
  // the installed PWA, where `create` (never pinned) and "Use a different
  // passkey…" (deliberately unpinned) both work while every pinned request
  // shows nothing.
  //
  // So the pin is an OPTIMISATION, not a requirement: it re-authenticates the
  // exact credential with no second chooser, which is the better experience
  // where it works. When it goes unanswered we ask the platform for its own
  // list instead, and then CHECK WHAT CAME BACK — the pin is what we lose, the
  // guarantee is not.
  let assertion
  try {
    const pinned = allowCredentials.length > 0
    try {
      assertion = await request(allowCredentials, pinned ? PINNED_CEREMONY_TIMEOUT_MS : timeoutMs)
    } catch (err) {
      if (!pinned || !(err instanceof CeremonyUnanswered)) throw err
      assertion = await request([], timeoutMs)
      if (credentialId && assertion?.id && assertion.id !== credentialId) {
        // Only enforceable when the caller named ONE credential. An unpinned
        // fallback from a whole-book request is answered by whichever passkey
        // the member chose, which is exactly what was wanted.
        throw new CredentialMismatch(
          'That is a different passkey from the one you picked. Choose it again, or use "Use a different passkey…".'
        )
      }
    }
  } catch (err) {
    throw mapCeremonyError(err)
  }
  if (!assertion) throw new CeremonyCancelled()

  const ext = assertion.getClientExtensionResults?.() ?? {}
  const prfOutput = ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : undefined

  return {
    credentialId: assertion.id,
    signature: new Uint8Array(assertion.response.signature),
    authenticatorData: new Uint8Array(assertion.response.authenticatorData),
    clientDataJSON: new Uint8Array(assertion.response.clientDataJSON),
    prfOutput,
    // Present for a discoverable credential; it is what names this passkey in
    // the platform's own list (see nameCredentialForAccount). Passkeys created
    // before that naming existed have no stored userId, so recovering it from
    // the assertion is what lets them be healed on sign-in.
    userHandle: assertion.response.userHandle ? b64url(assertion.response.userHandle) : undefined,
  }
}

export function base64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export { b64url as bytesToBase64url }
