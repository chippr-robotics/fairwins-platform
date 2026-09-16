import {
  formatUnits as viemFormatUnits,
  parseUnits as viemParseUnits,
  formatEther as viemFormatEther,
  parseEther as viemParseEther,
} from 'viem'

/**
 * Unit conversion seam (spec 110, Phase 0 — issue #1591).
 *
 * viem-backed, ethers-v6-compatible at the input boundary. viem's formatUnits/parseUnits
 * take `(bigint, number)` strictly; ethers accepted BigNumberish values and — the case that
 * actually occurs here — BIGINT decimals, because a `decimals()` contract read comes back as
 * a bigint. A blind swap turns every `formatUnits(balance, decimals)` over a read result into
 * an InvalidDecimalsError, so the coercion lives once, here, instead of at ~50 call sites.
 *
 * Throw semantics are preserved: `BigInt(value)` rejects a non-integer string ('12.5') the
 * same way ethers' BigNumberish parsing did, and a NaN decimals still fails inside viem.
 * Call sites that can tighten to `(bigint, number)` do so as they move onto the read/write
 * seams (Phases 1–2), at which point they may import viem directly and leave this seam.
 */
// ethers accepted BigNumberish: bigint, integer number, integer decimal/hex string. Everything
// else THREW — and `BigInt()` alone does not reproduce that: BigInt('') and BigInt([]) are 0n,
// BigInt(true) is 1n, which turns "unparsable" into a fabricated zero (Constitution III).
function toBigIntStrict(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string' && value.trim() !== '') return BigInt(value)
  throw new TypeError(`invalid BigNumberish value: ${String(value)}`)
}

// ethers emits a decimal point for a whole value ('25.0') where viem trims to '25'. Surfaces
// render this string raw (a Max button fills an input with it), so the ethers shape is
// preserved — restyling every rendered balance is not a Phase 0 decision.
//
// EXCEPT at zero decimals, where ethers emits no point at all (`formatUnits(123n, 0)` is
// '123', not '123.0'). A 0-decimal unit has no fractional part to show, so appending one
// would invent a precision the token does not have — and this seam's whole job is to be
// indistinguishable from what it replaced.
const withPoint = (s, decimals) => (decimals === 0 || s.includes('.') ? s : `${s}.0`)

export function formatUnits(value, decimals = 18) {
  const places = Number(decimals)
  return withPoint(viemFormatUnits(toBigIntStrict(value), places), places)
}

export function parseUnits(value, decimals = 18) {
  return viemParseUnits(typeof value === 'string' ? value : String(value), Number(decimals))
}

export function formatEther(value) {
  return withPoint(viemFormatEther(toBigIntStrict(value)), 18)
}

export function parseEther(value) {
  return viemParseEther(typeof value === 'string' ? value : String(value))
}
