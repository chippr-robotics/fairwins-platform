/**
 * E2E Tests: bridge and supplied liquidity (spec 067, Full-tier)
 *
 * Issue #1236. Four flows, and every one of them settles its claim from CHAIN STATE rather
 * than from a success message, because the claims are all about who is holding the money:
 *
 *   BL-01  liquidity.supply-uniswap-position   the position NFT is the MEMBER's, not the router's
 *   BL-02  liquidity.pause-stops-new-only      a pause stops new supplies and traps nothing
 *   BL-03  bridge.deposit-member-is-depositor  Across records the MEMBER as depositor
 *   BL-04  bridge.fee-consent-ceiling          the disclosed bps is a ceiling, and 0 shows no line
 *
 * ── WHY THESE ARE ON-CHAIN AND NOT NO-CHAIN ────────────────────────────────────────────────
 * "The router never takes custody" is not a rendering fact. A component test can assert what
 * the app INTENDS to send; only a chain can answer who ended up owning the position and whose
 * address Across wrote down. Both are one refactor away from being wrong in a way no unit test
 * would notice — `recipient: address(this)` and `depositor: address(this)` are both perfectly
 * ordinary-looking lines.
 *
 * ── WHAT THE CHAIN IS ──────────────────────────────────────────────────────────────────────
 * The full tier's node boots as chainId 80002 (Amoy-shaped) and `VITE_E2E_AMOY_LOCAL=1` makes
 * the DEV-only seams in config/networks.js + config/contracts.js resolve both routers there.
 * Across and Uniswap are the contracts/mocks stand-ins deployed by
 * `scripts/deploy/deploy-bridge-liquidity.js` — MockAcrossSpokePool records `depositor`
 * verbatim, and MockPositionManager mints to `recipient` and models the member-called exit
 * legs, which is exactly what BL-01/BL-02/BL-03 read back.
 */

const MEMBER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // hardhat #0
const USDC = '0xbc4D54AE49ED9C6075770CD6acA930A728dcf526'   // the local payment token (18 dec here)
const WMATIC = '0x637914a81B4F67BeA3acd94fc5a233656f8C08f7' // the local wrapped native (deployment key 'wmatic'; the app labels it WPOL — MockWNative since spec 108)
const ROUTER = '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154' // liquidityRouter (nonce-derived)
const BRIDGE_ROUTER = '0x4c5859f0F772848b2D91F1D83E2Fe57935348029' // bridgeRouter (nonce-derived)
// The destination leg. Sepolia's USDC — the app's own registry entry for chain 11155111, which
// is what the destination selector offers and what the curated route must therefore name.
//
// It was Polygon 137 until issue #1265 made `bridgeNetworks()` cohort-bounded. That change is
// correct and this test was relying on precisely what it fixed: a testnet-cohort build could
// reach a MAINNET destination, which constitution III forbids. Sepolia is in this build's
// cohort and carries a bridge config under the same DEV-only seam Amoy uses
// (config/networks.js), so the pair is now testnet→testnet. Nothing is read on the destination
// chain — MockAcrossSpokePool records `outputToken` and `destinationChainId` verbatim and BL-03
// reads the deposit back on the ORIGIN chain — so this address only has to be the one the
// destination selector actually offers.
const USDC_ON_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
const DEST_CHAIN_ID = 11155111

const SUPPLY_URL = '/wallet?tab=earn&view=supply'
const BRIDGE_URL = '/wallet?tab=paytransfer&view=bridge'

