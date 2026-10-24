// =============================================================================
// app-lock.cy.js
// Account-native tier — spec 041 amendment (release 1.14.0), User Story 7.
// Issue #1364 / matrix row `passkey.app-lock`.
//
// ── WHY THIS IS NO-CHAIN, ACCOUNT-NATIVE ────────────────────────────────────
// The lock is a UI gate over an intact session (frontend/src/lib/applock/appLock.js
// header): it never signs, submits, or touches a chain. It DOES need the real WebAuthn
// re-prompt though — the whole feature only exists because a passkey can be re-asked
// for — so it lives beside the other passkey flows and rides the fast job's desktop
// leg under CYPRESS_PASSKEY_ENABLED, exactly like returning-user.cy.js.
//
// ── WHAT PROVES THE OVERLAY ACTUALLY GATES THE APP ──────────────────────────
// `should('be.visible')` on the overlay is necessary but not sufficient — the app
// tree stays MOUNTED underneath by design (AppLockOverlay.jsx's own header, point 1),
// so a wallet control behind the cover is still technically "visible" to a naive
// check. The real question is what a member's click would actually hit, which is
// exactly what `document.elementFromPoint` answers: at the coordinates of the header
// account button, is the element under the cursor the OVERLAY, or the button itself?
// If the overlay were ever removed (or its z-index/inset broken), this flips to the
// real control and the assertion fails — which is the bar the brief sets ("must fail
// if the overlay is removed").
//
// ── THE cy.clock TRAP (anti-pattern #11) AND WHY THE CLOCK GOES IN EARLY ────
// The idle mechanism is a real `setTimeout(engageLock, IDLE_LOCK_MS)`
// (AppLockOverlay.jsx `arm()`), not a Date-based deadline. Sinon's fake clock only
// takes over calls made to setTimeout AFTER it installs — a timer already scheduled
// against the REAL setTimeout keeps running in real time no matter how far a later
// cy.tick() winds the fake one. So the clock is installed BEFORE the setting is
// switched on (before ArmedAppLock mounts and calls `arm()`), and the `Date.now()`
// argument is still evaluated inside `cy.then()`, not at test-body parse time, so it
// is not stale by the time the command actually runs (BTC-03's fix, same trap).
// Only `Date`/`setTimeout`/`clearTimeout` are faked — narrow enough that rendering,
// WebAuthn's CDP-driven ceremony, and Cypress's own retries all keep real time.
//
// ── WEBAUTHN FAILURE, DRIVEN FOR REAL ────────────────────────────────────────
// [AL-05]'s failed ceremony is not a fake rejection: `WebAuthn.setUserVerified` (CDP)
// makes the SAME virtual authenticator genuinely fail user verification, which
// getAssertion's `userVerification: 'required'` request turns into a real WebAuthn
// rejection (lib/passkey/credentials.js `mapCeremonyError` maps it to either
// CeremonyCancelled or AuthenticatorUnavailable depending on the DOMException name
// Chrome raises for a declined UV check). The test asserts on what both branches
// share — the overlay stays up, and the copy says the member is still signed in
// (describeUnlockFailure never says "session expired") — rather than pinning to one
// subtype's exact wording, since which DOMException a forced UV failure raises is a
// CDP/engine detail, not the product behaviour under test.
// =============================================================================

import {
  addVirtualAuthenticator as addAuthenticator,
  cdp,
  choosePasskey,
  expectConnected,
  isChromium,
  resetAuthenticators,
} from '../../support/webauthn'

// frontend/src/lib/applock/appLock.js:30 — the shared cross-tab lock flag.
const APP_LOCK_STATE_KEY = 'fairwins.applock.state.v1'
// frontend/src/lib/applock/appLock.js:33 — idle period before the overlay engages.
const IDLE_LOCK_MS = 15 * 60 * 1000
// frontend/src/components/applock/AppLockOverlay.jsx:192
const OVERLAY = '[data-testid="app-lock-overlay"]'
// frontend/src/config/navSearchIndex.js:393-399 — the deep-link hash opens the card.
const SETTINGS_APP_LOCK = '/wallet?tab=settings#app-lock'
// frontend/cypress/support/webauthn.js's own header control, used by every passkey spec.
// The occlusion probe target. Page-local on purpose: the header's account button sits in a
// fixed container that the settings route clips at the desktop viewport (measured on CI: "not
// visible because its ancestor has position: fixed and it is overflowed"), so a click there was
// never a fair baseline. The App lock toggle is on every screen this file drives, is real
// content, and is exactly what a member would reach for — before the lock it must take the
// click, after the lock the overlay must.
const PROBE = '[data-testid="app-lock-toggle"]'
const ACCOUNT_BUTTON = PROBE
// frontend/src/connectors/passkey.js session key, read back to prove FR-026 (session intact).
const SESSION_KEY = 'fairwins.passkey.session.v1'

