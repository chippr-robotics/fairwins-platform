/**
 * Capability-token authentication for the member API (spec 095).
 *
 * Contract: specs/095-member-api-agentic-access/contracts/member-api.md.
 *
 * WHAT A TOKEN IS
 *   fw1.<base64url(grantJSON)>.<base64url(signatureBytes)>       in `Authorization: Bearer …`
 *
 * grantJSON is `{ v, account, keyId, scopes, issuedAt, expiresAt, label }`, and the member's
 * signature is over the `ApiKeyGrant` struct from @fairwins/intent-types under the off-chain
 * `FairWins Member API` domain. `label` is display-only and is NOT in the signed struct, so a
 * renamed key needs no new signature and a label can never widen what a token permits.
 *
 * THE GATEWAY STORES NOTHING TO ISSUE ONE. That is the design, not a limitation: this service holds
 * no per-member state (no volume, single instance, every store in it is an in-process Map), so a
 * server-side key table would be a durability claim it cannot honour. A member-signed capability
 * needs no table — the signature IS the record. What that costs is revocation durability, and the
 * API says so out loud on every revocation answer rather than implying otherwise.
 *
 * THE ORDER OF THE SIX CHECKS IS DELIBERATE (constraint: cheapest and most-certain first, and never
 * report a stronger verdict than the evidence supports):
 *   1. parse + window + TTL cap — pure arithmetic on bytes the caller supplied.
 *   2. signature: ECDSA recovery, then ERC-1271 on the reference chain for contract accounts.
 *   3. revocation — an in-process fact.
 *   4. membership — a chain read, cached.
 *   5. sanctions — a chain read, fail-closed, reusing policy/sanctions.js unchanged.
 *   6. scope — pure, but LAST, because "you lack this scope" is information about a token we have
 *      not yet finished trusting, and answering it before the signature check would let an
 *      unsigned grant enumerate the API.
 *
 * THREE VERDICTS ON THE SIGNATURE, NEVER TWO (spec-084 precedent). A contract account — a passkey
 * member — has no public key, so ECDSA recovery does not produce their address and only the account
 * itself can say whether it stands behind the bytes. When that call cannot be made because the
 * chain is unreachable, the answer is UNKNOWN and this module answers 503 `auth_unverifiable`.
 * Answering 401 there would tell a member their own key is forged because our RPC was slow.
 */
import { ethers } from 'ethers'
import { MEMBER_API_DOMAIN, MEMBER_API_GRANT_TYPES, MEMBER_API_REVOCATION_TYPES, canonicalScopeString } from '@fairwins/intent-types'
import { GatewayError } from '../errors.js'
import { ALL_SCOPES, TOKEN_PREFIX } from './contract.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const DAY_SEC = 86_400

/** Longest token we will even attempt to parse. A grant is a few hundred bytes; nothing legitimate is large. */
const MAX_TOKEN_BYTES = 8192
/** Longest display label we will echo back. Never verified, never trusted, never unbounded. */
const MAX_LABEL_CHARS = 120

const ERC1271_IFACE = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const ERC1271_MAGIC = '0x1626ba7e'

const b64urlDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

const invalid = (reason) => new GatewayError(401, 'invalid_token', reason)

/**
 * Parse and structurally validate a token. Never touches the network.
 *
 * Everything here is a statement about BYTES THE CALLER SUPPLIED, so it is all `invalid_token` —
 * no part of it says anything about whether the member authorised anything.
 *
 * @param {string} raw the value of the Authorization header, with or without the `Bearer ` prefix
 * @returns {{grant: object, signature: string, scopeString: string}}
 */
