// =============================================================================
// 48-wrap-multi-currency.cy.js
// Fast-tier E2E for spec 108 — the Wrap view's multi-currency picker
// (`trade.wrap-multi-currency-picker` in the coverage matrix).
//
// NO CHAIN, deliberately: what this file proves is the PICKER's honesty and the
// stated-before-signing facts — which coins are offered, that an unreadable
// balance is unknown rather than zero, that changing the coin clears the amount,
// and that a cross-chain selection DISCLOSES the coming wallet switch and refuses
// honestly (naming both chains, sending nothing) when the wallet declines. The
// wrap TRANSACTION on another chain — real value against the chain's own wrapper
// — is the on-chain tier's row (`trade.wrap-cross-chain-submit`), per the e2e
// policy's money-path rule.
//
// THE COHORT HERE IS MAINNET. The fast tier's dev server (`dev:fast`) builds the
// default (mainnet) cohort — this spec's first CI run assumed testnet and looked
// for Mordor/Amoy rows that a mainnet build honestly never offers. So the
// offered coins are the mainnet chains with a configured wrapper — Ethereum,
// Optimism, Ethereum Classic, Polygon, Base, Arbitrum — while the mock wallet's
// own chain (Hardhat 1337, testnet) is NOT in the cohort and must not be listed,
// and Sepolia (no wrapper anywhere) must not be either: absence over guessed
// addresses, and never a cross-cohort row.
//
// RPC stubbing rides issue #1463's rule: EVERY rung of every read is matched —
// publicnode + drpc for the five EVM mainnets, rivet + etcdesktop for ETC — so
// no live endpoint can quietly answer for a chain this spec declares dead.
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const WRAP_URL = '/wallet?tab=trade&view=wrap'

const ONE_ETHER = '0x0de0b6b3a7640000' // 1e18

/**
 * Stub one chain's JSON-RPC rails. `fail: true` refuses every method on every
 * rung — the chain dies whole, which is what "could not be read" means.
 */
function stubChainRpc(urlPattern, { chainIdHex, fail = false, balance = ONE_ETHER, alias }) {
  cy.intercept({ method: 'POST', url: urlPattern }, (req) => {
    const one = (payload) => {
      const { method, id } = payload
      if (fail) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'chain unreachable' } }
      }
      let result
      switch (method) {
        case 'eth_chainId': result = chainIdHex; break
        case 'net_version': result = String(parseInt(chainIdHex, 16)); break
        case 'eth_blockNumber': result = '0x1000000'; break
        case 'eth_getBalance': result = balance; break
        case 'eth_gasPrice': result = '0x3b9aca00'; break
        case 'eth_call': result = '0x'; break
        default: result = '0x'
      }
      return { jsonrpc: '2.0', id, result }
    }
    req.reply({
      statusCode: 200,
      body: Array.isArray(req.body) ? req.body.map(one) : one(req.body || {}),
    })
  }).as(alias)
}

/**
 * Both rails of every cohort chain. Polygon is the one this file kills when a
 * test needs an unreadable chain — BOTH its rungs, or live drpc answers for a
 * chain the test declared dead (issue #1463).
 */
function stubAllChains({ polygonFails = false } = {}) {
  stubChainRpc(/ethereum-rpc\.publicnode\.com|eth\.drpc\.org/, { chainIdHex: '0x1', alias: 'ethRpc' })
  stubChainRpc(/optimism-rpc\.publicnode\.com|optimism\.drpc\.org/, { chainIdHex: '0xa', alias: 'opRpc' })
  stubChainRpc(/etc\.rivet\.link|etc\.etcdesktop\.com/, { chainIdHex: '0x3d', alias: 'etcRpc' })
  stubChainRpc(/polygon-bor-rpc\.publicnode\.com|polygon\.drpc\.org/, {
    chainIdHex: '0x89',
    fail: polygonFails,
    alias: 'polygonRpc',
  })
  stubChainRpc(/base-rpc\.publicnode\.com|base\.drpc\.org/, { chainIdHex: '0x2105', alias: 'baseRpc' })
  stubChainRpc(/arbitrum-one-rpc\.publicnode\.com|arbitrum\.drpc\.org/, { chainIdHex: '0xa4b1', alias: 'arbRpc' })
}

