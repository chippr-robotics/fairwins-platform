import { zeroAddress } from 'viem'
// Statuses that end a wager's resolvability — no resolve control in any of them.
const TERMINAL_FOR_RESOLVE = new Set([
  'resolved', 'disputed', 'cancelled', 'canceled', 'refunded', 'expired',
  'declined', 'pending_acceptance',
])

/**
 * What the resolve control shows for a wager right now:
 *   'button'    — the resolve window is open and this wallet may act
 *   'countdown' — this wallet may act, but the window has not opened yet
 *   'none'      — nothing renders (unauthorized, terminal, or past the deadline)
 *
 * Pure, and kept in its own module so callers that need to know whether a
 * Resolve *button* is actually on screen read the same decision
 * ResolveButtonWithCountdown renders from, instead of re-deriving an
 * approximation of it. WagerTable uses it to decide whether the action-needed
 * tag would duplicate a visible control.
 *
 * @param {object} market
 * @param {string} account
 * @param {number} [now]
 * @returns {{state: 'button'|'countdown'|'none', msUntilOpen: number}}
 */
export function resolveControlState(market, account, now = Date.now()) {
  const none = { state: 'none', msUntilOpen: 0 }

  const userAddr = account?.toLowerCase()
  const isCreator = market.creator?.toLowerCase() === userAddr
  const isOpponent = market.participants?.length > 1 &&
    market.participants[1]?.toLowerCase() === userAddr
  const isArbitrator = market.arbitrator &&
    market.arbitrator !== zeroAddress &&
    market.arbitrator.toLowerCase() === userAddr

  const resType = market.resolutionType ?? 0
  const isAuthorized = (() => {
    if (resType === 0) return isCreator || isOpponent || isArbitrator
    if (resType === 1) return isCreator
    if (resType === 2) return isOpponent
    if (resType === 3) return isArbitrator
    return false
  })()

  // A draw returns both stakes and so needs BOTH participants to agree; allow
  // either participant to open the resolution flow to propose/confirm a draw on
  // participant-resolved types (Either/Creator/Opponent), even when they cannot
  // declare a winner (e.g. the opponent on a Creator-resolved wager).
  const canProposeDraw = (resType === 0 || resType === 1 || resType === 2) && (isCreator || isOpponent)

  if (!isAuthorized && !canProposeDraw) return none

  const status = market.computedStatus || market.status
  if (TERMINAL_FOR_RESOLVE.has(status)) return none

  // Resolve-window gate. Resolution is only allowed in
  // [tradingEndTime, resolveDeadlineTime]:
  //   - before tradingEndTime  → a countdown, no resolve button
  //   - after resolveDeadlineTime → nothing (the Claim Refund flow takes over)
  // Fall back to "resolvable" when the timestamps are missing (e.g. legacy wagers).
  const { tradingEndTime, resolveDeadlineTime } = market
  if (typeof resolveDeadlineTime === 'number' && now > resolveDeadlineTime) return none
  if (typeof tradingEndTime === 'number' && now < tradingEndTime) {
    return { state: 'countdown', msUntilOpen: tradingEndTime - now }
  }
  return { state: 'button', msUntilOpen: 0 }
}

/** Format a countdown gap as the coarsest useful unit pair. */
export function countdownLabel(diff) {
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
