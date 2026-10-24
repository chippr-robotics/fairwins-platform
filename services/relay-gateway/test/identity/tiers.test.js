/**
 * Assurance-tier ladder (spec 106, T002).
 *
 * These are cheap tests over pure functions, and they are here because the ladder is the one thing
 * every other part of the feature compares against. Two properties matter more than the rest:
 *
 *   1. An unknown tier must THROW, not degrade. Returning 0 would silently downgrade a caller to
 *      anonymous; returning -1 would silently satisfy every minimum. Both fail quietly, in opposite
 *      directions, and a route table typo would look like working software either way.
 *
 *   2. `app` must be unreachable from anything a web caller can present (FR-005). A web app cannot
 *      prove its identity to a server, so any code path that concluded otherwise would be claiming
 *      something untrue.
 */
import { describe, it, expect } from 'vitest'
import {
  TIERS,
  TIER_ORDER,
  OBSERVABLE_TIERS,
  isTier,
  rankOf,
  atLeast,
  maxTier,
  isProofOfApp,
} from '../../src/identity/tiers.js'

describe('assurance tiers', () => {
  it('orders the ladder lowest-first, with address between human and member', () => {
    expect(TIER_ORDER).toEqual(['anonymous', 'human', 'address', 'member', 'app'])
  })

  it('ranks `address` above `human` — an account is more accountable than a browser', () => {
    // A challenge token proves a browser existed for a moment. An account proves who is answerable
    // afterwards, and is revocable. If this ever inverts, a route asking for `address` would be
    // satisfiable by a challenge, which proves nothing about who is calling.
    expect(rankOf(TIERS.ADDRESS)).toBeGreaterThan(rankOf(TIERS.HUMAN))
  })

  it('ranks `member` above `address` without making it reachable by paying alone', () => {
    // `member` is `address` PLUS an active paid tier — it is strictly more evidence, never less.
    expect(rankOf(TIERS.MEMBER)).toBeGreaterThan(rankOf(TIERS.ADDRESS))
  })

  describe('rankOf', () => {
    it('throws on an unknown tier rather than degrading in either direction', () => {
      expect(() => rankOf('superuser')).toThrow(TypeError)
      expect(() => rankOf(undefined)).toThrow(TypeError)
      expect(() => rankOf(null)).toThrow(TypeError)
      expect(() => rankOf(2)).toThrow(TypeError) // an ordinal is not a tier
    })

    it('rejects a numeric ordinal, so an ordinal can never arrive from a client', () => {
      // Ordinals are a comparison detail. If a number were accepted anywhere, a caller could send
      // one and renumbering the ladder would become an observable, breaking change.
      for (let i = 0; i < TIER_ORDER.length; i++) expect(isTier(i)).toBe(false)
    })
  })

  describe('atLeast', () => {
    it('satisfies a minimum with the exact tier or anything above it', () => {
      expect(atLeast(TIERS.ADDRESS, TIERS.ADDRESS)).toBe(true)
      expect(atLeast(TIERS.MEMBER, TIERS.ADDRESS)).toBe(true)
      expect(atLeast(TIERS.HUMAN, TIERS.ADDRESS)).toBe(false)
      expect(atLeast(TIERS.ANONYMOUS, TIERS.HUMAN)).toBe(false)
    })

    it('lets every tier satisfy an anonymous minimum', () => {
      // Read routes sit at `anonymous` so they never refuse for want of a tier (FR-006). A caller
      // who HAS proven something must not be worse off than one who has not.
      for (const t of TIER_ORDER) expect(atLeast(t, TIERS.ANONYMOUS)).toBe(true)
    })
  })

  describe('maxTier', () => {
    it('folds two verdicts to the higher one, in either argument order', () => {
      expect(maxTier(TIERS.HUMAN, TIERS.MEMBER)).toBe(TIERS.MEMBER)
      expect(maxTier(TIERS.MEMBER, TIERS.HUMAN)).toBe(TIERS.MEMBER)
      expect(maxTier(TIERS.ANONYMOUS, TIERS.ANONYMOUS)).toBe(TIERS.ANONYMOUS)
    })
  })

  describe('isProofOfApp — FR-005', () => {
    it('is false for every tier a web caller can reach', () => {
      // This is the assertion that keeps the product honest. Presenting a challenge AND a grant
      // still proves nothing about WHICH application sent the request.
      for (const t of [TIERS.ANONYMOUS, TIERS.HUMAN, TIERS.ADDRESS, TIERS.MEMBER]) {
        expect(isProofOfApp(t)).toBe(false)
      }
    })

    it('is true only for the attestation tier, which nothing currently issues', () => {
      expect(isProofOfApp(TIERS.APP)).toBe(true)
    })
  })

  describe('OBSERVABLE_TIERS — FR-036 bounded labels', () => {
    it('excludes the unreachable tier so no metric can claim it', () => {
      expect(OBSERVABLE_TIERS).not.toContain(TIERS.APP)
    })

    it('is a small fixed set, never derived from request content', () => {
      // Series count must be a function of the ladder, not of usage. A label built from a caller's
      // address or a wager id outgrows the metrics tier in days.
      expect(OBSERVABLE_TIERS.length).toBe(TIER_ORDER.length - 1)
      expect(Object.isFrozen(OBSERVABLE_TIERS)).toBe(true)
    })
  })

  it('freezes the exported tables so a consumer cannot mutate the ladder', () => {
    expect(Object.isFrozen(TIERS)).toBe(true)
    expect(Object.isFrozen(TIER_ORDER)).toBe(true)
  })
})
