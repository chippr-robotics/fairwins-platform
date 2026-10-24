// =============================================================================
// 22-accessibility.cy.js
// Fast-tier E2E tests for accessibility (A11Y-01..A11Y-11)
//
// Tests verify theme toggling, responsive layouts, modal accessibility,
// toast/notification patterns, form validation feedback, keyboard navigation,
// ARIA live regions, error boundary, timezone handling, and scrolling.
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('Accessibility', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  /**
   * Helper: connect wallet and visit the dashboard.
   */
  function connectAndVisit() {
    cy.mockWeb3Provider({ account: TEST_ACCOUNT })
    // Spec 073 moved the wager surface to Finance > Transfer > Wagers; `/fairwins` no longer
    // renders the quick-action grid these checks walk (same fix as bc294ec8 and siblings).
    cy.visit('/wagers')
    cy.get('body', { timeout: 10000 }).should('be.visible')

    cy.get('.wallet-connect-button, button[aria-label="Connect Wallet"]', { timeout: 10000 })
      .click()
    cy.selectInjectedConnector()
    cy.get('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 10000 })
      .should('be.visible')
  }

  // ---------------------------------------------------------------------------
  // A11Y-01: Dark/light theme toggle
  // ---------------------------------------------------------------------------
  it('[A11Y-01] Dark/light theme toggle', () => {
    connectAndVisit()

    // The ThemeToggle button should be in the header.
    cy.get('.theme-toggle', { timeout: 5000 }).should('be.visible')

    // Verify it has an accessible label.
    cy.get('.theme-toggle')
      .should('have.attr', 'aria-label')
      .and('match', /switch to (light|dark) mode/i)

    // Read the current mode from data attributes or body class.
    cy.get('.theme-toggle').invoke('attr', 'aria-label').then((label) => {
      const isDarkBefore = label.toLowerCase().includes('light')
      // Click the toggle.
      cy.get('.theme-toggle').click()

      // The label should now indicate the opposite mode.
      cy.get('.theme-toggle')
        .invoke('attr', 'aria-label')
        .should('match', isDarkBefore ? /switch to dark mode/i : /switch to light mode/i)

      // Toggle back.
      cy.get('.theme-toggle').click()
      cy.get('.theme-toggle')
        .invoke('attr', 'aria-label')
        .should('match', isDarkBefore ? /switch to light mode/i : /switch to dark mode/i)
    })
  })

  // ---------------------------------------------------------------------------
  // A11Y-02: Responsive layout mobile
  // ---------------------------------------------------------------------------
  it('[A11Y-02] Responsive layout mobile', () => {
    cy.viewport(375, 667) // iPhone SE dimensions
    cy.mockWeb3Provider({ account: TEST_ACCOUNT })

    cy.visit('/fairwins')
    cy.get('body', { timeout: 10000 }).should('be.visible')

    // The page should render without horizontal overflow.
    cy.get('body').then(($body) => {
      const bodyWidth = $body[0].scrollWidth
      const viewportWidth = Cypress.config('viewportWidth') || 375
      // scrollWidth should not exceed viewport by more than a few pixels.
      expect(bodyWidth).to.be.at.most(viewportWidth + 20)
    })

    // The header should still be visible.
    cy.get('.site-header, header[role="banner"]', { timeout: 5000 })
      .should('be.visible')

    // Key content areas should be visible.
    cy.get('.welcome-view, .dashboard-container', { timeout: 10000 })
      .should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // A11Y-03: Responsive layout tablet
  // ---------------------------------------------------------------------------
  it('[A11Y-03] Responsive layout tablet', () => {
    cy.viewport(768, 1024) // iPad dimensions
    cy.mockWeb3Provider({ account: TEST_ACCOUNT })

    cy.visit('/fairwins')
    cy.get('body', { timeout: 10000 }).should('be.visible')

    // No horizontal scroll.
    cy.get('body').then(($body) => {
      const bodyWidth = $body[0].scrollWidth
      const viewportWidth = 768
      expect(bodyWidth).to.be.at.most(viewportWidth + 20)
    })

    // Header and content should render.
    cy.get('.site-header, header[role="banner"]', { timeout: 5000 })
      .should('be.visible')
    cy.get('.welcome-view, .dashboard-container', { timeout: 10000 })
      .should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // A11Y-04: Modal accessibility (backdrop, Escape, focus trap)
  // ---------------------------------------------------------------------------
  /*
   * Un-skipped (#1019). The recorded reason — "modal control is covered at click time" — was
   * right about the symptom and pointed at the wrong control: the dialog opens fine and Escape
   * closes it. What failed was the BACKDROP CLICK, and only because of where it aimed.
   *
   * `.click('topLeft')` on a backdrop that spans the viewport means (0, 0), and the nav drawer's
   * 64px fixed gutter (z-index 1401) sits exactly there:
   *
   *   `<div class="friend-markets-modal-backdrop" …>` is being covered by another element:
   *   `<div class="app-nav-drawer-header">…`
   *
   * That is the app behaving correctly — a fixed gutter overlays the backdrop's top-left corner —
   * so the fix belongs in the test's aim, not in either component.
   *
   * TOP-CENTRE is the point, and it is the only one that works at BOTH viewport profiles.
   * Measured with elementFromPoint, modal open:
   *
   *            (2, 2)          (100, 100)      (w/2, 8)
   *   1280x720 drawer header   backdrop        backdrop
   *   390x844  backdrop        .fm-brand       backdrop
   *
   * The modal content starts at y=48 at both widths, so the strip above it is backdrop either
   * way. Corners are worse than they look: the right edge reports null, and bottom-left is the
   * section icon nav.
   */
  it('[A11Y-04] Modal accessibility (backdrop, Escape, focus trap)', () => {
    connectAndVisit()

    // Open the create wager modal via quick action.
    cy.get('.quick-action-card').contains('Friends Decide (1v1)').click()

    // The modal should open with dialog role and aria-modal.
    cy.get('[role="dialog"]', { timeout: 5000 }).should('be.visible')
    cy.get('[role="dialog"]')
      .should('have.attr', 'aria-modal', 'true')

    // Verify the close button has an aria-label.
    cy.get('[role="dialog"]').within(() => {
      cy.get('button[aria-label="Close modal"], .fm-close-btn', { timeout: 3000 })
        .should('exist')
    })

    // Press Escape to close.
    cy.get('body').type('{esc}')
    cy.get('.friend-markets-modal-backdrop, [role="dialog"]', { timeout: 5000 })
      .should('not.exist')

    // Re-open and test backdrop click.
    cy.get('.quick-action-card').contains('Friends Decide (1v1)').click()
    cy.get('[role="dialog"]', { timeout: 5000 }).should('be.visible')

    // Click the backdrop above the modal content — see the note above for why not a corner.
    cy.get('.friend-markets-modal-backdrop').click('top')
    cy.get('.friend-markets-modal-backdrop', { timeout: 5000 })
      .should('not.exist')
  })

  // ---------------------------------------------------------------------------
  // A11Y-05: Toast notifications
  // ---------------------------------------------------------------------------
  it('[A11Y-05] Toast notifications', () => {
    /*
     * ESTABLISH THE PRECONDITION: fire a real toast instead of hoping one happens to be on
     * screen. Landing on an unsupported chain with a wallet that rejects the switch (same setup
     * as 01-wallet-connection's WAL-09) reliably drives App.jsx's handleSwitchNetwork into its
     * catch branch, which calls showNotification(...) — a genuine [role="alert"] toast.
     */
    cy.mockWeb3Provider({ account: TEST_ACCOUNT, networkId: 56, rejectChainSwitch: true })
    cy.visit('/wagers')
    cy.get('body', { timeout: 10000 }).should('be.visible')
    cy.get('.wallet-connect-button, button[aria-label="Connect Wallet"]', { timeout: 10000 }).click()
    cy.selectInjectedConnector()

    cy.get('.network-error-banner .switch-network-button', { timeout: 15000 }).click()

    // The NotificationSystem renders with role="alert" and aria-live.
    cy.get('[role="alert"]', { timeout: 10000 }).first().should('have.attr', 'aria-live')
    // Its close button has an aria-label.
    cy.get('[role="alert"]').first().within(() => {
      cy.get('button[aria-label]').should('exist')
    })
  })

  // ---------------------------------------------------------------------------
  // A11Y-06: Form validation feedback
  // ---------------------------------------------------------------------------
  it('[A11Y-06] Form validation feedback', () => {
    connectAndVisit()

    // Open create wager modal.
    cy.get('.quick-action-card').contains('Friends Decide (1v1)').click()
    cy.get('[role="dialog"]', { timeout: 5000 }).should('be.visible')

    // Try to submit with empty fields — this should trigger validation errors.
    // Stake is an AmountKeypad (role="group", one button per digit, no <input>), so `.clear()`
    // has nothing to act on — clearing it means pressing backspace. Description IS a text input.
    cy.get('.fm-form').within(() => {
      cy.get('#fm-description').clear()
    })
    cy.enterAmountViaKeypad('fm-stake', '')
    cy.get('.fm-form').within(() => {
      cy.get('button[type="submit"], .fm-submit-btn').click({ force: true })
    })

    // Validation errors should appear with the .fm-error class.
    cy.get('.fm-error', { timeout: 5000 }).should('have.length.greaterThan', 0)
    cy.get('.fm-error').first().invoke('text').should('not.be.empty')

    // Verify the error class is applied to the invalid input.
    cy.get('input.error, textarea.error, select.error', { timeout: 3000 })
      .should('have.length.greaterThan', 0)
  })

  // ---------------------------------------------------------------------------
  // A11Y-07: Keyboard navigation
  // ---------------------------------------------------------------------------
  // PENDING (#1019): keyboard traversal order changed with the relocated surface.
  it.skip('[A11Y-07] Keyboard navigation', () => {
    connectAndVisit()

    // Tab through the quick action cards.
    cy.get('.quick-action-card').first().focus()
    cy.get('.quick-action-card').first().should('have.focus')

    // Each card should be focusable (they are buttons).
    cy.get('.quick-action-card').each(($card) => {
      cy.wrap($card).should('have.prop', 'tagName').and('match', /BUTTON/i)
    })

    // Verify the cards have aria-label attributes.
    cy.get('.quick-action-card').each(($card) => {
      expect($card.attr('aria-label')).to.exist
    })

    // Tab navigation should work — press Tab and verify focus moves.
    cy.get('.quick-action-card').first().focus()
    cy.realPress ? cy.realPress('Tab') : cy.focused().tab()
    // We can't reliably test Tab without cy.realPress, so just verify
    // the cards are keyboard-accessible with Enter.
    cy.get('.quick-action-card').first().focus()
    cy.get('.quick-action-card').first().type('{enter}')

    // The modal should open.
    cy.get('[role="dialog"]', { timeout: 5000 }).should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // A11Y-08: Screen reader announcements (ARIA live regions)
  // ---------------------------------------------------------------------------
  it('[A11Y-08] Screen reader announcements (ARIA live regions)', () => {
    connectAndVisit()

    // The AnnouncementRegion component should be present in the DOM.
    // It provides aria-live regions for screen reader announcements.
    cy.get('[aria-live], [role="status"], [role="alert"]', { timeout: 5000 })
      .should('have.length.greaterThan', 0)

    // Verify at least one live region has the correct aria-live value.
    cy.get('[aria-live]').then(($regions) => {
      const liveValues = $regions.toArray().map((el) => el.getAttribute('aria-live'))
      const hasValidLive = liveValues.some((v) => v === 'polite' || v === 'assertive')
      expect(hasValidLive).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // A11Y-09: Error boundary
  // ---------------------------------------------------------------------------
  it('[A11Y-09] Error boundary', () => {
    // The ErrorBoundary component renders a fallback UI with role="alert".
    // We verify its structure exists in the codebase by loading the page and
    // checking that the app doesn't crash.
    cy.mockWeb3Provider({ account: TEST_ACCOUNT })
    cy.visit('/fairwins')
    cy.get('body', { timeout: 10000 }).should('be.visible')

    // The app should load without hitting the error boundary.
    cy.get('.error-boundary').should('not.exist')

    // Verify the page content renders (not stuck in error state).
    cy.get('.welcome-view, .dashboard-container, .site-header', { timeout: 10000 })
      .should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // A11Y-10: Timezone handling
  // ---------------------------------------------------------------------------
  // PENDING (#1019): asserts `#fm-end-date` / a datetime-local input; FriendMarketsModal renders neither.
  it.skip('[A11Y-10] Timezone handling', () => {
    connectAndVisit()

    // Open create wager modal to test the datetime input.
    cy.get('.quick-action-card').contains('Friends Decide (1v1)').click()
    cy.get('[role="dialog"]', { timeout: 5000 }).should('be.visible')

    // The datetime-local input should have a min and max constraint.
    cy.get('#fm-end-date, input[type="datetime-local"]', { timeout: 5000 })
      .should('be.visible')
      .should('have.attr', 'min')
      .and('not.be.empty')

    cy.get('#fm-end-date, input[type="datetime-local"]')
      .should('have.attr', 'max')
      .and('not.be.empty')

    // The derived timeline tiles (Accept by / Ends / Resolve by) should
    // render with a real clock value, not the em-dash placeholder.
    cy.get('.fm-stat-tile.is-accept .fm-stat-time', { timeout: 3000 })
      .should('be.visible')
      .invoke('text')
      .should('not.be.empty')
      .and('not.equal', '—') // Not the em-dash placeholder
  })

  // ---------------------------------------------------------------------------
  // A11Y-11: Scrolling behavior
  // ---------------------------------------------------------------------------
  // PENDING (#1019): `.how-it-works-card` exists nowhere in src — decide whether the section stays (same as DSH-08).
  it.skip('[A11Y-11] Scrolling behavior', () => {
    connectAndVisit()

    // The dashboard should have scrollable content.
    cy.get('.dashboard-container', { timeout: 10000 }).should('be.visible')

    // Scroll to the bottom of the page.
    cy.scrollTo('bottom')

    // The how-it-works section should be near the bottom.
    cy.get('.how-it-works-card', { timeout: 5000 }).should('be.visible')

    // Scroll back to top.
    cy.scrollTo('top')

    // The quick actions should be visible again.
    cy.get('.quick-actions-grid', { timeout: 5000 }).should('be.visible')

    // Test modal scrolling — open My Wagers which can have scrollable content.
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 5000 }).should('be.visible')

    // The modal content area should exist and be scrollable if content overflows.
    cy.get('.mm-content', { timeout: 5000 }).should('be.visible')

    // Close the modal.
    cy.get('.mm-close-btn, button[aria-label="Close modal"]').click()
    cy.get('.my-markets-modal').should('not.exist')

    // Page should still be scrollable after modal closes.
    cy.scrollTo('bottom')
    cy.get('.how-it-works-card').should('exist')
  })

  // ---------------------------------------------------------------------------
  // A11Y-12..15 (spec 094): the real ruleset, not hand-written checks.
  //
  // These replace the old `[A11Y-BONUS] checkA11y` test, which was skipped AND, when it ran,
  // guarded both of its loops with `if ($els.length > 0)` — it passed on a surface with no visible
  // images and no visible buttons having checked nothing.
  //
  // Serious and critical violations fail. #1019's unnamed "Open menu" control is suppressed by rule
  // with its issue named, so the exception stays countable rather than silently disabling the test.
  // ---------------------------------------------------------------------------
  const KNOWN = [
    // The menu trigger has no accessible name; the name itself is still undecided (#1019).
    { rule: 'button-name', issue: '#1019' },
    // #1247's color-contrast suppression came off here: the quick-action group headers
    // and their secondary/tag text now read from --accent-color / --text-secondary
    // (Dashboard.css), both audited ≥4.5:1 on every background they render over in
    // both themes (frontend/src/test/brand/tokenContrast.test.js).
  ]

  it('[A11Y-12] Dashboard has no serious or critical violations', () => {
    connectAndVisit()
    cy.get('.quick-actions-grid', { timeout: 10000 }).should('be.visible')
    cy.a11yScan({ disableRules: KNOWN, label: 'wagers dashboard' })
  })

  it('[A11Y-13] The landing page has no serious or critical violations', () => {
    cy.visit('/')
    cy.get('body', { timeout: 10000 }).should('be.visible')
    cy.a11yScan({ disableRules: KNOWN, label: 'landing' })
  })

  it('[A11Y-14] An open modal is scanned as the modal, not the page behind it', () => {
    connectAndVisit()
    cy.get('.quick-action-card').contains('My Wagers').click()
    cy.get('[role="dialog"], .my-markets-modal', { timeout: 10000 }).should('be.visible')

    /*
     * SCOPED to the dialog on purpose. The app portals its modals, so a document-wide scan reports
     * violations from the page underneath and attributes them to the modal under test — the same
     * mistake as an unscoped cy.contains, and just as invisible.
     */
    cy.get('[role="dialog"], .my-markets-modal').then(($modal) => {
      cy.a11yScan({ context: $modal[0], disableRules: KNOWN, label: 'My Wagers modal' })
    })
  })

  it('[A11Y-15] Every control the dashboard needs is reachable at the active viewport', () => {
    connectAndVisit()

    // Present is not reachable: `be.visible` passes for an element scrolled outside a clipping
    // ancestor, which is exactly how a phone layout breaks without any test noticing.
    cy.assertReachable('.quick-actions-grid')
    cy.assertReachable('.theme-toggle')
    cy.assertReachable('.wallet-account-button, button[aria-label="Wallet Account"]')
  })
})
