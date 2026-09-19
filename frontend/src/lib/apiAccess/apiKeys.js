/**
 * Member API keys (spec 095) — grant building, revocation building, and the local metadata store.
 *
 * A key is a MEMBER-SIGNED CAPABILITY, not a server record. The gateway stores nothing to issue one:
 * the member signs an `ApiKeyGrant` under the off-chain `FairWins Member API` domain, and the
 * resulting `fw1.…` token IS the credential. Two consequences shape this whole module:
 *
 *   1. **Creation works with the gateway down.** Signing is local. A member can mint a key, copy it,
 *      and paste it into an agent while the relay gateway is unreachable — only introspection
 *      (`/v1/member/me`) and revocation REGISTRATION need the network. The panel says so rather than
 *      disabling the button.
 *   2. **The token is never stored.** It is assembled, shown once, and dropped. What persists is
 *      METADATA — key id, label, scopes, window — which is what lets the member see which keys they
 *      minted and revoke one by id. `recordApiKey` builds its record field by field from an explicit
 *      whitelist precisely so a token cannot reach storage by being passed in an extra property.
 *
 * The struct tables and the domain come from `@fairwins/intent-types` and are NEVER redefined here:
 * the signer (this file) and the verifier (the gateway) must agree byte-for-byte, and a local copy
 * is exactly the drift spec 075 exists to remove. A mismatch would not fail loudly — it would mint
 * a token every request rejects while the member watches.
 *
 * STORAGE: wallet-scoped `userStorage` key `api_access_keys`, localStorage (constraint: a
 * wallet-scoped preference must pass `useLocalStorage = true`; the default is sessionStorage).
 * It is DELIBERATELY ABSENT from `lib/backup/syncedObjects.js` — a key is a credential bound to one
 * gateway's live revocation set, and its metadata names credentials that may be live on other
 * devices. The same call was made for `network_endpoints` (spec 069). A test asserts the absence.
 */
import { toHex } from 'viem'
import { getAddress, isAddress } from '../evm/address'
import {
  MEMBER_API_DOMAIN,
  MEMBER_API_GRANT_TYPES,
  MEMBER_API_REVOCATION_TYPES,
  canonicalScopeString,
} from '@fairwins/intent-types'
import { getUserPreference, saveUserPreference } from '../../utils/userStorage'

export { canonicalScopeString }

/** Wallet-scoped storage key holding key METADATA (never a token). */
export const API_KEYS_STORAGE_KEY = 'api_access_keys'

/** Upper bound on retained metadata records — a list, not an archive. Oldest are dropped first. */
export const MAX_STORED_KEYS = 50

/**
 * Scopes v1, mirroring `SCOPES` in services/relay-gateway/src/memberApi/contract.js.
 *
 * There is no `write:` scope of any kind, and that absence is the design: the only rail the API
 * offers for an action is "here is the typed data, YOU sign it", followed by the existing public
 * relay. A scope that authorised a write would claim the gateway can act as the member.
 */
export const API_SCOPES = Object.freeze([
  Object.freeze({
    id: 'read:profile',
    label: 'Read this key',
    description: 'Which account and key the token belongs to, its scopes and expiry.',
    defaultOn: true,
  }),
  Object.freeze({
    id: 'read:membership',
    label: 'Read membership',
    description: 'Your membership tier and expiry on the membership reference chain.',
    defaultOn: true,
  }),
  Object.freeze({
    id: 'read:wagers',
    label: 'Read wagers',
    description: 'The wagers this account is a party to, per chain.',
    defaultOn: true,
  }),
  Object.freeze({
    id: 'read:fees',
    label: 'Read fee rates',
    description: 'The live platform fee rates the FeeRouter publishes.',
    defaultOn: true,
  }),
  Object.freeze({
    id: 'build:intents',
    label: 'Build unsigned transactions',
    description:
      'Prepare EIP-712 typed data for a platform action. Signing stays with you — this never submits anything.',
    defaultOn: false,
  }),
  Object.freeze({
    id: 'assistant:chat',
    label: 'Talk to the assistant',
    description: 'Send messages to the FairWins assistant. It answers questions; it never signs or submits.',
    defaultOn: false,
  }),
])

/** Every scope id, ascending — the order `canonicalScopeString` produces. */
export const ALL_SCOPE_IDS = Object.freeze(API_SCOPES.map((s) => s.id).sort())

/** Expiry choices offered at creation, in days. */
export const EXPIRY_CHOICES_DAYS = Object.freeze([7, 30, 90])

/**
 * The longest lifetime the gateway's default configuration accepts (`MEMBER_API_MAX_TTL_DAYS`).
 * Signing a longer grant is not refused locally — the gateway is the authority — but the panel
 * never OFFERS one, because a key that mints cleanly and then fails every request is worse than a
 * shorter key.
 */
