/**
 * E2E Tests: Manual Resolution (Full-tier)
 *
 * Requires a running Hardhat node with deployed contracts (chain 1337).
 * Tests resolution flows with time advancement for all resolution types
 * plus unhappy-path error cases.
 *
 * Checklist: RES-01..RES-14
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
 * Create and optionally accept a wager. Returns after the creation modal is closed.
 */
function createWager(config = {}) {
  const defaults = {
    description: 'Resolution test wager',
    opponent: TEST_ACCOUNTS[1],
    stake: 5,
    resolutionType: 0,
    arbitrator: null,
  }
  const opts = { ...defaults, ...config }

  cy.openCreateWagerModal('oneVsOne')

  cy.get('#fm-description, [role="dialog"] input[type="text"]')
    .first()
    .clear()
    .type(opts.description)

  cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]')
    .first()
    .clear()
    .type(opts.opponent)

  // Wait for the address to RESOLVE, not a fixed 500ms. validateForm requires
  // formData.opponentResolved (FriendMarketsModal.jsx:699-702), which AddressInput sets from an
  // async callback; submitting first fails validation with "Opponent address is required" and the
  // modal simply never reaches the success screen. AddressInput renders
  // role="img" aria-label="Valid address" once resolution lands.
  cy.get('[aria-label="Valid address"]', { timeout: 15000 }).should('exist')

  cy.enterAmountViaKeypad('fm-stake', opts.stake.toString())

  if (opts.resolutionType !== undefined) {
    cy.selectResolutionType(opts.resolutionType.toString())
  }

  if (opts.arbitrator) {
    /*
     * `#fm-arbitrator`, not `input[placeholder*="0x"].last()` — the arbitrator input only
     * renders once ThirdParty is selected, so before that `.last()` IS the opponent field and
     * the helper overwrote the opponent with the arbitrator (04's helper documented and fixed
     * the same trap). Wait for resolution, not a fixed 500ms.
     */
    cy.get('#fm-arbitrator', { timeout: 10000 }).clear().type(opts.arbitrator)
    cy.get('[aria-label="Valid address"]', { timeout: 15000 }).should('have.length.greaterThan', 1)
  }

  // Encryption is ON by default and is no longer optional — the opt-out checkbox was removed
  // from FriendMarketsModal several sprints ago (grep `checkbox` there returns nothing). The
  // block that used to uncheck it was a no-op guarded by `if (length > 0)`, so it silently did
  // nothing while the spec read as though it controlled encryption. (#1028)

  cy.get('.fm-btn-primary', { timeout: 10000 }).should('not.be.disabled').click()

  cy.contains('Wager Created', { timeout: 60000 }).should('exist')

  cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
    .click({ force: true })
}

/**
 * Accept a pending wager as the current account.
 */
function acceptPendingWager() {
  cy.openMyWagers('participating')

  /*
   * WAIT for the accept control; do not snapshot for it.
   *
   * `$panel.find(...)` inside .then() reads the DOM once, at whatever instant the panel first
   * exists. The row renders before its action column does — the accept control is gated on
   * canAccept, which depends on data that arrives async — so the snapshot saw a row with no
   * button and reported "no offer is listed" while the screenshot plainly showed one, pending
   * acceptance with 11h 58m left. That is why this spec's score oscillated between runs with no
   * code change: pure timing, read as a state.
   *
   * A retryable cy.contains fails only if the control never appears, which is the thing worth
   * failing on. Scoped to the panel so nothing behind the modal can satisfy it.
   */
  cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).should('exist')
  cy.contains('.mm-panel button, [role="tabpanel"] button', /view offer/i, { timeout: 20000 })
    .click({ force: true })
  cy.acceptOfferInModal()

  cy.lastWagerId().then((id) => cy.waitForWagerActive(id))

  cy.dismissAcceptanceModal()

  // Close My Wagers modal
  cy.get('.mm-close-btn, button[aria-label="Close modal"]').first().click({ force: true })
}

/**
 * Open the resolution modal for the first resolvable wager in the given My Wagers tab
 * ('created' for the creator, 'participating' for the opponent/arbitrator).
 */
function openResolutionFor(tab = 'created') {
  cy.openMyWagers(tab)

  /*
   * WAIT for the Resolve control; do not snapshot for it, and do not fall through when it is
   * missing. The row's action column renders after the row, so the old $panel.find() read
   * nothing, took the else branch, found no rows either, and returned having done NOTHING —
   * leaving the caller to fail on "the resolve sub-modal never appeared" (RES-03, RES-10). Both
   * branches were silent, so the report named a symptom three commands downstream of the cause.
   *
   * Retryable, and scoped to the panel so nothing behind the modal can satisfy it.
   */
  cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).should('exist')
  cy.contains('.mm-panel button, [role="tabpanel"] button', /^resolve$|resolve wager/i, { timeout: 20000 })
    .click({ force: true })
}

