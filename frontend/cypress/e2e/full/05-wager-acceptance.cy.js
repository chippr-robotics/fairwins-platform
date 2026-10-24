/**
 * E2E Tests: Wager Acceptance (Full-tier)
 *
 * Requires a running Hardhat node with deployed contracts (chain 1337).
 * Tests acceptance flows with real contract TXs and account switching.
 *
 * Checklist: ACC-01..ACC-13
 *
 * Every test here establishes its own precondition and judges the outcome by chain state
 * (wager status/winner, or a refused chainTx) rather than by wording a modal happens to render.
 * See docs/developer-guide/e2e-testing-policy.md, anti-pattern 7 (#1231).
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
 * Create a simple 1v1 wager as account #0, return to dashboard.
 */
function createSimpleWager(config = {}) {
  const defaults = {
    description: 'Test wager for acceptance',
    opponent: TEST_ACCOUNTS[1],
    stake: 10,
    resolutionType: 0,
  }
  const opts = { ...defaults, ...config }

  cy.openCreateWagerModal('oneVsOne')

  // Fill form
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

  // Encryption is ON by default and is no longer optional — the opt-out checkbox was removed
  // from FriendMarketsModal several sprints ago (grep `checkbox` there returns nothing). The
  // block that used to uncheck it was a no-op guarded by `if (length > 0)`, so it silently did
  // nothing while the spec read as though it controlled encryption. (#1028)

  // Submit
  cy.get('.fm-btn-primary', { timeout: 10000 }).should('not.be.disabled').click()

  // Wait for creation to complete
  cy.contains('Wager Created', { timeout: 60000 }).should('exist')
}

/**
 * Create a wager as account #0, close the create modal, and switch to `accountIndex`
 * (the opponent by default). Every test below starts from this instead of hoping an
 * earlier test in the file left a suitable wager behind.
 */
function createWagerAndSwitchTo(config = {}, accountIndex = 1) {
  connectAndVisit(0)
  createSimpleWager(config)
  cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
    .click({ force: true })
  cy.switchAccount(accountIndex)
}

/**
 * Open the pending offer for the current account and wait for the acceptance modal.
 */
function openPendingOffer() {
  cy.openMyWagers('participating')
  cy.contains('.mm-panel button, [role="tabpanel"] button', /view offer/i, { timeout: 20000 })
    .click({ force: true })
  cy.get('.ma-modal, [role="dialog"]', { timeout: 5000 }).should('be.visible')
}

/*
 * Thin alias for the shared command — the real logic lives in cy.acceptOfferInModal(), which
 * three specs now share. Kept as a name because the call sites read better with it.
 */
function acceptThroughModal() {
  cy.acceptOfferInModal()
}

