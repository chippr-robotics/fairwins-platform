import { isAddress as viemIsAddress, getAddress } from 'viem'

/**
 * Address validation seam (spec 110, Phase 1 — issue #1592).
 *
 * `isAddress` is the third ethers→viem divergence this migration has had to find, and the first
 * that is about a VALIDATOR rather than a decoder. Neither of viem's two settings reproduces what
 * ethers did, and they are wrong in opposite directions:
 *
 *   input                         ethers   viem strict:true   viem strict:false
 *   all-lowercase                 accept   accept             accept
 *   correct mixed-case checksum   accept   accept             accept
 *   ALL-UPPERCASE                 accept   REJECT             accept
 *   mixed case, wrong checksum    REJECT   reject             ACCEPT
 *
 * ethers checks a checksum only when the string CARRIES one — i.e. when it is mixed case
 * (`/([A-F].*[a-f])|([a-f].*[A-F])/`). An all-lowercase or all-uppercase address has no checksum
 * information in it, so there is nothing to verify; a mixed-case one that fails is a typo, which is
 * the entire reason EIP-55 exists.
 *
 * Both viem behaviours are bugs here, and they are not equally bad. `strict: true` REFUSES a valid
 * all-uppercase address — a member pasting one is told it is not an address. `strict: false`
 * ACCEPTS a mistyped mixed-case one, which is the failure the checksum was there to catch, and it
 * does so silently because viem's `getAddress` (unlike ethers') does not throw on a bad checksum
 * either — it just re-checksums whatever it was handed. So "pass `{ strict: false }` to be
 * permissive" is the tempting one-word fix and is the one that loses the safety property.
 *
 * `getAddress` is re-exported so a converted module takes both halves from one place.
 */
export { getAddress }

/** @param {unknown} value @returns {boolean} true where ethers' `isAddress` returned true. */
export function isAddress(value) {
  if (typeof value !== 'string') return false
  // Shape first (and the `0X`-prefixed form is rejected by both libraries, so this covers it).
  if (!viemIsAddress(value, { strict: false })) return false
  const body = value.slice(2)
  const carriesChecksum = /[A-F]/.test(body) && /[a-f]/.test(body)
  return !carriesChecksum || viemIsAddress(value)
}