export function parseToken(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw invalid('missing bearer token')
  const bearer = raw.startsWith('Bearer ') || raw.startsWith('bearer ') ? raw.slice(7).trim() : raw.trim()
  if (Buffer.byteLength(bearer, 'utf8') > MAX_TOKEN_BYTES) throw invalid('bearer token is implausibly large')

  const parts = bearer.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw invalid(`token must be "${TOKEN_PREFIX}.<base64url grant>.<base64url signature>"`)
  }

  let grant
  try {
    grant = JSON.parse(b64urlDecode(parts[1]).toString('utf8'))
  } catch {
    throw invalid('the grant segment is not base64url-encoded JSON')
  }
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) throw invalid('the grant must be a JSON object')
  if (grant.v !== 1) throw invalid('unsupported grant version; this gateway understands v1')
  if (!ADDRESS_RE.test(grant.account ?? '')) throw invalid('grant.account must be a 0x-prefixed 20-byte hex address')
  if (!BYTES32_RE.test(grant.keyId ?? '')) throw invalid('grant.keyId must be 32 bytes of hex')
  if (!Number.isInteger(grant.issuedAt) || grant.issuedAt < 0) throw invalid('grant.issuedAt must be a unix timestamp in seconds')
  if (!Number.isInteger(grant.expiresAt) || grant.expiresAt <= 0) throw invalid('grant.expiresAt must be a unix timestamp in seconds')
  if (!Array.isArray(grant.scopes) || grant.scopes.length === 0) throw invalid('grant.scopes must be a non-empty array')
  if (grant.label != null && (typeof grant.label !== 'string' || grant.label.length > MAX_LABEL_CHARS)) {
    throw invalid(`grant.label must be a string of at most ${MAX_LABEL_CHARS} characters`)
  }
  const unknown = grant.scopes.filter((s) => !ALL_SCOPES.includes(s))
  if (unknown.length > 0) {
    // Refused rather than ignored: silently dropping an unknown scope would hand back a token that
    // reads as narrower than the member was shown when they signed it.
    throw invalid(`unknown scope(s): ${unknown.join(', ')}. This gateway serves: ${ALL_SCOPES.join(', ')}`)
  }

  let scopeString
  try {
    scopeString = canonicalScopeString(grant.scopes)
  } catch (e) {
    throw invalid(String(e?.message ?? 'grant.scopes is not canonicalisable'))
  }

  let signature
  try {
    signature = ethers.hexlify(b64urlDecode(parts[2]))
  } catch {
    throw invalid('the signature segment is not base64url')
  }
  if (signature === '0x') throw invalid('the signature segment is empty')

  return { grant, signature, scopeString }
}

/** The exact EIP-712 message the member signed. Derived, never taken from the wire. */
export function grantMessage(grant, scopeString) {
  return {
    account: grant.account,
    keyId: grant.keyId,
    scopes: scopeString,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  }
}

/**
 * Verify an EIP-712 signature by `account`, three-valued.
 *
 * `'valid'`        — ECDSA recovered the account, or the account's own contract returned the
 *                    ERC-1271 magic value.
 * `'invalid'`      — recovery produced someone else AND the account answered the question with
 *                    something other than the magic value. Note an EOA answers an eth_call with
 *                    `0x`, which is the account declining to endorse the bytes; combined with a
 *                    non-matching recovery that is knowably invalid.
 * `'unverifiable'` — the ERC-1271 call could NOT BE MADE (no provider, or the node errored). This
 *                    is not a negative. It is exactly what a legitimate smart-account signature
 *                    looks like from outside when the chain is unreachable.
 *
 * @returns {Promise<'valid'|'invalid'|'unverifiable'>}
 */
export async function verifyTypedSignature({ provider, account, types, message, signature }) {
  const domain = { ...MEMBER_API_DOMAIN }
  try {
    const recovered = ethers.verifyTypedData(domain, types, message, signature)
    if (recovered.toLowerCase() === String(account).toLowerCase()) return 'valid'
  } catch {
    // A malformed signature cannot ECDSA-recover; a contract account may still endorse it, so this
    // falls through to the 1271 leg rather than short-circuiting to invalid.
  }
  if (!provider) return 'unverifiable'
  const digest = ethers.TypedDataEncoder.hash(domain, types, message)
  try {
    const data = ERC1271_IFACE.encodeFunctionData('isValidSignature', [digest, signature])
    const ret = await provider.call({ to: account, data })
    if (typeof ret === 'string' && ret.length >= 10 && ret.slice(0, 10).toLowerCase() === ERC1271_MAGIC) return 'valid'
    return 'invalid'
  } catch {
    return 'unverifiable'
  }
}

/**
 * Verify a member-signed `ApiKeyRevocation` body. Same three verdicts, same reasons.
 *
 * @returns {Promise<{account: string, keyId: string, revokedAt: number}>}
 * @throws {GatewayError} 400 bad_request | 401 invalid_token | 503 auth_unverifiable
 */
