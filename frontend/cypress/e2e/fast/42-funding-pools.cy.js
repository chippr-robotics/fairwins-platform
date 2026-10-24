// =============================================================================
// 42-funding-pools.cy.js
// Fast-tier E2E for funding pools (spec 103) on Payments ▸ Request ▸ Pool.
//
// NO CHAIN, and deliberately so (e2e-testing-policy.md, admission rule 1). Everything here happens
// BEFORE a signature: the Direct | Pool kind switch, what the create form refuses and why, the
// public-purpose disclosure, the My Pools sheet's honest empty state and its find field, the
// Pool-kind deep link, and how a pool link renders when the chain cannot answer. The money paths —
// create, contribute, close, refund — cost the member money and live in the on-chain tier
// (full/39-funding-pools.cy.js). Nothing in this file signs or moves value.
//
// Checklist: FP-FAST-01..FP-FAST-07 (FP-FAST-03 runs last — the only test that connects a wallet)
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

// Land disconnected, then connect through the header (the same path the on-chain specs take). A
// session restored BEFORE the Payments home mounts (`preAuthorized`) is deliberately not used here.
function openPoolKind({ connect = true } = {}) {
  cy.mockWeb3Provider({ account: TEST_ACCOUNT })
  cy.visit('/app?kind=pool')
  cy.get('[data-testid="request-kind"][data-kind="pool"]', { timeout: 20000 }).should('be.visible')
  if (connect) {
    cy.get('.wallet-connect-button, button[aria-label="Connect Wallet"]', { timeout: 10000 }).click()
    cy.selectInjectedConnector()
    cy.get('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 10000 }).should('be.visible')
    cy.get('[data-testid="funding-create"]', { timeout: 20000 }).should('exist')
  }
}

const typePurpose = (text) => cy.get('#funding-purpose').clear().type(text, { delay: 0 })

describe('Funding pools — the Request ▸ Pool surface (spec 103, no chain)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    // Hermetic: the Payments home asks a public price API for the native-coin rate. Nothing here
    // depends on it, and the no-chain tier must not depend on the internet.
    cy.intercept('https://api.coingecko.com/**', { statusCode: 200, body: {} })
  })

  it('[FP-FAST-01] the Request view offers Direct | Pool; switching keeps the one-time form intact', () => {
    cy.mockWeb3Provider({ account: TEST_ACCOUNT })
    cy.visit('/app')
    // Land on Request mode (desktop pill / mobile icon nav both expose the mode by name).
    cy.get('body').then(($b) => {
      const pill = $b.find('.home-mode-switcher [role="radio"]:contains("Request")')
      if (pill.length) cy.wrap(pill.first()).click()
      else cy.get('[aria-label="Home mode"]').contains(/request/i).click({ force: true })
    })
    cy.get('[data-testid="request-kind"][data-kind="once"]', { timeout: 20000 }).should('be.visible')
    cy.get('[aria-label="Amount to request"]').should('exist')
    cy.get('[data-testid="request-kind"]').find('[role="radio"]').contains('Pool').click()
    cy.get('[data-testid="request-kind"][data-kind="pool"]').should('be.visible')
    cy.get('[data-testid="funding-create-form"]').should('exist')
    cy.get('[data-testid="request-kind"]').find('[role="radio"]').contains('Direct').click()
    cy.get('[data-testid="request-kind"][data-kind="once"]').should('be.visible')
    cy.get('[aria-label="Amount to request"]').should('exist')
  })

  it('[FP-FAST-02] /app?kind=pool deep-links straight to the Pool kind and strips the query', () => {
    openPoolKind({ connect: false })
    cy.location('search').should('not.contain', 'kind=pool')
    cy.get('#funding-purpose').should('be.visible')
    cy.get('[data-testid="funding-goal-hero"], [data-testid="amount-keypad-hero"]').should('exist')
  })

  it('[FP-FAST-04] disconnected: the Pool form is visible but the primary action offers to connect', () => {
    openPoolKind({ connect: false })
    cy.get('[data-testid="funding-create"]').should('not.exist')
    // Scoped to the Pool form: the (hidden) Pay panel carries its own "Connect wallet" button.
    cy.get('[data-testid="funding-create-form"]').contains('button', 'Connect wallet').scrollIntoView().should('be.visible')
    cy.get('[data-testid="my-pools-open"]').scrollIntoView().should('be.visible')
  })

  it('[FP-FAST-05] My Pools opens as a focus-trapped sheet with an honest empty state and a find field', () => {
    openPoolKind({ connect: false })
    cy.get('[data-testid="my-pools-open"]').scrollIntoView().click()
    cy.get('[role="dialog"][aria-label="My Pools"]').should('be.visible').within(() => {
      cy.get('[data-testid="my-pools-empty"]').should('contain.text', 'haven’t organized or contributed')
      cy.get('[data-testid="my-pools-find"]').type('only three words', { delay: 0 })
      cy.get('[data-testid="my-pools-find-go"]').click()
      cy.get('[data-testid="my-pools-find-error"]').should('contain.text', 'four words')
    })
    cy.a11yScan({ context: '[role="dialog"][aria-label="My Pools"]', label: 'my pools sheet' })
    cy.get('body').type('{esc}')
    cy.get('[role="dialog"][aria-label="My Pools"]').should('not.exist')
    // "Start a pool" from the empty state lands back on the form.
    cy.get('[data-testid="my-pools-open"]').scrollIntoView().click()
    cy.contains('button', 'Start a pool').click()
    cy.get('[data-testid="funding-create-form"]').should('be.visible')
  })

  it('[FP-FAST-06] a pool link the chain cannot answer renders as unreadable with a retry — never as zeros', () => {
    cy.mockWeb3Provider({ account: TEST_ACCOUNT })
    // Whatever the local RPC says, a random address with no code is never a pool: the page must say so
    // rather than paint a 0-of-0 bar.
    cy.visit('/fund/0x00000000000000000000000000000000000000AA')
    cy.get('[data-testid="funding-unreadable"], [data-testid="funding-not-found"]', { timeout: 30000 }).should('be.visible')
    cy.get('[role="progressbar"]').should('not.exist')
    cy.get('[data-testid="funding-raised"]').should('not.exist')
  })

  it('[FP-FAST-07] the Pool form and the sheet pass the accessibility scan', () => {
    openPoolKind({ connect: false })
    cy.a11yScan({ context: '[data-testid="funding-create-form"]', label: 'funding create form' })
  })

  // The ONE test that connects a wallet runs last: a connected Payments home leaves nothing for a later
  // test to inherit, and the form's enabled state is the only assertion that needs an account.
  it('[FP-FAST-03] the form refuses an empty purpose and a zero goal, and says the purpose is public', () => {
    openPoolKind()
    cy.get('[data-testid="funding-create"]').scrollIntoView().should('be.disabled')
    cy.get('[role="note"]').should('contain.text', 'public on-chain')
    typePurpose("Dana's surprise party")
    cy.get('[data-testid="funding-create"]').should('be.disabled') // goal still zero
    cy.enterAmountViaKeypad('funding-goal', '120')
    cy.get('[data-testid="funding-create"]').should('be.enabled')
    // The purpose counter tracks BYTES against the 200 cap ("Dana's surprise party" is 21 of them).
    cy.contains(`${new TextEncoder().encode("Dana's surprise party").length}/200`).should('exist')
    typePurpose('x'.repeat(200))
    cy.contains('200/200').should('exist')
    cy.get('#funding-purpose').should('have.attr', 'maxlength', '200')
    // Every window choice is a radio in one group; the default is 1 week.
    cy.get('[role="radio"][aria-checked="true"]').contains('1 week').should('exist')
    cy.get('[role="radio"]').contains('30 days').click()
    cy.get('[role="radio"][aria-checked="true"]').contains('30 days').should('exist')
  })
})
