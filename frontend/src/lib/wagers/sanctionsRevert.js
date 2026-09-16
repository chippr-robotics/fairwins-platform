import { getAddress } from 'viem'
import { rawRevertData } from '../chain/revertError'

/**
 * Sanctions-screening reverts, decoded and put into words (#1292).
 *
 * `ISanctionsGuard`'s errors are NOT in the WagerRegistry ABI the frontend ships — the guard reverts
 * *through* the registry call, so solc never emits `SanctionedAddress` into the registry's own ABI and
 * ethers has nothing to decode it with. Every screened member therefore saw
 * "execution reverted (unknown custom error)" (or, worse, a fall-through telling them to check a
 * balance and an allowance that are both fine). Recovering the error from its selector is what makes
 * any `reason.includes('SanctionedAddress')` check able to fire at all.
 *
 * Shared because FOUR entrypoints are screened, not two: `createWager` and `acceptWager`
 * (contracts/wagers/WagerRegistryCore.sol `_createWager` / `_runAcceptGuard`) plus `createOpenWager`
 * (contracts/wagers/WagerRegistry.sol) and `acceptOpenWager`.
 */

/** `ISanctionsGuard.SanctionedAddress(address)` — first 4 bytes of keccak256 of the signature. */
export const SANCTIONED_ADDRESS_SELECTOR = '0x80279111'

// Errors the shipped ABI cannot decode, keyed by selector. Kept as a map so the next one is a line.
const UNDECODABLE_ERROR_BY_SELECTOR = {
  [SANCTIONED_ADDRESS_SELECTOR]: 'SanctionedAddress',
}

/**
 * The revert data an ethers error carries, across the shapes wallets actually produce — the shared
 * `rawRevertData` walk covers the nested ones too (MetaMask leaves the node payload under
 * `data.data`, wrapped providers under `error.error.data`), where a shallower read sees an object
 * and misses the selector entirely.
 *
 * Neither walk reads `error.transaction.data`: that is the CALLDATA we sent, so it is present on
 * almost every failure and would shadow the revert data that actually carries the selector.
 */
function revertDataFrom(error) {
  const data = rawRevertData(error)
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) return null
  return data.toLowerCase()
}

/**
 * The revert reason for a call/simulation error, naming the custom errors the frontend ABI cannot
 * decode on its own. Feed the result to the surface's `translate*Revert`.
 */
export function revertReasonFrom(error) {
  const data = revertDataFrom(error)
  const selector = data && data.length >= 10 ? data.slice(0, 10) : null
  if (selector && UNDECODABLE_ERROR_BY_SELECTOR[selector]) return UNDECODABLE_ERROR_BY_SELECTOR[selector]
  return error?.reason || error?.shortMessage || error?.message || ''
}

/**
 * The address `SanctionedAddress(address account)` names, or null when the error is a different
 * revert or its data was truncated.
 *
 * This matters on the ACCEPT paths, where `_runAcceptGuard` screens BOTH parties
 * (`_screen(taker); _screen(creator);`). A creator listed after their wager was created makes every
 * accept revert with the *creator's* address — telling the acceptor their own account was stopped
 * would be a false compliance accusation about a clean address.
 */
export function sanctionedAddressFrom(error) {
  const data = revertDataFrom(error)
  if (!data || data.slice(0, 10) !== SANCTIONED_ADDRESS_SELECTOR) return null
  if (data.length < 10 + 64) return null // truncated: one 32-byte word must follow the selector
  try {
    return getAddress(`0x${data.slice(34, 74)}`)
  } catch {
    return null
  }
}

const shorten = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`

// Screening is FAIL-CLOSED: contracts/access/SanctionsGuard.sol `isAllowed` returns false whenever the
// configured oracle is unreachable or erroring, so `checkBlocked` reverts SanctionedAddress during an
// oracle outage for accounts that are on no list at all. The revert therefore establishes that
// screening did not clear the account — never that the account is listed. Saying otherwise would tell
// every member during an outage that they are flagged, which is exactly the class of claim this repo
// forbids elsewhere (a read that failed is never rendered as a fact).
const SCREENING_CAVEAT =
  'Screening also blocks transactions when the screening service itself cannot be reached, so this may clear on a later attempt.'

const SUPPORT_TAIL = 'If it keeps happening, contact support with the address you are using.'

/**
 * Copy for a surface where only the acting member is screened — both CREATE paths
 * (`_createWager` screens the creator; `createOpenWager` screens `msg.sender`).
 *
 * `outcome` completes "so …" and must be the strongest claim true on EVERY leg. Notably it must not
 * say nothing was submitted: on the self-submit legs a stake approval (and the `batchExpireOpen`
 * cleanup) are already sent, confirmed and PAID FOR by the time this simulation reverts.
 */
export function screenedActorMessage(outcome) {
  return `Sanctions screening did not clear your account, so ${outcome}. ${SCREENING_CAVEAT} ${SUPPORT_TAIL}`
}

/**
 * Copy for a surface where EITHER party may be the one screening stopped on — both ACCEPT paths.
 * Pass the address decoded by {@link sanctionedAddressFrom} and the acting member's address; when
 * either is unknown the message says so rather than guessing whose account it was.
 */
export function screenedPartyMessage({ outcome, sanctioned = null, account = null }) {
  if (sanctioned && account) {
    if (sanctioned.toLowerCase() === account.toLowerCase()) return screenedActorMessage(outcome)
    return (
      `Sanctions screening did not clear the other party's account (${shorten(sanctioned)}) — not yours — ` +
      `so ${outcome}. ${SCREENING_CAVEAT} There is nothing to change on your side.`
    )
  }
  if (sanctioned) {
    return `Sanctions screening did not clear the account ${shorten(sanctioned)}, so ${outcome}. ${SCREENING_CAVEAT} ${SUPPORT_TAIL}`
  }
  return (
    `Sanctions screening did not clear this wager, so ${outcome}. Both your account and the other party's ` +
    `are screened, and the error does not say which one it stopped on. ${SCREENING_CAVEAT} ${SUPPORT_TAIL}`
  )
}
