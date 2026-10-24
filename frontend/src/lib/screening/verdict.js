/**
 * From a set of source readings to ONE word a member can act on — and the rule that makes the
 * green one honest.
 *
 * A reading is one source's answer about one address on one chain:
 *
 *   { status: 'read', flagged: boolean }   the list answered
 *   { status: 'unreadable', reason }       it could not be asked — NOT an answer
 *
 * The verdict over a set of them:
 *
 *   flagged     ANY source answered "yes, listed". One is enough: the lists are independent
 *               and a member who is clear on four and frozen on the fifth still loses the funds.
 *   screened    EVERY configured source answered, and every answer was clear. This is the only
 *               state that renders green, and it requires `unreadable === 0`: a source that did
 *               not answer is not a source that said no.
 *   partial     nothing flagged, at least one answer, at least one source unanswered. Not green.
 *   unscreened  no source answered at all — none configured for these chains, or all unreadable.
 *
 * The asymmetry is deliberate and is the whole feature: a flag is a positive fact from a named
 * list and stands on its own; "clear" is the absence of a flag from EVERY list, so one missing
 * list means the absence was never established.
 */

export const VERDICTS = Object.freeze({
  SCREENED: 'screened',
  FLAGGED: 'flagged',
  PARTIAL: 'partial',
  UNSCREENED: 'unscreened',
})

export const READ = 'read'
export const UNREADABLE = 'unreadable'

/** @param {Array<{status: string, flagged?: boolean}>} readings */
export function countReadings(readings = []) {
  let read = 0
  let flagged = 0
  let unreadable = 0
  for (const r of readings) {
    if (!r) continue
    if (r.status === READ) {
      read += 1
      if (r.flagged) flagged += 1
    } else if (r.status === UNREADABLE) {
      unreadable += 1
    }
  }
  return { read, flagged, unreadable, total: read + unreadable }
}

/** @param {Array<{status: string, flagged?: boolean}>} readings */
export function deriveVerdict(readings = []) {
  const c = countReadings(readings)
  if (c.flagged > 0) return VERDICTS.FLAGGED
  if (c.read === 0) return VERDICTS.UNSCREENED
  if (c.unreadable > 0) return VERDICTS.PARTIAL
  return VERDICTS.SCREENED
}

/**
 * The verdict for ONE network, from a whole-estate result.
 *
 * The address book saves an address WITH the network it is used on, so a row there is asking a
 * narrower question than the pill above it: not "is this address listed anywhere?" but "what do
 * this network's lists say?". Deriving it from the readings already in hand keeps one sweep
 * answering both, and keeps the two answers consistent by construction.
 *
 * Returns `null` when nothing screens that chain — the caller says "no source on this network",
 * which is a different sentence from "nothing answered" and must not be collapsed into it.
 *
 * @param {{readings: any[]}} result
 * @param {number} chainId
 * @returns {{verdict: string, readings: any[]}|null}
 */
export function verdictOnChain(result, chainId) {
  const here = (result?.readings || []).filter((r) => Number(r.chainId) === Number(chainId))
  if (!here.length) return null
  return { verdict: deriveVerdict(here), readings: here }
}

/** Short pill labels. Words, never colour alone (WCAG 1.4.1). */
export const VERDICT_LABELS = Object.freeze({
  [VERDICTS.SCREENED]: 'Screened clear',
  [VERDICTS.FLAGGED]: 'Flagged',
  [VERDICTS.PARTIAL]: 'Partly screened',
  [VERDICTS.UNSCREENED]: 'Unscreened',
})

function joinNames(names) {
  const uniq = [...new Set(names.filter(Boolean))]
  if (uniq.length <= 1) return uniq.join('')
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`
  return `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`
}

/**
 * One sentence for the verdict, naming what it rests on. `nameForChain` turns a chainId into
 * the network's display name; the default is honest rather than pretty.
 *
 * @param {{ verdict: string, readings: any[], uncovered?: number[] }} result
 * @param {(chainId:number) => string} [nameForChain]
 */
export function describeVerdict(result, nameForChain = (id) => `chain ${id}`) {
  const readings = result?.readings || []
  const c = countReadings(readings)
  const networks = new Set(readings.filter((r) => r.status === READ).map((r) => r.chainId))
  switch (result?.verdict) {
    case VERDICTS.FLAGGED: {
      // The one case that still names its sources in the summary: a member about to send value
      // needs to know WHICH list objects, because the consequence differs — a FairWins guard hit
      // reverts the transaction, an issuer freeze strands the token after it arrives.
      const hits = readings.filter((r) => r.status === READ && r.flagged)
      const where = joinNames(hits.map((r) => `${r.label} on ${nameForChain(r.chainId)}`))
      return `This address is flagged by sanctions screening: ${where}. Value sent to it may be refused on-chain or frozen.`
    }
    case VERDICTS.SCREENED:
      return `All ${c.read} ${c.read === 1 ? 'list' : 'lists'} on ${networks.size} ${networks.size === 1 ? 'network' : 'networks'} answered clear.`
    case VERDICTS.PARTIAL:
      // Deliberately does NOT name the missing sources (issue #1458 QA round). It used to, and on
      // a build where several were unreachable the notice became a paragraph a member had to read
      // to learn one thing: it is not a clean bill. WHICH list is missing is a detail for someone
      // who asks — it lives one tap away, in the pill's own per-source rows, where each is named
      // with the reason it gave. The count is the honest headline; the bar shows the shape.
      return `${c.read} of ${c.total} lists answered clear; ${c.unreadable} could not be read — not a clean bill.`
    case VERDICTS.UNSCREENED:
    default: {
      // Two different facts can each be true here, and both are named when they are: the sources
      // that exist gave no answer, and the networks that have no source at all (acceptance
      // scenario 5 — a member on ETC needs to hear that nothing screens there, not just that a
      // Polygon read timed out).
      const un = (result?.uncovered || []).map(nameForChain)
      const uncoveredSentence = un.length ? ` No screening source covers ${joinNames(un)}.` : ''
      if (c.total === 0) {
        return un.length
          ? `No screening source covers ${joinNames(un)}. This address could not be checked.`
          : 'This address could not be screened.'
      }
      return `This address could not be screened: no source answered.${uncoveredSentence} Proceed with caution.`
    }
  }
}

/**
 * Worst verdict in a set — the contact-level flag over a contact's addresses.
 *
 * Order is by what a member must act on, not by severity of colour: a flag anywhere outranks a
 * gap, and a gap outranks a clean bill. `screened` is last precisely because it is the only one
 * that claims something, so it can only survive when nothing else is present.
 */
const VERDICT_RANK = {
  [VERDICTS.FLAGGED]: 3,
  [VERDICTS.UNSCREENED]: 2,
  [VERDICTS.PARTIAL]: 1,
  [VERDICTS.SCREENED]: 0,
}

export function worstVerdict(verdicts = []) {
  return (verdicts.filter(Boolean).reduce(
    (worst, v) => ((VERDICT_RANK[v] ?? -1) > (VERDICT_RANK[worst] ?? -1) ? v : worst),
    null,
  ))
}
