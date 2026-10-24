/**
 * Proof-of-human challenge, client half (spec 106 slice 2, #1444 / T018).
 *
 * Runs the Turnstile widget, holds the resulting token in module memory, and hands callers a
 * header to attach. What a token buys is THROUGHPUT — the gateway's `human` tier carries higher
 * rate ceilings than `anonymous` — never access: no read route requires one, so every failure
 * mode in this file degrades to "browse at the anonymous ceiling", silently.
 *
 * ── SILENT DEGRADATION IS A REQUIREMENT, NOT A COURTESY (FR-017) ─────────────────────────────
 *
 * An unreachable challenge service is not evidence of a hostile visitor, and must never be
 * RENDERED as suspicion — no error banner, no "verification failed", no blocked surface. Every
 * exit here is one of two honest states: a token (attach it) or nothing (attach nothing). The
 * visitor cannot tell the difference, which is the point; the only observable consequence of an
 * outage is the lower rate ceiling.
 *
 * ── NOTHING PERSISTS ─────────────────────────────────────────────────────────────────────────
 *
 * The token lives in module memory and dies with the tab. Turnstile tokens are short-lived and
 * single-use at the vendor (the gateway caches its own verification verdict, keyed by digest —
 * see the gateway's challenge verifier); persisting one would store a dead credential and read
 * as a bug the first time it is replayed.
 *
 * ── HOW THE WIDGET LOADS ─────────────────────────────────────────────────────────────────────
 *
 * Lazily, only when a sitekey is configured, from the ONE host the CSP pins
 * (`https://challenges.cloudflare.com` — see nginxCspScriptSrc.test.js's allowlist). No sitekey
 * means fully dormant: no script tag, no network fetch, no DOM. The sitekey is PUBLIC by design;
 * the paired secret exists only on the gateway.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** Ask for a fresh token this far before the vendor-side expiry (~300s) would strand a request. */
const REFRESH_AHEAD_MS = 60_000
const TOKEN_LIFETIME_MS = 300_000
const FAILURE_COOLDOWN_MS = 120_000

let state = {
  token: null,
  freshUntil: 0,
  widgetId: null,
  container: null,
  loading: null,
  cooldownUntil: 0,
}

export function challengeSitekey() {
  const key = import.meta.env?.VITE_CHALLENGE_SITEKEY
  return typeof key === 'string' && key.trim() ? key.trim() : null
}

/** True when the challenge is configured at all — surfaces use this to decide whether to warm it. */
export function challengeConfigured() {
  return challengeSitekey() !== null
}

/**
 * The header to attach to a gateway request: `{ 'X-FairWins-Challenge': token }` or `{}`.
 * Synchronous — reads whatever the module already holds. Callers spread it and move on; a miss
 * is the anonymous ceiling, not an error.
 */
export function challengeHeaders() {
  if (state.token && state.freshUntil > Date.now()) return { 'X-FairWins-Challenge': state.token }
  return {}
}

function loadScript(doc) {
  if (state.loading) return state.loading
  state.loading = new Promise((resolvePromise) => {
    // EVERYTHING resolves — null on any failure, including a DOM that throws under us (a
    // sandboxed webview, a teardown race). The caller's next line must be "carry on anonymous",
    // and both a rejection and an exception are paths that invite someone to render the failure.
    try {
      if (globalThis.turnstile) return resolvePromise(globalThis.turnstile)
      const script = doc.createElement('script')
      script.src = SCRIPT_SRC
      script.async = true
      script.onload = () => resolvePromise(globalThis.turnstile ?? null)
      script.onerror = () => resolvePromise(null)
      doc.head.appendChild(script)
    } catch {
      resolvePromise(null)
    }
  })
  return state.loading
}

/**
 * Acquire or refresh a challenge token in the background. Fire-and-forget; never throws; safe to
 * call opportunistically (idempotent while fresh, cooldown-guarded after failure).
 *
 * The widget renders into an off-screen container in managed mode: Cloudflare decides whether the
 * visitor needs interaction. If it escalates to an interactive challenge, `onInteractiveCallback`
 * lets a surface bring the container on-screen — the ONE case a member ever sees anything, and it
 * is the vendor's UI, subject to the a11y gate on whichever surface mounts it.
 */
export async function ensureChallengeToken({ document: doc = globalThis.document, onInteractive = null } = {}) {
  const sitekey = challengeSitekey()
  if (!sitekey || !doc) return // dormant: no sitekey, no script, no DOM
  const now = Date.now()
  if (state.token && state.freshUntil - REFRESH_AHEAD_MS > now) return
  if (state.cooldownUntil > now) return

  const turnstile = await loadScript(doc)
  if (!turnstile) {
    state.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
    return
  }

  try {
    if (!state.container || !doc.contains(state.container)) {
      const container = doc.createElement('div')
      container.setAttribute('data-testid', 'challenge-container')
      // Off-screen, not display:none — some challenge modes refuse to run unrendered.
      container.style.position = 'fixed'
      container.style.left = '-9999px'
      container.style.bottom = '0'
      // Out of the accessibility tree until a surface deliberately brings it on-screen: an
      // off-screen iframe in the tab order would be a keyboard trap nobody can see.
      container.setAttribute('aria-hidden', 'true')
      container.tabIndex = -1
      doc.body.appendChild(container)
      state.container = container
    }

    if (state.widgetId != null) {
      turnstile.reset(state.widgetId)
      return
    }

    state.widgetId = turnstile.render(state.container, {
      sitekey,
      // Managed mode: the vendor decides whether this visitor needs interaction at all. Most
      // never see anything.
      appearance: 'interaction-only',
      callback: (token) => {
        state.token = token
        state.freshUntil = Date.now() + TOKEN_LIFETIME_MS
      },
      'expired-callback': () => {
        state.token = null
      },
      'error-callback': () => {
        // FR-017: an errored widget is a visitor browsing at the anonymous ceiling, nothing more.
        state.token = null
        state.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      },
      'before-interactive-callback': () => {
        if (typeof onInteractive === 'function') onInteractive(state.container)
      },
    })
  } catch {
    state.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
  }
}

/** Test seam. Production code never calls it. */
export function __resetChallengeForTests() {
  state = { token: null, freshUntil: 0, widgetId: null, container: null, loading: null, cooldownUntil: 0 }
}
