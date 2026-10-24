// =============================================================================
// spec 041 T044 — returning user signs back in, on any device (US3)
//
// CDP virtual-authenticator flows (Chrome only). The synced-device scenario
// uses a second virtual authenticator carrying the SAME resident credential —
// the WebAuthn-level equivalent of platform credential sync.
// Tier gating mirrors onboarding-journey.cy.js (PASSKEY_ENABLED app build).
// =============================================================================

import {
  addCredential,
  addVirtualAuthenticator as addAuthenticator,
  choosePasskey,
  connectedAddress,
  expectConnected,
  getCredentials,
  isChromium,
  openAccountMenu,
  removeAuthenticator,
  resetAuthenticators,
} from '../../support/webauthn'

;(isChromium ? describe : describe.skip)('Returning passkey user (US3)', () => {
  beforeEach(function () {
    if (!Cypress.env('PASSKEY_ENABLED')) this.skip()
    cy.clearCookies()
    /*
     * RU-01 leaves its authenticator plugged in, and Chrome allows only ONE internal
     * authenticator per environment — so without this, RU-02's own `addAuthenticator` failed
     * with "Chrome only supports one internal authenticator per environment" and the synced-device
     * flow never ran. The collision is invisible from inside either test.
     */
    resetAuthenticators()
  })

  it('[RU-01] same device: reload restores silently; sign-in after sign-out is ONE prompt within budget (SC-005)', () => {
    /*
     * CLOSE THE NETWORK BOUNDARY. This is a no-chain-tier spec, and SC-005 is a budget on the
     * app's sign-in path — left open, the stopwatch measures the runner's internet latency to a
     * public RPC host instead, which is neither the product's fault nor its achievement. Failing
     * fast is deliberate: sign-in for a member whose record is already complete needs no chain,
     * so a refused read must not change the outcome — and if it ever does, this test says so.
     */
    cy.intercept({ method: 'POST', hostname: /publicnode\.com$|rivet\.link$|etcdesktop\.com$/ }, (req) =>
      req.reply({ statusCode: 503, body: 'no chain in the no-chain tier' }),
    )
    addAuthenticator()
    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    choosePasskey()
    expectConnected()
    connectedAddress().as('address')

    // Silent reconnect on reload — no ceremony, no connect button.
    cy.reload()
    cy.contains(/connect wallet/i).should('not.exist')
    // Reading the address back also settles the post-reload render, so the sign-out click below
    // is not racing it.
    cy.get('@address').then((address) => connectedAddress().should('equal', address))

    // Explicit sign-out, then a timed one-prompt sign-in (SC-005 ≤10 s). Disconnect lives in the
    // header account menu, so it has to be opened first.
    openAccountMenu()
    /*
     * Wait for the balance read to land before clicking.
     *
     * The dropdown re-renders when the USDC balance resolves, which detaches the button
     * mid-click ("the page updated while this command was executing"). `should('be.visible')`
     * does not help — the element is visible, it is about to be replaced. Waiting on the thing
     * that causes the re-render is the fix; waiting on the button is waiting on the symptom.
     */
    cy.get('.usdc-balance', { timeout: 20000 }).should('not.contain.text', 'Loading')
    cy.get('[aria-label="Disconnect wallet"]').click()
    cy.contains('button', /connect wallet/i).should('exist')
    /*
     * STAMP THE START INSIDE THE QUEUE.
     *
     * `const start = Date.now()` in the test body runs when Cypress EVALUATES the body — before a
     * single command has executed — so the budget below was charged the whole test: the visit, the
     * first ceremony, the reload, the menu, the sign-out. It read ~16s against a 10s budget for a
     * sign-in that takes about 700ms. The original test had this from the day it was written and
     * could not report it, because the tier never ran it.
     */
    let start = 0
    cy.then(() => {
      start = Date.now()
    })
    cy.contains('button', /connect wallet/i).click()
    // Second sign-in in the SAME browser: the explainer is once-only and the book now knows this
    // passkey, so the chooser lists it and signing in is one click.
    choosePasskey({ mode: 'sign-in' })
    /*
     * STOP THE CLOCK WHEN THE MEMBER IS SIGNED IN, not when the test has finished inspecting.
     *
     * SC-005 budgets the member-visible sign-in: press connect, one prompt, you are in. Opening
     * the account menu and reading an address out of it is how this test establishes identity —
     * it is not part of signing in, and timing it charged Cypress's own retries to the product.
     */
    expectConnected().then(() => {
      expect(Date.now() - start, 'sign-in wall clock (SC-005)').to.be.lessThan(10000)
    })

    // Same account as before the sign-out — asserted, but outside the timed window.
    cy.get('@address').then((address) => connectedAddress().should('equal', address))
  })

  it('[RU-02] synced device: the same credential on a second authenticator reaches the SAME account', () => {
    let credential
    addAuthenticator().then(({ authenticatorId }) => {
      cy.visit('/fairwins')
      cy.contains('button', /connect wallet/i).click()
      choosePasskey()
      expectConnected()
      connectedAddress().as('address')
      // Export the resident credential (the "sync" leg), then remove device A.
      cy.then(() =>
        getCredentials(authenticatorId).then(({ credentials }) => {
          credential = credentials[0]
          return removeAuthenticator(authenticatorId)
        })
      )
    })

    // Device B: fresh authenticator + the synced credential; cleared site data.
    cy.then(() =>
      addAuthenticator().then(({ authenticatorId: deviceB }) =>
        addCredential(deviceB, credential)
      )
    )
    cy.clearLocalStorage()
    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    /*
     * THE CASE THIS TEST EXISTS FOR. Device B's local book is empty, but the credential synced.
     * The app used to skip straight to sign-up here and mint a SECOND account — the member's
     * funds apparently gone — because "nothing to choose between" was read off the browser's book
     * rather than the device's. Now the chooser offers "I already have a passkey".
     */
    choosePasskey({ mode: 'sign-in' })

    /*
     * ONE EXTRA STEP SINCE SPEC 104, and it is the point rather than friction.
     *
     * Device B's book is empty, so the app can only DERIVE where this key's account would be — and
     * device A never spent, so nothing is deployed there. That state is indistinguishable on chain
     * from a passkey that was added to somebody else's account, which is the failure spec 104
     * exists to stop: signing a member into an empty address as though it were confirmed.
     *
     * So the app now says which it is and lets the member decide. Accepting is safe precisely
     * because the address is a deterministic function of the passkey — it is the SAME address
     * device A showed, which is what the assertion below still proves.
     */
    cy.contains('button', /continue to that account/i, { timeout: 30000 }).click()

    cy.get('@address').then((address) => {
      // Same on-chain identity: address, funds, roles all follow (FR-009).
      expectConnected()
      connectedAddress().should('equal', address)
    })
  })
})
