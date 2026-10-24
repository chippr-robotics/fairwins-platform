/**
 * E2E Tests: Claim Payouts (Full-tier)
 *
 * Requires a running Hardhat node with deployed contracts (chain 1337).
 * Tests payout claiming after wager resolution, including happy-path
 * token claims and error cases (not winner, double claim, etc.).
 *
 * Checklist: CLM-01..CLM-10
 *
 * Every test here establishes its own precondition (create → accept → resolve,
 * or the specific chain state the test is named for) and judges the outcome by
 * chain state — a wager's `status`/`paid`/`winner` fields and the winner's token
 * balance — never by wording in the detail panel. See docs/developer-guide/
 * e2e-testing-policy.md, anti-pattern 7 (#1231).
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
 * Create, accept, advance time, and resolve a wager THROUGH THE UI.
 * After this, the winner can claim the payout. Reserved for CLM-01/CLM-10,
 * which exist to prove the real member-facing claim path works — every other
 * CLM test drives the same on-chain facts directly (chainTx), which is faster
 * and does not depend on DOM timing to prove a contract-level guarantee.
 */
function createAcceptAndResolve(config = {}) {
  const defaults = {
    description: 'Claim test wager',
    opponent: TEST_ACCOUNTS[1],
    stake: 5,
    resolutionType: 0,
    winnerIsCreator: true,
  }
  const opts = { ...defaults, ...config }

  // Step 1: Create wager as account #0
  connectAndVisit(0)

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

  if (opts.stakeToken) {
    cy.get('#fm-stake-token, [role="dialog"] .fm-token-select')
      .first()
      .select(opts.stakeToken)
  }

  if (opts.resolutionType !== undefined) {
    cy.selectResolutionType(opts.resolutionType.toString())
  }

  // Encryption is ON by default and is no longer optional — the opt-out checkbox was removed
  // from FriendMarketsModal several sprints ago (grep `checkbox` there returns nothing). The
  // block that used to uncheck it was a no-op guarded by `if (length > 0)`, so it silently did
  // nothing while the spec read as though it controlled encryption. (#1028)

  cy.get('.fm-btn-primary', { timeout: 10000 }).should('not.be.disabled').click()

  cy.contains('Wager Created', { timeout: 60000 }).should('exist')

  cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
    .click({ force: true })

  // Step 2: Accept as opponent
  cy.switchAccount(1)

  cy.openMyWagers('participating')
  /*
   * Same acceptance shape 05 and 07 arrived at, for the same three reasons:
   *
   * - WAIT for the accept control rather than snapshotting with $panel.find(): the row renders
   *   before its action column does, so a one-shot read sees no button and the `if` silently
   *   skipped the entire acceptance — leaving CLM-01 to fail later on a wager nobody accepted.
   * - The wagers are PRIVATE (encryption is mandatory), so the modal gates the terms, and the
   *   Accept control, behind "Decrypt Wager Details" until a signature lands.
   * - SCOPE to the dialog: unscoped, /accept/i matches Dashboard's Scan QR card behind the
   *   modal ("Accept a wager from a friend"), which is visible and un-clickable.
   */
  cy.contains('.mm-panel button, [role="tabpanel"] button', /view offer/i, { timeout: 20000 })
    .click({ force: true })
  cy.acceptOfferInModal()

  // Success is the wager reaching Active on chain, not a word in the dialog.
  cy.lastWagerId().then((id) => cy.waitForWagerActive(id))
  cy.dismissAcceptanceModal()
  cy.get('.mm-close-btn, button[aria-label="Close modal"]').first().click({ force: true })

  // Step 3: Advance time past end date
  cy.advanceTime(25 * 60 * 60)

  // Step 4: Resolve as creator
  cy.switchAccount(0)

  cy.openMyWagers('created')

  /*
   * WAIT FOR THE RESOLVE CONTROL ITSELF — do not snapshot the list and branch on what it holds.
   *
   * What this replaces was a `$panel.find(...)` one-shot DOM snapshot (anti-pattern 3 in
   * docs/developer-guide/e2e-testing-policy.md) wrapped around three nested `if`s. Taken before
   * the async-gated action column rendered it found neither a Resolve button nor a row, so every
   * branch no-oped silently (anti-pattern 6), NOTHING WAS CLICKED, and the helper walked on to
   * `cy.resolveWagerInModal` — which then spent its 15s waiting for a sub-modal that nothing had
   * opened and failed there, three commands downstream of the cause (#1327 lead 2). That is the
   * CLM-01/CLM-10 flake: the same commit passed one run and failed the next purely on whether
   * the list had rendered in time.
   *
   * One retryable assertion on the control replaces all of it, and it is the SAME shape spec 07's
   * `openResolutionFor()` already uses against this list. The window is generous because the scan
   * here is cold: `clearLocalStorage` in `beforeEach` and `switchAccount` both drop the
   * `friendMarkets:<chainId>` cache, so the rows come from a fresh chain scan.
   *
   * Note `.mm-action-resolve` is gone with it: no component has ever rendered that class. The
   * row's control is `.wc-action` labelled "Resolve"; the detail view's is "Resolve Market".
   */
  cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).should('exist')
  /*
   * scrollIntoView BEFORE the visibility assertion: the resolve control can sit below the
   * modal's scrolled fold, and Cypress reports a fixed-position element whose centre is
   * outside `.mm-content`'s viewport as "covered" — a state the member fixes by scrolling,
   * so the test does the same rather than failing on it (the CLM-01/CLM-10 red on this PR).
   * The pattern also matches "Resolve Market" — the label the detail view and the row's
   * countdown control actually render (ResolveButtonWithCountdown); "resolve wager" is not a
   * string any component produces.
   */
  cy.contains('.mm-panel button, [role="tabpanel"] button', /^resolve$|resolve (wager|market)/i, { timeout: 30000 })
    .scrollIntoView()
    .should('be.visible')
    .and('not.be.disabled')
    .click({ force: true })

  /*
   * ANCHOR THE SUB-MODAL ON THE CLICK THAT OPENS IT (#1327 lead 2). `resolveWagerInModal` waits
   * for `.mm-sub-modal` too, but it waits INSIDE a custom command, so the 15s and the failure
   * were both attributed to the resolution flow — "the resolve sub-modal never appeared" — when
   * the fact worth reporting is that the trigger before it did nothing. Assert it at the call
   * site and the failure sits next to the click that was supposed to cause it.
   */
  cy.get('.mm-sub-modal', { timeout: 15000 }).should('be.visible')

  // Select outcome based on who should win
  /*
   * The sub-modal labels outcomes by PARTY — "Creator wins — <name>", "Opponent wins — <name>"
   * (MyMarketsModal's outcomeLabels/labelFor) — not Pass/Fail, so the old strings matched
   * nothing. Match a pattern: each label carries a name or shortened address after the title.
   */
  cy.resolveWagerInModal(opts.winnerIsCreator ? /creator wins/i : /opponent wins/i)
  cy.lastWagerId().then((id) => cy.waitForWagerResolved(id))
}

