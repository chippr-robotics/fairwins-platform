/**
 * The never-stranded fallback's classifier (spec 050 FR-007), pinned against the 2026-08-26
 * production incident: the paymaster's EntryPoint deposit was empty, the bundler answered
 * "UserOperation reverted during simulation with reason: AA31 paymaster deposit too low",
 * and the classifier's generic revert patterns swallowed it BEFORE the AA3x intent applied —
 * so members saw a raw viem dump instead of the self-funded retry.
 *
 * The rule: every AA3x (the EntryPoint's PAYMASTER range) is a sponsorship problem — retry
 * self-funded. AA1x/AA2x and execution reverts are the member's op — surface, never re-send.
 */
import { describe, it, expect } from 'vitest'
import { isSponsorshipUnavailable } from '../../lib/passkey/sendBatch'

// The verbatim shape viem surfaced in production (details carries the bundler's reason).
const INCIDENT_MESSAGE =
  'Paymaster deposit for the User Operation is too low. This could arise when: - the Paymaster has ' +
  'deposited less than the expected amount via the `deposit` function ... Details: UserOperation ' +
  'reverted during simulation with reason: AA31 paymaster deposit too low Version: viem@2.55.19'

describe('isSponsorshipUnavailable — paymaster AA3x beats the generic revert patterns', () => {
  it('classifies the verbatim empty-deposit incident message as sponsorship-unavailable', () => {
    expect(isSponsorshipUnavailable(new Error(INCIDENT_MESSAGE))).toBe(true)
  })

  it('classifies every AA3x as sponsorship-unavailable, even phrased as a simulation revert', () => {
    for (const code of ['AA30 paymaster not deployed', 'AA31 paymaster deposit too low', 'AA33 reverted (or OOG)', 'AA34 signature error']) {
      const bundlerPhrasing = `UserOperation reverted during simulation with reason: ${code}`
      expect(isSponsorshipUnavailable(new Error(bundlerPhrasing)), code).toBe(true)
    }
  })

  it("still surfaces the member's own failures — a self-funded retry would fail identically", () => {
    for (const msg of [
      'UserOperation reverted during simulation with reason: AA21 didn\'t pay prefund',
      'UserOperation reverted during simulation with reason: AA10 sender already constructed',
      'execution reverted: ERC20: transfer amount exceeds balance',
      'UserOperation reverted during simulation with reason: 0x... out of gas',
    ]) {
      expect(isSponsorshipUnavailable(new Error(msg)), msg).toBe(false)
    }
  })

  it('still treats endpoint refusals and transport failures as sponsorship-unavailable', () => {
    for (const msg of [
      'sponsorship pool cannot cover this operation; self-submit',
      'killswitch_active: sponsorship is temporarily paused; self-submit',
      'fetch failed',
      'HTTP 503',
    ]) {
      expect(isSponsorshipUnavailable(new Error(msg)), msg).toBe(true)
    }
  })

  it('reads the reason from err.details where viem puts it, not only err.message', () => {
    const err = new Error('User operation failed.')
    err.details = 'UserOperation reverted during simulation with reason: AA31 paymaster deposit too low'
    expect(isSponsorshipUnavailable(err)).toBe(true)
  })
})
