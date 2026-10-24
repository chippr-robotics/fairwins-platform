// =============================================================================
// spec 041 T035 — passkey onboarding journey (US1)
//
// Drives REAL WebAuthn ceremonies through the Chrome DevTools Protocol virtual
// authenticator (no mocked WebAuthn JS API): capability gating (FR-004),
// sign-up ceremony → connected account with a stable address (FR-005),
// counterfactual funding view with QR (FR-007), no-seed-phrase invariant, and
// SC-001's interaction budget.
//
// Tier notes:
//  - The gating + sign-up + funded-view sections run WITHOUT a chain: the
//    account address derivation is the only read, and the ceremony needs no
//    chain — which is precisely why this flow belongs in a tier that has none.
//  - SC-002's money journey is NOT here any more (see below): it needs the
//    local stack with a bundler and lives in the specs the
//    `cypress-passkey-full-stack` job runs.
//
// WHERE PK-03 WENT (#1407). This file used to end with `it.skip('[PK-03] full
// money journey …')`, a sketch written against three things that do not exist —
// `[data-testid="passkey-account-address"]`, `[data-testid="confirm-passkey"]`
// (the only mount of which was `components/wallet/PasskeyConfirm.jsx`, imported
// by nothing but its own unit test and now deleted) and a `cy.task('seedUsdc')`
// that was never registered. A skip cannot be turned into coverage by a flag, so
// it has been REPLACED by tests that run:
//   · fund → move money, first-use activation → `sponsored-userop.cy.js::SU-01`
//   · fund → MEMBERSHIP purchase, sponsored and self-funded →
//     `membership-purchase.cy.js::MP-01/MP-02`
// The wager round-trip half is covered from the chain side by
// `full/04-wager-creation-tx.cy.js` and `full/05-wager-acceptance.cy.js`; a
// passkey-signed wager is a further flow and is tracked as such, not left here
// as a skip that reads like coverage.
// =============================================================================

import {
  addVirtualAuthenticator,
  choosePasskey,
  connectedAddress,
  expectConnected,
  isChromium,
  openAccountMenu,
  resetAuthenticators,
} from '../../support/webauthn'

;(isChromium ? describe : describe.skip)('Passkey onboarding journey (US1)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    // Chrome allows ONE internal authenticator per environment and the CDP domain outlives a
    // test, so the previous test's device has to be unplugged before this one plugs its in.
    resetAuthenticators()
  })

  // PENDING (#1019): asserts the passkey option is absent, but CI renders it — same network passkey-config question as UL-01.
  it.skip('[PK-01] hides the passkey option when the network has no passkey config (FR-004)', () => {
    // Default local env has no VITE_BUNDLER_URLS_* → capability off → option absent.
    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    cy.contains(/browser wallet/i).should('exist')
    cy.contains(/^passkey$/i).should('not.exist')
  })

  it('[PK-02] sign-up: one ceremony to a connected, fundable account; no seed phrase (SC-001)', function () {
    if (!Cypress.env('PASSKEY_ENABLED')) this.skip() // needs VITE_BUNDLER_URLS_LOCAL app build
    addVirtualAuthenticator()

    /*
     * NO RPC STUB.
     *
     * There used to be one here, matching a `rpc` path glob — a pattern this app never requests,
     * since providers resolve to hosts like `polygon-bor-rpc.publicnode.com/` (spec 069). It
     * therefore stubbed nothing. Pointing it at the real host turned out to be worse than
     * useless: the account address is derived on the device, and answering every `eth_call` with
     * one canned word broke the derivation the test is here to observe. The ceremony needs no
     * chain, which is precisely why this flow belongs in a tier that has none.
     */
    cy.visit('/fairwins')

    /*
     * SC-001 interaction budget: connect-surface → passkey → (ceremony is the device prompt,
     * auto-approved by the virtual authenticator) = ≤3 member decisions.
     *
     * `choosePasskey` continues through spec 045's first-time explainer (FR-010), which this
     * spec predates and never saw, because the tier's env guard had made it permanently pending
     * before 045 landed — a skipped test stops tracking the product. The explainer confirms the
     * choice just made and is shown once per browser, so it is part of decision 2, not a third.
     */
    cy.contains('button', /connect wallet/i).click() // 1
    choosePasskey() // 2

    /*
     * A connected account with a stable address, and the QR a member funds it from (FR-007).
     *
     * This used to assert `[data-testid="passkey-account-address"]` and the copy "activates
     * on-chain automatically" on a dedicated counterfactual-funding screen. NONE OF THAT EXISTS
     * in the app any more — the address and its QR live on the header account control, where
     * every account type shows them. The old assertions could not have passed for a long time;
     * the tier's env guard meant nobody found out.
     */
    expectConnected()
    connectedAddress().should('match', /^0x[0-9a-fA-F]{40}$/)
    openAccountMenu()
    cy.get('[aria-label="Show wallet address QR code"]').click() // 3
    cy.get('[role="dialog"]').should('exist')

    // No-seed-phrase invariant: the DOM never asks the user to record anything.
    cy.get('body').should(($b) => {
      const text = $b.text().toLowerCase()
      expect(text).to.not.include('backup phrase')
      expect(text).to.not.include('recovery phrase')
    })

    // Session persisted for silent reconnect (FR-003).
    cy.reload()
    cy.contains(/connect wallet/i).should('not.exist')
  })

})
