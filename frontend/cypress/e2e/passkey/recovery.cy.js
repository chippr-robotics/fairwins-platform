// =============================================================================
// spec 041 T051–T053 — losing a device is not losing the money (US5 / SC-007).
//
// ACCOUNT-NATIVE TIER, full stack. The claim in US5 is not "the same address
// appears again": it is that the member can still SPEND. An address is cheap to
// re-derive — it is a pure function of the credential's public key — so a test
// that stopped at the address would pass just as happily against an account
// nobody could sign for. RC-01 therefore ends by moving real money from the
// recovered session and reading the recipient's balance off the chain.
//
// The device loss is real, not simulated in JS: the virtual authenticator is
// UNPLUGGED (CDP removeVirtualAuthenticator) and the browser's storage cleared,
// so what signs afterwards is a different authenticator that was handed the
// synced credential — the WebAuthn shape of "my passkey followed me to a new
// phone". Recovery is therefore unaided: no support, no seed phrase, no export.
// =============================================================================

import {
  addCredential,
  addVirtualAuthenticator,
  choosePasskey,
  connectedAddress,
  expectConnected,
  getCredentials,
  isChromium,
  removeAuthenticator,
  resetAuthenticators,
} from '../../support/webauthn'

const CREDENTIALS_KEY = 'fairwins.passkey.credentials.v1'
// Hardhat account #6 — not the deployer, not alto's executor or utility key, not the paymaster
// signer. It only has to be an address whose balance can be read back.
const RECIPIENT = '0x976EA74026E726554dB657fA54763abd0C3a0aa9'

function ownerBytesFromStorage(win, address) {
  const book = JSON.parse(win.localStorage.getItem(CREDENTIALS_KEY) || '[]')
  const cred = book.find((c) => c.address?.toLowerCase() === address.toLowerCase()) || book[0]
  if (!cred?.publicKey?.x) throw new Error('no passkey credential with a public key in this browser')
  return `0x${cred.publicKey.x.slice(2).padStart(64, '0')}${cred.publicKey.y.slice(2).padStart(64, '0')}`
}

/**
 * Poll a balance until it satisfies `check`, then hand it back for a real assertion.
 *
 * `cy.task(...).should(...)` CANNOT do this: `cy.task` is not a query, so Cypress does not re-invoke
 * it on a failed assertion — the retry would re-assert the same stale answer until it timed out. A
 * UserOperation lands asynchronously (bundle, mine, receipt), so the wait has to be explicit. It
 * gives up after the budget and returns whatever it last read, which then fails the assertion at
 * the call site with the actual number in the message.
 */
function pollBalance(address, check, tries = 40) {
  return cy.task('passkeyStack', { action: 'balances', args: { address } }).then((r) => {
    if (check(r) || tries === 0) return r
    return cy.wait(3000).then(() => pollBalance(address, check, tries - 1))
  })
}

/** Drive the member-facing send: asset → recipient → amount → preview → send. */
function sendUsdc(amount) {
  cy.visit('/wallet?tab=paytransfer')
  cy.get('.pt-form', { timeout: 40000 }).should('exist')
  cy.get('.uas-trigger[aria-label="Asset to send"]').click()
  cy.get('.uas-search').type('USDC')
  cy.get('.uas-list').contains('.uas-sym', 'USDC').click()
  cy.get('#pt-to').type(RECIPIENT)
  cy.get('#pt-amount').type(amount)
  cy.contains('button', /^Preview$/).click()
  cy.get('.pt-preview', { timeout: 20000 }).should('exist')
  cy.contains('button', /^Send$/).click()
}

