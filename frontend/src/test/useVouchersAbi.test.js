import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { MEMBERSHIP_VOUCHER_ABI } from '../abis/MembershipVoucher'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'
import { normalizeTermsHash } from '../hooks/useVouchers'
import { getCurrentDocument } from '../utils/legalDocs'

// Regression guard for the "(intermediate value).getTierConfig is not a function" bug:
// useVouchers builds ethers contracts from these ABIs and calls the functions below.
// If a synced/mirrored ABI ever drops one, minting/redeeming breaks at runtime — these
// tests fail loudly at build time instead.
const hasFn = (abi, name) =>
  abi.some((e) => e.type === 'function' && e.name === name)

describe('useVouchers ABI surface', () => {
  it('MembershipVoucher ABI exposes the functions the voucher contract is called with', () => {
    for (const fn of ['mint', 'voucherInfo', 'ownerOf']) {
      expect(hasFn(MEMBERSHIP_VOUCHER_ABI, fn), `voucher ABI missing ${fn}`).toBe(true)
    }
  })

  it('MembershipManager ABI exposes the functions the manager contract is called with', () => {
    for (const fn of ['getTierConfig', 'redeemVoucher']) {
      expect(hasFn(MEMBERSHIP_MANAGER_ABI, fn), `manager ABI missing ${fn}`).toBe(true)
    }
  })

  // Regression guard for the "redeemVoucher never records terms" audit finding (spec 026
  // FR-013/SC-005): the ABI must still take a second bytes32 param, or the wiring in
  // useVouchers.js has nothing to pass the resolved terms hash into.
  it('redeemVoucher takes (voucherId, acceptedTermsHash) — the second param the terms fix relies on', () => {
    const fn = MEMBERSHIP_MANAGER_ABI.find((e) => e.type === 'function' && e.name === 'redeemVoucher')
    expect(fn.inputs.map((i) => i.type)).toEqual(['uint256', 'bytes32'])
    expect(fn.inputs[1].name).toBe('acceptedTermsHash')
  })
})

// Spec 026 FR-013/SC-005: redeemVoucher must record the same in-force Terms hash the purchase
// rail records (getCurrentDocument('terms').hash, a bare 64-char hex digest), normalized into
// the 0x-bytes32 form the contract expects. See useVouchers.js#normalizeTermsHash.
describe('useVouchers termsHash normalization (spec 026 FR-013/SC-005)', () => {
  it('prefixes a bare 64-char hex digest (the legalDocs.js shape) with 0x', () => {
    const bare = getCurrentDocument('terms').hash
    expect(bare.startsWith('0x')).toBe(false)
    expect(bare).toHaveLength(64)
    expect(normalizeTermsHash(bare)).toBe(`0x${bare}`)
  })

  it('leaves an already-0x-prefixed hash untouched', () => {
    const hash = '0x' + 'ab'.repeat(32)
    expect(normalizeTermsHash(hash)).toBe(hash)
  })

  it('falls back to the zero hash (a contract-side no-op) for undefined/null/empty', () => {
    expect(normalizeTermsHash(undefined)).toBe(ethers.ZeroHash)
    expect(normalizeTermsHash(null)).toBe(ethers.ZeroHash)
    expect(normalizeTermsHash('')).toBe(ethers.ZeroHash)
  })

  it('never resolves to the zero hash for the real in-force terms document', () => {
    // This is the exact regression the audit finding named: onRedeem used to pass `undefined`,
    // which normalizes to ZeroHash and makes the contract's _recordTerms no-op silently.
    const normalized = normalizeTermsHash(getCurrentDocument('terms').hash)
    expect(normalized).not.toBe(ethers.ZeroHash)
    expect(normalized).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