function openPicker() {
  cy.get('[data-testid="wrap-coin-field"]', { timeout: 15000 })
    .find('button[aria-haspopup="listbox"]')
    .click()
}

describe('Wrap — multi-currency picker (spec 108)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true })
  })

  it('[WMC-01] offers every wrappable cohort coin with its network — and nothing it cannot resolve', () => {
    stubAllChains()
    cy.visit(WRAP_URL)
    openPicker()
    cy.get('[role="listbox"]').within(() => {
      cy.contains('[role="option"]', 'Ethereum Classic').should('exist')
      cy.contains('[role="option"]', 'Polygon').should('exist')
      cy.contains('[role="option"]', 'Base').should('exist')
      cy.contains('[role="option"]', 'Optimism').should('exist')
      cy.contains('[role="option"]', 'Arbitrum').should('exist')
      // Sepolia has no configured wrapper anywhere: absent, never a disabled row
      // wearing a guessed address.
      cy.contains('[role="option"]', 'Sepolia').should('not.exist')
      // The mock wallet's own chain (Hardhat, testnet) is outside the mainnet
      // cohort — constitution III: the list never crosses the cohort boundary,
      // whatever the wallet is connected to.
      cy.contains('[role="option"]', 'Hardhat').should('not.exist')
    })
  })

  it('[WMC-02] an unreadable chain shows an unknown balance — never a zero — and stays selectable with the switch disclosed', () => {
    stubAllChains({ polygonFails: true })
    cy.visit(WRAP_URL)
    cy.wait('@polygonRpc')
    openPicker()
    cy.contains('[role="option"]', 'Polygon')
      .should('not.contain.text', 'Balance: 0')
      .click()
    // The selection is honest about the failed read, and about the switch to come.
    cy.contains('could not be read just now').should('be.visible')
    cy.contains('unknown, not zero').should('be.visible')
    cy.get('#pt-wrap-amount').type('0.5')
    cy.contains('your wallet will be asked to switch').should('be.visible')
    cy.contains('button', /^Wrap .* on Polygon$/).should('be.enabled')
  })

  it('[WMC-03] changing the coin clears the amount — a MAX quoted on one chain never rides to another', () => {
    stubAllChains()
    cy.visit(WRAP_URL)
    cy.get('#pt-wrap-amount', { timeout: 15000 }).type('2.5')
    openPicker()
    cy.contains('[role="option"]', 'Ethereum Classic').click()
    cy.get('#pt-wrap-amount').should('have.value', '')
  })

  it('[WMC-04] a refused wallet switch names BOTH chains and sends nothing', () => {
    stubAllChains()
    // The mock wallet declines wallet_switchEthereumChain — the member pressing
    // Cancel, or a wallet with no such chain.
    cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true, rejectChainSwitch: true })
    cy.visit(WRAP_URL)
    openPicker()
    cy.contains('[role="option"]', 'Ethereum Classic').click()
    cy.get('#pt-wrap-amount').type('0.25')
    cy.contains('button', /^Wrap ETC on Ethereum Classic$/).click()
    cy.get('[role="alert"]', { timeout: 15000 })
      .should('contain.text', 'Ethereum Classic')
      .and('contain.text', 'Hardhat')
      // Spec 110 T026a — the wrap refusal is now the SHARED one (`settleWalletOn`), so this reads
      // "…so nothing has been signed" where spec 108's private loop said "— nothing was sent".
      // Four surfaces had four sentences for the identical event; the shared one is spec 102's,
      // already pinned by useActiveAccount's suite. Both chains named is the part that matters.
      .and('contain.text', 'nothing has been signed')
    // No success notice, no receipt — the refusal is the whole outcome.
    cy.contains('Done —').should('not.exist')
  })
})
