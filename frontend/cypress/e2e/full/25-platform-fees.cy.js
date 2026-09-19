/**
 * E2E Tests: Platform fees (spec 060, Full-tier)
 *
 * The invariant this tier exists for is not "a fee exists" — it is **a member is never charged
 * above the rate they were shown**. Disclosure, signature and settlement are three different
 * layers, and only a flow test spans them: the rate is READ from the FeeRouter and RENDERED, the
 * rendered rate is passed back as `maxFeeBps` when the member signs, and the amount actually
 * taken lands in the treasury on chain. Each of the three assertions below is derived from the
 * PREVIOUS layer — the expected fee is computed from the percentage the DOM showed, never from
 * the number the test arranged, so a UI that disclosed one rate and signed another fails here.
 *
 * Requires (all from `npm run setup:e2e`):
 *   · the `FeeRouter` from `deploy:local:fees` — the real spec-060 contract, not a double;
 *   · a `MockERC4626Vault` from `deploy:local:earn-vault` — `depositToVaultWithFee` is the ONE
 *     on-chain charge path and Earn ▸ Lend is its only member surface, so a local chain needs
 *     something for the wrapper to wrap.
 *
 * The vault LIST is stubbed at Morpho's public API (there is no Morpho on a local chain) — the
 * same treatment `cy.interceptIpfs()` gives Pinata elsewhere in this tier. Everything that
 * decides money is real: the router, the vault, the token, the rate, the signature and the
 * balances all live on the chain, and every outcome below is read back from it.
 *
 * Closes #1233 (sub-issue of #1228). Flows:
 *   FEE-01 fees.disclosed-before-signature — the rate on screen is the rate charged
 *   FEE-02 fees.disclosed-before-signature — a raise after the quote CANNOT overcharge the member
 *   FEE-03 fees.admin-changes-rate         — an operator edits a rate and members see the new one
 *
 * Checklist: FEE-01..FEE-03
 */

import { resetChainBetweenTests } from '../../support/e2e'

const ADMIN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'  // #0 — DEFAULT_ADMIN + FEE_ADMIN on the router
const MEMBER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // #1 — seeded with stake tokens

/**
 * The FeeRouter address the APP is built with (frontend/src/config/contracts.js, HARDHAT_CONTRACTS).
 * Asserted against the chain in `before` — see the comment there for why a mismatch has to be
 * named rather than discovered as "deposits are paused".
 */
const CONFIGURED_FEE_ROUTER = '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9'

const EARN_LEND = 'earn.lend'
/** keccak256('earn.lend') — the service id, which is also the option value in the admin form. */
const EARN_LEND_SERVICE_ID = '0x775c3db7836aba902f26689de8429f1af00198b865b0512297ff25c6767dc6ea'
// The local payment token is an 18-decimal MockERC20 (contracts/mocks) and the mock vault
// inherits that. Deposits are entered in human units, so this must track it.
const DECIMALS = 18n
const ONE = 10n ** DECIMALS
const DEPOSIT = 100n * ONE

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Fixture coordinates, resolved once from the deployment record. */
let fixtures = null

/**
 * Assert a chainTx result succeeded, surfacing the decoded on-chain error (`describeRevert` in
 * cypress.config.js) rather than a bare "expected false to be true".
 */
function expectOk(result, label) {
  expect(result.ok, `${label}: ${result.error || 'no error message returned'}`).to.be.true
  return result
}

/**
 * Stand in for Morpho's vault API with the LOCAL mock vault.
 *
 * Registered before every visit. Two queries arrive on this one endpoint: the vault list, and
 * the position enrichment (USD value / earnings). The enrichment is answered with an empty user
 * — the app treats that as "no enrichment" and falls back to on-chain reads, which is exactly the
 * state we want, because on-chain is what this spec judges by.
 */
function stubVaultList() {
  cy.intercept('POST', 'https://api.morpho.org/graphql', (req) => {
    const query = String(req.body?.query || '')
    if (query.includes('EarnPositions')) {
      req.reply({ statusCode: 200, body: { data: { userByAddress: null } } })
      return
    }
    req.reply({
      statusCode: 200,
      body: {
        data: {
          vaults: {
            items: [
              {
                address: fixtures.vault,
                symbol: 'mVLT',
                name: 'Local Test Vault',
                listed: true,
                state: {
                  totalAssetsUsd: 1000,
                  apy: 0.05,
                  netApy: 0.045,
                  curators: [{ name: 'FairWins E2E' }],
                  allRewards: [],
                },
                asset: {
                  name: 'Mock USDC',
                  address: fixtures.asset,
                  decimals: Number(DECIMALS),
                  symbol: 'USDC',
                },
                chain: { id: Number(Cypress.env('NETWORK_ID')) },
              },
            ],
          },
        },
      },
    })
  }).as('morpho')
}

