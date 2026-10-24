/**
 * Assistant provider copy (spec 104) — the sentences every assistant surface says about WHO answers.
 *
 * Three surfaces state the rail — the chat header, the Tools card, the launcher's panel — and the
 * one thing that must never happen is two of them describing the same choice differently. The
 * cost/privacy sentence in particular is a disclosure (research § 4.6): it is quoted here once and
 * imported, never retyped.
 *
 * It also holds the pure sentence-producing helpers the surfaces share (`providerOptionReason`,
 * `describeTestOutcome`, `errorCopy`). They live in a plain module rather than beside the component
 * that renders them for two reasons: a copy string quoted by two surfaces has one home, and a
 * component file that also exports functions breaks Fast Refresh for the whole file.
 */

import { tenantAssistantSettings } from '../../config/tenant'
import { GUTTERTOKEN_SIGNUP_URL } from '../../lib/assistant/providers/guttertoken'

/** Member-facing name of each rail. Keyed by the `provider` value `resolveProvider` returns. */
export const PROVIDER_NAMES = Object.freeze({
  fairwins: 'FairWins assistant',
  guttertoken: 'GutterToken',
})

/** The chooser's option labels — what the member picks between. */
export const PROVIDER_OPTION_LABELS = Object.freeze({
  fairwins: 'FairWins assistant (membership)',
  guttertoken: 'GutterToken (your credits)',
})

/**
 * One sentence per option: who receives the messages and who pays. Both are facts the member
 * needs BEFORE the first token, so the chooser shows them beside the radio, not behind a link.
 */
export const PROVIDER_COST_LINES = Object.freeze({
  fairwins: 'Messages go to the FairWins gateway and its model provider; included in membership.',
  guttertoken:
    'Messages go from this device straight to GutterToken and are billed to your prepaid balance per token; FairWins never sees them and charges nothing.',
})

/**
 * Where "Get a key ↗" goes.
 *
 * `https://app.guttertokens.com/signup`, decorated with `?ref=<code>` when the tenant manifest
 * declares one (`settings.assistant.guttertokenReferralCode`). The code is OPTIONAL and none is
 * registered today, so the plain link is the normal case and the read has to survive a manifest
 * with no assistant block at all. Nothing else about the link is ours — the code only prefills
 * GutterToken's own referral field.
 *
 * The code's shape is validator-gated (`^[A-Za-z0-9_-]{1,64}$`), and it is re-checked here rather
 * than trusted: this value is interpolated into a URL the member is about to follow, and a build
 * whose manifest slipped past the gate must not be able to point that link somewhere else.
 */
export function gutterTokenSignupUrl() {
  const code = tenantAssistantSettings().guttertokenReferralCode
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) return GUTTERTOKEN_SIGNUP_URL
  return `${GUTTERTOKEN_SIGNUP_URL}?ref=${code}`
}

/**
 * Whether a referral code is actually attached. The disclosure sentence is stated either way —
 * FairWins *may* receive credit — but a surface that wants to say more only says it when true.
 */
export function hasGutterTokenReferral() {
  return gutterTokenSignupUrl() !== GUTTERTOKEN_SIGNUP_URL
}

/**
 * The key sheet's lead sentence, branched on how this member signs in.
 *
 * This is a VERIFIED fact, not a hedge (research § 4.5): GutterToken's signup page detects
 * `window.ethereum` only. A passkey member has no injected wallet for it to find and no ERC-1271
 * path, so the wallet option is not even shown to them — they must create the account with an
 * e-mail address. Telling them to "sign in with your wallet" would send them to a dead end.
 *
 * Neither branch implies FairWins can connect, link or sign them in over there: signup happens
 * inside GutterToken's own session and FairWins is never part of it.
 *
 * @param {string|null|undefined} loginMethod - `useWallet().loginMethod`
 */
export function keySheetLead(loginMethod) {
  if (loginMethod === 'passkey') {
    return 'Your FairWins passkey account cannot sign GutterToken\'s wallet sign-in (it has no key). Create a GutterToken account with an e-mail address, then paste the API key from their dashboard here.'
  }
  return 'Sign up at GutterToken with the same wallet you use here, or with an e-mail address, then paste the API key from their dashboard here.'
}

/** The chat header subline. Names the rail every time the panel opens. */
export function providerBadgeText(provider) {
  if (provider === 'guttertoken') return 'Answered by GutterToken on your credits'
  if (provider === 'fairwins') return 'Answered by FairWins'
  return null
}

/**
 * What a tool is READING, in the member's words, for the progress row ("Reading your wagers…").
 * Keyed by the contract's tool names; an unknown tool falls back to a humanised name rather than
 * to nothing, so a new tool never runs invisibly. An event may also carry its own `title`.
 */
const TOOL_SUBJECTS = Object.freeze({
  get_profile: 'your profile',
  get_membership: 'your membership',
  get_wagers: 'your wagers',
  get_fees: 'the current fees',
  get_gateway_status: 'the service status',
  get_prediction_markets: 'prediction markets',
  get_perps_pairs: 'perps markets',
  find_in_app: 'the app map',
})

export function toolSubject(event) {
  if (!event) return 'data'
  if (event.title) return String(event.title)
  const name = String(event.name || '')
  if (TOOL_SUBJECTS[name]) return TOOL_SUBJECTS[name]
  return name.replace(/^get_/, '').replace(/_/g, ' ') || 'data'
}

