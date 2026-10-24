// =============================================================================
// 44-bitcoin-network-card.cy.js
// Fast-tier E2E for opening the Bitcoin wallet surface from its network card
// (spec 061). Matrix row `bitcoin.network-card-activates`, issue #1364.
//
// ── WHY THIS IS NO-CHAIN, NOT PASSKEY-TIER ───────────────────────────────────
// `NetworkPanel`'s Bitcoin card (frontend/src/components/account/NetworkPanel.jsx
// ~L37-124, `BitcoinNetworkCard`) renders and activates for ANY connected wallet —
// there is no `loginMethod === 'passkey'` gate on the card itself, only on what
// `useBitcoinWallet` later reports once you are on the surface it opens
// (frontend/src/hooks/useBitcoinWallet.js `availability`: 'non-passkey login →
// unavailable'). So the flow under test here — the card renders, activating it
// navigates by STRING id with no EVM chain switch — needs no passkey and no chain,
// and belongs in the fast tier per admission rule 1. (The PRF-gated "locked ->
// unlock -> rotate addresses" flows already have dedicated passkey-tier coverage:
// bitcoin-receive.cy.js / bitcoin-send-fee.cy.js.)
//
// ── THE ASSERTION THIS FILE EXISTS FOR ───────────────────────────────────────
// Bitcoin has no EVM chainId (bitcoinNetworks.js header: "never assign Bitcoin a
// numeric chainId... guard every shared boundary with isBitcoinNetworkId").
// `openBitcoin()` (NetworkPanel.jsx) never calls wagmi's `switchChain` for a
// Bitcoin id — it navigates. [BC-02] proves that at the wallet PROVIDER, not just
// by reading the source: a spy on the mocked `window.ethereum.request` (installed
// AFTER cy.mockWeb3Provider + cy.visit — anti-pattern #4, a spy registered before
// the mock's window:before:load handler runs finds nothing to wrap) must show NO
// `wallet_switchEthereumChain` / `wallet_addEthereumChain` call across the click.
//
// ── THE HONEST DEGRADE THIS FLOW ACTUALLY OWNS ───────────────────────────────
// The surface the card opens is the wallet's Transfer view (the card's own copy:
// '"Use" opens the wallet's Transfer surface, where Bitcoin send, receive and
// balances live'). For the mocked CLASSIC wallet used here, `useBitcoinWallet`'s
// availability is structurally 'unavailable' (no passkey to derive from), and
// TransferForm only ever adds the BTC asset option when `btc.status === 'ready'`
// (TransferForm.jsx ~L145). [BC-03] reads that back literally: after activating
// from the card, the asset picker must not fabricate a BTC option for an account
// that cannot back one — the same "never invent a balance" rule AS-01 proves for
// a pending read, applied to a whole asset that structurally does not exist here.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const NETWORK_URL = '/wallet?tab=network'
// Every shipped read provider this build resolves runs through publicnode et al.
// (same host list as 35-navigation-and-lookup.cy.js's chainWorld()).
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/

/** Answer just enough of the RPC surface that the app renders without hanging. */
function chainWorld() {
  cy.intercept({ method: 'POST', hostname: RPC_HOSTS }, (req) => {
    const one = ({ method, id }) => {
      const reply = (result) => ({ jsonrpc: '2.0', id, result })
      if (method === 'eth_chainId') return reply('0x89')
      if (method === 'eth_blockNumber') return reply('0x4000000')
      if (method === 'eth_getBalance') return reply('0x0')
      return reply('0x')
    }
    const body = req.body
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  })
}

/** A CLASSIC (injected) wallet on Polygon mainnet — the account Bitcoin cannot serve. */
function connect() {
  cy.mockWeb3Provider({
    account: ACCOUNT,
    preAuthorized: true,
    networkId: 137,
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
  })
}

const waitForAccount = () => cy.get('[aria-label="Wallet Account"]', { timeout: 40000 }).should('exist')

