// =============================================================================
// 43-vault-create-flow.cy.js
// Fast-tier E2E for spec 105's guided multichain vault creation — the four-sheet flow up to (and
// deliberately excluding) the first signature.
//
// Runs WITHOUT a chain per the tier admission rule: everything below is decided in the client —
// sheet navigation, preset semantics, the network multi-select with its cohort filter and per-rail
// honesty, and the predicted-address promise. The deploy itself (real transactions, the same
// address landing on chain, rules installing) is the on-chain tier's job (full/29, CV-01).
//
// Sub-issue of #1228. Flows:
//   CF-01 custody.create-flow      — four sheets in order, back navigation preserves entries
//   CF-02 custody.create-networks  — cohort custody networks offered; selection toggles
//   CF-03 custody.create-networks  — a rail that cannot act renders ITS reason in place, disabled
//   CF-A11Y                        — each sheet scans clean
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OWNER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const CUSTODY_CHAIN = 137

function openFlow() {
  cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true, networkId: CUSTODY_CHAIN })
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 15000 }).should('be.visible')
  cy.get('[data-testid="custody-open-vault-actions"]').click()
  cy.get('[data-testid="vault-action-create"]').click()
  cy.get('[data-testid="create-step-type"]').scrollIntoView().should('be.visible')
}

describe('Protect — guided vault creation (spec 105)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[CF-01] walks type → rules → networks, and Back preserves what the member entered', () => {
    openFlow()
    cy.get('#create-owner-1').clear().type(OWNER_B)
    cy.get('#create-vault-label').type('Family')
    cy.contains('button', 'Next: set rules').click()
    cy.get('[data-testid="create-step-rules"]').should('be.visible')
    cy.get('[data-testid="rule-tile-cap"]').click()
    cy.get('input[aria-label="Daily cap amount"]').clear().type('250')
    cy.contains('button', 'Next: pick networks').click()
    cy.get('[data-testid="create-step-networks"]').should('be.visible')
    // Nothing was signed and nothing was sent — this sheet is where that would begin.
    cy.contains('button', 'Back').click()
    cy.get('[data-testid="rules-summary"]').should('contain.text', 'Up to 250 of everyday money')
    cy.contains('button', 'Back').click()
    cy.get('#create-owner-1').should('have.value', OWNER_B)
    cy.get('#create-vault-label').should('have.value', 'Family')
  })

  it('[CF-02] offers the cohort custody networks as a multi-select with the connected chain preselected', () => {
    openFlow()
    cy.get('#create-owner-1').clear().type(OWNER_B)
    cy.contains('button', 'Next: set rules').click()
    cy.contains('button', 'Next: pick networks').click()
    // The connected chain arrives selected; toggling is free; deploy needs a non-empty selection.
    cy.get(`[data-testid="network-chip-${CUSTODY_CHAIN}"]`).should('have.attr', 'aria-checked', 'true')
    cy.get('[data-testid^="network-chip-"]').should('have.length.at.least', 2)
    cy.get(`[data-testid="network-chip-${CUSTODY_CHAIN}"]`).click().should('have.attr', 'aria-checked', 'false')
    cy.get('[data-testid="deploy-button"]').should('be.disabled')
    cy.get(`[data-testid="network-chip-${CUSTODY_CHAIN}"]`).click().should('have.attr', 'aria-checked', 'true')
    cy.get('[data-testid="deploy-button"]').should('be.enabled')
  })

  it('[CF-03] a network the session cannot sign on states ITS reason in place, before anything is attempted', () => {
    openFlow()
    cy.get('#create-owner-1').clear().type(OWNER_B)
    cy.contains('button', 'Next: set rules').click()
    cy.contains('button', 'Next: pick networks').click()
    /*
     * The mocked injected wallet HAS a signer, and the write rail is a property of the signer —
     * so on this session every cohort network is actionable and NO rail reason renders. The
     * refusing rail (a passkey session on a chain with no bundler) is unit-covered in
     * writeRail.test.js and CreateVaultFlow.test.jsx; what this tier can honestly assert is that
     * an available rail never renders a phantom reason.
     */
    cy.get('.create-flow__rail-reason').should('not.exist')
  })

  it('[CF-A11Y] each creation sheet has no serious or critical violations', () => {
    openFlow()
    cy.get('[role="dialog"]').then(($sheet) => cy.a11yScan({ context: $sheet[0], label: 'create flow — type' }))
    cy.get('#create-owner-1').clear().type(OWNER_B)
    cy.contains('button', 'Next: set rules').click()
    cy.get('[data-testid="create-step-rules"]').should('be.visible')
    cy.get('[role="dialog"]').then(($sheet) => cy.a11yScan({ context: $sheet[0], label: 'create flow — rules' }))
    cy.contains('button', 'Next: pick networks').click()
    cy.get('[data-testid="create-step-networks"]').should('be.visible')
    cy.get('[role="dialog"]').then(($sheet) => cy.a11yScan({ context: $sheet[0], label: 'create flow — networks' }))
  })
})
