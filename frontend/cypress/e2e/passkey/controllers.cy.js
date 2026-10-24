// =============================================================================
// spec 041 T046–T050 — the keys that can move the money (US4 / FR-018–FR-020).
//
// ACCOUNT-NATIVE TIER, full stack. Every assertion here is about the account's
// ON-CHAIN owner set, and every mutation is a real sponsored UserOperation
// through the local EntryPoint + alto bundler, so this spec cannot run without
// the stack the `cypress-passkey-full-stack` job brings up. It skips honestly
// otherwise — a controller change that never reached a chain would be a claim
// about a React list, not about who can spend.
//
// Why the chain is read at all when the panel already lists controllers: the
// panel renders `readControllers`, so asserting only the list would let a
// display bug and a working contract look identical, and would let a FAILED
// UserOp look like a successful one for as long as the optimistic list stayed
// up. `ownerCount()` on the account is the fact that decides who can sign.
//
// The three testids this file used to drive — `passkey-account-address` and a
// `/fairwins/account` route — do not exist and never did in the shipped app.
// The address renders in the header account control (support/webauthn.js
// documents why) and the controllers panel is a COLLAPSED accordion card on
// the Recovery tab (`/wallet?tab=security`), so it has to be opened first.
// =============================================================================

import {
  addVirtualAuthenticator,
  choosePasskey,
  connectedAddress,
  expectConnected,
  isChromium,
  resetAuthenticators,
} from '../../support/webauthn'

const CREDENTIALS_KEY = 'fairwins.passkey.credentials.v1'
const PANEL = '.controllers-panel'
const ROW = '[data-testid^="controller-"]'
// All-lowercase on purpose: a mixed-case address is a CHECKSUM claim, and ethers rejects a wrong one
// before it ever reaches the guard — which would fail the fixture, not the product.
const FLAGGED = '0xcccccccccccccccccccccccccccccccccccccccc'

/** The session credential's P-256 key as the account's owner entry — x ‖ y, 64 bytes. */
function ownerBytesFromStorage(win, address) {
  const book = JSON.parse(win.localStorage.getItem(CREDENTIALS_KEY) || '[]')
  const cred = book.find((c) => c.address?.toLowerCase() === address.toLowerCase()) || book[0]
  if (!cred?.publicKey?.x) throw new Error('no passkey credential with a public key in this browser')
  return `0x${cred.publicKey.x.slice(2).padStart(64, '0')}${cred.publicKey.y.slice(2).padStart(64, '0')}`
}

/** Open the Recovery tab's controllers card. It is an accordion and starts CLOSED. */
function openControllers() {
  cy.visit('/wallet?tab=security')
  cy.get('#controllers-header', { timeout: 30000 }).click()
  cy.get('#controllers-header').should('have.attr', 'aria-expanded', 'true')
  return cy.get(PANEL, { timeout: 20000 }).should('exist')
}

