/**
 * E2E Tests: Wager Creation with Real Transactions (Full-tier)
 *
 * Requires a running Hardhat node with deployed contracts (chain 1337).
 * Tests happy-path wager creation across all market types, stake tokens,
 * resolution types, and oracle-pegged flows.
 *
 * Checklist: CRE-01..CRE-16
 * Validation-only tests (CRE-17+) live in fast/04-wager-creation-validation.cy.js
 */

const TEST_ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // #0 Creator / Admin
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // #1 Opponent
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // #2 Arbitrator
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // #3 Guardian
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', // #4 Bystander
]

/**
 * Connect wallet and navigate to the dashboard.
 */
function connectWalletAndVisit(accountIndex = 0) {
  cy.mockWeb3Provider({ account: TEST_ACCOUNTS[accountIndex] })
  cy.visitWagers()

  cy.connectWallet()
}

/**
 * Open the Create Wager modal and fill common fields.
 * Returns the modal container for further interaction.
 */
function openAndFillWagerForm(config = {}) {
  const type = config.type || 'oneVsOne'
  cy.openCreateWagerModal(type)

  // Fill description
  if (config.description) {
    cy.get('#fm-description, [role="dialog"] input[type="text"]')
      .first()
      .clear()
      .type(config.description)
  }

  // Fill opponent (1v1)
  if (config.opponent) {
    cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]')
      .first()
      .clear()
      .type(config.opponent)
    /*
     * Wait for the address to RESOLVE, not a fixed 500ms. validateForm requires
     * formData.opponentResolved; submitting first fails validation and the modal never reaches the
     * success screen, so the failure surfaces 60s later as a timeout on the success copy and points
     * at the transaction instead of at the form. The same fix was already applied to CRE-11 lower in
     * THIS file — one copy got it, the helper serving CRE-01..CRE-09 did not.
     */
    cy.get('[aria-label="Valid address"]', { timeout: 15000 }).should('exist')
  }

  // Set stake amount
  if (config.stake) {
    cy.enterAmountViaKeypad('fm-stake', config.stake.toString())
  }

  // Set stake token
  if (config.stakeToken) {
    cy.get('#fm-stake-token, [role="dialog"] .fm-token-select')
      .first()
      .select(config.stakeToken)
  }

  // Set resolution type
  if (config.resolutionType !== undefined) {
    cy.selectResolutionType(config.resolutionType.toString())
  }

  // Set arbitrator
  if (config.arbitrator) {
    /*
     * `#fm-arbitrator` (FriendMarketsModal.jsx:1586), not `input[placeholder*="0x"]).last()`.
     * The arbitrator input only renders once ResolutionType.ThirdParty is selected, so before that
     * `.last()` is the OPPONENT field — the helper would overwrite the opponent with the
     * arbitrator address and leave the arbitrator empty, which then fails validation
     * ("Arbitrator address is required for third-party resolution", :720).
     * Waits for resolution rather than a fixed 500ms, same as the opponent field.
     */
    cy.get('#fm-arbitrator', { timeout: 10000 }).clear().type(config.arbitrator)
    cy.get('[aria-label="Valid address"]', { timeout: 15000 }).should('have.length.greaterThan', 1)
  }

  // Set odds multiplier (offer)
  if (config.oddsMultiplier) {
    cy.get('#fm-odds, [role="dialog"] .fm-odds-slider')
      .first()
      .invoke('val', config.oddsMultiplier)
      .trigger('input')
  }

  // Encryption is ON by default and is no longer optional — the opt-out checkbox was removed
  // from FriendMarketsModal several sprints ago (grep `checkbox` there returns nothing). The
  // block that used to uncheck it was a no-op guarded by `if (length > 0)`, so it silently did
  // nothing while the spec read as though it controlled encryption. (#1028)
}

/**
 * Submit the wager creation form and wait for TX completion.
 */