/**
 * The Bitcoin card whose visible name matches exactly (`.contains` is substring —
 * "Bitcoin" would also match "Bitcoin Testnet4", so the name is anchored).
 */
function bitcoinCard(name) {
  return cy
    .contains('.network-card .network-name', new RegExp(`^${name}$`), { timeout: 20000 })
    .closest('.network-card')
}

describe('Bitcoin network card activation (spec 061)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[BC-01] bitcoin.network-card-activates — the Bitcoin card renders, mainnet actionable and testnet display-only', () => {
    /*
     * Chain 137 (Polygon, connected) is NOT testnet, so
     * getActiveBitcoinNetworkId(false) === 'bitcoin' (mainnet) is the side FR-021
     * offers for use; 'bitcoin-testnet' mirrors the pair for documentation only
     * (constitution III: never both sides of the pair at once).
     */
    chainWorld()
    connect()
    cy.visit(NETWORK_URL)
    waitForAccount()

    bitcoinCard('Bitcoin').within(() => {
      cy.get('.network-kind').should('contain.text', 'Mainnet')
      cy.get('button[aria-label="Use Bitcoin"]').should('exist').and('be.enabled')
      cy.contains(/opens the wallet's transfer surface/i).should('exist')
    })

    bitcoinCard('Bitcoin Testnet4').within(() => {
      cy.get('.network-kind').should('contain.text', 'Testnet')
      cy.get('.network-active-badge.network-display-only-badge', { timeout: 20000 }).should(
        'contain.text',
        'No wallet switch',
      )
      // The non-actionable side of the pair carries no activation control at all —
      // this is what "only one side is ever offered" means at the DOM, not just in prose.
      cy.get('button[aria-label]').should('not.exist')
    })
  })

  it('[BC-02] bitcoin.network-card-activates — activating navigates by STRING id, with no EVM chain switch requested', () => {
    chainWorld()
    connect()
    cy.visit(NETWORK_URL)
    waitForAccount()

    // Installed AFTER the mock's window:before:load handler has already run (the visit
    // above completed) — a spy attached any earlier would wrap nothing (anti-pattern #4).
    cy.window().then((win) => {
      cy.spy(win.ethereum, 'request').as('ethRequest')
    })

    bitcoinCard('Bitcoin').find('button[aria-label="Use Bitcoin"]').click()

    // The card's own navigation target (openBitcoin -> navigate('/wallet?tab=paytransfer')).
    cy.location('search', { timeout: 20000 }).should('include', 'tab=paytransfer')

    cy.get('@ethRequest').then((spy) => {
      const methods = spy.getCalls().map((call) => call.args[0]?.method)
      expect(methods, 'no wallet_switchEthereumChain for a Bitcoin activation').to.not.include(
        'wallet_switchEthereumChain',
      )
      expect(methods, 'no wallet_addEthereumChain for a Bitcoin activation').to.not.include(
        'wallet_addEthereumChain',
      )
    })
  })

  it('[BC-03] bitcoin.network-card-activates — the Transfer surface it opens never fabricates a BTC option for a wallet that cannot back one', () => {
    chainWorld()
    connect()
    cy.visit(NETWORK_URL)
    waitForAccount()

    bitcoinCard('Bitcoin').find('button[aria-label="Use Bitcoin"]').click()
    cy.location('search', { timeout: 20000 }).should('include', 'tab=paytransfer')

    cy.get('[aria-label="Asset to send"]', { timeout: 20000 }).first().click()
    cy.get('[role="option"]', { timeout: 20000 }).should('have.length.at.least', 1)
    // Falsifiable both ways: at least one real (non-Bitcoin) asset is listed, proving
    // the picker actually opened and populated, and none of them is BTC.
    cy.get('[role="option"] .uas-sym').each(($sym) => {
      expect($sym.text().trim(), 'a non-passkey wallet is never offered a Bitcoin asset').to.not.equal('BTC')
    })
  })
})
