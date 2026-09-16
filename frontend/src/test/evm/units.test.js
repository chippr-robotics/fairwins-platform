import { describe, it, expect } from 'vitest'
import {
  formatUnits as ethersFormatUnits,
  parseUnits as ethersParseUnits,
} from 'ethers'
import { formatUnits, parseUnits, formatEther, parseEther } from '../../lib/evm/units'

// Parity cases measured against ethers v6 before the Phase 0 swap (spec 110 / #1591).
// The load-bearing one is BIGINT DECIMALS: a `decimals()` contract read is a bigint, ethers
// accepted it, and viem's own formatUnits throws InvalidDecimalsError on it.
describe('lib/evm/units — ethers-v6-compatible coercion over viem', () => {
  it('formatUnits accepts bigint decimals (the decimals() read case)', () => {
    expect(formatUnits(123456n, 4n)).toBe('12.3456')
  })

  it('formatUnits accepts bigint, integer-string and number values', () => {
    expect(formatUnits(123456n, 4)).toBe('12.3456')
    expect(formatUnits('123456', 4)).toBe('12.3456')
    expect(formatUnits(123456, 4)).toBe('12.3456')
  })

  it('formatUnits defaults to 18 decimals like ethers', () => {
    expect(formatUnits(1000000000000000000n)).toBe('1.0')
  })

  it('formatUnits still throws on unparsable input (ethers threw too) — never a silent zero', () => {
    expect(() => formatUnits('12.5', 4)).toThrow()
    expect(() => formatUnits('', 4)).toThrow() // BigInt('') is 0n — the fabricated-zero trap
    expect(() => formatUnits(NaN, 4)).toThrow()
    expect(() => formatUnits(null, 4)).toThrow()
    expect(() => formatUnits(true, 4)).toThrow()
    expect(() => formatUnits([], 4)).toThrow()
  })

  it('parseUnits round-trips and accepts bigint decimals', () => {
    expect(parseUnits('1.5', 6)).toBe(1500000n)
    expect(parseUnits('1.5', 6n)).toBe(1500000n)
    expect(parseUnits('1.5')).toBe(1500000000000000000n)
  })

  it('formatEther / parseEther match the fixed-18 pair', () => {
    expect(formatEther(1000000000000000000n)).toBe('1.0')
    expect(parseEther('1')).toBe(1000000000000000000n)
    expect(formatEther('2000000000000000000')).toBe('2.0')
  })

  it('formatUnits keeps the ethers decimal-point shape (25.0, not viem\'s 25)', () => {
    expect(formatUnits(25000000n, 6)).toBe('25.0')
    expect(formatUnits(0n, 6)).toBe('0.0')
  })

  // A 0-decimal unit has no fractional part, and ethers emits none: `formatUnits(123n, 0)` is
  // '123'. The point-restoring rule above would have appended one, inventing a precision the
  // token does not have — on a string surfaces render RAW into an amount field.
  it('emits NO decimal point at zero decimals, as ethers does', () => {
    expect(formatUnits(123n, 0)).toBe('123')
    expect(formatUnits(0n, 0)).toBe('0')
    expect(formatUnits(123n, 0n)).toBe('123')
  })
})

// The seam's contract is "indistinguishable from ethers at the boundary", which is a claim about
// ethers — so it is checked against ethers rather than against remembered strings. This is what
// caught the zero-decimals case above; a hand-written expectation would have agreed with the bug.
describe('lib/evm/units — differential parity with ethers v6', () => {
  const VALUES = [0n, 1n, 5n, 123n, 999n, 10n ** 6n, 10n ** 18n, 25n * 10n ** 18n, 1234567n, 2n ** 200n, 2n ** 256n - 1n]
  const DECIMALS = [0, 1, 2, 6, 8, 9, 18, 27]

  it('formatUnits agrees with ethers for every value × decimals pair', () => {
    for (const value of VALUES) {
      for (const decimals of DECIMALS) {
        expect(`${value}@${decimals}=${formatUnits(value, decimals)}`).toBe(
          `${value}@${decimals}=${ethersFormatUnits(value, decimals)}`,
        )
      }
    }
  })

  it('parseUnits agrees with ethers, including at zero decimals', () => {
    for (const [text, decimals] of [
      ['0', 18], ['1', 18], ['25.0', 18], ['1.234567', 6], ['0.000001', 6],
      ['1000000', 6], ['123', 0], ['7', 0],
    ]) {
      expect(parseUnits(text, decimals)).toBe(ethersParseUnits(text, decimals))
    }
  })
})
