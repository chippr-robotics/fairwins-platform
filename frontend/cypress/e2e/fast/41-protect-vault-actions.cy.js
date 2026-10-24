// =============================================================================
// 41-protect-vault-actions.cy.js
// Fast-tier E2E for the Protect vault ActionSheet (release 1.14.0, specs 043/049/068).
//
// Runs WITHOUT a chain. Everything asserted here is decided in the client before any signature:
// which of the four vault actions the sheet offers, why it closes the others, and the guided
// creation flow's own contract (spec 105) — presets that resolve the arrangement, the rules tile
// grid with its live summary, and the refusal of the one configuration the flow will not produce
// (a single owner, a single approval, no rules).
//
// Deliberately no-chain per the tier admission rule: nothing below submits a transaction or costs
// a member anything. The deploy itself, the guard that ends up in the vault's storage slot, and the
// propose/approve cycle are the on-chain tier's job (full/29-protect-custody.cy.js, CV-01..CV-07).
//
// Sub-issue of #1228. Flows:
//   VA-01 custody.vault-action-sheet   — one door, four actions
//   VA-02 custody.create-vault         — the rules grid + live summary (spec 105 sheet 2)
//   VA-03 custody.create-vault         — presets resolve the arrangement (spec 105 sheet 1)
//   VA-04 custody.create-vault         — 1-of-1 with no rules is refused, honestly
//   VA-05 custody.vault-action-sheet   — closed actions are shown with their reason, never hidden
//
// Checklist: VA-01..VA-06
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OWNER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const OWNER_C = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const OWNER_D = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'

// Polygon: a real custody chain with Safe v1.4.1 AND the spec-068 ordered policy engine, so the
// sheet offers creation and the starter policy is genuinely available. No RPC is reachable in this
// tier — which is fine, because nothing here reads the chain.
const CUSTODY_CHAIN = 137

function openProtect() {
  cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true, networkId: CUSTODY_CHAIN })
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 15000 }).should('be.visible')
  cy.get('.custody-onchain').should('be.visible')
}

const openSheet = () => cy.get('[data-testid="custody-open-vault-actions"]').click()

function openCreate() {
  openSheet()
  cy.get('[data-testid="vault-action-create"]').click()
  // Spec 105 — creation is the guided four-sheet flow; the first sheet is the type picker.
  cy.get('[data-testid="create-step-type"]').scrollIntoView().should('be.visible')
}

function addOwner(address) {
  cy.get('[data-testid="create-step-type"]').contains('button', 'Add owner').click()
  cy.get('[data-testid="create-step-type"] input[id^="create-owner-"]').last().clear().type(address)
}

function setOwner(i, address) {
  cy.get(`#create-owner-${i}`).clear().type(address)
}