const task = (name) => (action, args = {}) =>
  cy.task(name, { action, args }).then((r) => {
    expect(r.ok, `${name} ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

const fixture = task('liquidityFixture')
const bridge = task('bridgeFixture')

/**
 * Open the sheet for the pool THIS SPEC listed. The whole row is the control (SupplyView).
 *
 * The row is picked by NETWORK NAME, never `.first()`: the catalog reads every supported
 * network, so on a machine with outbound RPC the list also carries the real Ethereum and
 * Polygon pools — and `.first()` silently opened an Ethereum USDC/USDT sheet where the
 * member holds nothing, which fails as "that is more than your USDC" three steps later.
 */
const LOCAL_NETWORK = 'Polygon Amoy' // what chain 80002 calls itself (config/networks.js)

/*
 * Each flow curates its own pool at its own FEE TIER, and opens the row by that tier. Sharing
 * one pool between flows was worse than it looks: `SupplySheet` matches a position to a pool by
 * `poolId` and takes the FIRST match, so a second position in the same pool is invisible to it —
 * a flow that supplied would find the earlier flow's spent position instead of its own and be
 * told it has nothing to withdraw.
 */
const FEE_TIER = { supply: 3000, pause: 500 }
const feeLabel = (tier) => `${(tier / 10_000).toFixed(2)}% fee`

/*
 * The row for THIS spec's pool. Both filters are required and neither is an assertion after the
 * fact: the catalog reads every supported network, so on a machine with outbound RPC the list
 * also carries the real Ethereum and Polygon pools — and `cy.contains` returns the FIRST match,
 * which was an Ethereum row where the member holds nothing.
 */
const poolRow = (tier) =>
  cy
    .get('.supply-row', { timeout: 60000 })
    .filter(`:contains("${LOCAL_NETWORK}")`)
    .filter(`:contains("${feeLabel(tier)}")`)
    .should('have.length', 1)

const openPool = (tier) => {
  poolRow(tier).click()
  // The sheet is a fixed-position panel with its own scroll container, so Cypress cannot
  // scroll the page to reach a field below the fold — scroll the field itself into view.
  cy.get('#supply-amount-0', { timeout: 20000 }).scrollIntoView().should('be.visible')
}

describe('Bridge and supplied liquidity (spec 067)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    /*
     * Every test starts from an UNPAUSED router, and this belongs here rather than at the end
     * of the test that pauses. A pause left behind does not fail the next test where it was
     * set — it changes which mode the sheet opens in (`SupplyView` opens a closed pool the
     * member holds on the way OUT), so the next spec fails looking for an amount field that
     * was never going to be there. Cleanup that only runs when a test succeeds is exactly the
     * cleanup that is missing when you need it.
     */
    fixture('setPaused', { paused: false })
  })

  it('[BL-01] liquidity.supply-uniswap-position — the position NFT is minted to the member, never to the router', () => {
    fixture('listTradingPool', { tokenA: USDC, tokenB: WMATIC, feeTier: FEE_TIER.supply })

    // The id the supply below will mint, read BEFORE it happens. Token ids accumulate on a
    // shared node, so this is the only way to name the position this flow created.
    fixture('positionCounters', { owner: MEMBER }).then(({ nextTokenId, balance }) => {
      cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
      cy.visit(SUPPLY_URL)
      openPool(FEE_TIER.supply)

      cy.get('#supply-amount-0').type('5')
      cy.get('#supply-amount-1').type('5')
      cy.contains('button', 'Review and confirm').should('not.be.disabled').click()

      // The disclosure is a GATE, not a tooltip (SupplySheet) — the confirm control is unusable
      // until it is acknowledged, so a test that could skip it would be testing a different app.
      cy.get('.supply-ack input[type="checkbox"]').should('not.be.checked').check()
      cy.contains('button', 'Supply to this pool').should('not.be.disabled').click()

      // SupplyView closes the sheet on completion (`onActionComplete`), so the member's signal
      // is the pool appearing under "Your pools" — not a message inside a panel that is gone.
      cy.get('.supply-ack', { timeout: 60000 }).should('not.exist')
      cy.get('.supply-position-list .supply-position', { timeout: 30000 })
        .should('have.length.at.least', balance + 1)

      // THE ASSERTION. Not the list above it — the owner of the NFT, from the chain.
      fixture('positionOwner', { tokenId: nextTokenId }).then(({ owner, liquidity }) => {
        expect(owner.toLowerCase(), 'the position NFT belongs to the member').to.equal(MEMBER.toLowerCase())
        expect(owner.toLowerCase(), 'the router must never own a member position')
          .to.not.equal(ROUTER.toLowerCase())
        expect(BigInt(liquidity) > 0n, 'the position holds liquidity').to.equal(true)
      })

      // FR-013's sibling on this path: the router is a conduit, so it ends the transaction
      // holding nothing of either asset. A residue here is custody by accident.
      for (const token of [USDC, WMATIC]) {
        fixture('tokenBalanceOf', { token, address: ROUTER }).then(({ balance: residue }) => {
          expect(residue, `router residue in ${token}`).to.equal('0')
        })
      }
    })
  })

  it('[BL-02] liquidity.pause-stops-new-only — a pause closes new supplies and traps nothing', () => {
    /*
     * The claim under test is the one the router's design rests on: `pause()` is a stop on NEW
     * Uniswap supplies, not a killswitch over a member's money. It is testable only because the
     * exit does not run through FairWins at all — `buildExitCalls` talks to Uniswap's position
     * manager directly — so this flow withdraws WHILE THE ROUTER IS PAUSED and takes the tokens
     * back. A refactor that routed the exit through the router would fail here and nowhere else.
     *
     * Note also what this test does NOT say. Across bridge-LP deposits never touch a FairWins
     * contract either (research R3), so this pause cannot reach them — calling it a pause on
     * "pooling" would be asserting something untrue about a path it does not control.
     */
    fixture('listTradingPool', { tokenA: USDC, tokenB: WMATIC, feeTier: FEE_TIER.pause })

    fixture('positionCounters', { owner: MEMBER }).then(({ nextTokenId }) => {
      cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
      cy.visit(SUPPLY_URL)
      openPool(FEE_TIER.pause)

      cy.get('#supply-amount-0').type('4')
      cy.get('#supply-amount-1').type('4')
      cy.contains('button', 'Review and confirm').should('not.be.disabled').click()
      cy.get('.supply-ack input[type="checkbox"]').check()
      cy.contains('button', 'Supply to this pool').click()
      cy.get('.supply-ack', { timeout: 60000 }).should('not.exist')

      fixture('positionOwner', { tokenId: nextTokenId }).then(({ liquidity }) => {
        expect(BigInt(liquidity) > 0n, 'there is a position for the pause to trap').to.equal(true)
      })

      // ── The guardian pauses. ────────────────────────────────────────────────────────
      fixture('setPaused', { paused: true })
      fixture('poolPaused').then(({ paused }) => expect(paused, 'the router is paused').to.equal(true))

      cy.visit(SUPPLY_URL)
      // A pool that has stopped taking deposits is NOT hidden (FR-024) — it stays in the
      // list, labelled, and opens on the way OUT because the member holds a position.
      poolRow(FEE_TIER.pause)
        .should('have.class', 'supply-row-closed')
        // Wait for the POSITION to be attached to the row before opening it. The catalog and
        // the member's positions load separately, and the tab the sheet lands on is decided
        // ONCE, at click time — click in the gap between the two and a pool the member holds
        // opens on Supply, which is the dead end this pause is supposed to route around.
        .find('.supply-row-chip.position')
        .should('exist')
      poolRow(FEE_TIER.pause).click()
      // Tabs are addressed BY POSITION, not by label: the supply tab renames itself to "Add to
      // position" once the member holds one, so a label selector here tests the copy, not the
      // pause. [0] is supply, [1] is withdraw (SupplySheet's `earn-mode-tabs`).
      cy.get('.earn-mode-tabs [role="tab"]', { timeout: 20000 })
        .eq(1)
        .should('have.attr', 'aria-selected', 'true')

      // Half one: new value in is refused, and the controls say so rather than failing later.
      cy.get('.earn-mode-tabs [role="tab"]').eq(0).click()
      cy.get('#supply-amount-0').scrollIntoView().should('be.disabled')
      cy.get('#supply-amount-1').should('be.disabled')
      cy.contains('button', 'Review and confirm').should('be.disabled')

      // Half two: the exit is untouched. The tab is not disabled, the control is not
      // disabled, and — the part that actually matters — the tokens come back.
      cy.get('.earn-mode-tabs [role="tab"]').eq(1).should('not.be.disabled').click()
      // SCOPED. `cy.contains('button', 'All')` matches the "← All earning options" back
      // control first, which is behind the sheet's scrim and cannot be clicked.
      cy.get('.supply-percent-row').contains('button', 'All').click()

      fixture('tokenBalanceOf', { token: USDC, address: MEMBER }).then(({ balance: usdcBefore }) => {
        fixture('tokenBalanceOf', { token: WMATIC, address: MEMBER }).then(({ balance: wmaticBefore }) => {
          cy.contains('button', /^Withdraw /).should('not.be.disabled').click()
          cy.get('.earn-mode-tabs', { timeout: 60000 }).should('not.exist')

          fixture('positionOwner', { tokenId: nextTokenId }).then(({ owner, liquidity }) => {
            expect(BigInt(liquidity), 'the position was emptied while the router was paused').to.equal(0n)
            expect(owner.toLowerCase(), 'and it is still the member who owns it')
              .to.equal(MEMBER.toLowerCase())
          })
          for (const [token, before, label] of [
            [USDC, usdcBefore, 'USDC'],
            [WMATIC, wmaticBefore, 'WPOL'],
          ]) {
            fixture('tokenBalanceOf', { token, address: MEMBER }).then(({ balance }) => {
              expect(BigInt(balance) > BigInt(before), `${label} came back to the member`).to.equal(true)
            })
          }
        })
      })

    })
  })

  // ── The bridge half ─────────────────────────────────────────────────────────────────────
  //
  // A bridge price cannot be derived client-side (research R10), so the app asks the
  // relay-gateway and the gateway asks Across. There is no gateway on this machine, so the
  // quote endpoint is STUBBED — and only that. Everything the flows assert (the route, the
  // rate, the depositor Across recorded, whether anything moved at all) comes from the chain.
  //
  // The stub answers arithmetic Across's own contract enforces: `net - totalRelayFee` IS
  // `outputAmount`. A stub that did not reconcile would make the app drop its itemization and
  // hide the very lines BL-04 reads.
  const stubQuote = () => {
    cy.intercept('GET', '**/v1/bridge/80002/quote*', (req) => {
      const net = BigInt(new URL(req.url).searchParams.get('amount'))
      const relayerGasFee = 2_000_000_000_000_000n // 0.002 in 18-dec units
      const lpFee = 1_000_000_000_000_000n
      const relayerCapitalFee = 1_000_000_000_000_000n
      const total = relayerGasFee + lpFee + relayerCapitalFee
      const nowSec = Math.floor(Date.now() / 1000)
      req.reply({
        statusCode: 200,
        body: {
          totalRelayFee: { total: total.toString() },
          relayerGasFee: { total: relayerGasFee.toString() },
          lpFee: { total: lpFee.toString() },
          relayerCapitalFee: { total: relayerCapitalFee.toString() },
          outputAmount: (net - total).toString(),
          quoteTimestamp: String(nowSec),
          fillDeadline: String(nowSec + 3600),
          exclusivityDeadline: '0',
          inputToken: USDC,
          outputToken: USDC_ON_SEPOLIA,
        },
      })
    }).as('bridgeQuote')
  }

  const openBridge = () => {
    cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
    cy.visit(BRIDGE_URL)
    // The route list is read from the chain; the amount field is only useful once it is in.
    cy.get('#bridge-amount', { timeout: 60000 }).should('be.enabled')
  }

  it('[BL-03] bridge.deposit-member-is-depositor — Across records the member, so an unfilled deposit refunds to them', () => {
    /*
     * `depositV3` is passed `msg.sender`, never `address(this)`. That single argument is why
     * `IBridgeRouter` has no rescue and no claim-refund function: an unfilled deposit is
     * returned by Across to the DEPOSITOR on the origin chain, so as long as that is the
     * member, there is nothing for FairWins to hold and nothing to hand back. Swapping it for
     * `address(this)` compiles, passes every unit test about amounts, and quietly makes the
     * router the only party Across will ever refund.
     */
    bridge('setBridgeFeeBps', { bps: 0 })
    bridge('setRoute', { inputToken: USDC, outputToken: USDC_ON_SEPOLIA, destinationChainId: DEST_CHAIN_ID })

    bridge('lastDeposit').then(({ depositCount: before }) => {
      stubQuote()
      openBridge()

      cy.get('#bridge-amount').type('12')
      cy.wait('@bridgeQuote')
      cy.contains('button', /^Bridge /, { timeout: 20000 }).should('not.be.disabled').click()

      // "Sent", not "submitted but unconfirmed": the app only says this once it has read the
      // deposit back out of the mined receipt, which is the honest bar for having bridged.
      cy.contains(/Sent from Polygon Amoy/i, { timeout: 60000 }).should('be.visible')

      bridge('lastDeposit').then((deposit) => {
        expect(deposit.depositCount, 'exactly one deposit reached Across').to.equal(before + 1)
        expect(deposit.depositor.toLowerCase(), 'Across recorded the MEMBER as depositor')
          .to.equal(MEMBER.toLowerCase())
        expect(deposit.depositor.toLowerCase(), 'never the router — that would strand the refund')
          .to.not.equal(BRIDGE_ROUTER.toLowerCase())
        expect(deposit.recipient.toLowerCase()).to.equal(MEMBER.toLowerCase())
        // At a zero rate the whole amount is bridged: the fee split takes nothing.
        expect(deposit.amount, 'the full amount reached Across').to.equal((12n * 10n ** 18n).toString())
      })

      // And the router keeps nothing (FR-013). A residue here is custody by accident.
      fixture('tokenBalanceOf', { token: USDC, address: BRIDGE_ROUTER }).then(({ balance }) => {
        expect(balance, 'the router holds no member funds after a bridge').to.equal('0')
      })
    })
  })

  it('[BL-04] bridge.fee-consent-ceiling — the disclosed rate is a ceiling, and a zero rate shows no fee line', () => {
    /*
     * Both spec-067 fee services ship at RATE 0, cap 250 bps, and nothing here implies
     * otherwise: the flow ends by putting the rate back to zero and checking that the confirm
     * screen then carries no fee line AT ALL — not a line reading 0.00% (FR-029).
     *
     * The ceiling is the other half. The bps the member was shown travels back into the
     * calldata as `maxFeeBps`, and `BridgeRouter.bridgeWithFee` reverts `FeeAboveQuoted` when
     * the live rate is above it. So this flow raises the rate BEHIND THE MEMBER — after they
     * have read the price and before they sign — and proves the transfer is refused rather
     * than repriced. Nothing reached Across; that is the assertion, not the error text.
     */
    bridge('setRoute', { inputToken: USDC, outputToken: USDC_ON_SEPOLIA, destinationChainId: DEST_CHAIN_ID })
    bridge('setBridgeFeeBps', { bps: 25 }).then(({ bps }) => expect(bps).to.equal(25))

    bridge('lastDeposit').then(({ depositCount: before }) => {
      stubQuote()
      openBridge()

      cy.get('#bridge-amount').type('20')
      cy.wait('@bridgeQuote')
      // The rate is disclosed as its own line before any signature (FR-007/FR-026).
      cy.contains('FairWins fee', { timeout: 20000 }).should('be.visible')
      cy.contains('0.25%').should('be.visible')

      // The operator raises the rate while the member is reading the price they were quoted.
      bridge('setBridgeFeeBps', { bps: 100 }).then(({ bps }) => expect(bps).to.equal(100))

      cy.contains('button', /^Bridge /).should('not.be.disabled').click()

      // Refused, not repriced. The member is told, and — the part that matters — nothing moved.
      cy.get('.earn-input-error', { timeout: 60000 }).should('be.visible')
      cy.contains(/Sent from Polygon Amoy/i).should('not.exist')
      bridge('lastDeposit').then(({ depositCount }) => {
        expect(depositCount, 'no deposit reached Across at the raised rate').to.equal(before)
      })

      // ── FR-029: back at the shipping rate, there is no fee line to read. ──
      bridge('setBridgeFeeBps', { bps: 0 })
      cy.visit(BRIDGE_URL)
      cy.get('#bridge-amount', { timeout: 60000 }).should('be.enabled').type('20')
      cy.wait('@bridgeQuote')
      cy.contains('button', /^Bridge /, { timeout: 20000 }).should('not.be.disabled')
      cy.contains('FairWins fee').should('not.exist')
      cy.contains('0.00%').should('not.exist')
    })
  })
})