export async function verifyRevocation({ provider, body, now = () => Math.floor(Date.now() / 1000), clockSkewSec = 300 }) {
  const rev = body?.revocation
  const signature = body?.signature
  if (!rev || typeof rev !== 'object') throw new GatewayError(400, 'bad_request', 'body.revocation is required')
  if (!ADDRESS_RE.test(rev.account ?? '')) throw new GatewayError(400, 'bad_request', 'revocation.account must be an address')
  if (!BYTES32_RE.test(rev.keyId ?? '')) throw new GatewayError(400, 'bad_request', 'revocation.keyId must be 32 bytes of hex')
  if (!Number.isInteger(rev.revokedAt) || rev.revokedAt < 0) {
    throw new GatewayError(400, 'bad_request', 'revocation.revokedAt must be a unix timestamp in seconds')
  }
  // A timestamp far in the future is refused rather than clamped: `revokedAt` is what decides how
  // long the in-process record is kept, so accepting an arbitrary one would let a single request
  // pin a record open past every pruning window.
  if (rev.revokedAt > now() + clockSkewSec) {
    throw new GatewayError(400, 'bad_request', 'revocation.revokedAt is in the future')
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]*$/.test(signature) || signature === '0x') {
    throw new GatewayError(400, 'bad_request', 'body.signature must be a non-empty 0x-prefixed hex signature')
  }

  const message = { account: rev.account, keyId: rev.keyId, revokedAt: rev.revokedAt }
  const verdict = await verifyTypedSignature({
    provider,
    account: rev.account,
    types: MEMBER_API_REVOCATION_TYPES,
    message,
    signature,
  })
  if (verdict === 'unverifiable') {
    throw new GatewayError(
      503,
      'auth_unverifiable',
      'the revocation signature could not be checked because the membership reference chain was unreachable; try again'
    )
  }
  if (verdict === 'invalid') {
    throw new GatewayError(401, 'invalid_signature', 'the revocation is not signed by the account it names')
  }
  return { account: rev.account, keyId: rev.keyId, revokedAt: rev.revokedAt }
}

/**
 * Build the authenticator.
 *
 * @param {object} config full gateway config (reads .memberApi and .chains)
 * @param {{
 *   providers: Record<number, {call: Function}>,
 *   screen: {screen: (chainId: number, account: string) => Promise<void>},
 *   revocations: {isRevoked: Function, durable: boolean},
 *   membership: {read: Function, chainId: number},
 *   quotas: {hit: Function},
 *   now?: () => number,   // unix SECONDS, matching the gateway-wide `now`
 * }} deps
 */
/**
 * Steps 1-3 of `authenticate`, extracted so a caller can establish CONTROL OF AN ACCOUNT without
 * also demanding a paid membership (spec 106, FR-003).
 *
 * WHY THIS EXISTS. `authenticate` answers one question — "may this key call this member-API route?"
 * — and its answer includes an active paid tier (step 4, 403 `membership_required`). That is right
 * for the member API. It is wrong as a general test of who is calling: spec 106 gates order
 * signing, Bitcoin broadcast and marketplace writes, and those need an ANSWERABLE PARTY, not a
 * customer. Reusing `authenticate` there would have made trading require a purchase, silently.
 *
 * So the parse/expiry/signature/revocation core lives here and both callers share it. This is
 * extraction, not duplication, on purpose: a second signature path is exactly the drift this
 * repo's type-parity gates exist to prevent, and the three-verdict rule below is too easy to get
 * subtly wrong twice.
 *
 * THROWS `GatewayError` exactly as before, including the 503/401 split that keeps "unknown" apart
 * from "forged". A contract account (a passkey member) has no public key, so an unreachable chain
 * looks identical to a legitimate smart-account signature — which is why `unverifiable` can never
 * become a denial.
 *
 * @returns {Promise<{grant: object, scopeString: string}>} the verified grant; membership NOT read
 */
