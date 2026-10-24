/**
 * lib/format/amount — the shared display formatter (spec 102, FR-018).
 *
 * Every row of the data-model table, plus the staging case that motivated it: a native balance
 * of 2.006441459389172406 rendered raw into a 390px tile. The formatter shapes what is SHOWN;
 * these tests also pin that it never turns an unreadable value into a "0".
 */
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { formatUnitsForDisplay, formatDecimalForDisplay } from '../../lib/format/amount'

describe('formatUnitsForDisplay — the table', () => {
  it('null / undefined pass through as null (the caller renders "—")', () => {
    expect(formatUnitsForDisplay(null)).toBeNull()
    expect(formatUnitsForDisplay(undefined)).toBeNull()
    expect(formatUnitsForDisplay(undefined, 6)).toBeNull()
  })

  it('0n → "0"', () => {
    expect(formatUnitsForDisplay(0n)).toBe('0')
    expect(formatUnitsForDisplay('0', 6)).toBe('0')
    expect(formatUnitsForDisplay(0, 6)).toBe('0')
  })

  it('non-zero dust below 0.000001 → "< 0.000001"', () => {
    expect(formatUnitsForDisplay(1n)).toBe('< 0.000001') // 1 wei
    expect(formatUnitsForDisplay(999_999_999_999n)).toBe('< 0.000001') // just under 1e-6 ETH
  })

  it('0.000001 ≤ v < 1 → up to 6 fraction digits, trailing zeros trimmed', () => {
    expect(formatUnitsForDisplay(1_000_000_000_000n)).toBe('0.000001')
    expect(formatUnitsForDisplay(ethers.parseEther('0.5'))).toBe('0.5')
    expect(formatUnitsForDisplay(ethers.parseEther('0.123456789'))).toBe('0.123457')
    expect(formatUnitsForDisplay(ethers.parseEther('0.100000'))).toBe('0.1')
  })

  it('v ≥ 1 → up to 4 fraction digits, grouped', () => {
    expect(formatUnitsForDisplay(ethers.parseEther('1'))).toBe('1')
    expect(formatUnitsForDisplay(ethers.parseEther('9.9'))).toBe('9.9')
    expect(formatUnitsForDisplay(ethers.parseEther('1234567.891234'))).toBe('1,234,567.8912')
  })

  it('honours maxFractionDigits for values ≥ 1', () => {
    expect(formatUnitsForDisplay(ethers.parseEther('1.23456789'), 18, { maxFractionDigits: 2 })).toBe('1.23')
    expect(formatUnitsForDisplay(ethers.parseEther('1.23456789'), 18, { maxFractionDigits: 6 })).toBe('1.234568')
  })

  it('unparsable → null, never "0" and never a throw', () => {
    expect(formatUnitsForDisplay('abc')).toBeNull()
    expect(formatUnitsForDisplay('')).toBeNull()
    expect(formatUnitsForDisplay('1.5')).toBeNull() // base units are integers
    expect(formatUnitsForDisplay(NaN)).toBeNull()
    expect(formatUnitsForDisplay(Infinity)).toBeNull()
    expect(formatUnitsForDisplay(1.5)).toBeNull()
    expect(formatUnitsForDisplay({})).toBeNull()
    expect(formatUnitsForDisplay([])).toBeNull()
    expect(formatUnitsForDisplay(true)).toBeNull()
    expect(formatUnitsForDisplay(1n, 'eighteen')).toBeNull()
  })
})

describe('formatUnitsForDisplay — cases from the field', () => {
  it('the staging overflow: 2.006441459389172406 ETC shows as 2.0064', () => {
    expect(formatUnitsForDisplay(2006441459389172406n)).toBe('2.0064')
    expect(formatUnitsForDisplay('2006441459389172406', 18)).toBe('2.0064')
  })

  it('a 6-decimal USDC value', () => {
    expect(formatUnitsForDisplay(1_234_567_890n, 6)).toBe('1,234.5679')
    expect(formatUnitsForDisplay(250_000n, 6)).toBe('0.25')
    expect(formatUnitsForDisplay(1n, 6)).toBe('0.000001')
    expect(formatUnitsForDisplay(100_000_000n, 6)).toBe('100')
  })

  it('huge values are grouped', () => {
    expect(formatUnitsForDisplay(ethers.parseEther('1000000000'))).toBe('1,000,000,000')
    expect(formatUnitsForDisplay(ethers.parseEther('987654321.123456789'))).toBe('987,654,321.1235')
    expect(formatUnitsForDisplay(1_000_000_000_000_000n, 6)).toBe('1,000,000,000')
  })

  it('accepts an integer number of base units', () => {
    expect(formatUnitsForDisplay(1_500_000, 6)).toBe('1.5')
  })

  it('does not itself round what is sent: formatUnits still carries full precision', () => {
    const raw = 2006441459389172406n
    expect(ethers.formatUnits(raw, 18)).toBe('2.006441459389172406')
    expect(ethers.parseUnits(ethers.formatUnits(raw, 18), 18)).toBe(raw)
  })
})

describe('formatDecimalForDisplay — callers that already hold a decimal string', () => {
  it('null / undefined → null', () => {
    expect(formatDecimalForDisplay(null)).toBeNull()
    expect(formatDecimalForDisplay(undefined)).toBeNull()
  })

  it('applies the same table to a decimal string', () => {
    expect(formatDecimalForDisplay('0')).toBe('0')
    expect(formatDecimalForDisplay('0.0')).toBe('0')
    expect(formatDecimalForDisplay('0.0000001')).toBe('< 0.000001')
    expect(formatDecimalForDisplay('0.000001')).toBe('0.000001')
    expect(formatDecimalForDisplay('0.123456789')).toBe('0.123457')
    expect(formatDecimalForDisplay('0.5')).toBe('0.5')
    expect(formatDecimalForDisplay('2.006441459389172406')).toBe('2.0064')
    expect(formatDecimalForDisplay('9.9')).toBe('9.9')
    expect(formatDecimalForDisplay('4.0')).toBe('4')
    expect(formatDecimalForDisplay('1234567.891234')).toBe('1,234,567.8912')
    expect(formatDecimalForDisplay('1.23456789', { maxFractionDigits: 2 })).toBe('1.23')
  })

  it('accepts a plain number (TransferForm holds balances as numbers)', () => {
    expect(formatDecimalForDisplay(2.006441459389172406)).toBe('2.0064')
    expect(formatDecimalForDisplay(100)).toBe('100')
    expect(formatDecimalForDisplay(0)).toBe('0')
    expect(formatDecimalForDisplay(0.25)).toBe('0.25')
  })

  it('unparsable → null, never "0"', () => {
    expect(formatDecimalForDisplay('')).toBeNull()
    expect(formatDecimalForDisplay('   ')).toBeNull()
    expect(formatDecimalForDisplay('abc')).toBeNull()
    expect(formatDecimalForDisplay('12abc')).toBeNull()
    expect(formatDecimalForDisplay(NaN)).toBeNull()
    expect(formatDecimalForDisplay(-Infinity)).toBeNull()
    expect(formatDecimalForDisplay({})).toBeNull()
    expect(formatDecimalForDisplay(5n)).toBeNull() // base units belong to formatUnitsForDisplay
  })
})
