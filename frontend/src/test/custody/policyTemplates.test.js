// Release 1.14.0 — the starter policy offered by default in the vault creation sheet.
// The two properties that matter are structural, not cosmetic: the rule set must never end in a
// silent deny-all (V2 denies anything no rule matches), and it must validate against the same
// validateRulesConfig the hand-composed path uses, or it could never be proposed.

import { describe, it, expect } from 'vitest'
import { getAddress } from 'ethers'
import {
  STARTER_DEFAULT_COOLDOWN_SECONDS,
  STARTER_DEFAULT_STABLE_WINDOW,
  isStarterPolicyAvailable,
  starterPolicyV2,
  starterStableAsset,
} from '../../lib/custody/policyTemplates'
import { ANY_ASSET, matchPreview, validateRulesConfig } from '../../lib/custody/policyV2'

// Chain 1337 carries the synced policy engine addresses used across the custody suites.
const POLICY_CHAIN = 1337
const PAYEE = '0x3333333333333333333333333333333333333333'

describe('starter policy template', () => {
  it('is available exactly where the ordered engine is', () => {
    expect(isStarterPolicyAvailable(POLICY_CHAIN)).toBe(true)
    // 999 has no policy engine — offering a starter there would be inventing availability.
    expect(isStarterPolicyAvailable(999)).toBe(false)
    expect(() => starterPolicyV2({ chainId: 999 })).toThrow(/not available/i)
  })

  it('caps the stable token and ends with a catch-all, in that order', () => {
    const { rules, cooldown, stable } = starterPolicyV2({ chainId: POLICY_CHAIN })
    expect(stable).not.toBeNull()
    expect(rules).toHaveLength(2)
    expect(getAddress(rules[0].asset)).toBe(getAddress(stable.address))
    expect(rules[0].windowLimit).toBeGreaterThan(0n)
    // The LAST rule must match anything, or every unnamed asset is denied by silence.
    expect(getAddress(rules[rules.length - 1].asset)).toBe(getAddress(ANY_ASSET))
    expect(rules[rules.length - 1].windowLimit).toBe(0n)
    expect(rules[rules.length - 1].approvalsRequired).toBe(0)
    expect(cooldown).toBe(STARTER_DEFAULT_COOLDOWN_SECONDS)
  })

  it('produces rules the composer itself would accept', () => {
    const { rules, cooldown } = starterPolicyV2({ chainId: POLICY_CHAIN })
    expect(() => validateRulesConfig(rules, cooldown)).not.toThrow()
  })

  it('never denies a plain native transfer — the catch-all governs it', () => {
    const { rules } = starterPolicyV2({ chainId: POLICY_CHAIN })
    const res = matchPreview(rules, { to: PAYEE, value: 10n ** 18n, data: '0x' })
    expect(res.matched).toBe(true)
    expect(res.ruleIndex).toBe(rules.length - 1)
  })

  it('governs a stable-token transfer by the capped rule, not the catch-all', () => {
    const { rules, stable } = starterPolicyV2({ chainId: POLICY_CHAIN })
    // ERC-20 transfer(PAYEE, 1)
    const data =
      '0xa9059cbb' + PAYEE.slice(2).padStart(64, '0') + (1n).toString(16).padStart(64, '0')
    const res = matchPreview(rules, { to: stable.address, value: 0n, data })
    expect(res.matched).toBe(true)
    expect(res.ruleIndex).toBe(0)
  })

  it('drops the capped rule when the member clears the amount, keeping the catch-all', () => {
    const { rules } = starterPolicyV2({ chainId: POLICY_CHAIN, stableWindowAmount: '' })
    expect(rules).toHaveLength(1)
    expect(getAddress(rules[0].asset)).toBe(getAddress(ANY_ASSET))
  })

  it('honours a member-chosen delay and refuses an unparseable amount', () => {
    expect(starterPolicyV2({ chainId: POLICY_CHAIN, cooldownSeconds: 0 }).cooldown).toBe(0)
    expect(() => starterPolicyV2({ chainId: POLICY_CHAIN, stableWindowAmount: 'lots' })).toThrow(
      /plain number/i,
    )
  })

  it('summarises itself from the encoded rules, including the delay', () => {
    const { summary } = starterPolicyV2({ chainId: POLICY_CHAIN })
    expect(summary.join(' ')).toMatch(/001 —/)
    expect(summary.join(' ')).toMatch(/24 hours/)
    expect(summary.join(' ')).toMatch(/must pass between fund movements/i)
  })

  it('reads the stable token strictly from the named chain', () => {
    expect(starterStableAsset(POLICY_CHAIN)?.address).toBeTruthy()
    expect(starterStableAsset(999)).toBeNull()
    expect(STARTER_DEFAULT_STABLE_WINDOW).toBe('500')
  })
})
