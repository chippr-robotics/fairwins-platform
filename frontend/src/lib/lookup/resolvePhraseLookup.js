/**
 * Unified phrase lookup resolver (spec 037, FR-001..013/025).
 *
 * Given a four-word phrase, resolve it to EITHER an open challenge OR a group pool by running both
 * lookups concurrently, then reduce the two source outcomes to a single discriminated `LookupResult`.
 * Pure and dependency-injected so it is unit-testable without a wallet/chain:
 *
 *   resolvePhraseLookup({ phrase, lang, account, now, deps: { lookupChallenge, resolvePool } })
 *
 * deps.lookupChallenge(code) → { status:'matched', payload } | { status:'not-found', ... } | { status:'errored', error }
 *   (see useOpenChallengeAccept().lookup — never throws)
 * deps.resolvePool(phrase, lang) → { summary } | { notFound:true, reason } ; MAY throw on RPC/signer error
 *   (see usePools().resolvePhrase)
 * deps.resolveFunding(phrase, lang) → same shape, against the FUNDING-pool factory (spec 103, FR-021);
 *   optional — absent means "not checked", which is reported honestly as a `funding` errored source only
 *   when it was supplied and threw.
 *
 * Result kinds: format-error | challenge | pool | funding | collision | not-actionable | self | none |
 * lookup-failed. A funding pool never collides with the others silently: when both a wager-side match and
 * a funding match exist the wager result wins and the funding pool rides along as `result.funding` so the
 * UI can offer it as a second row.
 * Distinguishing "none" (both sources checked, no match) from "lookup-failed" (a source errored) is the
 * FR-025 guarantee — we never show "no match" when we could not actually check.
 */
import { isValidCode } from '../../utils/claimCode/wordlist.js'

export const WORD_COUNT = 4

/**
 * Normalize a phrase for lookup: NFKC, lowercase, hyphen/underscore→space, trim, collapse whitespace.
 * Broader than the English claim-code normalizer (it also folds hyphens) so pasted "a-b-c-d" resolves
 * the same as "a b c d" (FR-008).
 */
export function normalizePhrase(input) {
  if (typeof input !== 'string') return ''
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function settledToOutcome(settled) {
  if (settled.status === 'fulfilled') return settled.value
  return { status: 'errored', error: settled.reason }
}

// Adapt usePools().resolvePhrase (returns {summary} | {notFound,reason}; throws on error) to an outcome.
async function poolOutcome(resolvePool, phrase, lang) {
  const res = await resolvePool(phrase, lang) // a throw here is caught by Promise.allSettled → 'errored'
  if (res && res.summary) return { status: 'matched', payload: res.payload || res.summary }
  return { status: 'not-found', reason: (res && res.reason) || 'unknown' }
}

function classifyChallenge(payload, account) {
  const creator = payload?.wager?.creator
  const isSelf = !!account && !!creator && String(creator).toLowerCase() === String(account).toLowerCase()
  if (isSelf) return { kind: 'self', type: 'challenge', match: payload }
  // A challenge only resolves here while it is still Open and unaccepted (spec 024: the claim slot frees
  // once accepted/expired/cancelled), so a matched challenge is inherently actionable.
  return { kind: 'challenge', match: payload, actionable: true, isSelf: false }
}

function classifyPool(summary, account, now) {
  const isSelf = !!summary.isCreator || !!summary.hasJoined
  const open = summary.state === 0 // 0 = JoiningOpen
  const hasSlots = (summary.slotsRemaining ?? 0) > 0
  const beforeDeadline = !summary.acceptDeadline || now < summary.acceptDeadline
  const actionable = open && hasSlots && beforeDeadline && !summary.hasJoined
  if (isSelf) return { kind: 'self', type: 'pool', match: summary }
  if (!actionable) {
    const reason = !open ? summary.stateLabel || 'closed'
      : !hasSlots ? 'full'
      : !beforeDeadline ? 'join-window-passed'
      : 'unavailable'
    return { kind: 'not-actionable', type: 'pool', match: summary, reason }
  }
  return { kind: 'pool', match: summary, actionable: true, isSelf: false }
}

export async function resolvePhraseLookup({ phrase, lang = 'en', account = null, now, deps }) {
  const nowSec = typeof now === 'number' ? now : Math.floor(Date.now() / 1000)
  const normalized = normalizePhrase(phrase)
  const words = normalized ? normalized.split(' ') : []
  if (words.length !== WORD_COUNT) {
    return { kind: 'format-error', message: 'Enter exactly four words separated by spaces.' }
  }

  // Challenges are English-only; only attempt the challenge lookup for a valid English four-word code.
  const englishValid = isValidCode(normalized)

  const [challengeSettled, poolSettled, fundingSettled] = await Promise.allSettled([
    englishValid ? deps.lookupChallenge(normalized) : Promise.resolve({ status: 'not-found', reason: 'not-english' }),
    poolOutcome(deps.resolvePool, normalized, lang),
    deps.resolveFunding
      ? poolOutcome(deps.resolveFunding, normalized, lang)
      : Promise.resolve({ status: 'not-found', reason: 'not-checked' }),
  ])

  const challenge = settledToOutcome(challengeSettled)
  const pool = settledToOutcome(poolSettled)
  const funding = settledToOutcome(fundingSettled)

  const challengeMatched = challenge.status === 'matched'
  const poolMatched = pool.status === 'matched'
  const fundingMatched = funding.status === 'matched'
  const withFunding = (res) => (fundingMatched ? { ...res, funding: funding.payload } : res)

  if (challengeMatched && poolMatched) {
    return withFunding({ kind: 'collision', challenge: challenge.payload, pool: pool.payload })
  }
  if (challengeMatched) return withFunding(classifyChallenge(challenge.payload, account))
  if (poolMatched) return withFunding(classifyPool(pool.payload, account, nowSec))
  if (fundingMatched) return { kind: 'funding', match: funding.payload }

  // Neither matched: distinguish a genuine empty result from a source that could not be checked.
  const erroredSources = []
  if (challenge.status === 'errored') erroredSources.push('challenge')
  if (pool.status === 'errored') erroredSources.push('pool')
  if (funding.status === 'errored') erroredSources.push('funding')
  if (erroredSources.length > 0) return { kind: 'lookup-failed', sources: erroredSources }
  return { kind: 'none' }
}

export default resolvePhraseLookup
