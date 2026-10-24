// =============================================================================
// 40-account-add-wrap-move.cy.js
// Fast-tier E2E for two release-1.14.0 surface moves:
//
//   account.add-chooser  — the account carousel's "+" opens a chooser whose three
//                          options deep-link to the EXISTING add/recover surfaces
//                          (Protect ▸ On chain / Off chain, Recovery ▸ legacy import)
//   trade.wrap-view      — Wrap is a view of Trade (`?tab=trade&view=wrap`), and the
//                          old Transfer wrap URL redirects there instead of dying
//
// NO CHAIN. Both are pure navigation/URL contracts: which sheet opens, which tab and
// accordion card a click lands on, and where a legacy URL resolves. The wrap
// TRANSACTION (a real deposit()/withdraw()) is the on-chain tier's concern; nothing
// here signs or moves value.
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('Account "+" chooser (release 1.14.0)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true })
    cy.visit('/wallet?tab=account')
    cy.get('[data-testid="account-add-open"]', { timeout: 15000 }).should('be.visible')
  })

  it('[ACC-ADD-01] the "+" opens the chooser with the three ways to add an account', () => {
    cy.get('[data-testid="account-add-open"]').click()
    cy.get('[role="dialog"][aria-label="Add an account"]').within(() => {
      cy.contains('button', 'Add a vault').should('be.visible')
      cy.contains('button', 'Add a hardware account').should('be.visible')
      cy.contains('button', 'Recover a legacy account').should('be.visible')
    })
  })

  it('[ACC-ADD-02] "Add a hardware account" lands on Protect with the Off chain card open', () => {
    cy.get('[data-testid="account-add-open"]').click()
    cy.contains('button', 'Add a hardware account').click()
    cy.location('search').should('include', 'tab=custody')
    cy.location('hash').should('eq', '#custody-offchain')
    // The deep link's whole point: the accordion card is OPEN on arrival, not a
    // collapsed heading the member has to hunt for.
    cy.get('[data-testid="custody-acc-offchain"]', { timeout: 15000 })
      .find('[aria-expanded="true"]')
      .should('exist')
  })

  it('[ACC-ADD-03] "Add a vault" lands on Protect ▸ On chain', () => {
    cy.get('[data-testid="account-add-open"]').click()
    cy.contains('button', 'Add a vault').click()
    cy.location('search').should('include', 'tab=custody')
    cy.location('hash').should('eq', '#custody-onchain')
  })

  it('[ACC-ADD-04] "Recover a legacy account" lands on Recovery at the legacy import card', () => {
    cy.get('[data-testid="account-add-open"]').click()
    cy.contains('button', 'Recover a legacy account').click()
    cy.location('search').should('include', 'tab=security')
    cy.location('hash').should('eq', '#legacy-recovery')
  })
})

describe('Wrap inside Trade (release 1.14.0)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true })
  })

  it('[TRADE-WRAP-01] ?tab=trade&view=wrap renders the wrap form beside Swap', () => {
    cy.visit('/wallet?tab=trade&view=wrap')
    cy.get('[data-attention="trade-wrap"]', { timeout: 15000 }).should('exist')
    cy.get('[role="tab"][aria-selected="true"]').should('contain.text', 'Wrap')
    // The view is the untouched WrapView — its direction control is its signature.
    cy.get('[data-attention="trade-wrap"]').contains('Direction').should('exist')
  })

  it('[TRADE-WRAP-02] Swap stays the Trade default', () => {
    cy.visit('/wallet?tab=trade')
    cy.get('[role="tab"][aria-selected="true"]', { timeout: 15000 }).should('contain.text', 'Swap')
    cy.get('[data-attention="trade-wrap"]').should('not.exist')
  })

  it('[TRADE-WRAP-03] the old Transfer wrap URL redirects to the Trade location', () => {
    cy.visit('/wallet?tab=paytransfer&view=wrap')
    cy.location('search', { timeout: 15000 }).should('eq', '?tab=trade&view=wrap')
    cy.get('[data-attention="trade-wrap"]').should('exist')
  })

  it('[TRADE-WRAP-04] Transfer no longer offers a Wrap tab of its own', () => {
    cy.visit('/wallet?tab=paytransfer')
    cy.contains('[role="tab"]', 'Transfer', { timeout: 15000 }).should('exist')
    cy.contains('[role="tab"]', 'Wrap').should('not.exist')
  })
})