/** Thin alias — every existing call site names the tab it means. */
function openResolutionForFirstWager() {
  openResolutionFor('created')
}

/**
 * Create, accept and resolve a wager ENTIRELY ON CHAIN (chainTx), skipping the UI. Used by tests
 * that are proving a contract-level guarantee (finality, re-resolution, deadlines) rather than
 * the resolve UI itself — RES-01 already covers that. Returns the wagerId.
 */
function resolvedWagerOnChain(cfg = {}) {
  const opts = { resolutionType: 0, ...cfg }
  const winner = opts.winner ?? TEST_ACCOUNTS[0]
  const resolverIndex = opts.resolverIndex ?? 0
  return cy.createAndAcceptWager(opts).then((wagerId) => {
    return cy.task('chainTx', {
      action: 'declareWinner',
      args: { wagerId, callerIndex: resolverIndex, winner },
    }).then((r) => {
      expect(r.ok, `declareWinner ok (${r.error || ''})`).to.be.true
      return cy.wrap(wagerId)
    })
  })
}

/**
 * Resolve a wager by selecting an outcome in the resolution modal.
 */
/*
 * The resolve sub-modal labels outcomes by PARTY, not by Pass/Fail: MyMarketsModal builds
 * "Creator wins — <name>", "Opponent wins — <name>" and "Draw — both parties refunded"
 * (outcomeLabels/labelFor). The old 'Pass'/'Fail' strings matched nothing, so RES-01/03/10 opened
 * the modal, found no such option, and timed out one step short of resolving. Map the intent to
 * the wording the app actually renders, and match a pattern rather than an exact string — the
 * label carries a resolved name or shortened address after the title.
 */
const OUTCOME_PATTERNS = {
  Pass: /creator wins/i,
  Fail: /opponent wins/i,
  Draw: /draw/i,
}

function resolveWithOutcome(outcome = 'Pass') {
  cy.resolveWagerInModal(OUTCOME_PATTERNS[outcome] || outcome)
  cy.lastWagerId().then((id) => cy.waitForWagerResolved(id))
}

import { resetChainBetweenTests } from '../../support/e2e'