/** The persisted lock flag, read the same way the app itself does (appLock.js:71-82). */
function readLockState() {
  return cy.window().then((win) => {
    const raw = win.localStorage.getItem(APP_LOCK_STATE_KEY)
    if (!raw) return false
    try {
      return JSON.parse(raw)?.locked === true
    } catch {
      return Boolean(raw)
    }
  })
}

/**
 * What a real click at `selector`'s center would actually land on: the element
 * itself (or a descendant), or something covering it. Falsifiable in both
 * directions — this is the same check used to prove reachability BEFORE the lock
 * and occlusion AFTER it.
 */
function elementAtCenterOf(selector) {
  return cy.get(selector).then(($el) => {
    const rect = $el[0].getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return cy.document().then((doc) => doc.elementFromPoint(x, y))
  })
}

/**
 * Sign up with a fresh passkey and land on the Settings ▸ App lock card, open
 * (the hash deep-link, per navSearchIndex.js — 38-assistant.cy.js proves the same
 * pattern). Asserts the toggle is present, enabled and OFF — the precondition
 * every test in this file needs, established rather than assumed.
 */
function signInAndOpenAppLockSettings() {
  let authenticatorId
  addAuthenticator().then((result) => {
    authenticatorId = result.authenticatorId
  })
  cy.visit('/fairwins')
  cy.contains('button', /connect wallet/i).click()
  choosePasskey()
  expectConnected()

  cy.visit(SETTINGS_APP_LOCK)
  cy.get('[data-testid="app-lock-prefs-panel"]', { timeout: 20000 }).should('exist')
  cy.get('[data-testid="app-lock-toggle"]', { timeout: 20000 })
    .should('not.be.disabled')
    .should('not.be.checked')

  return cy.then(() => authenticatorId)
}

/** Check the box (no clock installed) and assert the setting actually flipped. */
function enableAppLock() {
  cy.get('[data-testid="app-lock-toggle"]').check()
  cy.get('[data-testid="app-lock-toggle"]').should('be.checked')
}

/** Simulate the tab backgrounding / returning — the "on leaving" trigger (FR-025b). */
function setVisibility(state) {
  cy.window().then((win) => {
    Object.defineProperty(win.document, 'visibilityState', { value: state, configurable: true })
    win.document.dispatchEvent(new win.Event('visibilitychange'))
  })
}