/**
 * Create, accept and resolve a wager ENTIRELY ON CHAIN (chainTx), skipping the UI. Reliable and
 * fast — the contract-level guarantees these tests exist to check (who can claim, whether a
 * second claim is refused, whether time bars a claim) do not depend on the create wizard's DOM,
 * and CLM-01/CLM-10 already prove the UI leg works. Returns the wagerId.
 *
 * cfg: everything `cy.createAndAcceptWager` takes, plus `winner` (address, defaults to the
 * creator) and `resolverIndex` (account index calling declareWinner, defaults to 0 — the creator).
 */
function resolvedWager(cfg = {}) {
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

describe('Claim Payouts', () => {
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
     * STUB THE PINNING SERVICE — see frontend/package.json `dev:e2e`. Same misclassification
     * as 07: the interceptIpfs sweep grepped for the shared create helpers and this file's
     * local createAcceptAndResolve matched nothing — but it opens the create modal, and its
     * mandatory metadata upload died unstubbed (CLM-01's "Wager Created" timeout).
     */
    cy.interceptIpfs()
  })

  // ---------------------------------------------------------------------------
  // CLM-01: Claim USDC payout (winner = creator) — driven through the UI, the
  // only test in this file that is. Proven by the winner's on-chain token
  // balance moving, not by a word the detail panel happens to render.
  // ---------------------------------------------------------------------------
  it('[CLM-01] Claim USDC payout after resolution', () => {
    createAcceptAndResolve({
      description: 'CLM-01: USDC claim test',
      stake: 5,
      winnerIsCreator: true,
    })

    const winner = TEST_ACCOUNTS[0]

    cy.lastWagerId().then((wagerId) => {
      cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((before) => {
        connectAndVisit(0)
        cy.openMyWagers('history')

        cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
          .find('.mm-table-row', { timeout: 20000 })
          .should('have.length.greaterThan', 0)

        cy.get('.mm-panel, [role="tabpanel"]').find('.mm-table-row').first().click()
        cy.get('.mm-detail', { timeout: 5000 }).should('be.visible')
        cy.get('.mm-detail').contains('button', /claim winnings/i, { timeout: 10000 })
          .click({ force: true })

        // The claim's outcome is the wager flipping to `paid` on chain and the winner's token
        // balance moving — not a word in the detail panel, which can render before the
        // transaction lands, or repeat wording that was already on screen for another reason.
        cy.waitForWagerPaid(wagerId)
        cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((after) => {
          expect(
            BigInt(after.balance) > BigInt(before.balance),
            'winner balance increased by the payout'
          ).to.be.true
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-02: Claim payout when the OPPONENT wins.
  //
  // The original name here was "Claim MATIC payout" — an alternate-stake-token
  // scenario the local e2e deployment has never had a second token to exercise.
  // What is worth proving that CLM-01 doesn't: the payout credits whoever the
  // contract names as winner, not always the creator, and it credits ONLY them.
  // ---------------------------------------------------------------------------
  it('[CLM-02] Claim payout when the opponent is the declared winner', () => {
    const winner = TEST_ACCOUNTS[1]
    const loser = TEST_ACCOUNTS[0]

    resolvedWager({ stake: 5, winner, resolverIndex: 1 }).then((wagerId) => {
      cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((winnerBefore) => {
        cy.task('chainTx', { action: 'tokenBalance', args: { address: loser } }).then((loserBefore) => {
          cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 1 } }).then((r) => {
            expect(r.ok, `opponent claims their win (${r.error || ''})`).to.be.true
          })
          cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((winnerAfter) => {
            expect(
              BigInt(winnerAfter.balance) > BigInt(winnerBefore.balance),
              'the opponent, as winner, was credited'
            ).to.be.true
          })
          cy.task('chainTx', { action: 'tokenBalance', args: { address: loser } }).then((loserAfter) => {
            expect(
              loserAfter.balance,
              'the creator, as loser, was NOT credited'
            ).to.equal(loserBefore.balance)
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-03: Verify payout amount matches total stakes EXACTLY.
  // ---------------------------------------------------------------------------
  it('[CLM-03] Verify payout amount matches total stakes', () => {
    const winner = TEST_ACCOUNTS[0]
    const stake = (10n ** 18n) * 7n

    resolvedWager({ stake: stake.toString(), winner }).then((wagerId) => {
      cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((before) => {
        cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
          expect(r.ok, `claim succeeds (${r.error || ''})`).to.be.true
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((after) => {
          const delta = BigInt(after.balance) - BigInt(before.balance)
          // Equal-stake Either-party wager: payout is creatorStake + opponentStake, i.e. 2x stake.
          expect(delta, 'payout is exactly the combined stakes').to.equal(stake * 2n)
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-04: Claim offer wager payout with ASYMMETRIC stakes.
  //
  // Either-party resolution requires equal stakes on chain (EitherRequiresEqualStakes) — an
  // asymmetric "offer" wager needs a resolutionType with a named resolver, so this uses
  // Creator-only (1) and the creator declares the winner.
  // ---------------------------------------------------------------------------
  it('[CLM-04] Claim offer payout with asymmetric stakes', () => {
    const winner = TEST_ACCOUNTS[0]
    const creatorStake = (10n ** 18n) * 3n
    const opponentStake = (10n ** 18n) * 9n

    resolvedWager({
      creatorStake: creatorStake.toString(),
      opponentStake: opponentStake.toString(),
      resolutionType: 1, // Creator Only
      winner,
      resolverIndex: 0,
    }).then((wagerId) => {
      cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((before) => {
        cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
          expect(r.ok, `claim succeeds (${r.error || ''})`).to.be.true
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((after) => {
          const delta = BigInt(after.balance) - BigInt(before.balance)
          expect(delta, 'asymmetric payout is exactly creatorStake + opponentStake')
            .to.equal(creatorStake + opponentStake)
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-05: Claim well within a normal timeframe still succeeds.
  // ---------------------------------------------------------------------------
  it('[CLM-05] Claim succeeds when made shortly after resolution', () => {
    const winner = TEST_ACCOUNTS[0]

    resolvedWager({ stake: 5, winner }).then((wagerId) => {
      cy.advanceTime(2 * 24 * 60 * 60) // a couple of days, unremarkable
      cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((before) => {
        cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
          expect(r.ok, `claim succeeds (${r.error || ''})`).to.be.true
        })
        cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
          expect(i.paid, 'wager is marked paid').to.equal(true)
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((after) => {
          expect(BigInt(after.balance) > BigInt(before.balance), 'balance increased').to.be.true
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-06: Non-winner cannot claim.
  // ---------------------------------------------------------------------------
  it('[CLM-06] Non-winner (loser) cannot claim payout', () => {
    const winner = TEST_ACCOUNTS[0]
    const loser = TEST_ACCOUNTS[1]

    resolvedWager({ stake: 5, winner }).then((wagerId) => {
      cy.task('chainTx', { action: 'tokenBalance', args: { address: loser } }).then((before) => {
        // The loser calling claimPayout on the WINNER's behalf — the contract checks
        // msg.sender against the winner, so this must revert NotWinner.
        cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 1 } }).then((r) => {
          expect(r.ok, 'the loser is refused the payout').to.equal(false)
        })
        cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
          expect(i.paid, 'the wager stays unpaid').to.equal(false)
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: loser } }).then((after) => {
          expect(after.balance, "the loser's balance is unchanged").to.equal(before.balance)
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-07: Double claim prevented (already claimed).
  // ---------------------------------------------------------------------------
  it('[CLM-07] Double claim prevented (already claimed)', () => {
    const winner = TEST_ACCOUNTS[0]

    resolvedWager({ stake: 5, winner }).then((wagerId) => {
      cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, `first claim succeeds (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((afterFirst) => {
        // Second claim must be refused (AlreadyPaid) and must NOT move the balance again.
        cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
          expect(r.ok, 'second claim is refused').to.equal(false)
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((afterSecond) => {
          expect(afterSecond.balance, 'balance did not move a second time').to.equal(afterFirst.balance)
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-08: Cannot claim before wager is resolved.
  // ---------------------------------------------------------------------------
  it('[CLM-08] Cannot claim before wager is resolved', () => {
    // Active (accepted) but not yet resolved — no declareWinner call.
    cy.createAndAcceptWager({ stake: 5 }).then((wagerId) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager is Active, not Resolved').to.equal(2)
      })
      cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, 'claim is refused before resolution').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.paid, 'nothing was paid').to.equal(false)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-09: Claim succeeds even long after resolution — the registry has NO
  // claim-window expiry (WagerRegistryCore._claimPayout gates only on
  // Resolved status, caller==winner, and !paid). Proves the real behavior
  // instead of the "90-day window" the original test guessed at and never
  // found evidence for.
  // ---------------------------------------------------------------------------
  it('[CLM-09] Claim succeeds long after resolution — the registry has no claim-window expiry', () => {
    const winner = TEST_ACCOUNTS[0]

    resolvedWager({ stake: 5, winner }).then((wagerId) => {
      cy.advanceTime(200 * 24 * 60 * 60) // 200 days — far past any plausible "claim window"
      cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((before) => {
        cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
          expect(r.ok, `claim still succeeds 200 days later (${r.error || ''})`).to.be.true
        })
        cy.task('chainTx', { action: 'tokenBalance', args: { address: winner } }).then((after) => {
          expect(BigInt(after.balance) > BigInt(before.balance), 'balance increased').to.be.true
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CLM-10: Frozen winner cannot claim
  // ---------------------------------------------------------------------------
  it('[CLM-10] a frozen winner cannot claim, and can once unfrozen', () => {
    /*
     * This test never froze anything.
     *
     * It opened History, clicked whatever row happened to be first, and accepted any of
     * frozen | claimed | success | error | payout in the detail text — five words common enough
     * that it passed on almost any state, including states with nothing to do with freezing. It
     * finally failed on CI when the panel happened to contain none of them, which is the only
     * reason anyone looked at it. Two `expect(true).to.be.true` fall-throughs meant a missing row
     * or a missing button passed as well.
     *
     * The rule it is named for is worth having: a frozen account cannot take money out, and the
     * freeze is reversible. Drive it on chain, where the answer is a fact — `paid` on the wager —
     * rather than a word in a panel.
     */
    const winner = TEST_ACCOUNTS[0]

    createAcceptAndResolve({ description: 'CLM-10: frozen winner', winnerIsCreator: true })

    cy.lastWagerId().then((wagerId) => {
      cy.task('chainTx', { action: 'freeze', args: { address: winner } }).then((r) => {
        expect(r.ok, `freeze the winner (${r.error || ''})`).to.be.true
      })

      // Blocked while frozen — and the wager stays unpaid, which is the part that matters.
      cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, 'a frozen winner is refused the payout').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.paid, 'nothing was paid out while frozen').to.equal(false)
      })

      // Reversible: unfreezing restores the claim.
      cy.task('chainTx', { action: 'unfreeze', args: { address: winner } }).then((r) => {
        expect(r.ok, `unfreeze the winner (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'claimPayout', args: { wagerId, callerIndex: 0 } }).then((r) => {
        expect(r.ok, `claim after unfreeze (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.paid, 'paid once the freeze is lifted').to.equal(true)
      })
    })
  })
})