export async function verifyGrantCredential({
  authorization,
  referenceProvider,
  revocations,
  clockSkewSec,
  maxTtlDays,
  nowSec,
}) {
  // ---- 1. parse + window + TTL cap (pure) ----------------------------------------------------
  const { grant, signature, scopeString } = parseToken(authorization ?? '')

  if (grant.expiresAt <= nowSec) {
    throw new GatewayError(401, 'token_expired', 'this key has expired; mint a new one in the app')
  }
  if (grant.issuedAt > nowSec + clockSkewSec) {
    throw invalid('grant.issuedAt is in the future')
  }
  const ttlSec = grant.expiresAt - grant.issuedAt
  if (ttlSec > maxTtlDays * DAY_SEC) {
    throw new GatewayError(
      401,
      'token_ttl_exceeded',
      `this key asks for ${Math.ceil(ttlSec / DAY_SEC)} days; this gateway accepts at most ${maxTtlDays}`
    )
  }

  // ---- 2. signature: ECDSA, then ERC-1271 on the reference chain -----------------------------
  const verdict = await verifyTypedSignature({
    provider: referenceProvider,
    account: grant.account,
    types: MEMBER_API_GRANT_TYPES,
    message: grantMessage(grant, scopeString),
    signature,
  })
  if (verdict === 'unverifiable') {
    // NEVER 401 here. Unknown is not forged.
    throw new GatewayError(
      503,
      'auth_unverifiable',
      'this key could not be checked because the membership reference chain was unreachable; try again shortly'
    )
  }
  if (verdict === 'invalid') {
    throw new GatewayError(401, 'invalid_signature', 'the grant is not signed by the account it names')
  }

  // ---- 3. revocation (in-process; honest about it everywhere it surfaces) --------------------
  if (revocations.isRevoked(grant.account, grant.keyId)) {
    throw new GatewayError(401, 'token_revoked', 'this key was revoked on this gateway')
  }

  return { grant, scopeString }
}

export function createMemberAuth(config, { providers, screen, revocations, membership, quotas, now = () => Math.floor(Date.now() / 1000) }) {
  const memberApi = config.memberApi
  const referenceProvider = providers?.[memberApi.referenceChainId] ?? null

  /**
   * Authenticate one request and assert one scope.
   *
   * @param {import('express').Request} req
   * @param {string|null} requiredScope
   * @returns {Promise<{account: string, keyId: string, scopes: string[], issuedAt: number, expiresAt: number, label: string|null, membership: object}>}
   */
  async function authenticate(req, requiredScope) {
    // ---- 1-3. parse, window, TTL cap, signature, revocation -----------------------------------
    // Shared with the spec-105 identity layer via `verifyGrantCredential`. The split is exactly
    // here because everything above establishes CONTROL OF THE ACCOUNT, and everything below adds
    // requirements specific to the member API — a paid tier, a scope, this module's own quota.
    const nowSec = now()
    const { grant } = await verifyGrantCredential({
      authorization: req.get('authorization'),
      referenceProvider,
      revocations,
      clockSkewSec: memberApi.clockSkewSec,
      maxTtlDays: memberApi.maxTtlDays,
      nowSec,
    })

    // ---- 4. membership: active paid tier on the reference chain, three-state -------------------
    const m = await membership.read(grant.account)
    if (m.state !== 'read') {
      // BOTH non-read states are retryable, never a denial. `unreadable` is an outage;
      // `not-configured` means this deployment records no membership contract on the reference
      // chain at all (boot refuses that combination while the module is enabled, so it should be
      // unreachable) — and neither is evidence that the member lacks a membership.
      throw new GatewayError(
        503,
        'membership_unreadable',
        m.state === 'not-configured'
          ? 'this gateway records no membership contract on its reference chain, so membership cannot be established here'
          : 'membership could not be read right now; this is not a decision that you lack one — try again shortly'
      )
    }
    if (!m.active) {
      throw new GatewayError(403, 'membership_required', 'API access needs an active FairWins membership on the reference chain')
    }

    // ---- 5. sanctions screening (fail-closed; the shared screen, unchanged) --------------------
    // Throws 403 sanctioned_signer / 503 screening_unavailable itself.
    await screen.screen(memberApi.referenceChainId, grant.account)

    // ---- 6. scope, then quotas ------------------------------------------------------------------
    if (requiredScope && !grant.scopes.includes(requiredScope)) {
      throw new GatewayError(
        403,
        'insufficient_scope',
        `this key does not carry the "${requiredScope}" scope; mint a key that includes it`
      )
    }

    // Keyed by ACCOUNT, not by IP: `req.ip` is the proxy on the VM deployment (trust proxy is
    // unset), so an IP key would pool every member into one bucket. The account is recovered from a
    // signature we have just verified, which is the strongest key available here.
    const q = quotas.hit(grant.account)
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} member API quota exceeded; retry shortly`, {
        retryAfterSec: q.retryAfterSec,
      })
    }

    return {
      account: grant.account,
      keyId: grant.keyId,
      scopes: [...grant.scopes].sort(),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      label: typeof grant.label === 'string' ? grant.label : null,
      membership: m,
    }
  }

  return { authenticate, referenceChainId: memberApi.referenceChainId }
}
