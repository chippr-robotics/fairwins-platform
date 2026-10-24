/**
 * E2E Tests: Multi-currency wrap — cross-chain submit (spec 108, full tier)
 *
 * `trade.wrap-cross-chain-submit` in the coverage matrix. The member signs
 * something that costs money (the wrap sends coin, plus the fee), so the e2e
 * policy's money-path rule puts EXECUTION here, on a real chain: the local
 * hardhat node (chain 80002) with the locally-deployed WMATIC recorded as the
 * chain's wrapped native.
 *
 * THE CROSS-CHAIN DEVICE (spec 102's precedent, one node): the mock wallet
 * starts on MORDOR (63) while the target coin lives on the LOCAL chain (80002).
 * Selecting the local coin and submitting forces the spec-108 switch-then-settle
 * path — `wallet_switchEthereumChain` lands on the mock, the settled signer
 * sends — and because the mock forwards real RPC to the node, the deposit() that
 * follows is a REAL transaction against the chain's own wrapper, asserted by the
 * wrapped balance the app reads back from that chain.
 *
 * Mordor's own public endpoint is stubbed DEAD in every test: no read of a live
 * chain sneaks in to prop up a test (issue #1463's lesson — a stub that leaves a
 * rail open proves nothing), and an unreadable origin chain is exactly the state
 * the picker must stay honest through.
 *
 * Checklist: WXC-01 (cross-chain wrap executes), WXC-02 (refused switch names
 * both chains, sends nothing), WXC-03 (unwrap back on the settled chain).
 */

// Hardhat default account #4 — not used as a wrap actor anywhere else, so this
// spec's wrapped balance always starts at zero.
const WRAPPER_ACCOUNT = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'

const MORDOR = 63

function stubMordorDead() {
  cy.intercept({ method: 'POST', url: /rpc\.mordor\.etccooperative\.org/ }, (req) => {
    const one = ({ id }) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'chain unreachable' } })
    req.reply({ statusCode: 200, body: Array.isArray(req.body) ? req.body.map(one) : one(req.body || {}) })
  }).as('mordorRpc')
}

function openPicker() {
  cy.get('[data-testid="wrap-coin-field"]', { timeout: 20000 })
    .find('button[aria-haspopup="listbox"]')
    .click()
}

function selectLocalCoin() {
  openPicker()
  // The local chain masquerades as Amoy (80002) — its row is the one whose
  // network the picker names as Amoy.
  cy.contains('[role="option"]', 'Amoy').click()
}

describe('Wrap across chains (spec 108)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    stubMordorDead()
  })

  it('[WXC-01] selecting another chain\'s coin switches the wallet at submit and wraps against that chain\'s own wrapper', () => {
    cy.mockWeb3Provider({ account: WRAPPER_ACCOUNT, preAuthorized: true, networkId: MORDOR })
    cy.visit('/wallet?tab=trade&view=wrap')
    selectLocalCoin()

    cy.get('#pt-wrap-amount').type('0.5')
    // Stated before the signature: the switch is disclosed, not sprung.
    cy.contains('your wallet will be asked to switch').should('be.visible')
    cy.contains('button', /^Wrap .* on .*Amoy$/).click()

    // The settled chain executed a real deposit(): the success notice appears and
    // the wrapped balance the app reads back FROM THE TARGET CHAIN carries it.
    cy.get('.pt-notice-success', { timeout: 60000 }).should('contain.text', 'Done')
    cy.get('.pt-wrap-balances').within(() => {
      cy.contains('.pt-wrap-balance', /^W/).should('contain.text', '0.5')
    })
  })

  it('[WXC-02] a refused switch names BOTH chains and sends nothing', () => {
    cy.mockWeb3Provider({
      account: WRAPPER_ACCOUNT,
      preAuthorized: true,
      networkId: MORDOR,
      rejectChainSwitch: true,
    })
    cy.visit('/wallet?tab=trade&view=wrap')
    selectLocalCoin()

    cy.get('#pt-wrap-amount').type('0.25')
    cy.contains('button', /^Wrap .* on .*Amoy$/).click()

    cy.get('[role="alert"]', { timeout: 20000 })
      .should('contain.text', 'Amoy')
      .and('contain.text', 'Mordor')
      // Spec 110 T026a — the wrap refusal is now the SHARED one (`settleWalletOn`), so this reads
      // "…so nothing has been signed" where spec 108's private loop said "— nothing was sent".
      // Four surfaces had four sentences for the identical event; the shared one is spec 102's,
      // already pinned by useActiveAccount's suite. Both chains named is the part that matters.
      .and('contain.text', 'nothing has been signed')
    cy.contains('Done —').should('not.exist')
  })

  it('[WXC-03] the unwrap direction burns 1:1 back on the settled chain', () => {
    // The wallet now starts on the local chain (the state WXC-01 left the member
    // in) — no switch involved; what is under test is the round trip.
    cy.mockWeb3Provider({ account: WRAPPER_ACCOUNT, preAuthorized: true })
    cy.visit('/wallet?tab=trade&view=wrap')

    cy.get('[data-testid="wrap-coin-field"]', { timeout: 20000 }).should('exist')
    cy.contains('[role="radio"]', 'Unwrap').click()
    cy.get('#pt-wrap-amount').type('0.2')
    cy.get('#pt-wrap-amount').should('have.value', '0.2')
    // The SUBMIT button, by its container — `cy.contains('button', /^Unwrap/)` would match
    // the direction radio first ("Unwrap WMATIC → POL" precedes it in DOM order), and
    // clicking that toggle clears the amount by design.
    cy.get('.pt-actions .pt-btn-primary').click()

    cy.get('.pt-notice-success', { timeout: 60000 }).should('contain.text', 'Done')
    // 0.5 wrapped in WXC-01, 0.2 burned here: the chain says 0.3 remains.
    cy.get('.pt-wrap-balances').within(() => {
      cy.contains('.pt-wrap-balance', /^W/).should('contain.text', '0.3')
    })
  })
})
