/**
 * Which account does this passkey control? (spec 104)
 *
 * The seam that replaces the derive-then-sanity-check logic inside
 * `connectors/passkey.js#resolveAccountForCredential`. The distinction it exists to make is
 * between an address the chain CONFIRMED and an address we computed and hoped for: the old code
 * derived an address on the assumption that the key was the account's sole initial owner and,
 * when that address turned out to hold no contract, returned it anyway — signing a member who had
 * lost their device into a brand-new empty account with nothing said.
 *
 * So the return type carries a value in exactly ONE of its four shapes. Three of the four
 * constructors below take no address at all, which is what makes "return the derived one anyway"
 * impossible rather than merely discouraged — the same device as spec 089's `reading.js` (one of
 * three constructors takes a number) and spec 071's estate reads.
 *
 * Reads go through the spec-069 endpoint seam, so a member's own RPC applies. That matters more
 * here than almost anywhere: recovery is read-heavy, and an `unverified` that the member's working
 * endpoint would have turned into `resolved` is a member turned away for no reason.
 */

import { publicKeyToOwnerBytes, readControllers, computeAccountAddress } from './smartAccount'

/** Default bound on the whole resolution. Expiry yields `unverified`, never `none-found`. */
export const RESOLUTION_DEADLINE_MS = 20_000

/**
 * How many creation nonces leg A enumerates (spec 104 T-103).
 *
 * The factory salts an account with `keccak(owners, nonce)`, so one key produces a DIFFERENT
 * address at each nonce. Release 1 checked nonce 0 only, which finds an account only when the
 * member's first creation attempt succeeded — a member whose first attempt reverted and who
 * retried holds an account at nonce 1 that the resolver could not see, and was told `none-found`.
 *
 * 8 comes from research.md's leg-A costing (N × getCode, N ≈ 8). It is a bound on a SEARCH, not a
 * limit on what may exist: a member with an account past it gets `none-found`, whose wording
 * already sends them to the address path. Raising it costs one `getCode` per nonce.
 */
export const NONCE_SCAN_LIMIT = 8

export const OUTCOMES = Object.freeze({
  RESOLVED: 'resolved',
  NONE_FOUND: 'none-found',
  UNVERIFIED: 'unverified',
  NOT_CONTROLLER: 'not-controller',
})

/**
 * The one place an address may enter a result.
 * @param {Array<{address: string, ownerIndex: number, chainId: number}>} accounts 1..n
 */
export function resolved(accounts) {
  return { outcome: OUTCOMES.RESOLVED, accounts }
}

/** The chain was read and nothing on it lists this key. */
export function noneFound(reason) {
  return { outcome: OUTCOMES.NONE_FOUND, reason }
}

/**
 * The chain could NOT be read. Deliberately not `none-found`: an unreachable chain is not
 * evidence of absence, and collapsing the two tells a member with a perfectly good account that
 * they have none — the identity equivalent of rendering an unreadable balance as $0.
 */
export function unverified(reason) {
  return { outcome: OUTCOMES.UNVERIFIED, reason }
}

/**
 * A NAMED account exists and this key is not among its current owners. Carries the address
 * because the member supplied it: naming it back is what makes the refusal legible rather than
 * a bare no.
 */
export function notController(reason, address) {
  return { outcome: OUTCOMES.NOT_CONTROLLER, reason, address }
}

/** True only for the one outcome a session may be opened on. */
export function isResolved(resolution) {
  return resolution?.outcome === OUTCOMES.RESOLVED && resolution.accounts?.length > 0
}

const REASONS = {
  noCode: 'No account is deployed at that address yet.',
  notOwner: 'That account exists, but this passkey is not one of its owners.',
  unreadable:
    'We could not reach the network to check. This does not mean you have no account — try again, ' +
    'or check your network settings.',
  timedOut:
    'The network did not answer in time. This does not mean you have no account — try again in a moment.',
  nothingFound:
    'No account on this network lists this passkey as an owner. A passkey that was added to an ' +
    'existing account after it was created cannot be found this way — enter the account address instead.',
}

/** Deadline that rejects rather than hanging, so a slow chain degrades to `unverified`. */
function withDeadline(promise, deadlineMs, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!deadlineMs) return promise
  let timer
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimer(() => reject(new DeadlineExpired()), deadlineMs)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimer(timer))
}

class DeadlineExpired extends Error {
  constructor() {
    super('deadline expired')
    this.name = 'DeadlineExpired'
  }
}

/**
 * Confirm ONE named address against its CURRENT owner set.
 *
 * The primitive behind both the confirmation step of a search and the address a member types in.
 * Where the address came from changes nothing about the check performed — an address is a hint,
 * never a claim.
 *
 * Verification is against the current set, not history: a key that once owned an account and was
 * rotated off does not control it, and offering it would send the member somewhere they can no
 * longer sign for.
 *
 * @returns {object} a Resolution narrowed to `resolved` (exactly one account),
 *   `not-controller`, or `unverified`.
 */
