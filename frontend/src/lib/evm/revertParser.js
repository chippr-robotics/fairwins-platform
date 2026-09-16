/**
 * A viem-backed `parseError` for `lib/chain/revertError.js` (spec 110 T023/T028).
 *
 * `revertError.js` deliberately imports nothing — it takes any object with
 * `parseError(data) => {name, args} | null`, so it cannot become a second place that decides which
 * ABI describes a failure. `errorParser(abi)` is that object, built on viem instead of an ethers
 * `Interface`, and it keeps the duck type EXACTLY: same method, same return shape, same null.
 *
 * Verified against `new Interface(abi).parseError(data)` on named errors with and without
 * arguments, and on the two builtins — `Error(string)` and `Panic(uint256)` decode identically in
 * both libraries even when the ABI does not declare them.
 *
 * TWO SHAPE DIFFERENCES ARE NORMALISED HERE rather than left for callers (divergence 12):
 *
 *   · **An UNKNOWN selector: ethers returned `null`, viem THROWS.** `extractRevert` walks five
 *     candidate payloads looking for one that decodes, so a throw per miss would work by accident
 *     through its catch — but the declared type says `null`, and a helper that throws where its
 *     contract says it returns null is a trap for the next caller.
 *   · **A no-argument error: ethers gave `[]`, viem gives `undefined`.** `describeRevert` renders
 *     `args.length > 0 ? Name(args) : Name`, so `undefined` would work through its `?? []` — again
 *     by accident. `[]` is what the type says.
 *
 * Both are cases where the wrong thing happens to work today and stops working the moment someone
 * writes a caller that trusts the signature.
 */
import { decodeErrorResult } from 'viem'
import { normalizeAbi } from '../chains/readContract'

/**
 * @param {Array} abi JSON ABI or human-readable signature strings (error fragments are enough)
 * @returns {{parseError: (data: string) => {name: string, args: unknown[]}|null}}
 */
export function errorParser(abi) {
  const parsed = normalizeAbi(abi)
  return {
    parseError(data) {
      try {
        const decoded = decodeErrorResult({ abi: parsed, data })
        if (!decoded?.errorName) return null
        return { name: decoded.errorName, args: Array.from(decoded.args ?? []) }
      } catch {
        // Not one of this ABI's errors — and NOT an exception, because that is what the caller's
        // declared contract promises and what ethers did.
        return null
      }
    },
  }
}
