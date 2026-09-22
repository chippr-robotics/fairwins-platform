import { describe, it, expect } from 'vitest'
import { isAddress as ethersIsAddress, getAddress as ethersGetAddress } from 'ethers'
import { isAddress as viemIsAddress } from 'viem'
import { isAddress, getAddress } from '../../lib/evm/address'

/*
 * Differential parity against ethers v6 (spec 110 / #1592).
 *
 * `isAddress` is the third ethers→viem divergence the migration has had to find and the first about
 * a VALIDATOR rather than a decoder — and it is the one where the obvious one-word fix
 * (`{ strict: false }`) is the unsafe direction. These cases were measured against ethers before
 * the swap; the assertions on `viemIsAddress` are deliberate, so this test FAILS if a future viem
 * release makes the seam redundant (at which point it can be deleted, on purpose, rather than
 * quietly kept).
 */
const LOWER = '0x1111111111111111111111111111111111111abc'
const CHECKSUMMED = ethersGetAddress(LOWER) // 0x…1aBc
const UPPER = `0x${LOWER.slice(2).toUpperCase()}`
const BAD_CHECKSUM = '0x1111111111111111111111111111111111111Abc' // one case flipped
const ALL_DIGITS = `0x${'1'.repeat(40)}`

describe('lib/evm/address — ethers-v6-compatible isAddress over viem', () => {
  it('accepts every form that carries no checksum information', () => {
    for (const value of [LOWER, UPPER, ALL_DIGITS]) {
      expect(isAddress(value), value).toBe(true)
      expect(ethersIsAddress(value), `ethers: ${value}`).toBe(true)
    }
  })

  it('accepts a correct mixed-case checksum', () => {
    expect(isAddress(CHECKSUMMED)).toBe(true)
    expect(ethersIsAddress(CHECKSUMMED)).toBe(true)
  })

  it('REJECTS a mixed-case address whose checksum is wrong — the typo EIP-55 exists to catch', () => {
    expect(isAddress(BAD_CHECKSUM)).toBe(false)
    expect(ethersIsAddress(BAD_CHECKSUM)).toBe(false)
    // The trap: viem's permissive setting waves it through, and viem's `getAddress` does not throw
    // on it either (ethers' did), so nothing downstream would catch it.
    expect(viemIsAddress(BAD_CHECKSUM, { strict: false })).toBe(true)
    expect(() => getAddress(BAD_CHECKSUM)).not.toThrow()
  })

  it('does not inherit viem strict mode’s refusal of an ALL-UPPERCASE address', () => {
    expect(viemIsAddress(UPPER)).toBe(false) // viem strict:true — the other direction's bug
    expect(ethersIsAddress(UPPER)).toBe(true)
    expect(isAddress(UPPER)).toBe(true)
  })

  it('rejects non-addresses without throwing, for callers that branch on it', () => {
    for (const value of [null, undefined, 42, {}, '', 'nope', '0x123', `0X${LOWER.slice(2)}`]) {
      expect(isAddress(value), String(value)).toBe(false)
    }
    // `0X`-prefixed is refused by both libraries, so the seam needs no special case for it.
    expect(ethersIsAddress(`0X${LOWER.slice(2)}`)).toBe(false)
  })

  it('getAddress checksums exactly as ethers did', () => {
    for (const value of [LOWER, UPPER, CHECKSUMMED]) {
      expect(getAddress(value), value).toBe(ethersGetAddress(value))
    }
  })
})
