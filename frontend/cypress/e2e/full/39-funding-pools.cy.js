/**
 * E2E Tests: Funding Pools (spec 103, Full-tier)
 *
 * Requires a running Hardhat node with `FundingPoolFactory` deployed (a targeted, append-only deploy
 * on top of the core `deploy:local` record — scripts/deploy/deploy-funding-pool-factory.js, last in
 * `setup:e2e`). Judged by ON-CHAIN STATE (the `fundingInfo` / `fundingMemberInfo` / `tokenBalance`
 * chainTx reads), never by modal wording (e2e-testing-policy.md). The UI is exercised for the flow
 * under test; setup for the other flows is arranged directly on-chain, the same bypass-the-UI pattern
 * the wager-pool spec uses.
 *
 * ORDERING RULE: a click submits asynchronously (the app awaits `tx.wait()`, whose receipt poll is
 * seconds), so every chain read that judges a UI action waits for the page's OWN post-action render
 * first. Reading the chain straight after the click races the transaction — the first CI run of this
 * spec read `state: 0` on every flow that way — and is not a stronger test, only an earlier one.
 *
 * Flows (spec 103, FR-029):
 *   FP-01 funding.create-and-contribute  — create through the Request ▸ Pool form; a second account
 *                                          opens the link and contributes; totals + feed
 *   FP-02 funding.organizer-close        — the organizer closes below the goal and collects the pot
 *   FP-03 funding.majority-refund        — 2 of 3 contributors vote; each collects their own amount
 *   FP-04 funding.deadline-refund        — a pool nobody closes refunds after the settle deadline
 *   FP-05 funding.organizer-refund       — the organizer refunds everyone from an open pool
 *
 * Checklist: FP-01..FP-05
 */

import { resetChainBetweenTests } from '../../support/e2e'

const TEST_ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // #0 Organizer
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // #1 Contributor
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // #2 Contributor
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // #3 Contributor
]

// The local core payment token is an 18-decimal MockERC20 (contracts/mocks). UI-entered amounts are
// parsed against the token's live `decimals()`, so this must track that.
const UNIT = 10n ** 18n
const usd = (n) => BigInt(n) * UNIT