/** Connect as `account` and open Earn ▸ Lend with the vault list stubbed. */
function openLendAs(account) {
  cy.mockWeb3Provider({ account })
  stubVaultList()
  cy.visit('/fairwins')
  cy.connectWallet()
  cy.visit('/wallet?tab=earn&view=lend')
  cy.get('.earn-vault-row', { timeout: 20000 }).should('be.visible')
}

/** Open the deposit sheet for the one stubbed vault. */
function openDepositSheet() {
  cy.get('.earn-vault-row').click()
  // Scoped from here on: the sheet is rendered over the page, and an unscoped `cy.contains`
  // would happily match the list behind it (policy anti-pattern 2).
  cy.get('.earn-vault-sheet[role="dialog"]', { timeout: 15000 }).should('be.visible')
  // The balances read has to land before the fee line can be trusted to be absent or present.
  cy.get('.earn-vault-sheet').contains('In your wallet', { timeout: 20000 }).should('be.visible')
}

/**
 * Read the fee rate the sheet DISCLOSED, in basis points, from the rendered percentage.
 *
 * This is the layer the rest of the test is judged against: the expected fee is computed from
 * what the member could actually see, so a sheet that renders 0.25% while signing 2.50% fails
 * on the balance assertion rather than passing because both numbers came from the same fixture.
 */
function disclosedBps() {
  return cy
    .get('.earn-vault-sheet')
    .contains('dt', /FairWins platform fee/i, { timeout: 15000 })
    .invoke('text')
    .then((text) => {
      const match = text.match(/\(([\d.]+)%\)/)
      expect(match, `the fee line "${text}" states a percentage`).to.not.equal(null)
      const bps = Math.round(Number(match[1]) * 100)
      expect(bps, 'the disclosed rate is a whole number of basis points').to.be.a('number')
      return bps
    })
}

function tokenBalance(address) {
  return cy
    .task('chainTx', { action: 'tokenBalance', args: { address } })
    .then((r) => BigInt(expectOk(r, 'tokenBalance').balance))
}