;(isChromium ? describe : describe.skip)('Account controllers (US4)', () => {
  let account

  beforeEach(function () {
    // The bundler, the EntryPoint and the paymaster are all real here; without them a controller
    // mutation cannot be submitted at all, so pretending to run would report a pass for nothing.
    if (!Cypress.env('PASSKEY_FULL_STACK')) this.skip()
    cy.clearLocalStorage()
    cy.clearCookies()
    resetAuthenticators()
    addVirtualAuthenticator()

    cy.visit('/fairwins')
    cy.contains('button', /connect wallet/i).click()
    choosePasskey()
    expectConnected()
    connectedAddress().then((address) => {
      account = address
      cy.window().then((win) => {
        const ownerBytes = ownerBytesFromStorage(win, address)
        // Fund AND activate: the panel disables every mutation while the account is counterfactual,
        // which is the honest product behaviour (there is nothing on chain to change yet).
        cy.task('seedUsdcForActiveSession', { address, usdc: '1000', ownerBytes }).then((r) => {
          expect(r.deployed, 'the account is activated on chain before controller work begins').to.equal(true)
        })
      })
    })
  })

  it('[CT-01] adding a second passkey changes the account owner set, and the risk warning clears', () => {
    cy.then(() => cy.task('passkeyStack', { action: 'ownerCount', args: { address: account } }))
      .then((r) => expect(r.ownerCount, 'a fresh account has exactly one key').to.equal(1))

    openControllers()
    cy.get('[data-testid="single-controller-warning"]').should('exist')
    cy.get(ROW).should('have.length', 1)

    // The panel button opens an informed-consent sheet; the ceremony starts from inside it.
    cy.get(PANEL).contains('button', /add a passkey/i).click()
    cy.get('.action-sheet').contains('button', /create passkey/i).click()

    // One WebAuthn creation ceremony + one sponsored UserOp. 90s because that is a real bundle:
    // estimation, a sponsorship round-trip to the gateway, submission and inclusion.
    cy.get(ROW, { timeout: 90000 }).should('have.length', 2)
    cy.get('[data-testid="single-controller-warning"]').should('not.exist')

    // THE CLAIM. Two keys can now sign for this account, according to the account.
    cy.task('passkeyStack', { action: 'ownerCount', args: { address: account } }).then((r) => {
      expect(r.ownerCount, 'the account contract reports two owners').to.equal(2)
    })
  })

  it('[CT-02] removing a controller removes it on chain, and the last one cannot be removed', () => {
    openControllers()
    cy.get(PANEL).contains('button', /add a passkey/i).click()
    cy.get('.action-sheet').contains('button', /create passkey/i).click()
    cy.get(ROW, { timeout: 90000 }).should('have.length', 2)

    // Remove the key that was just ADDED, by its on-chain owner index (0 is the account's initial
    // owner — the session's key; 1 is the one added above). Both rows read "(this device)" here:
    // `isThisDevice` means "matches a credential stored in this browser", and the new passkey was
    // created by this browser too, so the badge cannot tell the two apart. Removing the session's
    // own key would strand the browser mid-spec, and the product warns about exactly that.
    cy.get('[data-testid="controller-1"]').find('[aria-label^="Remove"]').click()
    cy.get('.action-sheet').contains('button', /remove controller/i).click()

    cy.get(ROW, { timeout: 90000 }).should('have.length', 1)
    cy.task('passkeyStack', { action: 'ownerCount', args: { address: account } }).then((r) => {
      expect(r.ownerCount, 'the account contract is back to one owner').to.equal(1)
    })

    // FR-020: the client refuses before the ceremony, and the contract refuses regardless — this
    // asserts the half a member can see. An account with one key removable from the UI is an
    // account a stray tap can lock forever.
    cy.get(ROW).find('[aria-label^="Remove"]').should('be.disabled')
  })

  it('[CT-03] linking a flagged wallet is refused before anything is signed (clarification Q2)', () => {
    cy.task('flagAddress', FLAGGED).then((r) => expect(r.denied, 'the guard really holds the flag').to.equal(true))

    openControllers()
    cy.get(PANEL).contains('button', /link a wallet/i).click()
    cy.get('.action-sheet').find('input[aria-label="Wallet address to link"]').type(FLAGGED)
    cy.get('.action-sheet').contains('button', /^link wallet$/i).click()

    // The screening gate runs BEFORE the on-chain op, so the member is told why and no ceremony
    // is ever raised. "Screening is unavailable" would be a DIFFERENT (fail-closed) refusal and is
    // deliberately not accepted here: this address is flagged, and saying so is the requirement.
    cy.get('.action-sheet [role="alert"]', { timeout: 30000 })
      .should('contain.text', 'flagged by sanctions screening')

    // Nothing was linked — asserted on the chain, because a list that has not refreshed and a
    // contract that refused look the same in the DOM.
    cy.task('passkeyStack', { action: 'ownerCount', args: { address: account } }).then((r) => {
      expect(r.ownerCount, 'no owner was added').to.equal(1)
    })
  })
})