export async function verifyAccountForKey({ ownerBytes, address, chainId, deadlineMs = RESOLUTION_DEADLINE_MS, deps = {} }) {
  const wanted = String(ownerBytes || '').toLowerCase()
  if (!wanted) return unverified(REASONS.unreadable)

  let result
  try {
    result = await withDeadline(
      // STRICT: an unreadable chain must reach the `unverified` branch below. The default
      // behaviour reports a failed `getCode` as `deployed: false`, which would arrive here
      // indistinguishable from a genuinely empty address and be reported as an absence.
      (deps.readControllers ?? readControllers)({ chainId, accountAddress: address, strict: true, deps }),
      deadlineMs,
      deps
    )
  } catch (err) {
    // An RPC timeout is not a fact about the member's account. Both branches are `unverified`;
    // only the wording differs, so the member knows whether to wait or to look at their settings.
    return unverified(err instanceof DeadlineExpired ? REASONS.timedOut : REASONS.unreadable)
  }

  // Nothing deployed there. A member who mistyped an address and one whose passkey was rotated
  // off need different next steps, so the two refusals never share a sentence.
  if (!result?.deployed) return notController(REASONS.noCode, address)

  const match = (result.controllers || []).find((c) => c.ownerBytes?.toLowerCase() === wanted)
  if (!match) return notController(REASONS.notOwner, address)

  // The slot the CHAIN reported. Never 0 by assumption — signatures depend on the real index
  // (spec 045 FR-009), and an account that gained controllers does not put this key at 0.
  return resolved([{ address, ownerIndex: Number(match.index), chainId }])
}

/**
 * Search for accounts this key controls, then confirm every one it finds.
 *
 * **Leg A — nonce enumeration (T-103).** The candidates are the addresses this key would own had
 * it been the sole initial owner at each creation nonce. They are HINTS: each is confirmed against
 * its current owner set exactly as a member-typed address is, which is the whole point of the
 * seam — the code this replaced treated a derived address as an answer and signed members into
 * empty accounts.
 *
 * Leg B (the `AccountCreated` scan) is deliberately NOT here. Measured 2026-09-06, the endpoints
 * `config/networks.js` ships cannot serve it: Polygon's public node retains ~1.4 days of logs and
 * the others cap `getLogs` near 100 blocks and refuse historical ranges without a paid token. It
 * needs an index — the subgraph — and lands with one (#1432). Until then this resolver runs one
 * leg, and the aggregation below is written so that never becomes a claim it cannot support.
 *
 * Three rules govern the result, and each has a way to be quietly wrong:
 *
 * 1. **`none-found` requires that the legs actually RAN.** A chain that would not answer is not
 *    evidence of absence. If any candidate came back `unverified`, the answer is `unverified`,
 *    even though other candidates were read cleanly — a partial search that found nothing has not
 *    found nothing, it has not finished.
 * 2. **Every verified account is returned; the resolver picks none** (FR-007). Two accounts is a
 *    question for the member, and choosing for them would silently strand value in the other.
 * 3. **The deadline covers the whole search, not each candidate.** Candidates run concurrently
 *    under one budget, so widening `NONCE_SCAN_LIMIT` cannot extend how long a member waits.
 *
 * @returns {object} a Resolution. Never throws for a chain condition — a thrown error here is a
 *   programming fault, not something a member did.
 */
export async function resolveAccounts({
  ownerBytes,
  chainId,
  deadlineMs = RESOLUTION_DEADLINE_MS,
  nonceLimit = NONCE_SCAN_LIMIT,
  deps = {},
}) {
  const limit = Math.max(1, Math.floor(Number(nonceLimit)) || 1)

  // Derived up front and OUTSIDE the try/catch below: a missing factory address is a build
  // misconfiguration, not a chain condition, and must keep surfacing as the throw it always was
  // rather than being laundered into `none-found` — which would tell every member on a
  // misconfigured build that they have no account.
  const candidates = []
  for (let nonce = 0; nonce < limit; nonce += 1) {
    const address =
      deps.deriveCandidate?.({ ownerBytes, chainId, nonce }) ??
      computeAccountAddress({ ownersBytes: [ownerBytes], nonce: BigInt(nonce), chainId })
    if (address) candidates.push({ address, nonce })
  }

  const verdicts = await Promise.all(
    candidates.map(({ address }) =>
      verifyAccountForKey({ ownerBytes, address, chainId, deadlineMs, deps })
    )
  )

  const verified = []
  let incomplete = null

  verdicts.forEach((verdict, i) => {
    if (verdict.outcome === OUTCOMES.RESOLVED) {
      // `origin` is carried for diagnosis only (data-model.md); it never shortens a check, and
      // nothing downstream may trust an account more for having come from one leg or another.
      verified.push(...verdict.accounts.map((a) => ({ ...a, origin: 'nonce', nonce: candidates[i].nonce })))
    } else if (verdict.outcome === OUTCOMES.UNVERIFIED) {
      incomplete = incomplete ?? verdict.reason
    }
    // `not-controller` is a READ absence at this nonce: the chain answered and the key is not
    // there. It contributes nothing and is never surfaced — the member never named this address,
    // we computed it, and showing them an address they have never seen to deny it is noise.
  })

  if (verified.length > 0) return resolved(verified)
  if (incomplete) return unverified(incomplete)
  return noneFound(REASONS.nothingFound)
}

/** Owner bytes for a recovered P-256 key, lowercased for comparison. */
export function ownerBytesForPublicKey(publicKey) {
  return publicKeyToOwnerBytes(publicKey).toLowerCase()
}

export const __reasons = REASONS