function connectAs(accountIndex, path) {
  cy.mockWeb3Provider({ account: TEST_ACCOUNTS[accountIndex] })
  cy.visit(path)
  cy.get('.wallet-connect-button, button[aria-label="Connect Wallet"]', { timeout: 10000 }).click()
  cy.selectInjectedConnector()
  cy.get('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 10000 }).should('be.visible')
}

function expectOk(result, label) {
  expect(result.ok, `${label}: ${result.error || 'no error message returned'}`).to.be.true
  return result
}

function createOnChain(overrides = {}) {
  return cy.task('chainTx', { action: 'createFundingPool', args: { organizerIndex: 0, goal: usd(100).toString(), purpose: 'E2E pool', ...overrides } })
    .then((r) => expectOk(r, 'createFundingPool'))
}

function contributeOnChain(index, pool, amount) {
  cy.task('chainTx', { action: 'fund', args: { address: TEST_ACCOUNTS[index] } })
  return cy.task('chainTx', { action: 'contributeFunding', args: { index, pool, amount: amount.toString() } })
    .then((r) => expectOk(r, `contributeFunding #${index}`))
}

describe('Funding Pools', () => {
  // FP-04 advances the chain clock past a settle deadline; per-test isolation keeps that from poisoning
  // every later test's own deadlines (same reason 24-wager-pools isolates POOL-03).
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    // Hermetic: the Payments home asks a public price API for the native-coin rate; nothing here needs it.
    cy.intercept('https://api.coingecko.com/**', { statusCode: 200, body: {} })
  })

  // ---------------------------------------------------------------------------
  // FP-01: create through the UI, contribute through the shared link as a second account
  // ---------------------------------------------------------------------------
  it('[FP-01] Create a pool from Request ▸ Pool, then a contributor opens the link and chips in', () => {
    cy.task('chainTx', { action: 'fund', args: { address: TEST_ACCOUNTS[0] } })
    connectAs(0, '/app?kind=pool')
    cy.get('[data-testid="request-kind"][data-kind="pool"]', { timeout: 20000 }).should('be.visible')

    cy.get('#funding-purpose').type("Dana's surprise party", { delay: 0 })
    cy.enterAmountViaKeypad('funding-goal', '120')
    cy.get('[data-testid="funding-create"]').should('be.enabled').click()
    cy.get('[data-testid="funding-created"]', { timeout: 60000 }).should('exist')
    cy.get('[data-testid="funding-phrase"]').invoke('text').should('match', /^\S+ \S+ \S+ \S+$/)

    cy.get('[data-testid="funding-link"]').invoke('text').then((link) => {
      const path = link.replace(/^https?:\/\/[^/]+/, '')
      expect(path).to.match(/^\/fund\//)

      // The organizer's page shows the pool as created on-chain.
      cy.get('[data-testid="open-my-pool"]').click()
      cy.url({ timeout: 15000 }).should('match', /\/fund\/0x[0-9a-fA-F]{40}/)
      cy.url().then((url) => {
        const pool = url.match(/0x[0-9a-fA-F]{40}/)[0]
        cy.task('chainTx', { action: 'fundingInfo', args: { pool } }).then((info) => {
          expectOk(info, 'fundingInfo')
          expect(info.organizer.toLowerCase()).to.equal(TEST_ACCOUNTS[0].toLowerCase())
          expect(info.purpose).to.equal("Dana's surprise party")
          expect(BigInt(info.goal)).to.equal(usd(120))
          expect(info.state).to.equal(0)
        })
        cy.get('[data-testid="funding-purpose"]').should('contain.text', "Dana's surprise party")
        cy.get('[data-testid="close-pool"]').should('be.visible')

        // A second account follows the WORDS link, sees purpose + goal + progress, and contributes 40.
        cy.task('chainTx', { action: 'fund', args: { address: TEST_ACCOUNTS[1] } })
        connectAs(1, path)
        cy.get('[data-testid="funding-purpose"]', { timeout: 30000 }).should('contain.text', "Dana's surprise party")
        cy.get('[role="progressbar"][aria-label="Progress toward the goal"]').should('have.attr', 'aria-valuenow', '0')
        cy.get('[data-testid="close-pool"]').should('not.exist')
        cy.enterAmountViaKeypad('fp-amount', '40')
        cy.get('[data-testid="contribute"]').should('be.enabled').click()

        // The page re-reads after the receipt: bar, count, feed. (Waited on BEFORE the chain reads.)
        cy.get('[role="progressbar"][aria-label="Progress toward the goal"]', { timeout: 60000 }).should('have.attr', 'aria-valuenow', '33')
        cy.get('[data-testid="funding-contributors"]').should('contain.text', '1 contributor')
        cy.get('[data-testid="feed-entry"]', { timeout: 30000 }).first().should('contain.text', 'You contributed 40')
        cy.get('[data-testid="vote-refund"]').should('be.visible')

        // Judge by chain state.
        cy.task('chainTx', { action: 'fundingMemberInfo', args: { pool, address: TEST_ACCOUNTS[1] } }).then((m) => {
          expectOk(m, 'fundingMemberInfo')
          expect(BigInt(m.contributed), 'recorded contribution').to.equal(usd(40))
        })
        cy.task('chainTx', { action: 'fundingInfo', args: { pool } }).then((info) => {
          expect(BigInt(info.totalRaised)).to.equal(usd(40))
          expect(info.contributorCount).to.equal(1)
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: pool } }).then((r) => {
          expect(BigInt(r.balance), 'escrow holds the contribution').to.equal(usd(40))
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // FP-02: organizer closes below the goal and collects
  // ---------------------------------------------------------------------------
  it('[FP-02] The organizer closes below the goal; the whole pot lands in their account', () => {
    createOnChain({ goal: usd(1000).toString() }).then(({ pool }) => {
      contributeOnChain(1, pool, usd(30))
      contributeOnChain(2, pool, usd(20))
      cy.task('chainTx', { action: 'fund', args: { address: TEST_ACCOUNTS[0] } })

      cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[0] } }).then((before) => {
        connectAs(0, `/fund/${pool}`)
        cy.get('[data-testid="close-pool"]', { timeout: 30000 }).should('contain.text', 'Close & collect 50').click()
        cy.get('[data-testid="confirm-close"]').should('contain.text', 'not yet met').and('contain.text', 'final')
        cy.get('[data-testid="confirm-close-go"]').click()

        // The page's own post-close render lands after the receipt; only then is the chain judged.
        cy.get('[data-testid="funding-closed"]', { timeout: 60000 }).should('contain.text', '50')
        cy.get('[data-testid="contribute-control"]').should('not.exist')

        cy.task('chainTx', { action: 'fundingInfo', args: { pool } }).then((info) => {
          expect(info.state, 'closed').to.equal(1)
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: pool } }).then((r) => {
          expect(BigInt(r.balance), 'escrow emptied').to.equal(0n)
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[0] } }).then((after) => {
          expect(BigInt(after.balance) - BigInt(before.balance), 'organizer received the pot').to.equal(usd(50))
        })

        // Terminal: a contribution attempt on-chain is refused.
        cy.task('chainTx', { action: 'contributeFunding', args: { index: 3, pool, amount: usd(1).toString() } })
          .its('ok').should('not.equal', true)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // FP-03: majority refund vote, then each contributor collects
  // ---------------------------------------------------------------------------
  it('[FP-03] Two of three contributors vote to refund; the pool refunds and each collects their own amount', () => {
    createOnChain().then(({ pool }) => {
      contributeOnChain(1, pool, usd(10))
      contributeOnChain(2, pool, usd(20))
      contributeOnChain(3, pool, usd(30))

      // First vote through the UI as contributor #1.
      connectAs(1, `/fund/${pool}`)
      cy.get('[data-testid="refund-count"]', { timeout: 30000 }).should('contain.text', '0 / 2')
      cy.get('[data-testid="vote-refund"]').click()
      cy.get('[data-testid="confirm-vote"]').should('contain.text', 'organizer can still close')
      cy.get('[data-testid="confirm-vote-go"]').click()
      cy.get('[data-testid="voted"]', { timeout: 60000 }).should('exist')
      cy.get('[data-testid="refund-count"]').should('contain.text', '1 / 2')
      cy.task('chainTx', { action: 'fundingInfo', args: { pool } }).then((info) => {
        expect(info.refundVotes).to.equal(1)
        expect(info.state, 'still open after one vote').to.equal(0)
      })

      // Second vote on-chain as contributor #2 → majority → refunding.
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 2, pool, fn: 'voteRefund' } })
        .then((r) => expectOk(r, 'voteRefund #2'))
      cy.task('chainTx', { action: 'fundingInfo', args: { pool } }).then((info) => {
        expect(info.state, 'refunding').to.equal(2)
        expect(info.refundReason, 'reason: majority').to.equal(2)
      })

      // Contributor #1 collects through the UI; the others on-chain. Balances restore exactly.
      cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).then((before) => {
        cy.reload()
        cy.get('[data-testid="claim-refund"]', { timeout: 30000 }).should('contain.text', 'Collect my 10').click()
        // Once collected the page re-reads and the control is gone — the signal the receipt landed.
        cy.get('[data-testid="claim-refund"]', { timeout: 60000 }).should('not.exist')
        cy.get('[data-testid="refund-count"]').should('contain.text', '1 / 3')
        cy.task('chainTx', { action: 'fundingMemberInfo', args: { pool, address: TEST_ACCOUNTS[1] } }).then((m) => {
          expect(m.refunded).to.be.true
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).then((after) => {
          expect(BigInt(after.balance) - BigInt(before.balance)).to.equal(usd(10))
        })
      })
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 2, pool, fn: 'claimRefund' } }).then((r) => expectOk(r, 'claim #2'))
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 3, pool, fn: 'claimRefund' } }).then((r) => expectOk(r, 'claim #3'))
      cy.task('chainTx', { action: 'tokenBalance', args: { address: pool } }).then((r) => {
        expect(BigInt(r.balance), 'escrow fully returned').to.equal(0n)
      })
      // A second collect is refused; the organizer cannot close a refunding pool.
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 2, pool, fn: 'claimRefund' } }).its('ok').should('not.equal', true)
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 0, pool, fn: 'close' } }).its('ok').should('not.equal', true)
      // The other two collected ON-CHAIN, not through this page, which re-reads on its own actions and on
      // load — never by polling. A fresh load shows the pool fully refunded.
      cy.reload()
      cy.get('[data-testid="refund-count"]', { timeout: 30000 }).should('contain.text', '3 / 3')
    })
  })

  // ---------------------------------------------------------------------------
  // FP-04: never stranded — the settle deadline
  // ---------------------------------------------------------------------------
  it('[FP-04] A pool nobody closes refunds after the settle deadline, triggered by anyone', () => {
    createOnChain({ contributeIn: 600, settleIn: 1200 }).then(({ pool }) => {
      contributeOnChain(1, pool, usd(25))
      // Before the deadline the poke is refused.
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 3, pool, fn: 'pokeDeadline' } }).its('ok').should('not.equal', true)
      cy.advanceTime(1300)

      // An unrelated account (never a contributor) starts refunds from the page.
      cy.task('chainTx', { action: 'fund', args: { address: TEST_ACCOUNTS[3] } })
      connectAs(3, `/fund/${pool}`)
      cy.get('[data-testid="funding-purpose"]', { timeout: 30000 }).should('contain.text', 'E2E pool')
      cy.get('[data-testid="funding-state"]').should('contain.text', 'Open')
      // Both deadlines are judged by the CHAIN's clock (`chainNow`), which advanceTime moved.
      cy.get('[data-testid="contributions-closed"]', { timeout: 30000 }).should('exist')
      cy.get('[data-testid="contribute-control"]').should('not.exist')
      cy.get('[data-testid="poke-deadline"]').click()
      cy.get('[data-testid="refund-reason"]', { timeout: 60000 }).should('contain.text', 'deadline')
      cy.task('chainTx', { action: 'fundingInfo', args: { pool } }).then((info) => {
        expect(info.state, 'refunding').to.equal(2)
        expect(info.refundReason, 'reason: deadline').to.equal(3)
      })
      cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).then((before) => {
        cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 1, pool, fn: 'claimRefund' } }).then((r) => expectOk(r, 'claim #1'))
        cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).then((after) => {
          expect(BigInt(after.balance) - BigInt(before.balance)).to.equal(usd(25))
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // FP-05: organizer refunds everyone
  // ---------------------------------------------------------------------------
  it('[FP-05] The organizer refunds everyone from an open pool', () => {
    createOnChain().then(({ pool }) => {
      contributeOnChain(1, pool, usd(15))
      contributeOnChain(2, pool, usd(5))
      cy.task('chainTx', { action: 'fund', args: { address: TEST_ACCOUNTS[0] } })
      connectAs(0, `/fund/${pool}`)
      cy.get('[data-testid="cancel-pool"]', { timeout: 30000 }).click()
      cy.get('[data-testid="confirm-cancel"]').should('contain.text', 'exactly what they put in')
      cy.get('[data-testid="confirm-cancel-go"]').click()
      cy.get('[data-testid="refund-reason"]', { timeout: 60000 }).should('contain.text', 'organizer')
      cy.get('[data-testid="close-pool"]').should('not.exist')
      cy.task('chainTx', { action: 'fundingInfo', args: { pool } }).then((info) => {
        expect(info.state).to.equal(2)
        expect(info.refundReason, 'reason: organizer').to.equal(1)
      })
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 1, pool, fn: 'claimRefund' } }).then((r) => expectOk(r, 'claim #1'))
      cy.task('chainTx', { action: 'fundingAction', args: { callerIndex: 2, pool, fn: 'claimRefund' } }).then((r) => expectOk(r, 'claim #2'))
      cy.task('chainTx', { action: 'tokenBalance', args: { address: pool } }).then((r) => {
        expect(BigInt(r.balance)).to.equal(0n)
      })
    })
  })
})
