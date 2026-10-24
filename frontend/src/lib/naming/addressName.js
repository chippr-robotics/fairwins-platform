/**
 * Deterministic two-word display names for wallet addresses (spec 040, US1 / FR-002).
 *
 * When an opponent has no address-book nickname and no ENS reverse record, the My Wagers card still
 * needs a memorable, human-readable label instead of a bare `0x1234…ABCD`. This derives a stable
 * adjective-noun name from the address itself: the SAME address always renders the SAME name, so a
 * repeat opponent is recognizable across wagers and sessions.
 *
 * It reuses ONLY the shared vocabulary from the pool nicknames (spec 034); it is intentionally a
 * separate function from `deriveNickname`, which is keyed on a Semaphore identity commitment and is
 * pool-scoped. This one is address-keyed and pure client-side display — never written to chain.
 */
import { keccak256, stringToBytes } from 'viem'
import { ADJECTIVES, NOUNS } from '../pools/nicknameWords'

const DOMAIN = 'FAIRWINS_ADDRESS_NAME_v1'

/**
 * Derive a stable two-word name for an address.
 *
 * @param {string} address a 0x-prefixed 20-byte hex address
 * @returns {{ adjective: string, noun: string, label: string }}
 * @throws if `address` is not a hex-like string
 */
export function deriveAddressName(address) {
  if (typeof address !== 'string' || !address.startsWith('0x')) {
    throw new Error('deriveAddressName: a 0x-prefixed address is required')
  }
  // Lowercase so a checksummed `0xAbC…` and a lowercase `0xabc…` — the same account — hash identically.
  const normalized = address.toLowerCase()
  const h = BigInt(keccak256(stringToBytes(DOMAIN + normalized)))

  const adjCount = BigInt(ADJECTIVES.length)
  const nounCount = BigInt(NOUNS.length)
  const adjective = ADJECTIVES[Number(h % adjCount)]
  const noun = NOUNS[Number((h / adjCount) % nounCount)]

  return { adjective, noun, label: `${adjective} ${noun}` }
}

export default deriveAddressName
