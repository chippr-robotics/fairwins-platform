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
 *
 * A THIRD (divergence 13) is the error-path twin of the multi-output read defect that Phase 1
 * found: **ethers' `parseError` returned args addressable BY NAME as well as by index; viem's
 * `decodeErrorResult` returns a bare array.** `revert.args.nextAllowedAt` is therefore `undefined`
 * — not an error, not a failed decode, just a field that quietly is not there, which is exactly
 * how the Supply list came to render empty. `CallsignPanel.describeError` reads that very name and
 * survives only because it happens to carry an `args?.[0]` fallback; without one it would have
 * dropped the time out of "you can change it again after …" and told the member nothing.
 *
 * So the names are attached here, the same way `readContract.js#withOutputNames` attaches them:
 * non-enumerably, so the value still behaves as, spreads as and compares equal to the array it is.
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
        return { name: decoded.errorName, args: withArgNames(decoded) }
      } catch {
        // Not one of this ABI's errors — and NOT an exception, because that is what the caller's
        // declared contract promises and what ethers did.
        return null
      }
    },
  }
}

/**
 * Give a decoded error's args their parameter NAMES back (divergence 13).
 *
 * Non-enumerable, so `JSON.stringify`, spreading and `toEqual` see the plain array they saw
 * before — only `args.someName` is added. A parameter with no name in the ABI, or one whose name
 * would collide with an array property, is left alone rather than guessed at.
 */
function withArgNames(decoded) {
  const args = Array.from(decoded.args ?? [])
  const inputs = decoded.abiItem?.inputs
  if (!Array.isArray(inputs) || inputs.length !== args.length) return args
  for (let i = 0; i < inputs.length; i += 1) {
    const name = inputs[i]?.name
    if (!name || name in args) continue
    Object.defineProperty(args, name, { value: args[i], enumerable: false, configurable: true })
  }
  return args
}