;(isChromium ? describe : describe.skip)('Device-loss recovery (US5)', () => {
  beforeEach(function () {
    if (!Cypress.env('PASSKEY_FULL_STACK')) this.skip()
    cy.clearLocalStorage()
    cy.clearCookies()
    resetAuthenticators()
  })

  it('[RC-01] a synced credential on a new device recovers the account AND the ability to spend', () => {
    let original
    let synced
    let authA

    addVirtualAuthenticator().then((r) => {
      authA = r.authenticatorId
    })
    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    choosePasskey()
    expectConnected()
    connectedAddress().then((address) => {
      original = address
      cy.window().then((win) => {
        cy.task('seedUsdcForActiveSession', {
          address,
          usdc: '100',
          ownerBytes: ownerBytesFromStorage(win, address),
        }).then((r) => expect(r.deployed, 'the account exists on chain before the device is lost').to.equal(true))
      })
    })

    // The device is lost: take the credential the platform would have synced, then unplug it.
    cy.then(() => getCredentials(authA)).then(({ credentials }) => {
      expect(credentials, 'the authenticator holds the resident credential').to.have.length.at.least(1)
      synced = credentials[0]
    })
    cy.then(() => removeAuthenticator(authA))

    // A brand-new browser on a brand-new device that happens to hold the same passkey.
    cy.clearLocalStorage()
    cy.clearCookies()
    cy.then(() => addVirtualAuthenticator()).then(({ authenticatorId }) => addCredential(authenticatorId, synced))

    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    // No local record exists here, so the chooser offers "I already have a passkey" and the
    // connector issues a bare discoverable request — the cross-device path (issue #849).
    choosePasskey({ mode: 'sign-in' })
    expectConnected()
    connectedAddress().should((address) => {
      expect(String(address).toLowerCase(), 'the same account, on a device that never created it')
        .to.equal(String(original).toLowerCase())
    })

    // AND IT CAN STILL SPEND. This is the half that makes the recovery worth anything: the session
    // signs a real UserOperation with the recovered credential and the money arrives.
    cy.task('passkeyStack', { action: 'balances', args: { address: RECIPIENT } }).as('before')
    sendUsdc('5')
    cy.get('@before').then((before) => {
      const want = BigInt(before.usdc) + 5n * 10n ** 18n
      // Judged on the CHAIN, not on a toast: inclusion is what moved the money.
      pollBalance(RECIPIENT, (r) => BigInt(r.usdc) >= want).then((after) => {
        expect(BigInt(after.usdc) - BigInt(before.usdc), 'the recipient received 5 USDC').to.equal(
          5n * 10n ** 18n,
        )
      })
    })
  })

  /*
   * RC-04 — FR-021 says a single-credential account is warned at three moments: creation, first
   * funding, and membership purchase. `components/wallet/DeviceLossWarning.jsx` is mounted at all
   * three (issue #1405): HomeScreen (creation — the surface the ceremony lands on), MyAccountView
   * (first funding — the wallet home once the portfolio reports a non-zero holding) and the
   * Review step of PremiumPurchaseModal (before the member commits money). Each moment is driven
   * here through the real UI and asserted by its own testid; the controllers card's badge + alert
   * are the fourth, standing disclosure on the surface that can fix it. Remove any one mount and
   * exactly one assertion below fails.
   */
  it('[RC-04] a single-credential account is warned at creation, first funding and membership purchase, and told where to fix it', () => {
    addVirtualAuthenticator()
    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    choosePasskey()
    expectConnected()

    // Moment 1 — CREATION. The first surface a brand-new passkey account renders on.
    cy.get('[data-testid="device-loss-warning-creation"]', { timeout: 30000 })
      .should('have.attr', 'role', 'alert')
      .and('contain.text', 'One passkey guards this account')

    connectedAddress().then((address) => {
      cy.window().then((win) => {
        cy.task('seedUsdcForActiveSession', {
          address,
          usdc: '10',
          ownerBytes: ownerBytesFromStorage(win, address),
        })
      })

      // Moment 2 — FIRST FUNDING. The wallet home, once the portfolio has READ a non-zero holding
      // (never on a totalUsd, which a missing price feed would zero — MyAccountView.jsx).
      //
      // The portfolio scans testnets only when the member has opted in
      // (`getPortfolioChainIds({ includeTestnets })`), and this stack runs on a node impersonating
      // Amoy — so without the preference the 10 USDC is never scanned, the wallet home never shows
      // the account holding anything, and the warning (judged on what the home SHOWS) is honestly
      // absent. Seeded as the app itself stores it (Preferences → Portfolio writes the same key;
      // full/43 does the same); the toggle's own UI is not what this flow is about.
      cy.visit('/wallet?tab=account', {
        onBeforeLoad(win) {
          win.localStorage.setItem(`fw_user_${address.toLowerCase()}_show_testnet_assets`, 'true')
        },
      })
    })
    expectConnected()
    cy.get('[data-testid="device-loss-warning-first-funding"]', { timeout: 90000 }).should('have.attr', 'role', 'alert')

    // Moment 3 — MEMBERSHIP PURCHASE. On the Review step, before the member signs; it warns and
    // never gates, so the purchase button underneath stays untouched.
    cy.visit('/wallet?tab=membership')
    expectConnected()
    cy.get('.membership-section .get-roles-btn', { timeout: 30000 }).click()
    cy.get('.ppm-overlay', { timeout: 30000 }).should('exist')
    cy.contains('.ppm-tier-card', /Bronze/i, { timeout: 30000 }).click()
    cy.get('.ppm-overlay').contains('button', /^Continue$/).click()
    cy.get('[data-testid="device-loss-warning-membership-purchase"]', { timeout: 30000 }).should('have.attr', 'role', 'alert')
    cy.get('.ppm-btn-purchase').should('exist')
    cy.get('.ppm-close-btn').click({ force: true })

    // The standing disclosure on the surface that can fix it.
    cy.visit('/wallet?tab=security')
    expectConnected()
    // Collapsed: the badge is the whole warning a member sees while scanning the tab, so it has to
    // say something actionable rather than a count.
    cy.get('#controllers-header', { timeout: 30000 }).should('contain.text', 'Add a backup key')
    cy.get('#controllers-header').click()
    cy.get('[data-testid="single-controller-warning"]')
      .should('have.attr', 'role', 'alert')
      .and('contain.text', 'Only one passkey controls this account')

    // And it names the two ways out, which is what makes it a warning rather than an alarm.
    cy.get('.controllers-panel').contains('button', /add a passkey/i).should('be.enabled')
    cy.get('.controllers-panel').contains('button', /link a wallet/i).should('be.enabled')
  })
})
