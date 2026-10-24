/**
 * Two-word nicknames for Wager Pools (spec 034, address-based — Semaphore removed).
 *
 * Derived deterministically from a member's PUBLIC wallet address so ANY member can reproduce every
 * member's nickname from the on-chain roster (`Joined(address)` events). Pools are no longer anonymous;
 * the nickname is purely a friendly label. This is a pure client-side display function; it is NEVER
 * written to or read from the chain.
 */
import { encodePacked, keccak256 } from 'viem'
import { ADJECTIVES, NOUNS, NICKNAME_VERSION } from './nicknameWords'

const DOMAIN = `FAIRWINS_POOL_NICK_v${NICKNAME_VERSION}`

/**
 * Derive a stable nickname for a member from their wallet address.
 * @param {string} address the member's public wallet address
 * @param {string|number} [poolId] scopes the nickname to a pool (optional but recommended)
 * @returns {{ adjective: string, noun: string, label: string, suffix: string }}
 */
export function deriveNickname(address, poolId = '') {
  // Lowercase both so the SAME member renders the SAME two words for EVERYONE regardless of how the
  // address / pool were cased upstream (checksummed vs lowercase are the same account / pool).
  const addr = String(address || '').toLowerCase()
  const scope = String(poolId).toLowerCase()
  const h = BigInt(keccak256(encodePacked(['address', 'string', 'string'], [addr, scope, DOMAIN])))

  const adjCount = BigInt(ADJECTIVES.length)
  const nounCount = BigInt(NOUNS.length)
  const adjective = ADJECTIVES[Number(h % adjCount)]
  const noun = NOUNS[Number((h / adjCount) % nounCount)]

  // Short, stable disambiguator from the public address for the rare in-pool collision.
  const suffix = addr.slice(-2)

  return { adjective, noun, label: `${adjective} ${noun}`, suffix }
}
