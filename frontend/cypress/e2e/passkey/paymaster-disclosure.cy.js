// =============================================================================
// paymaster-disclosure.cy.js
// Account-native tier — spec 050, the fee a passkey member is actually paying.
//
// Issue #1240. Sponsorship is the headline feature of a passkey account, and it
// is OPTIONAL infrastructure: a self-hosted verifying paymaster reimburses the
// bundler, and where one is not configured the member funds their own UserOp.
// Spec 050 is explicit that the confirm UI must disclose which of those is
// happening — "sponsored" and "you pay" are different transactions and the
// member is entitled to know which they are authorising.
//
// This build configures no bundler and no sponsor paymaster (`VITE_BUNDLER_URLS_*`
// and the sponsor endpoint are unset), which is exactly the case FR-004 exists
// for. Each test therefore makes TWO claims, and both are needed: the negative —
// no surface may claim a sponsorship this deployment cannot deliver — and the
// positive one that gives the flow its name, that the fee line names the MEMBER
// as the payer.
//
// `sponsorPaymasterUrl` is resolved at BUILD time (`networks.js#passkeyConfig`
// from `VITE_SPONSOR_PAYMASTER_<NET>`), so the unavailable state cannot be
// produced at runtime by intercepting `POST /v1/paymaster`: with the URL null
// the client never builds a paymaster transport and never issues that request.
// The unavailability is a property of the build, and that is what is driven here.
// The runtime failure of a CONFIGURED endpoint (sponsorship requested, refused,
// UserOp self-funds) is covered in
// `frontend/src/lib/passkey/__tests__/sendBatch.fallback.test.js`.
//
// The positive path — a UserOp actually sponsored end to end — needs a live
// bundler and paymaster and is tracked separately; it is not faked here.
// =============================================================================

import {
  addVirtualAuthenticator as addAuthenticator,
  choosePasskey,
  expectConnected,
  isChromium,
  resetAuthenticators,
} from '../../support/webauthn'

;(isChromium ? describe : describe.skip)('Sponsored-fee disclosure (spec 050)', () => {
  beforeEach(function () {
    if (!Cypress.env('PASSKEY_ENABLED')) this.skip()
    cy.clearCookies()
    cy.clearLocalStorage()
    resetAuthenticators()
  })

  it('[PM-01] paymaster.fallback-disclosed — with no paymaster configured, nothing claims to be sponsored', () => {
    /*
     * The failure this rules out is a badge that reads the FEATURE rather than the DEPLOYMENT.
     * "⚡ Gasless · sponsored" is derived from `pairNetwork.passkey.sponsorPaymasterUrl`, and a
     * surface that instead derived it from "this is a passkey account" would tell every member of
     * every deployment that their gas is covered — right up until they were asked to fund it.
     *
     * A member who is told the fee is covered and is then charged has been misinformed about
     * money, which is the one category of disclosure this codebase treats as non-negotiable.
     */
    addAuthenticator({ prf: true })
    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    choosePasskey()
    expectConnected()

    cy.visit('/wallet?tab=trade')
    cy.get('.trade-panel', { timeout: 40000 }).should('exist')

    // The rail is stated up front, before any amount is entered.
    cy.get('.trade-badge', { timeout: 20000 }).should('be.visible')
    cy.get('.trade-panel').should(($p) => {
      const text = $p.text()
      expect(
        text,
        `no sponsor paymaster is configured, so nothing may claim sponsorship. Rendered: ${text.slice(0, 300)}`,
      ).to.not.match(/gasless|sponsored/i)
    })

    /*
     * And the member is told, POSITIVELY, that the fee is theirs.
     *
     * This assertion was originally a disjunction — "network fee applies" OR "passkey accounts
     * can't send transactions here" — on the reasoning that both are honest. Both are, but only
     * one of them is a fee disclosure, and in this build the second is always rendered (no
     * bundler ⇒ `passkeyReady` is false ⇒ TradePanel.jsx:489 prints the unsupported-network
     * note). So the disjunction was satisfied by the note in every run and the fee line was
     * never actually examined: `feeBadge` could have been deleted outright and this still passed.
     *
     * The badge is the disclosure, it is computed independently of `passkeyReady`
     * (TradePanel.jsx:437-443), and for a passkey session that is neither a vault nor a recovered
     * account its only two possible values are "⚡ Gasless · sponsored" and "Network fee applies".
     * Asserting the exact one therefore states the whole claim in the flow's name: sponsorship is
     * unavailable, and the member is told they pay.
     */
    cy.get('.trade-panel .trade-badge')
      .invoke('text')
      .invoke('trim')
      .should('equal', 'Network fee applies')

    /*
     * The unsupported-network note is still expected, and is now asserted as its own separate
     * fact rather than as an alternative to the fee line — it explains WHY nothing can be sent
     * here, which is a different thing from saying who pays.
     */
    cy.get('.trade-panel').should(($p) => {
      expect($p.text(), 'and the reason nothing can be sent here is stated too').to.match(
        /can’t send transactions|can't send transactions/i,
      )
    })
  })

  it('[PM-02] paymaster.fallback-disclosed — the claim tracks the deployment, not the account type', () => {
    /*
     * The same panel, same build, reached by a CLASSIC wallet. Both accounts must be told a fee
     * applies here — which is what makes PM-01 a statement about the deployment rather than an
     * artefact of the passkey path being broken in this build.
     */
    cy.mockWeb3Provider({ account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', preAuthorized: true })
    cy.visit('/wallet?tab=trade')
    cy.get('.trade-panel', { timeout: 40000 }).should('exist')

    cy.get('.trade-badge', { timeout: 20000 }).should('be.visible')
    cy.get('.trade-panel').should(($p) => {
      expect($p.text(), 'a classic wallet is never told its gas is sponsored').to.not.match(
        /gasless|sponsored/i,
      )
    })

    // The SAME disclosure, word for word, as the passkey session gets in PM-01. That equality is
    // the point: it is what makes PM-01's badge a statement about this deployment's paymaster
    // rather than a side effect of the passkey rail being unavailable in this build.
    cy.get('.trade-panel .trade-badge')
      .invoke('text')
      .invoke('trim')
      .should('equal', 'Network fee applies')
  })
})