function submitWagerForm() {
  cy.get('.fm-btn-primary', { timeout: 10000 }).should('not.be.disabled').click()

  /*
   * Report a blocked submit instead of timing out blind. validateForm can refuse silently — the
   * button stays enabled, nothing is sent, and the only sign is a `.fm-error` span on the field
   * at fault. Waiting 60s for "Wager Created" then said only that it never appeared, which is
   * true of a rejected form and of a failed transaction alike.
   */
  cy.get('body').then(($b) => {
    const errs = $b.find('.fm-error').toArray().map((el) => el.textContent.trim()).filter(Boolean)
    if (errs.length) throw new Error(`create form refused the submit: ${errs.join(' | ')}`)
  })

  // The form transitions through verify → approve → create → complete.
  cy.contains('Wager Created', { timeout: 60000 }).should('exist')
}

/**
 * Assert wager was created successfully (success screen visible).
 */
function assertWagerCreated() {
  cy.contains('Wager Created', { timeout: 60000 }).should('exist')
}

describe('Wager Creation with Real Transactions', () => {
  before(() => {
    // Encryption is MANDATORY: FriendMarketsModal refuses to create a wager whose opponent has
    // no key in KeyRegistry, silently and with no validation error. A fresh chain has none.
    // The chain checkpoint reverts state per spec, so this runs once per spec.
    //
    // #2 (the arbitrator) is in the list because CRE-06's ThirdParty wager encrypts the
    // private terms TO THE ARBITRATOR as well (FriendMarketsModal.jsx:936-943) — without
    // #2's key the create dies with "The arbitrator has not registered their encryption
    // key yet", 60 seconds after the submit, looking like a transaction failure.
    cy.ensureWagerCapacity([0, 1])
    cy.ensureEncryptionKeys([0, 1, 2])
  })

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    /*
     * STUB THE PINNING SERVICE. Encryption is mandatory on the create path, so
     * useFriendMarketCreation always calls uploadEncryptedEnvelope — and a create that cannot
     * pin its metadata throws BEFORE it reaches WagerRegistry. Without this every test in this
     * file fails for a reason that has nothing to do with the money path it is testing.
     *
     * This is only half of it: the throw is raised in getPinataAuthHeaders() while BUILDING the
     * request, so an intercept alone never fires. The dev server must also run with a
     * VITE_PINATA_JWT (see the `dev:e2e` script) or the request is never issued to intercept.
     */
    cy.interceptIpfs()
  })

  // ---------------------------------------------------------------------------
  // CRE-01: 1v1 USDC, Either Party resolution
  // ---------------------------------------------------------------------------
  it('[CRE-01] Create 1v1 wager with USDC, Either Party resolution', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-01: BTC above 100k by end of week',
      opponent: TEST_ACCOUNTS[1],
      stake: 10,
      stakeToken: 'STABLE',
      resolutionType: 0, // Either Party
      encrypted: false,
    })

    submitWagerForm()
    assertWagerCreated()
  })

  // ---------------------------------------------------------------------------
  // CRE-02: 1v1 POL (native token, no approval needed)
  // ---------------------------------------------------------------------------
  it('[CRE-02] Create 1v1 wager with POL (native token)', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-02: Native POL wager test',
      opponent: TEST_ACCOUNTS[1],
      stake: 1,
      stakeToken: 'NATIVE',
      resolutionType: 0,
      encrypted: false,
    })

    submitWagerForm()

    /*
     * Native collateral may legitimately be REFUSED — v2 is ERC20-only — so this accepts either
     * outcome, as the comment always promised. Retrying (`cy.contains` + `should`) rather than the
     * original one-shot `invoke('text').then()`, which read the DOM before the tx settled.
     * Tightening this to success-only would fail the test for behaving correctly.
     */
    cy.contains(/Wager Created|not supported|native|erc20/i, { timeout: 60000 }).should('exist')
  })

  // ---------------------------------------------------------------------------
  // CRE-03: 1v1 WPOL
  // ---------------------------------------------------------------------------
  it('[CRE-03] Create 1v1 wager with WPOL', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-03: Wrapped POL wager test',
      opponent: TEST_ACCOUNTS[1],
      stake: 1,
      stakeToken: 'WNATIVE',
      resolutionType: 0,
      encrypted: false,
    })

    submitWagerForm()

    cy.contains('Wager Created', { timeout: 60000 }).should('exist')
  })

  // ---------------------------------------------------------------------------
  // CRE-04: Creator Only resolution
  // ---------------------------------------------------------------------------
  it('[CRE-04] Create 1v1 wager with Creator Only resolution', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-04: Creator resolves this wager',
      opponent: TEST_ACCOUNTS[1],
      stake: 5,
      resolutionType: 1, // Creator Only
      encrypted: false,
    })

    submitWagerForm()
    assertWagerCreated()
  })

  // ---------------------------------------------------------------------------
  // CRE-05: Opponent Only resolution
  // ---------------------------------------------------------------------------
  it('[CRE-05] Create 1v1 wager with Opponent Only resolution', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-05: Opponent resolves this wager',
      opponent: TEST_ACCOUNTS[1],
      stake: 5,
      resolutionType: 2, // Opponent Only
      encrypted: false,
    })

    submitWagerForm()
    assertWagerCreated()
  })

  // ---------------------------------------------------------------------------
  // CRE-06: Third Party resolution
  // ---------------------------------------------------------------------------
  it('[CRE-06] Create 1v1 wager with Third Party resolution', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-06: Third party arbitrator resolves',
      opponent: TEST_ACCOUNTS[1],
      stake: 5,
      resolutionType: 3, // Third Party
      arbitrator: TEST_ACCOUNTS[2],
      encrypted: false,
    })

    submitWagerForm()
    assertWagerCreated()
  })

  // ---------------------------------------------------------------------------
  // CRE-07: Private / encrypted wager
  // ---------------------------------------------------------------------------
  it('[CRE-07] Create encrypted private wager', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-07: This is an encrypted wager',
      opponent: TEST_ACCOUNTS[1],
      stake: 10,
      resolutionType: 0,
      // encrypted defaults to true; leave it on
    })

    submitWagerForm()

    /*
     * Success-only is correct here NOW: cy.ensureEncryptionKeys([0,1]) in before() guarantees the
     * opponent holds a key, so the "opponent hasn't registered a key" branch this used to tolerate
     * is unreachable. Tolerating it would let a genuine encryption regression pass.
     */
    cy.contains('Wager Created', { timeout: 60000 }).should('exist')
  })

  // ---------------------------------------------------------------------------
  // CRE-08: Custom acceptance deadline
  // ---------------------------------------------------------------------------
  it('[CRE-08] Create wager and verify acceptance deadline', () => {
    connectWalletAndVisit(0)

    openAndFillWagerForm({
      description: 'CRE-08: Custom deadline wager',
      opponent: TEST_ACCOUNTS[1],
      stake: 5,
      resolutionType: 0,
      encrypted: false,
    })

    // Verify the derived acceptance deadline is displayed (deterministic, not
    // editable) via the glanceable "Accept by" timeline tile.
    cy.get('[role="dialog"]').within(() => {
      // `exist`, not `be.visible`: the deadline tiles sit below the fold of the scrollable modal.
      // The claim is that the acceptance deadline is RENDERED; whether the modal scrolls to it is a
      // separate UX question (#1019). Same class as the success heading.
      cy.contains('Accept by').should('exist')
      cy.get('.fm-stat-tile.is-accept .fm-stat-time').should('exist')
      cy.get('.fm-stat-tile.is-accept .fm-stat-time').invoke('text').should('not.be.empty').and('not.equal', '—')
    })

    submitWagerForm()
    assertWagerCreated()
  })

  // ---------------------------------------------------------------------------
  // CRE-09: Custom end date
  // ---------------------------------------------------------------------------
  it('[CRE-09] Create wager with custom end date', () => {
    connectWalletAndVisit(0)

    cy.openCreateWagerModal('oneVsOne')

    // Fill basic fields
    cy.get('#fm-description, [role="dialog"] input[type="text"]')
      .first()
      .clear()
      .type('CRE-09: Wager with custom end date')

    cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]')
      .first()
      .clear()
      .type(TEST_ACCOUNTS[1])

    cy.enterAmountViaKeypad('fm-stake', '5')

    /*
     * The end date is NOT a form input. Spec 038 replaced `#fm-end-date` with the
     * DeadlineTimeline: milestones on a shared track, where tapping the editable
     * ENDS tile (a <button>, "Tap to set") opens SetTimeModal — the single exact
     * date-and-time entry point — whose datetime-local input is `.stm-input` and
     * whose confirm button is "Set". The old selector matched nothing.
     *
     * +5 days, formatted LOCAL (toISOString is UTC and can be off by a day at
     * midnight boundaries); the flow bounds the end time at min 1h / max 21d.
     */
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    const pad = (n) => String(n).padStart(2, '0')
    const localStamp = `${futureDate.getFullYear()}-${pad(futureDate.getMonth() + 1)}-${pad(futureDate.getDate())}T${pad(futureDate.getHours())}:${pad(futureDate.getMinutes())}`
    cy.get('.fm-stat-tiles', { timeout: 10000 }).contains('button', /ends/i).click()
    cy.get('.stm-input', { timeout: 10000 }).clear().type(localStamp)
    cy.get('.stm-dialog').contains('button', /^set$/i).click()
    // The tile reflects the chosen day — proof the modal actually applied it.
    cy.get('.fm-stat-tiles').contains('button', /ends/i)
      .should('contain.text', String(futureDate.getDate()))

    submitWagerForm()
    assertWagerCreated()
  })

  // ---------------------------------------------------------------------------
  // CRE-10: Group wagers are not offered (v2 contract is 1v1 only)
  // ---------------------------------------------------------------------------
  it('[CRE-10] Group wager creation is not available', () => {
    connectWalletAndVisit(0)

    // No "Group Wager" entry card on the dashboard.
    cy.contains('.quick-action-card', /group wager/i).should('not.exist')

    // And the 1v1 creation form exposes no member-address / group inputs.
    cy.openCreateWagerModal('oneVsOne')
    cy.get('[role="dialog"]').within(() => {
      cy.get('#fm-members').should('not.exist')
      cy.get('#fm-min-threshold').should('not.exist')
    })
  })

  // ---------------------------------------------------------------------------
  // CRE-11: Offer with asymmetric odds
  // ---------------------------------------------------------------------------
  it('[CRE-11] Create offer wager with asymmetric odds', () => {
    connectWalletAndVisit(0)

    cy.openCreateWagerModal('offer')

    // Offer-type form has odds slider
    cy.get('[role="dialog"]').within(() => {
      cy.get('#fm-description, input[type="text"]').first().clear().type('CRE-11: Offer 5x odds')

      cy.get('input[placeholder*="0x"]').first().clear().type(TEST_ACCOUNTS[1])

  // Wait for the address to RESOLVE, not a fixed 500ms. validateForm requires
  // formData.opponentResolved (FriendMarketsModal.jsx:699-702), which AddressInput sets from an
  // async callback; submitting first fails validation with "Opponent address is required" and the
  // modal simply never reaches the success screen. AddressInput renders
  // role="img" aria-label="Valid address" once resolution lands.
  cy.get('[aria-label="Valid address"]', { timeout: 15000 }).should('exist')

      cy.enterAmountViaKeypad('fm-stake', '10')

      /*
       * SET THE ODDS TO 5x — the asymmetry this test is named for, so the preset is a
       * PRECONDITION, not a probe.
       *
       * The old `$buttons.filter(':contains("5x")')` was a one-shot DOM snapshot inside
       * `.then()` (anti-pattern 3): it read the preset row once, and when the row had not
       * rendered yet the `if` silently did nothing (anti-pattern 6). The form then kept its
       * 2x default and the test CREATED A SYMMETRIC WAGER while still passing, because the
       * only thing asserted afterwards — that `.fm-odds-summary` exists — is true at every
       * multiplier. A retryable `cy.contains` fails here, naming the missing control.
       *
       * `/^5x$/` rather than `5x`, so the preset row's 50x button cannot satisfy it.
       */
      cy.contains('.fm-odds-presets button', /^5x$/, { timeout: 10000 })
        .should('not.be.disabled')
        .click()

      /*
       * The form agreeing the selection landed: FriendMarketsModal puts `active` on the preset
       * only while `formData.oddsMultiplier === 500`, which is the value the create actually
       * submits. Without this the click could miss and the summary would still render.
       */
      cy.contains('.fm-odds-presets button', /^5x$/).should('have.class', 'active')
    })


    // Verify odds summary shows correct values
    cy.get('[role="dialog"]').within(() => {
      cy.get('.fm-odds-summary, .fm-odds-row').should('exist')
    })

    submitWagerForm()

    cy.contains('Wager Created', { timeout: 60000 }).should('exist')
  })

  // ---------------------------------------------------------------------------
  // CRE-12..16: the ORACLE flow ("Oracle Settles" card), rewritten (#1028).
  //
  // The old tests drove `#fm-resolution-type, .fm-select` — a dropdown that has
  // not existed in any .jsx for a long time. The real flow: the Dashboard's
  // "Oracle Settles" card opens the modal in its oracle category, where (with
  // the default Polymarket-only exposure) the tab strip is HIDDEN and the
  // Polymarket picker renders directly — an inline PolymarketBrowser whose
  // market cards commit a conditionId on click (.fm-polymarket-selected).
  //
  // The browser's data comes from Polymarket's Gamma API — an EXTERNAL service
  // the local tier must not depend on — so the tests intercept it and serve a
  // fixture whose conditionId is a REAL condition prepared on the local mock
  // CTF (cy.task prepareCondition). The intercept fakes only the CATALOG; the
  // wager itself settles against a condition the chain actually holds.
  // ---------------------------------------------------------------------------

  /** Serve both Gamma endpoints (search + top events) from one fixture. */
  function interceptGamma(conditionId, { question = 'E2E: will the fixture market resolve YES?' } = {}) {
    const market = {
      id: 'e2e-m1',
      question,
      conditionId,
      endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      active: true,
      closed: false,
      volume: 1000000,
      liquidity: 50000,
      // Gamma serialises these as JSON STRINGS (parseJsonArray in the hook).
      outcomes: JSON.stringify(['Yes', 'No']),
      outcomePrices: JSON.stringify(['0.55', '0.45']),
    }
    const event = { id: 'e2e-ev1', title: question, slug: 'e2e-fixture', tags: [], volume: 1000000, markets: [market] }
    cy.intercept('GET', '**/public-search*', { body: { events: [event] } }).as('gammaSearch')
    cy.intercept('GET', '**/events?*', { body: [event] }).as('gammaTop')
    cy.intercept('GET', '**/tags/slug/*', { body: {} })
    return market
  }

  it('[CRE-12] Create Polymarket-pegged wager', () => {
    cy.task('chainTx', { action: 'prepareCondition', args: { question: 'CRE-12 fixture' } }).then((prep) => {
      expect(prep.ok, 'prepareCondition').to.be.true
      const market = interceptGamma(prep.conditionId)

      connectWalletAndVisit(0)
      cy.openCreateWagerModal('oracle')

      // Pick the fixture market from the inline browser; the selected panel
      // must echo the REAL on-chain conditionId, proving the link committed.
      cy.contains('.pmb__card-question', /fixture market/i, { timeout: 15000 }).click()
      /*
       * Assert the SELECTION, not the pixel. `.fm-polymarket-selected` is position:fixed inside
       * the modal, so Cypress calls it "not visible because it is covered by another element" —
       * a statement about layering, not about whether the market was linked. The invariant this
       * test exists for is the next line: the panel echoes the real on-chain conditionId.
       */
      cy.get('.fm-polymarket-selected', { timeout: 10000 }).should('exist')
      cy.get('.fm-polymarket-cid').should('contain.text', market.conditionId)

      cy.get('#fm-description, [role="dialog"] input[type="text"]')
        .first().clear().type('CRE-12: Polymarket-pegged wager')
      cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]')
        .first().clear().type(TEST_ACCOUNTS[1])
      cy.get('[aria-label="Valid address"]', { timeout: 15000 }).should('exist')
      cy.enterAmountViaKeypad('fm-stake', '5')

      /*
       * PICK A SIDE. A wager pegged to a Polymarket condition is meaningless until the creator
       * says which outcome they are taking, and FriendMarketsModal enforces it — validateForm
       * sets errors.creatorSide ("Pick which side of the linked market you are taking") and the
       * submit does nothing. The test clicked Create and waited 60s for a success screen that
       * was never coming, with the reason sitting on screen in a `.fm-error` span.
       */
      cy.contains('button', /i'm taking/i, { timeout: 10000 }).first().click()

      submitWagerForm()
      assertWagerCreated()
    })
  })

  // The default cohort exposes POLYMARKET ONLY (VITE_ORACLE_MODELS unset ⇒
  // 'polymarket'; FriendMarketsModal: "Hidden models are not selectable by any
  // path"). Driving the Chainlink/UMA creates would test a configuration the
  // shipped product does not offer — so these three assert the default
  // honestly: the hidden oracles are absent, while the Polymarket flow (the
  // positive control) is present. A VITE_ORACLE_MODELS=all variant job is the
  // place to drive the hidden flows, with its own fixtures per adapter.

  it('[CRE-13] Chainlink Data Feed is not offered under default exposure', () => {
    cy.task('chainTx', { action: 'prepareCondition', args: { question: 'CRE-13 fixture' } }).then((prep) => {
      interceptGamma(prep.conditionId)
      connectWalletAndVisit(0)
      cy.openCreateWagerModal('oracle')
      // Positive control first — a broken modal must not pass this test.
      cy.contains('.pmb__card-question', /fixture market/i, { timeout: 15000 }).should('be.visible')
      cy.get('[role="dialog"]').invoke('text').should('not.match', /chainlink data feed/i)
    })
  })

  it('[CRE-14] Chainlink Functions is not offered under default exposure', () => {
    cy.task('chainTx', { action: 'prepareCondition', args: { question: 'CRE-14 fixture' } }).then((prep) => {
      interceptGamma(prep.conditionId)
      connectWalletAndVisit(0)
      cy.openCreateWagerModal('oracle')
      cy.contains('.pmb__card-question', /fixture market/i, { timeout: 15000 }).should('be.visible')
      cy.get('[role="dialog"]').invoke('text').should('not.match', /chainlink functions/i)
    })
  })

  it('[CRE-15] UMA Optimistic Oracle is not offered under default exposure', () => {
    cy.task('chainTx', { action: 'prepareCondition', args: { question: 'CRE-15 fixture' } }).then((prep) => {
      interceptGamma(prep.conditionId)
      connectWalletAndVisit(0)
      cy.openCreateWagerModal('oracle')
      cy.contains('.pmb__card-question', /fixture market/i, { timeout: 15000 }).should('be.visible')
      cy.get('[role="dialog"]').invoke('text').should('not.match', /uma optimistic/i)
    })
  })

  it('[CRE-16] Browse Polymarket markets in picker', () => {
    cy.task('chainTx', { action: 'prepareCondition', args: { question: 'CRE-16 fixture' } }).then((prep) => {
      const market = interceptGamma(prep.conditionId)
      connectWalletAndVisit(0)
      cy.openCreateWagerModal('oracle')
      // The browser lists the catalog and a tap commits the selection.
      cy.contains('.pmb__card-question', /fixture market/i, { timeout: 15000 }).should('be.visible').click()
      /*
       * Assert the SELECTION, not the pixel. `.fm-polymarket-selected` is position:fixed inside
       * the modal, so Cypress calls it "not visible because it is covered by another element" —
       * a statement about layering, not about whether the market was linked. The invariant this
       * test exists for is the next line: the panel echoes the real on-chain conditionId.
       */
      cy.get('.fm-polymarket-selected', { timeout: 10000 }).should('exist')
      cy.get('.fm-polymarket-cid').should('contain.text', market.conditionId)
    })
  })
})
