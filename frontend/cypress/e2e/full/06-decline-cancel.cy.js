/**
 * E2E Tests: Decline and Cancel Wagers (Full-tier)
 *
 * Requires a running Hardhat node with deployed contracts (chain 1337).
 * Tests decline by opponent, cancellation by creator, and permission guards.
 *
 * Checklist: DEC-01..DEC-06
 */

const TEST_ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // #0 Creator / Admin
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // #1 Opponent
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // #2 Arbitrator
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // #3 Guardian
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', // #4 Bystander
]

/**
 * Connect wallet and navigate to dashboard.
 */
function connectAndVisit(accountIndex = 0) {
  cy.mockWeb3Provider({ account: TEST_ACCOUNTS[accountIndex] })
  cy.visitWagers()

  cy.connectWallet()
}

/**
 * Create a simple 1v1 wager as the current account.
 */
function createWagerForTest(description, opponent = TEST_ACCOUNTS[1]) {
  cy.openCreateWagerModal('oneVsOne')

  cy.get('#fm-description, [role="dialog"] input[type="text"]')
    .first()
    .clear()
    .type(description)

  cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]')
    .first()
    .clear()
    .type(opponent)

  // Wait for the address to RESOLVE, not a fixed 500ms. validateForm requires
  // formData.opponentResolved (FriendMarketsModal.jsx:699-702), which AddressInput sets from an
  // async callback; submitting first fails validation with "Opponent address is required" and the
  // modal simply never reaches the success screen. AddressInput renders
  // role="img" aria-label="Valid address" once resolution lands.
  cy.get('[aria-label="Valid address"]', { timeout: 15000 }).should('exist')

  cy.enterAmountViaKeypad('fm-stake', '5')

  // Encryption is ON by default and is no longer optional — the opt-out checkbox was removed
  // from FriendMarketsModal several sprints ago (grep `checkbox` there returns nothing). The
  // block that used to uncheck it was a no-op guarded by `if (length > 0)`, so it silently did
  // nothing while the spec read as though it controlled encryption. (#1028)

  cy.get('.fm-btn-primary', { timeout: 10000 }).should('not.be.disabled').click()

  // Wait for creation
  cy.contains('Wager Created', { timeout: 60000 }).should('exist')

  // Close modal
  cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
    .click({ force: true })
}

/**
 * Poll the registry until `wagerId` reads back as None (0) — the on-chain proof that an exit
 * from a pending wager landed and the escrow was released.
 *
 * Neither exit leaves a Cancelled status behind: WagerRegistryCore RELEASES a declined or
 * withdrawn Open wager's storage for reuse (the gas-refund pattern), so the record reads back
 * as None. Paired with a precondition check that the wager was Open (1) beforehand, the
 * Open(1)→None(0) transition is what says the money moved back.
 */
function waitForWagerReleased(wagerId, tries = 45) {
  const poll = (n) =>
    cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((info) => {
      if (info.ok && Number(info.status) === 0) return cy.wrap(info.status)
      if (n <= 0) throw new Error(`wager ${wagerId} was never released; last status ${info.status}`)
      cy.wait(1000)
      return poll(n - 1)
    })
  return poll(tries)
}

