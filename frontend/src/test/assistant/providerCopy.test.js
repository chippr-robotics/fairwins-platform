/**
 * Assistant provider copy (spec 104) — the shared sentences, and the one URL a member follows.
 *
 * `gutterTokenSignupUrl` is tested from both sides on purpose. NO tenant declares a referral code
 * today, so the decorated branch is dead in every rendered surface: without a test it would ship
 * unexercised and only be discovered by the first tenant that registers one. And because the value
 * is interpolated into a URL, the shape check is re-run here rather than trusted to the manifest
 * validator — a build whose manifest slipped past the gate must not be able to redirect the link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ assistantSettings: {} }))

vi.mock('../../config/tenant', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, tenantAssistantSettings: () => m.assistantSettings }
})

import {
  PROVIDER_COST_LINES,
  describeTestOutcome,
  errorCopy,
  gutterTokenSignupUrl,
  hasGutterTokenReferral,
  keySheetLead,
  providerBadgeText,
  toolSubject,
} from '../../components/assistant/providerCopy'
import { GUTTERTOKEN_SIGNUP_URL } from '../../lib/assistant/providers/guttertoken'

beforeEach(() => {
  m.assistantSettings = {}
})

describe('gutterTokenSignupUrl', () => {
  it('is the plain signup link when the tenant declares no referral code', () => {
    expect(gutterTokenSignupUrl()).toBe(GUTTERTOKEN_SIGNUP_URL)
    expect(hasGutterTokenReferral()).toBe(false)
  })

  it('carries ?ref=<code> when the manifest declares one', () => {
    m.assistantSettings = { guttertokenReferralCode: 'FAIRWINS-2026_a' }
    expect(gutterTokenSignupUrl()).toBe(`${GUTTERTOKEN_SIGNUP_URL}?ref=FAIRWINS-2026_a`)
    expect(hasGutterTokenReferral()).toBe(true)
  })

  it('refuses a code that could re-point the link, falling back to the plain one', () => {
    for (const bad of ['a b', 'x?y=1', '../evil', 'a'.repeat(65), 42, null]) {
      m.assistantSettings = { guttertokenReferralCode: bad }
      expect(gutterTokenSignupUrl()).toBe(GUTTERTOKEN_SIGNUP_URL)
    }
  })
})

describe('keySheetLead', () => {
  it('tells a passkey member to use an e-mail address — GutterToken cannot see their account', () => {
    const lead = keySheetLead('passkey')
    expect(lead).toMatch(/cannot sign GutterToken's wallet sign-in/)
    expect(lead).toMatch(/e-mail address/)
  })

  it('offers a classic-wallet member the same wallet, or an e-mail address', () => {
    expect(keySheetLead('injected')).toMatch(/the same wallet you use here, or with an e-mail address/)
  })

  it('never claims FairWins can sign the member in over there, on either branch', () => {
    for (const method of ['passkey', 'injected', null, undefined]) {
      expect(keySheetLead(method)).not.toMatch(/we (will )?(sign|log|connect) you/i)
    }
  })
})

describe('the rail is named, and its cost is stated', () => {
  it('names each rail in the chat header', () => {
    expect(providerBadgeText('fairwins')).toBe('Answered by FairWins')
    expect(providerBadgeText('guttertoken')).toBe('Answered by GutterToken on your credits')
    expect(providerBadgeText(null)).toBeNull()
  })

  it('states, for GutterToken, that FairWins is not in the path and charges nothing', () => {
    expect(PROVIDER_COST_LINES.guttertoken).toMatch(/straight to GutterToken/)
    expect(PROVIDER_COST_LINES.guttertoken).toMatch(/FairWins never sees them and charges nothing/)
  })

  it('never quotes a rate or a balance — FairWins cannot read either', () => {
    const everything = [
      ...Object.values(PROVIDER_COST_LINES),
      keySheetLead('passkey'),
      keySheetLead('injected'),
      describeTestOutcome({ ok: true, models: ['a'] }).text,
      errorCopy({ state: 'out_of_credit' }, 'guttertoken'),
    ].join(' ')
    expect(everything).not.toMatch(/\$\d|\d+\s*(credits?|USD)\b|per 1[MK]/i)
  })
})

describe('describeTestOutcome — three outcomes, never a green tick', () => {
  it('accepts, with the model count when there is one', () => {
    expect(describeTestOutcome({ ok: true, models: ['a', 'b'] })).toEqual({
      tone: 'ok',
      text: 'GutterToken accepted this key — 2 models available.',
    })
  })

  it('reports a refusal as a refusal', () => {
    expect(describeTestOutcome({ ok: false, state: 'key_invalid' }).tone).toBe('refused')
  })

  it('says an unreachable check proves NOTHING about the key', () => {
    const out = describeTestOutcome({ ok: false, state: 'unreachable' })
    expect(out.tone).toBe('unknown')
    expect(out.text).toMatch(/says nothing about the key itself/)
  })

  it('handles key_missing — outside testGutterTokenKey\'s enum, returned by testStoredGutterTokenKey', () => {
    // Falling through to the generic sentence here would tell a member their key was rejected when
    // there is simply no key saved.
    expect(describeTestOutcome({ ok: false, state: 'key_missing' }).text).toMatch(
      /no GutterToken key saved on this device to test/i
    )
  })
})

describe('errorCopy — the rail decides what a quota MEANS', () => {
  it('names GutterToken\'s own per-network rate limit', () => {
    expect(errorCopy({ state: 'quota' }, 'guttertoken')).toMatch(/rate-limiting requests from your network/)
  })

  it('keeps the gateway\'s own message on the FairWins rail', () => {
    expect(errorCopy({ state: 'quota', message: 'Budget spent.' }, 'fairwins')).toBe('Budget spent.')
  })

  it('never leaks a raw transport message for a state it knows', () => {
    expect(errorCopy({ state: 'key_invalid', message: 'HTTP 401 sk-secret' }, 'guttertoken')).not.toMatch(/sk-/)
  })
})

describe('toolSubject — a new tool is never invisible', () => {
  it('uses the member-facing subject for a known tool', () => {
    expect(toolSubject({ name: 'get_wagers' })).toBe('your wagers')
  })

  it('humanises an unknown tool rather than rendering nothing', () => {
    expect(toolSubject({ name: 'get_something_new' })).toBe('something new')
  })

  it('prefers an event\'s own title', () => {
    expect(toolSubject({ name: 'get_wagers', title: 'your open bets' })).toBe('your open bets')
  })
})