/**
 * The referral disclosure, stated in words beside the "Get a key" link — never a bare link. Spec
 * 057's rule: a revenue path is its own sentence, never implied to be neutral.
 */
export const REFERRAL_DISCLOSURE =
  'Opens GutterToken. FairWins may receive referral credit when you fund an account through this link.'

/**
 * Why a provider option cannot be chosen right now, or null when it can.
 *
 * THREE membership states, never two: pending and unreadable are each their own sentence, and
 * neither is a denial. Unreadable in particular keeps the option ENABLED (`keepEnabled`) — an RPC
 * that did not answer is not evidence about a member's tier, and hiding the rail on a timeout would
 * make a network problem look like a decision about their account.
 *
 * @param {'fairwins'|'guttertoken'} provider
 * @param {{membership: null|{readable?: boolean, isActive?: boolean}, hasKey: boolean}} context
 */
export function providerOptionReason(provider, { membership, hasKey }) {
  if (provider === 'fairwins') {
    if (membership == null) return { text: 'Checking your membership…', tone: 'pending' }
    if (membership.readable === false) {
      return {
        text: 'Your membership could not be read right now. You can still choose this; it is checked again when you ask something.',
        tone: 'unreadable',
        keepEnabled: true,
      }
    }
    if (!membership.isActive) return { text: 'Requires an active membership.', tone: 'blocked', membershipLink: true }
    return null
  }
  if (provider === 'guttertoken') {
    if (!hasKey) return { text: 'Add a GutterToken key below to use your own credits.', tone: 'blocked' }
    return null
  }
  return null
}

/**
 * The three outcomes of testing a key, as sentences. The card and the sheet both render this, so
 * they cannot describe the same HTTP status differently.
 *
 * Refused, unreachable and accepted are genuinely different facts and are never collapsed into a
 * green tick: "could not be reached" says nothing about the key, and a member told otherwise would
 * re-type a key that was fine.
 */
export function describeTestOutcome(result) {
  if (result?.ok) {
    const n = Array.isArray(result.models) ? result.models.length : null
    return {
      tone: 'ok',
      text:
        n == null
          ? 'GutterToken accepted this key.'
          : `GutterToken accepted this key — ${n} model${n === 1 ? '' : 's'} available.`,
    }
  }
  const state = result?.state
  if (state === 'key_invalid' || state === 'unauthorized') {
    return { tone: 'refused', text: 'GutterToken did not accept this key. It may have been revoked or mistyped.' }
  }
  if (state === 'key_missing') {
    return { tone: 'refused', text: 'There is no GutterToken key saved on this device to test.' }
  }
  if (state === 'unreachable') {
    return {
      tone: 'unknown',
      text: 'GutterToken could not be reached to check this key. That says nothing about the key itself — try again shortly.',
    }
  }
  if (state === 'out_of_credit') {
    return { tone: 'ok', text: 'GutterToken accepted this key, but its balance is empty. Top up at GutterToken before asking anything.' }
  }
  return {
    tone: 'unknown',
    text: result?.message
      ? `GutterToken did not confirm this key: ${result.message}`
      : 'GutterToken did not confirm this key.',
  }
}

/**
 * The member-facing sentence for a failed turn, given the rail it happened on. The rail matters for
 * exactly one state: a `quota` on GutterToken is THEIR per-network rate limit, which is a different
 * fact (and a different remedy) from the gateway's own budget.
 */
export function errorCopy(error, provider) {
  switch (error?.state) {
    case 'key_invalid':
      return 'GutterToken did not accept your key. It may have been revoked.'
    case 'key_missing':
      return 'No GutterToken key is saved on this device, so nothing can answer yet. Choose who answers to continue.'
    case 'out_of_credit':
      return 'Your GutterToken balance is empty. Top up at GutterToken and try again.'
    case 'quota':
      return provider === 'guttertoken'
        ? 'GutterToken is rate-limiting requests from your network. Try again shortly.'
        : error?.message || 'The assistant is busy. Try again shortly.'
    case 'no_grant':
      return 'That question needs your own data, which the assistant can read only after you sign a short, read-only grant.'
    default:
      return error?.message || 'The assistant could not answer.'
  }
}

/**
 * Fold one `onToolEvent` into the progress rows. A `start` opens a row; the matching `done` closes
 * the most recent open row of that name. A `done` with no open row still gets a row — a read that
 * happened is never invisible because its start was missed.
 */
export function applyToolEvent(rows, event) {
  if (!event || !event.name) return rows
  const subject = toolSubject(event)
  if (event.phase === 'start') {
    return [...rows, { key: `${event.name}-${rows.length}`, name: event.name, subject, status: 'pending', code: null }]
  }
  const status = event.ok === false ? 'unreadable' : 'read'
  const idx = [...rows].reverse().findIndex((r) => r.name === event.name && r.status === 'pending')
  if (idx === -1) {
    return [...rows, { key: `${event.name}-${rows.length}`, name: event.name, subject, status, code: event.code ?? null }]
  }
  const real = rows.length - 1 - idx
  return rows.map((r, i) => (i === real ? { ...r, status, code: event.code ?? null } : r))
}