export const MAX_TTL_DAYS = 90

const DAY_SECONDS = 86_400
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/

/** A fresh random 32-byte key id. An identifier, not a secret: revocations name it, `/me` echoes it. */
export function randomKeyId() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Build the grant a member signs.
 *
 * @param {{account: string, keyId?: string, scopes: string[], ttlDays: number, label?: string, nowSeconds?: number}} args
 * @returns {{v: 1, account: string, keyId: string, scopes: string[], issuedAt: number, expiresAt: number, label: string}}
 */
export function buildGrant({ account, keyId, scopes, ttlDays, label = '', nowSeconds }) {
  if (!isAddress(account ?? '')) throw new Error('buildGrant: account must be a 0x address')
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('buildGrant: at least one scope is required')
  const unknown = scopes.filter((s) => !ALL_SCOPE_IDS.includes(s))
  if (unknown.length > 0) throw new Error(`buildGrant: unknown scope(s): ${unknown.join(', ')}`)
  const days = Number(ttlDays)
  if (!Number.isFinite(days) || days <= 0) throw new Error('buildGrant: ttlDays must be a positive number')
  if (days > MAX_TTL_DAYS) throw new Error(`buildGrant: ttlDays exceeds the ${MAX_TTL_DAYS}-day maximum`)

  const issuedAt = Math.floor(nowSeconds != null ? nowSeconds : Date.now() / 1000)
  // Scopes are stored SORTED so the record, the signing prompt and the token all read the same.
  const sorted = canonicalScopeString(scopes).split(' ')
  return {
    v: 1,
    account: getAddress(account),
    keyId: keyId || randomKeyId(),
    scopes: sorted,
    issuedAt,
    expiresAt: issuedAt + Math.round(days * DAY_SECONDS),
    label: String(label || '').slice(0, 120),
  }
}

/**
 * The EIP-712 payload for a grant. `scopes` collapses to ONE canonical line — sorted, de-duplicated,
 * single-space separated — because a wallet renders a dynamic array unpredictably and some render
 * it not at all, so a member approving an array may be shown nothing about what the key can do.
 */
export function grantTypedData(grant) {
  return {
    domain: { ...MEMBER_API_DOMAIN },
    types: MEMBER_API_GRANT_TYPES,
    primaryType: 'ApiKeyGrant',
    message: {
      account: grant.account,
      keyId: grant.keyId,
      scopes: canonicalScopeString(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
    },
  }
}

/**
 * Build the revocation struct + its EIP-712 payload.
 *
 * SELF-AUTHORIZING: the gateway needs no bearer token to accept this, because the situation you
 * revoke in is usually "the token got out" — requiring the leaked credential to withdraw the leaked
 * credential would be the wrong shape.
 */
export function buildRevocation({ account, keyId, nowSeconds }) {
  if (!isAddress(account ?? '')) throw new Error('buildRevocation: account must be a 0x address')
  if (!BYTES32_RE.test(keyId ?? '')) throw new Error('buildRevocation: keyId must be 32 bytes of hex')
  return {
    account: getAddress(account),
    keyId,
    revokedAt: Math.floor(nowSeconds != null ? nowSeconds : Date.now() / 1000),
  }
}

export function revocationTypedData(revocation) {
  return {
    domain: { ...MEMBER_API_DOMAIN },
    types: MEMBER_API_REVOCATION_TYPES,
    primaryType: 'ApiKeyRevocation',
    message: { ...revocation },
  }
}

/** The exact body `POST /v1/member/keys/revoke` expects. */
export function revocationRequestBody(revocation, signature) {
  return { revocation: { ...revocation }, signature }
}

// ---------------------------------------------------------------------------
// Metadata store — wallet-scoped, localStorage, NEVER a token.
// ---------------------------------------------------------------------------

/**
 * Coerce one stored entry into a record, or null. A foreign shape is DROPPED rather than trusted:
 * this list decides which key ids a revoke button names, and a malformed entry there would have the
 * member sign a revocation for something that is not their key.
 */
function toRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!BYTES32_RE.test(raw.keyId ?? '')) return null
  if (!Array.isArray(raw.scopes)) return null
  const scopes = raw.scopes.filter((s) => typeof s === 'string' && ALL_SCOPE_IDS.includes(s))
  if (scopes.length === 0) return null
  const issuedAt = Number(raw.issuedAt)
  const expiresAt = Number(raw.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= 0) return null
  const revokedAt = Number(raw.revokedAt)
  return {
    keyId: raw.keyId,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 120) : '',
    scopes: [...scopes].sort(),
    issuedAt,
    expiresAt,
    revokedAt: Number.isFinite(revokedAt) && revokedAt > 0 ? revokedAt : null,
    // Tri-state, carried through the sanitizer deliberately: `false` means the member signed a
    // withdrawal the gateway never heard (rendered "revocation signed — not delivered"), `true`
    // means it was registered, and `null` (records written before the flag existed) reads as
    // delivered so old notes keep their meaning. Dropping this field here silently promoted every
    // undelivered revocation to a plain "revoked" — the exact claim the flag exists to prevent.
    revocationDelivered:
      raw.revocationDelivered === false ? false : raw.revocationDelivered === true ? true : null,
  }
}