describe('Decline and Cancel Wagers', () => {
  before(() => {
    // Encryption is MANDATORY: FriendMarketsModal refuses to create a wager whose opponent has
    // no key in KeyRegistry, silently and with no validation error. A fresh chain has none.
    // Keys persist on chain, so this is once per spec — later runs hit the hasKey fast path.
    cy.ensureWagerCapacity([0, 1])
    cy.ensureEncryptionKeys([0, 1])
  })

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    /*
     * STUB THE PINNING SERVICE — see frontend/package.json `dev:e2e`. Both exits from a pending
     * wager need one CREATED first, and a create that cannot pin its encrypted metadata throws
     * before it reaches WagerRegistry.
     */
    cy.interceptIpfs()
  })

  // ---------------------------------------------------------------------------
  // DEC-01: Opponent declines pending wager
  // ---------------------------------------------------------------------------
  it('[DEC-01] Opponent declines pending wager', () => {
    // Create wager as account #0
    connectAndVisit(0)
    createWagerForTest('DEC-01: Opponent will decline this')

    cy.lastWagerId().then((wagerId) => {
      // Pin the precondition: the wager this test just created is Open (1).
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } })
        .its('status').should('eq', 1)

      // Switch to opponent
      cy.switchAccount(1)

      cy.openMyWagers('participating')

      // The offer MUST be here — this test just created it addressed to #1.
      // (The old guard's else-branch swallowed "offer missing" as a pass.)
      cy.contains('button', /view offer/i, { timeout: 15000 }).click({ force: true })
      cy.get('.ma-modal, [role="dialog"]', { timeout: 10000 }).should('be.visible')

      cy.contains('button', /decline/i).click()
      cy.contains('button', /confirm decline/i).click()

      /*
       * The acceptance modal CLOSES on a successful decline, so asserting its
       * text re-matched whichever dialog remained (MyMarketsModal) — a surface
       * that never says "declined", which made this test fail against a
       * correct app. Assert the OUTCOME instead — and the outcome is not a
       * Cancelled status: WagerRegistryCore RELEASES a declined/cancelled Open
       * wager's storage for reuse (the gas-refund pattern), so the record
       * reads back as None (0). The Open(1)→None(0) transition, pinned by the
       * precondition check above, IS the on-chain proof the decline landed
       * and the escrow was released. (See waitForWagerReleased above — DEC-02
       * asserts the creator's withdrawal by the same transition.)
       */
      waitForWagerReleased(wagerId)

      /*
       * DELIBERATELY NOT ASSERTED: the list dropping the declined offer.
       *
       * Measured (2026-08-18): the "View Offer" row survives the decline —
       * on the stale open list AND after closing and reopening MyMarkets —
       * because the list's data outlives the modal and refreshes on a slower
       * cadence than any reasonable test timeout. Whether a declined wager
       * should stop being actionable promptly is a PRODUCT question, filed on
       * #1019; encoding either answer here would invent the decision. What
       * this test proves is the money path: the decline transacted and the
       * escrow was released (the Open→None poll above). A member tapping the
       * stale row gets the contract's refusal, not a double-decline.
       */
    })
  })

  // ---------------------------------------------------------------------------
  // DEC-02: Creator cancels open wager
  // ---------------------------------------------------------------------------
  it('[DEC-02] Creator cancels (withdraws) open wager', () => {
    connectAndVisit(0)
    createWagerForTest('DEC-02: Creator will cancel this')

    // Open My Wagers → Created tab
    cy.openMyWagers('created')

    /*
     * This test CREATED the wager above, so the row is a precondition, not a probe: it is
     * asserted retryably below and fails HERE if it never lists, rather than no-oping through a
     * one-shot snapshot (#1250). The WINDOW matters as much as the shape — 20s failed against a
     * list that does arrive — so the wait below keeps the 60s measured here.
     *
     * Measured on a clean local node: the cache key `friendMarkets:80002` is ALREADY written
     * (~6.4 KB) by the time this line runs — the page's first scan completed back at
     * `connectAndVisit(0)`, before the wager existed. So the row needs the NEXT scan, and it
     * lands at roughly 30s. The old 20s window closed first.
     *
     * `cy.settledWagerPanel()` deliberately NOT used here, though this is exactly the shape it
     * was written for: it waits for that key to exist, and here it already does, so it settles
     * instantly on a list that predates the creation and proves nothing. Its own docstring
     * names the precondition it needs — the key absent when the wait starts, via
     * `clearLocalStorage` or `switchAccount` — and this test meets neither. A retryable
     * assertion with a window that actually covers a cold scan is the honest wait, and it
     * still fails here, naming this precondition, if the row never lists at all.
     */
    cy.lastWagerId().then((wagerId) => {
      // Pin the precondition: the wager this test just created is Open (1), so the
      // Open→None transition asserted at the end can only mean the withdrawal landed.
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } })
        .its('status').should('eq', 1)

      /*
       * OPEN THE PENDING ROW. Matching on the row's own status badge rather than taking
       * `rows.first()`: this spec does not reset the chain between tests, and "Withdraw Offer"
       * is offered only on a PENDING_ACCEPTANCE wager, so an accepted or withdrawn leftover
       * sitting first in the list would send this test looking for a control that correctly
       * is not there.
       *
       * "Under Consideration", not "Pending": the row VM swaps the status text for the
       * CREATOR of a pending wager (wagerVm.js#statusText, isCreatorOfPending) — and this test
       * is the creator. The detail badge below still says "Pending Acceptance" because the
       * detail view renders getStatusLabel directly; only the row wears the creator-facing
       * label. /pending/i alone burned the full 60s here without ever matching.
       */
      cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
        .contains('.mm-table-row', /under consideration|pending/i, { timeout: 60000 })
        .click()

      cy.get('.mm-detail', { timeout: 5000 }).should('be.visible')
      cy.get('.mm-detail .mm-status-badge').should('contain.text', 'Pending Acceptance')

      /*
       * THE WITHDRAW CONTROL IS GUARANTEED HERE, so assert it — do not snapshot for it.
       *
       * MyMarketsModal renders "Withdraw Offer" for `isCreatorView && isCreator &&
       * PENDING_ACCEPTANCE`, all three of which this test has just arranged. The old
       * `$detail.find(...)` withdraw lookup was a one-shot DOM snapshot inside
       * `.then()` (anti-pattern 3) taken the instant `.mm-detail` became visible: when the
       * action area had not rendered yet it took the else branch, asserted that the panel
       * contained one of active|pending|resolved — true of the panel it was already looking
       * at — and reported a PASS having withdrawn nothing. The success branch was barely
       * better: it accepted `error` alongside `withdrawn`, so it passed whether the
       * transaction succeeded or failed.
       */
      cy.get('.mm-detail').contains('button', /withdraw offer/i, { timeout: 20000 })
        .should('be.visible')
        .and('not.be.disabled')
        .click()

      /*
       * JUDGE IT BY THE AUTHORITY THAT DECIDES IT. Whether the panel says "Offer withdrawn"
       * is copy; whether the member got their stake back is the money path, and the registry
       * releasing the record (Open→None, DEC-01's pattern) is what says it did.
       */
      waitForWagerReleased(wagerId)
    })
  })

  // ---------------------------------------------------------------------------
  // DEC-03: Non-opponent cannot decline
  // ---------------------------------------------------------------------------
  it('[DEC-03] Non-opponent cannot decline wager', () => {
    connectAndVisit(0)
    createWagerForTest('DEC-03: Only opponent can decline', TEST_ACCOUNTS[1])

    // Switch to bystander (not the opponent)
    cy.switchAccount(4)

    cy.openMyWagers('participating')

    // Bystander should not see the wager or should not have decline option
    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).invoke('text').then((text) => {
      const lower = text.toLowerCase()
      // Should not see any wagers or should be in empty state
      const noAccess = lower.includes('no active') ||
                      lower.includes('don\'t have') ||
                      lower.includes('empty') ||
                      lower.includes('no wagers')
      // Alternatively, if the wager shows up, it should not have decline option
      const noDecline = !lower.includes('decline')
      expect(noAccess || noDecline).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // DEC-04: Non-creator cannot cancel
  // ---------------------------------------------------------------------------
  it('[DEC-04] Non-creator cannot cancel wager', () => {
    connectAndVisit(0)
    createWagerForTest('DEC-04: Non-creator cancel test')

    cy.lastWagerId().then((wagerId) => {
      // The chain is the authority here: only the creator may cancelOpen (NotCreator otherwise).
      cy.task('chainTx', { action: 'cancelOpen', args: { wagerId, callerIndex: 1 } }).then((r) => {
        expect(r.ok, 'a non-creator cannot cancel the wager').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager is untouched — still Open').to.equal(1)
      })

      // And the UI does not offer the control to the opponent either.
      cy.switchAccount(1)
      cy.openMyWagers('participating')
      cy.contains('.mm-panel button, [role="tabpanel"] button', /view offer/i, { timeout: 20000 })
        .click({ force: true })
      cy.get('.ma-modal, [role="dialog"]', { timeout: 5000 }).should('be.visible')

      /*
       * ANCHOR THE ABSENCE ON THE MODAL HAVING DECIDED WHAT TO SHOW.
       *
       * `.ma-modal` becoming visible does not mean it has rendered its terms or its action row:
       * every wager here is private, so the modal first has to resolve the decrypt gate. A
       * one-shot `$modal.find(...)` taken in between (anti-pattern 3) finds no cancel control
       * for a reason that has nothing to do with permissions, and the assertion passes anyway.
       *
       * Wait for one of the modal's terminal states — the same edge cy.acceptOfferInModal()
       * waits on — and only then assert the control is absent.
       */
      cy.get('.ma-modal')
        .find('.ma-decrypt-prompt, .ma-description, .ma-decrypt-error', { timeout: 20000 })
        .should('exist')
      cy.get('.ma-modal').contains('button', /withdraw/i).should('not.exist')
      cy.get('.ma-modal').contains('button', /cancel wager/i).should('not.exist')
    })
  })

  // ---------------------------------------------------------------------------
  // DEC-05: Cannot cancel/decline after Active
  // ---------------------------------------------------------------------------
  it('[DEC-05] Cannot cancel or decline after wager is Active', () => {
    /*
     * ESTABLISH THE ACTIVE WAGER — do not hope one is lying around.
     *
     * This test used to connect, snapshot the panel, and filter its rows for an Active one;
     * when the filter found nothing (the scan not finished, or no earlier test having left an
     * accepted wager behind) it fell through to an else branch whose assertion ended in
     * `lower.length > 0` — true of any rendered panel. It reported as coverage for a rule
     * nobody had checked. Created and accepted on chain here, so the precondition is a fact
     * this test owns; ACC-09 and RES-12 arrange theirs the same way.
     */
    cy.createAndAcceptWager({ stake: 5 }).then((wagerId) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } })
        .its('status').should('eq', 2) // Active

      connectAndVisit(0)
      cy.openMyWagers('created')

      /*
       * OPEN THE ROW THAT IS ACTUALLY ACTIVE, retryably. A pending offer legitimately carries a
       * Withdraw control, so `rows.first()` made the assertion below pass or fail on list
       * ordering. `cy.contains` retries until an Active row lists, so a scan that has not
       * finished is a wait rather than a silently-skipped test (#1250).
       */
      /*
       * The chain says Active (pinned above); the ROW may already say "Pending Resolution" —
       * computedStatus is a function of the browser clock against the wager's own end time,
       * and this spec's earlier tests advance both clocks, so the label depends on where the
       * shard's clock sits when the scan lands. Either label is this wager; the detail is
       * then pinned to the id so a stale row matching the same label fails loudly instead of
       * quietly standing in.
       */
      cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
        .contains('.mm-table-row', /active|pending resolution/i, { timeout: 60000 })
        .click()

      cy.get('.mm-detail', { timeout: 5000 }).should('be.visible')
      cy.get('.mm-detail', { timeout: 10000 }).should('contain.text', `#${wagerId}`)

      /*
       * ANCHOR THE ABSENCE on the detail agreeing which wager it is describing, then assert the
       * exit controls are gone. `$detail.find(...)` inside `.then()` read the action area once
       * (anti-pattern 3) and would have reported "no Withdraw, no Cancel" of an area that had
       * simply not rendered.
       */
      // The badge is computed from the browser clock against the wager's end time, exactly like
      // the row above — an on-chain-Active wager reads 'Pending Resolution' once the shard's
      // clock passes its end time. Either label is on-chain status 2; the id pin above is what
      // ties the detail to THIS wager.
      cy.get('.mm-detail .mm-status-badge').invoke('text')
        .should('match', /active|pending resolution/i)
      cy.get('.mm-detail').contains('button', /withdraw/i).should('not.exist')
      cy.get('.mm-detail').contains('button', /cancel/i).should('not.exist')

      // And the chain refuses both exits outright, which is the guarantee the UI is reflecting.
      cy.task('chainTx', { action: 'cancelOpen', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, 'an Active wager can no longer be cancelled by its creator').to.equal(false)
      })
      cy.task('chainTx', { action: 'declineWager', args: { wagerId, callerIndex: 1 } }).then((r) => {
        expect(r.ok, 'an Active wager can no longer be declined by its opponent').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'the wager is untouched — still Active').to.equal(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // DEC-06: Frozen account cannot decline
  // ---------------------------------------------------------------------------
  it('[DEC-06] A frozen account cannot decline a wager, and can once unfrozen', () => {
    // Create a wager where the opponent is account #1
    connectAndVisit(0)
    createWagerForTest('DEC-06: Frozen decline test')

    cy.lastWagerId().then((wagerId) => {
      cy.task('chainTx', { action: 'freeze', args: { address: TEST_ACCOUNTS[1] } }).then((r) => {
        expect(r.ok, `freeze the opponent (${r.error || ''})`).to.be.true
      })

      // Blocked while frozen — and the wager stays Open, which is the part that matters.
      cy.task('chainTx', { action: 'declineWager', args: { wagerId, callerIndex: 1 } }).then((r) => {
        expect(r.ok, 'a frozen account cannot decline').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager stays Open while the opponent is frozen').to.equal(1)
      })

      // Reversible, matching CLM-10: unfreezing restores the ability to decline. A declined
      // Open wager's storage is released for reuse (DEC-01's Open→None pattern), so status
      // reading back as None (0) IS the on-chain proof the decline landed.
      cy.task('chainTx', { action: 'unfreeze', args: { address: TEST_ACCOUNTS[1] } }).then((r) => {
        expect(r.ok, `unfreeze the opponent (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'declineWager', args: { wagerId, callerIndex: 1 } }).then((r) => {
        expect(r.ok, `decline succeeds once unfrozen (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager is released (None) after the decline').to.equal(0)
      })
    })
  })
})
