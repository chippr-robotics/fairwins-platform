/**
 * Signature splitting seam (spec 110 — T020 wrote it, T028 moved it here to be shared).
 *
 * `ethers.Signature.from(hex)` has no correct viem replacement, and viem's `parseSignature` is
 * wrong for it in TWO independent ways — both silent-ish, both measured before this was written:
 *
 *   1. **It refuses the 64-byte EIP-2098 COMPACT form**, which ethers accepted. That matters
 *      wherever the bytes came from somebody else: Protect ▸ Verify exists to check other people's
 *      proofs (spec 084), so refusing an encoding ethers understood turns a perfectly good proof
 *      into "unverifiable" — a wrong answer dressed as an honest one.
 *   2. **It returns `v` as a BIGINT** (`28n`) where ethers returned a NUMBER (`28`). A `v` that
 *      rides into an EIP-3009 authorization object (`lib/pools/gasless.js`) is handed to a relayer
 *      and serialized, and `JSON.stringify` throws on a bigint. Loud rather than silent, but it is
 *      still not the same value, and "it will throw somewhere" is not a migration plan.
 *
 * So the split is written out. Checked against `ethers.Signature.from` over 200 real typed-data
 * signatures in BOTH encodings — 400 comparisons, r/s/v identical every time — before the swap.
 *
 * Returns `0x`-prefixed `r`/`s` and a numeric `v` (27/28), which is the ethers shape callers on the
 * wire need. `yParity` (0/1) is there for `@noble/curves`, which wants the recovery bit.
 */

const TOP_BIT = 1n << 255n

/**
 * @param {unknown} signature 65-byte `r‖s‖v` or 64-byte EIP-2098 compact hex
 * @returns {{r: string, s: string, yParity: 0|1, v: 27|28}|null} null when the bytes are not a
 *   signature — NEVER a throw and never a guessed value, because a 900-byte WebAuthn envelope
 *   reaching here is expected rather than exceptional.
 */
export function splitSignature(signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) return null
  const hex = signature.slice(2)

  if (hex.length === 130) {
    let yParity = parseInt(hex.slice(128, 130), 16)
    if (yParity === 27 || yParity === 28) yParity -= 27
    if (yParity !== 0 && yParity !== 1) return null
    return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, yParity, v: 27 + yParity }
  }

  if (hex.length === 128) {
    // EIP-2098: yParity is packed into the top bit of s.
    const yParityAndS = BigInt(`0x${hex.slice(64, 128)}`)
    const yParity = Number((yParityAndS & TOP_BIT) >> 255n)
    return {
      r: `0x${hex.slice(0, 64)}`,
      s: `0x${(yParityAndS & (TOP_BIT - 1n)).toString(16).padStart(64, '0')}`,
      yParity,
      v: 27 + yParity,
    }
  }

  return null
}