describe('Protect — vault ActionSheet (release 1.14.0)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  // ---------------------------------------------------------------------------
  // VA-01 — one door, four actions
  // ---------------------------------------------------------------------------
  it('[VA-01] opens one sheet offering all four vault actions', () => {
    openProtect()
    // Closed by default: the sheet is a door, not a permanent panel taking up the card.
    cy.get('[data-testid="vault-action-create"]').should('not.exist')

    openSheet()
    cy.get('[role="dialog"]').should('be.visible')
    cy.get('[data-testid="vault-action-create"]').should('be.visible').and('not.be.disabled')
    cy.get('[data-testid="vault-action-load"]').should('be.visible').and('not.be.disabled')
    cy.get('[data-testid="vault-action-propose"]').should('be.visible')
    cy.get('[data-testid="vault-action-approve"]').should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // VA-02 — the starter policy is the default, and it states what it will enforce
  // ---------------------------------------------------------------------------
  it('[VA-02] the rules grid opens pre-filled and its summary states the arrangement (spec 105)', () => {
    openProtect()
    openCreate()
    setOwner(0, OWNER_B)
    setOwner(1, OWNER_C)
    cy.contains('button', 'Next: set rules').click()
    cy.get('[data-testid="create-step-rules"]').should('be.visible')
    // The tiles state their CURRENT values; the summary is rebuilt from the same config that will
    // be realized on every network, so it cannot claim something the rules will not enforce.
    cy.get('[data-testid="rule-tile-cap"]').should('contain.text', '$500')
    cy.get('[data-testid="rule-tile-wait"]').should('contain.text', '1 hour')
    cy.get('[data-testid="rules-summary"]').should('contain.text', 'Up to 500 of everyday money')
    cy.get('[data-testid="rules-summary"]').should('contain.text', 'no back-to-back moves')
    // Editing a tile updates the summary before anything is signed.
    cy.get('[data-testid="rule-tile-cap"]').click()
    cy.get('input[aria-label="Daily cap amount"]').clear().type('250')
    cy.get('[data-testid="rules-summary"]').should('contain.text', 'Up to 250 of everyday money')
  })

  // ---------------------------------------------------------------------------
  // VA-03 — the threshold suggestion follows the owner list, then stops
  // ---------------------------------------------------------------------------
  it('[VA-03] presets resolve the arrangement — only Complex ever shows a threshold control (spec 105)', () => {
    openProtect()
    openCreate()
    // Joint: exactly two owners, one signature, no threshold control anywhere.
    cy.get('[data-testid="create-step-type"]').contains('[role="radio"]', 'Joint account')
      .should('have.attr', 'aria-checked', 'true')
    cy.get('input[id^="create-owner-"]').should('have.length', 2)
    cy.get('input[type="number"]').should('not.exist')

    // Controlled: everyone signs — n of n follows the owner list.
    cy.get('[data-testid="create-step-type"]').contains('[role="radio"]', 'Controlled').click()
    setOwner(0, OWNER_B)
    setOwner(1, OWNER_C)
    cy.contains(/all 2 owners must sign every move/i).should('exist')
    addOwner(OWNER_D)
    cy.contains(/all 3 owners must sign every move/i).should('exist')

    // Complex: the member picks m of n, defaulted to a majority, and their number then sticks.
    cy.get('[data-testid="create-step-type"]').contains('[role="radio"]', 'Complex').click()
    cy.get('input[type="number"]').should('have.value', '2') // ceil(3/2)
    cy.get('input[type="number"]').type('{selectall}3').should('have.value', '3')
    addOwner('0x00000000000000000000000000000000000000AA')
    cy.get('input[type="number"]').should('have.value', '3')
  })

  // ---------------------------------------------------------------------------
  // VA-04 — the 1-of-1-with-no-policy refusal, and both ways out of it
  // ---------------------------------------------------------------------------
  it('[VA-04] refuses a single-owner single-signature vault with no rules, and says what to do instead', () => {
    openProtect()
    openCreate()
    // A one-owner Complex vault with the rules switched off is the one configuration the flow
    // will not produce (spec 105 FR-003).
    cy.get('[data-testid="create-step-type"]').contains('[role="radio"]', 'Complex').click()
    cy.contains('button', 'Next: set rules').click()
    cy.get('[data-testid="rule-tile-cap"]').click()
    cy.get('input[aria-label="Daily cap amount"]').clear()
    cy.get('[data-testid="rule-tile-wait"]').click()
    cy.contains('[role="radio"]', 'No wait').click()
    cy.get('[data-testid="rule-tile-allowed"]').click()
    cy.contains('[role="radio"]', /Everything — one set of rules/).click()
    cy.contains('button', 'Next: pick networks').click()
    cy.get('[role="alert"]').should('contain.text', 'wallet wearing a vault badge')
    cy.get('[data-testid="create-step-networks"]').should('not.exist')

    // Way out — keep at least one rule, and the same tap proceeds.
    cy.get('[data-testid="rule-tile-cap"]').click()
    cy.get('input[aria-label="Daily cap amount"]').type('500')
    cy.contains('button', 'Next: pick networks').click()
    cy.get('[data-testid="create-step-networks"]').should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // VA-05 — a closed action is shown with its reason, never withdrawn
  // ---------------------------------------------------------------------------
  it('[VA-05] states why propose and approve are closed with no vault open', () => {
    openProtect()
    openSheet()
    cy.get('[data-testid="vault-action-propose"]')
      .should('be.disabled')
      .and('contain.text', 'Open a vault in the list below first')
    cy.get('[data-testid="vault-action-approve"]')
      .should('be.disabled')
      .and('contain.text', 'Open a vault in the list below first')
    // Creating and loading need no vault, so they stay open — the sheet distinguishes the two.
    cy.get('[data-testid="vault-action-create"]').should('not.be.disabled')
  })

  // ---------------------------------------------------------------------------
  // VA-06 — navigation: back to the chooser, and Escape closes the sheet
  // ---------------------------------------------------------------------------
  it('[VA-06] returns to the chooser, and reopening never lands on an abandoned form', () => {
    openProtect()
    openCreate()
    cy.get('[data-testid="vault-action-back"]').click()
    cy.get('[data-testid="vault-action-create"]').should('be.visible')
    cy.get('[data-testid="create-step-type"]').should('not.exist')

    // The shell's own Escape/backdrop handling has unit coverage (ActionSheet); what matters here
    // is that closing this sheet forgets where the member was.
    cy.get('[role="dialog"] [aria-label="Close"]').click()
    cy.get('[role="dialog"]').should('not.exist')
    // Reopening lands on the chooser, never on a form the member walked away from.
    openSheet()
    cy.get('[data-testid="vault-action-create"]').should('be.visible')
    cy.get('[data-testid="create-step-type"]').should('not.exist')
  })

  // ---------------------------------------------------------------------------
  // Accessibility — the sheet is a modal dialog the app portals over the page, so the scan is
  // scoped to its own root (spec 094).
  // ---------------------------------------------------------------------------
  it('[VA-A11Y] the open vault sheet has no serious or critical violations', () => {
    openProtect()
    openSheet()
    cy.get('[role="dialog"]').then(($sheet) => {
      cy.a11yScan({ context: $sheet[0], label: 'vault action sheet' })
    })
  })
})