;(isChromium ? describe : describe.skip)('App lock (spec 041 amendment, US7)', () => {
  beforeEach(function () {
    if (!Cypress.env('PASSKEY_ENABLED')) this.skip()
    cy.clearCookies()
    cy.clearLocalStorage()
    // Chrome allows ONE internal authenticator per environment; a spec that leaves its
    // device plugged in breaks the next one from the outside (webauthn.js header).
    resetAuthenticators()
  })

  it('[AL-01] passkey.app-lock — enabling in Settings persists the device preference across a reload', () => {
    signInAndOpenAppLockSettings()
    enableAppLock()
    // Turning the setting on does not itself lock the screen (FR-025 arms an idle
    // timer; it does not engage on enable).
    readLockState().then((locked) => {
      expect(locked, 'enabling the setting does not itself engage the lock').to.equal(false)
    })

    // The setting is device-scoped storage (fw_global_prefs.app_lock), not React state —
    // a reload that silently reconnects (RU-01's pattern) and still shows it checked is
    // the proof it was actually written, not just toggled in memory.
    cy.reload()
    expectConnected()
    cy.get('[data-testid="app-lock-toggle"]', { timeout: 20000 }).should('be.checked')
  })

  it('[AL-02] passkey.app-lock — the idle timeout gates every wallet surface behind the overlay', () => {
    signInAndOpenAppLockSettings()

    // Baseline: before the lock is even armed, the header account control is really
    // reachable — a real click there would hit the button, not a cover.
    cy.get(ACCOUNT_BUTTON, { timeout: 20000 }).scrollIntoView().should('be.visible')
    elementAtCenterOf(ACCOUNT_BUTTON).then((el) => {
      expect(el && el.closest(ACCOUNT_BUTTON), 'the app-lock toggle is reachable before the lock').to.exist
    })
    cy.get(OVERLAY).should('not.exist')

    // Install the fake clock BEFORE arming (see file header) — Date/setTimeout only, so
    // WebAuthn, React rendering and Cypress's own retries all keep real time.
    cy.then(() => {
      cy.clock(Date.now(), ['Date', 'setTimeout', 'clearTimeout'])
    })
    enableAppLock() // flips isAppLockEnabled() -> ArmedAppLock mounts -> arm() schedules the FAKE setTimeout
    cy.then(() => cy.tick(IDLE_LOCK_MS))

    cy.get(OVERLAY, { timeout: 20000 })
      .should('be.visible')
      .and('have.attr', 'role', 'dialog')
      .and('have.attr', 'aria-modal', 'true')
      .and('have.attr', 'aria-label', 'FairWins is locked')
    readLockState().then((locked) => expect(locked, 'the lock state is persisted').to.equal(true))

    // The gate itself: a real click at the account button's own coordinates now lands on
    // the overlay, not the button. Remove the overlay and this reverts to the button —
    // exactly the failure this test exists to catch.
    elementAtCenterOf(ACCOUNT_BUTTON).then((el) => {
      expect(el && el.closest(OVERLAY), 'the app-lock toggle is now covered by the lock overlay').to.exist
    })
  })

  it('[AL-03] passkey.app-lock — leaving the tab locks immediately, and returning re-prompts rather than auto-unlocking', () => {
    signInAndOpenAppLockSettings()
    enableAppLock()
    cy.get(ACCOUNT_BUTTON, { timeout: 20000 }).scrollIntoView().should('be.visible')
    cy.get(OVERLAY).should('not.exist')

    // FR-025b: backgrounding is immediate, not idle-timed — a phone going to the home
    // screen may never run the idle timer again.
    setVisibility('hidden')
    cy.get(OVERLAY, { timeout: 20000 }).should('be.visible')
    readLockState().then((locked) => expect(locked, 'hidden engaged the lock').to.equal(true))

    // Coming back is not a ceremony. If becoming visible silently lifted the cover, a
    // member picking their phone back up would see account content with no re-prompt —
    // exactly what FR-025b exists to prevent.
    setVisibility('visible')
    cy.get(OVERLAY, { timeout: 5000 }).should('be.visible')
    readLockState().then((locked) => expect(locked, 'still locked after returning').to.equal(true))
  })

  it('[AL-04] passkey.app-lock — a successful passkey ceremony unlocks and restores the surface', () => {
    signInAndOpenAppLockSettings()
    enableAppLock()
    setVisibility('hidden')
    cy.get(OVERLAY, { timeout: 20000 }).should('be.visible')

    // The SAME resident credential the sign-up minted; the virtual authenticator's default
    // isUserVerified:true (webauthn.js) auto-satisfies the required-UV assertion.
    cy.get('.app-lock__unlock').click()

    cy.get(OVERLAY, { timeout: 20000 }).should('not.exist')
    readLockState().then((locked) => expect(locked, 'the lock state was cleared').to.equal(false))
    elementAtCenterOf(ACCOUNT_BUTTON).then((el) => {
      expect(el && el.closest(ACCOUNT_BUTTON), 'the app-lock toggle is reachable again').to.exist
    })
    // FR-026: unlock touches nothing about the session.
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SESSION_KEY), 'the session survives an unlock').to.exist
    })
  })

  it('[AL-05] passkey.app-lock — a cancelled ceremony keeps the app locked, with sign-out offered as the escape hatch', () => {
    let authenticatorId
    signInAndOpenAppLockSettings().then((id) => {
      authenticatorId = id
    })
    enableAppLock()
    setVisibility('hidden')
    cy.get(OVERLAY, { timeout: 20000 }).should('be.visible')

    // Force the SAME authenticator to fail user verification — the WebAuthn shape of the
    // member declining/cancelling the platform prompt.
    cy.then(() => cdp('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false }))
    cy.get('.app-lock__unlock').click()

    cy.get(OVERLAY, { timeout: 20000 }).should('exist')
    // Asserted on what every describeUnlockFailure() branch shares (AppLockOverlay.jsx
    // lines 68-79), not one subtype's exact wording — which DOMException a forced UV
    // failure raises is a CDP/engine detail, not the product behaviour under test.
    cy.get('[role="alert"]', { timeout: 20000 })
      .invoke('text')
      .should('match', /you are still signed in/i)
    cy.get('.app-lock__unlock').should('be.enabled')
    cy.get('.app-lock__signout').should('be.enabled')
    readLockState().then((locked) => expect(locked, 'still locked after the cancelled ceremony').to.equal(true))
    // FR-026/FR-027: a failed ceremony never signs the member out, and never touches the
    // session it is guarding.
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SESSION_KEY), 'the session survives a failed unlock').to.exist
    })

    // The escape hatch is real, not decorative: with verification restored, the SAME
    // button now succeeds — retry, not lockout.
    cy.then(() => cdp('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true }))
    cy.get('.app-lock__unlock').click()
    cy.get(OVERLAY, { timeout: 20000 }).should('not.exist')
  })
})