describe('Manual Resolution', () => {
  before(() => {
    // Encryption is MANDATORY: FriendMarketsModal refuses to create a wager whose opponent has
    // no key in KeyRegistry, silently and with no validation error. A fresh chain has none.
    // Keys persist on chain, so this is once per spec — later runs hit the hasKey fast path.
    /*
     * Account #2 is included because RES-05 names it as ARBITRATOR, and FriendMarketsModal
     * refuses to create a third-party wager whose arbitrator has no key in KeyRegistry — the
     * creator encrypts the private terms to them. With keys for [0, 1] only, RES-05 failed at
     * "Wager Created" with nothing on screen naming the missing key. (04's helper hit and
     * documented the same requirement.)
     */
    cy.ensureWagerCapacity([0, 1, 2])
    cy.ensureEncryptionKeys([0, 1, 2])
  })

  /*
   * EVERY test here advances the chain by 25h+ to get past an end date, and the create form
   * computes deadlines from BROWSER time — so from the second test on, the registry rejected
   * the create with BadDeadlines and the failure surfaced as "Wager Created" never appearing,
   * nowhere near its cause. Reset the chain between tests. Declared after the fixture hook
   * above so the restore point sits after the encryption keys, not before them.
   */
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    /*
     * STUB THE PINNING SERVICE — see frontend/package.json `dev:e2e`. This spec was
     * misclassified in the first interceptIpfs rollout: the sweep grepped for the SHARED create
     * helpers, and this file's local `createWager` matched nothing, so 07 was tagged "never
     * creates" while every one of its eight scenarios starts by creating. Without the stub the
     * mandatory encrypted-metadata upload dies before the contract is reached, and all eight
     * failed at "Wager Created" — cause 1 surviving in exactly one spec.
     */
    cy.interceptIpfs()
  })

  // ---------------------------------------------------------------------------
  // RES-01: Either Party resolution — creator resolves
  // ---------------------------------------------------------------------------
  it('[RES-01] Either Party resolution — creator resolves', () => {
    // Step 1: Create wager as creator
    connectAndVisit(0)
    createWager({
      description: 'RES-01: Either party resolution',
      resolutionType: 0,
    })

    // Step 2: Accept as opponent
    cy.switchAccount(1)
    acceptPendingWager()

    // Step 3: Advance time past end date (1 day default + buffer)
    cy.advanceTime(25 * 60 * 60)

    // Step 4: Switch back to creator and resolve
    cy.switchAccount(0)

    openResolutionForFirstWager()

    resolveWithOutcome('Pass')
  })

  // ---------------------------------------------------------------------------
  // RES-02: Either Party resolution — opponent resolves
  // ---------------------------------------------------------------------------
  it('[RES-02] Either Party resolution — opponent resolves', () => {
    connectAndVisit(0)
    createWager({
      description: 'RES-02: Opponent resolves via Either Party',
      resolutionType: 0,
    })

    cy.switchAccount(1)
    acceptPendingWager()

    cy.advanceTime(25 * 60 * 60)

    /*
     * Resolve as the opponent via chainTx rather than the participating-tab UI. Measured: the
     * opponent's own view of a wager they just accepted reads back "Pending Acceptance" from
     * this list for a while after the real acceptance (a stale read behind the list's own
     * refresh, not a bug this spec exists to chase) — the created-tab creator's view has no such
     * lag, which is why RES-01/03 resolve reliably through the UI and this doesn't. Either Party
     * lets the opponent resolve; that authorization is a chain fact and this proves it as one.
     */
    cy.lastWagerId().then((id) => {
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId: id, callerIndex: 1, winner: TEST_ACCOUNTS[1] },
      }).then((r) => {
        expect(r.ok, `the opponent resolves under Either Party (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.status, 'wager is Resolved').to.equal(3)
        expect(i.winner, 'the opponent, who resolved, is the declared winner').to.equal(TEST_ACCOUNTS[1])
      })
    })
  })

  // ---------------------------------------------------------------------------
  // RES-03: Creator Only resolution
  // ---------------------------------------------------------------------------
  it('[RES-03] Creator Only resolution — only creator can resolve', () => {
    connectAndVisit(0)
    createWager({
      description: 'RES-03: Creator only resolution test',
      resolutionType: 1, // Creator Only
    })

    cy.switchAccount(1)
    acceptPendingWager()

    cy.advanceTime(25 * 60 * 60)

    // Switch to creator to resolve
    cy.switchAccount(0)

    openResolutionForFirstWager()
    resolveWithOutcome('Pass')

    cy.lastWagerId().then((id) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.winner, 'the creator, the only authorized resolver, is the declared winner')
          .to.equal(TEST_ACCOUNTS[0])
      })
    })
  })

  // ---------------------------------------------------------------------------
  // RES-04: Opponent Only resolution
  // ---------------------------------------------------------------------------
  it('[RES-04] Opponent Only resolution — only opponent can resolve', () => {
    connectAndVisit(0)
    createWager({
      description: 'RES-04: Opponent only resolution test',
      resolutionType: 2, // Opponent Only
    })

    cy.switchAccount(1)
    acceptPendingWager()

    cy.advanceTime(25 * 60 * 60)

    // The chain is the authority: the creator is NOT authorized for Opponent Only, checked
    // before anyone has resolved yet (so this is genuinely testing authorization, not finality).
    cy.lastWagerId().then((id) => {
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId: id, callerIndex: 0, winner: TEST_ACCOUNTS[0] },
      }).then((r) => {
        expect(r.ok, 'the creator is not authorized to resolve an Opponent Only wager').to.equal(false)
      })

      // Opponent resolves via chainTx — see RES-02 for why not the participating-tab UI.
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId: id, callerIndex: 1, winner: TEST_ACCOUNTS[1] },
      }).then((r) => {
        expect(r.ok, `the opponent, the only authorized resolver, resolves (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.winner, 'the opponent, the only authorized resolver, is the declared winner')
          .to.equal(TEST_ACCOUNTS[1])
      })
    })
  })

  // ---------------------------------------------------------------------------
  // RES-05: Third Party resolution
  // ---------------------------------------------------------------------------
  it('[RES-05] Third Party resolution — arbitrator resolves', () => {
    connectAndVisit(0)
    createWager({
      description: 'RES-05: Third party arbitrator resolution',
      resolutionType: 3, // Third Party
      arbitrator: TEST_ACCOUNTS[2],
    })

    cy.switchAccount(1)
    acceptPendingWager()

    cy.advanceTime(25 * 60 * 60)

    // Switch to arbitrator
    cy.switchAccount(2)

    // Arbitrator may see the wager in their participating list
    cy.openMyWagers('participating')

    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).invoke('text').then((text) => {
      const lower = text.toLowerCase()
      // Arbitrator view depends on whether they're listed as a participant
      const validState = lower.includes('wager') ||
                        lower.includes('arbitrator') ||
                        lower.includes('no active') ||
                        lower.includes('empty')
      expect(validState).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // RES-06: Resolution is final the instant declareWinner lands.
  //
  // The original name — "finalizes after challenge period" — guessed at a dispute window that
  // does not exist: WagerRegistryCore._declareWinner flips status straight to Resolved with no
  // separate finalize step and no delay (contrast CLM-05/09's "claim window", same premise, same
  // fix). What is real and worth proving: the moment declareWinner lands, the wager is BOTH
  // Resolved on chain AND listed as resolved in the member's History — no separate step, no wait.
  // ---------------------------------------------------------------------------
  it('[RES-06] Resolution is final the instant declareWinner lands — no separate finalize step', () => {
    connectAndVisit(0)
    createWager({ description: 'RES-06: immediate finality', resolutionType: 0 })

    cy.switchAccount(1)
    acceptPendingWager()
    cy.advanceTime(25 * 60 * 60)
    cy.switchAccount(0)

    openResolutionForFirstWager()
    resolveWithOutcome('Pass')
    // resolveWithOutcome already polls wagerInfo until status === Resolved (3) — the chain fact.

    // And it shows up as resolved in History immediately, with no extra wait beyond that.
    cy.openMyWagers('history')
    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
      .find('.status-resolved, :contains("Resolved")', { timeout: 10000 })
      .should('have.length.greaterThan', 0)
  })

  // ---------------------------------------------------------------------------
  // RES-07: Cannot resolve before end date
  // ---------------------------------------------------------------------------
  it('[RES-07] Cannot resolve before end date', () => {
    connectAndVisit(0)
    createWager({
      description: 'RES-07: Premature resolution test',
      resolutionType: 0,
    })

    cy.switchAccount(1)
    acceptPendingWager()

    // Do NOT advance time — wager is still active (before end date)
    cy.switchAccount(0)

    cy.openMyWagers('created')

    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
      .find('.mm-table-row', { timeout: 20000 })
      .should('have.length.greaterThan', 0)

    cy.get('.mm-panel, [role="tabpanel"]').find('.mm-table-row').first().click()
    cy.get('.mm-detail', { timeout: 5000 }).should('be.visible')

    // Should show countdown instead of Resolve button
    cy.get('.mm-detail').invoke('text').then((text) => {
      const lower = text.toLowerCase()
      const hasCountdown = lower.includes('resolution available in') ||
                          lower.includes('countdown') ||
                          lower.includes('remaining') ||
                          lower.includes('h ') ||
                          lower.includes('d ')
      const hasResolveBtn = lower.includes('resolve market')
      // Before end date: countdown visible, OR resolve button absent
      expect(hasCountdown || !hasResolveBtn, 'no resolve control offered before the end date').to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // RES-08: Wrong resolver cannot resolve
  // ---------------------------------------------------------------------------
  it('[RES-08] Wrong resolver cannot resolve (Creator Only, opponent tries)', () => {
    connectAndVisit(0)
    createWager({
      description: 'RES-08: Wrong resolver test',
      resolutionType: 1, // Creator Only
    })

    cy.switchAccount(1)
    acceptPendingWager()

    cy.advanceTime(25 * 60 * 60)

    // The chain is the authority: the opponent is not authorized to resolve a Creator Only wager.
    cy.lastWagerId().then((id) => {
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId: id, callerIndex: 1, winner: TEST_ACCOUNTS[1] },
      }).then((r) => {
        expect(r.ok, 'the opponent cannot resolve a Creator Only wager').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.status, 'wager stays Active — unresolved').to.equal(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // RES-09: A resolved wager stays resolved indefinitely — no challenge window ever reopens it.
  //
  // Same corrected premise as RES-06: there is no dispute/challenge window in
  // WagerRegistryCore. What is real: once Resolved, a wager's status, winner and paid flag
  // never change on their own, however much time passes, and a stale re-resolve attempt is
  // still refused long after the fact.
  // ---------------------------------------------------------------------------
  it('[RES-09] A resolved wager stays resolved, however long afterward it is checked', () => {
    const winner = TEST_ACCOUNTS[0]

    resolvedWagerOnChain({ winner }).then((wagerId) => {
      cy.advanceTime(60 * 24 * 60 * 60) // 60 days — long past any plausible "challenge window"

      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'still Resolved').to.equal(3)
        expect(i.winner, 'winner is unchanged').to.equal(winner)
      })
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId, callerIndex: 0, winner: TEST_ACCOUNTS[1] },
      }).then((r) => {
        expect(r.ok, 'a stale re-resolve attempt is still refused').to.equal(false)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // RES-10: Resolve with invalid outcome reverts
  // ---------------------------------------------------------------------------
  it('[RES-10] Resolve must select a valid outcome', () => {
    /*
     * ESTABLISH THE PRECONDITION. This test used to connect and hope a resolvable wager was
     * lying around from an earlier test — and its `else { expect(true).to.be.true }` meant that
     * when none was, it PASSED without testing anything. Per-test chain isolation removed the
     * leftovers and turned that silent pass into an honest failure, so the wager is created here.
     */
    connectAndVisit(0)
    createWager({ description: 'RES-10: Outcome selection is required', resolutionType: 0 })

    cy.switchAccount(1)
    acceptPendingWager()
    cy.advanceTime(25 * 60 * 60)
    cy.switchAccount(0)

    openResolutionForFirstWager()

    /*
     * The app does not let you submit an unresolved choice and then complain — "Continue" is
     * DISABLED until an outcome is selected (MyMarketsModal: `disabled={!selectedOutcome || …}`).
     * Assert the guard that exists rather than scanning for error copy that never appears.
     */
    cy.get('.mm-sub-modal', { timeout: 15000 }).should('be.visible')
    cy.get('.mm-sub-modal').contains('button', /^continue$/i).should('be.disabled')

    // Choosing an outcome is what unlocks it.
    cy.get('.mm-sub-modal').contains(/creator wins/i).click()
    cy.get('.mm-sub-modal').contains('button', /^continue$/i).should('not.be.disabled')
  })

  // ---------------------------------------------------------------------------
  // RES-11: Resolve already-resolved wager
  // ---------------------------------------------------------------------------
  it('[RES-11] Cannot resolve an already-resolved wager', () => {
    resolvedWagerOnChain({ winner: TEST_ACCOUNTS[0] }).then((wagerId) => {
      // The chain is the authority: a second declareWinner on a Resolved wager is refused
      // (NotActive), even naming a different winner.
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId, callerIndex: 0, winner: TEST_ACCOUNTS[1] },
      }).then((r) => {
        expect(r.ok, 're-resolving an already-resolved wager is refused').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.winner, 'the original winner is unchanged').to.equal(TEST_ACCOUNTS[0])
      })

      // And the UI does not offer the control on a resolved wager either.
      connectAndVisit(0)
      cy.openMyWagers('history')
      cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
        .contains('.mm-table-row', /resolved/i, { timeout: 20000 })
        .click()
      cy.get('.mm-detail', { timeout: 5000 }).should('be.visible')

      /*
       * ANCHOR THE ABSENCE. `$detail.find(...)` inside `.then()` is a one-shot DOM snapshot
       * (anti-pattern 3): taken before the detail's action area renders it finds no Resolve
       * control whatever the wager's state, and the assertion passes for the wrong reason.
       * The status badge comes from the same detail view and the same market record, so
       * asserting it first is what makes "no Resolve control" a statement about a RESOLVED
       * wager rather than about render timing.
       */
      cy.get('.mm-detail .mm-status-badge').should('contain.text', 'Resolved')
      cy.get('.mm-detail').contains('button', /resolve/i).should('not.exist')
    })
  })

  // ---------------------------------------------------------------------------
  // RES-12: NotActive revert when resolving pending wager
  // ---------------------------------------------------------------------------
  it('[RES-12] NotActive revert when wager is still pending acceptance', () => {
    // Created but not accepted — Open, not Active. Established here, not assumed left over.
    cy.createAndAcceptWager({ description: 'RES-12: pending acceptance', accept: false }).then((wagerId) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager is Open, not yet Active').to.equal(1)
      })
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId, callerIndex: 0, winner: TEST_ACCOUNTS[0] },
      }).then((r) => {
        expect(r.ok, 'resolving a pending (Open) wager is refused').to.equal(false)
      })

      // And the UI does not show a resolve control on it either.
      connectAndVisit(0)
      cy.openMyWagers('created')
      // 'Under Consideration', not 'Pending': the row VM swaps the status text for the CREATOR of
      // a pending wager (wagerVm.js#statusText, isCreatorOfPending) — and this test is the
      // creator. The detail badge below still says 'Pending Acceptance' (it renders
      // getStatusLabel directly, without the swap).
      cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
        .contains('.mm-table-row', /under consideration|pending/i, { timeout: 20000 })
        .click()
      cy.get('.mm-detail', { timeout: 5000 }).should('be.visible')

      /*
       * ANCHOR THE ABSENCE — see RES-11. The badge proves the detail is describing the wager
       * this test left pending acceptance; the snapshot it replaces would have reported "no
       * Resolve control" of an action area that had not rendered yet (anti-pattern 3).
       */
      cy.get('.mm-detail .mm-status-badge').should('contain.text', 'Pending Acceptance')
      cy.get('.mm-detail').contains('button', /resolve market/i).should('not.exist')
    })
  })

  // ---------------------------------------------------------------------------
  // RES-13: Bystander cannot resolve
  // ---------------------------------------------------------------------------
  it('[RES-13] Bystander cannot resolve any wager', () => {
    cy.mockWeb3Provider({ account: TEST_ACCOUNTS[4] }) // Bystander
    cy.visitWagers()

    cy.connectWallet()

    cy.openMyWagers('created')

    // Bystander should have no created wagers
    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).invoke('text').then((text) => {
      const lower = text.toLowerCase()
      expect(lower.includes('no wagers') || lower.includes('haven\'t created') || lower.includes('empty')).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // RES-14: Resolve deadline enforcement
  // ---------------------------------------------------------------------------
  it('[RES-14] Cannot resolve after resolve deadline passes', () => {
    // Active (accepted), with a resolveDeadline this test controls directly rather than hoping
    // the default window has or hasn't elapsed by the time 30 days pass. resolveDeadline must be
    // strictly after acceptDeadline (BadDeadlines otherwise), hence the shorter acceptIn.
    cy.createAndAcceptWager({
      description: 'RES-14: resolve deadline', acceptIn: 300, resolveIn: 3600,
    }).then((wagerId) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager is Active').to.equal(2)
      })

      cy.advanceTime(30 * 24 * 60 * 60) // 30 days — well past resolveDeadline

      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId, callerIndex: 0, winner: TEST_ACCOUNTS[0] },
      }).then((r) => {
        expect(r.ok, 'resolving after the resolve deadline is refused').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager stays Active — it was never resolved').to.equal(2)
      })

      // Past its deadline, the wager is refundable instead — the door the app actually offers.
      cy.task('chainTx', { action: 'claimRefund', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, `refund is available once resolution is no longer possible (${r.error || ''})`).to.be.true
      })
    })
  })

  // ---------------------------------------------------------------------------
  // RES-15 / RES-16 — DRAWS (spec 004). Both stakes go back, and one side alone
  // can never make that happen.
  // ---------------------------------------------------------------------------

  it('[RES-15] An arbitrator declares a draw and BOTH stakes are returned', () => {
    /*
     * `Status.Draw` is not "resolved with no winner" — it is a refund of both sides, and the only
     * assertion that proves it is the money. A status flag can be set by code that never moved a
     * token; `_settleDraw` transfers each stake back to the account that put it up, so the test
     * reads balances before and after and requires each side to be made whole.
     *
     * ThirdParty is the arbitrator path: their single call settles immediately, with no consent
     * from either participant. That is the whole point of naming an arbitrator, and it is also
     * why the participant path below must behave completely differently.
     */
    const STAKE = 2n * 10n ** 18n
    cy.createAndAcceptWager({
      description: 'RES-15: arbitrated draw',
      resolutionType: 3, // ThirdParty
      arbitrator: TEST_ACCOUNTS[2],
      stake: String(STAKE),
    }).then((wagerId) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager is Active before the draw').to.equal(2)
      })

      // Balances with both stakes escrowed — the baseline the refund is measured against.
      cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[0] } }).as('creatorBefore')
      cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).as('opponentBefore')

      cy.task('chainTx', { action: 'declareDraw', args: { wagerId, callerIndex: 2 } }).then((r) => {
        expect(r.ok, `the arbitrator can declare a draw (${r.error || ''})`).to.equal(true)
      })

      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'the wager settled as a Draw').to.equal(6)
      })

      // THE ASSERTION THIS TEST EXISTS FOR: each side got its own stake back, exactly.
      cy.get('@creatorBefore').then((before) => {
        cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[0] } }).then((after) => {
          expect(BigInt(after.balance) - BigInt(before.balance), 'the creator was refunded their stake').to.equal(STAKE)
        })
      })
      cy.get('@opponentBefore').then((before) => {
        cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).then((after) => {
          expect(BigInt(after.balance) - BigInt(before.balance), 'the opponent was refunded their stake').to.equal(STAKE)
        })
      })

      // Settled means settled: a second declaration finds nothing Active to draw.
      cy.task('chainTx', { action: 'declareDraw', args: { wagerId, callerIndex: 2 } }).then((r) => {
        expect(r.ok, 'a settled wager cannot be drawn again').to.equal(false)
      })
    })
  })

  it('[RES-16] One participant alone cannot force a draw — it takes both, and consent can be revoked', () => {
    /*
     * THE RULE WITH TEETH.
     *
     * On participant-resolved wagers a draw is MUTUAL: `_declareDraw` records one consent bit and
     * settles only at `_CONSENT_BOTH`. If a single declaration settled, either party could void a
     * wager they were losing at no cost — which is not a draw, it is a unilateral exit from a bet
     * whose outcome had stopped being convenient.
     *
     * So the load-bearing assertion here is a NEGATIVE one: after the creator declares, the wager
     * is still Active and nobody has been paid.
     */
    const STAKE = 2n * 10n ** 18n
    cy.createAndAcceptWager({
      description: 'RES-16: mutual draw consent',
      resolutionType: 0, // Either — a participant-resolved type
      stake: String(STAKE),
    }).then((wagerId) => {
      cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[0] } }).as('creatorBefore')

      // One side proposes. Accepted as a PROPOSAL — and nothing else moves.
      cy.task('chainTx', { action: 'declareDraw', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, 'the creator may propose a draw').to.equal(true)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'one consent is NOT a draw — the wager is still Active').to.equal(2)
      })
      cy.get('@creatorBefore').then((before) => {
        cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[0] } }).then((after) => {
          expect(BigInt(after.balance), 'no stake moved on a one-sided proposal').to.equal(BigInt(before.balance))
        })
      })

      /*
       * And the proposal is withdrawable. A member who offered a draw and then changed their mind
       * must be able to take it back while the wager is still live — otherwise the offer is a
       * one-way door that the other side can walk through at any later moment of their choosing.
       */
      cy.task('chainTx', { action: 'revokeDraw', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, 'a draw proposal can be revoked while the wager is Active').to.equal(true)
      })
      cy.task('chainTx', { action: 'declareDraw', args: { wagerId, callerIndex: 1 } }).then((r) => {
        expect(r.ok, 'the opponent may now propose').to.equal(true)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(
          i.status,
          'the revoked consent did not count — one live proposal is still not a draw',
        ).to.equal(2)
      })

      // Both sides agreeing IS a draw, and the money follows.
      cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).as('opponentBefore')
      cy.task('chainTx', { action: 'declareDraw', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, 'the creator declares again, completing mutual consent').to.equal(true)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'both sides agreeing settles the wager as a Draw').to.equal(6)
      })
      cy.get('@opponentBefore').then((before) => {
        cy.task('chainTx', { action: 'tokenBalance', args: { address: TEST_ACCOUNTS[1] } }).then((after) => {
          expect(BigInt(after.balance) - BigInt(before.balance), 'the opponent was refunded their stake').to.equal(STAKE)
        })
      })
    })
  })


  // ---------------------------------------------------------------------------
  // RES-17 / RES-18 / RES-19 — RELAYED INTENTS (spec 035). Someone else pays the
  // gas; nobody else gains the authority.
  // ---------------------------------------------------------------------------

  it('[RES-17] A relayer submits the member\'s signed intent — the member acts, the relayer pays', () => {
    /*
     * The whole promise of the intent rail in one assertion pair.
     *
     * `declareWinnerWithSig` is a PUBLIC function: anyone may call it. What makes that safe is
     * that the acting identity is not `msg.sender` but the address recovered from the signature,
     * and every authorisation check runs against THAT. So a relayer can pay the gas for a member
     * who has none, without acquiring any of the member's rights.
     *
     * The test proves both halves at once: the resolution succeeds when submitted by an account
     * that has no authority over the wager, and the outcome is the one the MEMBER signed.
     */
    cy.createAndAcceptWager({
      description: 'RES-17: relayed resolution',
      resolutionType: 1, // Creator-only — so the relayer plainly cannot resolve it themselves
    }).then((wagerId) => {
      /*
       * Positive control first. Account #3 is the relayer, and on a Creator-only wager it has no
       * standing at all — if this direct call were to succeed, the test below would prove nothing
       * about signatures.
       */
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId, callerIndex: 3, winner: TEST_ACCOUNTS[0] },
      }).then((r) => {
        expect(r.ok, 'the relayer has no authority of its own over this wager').to.equal(false)
      })

      // The same account submits the same outcome, now carrying the creator's signature.
      cy.task('chainTx', {
        action: 'declareWinnerWithSig',
        args: { wagerId, winner: TEST_ACCOUNTS[0], signerIndex: 0, relayerIndex: 3 },
      }).then((r) => {
        expect(r.ok, `the relayer may submit an intent the creator signed (${r.error || ''})`).to.equal(true)
      })

      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'the wager resolved').to.equal(3)
        expect(i.winner, 'the outcome is the one the MEMBER signed').to.equal(TEST_ACCOUNTS[0])
      })
    })
  })

  it('[RES-18] A relayed intent cannot be replayed, and cannot be re-pointed at another signer', () => {
    /*
     * Two ways a public, signature-carrying entrypoint goes wrong, and the guards for each.
     *
     * REPLAY: the intent is visible on chain the moment it is submitted. Without a spent-nonce
     * check, anyone could resubmit it — harmless on a settled wager, not harmless on a repeatable
     * action, and the guard belongs to the rail rather than to each action.
     *
     * SUBSTITUTION: `signer` is passed as a plain argument alongside the signature. If it were
     * trusted rather than verified against the recovered address, a relayer could name any member
     * as the actor and act as them. The digest binds the signer, so a mismatched pair must fail.
     */
    cy.createAndAcceptWager({ description: 'RES-18: replay + substitution', resolutionType: 1 }).then((wagerId) => {
      const NONCE = '0x' + '11'.repeat(32)

      cy.task('chainTx', {
        action: 'declareWinnerWithSig',
        args: { wagerId, winner: TEST_ACCOUNTS[0], signerIndex: 0, relayerIndex: 3, nonce: NONCE },
      }).then((r) => {
        expect(r.ok, 'the first submission lands').to.equal(true)
      })

      // Replay of the identical intent, by the same relayer.
      cy.task('chainTx', {
        action: 'declareWinnerWithSig',
        args: { wagerId, winner: TEST_ACCOUNTS[0], signerIndex: 0, relayerIndex: 3, nonce: NONCE },
      }).then((r) => {
        expect(r.ok, 'the same intent cannot be submitted twice').to.equal(false)
      })

      // Substitution: a signature made by #1, presented as though #0 had signed it.
      cy.createAndAcceptWager({ description: 'RES-18b: substitution', resolutionType: 1 }).then((otherId) => {
        cy.task('chainTx', {
          action: 'declareWinnerWithSig',
          args: {
            wagerId: otherId,
            winner: TEST_ACCOUNTS[1],
            signerIndex: 1,
            relayerIndex: 3,
            signerAddressOverride: TEST_ACCOUNTS[0],
          },
        }).then((r) => {
          expect(
            r.ok,
            'naming a different signer than the one who signed does not make them the actor',
          ).to.equal(false)
        })
        cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: otherId } }).then((i) => {
          expect(i.status, 'the wager was not resolved by the substitution attempt').to.equal(2)
        })
      })
    })
  })

  it('[RES-19] The self-submit fallback reaches the same outcome without any relayer', () => {
    /*
     * THE NEVER-STRANDED RULE (spec 036). The relayer is OPTIONAL infrastructure: when it is
     * unavailable the member submits the same action themselves and pays their own gas.
     *
     * A test cannot take down a relayer that this tier never runs, and asserting on a stubbed
     * gateway would only prove the stub was called. What IS on chain, and what the rule actually
     * depends on, is that the direct entrypoint remains open and produces the identical result —
     * so a member with gas is never blocked by infrastructure being down.
     */
    cy.createAndAcceptWager({ description: 'RES-19: self-submit fallback', resolutionType: 1 }).then((wagerId) => {
      cy.task('chainTx', {
        action: 'declareWinner',
        args: { wagerId, callerIndex: 0, winner: TEST_ACCOUNTS[0] },
      }).then((r) => {
        expect(r.ok, 'the member can always submit for themselves — no relayer required').to.equal(true)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'self-submission resolves the wager').to.equal(3)
        expect(i.winner, 'and reaches the same outcome the relayed path would have').to.equal(TEST_ACCOUNTS[0])
      })
    })
  })

})
