// =============================================================================
// spec 104 — a passkey that answers, and an account that cannot be confirmed.
//
// NO CHAIN NEEDED, and that is not a compromise here — it is the condition under test. This tier
// runs with no RPC reachable, which is exactly what produces the `unverified` verdict, so the
// environment generates the state rather than a stub asserting it does.
//
// What must hold:
//
//  - a cross-device sign-in whose account cannot be confirmed NEVER opens a session. Before spec
//    104 it did: the app derived an address on the assumption the key was the account's sole
//    initial owner and, when nothing was deployed there, signed the member into that brand-new
//    empty account with no error. A member reads that as their money being gone.
//  - the refusal keeps the three verdicts apart. An unreachable network must never render as
//    "you have no account" — same principle as spec 071's estate reads and spec 084's third
//    message-signing verdict, applied to identity.
//  - there is a way forward on the screen, not just a sentence: retry, or name the account.
//
// The chain-confirming half of recovery (the member's address IS verified and a session opens)
// needs a real deployed account and lives in the full-stack tier — see the matrix row.
// =============================================================================

import { addVirtualAuthenticator, choosePasskey, isChromium, resetAuthenticators } from '../../support/webauthn'

const SESSION_KEY = 'fairwins.passkey.session.v1'
const CREDENTIALS_KEY = 'fairwins.passkey.credentials.v1'

/**
 * Reach the connect surface.
 *
 * `cy.visit` is OVERRIDDEN in this suite to dismiss the dialog the app opens by itself
 * (`commands.js#dismissAutoConnectPrompt` — AutoConnectPrompt fires once wagmi's eager reconnect
 * settles, and the helper presses Escape). So after a visit the surface is CLOSED, and the header
 * button is the way in, exactly as every sibling spec does it.
 *
 * `cy.reload()` gets NO such treatment, which is why this spec uses a second `visit` instead: the
 * prompt reopens, nothing dismisses it, and a click on the header button then lands on the modal
 * backdrop — "covered by another element: connect-modal__backdrop". That is what this spec failed
 * with on its first CI run, and it fails only after a reload, which is why the sibling specs never
 * hit it.
 */
function openConnectSurface() {
  cy.contains('button', /connect wallet/i).click()
}

/** A passkey exists on the device; this BROWSER has never seen it. The cross-device condition. */
function signUpThenForgetThisBrowser() {
  cy.visit('/fairwins')
  openConnectSurface()
  choosePasskey({ mode: 'sign-up' })
  // The book now holds the credential. Clearing it is the "new browser, synced passkey" shape:
  // the authenticator still holds the key, the site remembers nothing.
  cy.get('[aria-label="Wallet Account"]', { timeout: 30000 }).should('exist')
  cy.window().then((win) => {
    win.localStorage.removeItem(CREDENTIALS_KEY)
    win.localStorage.removeItem(SESSION_KEY)
  })
}

describe('Passkey account recovery (spec 104)', () => {
  beforeEach(function () {
    if (!isChromium) this.skip() // the virtual authenticator is a CDP feature
    // Mirrors every sibling in this directory: the ceremony needs the passkey app build. It IS set
    // on the desktop no-chain leg, so this does not silently skip there.
    if (!Cypress.env('PASSKEY_ENABLED')) this.skip()
    cy.clearLocalStorage()
    cy.clearCookies()

    /*
     * CLOSE THE NETWORK BOUNDARY (the RU-01 idiom).
     *
     * The header above says this tier reaches no RPC — but a CI runner has internet, and
     * `defaultPublicClient` points at a real public endpoint. Left open, the resolver's read would
     * SUCCEED, report the derived address as undeployed, and return `none-found` instead of
     * `unverified`. The spec would then be asserting whichever verdict the runner's connectivity
     * happened to produce that morning, which is not a test of anything.
     *
     * Refusing the read makes `unverified` the deterministic outcome, and it is also the honest
     * shape of the condition under test: a member whose chain cannot be reached. The `none-found`
     * branch needs a chain that answers, so it belongs to the unit suites, where the answer is
     * given rather than hoped for.
     *
     * Matched by EXCLUDING localhost rather than by naming RPC hosts. A named list is the trap this
     * repo already documented (PK-02: a `rpc` path glob that "stubbed nothing" because providers
     * resolve to hosts like `polygon-bor-rpc.publicnode.com`) — and it caught this spec too: the
     * first list named publicnode/rivet/etcdesktop while the build actually resolves to
     * `polygon.drpc.org`, so every read sailed through and the verdict came back `none-found`.
     * A host nobody enumerated is exactly the one that gets through, so enumerate the ONE host that
     * is allowed instead.
     */
    cy.intercept({ method: 'POST', hostname: /^(?!localhost$|127\.0\.0\.1$)./ }, (req) =>
      req.reply({ statusCode: 503, body: 'no chain in the no-chain tier' }),
    )

    resetAuthenticators()
    addVirtualAuthenticator()
  })

  it('[REC-01] an unconfirmable account offers recovery instead of opening a session', () => {
    signUpThenForgetThisBrowser()

    cy.visit('/fairwins')
    openConnectSurface()
    choosePasskey({ mode: 'sign-in' })

    cy.get('[data-testid="recover-account"]', { timeout: 30000 }).should('exist')

    // THE REGRESSION. No session row, and the header still offers connection rather than an
    // account — an empty derived account must not be presented as the member's wallet.
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SESSION_KEY), 'passkey session').to.be.null
    })
    cy.get('[aria-label="Wallet Account"]').should('not.exist')
  })

  it('[REC-02] an unreachable network reads as unverified, never as "you have no account"', () => {
    signUpThenForgetThisBrowser()

    cy.visit('/fairwins')
    openConnectSurface()
    choosePasskey({ mode: 'sign-in' })

    cy.get('[data-testid="recover-reason"]', { timeout: 30000 })
      .invoke('text')
      .should((text) => {
        // The positive assertion: it says the absence of an answer is not the absence of an
        // account. The negative one matters just as much — a member who reads "no account" on a
        // network blip concludes their account is gone.
        expect(text).to.match(/does not mean you have no account/i)
        expect(text).to.not.match(/no account on this network lists/i)
      })
    cy.contains('button', /try again/i).should('exist')
  })

  it('[REC-03] the member can name their account, and a malformed address is refused in words', () => {
    signUpThenForgetThisBrowser()

    cy.visit('/fairwins')
    openConnectSurface()
    choosePasskey({ mode: 'sign-in' })
    cy.get('[data-testid="recover-account"]', { timeout: 30000 }).should('exist')

    cy.get('#recover-account-address').type('0xnope')
    cy.contains('button', /find my account/i).click()

    // Text, not colour alone (constitution V), and no attempt made.
    cy.get('[role="alert"]').should('contain.text', 'should start with 0x')
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SESSION_KEY), 'passkey session').to.be.null
    })

    // A well-formed address is HANDED ON to be checked rather than accepted on the client's say-so.
    // With the network closed the answer comes back unverified — which is the proof that matters
    // here: the form did not decide, the chain was asked. (A form that "accepted" an address it
    // never checked is exactly how typing any address would become a way into someone else's
    // account.)
    cy.get('#recover-account-address').clear().type(`0x${'b'.repeat(40)}`)
    cy.contains('button', /find my account/i).click()
    cy.get('[data-testid="recover-reason"]', { timeout: 30000 })
      .should('contain.text', 'does not mean you have no account')
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SESSION_KEY), 'passkey session').to.be.null
    })
  })
})
