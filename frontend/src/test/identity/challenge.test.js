/**
 * Client challenge lib (spec 106 slice 2, #1444 / T019).
 *
 * The property this file guards hardest: EVERY failure mode is silent (FR-017). An unreachable
 * challenge service, a script that will not load, a widget that errors — each leaves the visitor
 * browsing at the anonymous ceiling with NOTHING rendered, because an outage at a bot-check is
 * not evidence about the person, and "verification failed" on an honest visitor's screen is the
 * exact harm the requirement forbids.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  challengeHeaders,
  challengeConfigured,
  ensureChallengeToken,
  __resetChallengeForTests,
} from '../../lib/identity/challenge'

/** A minimal turnstile stub the loader "loads". */
function stubTurnstile({ token = 'tok-1', fail = false } = {}) {
  return {
    rendered: [],
    render(container, opts) {
      this.rendered.push({ container, opts })
      if (fail) opts['error-callback']?.()
      else opts.callback?.(token)
      return this.rendered.length
    },
    reset: vi.fn(),
  }
}

beforeEach(() => {
  __resetChallengeForTests()
  delete globalThis.turnstile
  vi.unstubAllEnvs()
})

describe('dormancy — no sitekey means NOTHING happens', () => {
  it('reports unconfigured and attaches no header', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', '')
    expect(challengeConfigured()).toBe(false)
    await ensureChallengeToken({})
    expect(challengeHeaders()).toEqual({})
  })

  it('adds no script tag and touches no DOM', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', '')
    await ensureChallengeToken({ document })
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull()
    expect(document.querySelector('[data-testid="challenge-container"]')).toBeNull()
  })
})

describe('acquisition', () => {
  it('renders the widget and holds the token for header attachment', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    globalThis.turnstile = stubTurnstile({ token: 'tok-alpha' })
    await ensureChallengeToken({ document })
    expect(challengeHeaders()).toEqual({ 'X-FairWins-Challenge': 'tok-alpha' })
  })

  it('keeps the widget container OUT of the accessibility tree until a surface opts it in', async () => {
    // An off-screen iframe left in the tab order is a keyboard trap nobody can see — the a11y
    // half of "most visitors never see the widget".
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    globalThis.turnstile = stubTurnstile()
    await ensureChallengeToken({ document })
    const container = document.querySelector('[data-testid="challenge-container"]')
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.tabIndex).toBe(-1)
  })

  it('is idempotent while the token is fresh — one widget, not one per call', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    const ts = stubTurnstile()
    globalThis.turnstile = ts
    await ensureChallengeToken({ document })
    await ensureChallengeToken({ document })
    await ensureChallengeToken({ document })
    expect(ts.rendered.length).toBe(1)
  })

  it('hands the interactive escalation to the surface that asked, and only then', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    let escalated = null
    globalThis.turnstile = {
      render(container, opts) {
        opts['before-interactive-callback']?.()
        return 1
      },
      reset: vi.fn(),
    }
    await ensureChallengeToken({ document, onInteractive: (el) => { escalated = el } })
    expect(escalated).not.toBeNull()
  })
})

describe('silent degradation (FR-017) — no failure ever renders', () => {
  it('a script that will not load leaves headers empty and throws nothing', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    // No globalThis.turnstile and jsdom will not actually fetch the script; onload never fires.
    // ensureChallengeToken must resolve without hanging the caller…
    const doc = {
      createElement: () => { throw new Error('no DOM for you') },
      head: null,
      body: null,
      contains: () => false,
    }
    await expect(ensureChallengeToken({ document: doc })).resolves.toBeUndefined()
    expect(challengeHeaders()).toEqual({})
  })

  it('a widget error clears the token, sets a cooldown, and surfaces nothing', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    const ts = stubTurnstile({ fail: true })
    globalThis.turnstile = ts
    await ensureChallengeToken({ document })
    expect(challengeHeaders()).toEqual({})
    // Cooldown: the next opportunistic call does not immediately re-render into the failure.
    await ensureChallengeToken({ document })
    expect(ts.rendered.length).toBe(1)
  })

  it('an expired token stops being attached rather than riding along stale', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    let expire
    globalThis.turnstile = {
      render(container, opts) {
        opts.callback('tok-1')
        expire = opts['expired-callback']
        return 1
      },
      reset: vi.fn(),
    }
    await ensureChallengeToken({ document })
    expect(challengeHeaders()).toEqual({ 'X-FairWins-Challenge': 'tok-1' })
    expire()
    expect(challengeHeaders()).toEqual({})
  })
})

describe('nothing persists', () => {
  it('writes no token to localStorage', async () => {
    vi.stubEnv('VITE_CHALLENGE_SITEKEY', 'real-sitekey')
    globalThis.turnstile = stubTurnstile({ token: 'tok-persist-check' })
    await ensureChallengeToken({ document })
    expect(JSON.stringify({ ...localStorage })).not.toContain('tok-persist-check')
  })
})
