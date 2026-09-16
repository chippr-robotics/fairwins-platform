import { describe, it, expect } from 'vitest'
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
})
