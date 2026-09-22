/**
 * Payout-matrix helpers for Wager Pool resolution (spec 034, address-based — Semaphore removed).
 *
 * The creator proposes an outcome by committing to a payout matrix: an array of { winner, amount } rows,
 * each winner identified by their PUBLIC wallet address (the address IS the "claim code"). The on-chain
 * proposalId / lockedOutcome is keccak256(abi.encode(PayoutEntry[])), computed identically here so the UI
 * can derive the id the creator proposes and that a claimant passes back. The matrix is fully public
 * (winners come straight from the roster), so it can be shared off-chain verbatim — only its hash lives
 * on-chain.
 */
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters } from 'viem'

// The contract's `lockedOutcome` is keccak256 over this exact encoding, so the parameter type is
// written once and shared by every hash below — a drifting copy would produce a hash the pool
// rejects, with nothing on screen to say why.
const PAYOUT_ENTRIES = parseAbiParameters('(address winner, uint256 amount)[]')

/** Normalise a row to { winner: checksummed address, amount: bigint }. */
function normEntry(e) {
  return { winner: getAddress(String(e.winner)), amount: BigInt(e.amount) }
}

/** keccak256(abi.encode(PayoutEntry[])) — equals the contract's lockedOutcome / proposalId. */
export function payoutMatrixHash(entries) {
  return keccak256(encodeAbiParameters(PAYOUT_ENTRIES, [entries.map(normEntry)]))
}

/** Sum of all row amounts (must equal the pool escrow = members * buyIn). */
export function payoutMatrixSum(entries) {
  return entries.reduce((acc, e) => acc + BigInt(e.amount), 0n)
}

/** Serialise the matrix for off-chain sharing (creator → winners). */
export function serializeMatrix(entries) {
  return JSON.stringify(entries.map((e) => ({ winner: getAddress(String(e.winner)), amount: String(e.amount) })))
}

/** Parse a shared matrix string back to rows; returns null on malformed input. */
export function parseMatrix(text) {
  try {
    const arr = JSON.parse(text)
    if (!Array.isArray(arr)) return null
    return arr.map((e) => ({ winner: getAddress(String(e.winner)), amount: String(BigInt(e.amount)) }))
  } catch {
    return null
  }
}

/**
 * Shared-proposal envelope. Because winners are public addresses, the matrix is fully shareable and the
 * old separate "display" annotation is no longer needed — the roster reads amounts straight from the
 * matrix. Kept as a versioned envelope for forward compatibility.
 */
export function serializeSharedProposal({ entries }) {
  return JSON.stringify({
    v: 2,
    matrix: entries.map((e) => ({ winner: getAddress(String(e.winner)), amount: String(e.amount) })),
  })
}

/**
 * Parse a shared proposal. Accepts the v2 envelope above OR a bare `PayoutEntry[]` array. Returns
 * { entries } or null on malformed input.
 */
export function parseSharedProposal(text) {
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      const entries = parseMatrix(text)
      return entries ? { entries } : null
    }
    if (parsed && Array.isArray(parsed.matrix)) {
      const entries = parseMatrix(JSON.stringify(parsed.matrix))
      return entries ? { entries } : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * Build a { winnerAddress(lowercased) → amount } lookup for the roster from a verified matrix. Only used
 * once the matrix hash has been verified against the on-chain proposalId. Winners are public, so no
 * separate display map is needed.
 */
export function payoutDisplayMap(entries) {
  if (!entries || !entries.length) return null
  const map = new Map()
  for (const e of entries) map.set(getAddress(String(e.winner)).toLowerCase(), BigInt(e.amount))
  return map
}