describe('Platform fees', () => {
  before(() => {
    /*
     * Resolve the fixtures ONCE and refuse to continue without them. Two of these checks would
     * otherwise degrade into a test that passes while proving nothing:
     *
     *   · a FeeRouter the app cannot resolve makes every quote unavailable, and the sheet then
     *     honestly renders no fee line — a "no fee was disclosed" assertion would pass;
     *   · a ZERO treasury makes the router SKIP the fee entirely (FeeRouter.depositToVaultWithFee),
     *     so "charged no more than disclosed" would hold at a charge of nothing.
     */
    cy.task('chainTx', { action: 'feeFixtures' }).then((r) => {
      expectOk(r, 'feeFixtures')
      expect(r.feeRouter.toLowerCase(),
        'the deployed FeeRouter is the address the app is built with — if this fails, the local ' +
        'deploy ORDER changed (deployProxy addresses come from the deployer nonce): update ' +
        'HARDHAT_CONTRACTS.feeRouter in frontend/src/config/contracts.js to the deployed address',
      ).to.equal(CONFIGURED_FEE_ROUTER.toLowerCase())
      expect(r.treasury, 'the router has a fee treasury — with none it skips fees, not charges them')
        .to.not.equal(ZERO_ADDRESS)
      fixtures = r
    })

    // The service must be REGISTERED and Wrapped, or `depositToVaultWithFee` reverts before any
    // rate is consulted and the whole spec would be testing the revert path by accident.
    cy.task('chainTx', { action: 'feeService', args: { label: EARN_LEND } }).then((svc) => {
      expectOk(svc, 'feeService(earn.lend)')
      expect(svc.kind, 'earn.lend is registered as a Wrapped service').to.equal(1)
      expect(svc.capBps, 'earn.lend carries a nonzero hard cap').to.be.greaterThan(0)
    })
  })

  // Every test arranges its own rate and moves real balances; without per-test isolation FEE-02's
  // raise-to-the-cap would still be in force when FEE-03 read the history back.
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  // ---------------------------------------------------------------------------
  // FEE-01: fees.disclosed-before-signature — the rate on screen is the rate charged
  // ---------------------------------------------------------------------------
  it('[FEE-01] a member is charged exactly the fee rate the deposit sheet disclosed', () => {
    cy.task('chainTx', { action: 'setFeeBps', args: { label: EARN_LEND, bps: 100 } })
      .then((r) => expectOk(r, 'setFeeBps(100)'))

    openLendAs(MEMBER)
    openDepositSheet()

    tokenBalance(fixtures.treasury).then((treasuryBefore) => {
      tokenBalance(MEMBER).then((memberBefore) => {
        cy.task('chainTx', { action: 'vaultPosition', args: { address: MEMBER } }).then((before) => {
          expectOk(before, 'vaultPosition before')

          disclosedBps().then((bps) => {
            // The disclosure is the member's consent ceiling; everything below is judged against
            // it, not against the 100 this test arranged.
            const expectedFee = (DEPOSIT * BigInt(bps)) / 10_000n
            const expectedNet = DEPOSIT - expectedFee

            // The sheet also has to say where the money goes, in the token's own units — a
            // percentage alone is not a disclosure of an amount.
            cy.get('.earn-vault-sheet').within(() => {
              cy.contains('dt', /Goes into the vault/i).should('be.visible')
            })

            cy.get('#earn-amount').clear().type('100')
            cy.get('.earn-vault-sheet .earn-submit').should('not.be.disabled').click()

            // Judged by the chain, never by the modal: the confirmation copy has been right in
            // this app while the transaction was never sent (#1226/#1227).
            // The 90s belongs on the command that WAITS. `.earn-vault-sheet` is already on screen —
            // it is the sheet the submit was clicked in — so a timeout on the `cy.get` is spent on
            // nothing and leaves the confirmation the default 10s, which is shorter than the deposit
            // it is waiting for. Every other long wait in this file and in the suite attaches the
            // timeout to `.contains` for exactly this reason (see line ~302, and 04-wager-creation-tx).
            cy.get('.earn-vault-sheet').contains(/deposit complete/i, { timeout: 90000 }).should('be.visible')

            tokenBalance(fixtures.treasury).then((treasuryAfter) => {
              const charged = treasuryAfter - treasuryBefore
              expect(charged, `the treasury received exactly the disclosed ${bps} bps of the deposit`)
                .to.equal(expectedFee)
              /*
               * And a fee was genuinely taken. Without this the equality above could hold at
               * zero on BOTH sides — which is what an unset treasury produces, because the
               * router then SKIPS the fee (FeeRouter.depositToVaultWithFee). The `before` hook
               * refuses that fixture, and this is the assertion that would notice if it stopped.
               */
              expect(charged > 0n, 'the charge is a real transfer, not a skipped fee').to.be.true
            })
            tokenBalance(MEMBER).then((memberAfter) => {
              expect(memberBefore - memberAfter, 'the member paid the gross amount, once')
                .to.equal(DEPOSIT)
            })
            cy.task('chainTx', { action: 'vaultPosition', args: { address: MEMBER } }).then((after) => {
              expectOk(after, 'vaultPosition after')
              expect(BigInt(after.totalAssets) - BigInt(before.totalAssets),
                'the vault received the deposit NET of the disclosed fee').to.equal(expectedNet)
              expect(BigInt(after.assets), 'the member owns the net deposit in the vault')
                .to.equal(expectedNet)
            })
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // FEE-02: fees.disclosed-before-signature — the ceiling is real, not decoration
  // ---------------------------------------------------------------------------
  it('[FEE-02] a rate raised after the quote cannot overcharge an in-flight deposit', () => {
    cy.task('chainTx', { action: 'setFeeBps', args: { label: EARN_LEND, bps: 50 } })
      .then((r) => expectOk(r, 'setFeeBps(50)'))

    openLendAs(MEMBER)
    openDepositSheet()

    tokenBalance(fixtures.treasury).then((treasuryBefore) => {
      tokenBalance(MEMBER).then((memberBefore) => {
        cy.task('chainTx', { action: 'vaultPosition', args: { address: MEMBER } }).then((before) => {
          expectOk(before, 'vaultPosition before')

          disclosedBps().then((quotedBps) => {
            expect(quotedBps, 'the member was quoted the rate in force when the sheet opened')
              .to.equal(50)
            cy.get('#earn-amount').clear().type('100')

            /*
             * The operator raises the rate to the service's hard cap AFTER the member has been
             * quoted — the concurrent-raise the `maxFeeBps` argument exists for. The member's
             * signature still carries the quoted 50 bps, so the router must refuse the charge
             * outright (FeeAboveQuoted) rather than take the higher one.
             */
            cy.task('chainTx', { action: 'setFeeBps', args: { label: EARN_LEND, bps: 250 } })
              .then((r) => expectOk(r, 'setFeeBps(250) — the concurrent raise'))
            cy.task('chainTx', { action: 'feeService', args: { label: EARN_LEND } }).then((svc) => {
              expect(svc.feeBps, 'the live rate really did move above the quote').to.equal(250)
            })

            cy.get('.earn-vault-sheet .earn-submit').should('not.be.disabled').click()

            // The member is told nothing moved, and that has to be TRUE — which the balances below
            // are what establish.
            cy.get('.earn-vault-sheet [role="alert"]', { timeout: 90000 })
              .should('contain.text', 'Nothing was moved')
            cy.get('.earn-vault-sheet').contains(/deposit complete/i).should('not.exist')

            tokenBalance(fixtures.treasury).then((treasuryAfter) => {
              expect(treasuryAfter, 'no fee was taken at the raised rate — or at any rate')
                .to.equal(treasuryBefore)
            })
            tokenBalance(MEMBER).then((memberAfter) => {
              expect(memberAfter, 'the member kept every token').to.equal(memberBefore)
            })
            cy.task('chainTx', { action: 'vaultPosition', args: { address: MEMBER } }).then((after) => {
              expectOk(after, 'vaultPosition after')
              expect(BigInt(after.totalAssets), 'nothing reached the vault either')
                .to.equal(BigInt(before.totalAssets))
              expect(BigInt(after.shares), 'the member holds no shares from a deposit that failed')
                .to.equal(BigInt(before.shares))
            })
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // FEE-03: fees.admin-changes-rate — an operator edits a rate and members see the new one
  // ---------------------------------------------------------------------------
  it('[FEE-03] an operator changes a service rate and the member surface discloses the new one', () => {
    cy.task('chainTx', { action: 'setFeeBps', args: { label: EARN_LEND, bps: 25 } })
      .then((r) => expectOk(r, 'setFeeBps(25) — the starting rate'))

    cy.mockWeb3Provider({ account: ADMIN })
    cy.visit('/fairwins')
    cy.connectWallet()
    cy.visit('/admin/membership-revenue?view=fees')

    // The live table is read from the router, so it states the rate that is actually in force.
    cy.get('table[aria-label="Registered fee services"]', { timeout: 20000 })
      .contains('tr', /Earn — vault lending/i)
      .should('contain.text', '25 bps')

    // Change it through the operator's own control, not through a task — this flow is about the
    // control existing and working, and a chainTx here would prove only that the contract works.
    cy.contains('.admin-card', /change a fee rate/i).within(() => {
      // By VALUE — the option's LABEL embeds the rate in force ("… (now 25 bps, cap 250)"), so
      // matching on it would make this test depend on the number the previous line just changed.
      cy.get('select').select(EARN_LEND_SERVICE_ID)
      cy.get('input[type="number"]').clear().type('75')
      cy.contains('button', /set fee rate/i).should('not.be.disabled').click()
    })

    /*
     * Wait on the OPERATOR'S OWN evidence that the change landed before reading the chain. The
     * tab re-reads after the transaction confirms, and its history table renders `FeeBpsChanged`
     * — so this is the screen agreeing, and the chain assertions below are what make that claim
     * true. Asserting on chain immediately after the click instead just races the receipt.
     */
    cy.contains('table[aria-label="Fee change history"] tr', '25 → 75 bps', { timeout: 90000 })
      .should('be.visible')
    cy.get('table[aria-label="Registered fee services"]')
      .contains('tr', /Earn — vault lending/i)
      .should('contain.text', '75 bps')

    // Settled on chain, and recorded in the audit history the tab renders — `getService` alone
    // could not tell a rate that was CHANGED from one that was always 75.
    cy.task('chainTx', { action: 'feeService', args: { label: EARN_LEND } }).then((svc) => {
      expectOk(svc, 'feeService after the operator edit')
      expect(svc.feeBps, 'the router holds the new rate').to.equal(75)
    })
    cy.task('chainTx', { action: 'feeHistory', args: { label: EARN_LEND } }).then((history) => {
      expectOk(history, 'feeHistory')
      const last = history.changes[history.changes.length - 1]
      expect(last, 'the change emitted FeeBpsChanged').to.not.equal(undefined)
      expect(last.oldBps, 'the event records the rate it moved from').to.equal(25)
      expect(last.newBps, 'the event records the rate it moved to').to.equal(75)
      expect(last.actor.toLowerCase(), 'the event records who changed it').to.equal(ADMIN.toLowerCase())
    })

    // The point of the flow: a member who comes along afterwards is quoted the NEW rate.
    openLendAs(MEMBER)
    openDepositSheet()
    disclosedBps().then((bps) => {
      expect(bps, 'the member surface discloses the rate the operator just set').to.equal(75)
    })
  })
})
