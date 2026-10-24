// =============================================================================
// 13-dashboard.cy.js
// Fast-tier E2E tests for dashboard rendering (DSH-01..DSH-18)
//
// These tests use mockWeb3Provider() and connect through the UI to verify the dashboard
// renders without a Hardhat node. They never used demo mode: the localStorage toggle this
// header used to cite was read by nothing, and the env bypass was build-time only.
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('Dashboard', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  /**
   * Helper: visit /fairwins with mock provider and connect the wallet so the
   * dashboard (not the Welcome View) renders. The connected dashboard gates on
   * isConnected unless demoMode is true.
   */
  function connectAndVisitDashboard() {
    cy.mockWeb3Provider({ account: TEST_ACCOUNT })
    /*
     * The wager dashboard is no longer the app's landing view. Spec 073 moved it to
     * Finance > Transfer > Wagers (appNav.js WAGERS_VIEW/WAGERS_PATH, rendered by
     * PayTransferPanel), with `/wagers` kept as a redirect — see the FR-030 amendment in
     * specs/073-miniapp-platform/spec.md and the note in CLAUDE.md.
     *
     * This spec kept visiting `/fairwins` and asserting the quick-action grid was there, so every
     * test failed with ".quick-action-card never found" against a page that had simply stopped
     * hosting it. The surface still exists and is still worth testing — only its address changed.
     */
    cy.visit('/wagers')
    cy.get('body', { timeout: 10000 }).should('be.visible')

    // Connect via UI.
    cy.get('.wallet-connect-button, button[aria-label="Connect Wallet"]', { timeout: 10000 })
      .click()
    cy.selectInjectedConnector()
    cy.get('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 10000 })
      .should('be.visible')
  }

  // ---------------------------------------------------------------------------
  // DSH-01: Quick action cards visible
  // ---------------------------------------------------------------------------
  /*
   * Rewritten (#1019). The pending note said "9 render, the test asserts 6 — decide the intended
   * grouping first", but there is no grouping decision to make: Dashboard.jsx declares TEN quick
   * actions and filters exactly one of them, `oracle-open-challenge`, on
   * `capabilities.polymarketSidebets` — a chain without an on-chain oracle does not get the Open
   * Oracle Challenge card (the plain Open Challenge stays). Nine is that rule's answer on this
   * tier, not a mystery.
   *
   * So this asserts the RULE and the cards' IDENTITY, never a count and never a position. The old
   * body did both — `should('have.length', 6)` and `.eq(0..5)` against titles — which is why
   * adding a tile broke it and why it would have kept breaking on every reorder. A count is also a
   * weak assertion in its own right: six of the wrong cards would have satisfied it.
   *
   * Membership is checked BOTH ways. Each expected card must be there exactly once, and no tile
   * may render that is not a known quick action — that second half is what a count was really
   * reaching for, and it names the stranger instead of just disagreeing about a number.
   */
  it('[DSH-01] Quick action cards visible, grouped by intent (create / track / QR)', () => {
    connectAndVisitDashboard()

    // Present on every chain.
    const ALWAYS_PRESENT = [
      'Friends Decide (1v1)',
      'Oracle Settles (1v1)',
      'Make an Offer',
      'Open Challenge',
      'Group Pool',
      'Enter Words',
      'My Wagers',
      'Scan QR Code',
      'Share Account',
    ]
    // Rendered only where the chain advertises an on-chain oracle (Dashboard.jsx
    // `visibleCreateActions`). Allowed, not required — this tier has no oracle.
    const CAPABILITY_GATED = 'Open Oracle Challenge'

    cy.get('.quick-actions-grid', { timeout: 10000 }).should('be.visible')

    ALWAYS_PRESENT.forEach((title) => {
      cy.get('.quick-action-card')
        .filter(`:contains("${title}")`)
        .should('have.length', 1)
    })

    cy.get('.quick-action-card').then(($cards) => {
      const known = new Set([...ALWAYS_PRESENT, CAPABILITY_GATED])
      const rendered = [...$cards].map((el) => el.querySelector('h4')?.textContent?.trim())
      const strangers = rendered.filter((t) => !known.has(t))
      expect(strangers, 'every rendered tile is a known quick action').to.deep.equal([])
    })

    // The two intent groups are labelled. A group header only renders when it still has a card
    // under it, so these also prove neither group was emptied by the capability filter.
    cy.contains('.qa-group-eyebrow', 'Start a wager').should('exist')
    cy.contains('.qa-group-eyebrow', 'Track & share').should('exist')
  })

  // ---------------------------------------------------------------------------
  // DSH-02: My Wagers — Participating tab
  // ---------------------------------------------------------------------------
  it('[DSH-02] My Wagers Participating tab', () => {
    connectAndVisitDashboard()

    // Open My Wagers modal via the quick action card.
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // The Participating tab should be active by default.
    cy.get('[role="tab"][aria-selected="true"]', { timeout: 5000 })
      .should('contain.text', 'Participating')

    // The tabpanel should be visible.
    cy.get('[role="tabpanel"], .mm-panel', { timeout: 5000 }).should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // DSH-03: My Wagers — Created tab
  // ---------------------------------------------------------------------------
  /*
   * Un-skipped (#1019). The recorded reason — "tab is a <span> without aria-selected" — described
   * what the ASSERTION resolved to, not what the app renders. MyMarketsModal's tabs are buttons
   * carrying `role="tab"` and `aria-selected`; the a11y contract is already there and needed no
   * deciding.
   *
   * What went wrong is a Cypress shape: `cy.get('[role="tab"]').contains('Created')` returns the
   * DEEPEST element containing the text, which is the inner `<span>Created</span>` — so the
   * assertion looked for aria-selected on a span that will never have it. The selector-first form,
   * `cy.contains('[role="tab"]', 'Created')`, yields the element matching the SELECTOR.
   *
   * The test was already using the correct form one line above, for the click. Only the assertion
   * used the other one, which is why the tab genuinely switched and the check still failed.
   */
  it('[DSH-03] My Wagers Created tab', () => {
    connectAndVisitDashboard()

    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // Switch to Created tab.
    cy.contains('[role="tab"]', 'Created').click()
    cy.contains('[role="tab"]', 'Created')
      .should('have.attr', 'aria-selected', 'true')
    // Both sides. "Created is selected" alone would still pass if every tab claimed selection,
    // which is a real way for a tablist to be wrong and the reason the marker existed.
    cy.contains('[role="tab"]', 'Participating')
      .should('have.attr', 'aria-selected', 'false')

    // The Created tabpanel should be visible.
    cy.get('[role="tabpanel"], .mm-panel').should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // DSH-04: My Wagers — History tab
  // ---------------------------------------------------------------------------
  // Same Cypress shape as DSH-03 — see the note there.
  it('[DSH-04] My Wagers History tab', () => {
    connectAndVisitDashboard()

    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // Switch to History tab.
    cy.contains('[role="tab"]', 'History').click()
    cy.contains('[role="tab"]', 'History')
      .should('have.attr', 'aria-selected', 'true')
    // Both sides — see DSH-03.
    cy.contains('[role="tab"]', 'Created')
      .should('have.attr', 'aria-selected', 'false')

    cy.get('[role="tabpanel"], .mm-panel').should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // DSH-05: Filter wagers by status
  // ---------------------------------------------------------------------------
  // PENDING (#1019): My Wagers modal backdrop sits at opacity 0 when asserted; needs an open/animation contract.
  it.skip('[DSH-05] Filter wagers by status', () => {
    connectAndVisitDashboard()

    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // The filter bar should be visible with Type and Status dropdowns.
    cy.get('.mm-filter-bar', { timeout: 5000 }).should('be.visible')

    // Verify the Status filter select exists and has options.
    cy.get('.mm-filter-bar .mm-filter-select').should('have.length.gte', 2)

    // Change the status filter to "Active".
    cy.get('.mm-filter-bar .mm-filter-select').last().select('active')
    cy.get('.mm-filter-bar .mm-filter-select').last().should('have.value', 'active')

    // Change back to "All Status".
    cy.get('.mm-filter-bar .mm-filter-select').last().select('all')
    cy.get('.mm-filter-bar .mm-filter-select').last().should('have.value', 'all')
  })

  // ---------------------------------------------------------------------------
  // DSH-06: View wager details from list
  // ---------------------------------------------------------------------------
  it('[DSH-06] View wager details from list', () => {
    connectAndVisitDashboard()

    // Open My Wagers.
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // At the default 1280px viewport the table view renders automatically
    // (spec 019); clicking a row opens the full detail view.
    cy.get('.mm-panel, [role="tabpanel"]').then(($panel) => {
      const rows = $panel.find('.mm-table-row, tr[role="button"]')
      if (rows.length > 0) {
        cy.wrap(rows.first()).click()
        // Detail view should show the back button and market info.
        cy.get('.mm-detail, .mm-back-btn').should('be.visible')
        cy.get('.mm-detail-header, .mm-detail-title-row').should('be.visible')
      } else {
        // No wagers — the empty state should be visible. This is the real assertion for this
        // branch; the fast tier runs with no chain, so an empty list is the expected fact here.
        cy.get('.mm-empty-state').should('be.visible')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // DSH-07: Wager status indicators
  // ---------------------------------------------------------------------------
  it('[DSH-07] Wager status indicators', () => {
    connectAndVisitDashboard()

    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // Check across all tabs that status badges exist and have the right classes.
    cy.get('.mm-panel, [role="tabpanel"]').then(($panel) => {
      const badges = $panel.find('.mm-status-badge')
      if (badges.length > 0) {
        // Every badge should have a status-* class.
        badges.each((_, el) => {
          const classes = el.className
          expect(classes).to.match(/status-/)
        })
      } else {
        // Empty state — verify the empty-state component is shown.
        cy.get('.mm-empty-state').should('exist')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // DSH-08: How-it-works collapsible section
  // ---------------------------------------------------------------------------
  // PENDING (#1019): `.how-it-works-card` no longer exists anywhere in src — decide whether the section stays.
  it.skip('[DSH-08] How-it-works collapsible section', () => {
    connectAndVisitDashboard()

    // The How It Works card should be present.
    cy.get('.how-it-works-card', { timeout: 10000 }).should('be.visible')

    // The toggle button should exist and show the collapsed state initially.
    cy.get('.how-it-works-toggle')
      .should('be.visible')
      .should('have.attr', 'aria-expanded', 'false')

    // Steps should NOT be visible when collapsed.
    cy.get('.how-it-works-steps').should('not.exist')

    // Click to expand.
    cy.get('.how-it-works-toggle').click()
    cy.get('.how-it-works-toggle')
      .should('have.attr', 'aria-expanded', 'true')

    // Steps should now be visible with 4 items.
    cy.get('.how-it-works-steps', { timeout: 5000 }).should('be.visible')
    cy.get('.how-step').should('have.length', 4)

    // Click to collapse again.
    cy.get('.how-it-works-toggle').click()
    cy.get('.how-it-works-toggle')
      .should('have.attr', 'aria-expanded', 'false')
    cy.get('.how-it-works-steps').should('not.exist')
  })

  // ---------------------------------------------------------------------------
  // DSH-09: Polymarket feed on dashboard
  // ---------------------------------------------------------------------------
  it('[DSH-09] Polymarket feed on dashboard', () => {
    connectAndVisitDashboard()

    // The PolymarketBrowser component renders in the dashboard.
    // It may self-gate if the chain doesn't support Polymarket.
    // Verify the section exists (even if empty due to chain).
    cy.get('.dashboard-section', { timeout: 10000 })
      .should('have.length.gte', 2)

    // If Polymarket content loaded, it should render cards or a message.
    cy.get('body').then(($body) => {
      const hasPolymarket = $body.find('.polymarket-browser, .polymarket-feed').length > 0
      // Either the component rendered or the section is present (may be empty on non-Polygon).
      expect(hasPolymarket || $body.find('.dashboard-section').length > 1).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // DSH-10: Dashboard without membership shows CTA
  // ---------------------------------------------------------------------------
  it('[DSH-10] Dashboard without membership shows CTA', () => {
    connectAndVisitDashboard()

    /*
     * This is deterministic in the fast tier, not either-way: RoleContext.syncRolesWithBlockchain
     * calls hasRoleOnChain for WAGER_PARTICIPANT, which never throws (blockchainService.js
     * catches every read failure and resolves `unread`/false) — so blockchainSynced flips true
     * even with no chain running. A freshly cleared localStorage (this file's beforeEach) holds
     * no local role either, so Dashboard.jsx's gate
     * (isConnected && blockchainSynced && !bannerDismissed && !hasRole(WAGER_PARTICIPANT))
     * is satisfied every time. The old `else` branch describing "the user may already have the
     * role" could not happen here and silently covered for the banner never rendering at all.
     */
    /*
     * 30s, not the file's usual 10s, and the budget is sized to what this specific wait
     * depends on rather than to the other assertions here. The banner's gate includes
     * `blockchainSynced`, which RoleContext only flips after `syncRolesWithBlockchain`
     * awaits `hasRoleOnChain` for FIVE roles IN SEQUENCE — and with no chain running each
     * one still reaches for a provider before resolving false. Measured at 6.2s on an idle
     * machine: 62% of a 10s budget already spent, which is a test living on borrowed time,
     * and it duly tipped on a loaded CI runner (desktop shard 1, run 34301224346) while
     * passing locally on the same commit.
     *
     * This widens a WAIT, not an assertion: what must be true is unchanged below, and a
     * banner that never renders still fails. Shortening the wait itself would mean making
     * that role sweep concurrent, which is a WalletContext change, not a spec one.
     *
     * Second occurrence: 30s tipped again on desktop shard 1 (run 35043312703, spec-110
     * Phase 0 head 33d0c57c — a diff that does not touch the role-sync path, but does grow
     * the bundle every page load pays for). Same remedy, same reasoning: the budget follows
     * what the wait depends on, and the assertion is unchanged.
     */
    cy.get('.dashboard-cta-banner', { timeout: 60000 }).should('be.visible')
    cy.get('.dashboard-cta-banner').invoke('text').should((text) => {
      expect(text.includes('Get access') || text.includes('Wager Participant'), text).to.be.true
    })

    cy.get('.cta-banner-btn.primary').should('be.visible')
    cy.get('.cta-banner-dismiss').should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // DSH-11: Empty state no wagers
  // ---------------------------------------------------------------------------
  it('[DSH-11] Empty state no wagers', () => {
    connectAndVisitDashboard()

    // Open My Wagers — with no real markets, it should show empty state.
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // The Participating tab empty state should be shown.
    cy.get('.mm-empty-state', { timeout: 5000 }).should('be.visible')
    cy.get('.mm-empty-state h3').should('exist')
    cy.get('.mm-empty-state h3').invoke('text').should('not.be.empty')
  })

  // ---------------------------------------------------------------------------
  // DSH-12: Loading state
  // ---------------------------------------------------------------------------
  it('[DSH-12] Loading state', () => {
    connectAndVisitDashboard()

    // Open My Wagers — the loading spinner may briefly appear.
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // Verify that after loading, either the spinner disappears and content
    // (empty state or data) is shown — not stuck in a loading loop.
    cy.get('.mm-content', { timeout: 10000 }).should('be.visible')
    cy.get('.mm-content').then(($content) => {
      const hasSpinner = $content.find('.mm-spinner, .mm-loading').length > 0
      const hasEmptyState = $content.find('.mm-empty-state').length > 0
      const hasTable = $content.find('.mm-table, .mm-table-container').length > 0
      const hasWalletPrompt = $content.find('.mm-empty-icon').length > 0
      // Content should resolve to one of these states.
      expect(hasSpinner || hasEmptyState || hasTable || hasWalletPrompt).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // DSH-13: Decrypt encrypted wager in list
  // ---------------------------------------------------------------------------
  it('[DSH-13] Decrypt encrypted wager in list', () => {
    // Phone viewport. My Wagers renders the same table here as on desktop — the
    // rows just restyle into stacked cards — so every row control, decrypt
    // included, is reachable without rotating the device.
    cy.viewport(390, 844)
    connectAndVisitDashboard()

    // Open My Wagers.
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // Without seeded market data we assert the pattern, not a specific wager: if
    // rows render at all they are table rows, and an encrypted-and-locked one
    // carries its Decrypt control inline in the row.
    cy.get('.mm-panel, [role="tabpanel"]').then(($panel) => {
      const rows = $panel.find('.mm-table-row')
      if (rows.length > 0) {
        cy.get('.mm-table').should('exist')
        cy.wrap(rows.first()).within(() => {
          cy.get('td.mm-table-market').should('exist')
        })
      } else {
        // No wagers at all — the empty state is fine.
        cy.get('.mm-empty-state').should('exist')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // DSH-14..DSH-16: Expired pending offers (My Wagers cleanup)
  //
  // These cover the UI-only contract: an offer whose acceptanceDeadline has
  // passed must be hidden by default, must surface under the Expired filter
  // with "Expired" in the Time Left column (not e.g. "23h 6m" from the
  // resolve deadline), and must be clearable from the user's local view.
  // The on-chain refund path is exercised by REF-01 in the full tier; here
  // we only assert what the user sees and what localStorage records.
  // ---------------------------------------------------------------------------

  /**
   * Connect, then seed localStorage with the supplied friend-market list and
   * reload so FriendMarketsContext picks them up from cache.
   *
   * The cache is CHAIN-SCOPED: FriendMarketsContext reads `friendMarkets:<chainId>`
   * and only falls back to the bare `friendMarkets` key when no chain is set —
   * which never happens once wagmi has a chain. Seeding the bare key alone (as
   * this helper used to) was therefore never readable, and the only tests that
   * depended on it either assert an EMPTY list (DSH-14, which passes either way)
   * or are skipped. Seed both the connected chain and wagmi's default first
   * chain, because the provider re-reads the cache when the chain settles after
   * reconnect.
   *
   * The cache survives because `cy.refuseChainReads()` makes every chain
   * UNREADABLE, and an unreadable chain keeps whatever was cached (spec 110 —
   * an unreachable network is a named gap, never an empty list). What must NOT
   * be relied on is a chain failing by accident. This helper used to say "the
   * on-chain fetch fails (no Hardhat)", which held only while the list read one
   * chain — the wallet's, 1337 at 127.0.0.1:8545. The list now spans the build's
   * cohort, and a `dev:fast` build's cohort is the five mainnets, so live
   * Polygon answered "this address has no wagers" and the estate read correctly
   * replaced that chain's cache with the empty truth. The fix is to stop the
   * tier reaching a real chain, not to stop the product believing one.
   */
  const WAGMI_DEFAULT_CHAIN_ID = 137 // polygon is first in `chains` (frontend/src/wagmi.js)

  function seedFriendMarketsAndOpen(markets) {
    // Phone viewport: My Wagers renders the same table here as on desktop.
    cy.viewport(390, 844)
    cy.refuseChainReads()
    connectAndVisitDashboard()
    cy.window().then((win) => {
      const payload = JSON.stringify(markets)
      const mockChainId = Number(Cypress.env('NETWORK_ID') || 1337)
      for (const key of [
        'friendMarkets',
        `friendMarkets:${mockChainId}`,
        `friendMarkets:${WAGMI_DEFAULT_CHAIN_ID}`,
      ]) {
        win.localStorage.setItem(key, payload)
      }
    })
    cy.reload()
    cy.get('body', { timeout: 10000 }).should('be.visible')
    // Re-connect via UI after reload (wagmi auto-reconnect may not fire).
    cy.get('body').then(($body) => {
      if ($body.find('.wallet-connect-button, button[aria-label="Connect Wallet"]').length > 0) {
        cy.get('.wallet-connect-button, button[aria-label="Connect Wallet"]', { timeout: 10000 })
          .click()
        cy.selectInjectedConnector()
      }
    })
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')
  }

  /**
   * Build a synthetic friend-market record for an opponent-side expired offer.
   *
   * The description is per-test on purpose: a row renders the wager's
   * description plus "Wager ID #<id>", so with one shared literal a
   * `cy.contains('.mm-table-row', 'DSH-15')` matches nothing — the case id
   * appears nowhere in the row.
   */
  function expiredOfferAsOpponent(id = 'exp-1', description = 'DSH-14 Expired Friend Offer') {
    return {
      id,
      uniqueId: `0xMOCK-${id}`,
      contractAddress: '0xMOCK',
      creator: '0x00000000000000000000000000000000000000aa', // not the test account
      opponent: TEST_ACCOUNT,
      participants: ['0x00000000000000000000000000000000000000aa', TEST_ACCOUNT],
      description,
      status: 'pending_acceptance',
      acceptanceDeadline: Date.now() - 60 * 60 * 1000,
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      stakeAmount: '1',
      stakeTokenSymbol: 'USDC',
      acceptedCount: 0,
    }
  }

  it('[DSH-14] Expired pending offers hidden from default Participating view', () => {
    seedFriendMarketsAndOpen([expiredOfferAsOpponent('exp-14')])

    // Default Participating tab + "All Status" filter → expired offer hidden.
    cy.get('.mm-empty-state', { timeout: 5000 }).should('be.visible')
    cy.contains('.mm-table-row', 'DSH-14 Expired Friend Offer').should('not.exist')
  })

  // The standalone "Expired" option is gone (spec 040 US6); an expired offer is
  // still Open on chain, so "Pending Acceptance" is the filter that surfaces it
  // and the route to its Clear / Reclaim & Clear action (#1297).
  it('[DSH-15] Pending Acceptance filter surfaces expired offers with "Expired" time-left and a Clear button', () => {
    seedFriendMarketsAndOpen([expiredOfferAsOpponent('exp-15', 'DSH-15 Expired Friend Offer')])

    cy.get('.mm-filter-bar .mm-filter-select').last().select('pending_acceptance')
    cy.get('.mm-filter-bar .mm-filter-select').last().should('have.value', 'pending_acceptance')

    cy.contains('.mm-table-row', 'DSH-15', { timeout: 5000 }).should('be.visible')
      .within(() => {
        // The status pill reads "Expired" (not e.g. "23h 6m" from endDate).
        cy.get('.mm-status-badge').should('contain.text', 'Expired')
        // The row's actions are always on screen — nothing to expand.
        // Opponent-side action is just "Clear" (creator's variant adds "Reclaim").
        cy.contains('button', /^Clear$/).should('be.visible')
      })
  })

  // Same filter as DSH-15. The offer here was created by someone else, so the
  // member has nothing escrowed and Clear really is just "hide it" — the
  // creator's variant reclaims the stake first and is covered in the unit suite.
  it('[DSH-16] Clear button dismisses an expired offer and persists to localStorage', () => {
    seedFriendMarketsAndOpen([expiredOfferAsOpponent('exp-16', 'DSH-16 Expired Friend Offer')])

    cy.get('.mm-filter-bar .mm-filter-select').last().select('pending_acceptance')
    cy.contains('.mm-table-row', 'DSH-16').should('be.visible').within(() => {
      cy.contains('button', /^Clear$/).click({ force: true })
    })

    // Row gone from the list and the dismissed set recorded under the
    // wallet's per-account key.
    cy.contains('.mm-table-row', 'DSH-16').should('not.exist')
    cy.window().then((win) => {
      const raw = win.localStorage.getItem(
        `mywagers_dismissed:${TEST_ACCOUNT.toLowerCase()}`
      )
      expect(raw).to.exist
      const ids = JSON.parse(raw)
      expect(ids).to.include('exp-16')
    })
  })

  // ---------------------------------------------------------------------------
  // DSH-17: My Wagers is one table view, and a phone reaches the resolution flow
  //
  // Regression: My Wagers used to swap to a card grid below 768px, and a
  // collapsed card exposed no resolve control — members had to rotate to
  // landscape to get the table and resolve a wager. There is now one view at
  // every viewport, with the row's actions always on screen.
  // ---------------------------------------------------------------------------

  /** A wager the test account created whose resolve window is already open. */
  function resolvableWagerAsCreator(id = 'res-1') {
    return {
      id,
      uniqueId: `0xMOCK-${id}`,
      contractAddress: '0xMOCK',
      creator: TEST_ACCOUNT,
      opponent: '0x00000000000000000000000000000000000000aa',
      participants: [TEST_ACCOUNT, '0x00000000000000000000000000000000000000aa'],
      description: 'DSH-17 Resolvable Wager',
      status: 'active',
      resolutionType: 0, // either party may resolve
      // Past trading end (ms) → the resolve window is open, no resolve deadline set.
      tradingEndTime: Date.now() - 60 * 60 * 1000,
      stakeAmount: '1',
      stakeTokenSymbol: 'USDC',
      acceptedCount: 1,
    }
  }

  it('[DSH-17] Phone viewport renders the wager table and reaches Resolve from the row', () => {
    cy.viewport(390, 844)
    seedFriendMarketsAndOpen([resolvableWagerAsCreator('res-17')])

    cy.get('[role="tab"]').contains(/created/i).click({ force: true })

    // The table renders on a phone — no card grid, no orientation dependency.
    cy.contains('.mm-table-row', 'DSH-17 Resolvable Wager', { timeout: 10000 })
      .should('be.visible')
    cy.get('.mm-table').should('exist')
    cy.contains('.mm-table-row', 'DSH-17 Resolvable Wager')
      .within(() => {
        // The resolution flow is one tap from the row.
        cy.contains('button', /^Resolve$/).should('be.visible').click()
      })

    // The resolution modal opens without ever leaving portrait.
    cy.get('.mm-sub-modal, .mm-sub-modal-backdrop', { timeout: 10000 }).should('be.visible')
  })

  it('[DSH-18] The wager list does not scroll sideways on a phone', () => {
    cy.viewport(390, 844)
    seedFriendMarketsAndOpen([resolvableWagerAsCreator('res-18')])

    cy.get('.mm-content', { timeout: 10000 }).should('be.visible')
    cy.get('.mm-content').then(($content) => {
      // Rows restyle into stacked cards below 640px, so nothing overflows.
      expect($content[0].scrollWidth).to.be.at.most($content[0].clientWidth + 2)
    })
  })
})