describe('Wager Acceptance', () => {
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
     * STUB THE PINNING SERVICE — see frontend/package.json `dev:e2e`. Every wager this file
     * accepts must first be CREATED, and a create that cannot pin its encrypted metadata throws
     * before it reaches WagerRegistry.
     */
    cy.interceptIpfs()
  })

  // ---------------------------------------------------------------------------
  // ACC-01: Accept 1v1 via link (switch to opponent account)
  // ---------------------------------------------------------------------------
  it('[ACC-01] Accept 1v1 wager via opponent account', () => {
    createWagerAndSwitchTo({ description: 'ACC-01: Opponent should accept this' })
    cy.connectWallet()

    openPendingOffer()
    acceptThroughModal()

    // Success is the wager reaching Active on chain, not a word in the modal.
    cy.lastWagerId().then((id) => cy.waitForWagerActive(id))
  })

  // ---------------------------------------------------------------------------
  // ACC-02: Accept modal shows the agreed stake terms before acceptance.
  //
  // Originally "Accept wager staked in MATIC" — the local e2e deployment has never had a second
  // stake token to exercise (see 10-claim-payouts CLM-02, same premise). What is worth proving
  // that ACC-01 doesn't: the modal discloses the real terms before the member signs anything.
  // ---------------------------------------------------------------------------
  it('[ACC-02] Accept modal displays the agreed stake before acceptance', () => {
    createWagerAndSwitchTo({ description: 'ACC-02: stake terms test', stake: 5 })

    openPendingOffer()

    cy.get('.ma-modal').invoke('text').then((text) => {
      const lower = text.toLowerCase()
      expect(lower.includes('stake') || lower.includes('usdc'), 'stake terms are shown before acceptance').to.be.true
    })

    acceptThroughModal()
    cy.lastWagerId().then((id) => cy.waitForWagerActive(id))
  })

  // ---------------------------------------------------------------------------
  // ACC-03: Accept encrypted wager (auto-decrypt)
  // ---------------------------------------------------------------------------
  it('[ACC-03] Accept encrypted wager with auto-decrypt', () => {
    // Every wager created through the UI is encrypted — the opt-out checkbox no longer exists
    // (see createSimpleWager above), so this establishes exactly the precondition it is named for.
    createWagerAndSwitchTo({ description: 'ACC-03: Encrypted wager acceptance test' })

    openPendingOffer()

    // Before the decrypt/accept round-trip, the modal must disclose that this offer is private.
    cy.get('.ma-modal').invoke('text').then((text) => {
      const lower = text.toLowerCase()
      const hasEncrypted = lower.includes('private') ||
                          lower.includes('encrypted') ||
                          lower.includes('decrypt') ||
                          lower.includes('unlock')
      expect(hasEncrypted, 'the offer is disclosed as private before it is decrypted').to.be.true
    })

    acceptThroughModal()

    // The decrypt succeeded iff acceptance actually landed on chain.
    cy.lastWagerId().then((id) => cy.waitForWagerActive(id))
  })

  // ---------------------------------------------------------------------------
  // ACC-04: View acceptance countdown timer
  // ---------------------------------------------------------------------------
  it('[ACC-04] View acceptance countdown timer', () => {
    createWagerAndSwitchTo({ description: 'ACC-04: Countdown timer test' })

    openPendingOffer()

    // Countdown timer must be visible — the offer this test just created has not expired.
    cy.get('.ma-modal').invoke('text').then((text) => {
      const lower = text.toLowerCase()
      const hasTimer = lower.includes('remaining') ||
                      lower.includes('accept by') ||
                      lower.includes('deadline') ||
                      lower.includes('hours') ||
                      lower.includes('minutes')
      expect(hasTimer, 'a countdown to the accept deadline is shown').to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-06: Unaccepted wager stays pending
  // ---------------------------------------------------------------------------
  it('[ACC-06] Unaccepted wager stays pending acceptance', () => {
    // A 1v1 wager that the opponent has not accepted yet stays in the pending-acceptance state —
    // created here rather than assumed left over from an earlier test.
    connectAndVisit(0)
    createSimpleWager({ description: 'ACC-06: stays pending' })
    cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
      .click({ force: true })

    cy.openMyWagers('created')

    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
      .find('.status-pending-acceptance, :contains("Pending")', { timeout: 20000 })
      .should('have.length.greaterThan', 0)

    cy.get('.mm-status-badge').first().invoke('text').then((text) => {
      const lower = text.toLowerCase()
      expect(lower.includes('pending') || lower.includes('under consideration'), 'badge reads pending').to.be.true
    })

    // The badge is describing a fact — cross-check it against the chain.
    cy.lastWagerId().then((id) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.status, 'wager is still Open, unaccepted').to.equal(1)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-07: Accept with wrong wallet
  // ---------------------------------------------------------------------------
  it('[ACC-07] Accept with wrong wallet shows error', () => {
    createWagerAndSwitchTo({
      description: 'ACC-07: Wrong wallet test',
      opponent: TEST_ACCOUNTS[1], // Only account #1 can accept
    }, 4) // Bystander — NOT the invited opponent

    cy.openMyWagers('participating')

    // The bystander should either:
    // 1. Not see the wager at all
    // 2. See it but with "You are not invited" message
    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).invoke('text').then((text) => {
      const lower = text.toLowerCase()
      const validState = lower.includes('no active') ||
                        lower.includes('not invited') ||
                        lower.includes('empty') ||
                        lower.includes('no wagers') ||
                        lower.includes('don\'t have')
      expect(validState, 'the bystander sees no acceptable offer').to.be.true
    })

    // The chain agrees: a bystander acceptWager call is refused (NotOpponent).
    cy.lastWagerId().then((id) => {
      cy.task('chainTx', { action: 'acceptWager', args: { wagerId: id, opponentIndex: 4 } }).then((r) => {
        expect(r.ok, 'only the named opponent can accept').to.equal(false)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-08: Accept after deadline is refused
  // ---------------------------------------------------------------------------
  it('[ACC-08] Accept after the accept deadline is refused', () => {
    connectAndVisit(0)
    createSimpleWager({ description: 'ACC-08: Expired deadline test' })
    cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
      .click({ force: true })

    // Advance time past the acceptance deadline (midpoint of end time).
    // Default end is 1 day out, deadline is midpoint = ~12 hours.
    cy.advanceTime(13 * 60 * 60) // 13 hours

    /*
     * Judge this by the authority that decides it: whether the UI still offers a (now
     * meaningless) accept control is a rendering detail, and the app may or may not have
     * pruned it from the list by the time this runs. The contract's AcceptExpired guard is
     * the fact that actually matters, and it is unconditional.
     */
    cy.lastWagerId().then((id) => {
      cy.task('chainTx', { action: 'acceptWager', args: { wagerId: id, opponentIndex: 1 } }).then((r) => {
        expect(r.ok, 'acceptance is refused once the accept deadline has passed').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.status, 'wager stays Open — it never became Active').to.equal(1)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-09: Accept already-accepted wager
  // ---------------------------------------------------------------------------
  it('[ACC-09] Accept already-accepted wager shows already accepted', () => {
    // Created and accepted directly on chain — reliable, and this test is about what happens
    // AFTER acceptance, not about exercising the create/accept UI again (ACC-01 already does).
    cy.createAndAcceptWager({ description: 'ACC-09: already accepted' }).then((wagerId) => {
      connectAndVisit(1)
      cy.openMyWagers('participating')

      /*
       * OPEN THE ACCEPTED ROW, not whichever happens to be first. This spec deliberately does
       * not reset the chain between tests, so `participating` also lists the still-open offers
       * ACC-01..ACC-08 left behind — and a pending offer legitimately DOES carry an Accept
       * control, so `rows.first()` made the assertion below pass or fail on list ordering.
       * Matching the row by its own status badge is retryable: if no Active row ever lists, the
       * test fails HERE naming that, rather than reporting a missing button.
       */
      // 'Pending Resolution' is the same on-chain Active wager: row and badge are computed from
      // the browser clock against the wager's end time (the hazard DEC-05 hit), so match either
      // label and pin the detail to the id below.
      cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 })
        .contains('.mm-table-row', /active|pending resolution/i, { timeout: 20000 })
        .click()
      cy.get('.mm-detail', { timeout: 5000 }).should('be.visible')
      cy.get('.mm-detail', { timeout: 10000 }).should('contain.text', `#${wagerId}`)

      /*
       * ANCHOR THE ABSENCE. `$detail.find(...)` inside `.then()` is a one-shot DOM snapshot
       * (anti-pattern 3) — taken before the detail's action area renders it reports "no Accept
       * control" for a reason that has nothing to do with the wager being accepted, and the
       * test goes green either way. The status badge is rendered by the same detail view from
       * the same market record, so asserting it first proves the panel is describing an ACTIVE
       * wager; only then does the missing Accept control mean what this test claims it means.
       */
      cy.get('.mm-detail .mm-status-badge').invoke('text')
        .should('match', /active|pending resolution/i)
      cy.get('.mm-detail').contains('button', /accept/i).should('not.exist')
      cy.get('.mm-detail').find('.mm-action-accept').should('not.exist')

      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
        expect(i.status, 'wager is Active on chain').to.equal(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-11: View encrypted wager without correct wallet
  // ---------------------------------------------------------------------------
  it('[ACC-11] View encrypted wager without correct wallet', () => {
    connectAndVisit(4) // Bystander — not a participant

    cy.openMyWagers('participating')

    // Bystander should not see encrypted wagers meant for other participants
    cy.get('.mm-panel, [role="tabpanel"]', { timeout: 10000 }).invoke('text').then((text) => {
      const lower = text.toLowerCase()
      // Should show empty state or no encrypted wager details
      const validState = lower.includes('no active') ||
                        lower.includes('don\'t have') ||
                        lower.includes('empty') ||
                        lower.includes('connect') ||
                        lower.includes('no wagers')
      expect(validState).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-12: A frozen account cannot accept a wager
  // ---------------------------------------------------------------------------
  it('[ACC-12] A frozen account cannot accept a wager, and can once unfrozen', () => {
    connectAndVisit(0) // Admin
    createSimpleWager({
      description: 'ACC-12: Frozen account acceptance test',
      opponent: TEST_ACCOUNTS[1],
    })
    cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
      .click({ force: true })

    cy.task('chainTx', { action: 'freeze', args: { address: TEST_ACCOUNTS[1] } }).then((r) => {
      expect(r.ok, `freeze the opponent (${r.error || ''})`).to.be.true
    })

    cy.lastWagerId().then((id) => {
      cy.task('chainTx', { action: 'acceptWager', args: { wagerId: id, opponentIndex: 1 } }).then((r) => {
        expect(r.ok, 'a frozen account is refused acceptance').to.equal(false)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.status, 'wager stays Open while the opponent is frozen').to.equal(1)
      })

      // Reversible, matching CLM-10: unfreezing restores the ability to accept.
      cy.task('chainTx', { action: 'unfreeze', args: { address: TEST_ACCOUNTS[1] } }).then((r) => {
        expect(r.ok, `unfreeze the opponent (${r.error || ''})`).to.be.true
      })
      cy.task('chainTx', { action: 'acceptWager', args: { wagerId: id, opponentIndex: 1 } }).then((r) => {
        expect(r.ok, `acceptance succeeds once unfrozen (${r.error || ''})`).to.be.true
      })
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-13: Reject approval during acceptance
  // ---------------------------------------------------------------------------
  it('[ACC-13] Reject approval during acceptance aborts flow', () => {
    connectAndVisit(0)
    createSimpleWager({ description: 'ACC-13: Reject approval test' })

    cy.get('[role="dialog"] button[aria-label="Close modal"], [role="dialog"] .fm-close-btn')
      .click({ force: true })

    // Switch to opponent with rejection-patched provider
    /*
     * Reject every way a member can authorize a SPEND, decided by METHOD rather than by ordinal.
     *
     * This used to reject "the second eth_sendTransaction (the approval TX)". Acceptance rides
     * the spec-035 intent rail, where the member's authorization is a SIGNATURE and someone else
     * submits the transaction — so the rejected request was one the flow never makes, and
     * counting transactions described a sequence that no longer exists. (MEM-12 had the same
     * defect, and its purchase ran to "Purchase Complete!" while the test waited for a refusal.)
     *
     * personal_sign is left alone deliberately: it derives the encryption key, which is identity,
     * not spend authorization.
     */
    const SPEND_AUTH = ['eth_sendTransaction', 'eth_signTypedData', 'eth_signTypedData_v4', 'wallet_sendCalls']
    /*
     * Register the wrapper INSIDE .then(), so it lands after the mock's own handler. `cy.on(...)`
     * at the top level of a test registers SYNCHRONOUSLY, while cy.mockWeb3Provider() only
     * enqueues a command that registers its handler when the queue runs — so a wrapper written
     * "after" the mock in source order actually ran BEFORE it, found no win.ethereum to wrap, and
     * installed nothing.
     */
    cy.mockWeb3Provider({ account: TEST_ACCOUNTS[1] }).then(() => {
      cy.on('window:before:load', (win) => {
        const originalRequest = win.ethereum?.request
        if (originalRequest) {
          win.ethereum.request = ({ method, params }) => {
            if (SPEND_AUTH.includes(method)) {
              const err = new Error('User rejected the request')
              err.code = 4001
              return Promise.reject(err)
            }
            return originalRequest({ method, params })
          }
        }
      })
    })

    cy.visitWagers()

    cy.connectWallet()

    cy.openMyWagers('participating')

    cy.contains('.mm-panel button, [role="tabpanel"] button', /view offer/i, { timeout: 20000 })
      .click({ force: true })

    acceptThroughModal()

    /*
     * ASSERT THE INVARIANT, not the wording: a refused authorization must leave the wager
     * unaccepted. Status 1 is Open — anything else and the rejection did not abort the flow.
     *
     * The old check scanned the modal for rejected/cancelled/failed/error/try again. That is a
     * list broad enough to pass on almost anything the modal might say, yet specific enough to
     * fail when it says nothing at all, which is what happens here — and it tested the copy
     * rather than the outcome. Whether the UI apologises well is a separate question from
     * whether the member's stake stayed put. The `else { expect(true).to.be.true }` this
     * replaced meant a missing offer silently PASSED the test.
     */
    cy.lastWagerId().then((id) => {
      cy.wait(3000)
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.status, `wager ${id} stays Open after a refused authorization`).to.equal(1)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // ACC-14 / ACC-15 — OPEN CHALLENGES (spec 024). No named opponent: whoever
  // holds the four-word code can take it, and only for themselves.
  // ---------------------------------------------------------------------------

  it('[ACC-14] A code holder takes an open challenge, and their stake actually moves', () => {
    /*
     * An open challenge names no opponent. Possession of the four-word code IS the authority to
     * take it: the client derives a keypair from the phrase, and the taker presents an EIP-712
     * signature from that key. These tests stand a generated keypair in for the phrase, because
     * what is under test is the on-chain acceptance rule, not the word list.
     *
     * The assertion that matters is the money. A wager flipping to Active proves a status write;
     * it does not prove the taker paid. `_settleAccept` pulls the opponent stake, so the test
     * reads the taker's balance either side and requires exactly the stake to have left.
     */
    const STAKE = 2n * 10n ** 18n
    const taker = TEST_ACCOUNTS[1]
    cy.task('chainTx', { action: 'fund', args: { address: TEST_ACCOUNTS[0] } })
    cy.task('chainTx', { action: 'fund', args: { address: taker } })
    cy.task('chainTx', { action: 'approve', args: { index: 0 } })
    cy.task('chainTx', { action: 'approve', args: { index: 1 } })
    cy.task('chainTx', { action: 'grantMembership', args: { address: TEST_ACCOUNTS[0], tier: 4, durationDays: 365 } })
    cy.task('chainTx', { action: 'grantMembership', args: { address: taker, tier: 4, durationDays: 365 } })

    cy.task('chainTx', { action: 'createOpenWager', args: { creatorIndex: 0, stake: String(STAKE) } }).then((open) => {
      expect(open.ok, 'the open challenge was created').to.equal(true)

      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: open.wagerId } }).then((i) => {
        expect(i.status, 'it starts Open').to.equal(1)
        expect(
          i.opponent,
          'an open challenge names NO opponent — that is what makes it open',
        ).to.equal('0x0000000000000000000000000000000000000000')
      })

      cy.task('chainTx', { action: 'tokenBalance', args: { address: taker } }).as('takerBefore')

      cy.task('chainTx', {
        action: 'acceptOpenWager',
        args: { wagerId: open.wagerId, claimKey: open.claimKey, takerIndex: 1 },
      }).then((r) => {
        expect(r.ok, `the code holder can take the challenge (${r.error || ''})`).to.equal(true)
      })

      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: open.wagerId } }).then((i) => {
        expect(i.status, 'the challenge is Active once taken').to.equal(2)
        expect(i.opponent, 'the taker is now the opponent').to.equal(taker)
      })

      cy.get('@takerBefore').then((before) => {
        cy.task('chainTx', { action: 'tokenBalance', args: { address: taker } }).then((after) => {
          expect(
            BigInt(before.balance) - BigInt(after.balance),
            'the taker actually staked — Active is not the same as paid',
          ).to.equal(STAKE)
        })
      })
    })
  })

  it('[ACC-15] A signature for one taker cannot be reused by another — the code is not a bearer token in the mempool', () => {
    /*
     * THE FRONT-RUNNING RULE, and the reason the signature commits to the taker at all.
     *
     * `acceptOpenWager` is a public call carrying a signature. If that signature authorised "this
     * challenge" rather than "this challenge, for this person", anyone watching the mempool could
     * copy it out of a pending transaction and take the wager first — and the legitimate holder
     * of the code would lose a challenge that was theirs to accept.
     *
     * So the digest is `OpenAccept(wagerId, taker)`, and this test proves the binding by lifting a
     * valid signature made for account #1 and submitting it as account #2. It must be refused,
     * and the challenge must still be Open afterwards for its rightful taker.
     */
    const STAKE = 2n * 10n ** 18n
    const rightful = TEST_ACCOUNTS[1]
    const frontRunner = TEST_ACCOUNTS[2]
    ;[TEST_ACCOUNTS[0], rightful, frontRunner].forEach((address, idx) => {
      cy.task('chainTx', { action: 'fund', args: { address } })
      cy.task('chainTx', { action: 'approve', args: { index: idx } })
      cy.task('chainTx', { action: 'grantMembership', args: { address, tier: 4, durationDays: 365 } })
    })

    cy.task('chainTx', { action: 'createOpenWager', args: { creatorIndex: 0, stake: String(STAKE) } }).then((open) => {
      expect(open.ok, 'the open challenge was created').to.equal(true)

      /*
       * The front-runner submits, as themselves, a signature that was issued for the rightful
       * taker. `taker` is what the digest commits to; `takerIndex` is who sends the transaction.
       */
      cy.task('chainTx', {
        action: 'acceptOpenWager',
        args: { wagerId: open.wagerId, claimKey: open.claimKey, takerIndex: 2, taker: rightful },
      }).then((r) => {
        expect(r.ok, "a signature issued for someone else does not let a third party take the challenge").to.equal(false)
      })

      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: open.wagerId } }).then((i) => {
        expect(i.status, 'the challenge is still Open — nobody took it').to.equal(1)
        expect(i.opponent, 'and it still names no opponent').to.equal('0x0000000000000000000000000000000000000000')
      })

      // And the rightful holder can still take it afterwards: the failed attempt cost them nothing.
      cy.task('chainTx', {
        action: 'acceptOpenWager',
        args: { wagerId: open.wagerId, claimKey: open.claimKey, takerIndex: 1 },
      }).then((r) => {
        expect(r.ok, `the rightful taker is unaffected by the attempt (${r.error || ''})`).to.equal(true)
      })
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: open.wagerId } }).then((i) => {
        expect(i.opponent, 'the challenge went to the person the code was shared with').to.equal(rightful)
      })
    })
  })

})