function writeAll(account, records) {
  saveUserPreference(account, API_KEYS_STORAGE_KEY, records.slice(-MAX_STORED_KEYS), true)
}

/**
 * Every key this device knows this account minted, newest first — as metadata RECORDS
 * (`{keyId, label, scopes, issuedAt, expiresAt, revokedAt, revocationDelivered}`), which is the
 * whole point of the name: the tokens themselves are shown once at minting and never stored, so a
 * function that could "list API keys" cannot exist here. (The old name claimed otherwise, and
 * CodeQL's credential-name heuristic agreed with the claim — flagging every write of this metadata
 * to localStorage as clear-text credential storage. The rename is the honest fix, not a dodge:
 * the data really is non-sensitive, and now the name says so.)
 * Returns `[]` for a missing account — this is a local list, so "no wallet" genuinely is "no list".
 */
export function listKeyRecords(account) {
  if (!account) return []
  const raw = getUserPreference(account, API_KEYS_STORAGE_KEY, [], true)
  if (!Array.isArray(raw)) return []
  const records = raw.map(toRecord).filter(Boolean)
  return records.slice().sort((a, b) => b.issuedAt - a.issuedAt)
}

/**
 * Persist the METADATA of a key that was just minted. Built field by field from the grant — there is
 * no path by which a token, a signature, or any other property of the caller's object is written.
 *
 * @returns {object} the stored record
 */
export function recordApiKey(account, grant) {
  const record = toRecord({
    keyId: grant.keyId,
    label: grant.label,
    scopes: grant.scopes,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    revokedAt: null,
  })
  if (!account || !record) throw new Error('recordApiKey: an account and a well-formed grant are required')
  const existing = listKeyRecords(account).filter((r) => r.keyId !== record.keyId)
  writeAll(account, [...existing.slice().sort((a, b) => a.issuedAt - b.issuedAt), record])
  return record
}

/**
 * Mark a key revoked locally. This is a NOTE, not a revocation: the authority is the gateway's own
 * in-process set, which does not survive a restart. The panel says both things.
 */
export function markApiKeyRevoked(account, keyId, revokedAt, { delivered = true } = {}) {
  if (!account) return
  const at = Math.floor(Number(revokedAt) || Date.now() / 1000)
  const next = listKeyRecords(account)
    .map((r) =>
      r.keyId === keyId
        ? {
            ...r,
            revokedAt: r.revokedAt ?? at,
            // Once a revocation has reached the gateway it stays delivered; an undelivered signing
            // is recorded as such so the list never claims the gateway agrees when it might not.
            revocationDelivered: r.revocationDelivered === true || delivered === true,
          }
        : r,
    )
    .sort((a, b) => a.issuedAt - b.issuedAt)
  writeAll(account, next)
}

/** Forget a key's metadata on this device. Does not (and cannot) un-issue the grant. */
export function forgetApiKey(account, keyId) {
  if (!account) return
  const next = listKeyRecords(account)
    .filter((r) => r.keyId !== keyId)
    .sort((a, b) => a.issuedAt - b.issuedAt)
  writeAll(account, next)
}

/**
 * Lifecycle for display: 'revoked' | 'revocation-signed' | 'expired' | 'active'.
 * 'revocation-signed' means the member signed the withdrawal but it never reached the gateway —
 * the grant may still be honoured there, and rendering it as plain "revoked" would claim
 * agreement the gateway has not given. Records written before the flag existed (no
 * `revocationDelivered` field) keep reading as 'revoked'.
 */
export function keyState(record, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (record?.revokedAt) return record?.revocationDelivered === false ? 'revocation-signed' : 'revoked'
  if (Number(record?.expiresAt) <= nowSeconds) return 'expired'
  return 'active'
}

/** Member-facing wording for a `keyState` value. */
export function keyStateLabel(state) {
  return state === 'revocation-signed' ? 'revocation signed — not delivered' : state
}

/** Short display form of a key id — enough to tell two keys apart, never a secret. */
export function shortKeyId(keyId) {
  const value = String(keyId || '')
  return value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value
}
