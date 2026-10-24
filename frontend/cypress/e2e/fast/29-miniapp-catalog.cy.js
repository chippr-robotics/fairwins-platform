// =============================================================================
// 29-miniapp-catalog.cy.js
// Fast-tier E2E tests for the Apps catalogue (specs 073 + 077).
//
// Issue #1238, flow `miniapp.browse-catalog`.
//
// ── WHY THIS IS IN THE NO-CHAIN TIER ────────────────────────────────────────
// Browsing is reading, filtering and pinning. Nothing here signs, nothing
// settles, and no member value is at risk — so the e2e admission rule
// (docs/developer-guide/e2e-testing-policy.md) puts it here rather than in the
// on-chain tier, which costs a private chain per shard.
//
// The registry read is answered by `cy.intercept` over the Polygon RPC the
// mainnet build resolves, with results ABI-encoded on the Node side by the
// `miniappCatalogWorld` task using the app's own ABI fragment. So the app does
// its real read, its real decode and its real filtering; only the transport is
// ours. What could NOT be measured this way — that the bytes behind a listing
// are the bytes the chain approved — is exactly what the on-chain tier's
// 32-miniapps.cy.js measures, and it needs a chain precisely because it is
// about the chain.
//
// The four registry states are the point of this surface. "No registry on this
// build", "the registry could not be read", "the registry answered and holds
// nothing", and "this is what it said a while ago" are four different facts,
// and only ONE of them is an empty list. A catalogue that renders an
// unreachable registry as an empty grid tells a member that nothing is
// approved — which is indistinguishable from a curator having just suspended a
// compromised app.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const CATALOG_URL = '/wallet?tab=apps'

/** Polygon is the mainnet build's registry home (`miniAppChainId()`), reached over publicnode. */
// BOTH rails, or the stub is a lie: since 480720bf every EVM mainnet has a drpc.org FAILOVER,
// so makeReadProvider builds a FallbackProvider — a stub that fails only the publicnode primary
// is answered by LIVE drpc, and "the chain is unreachable" quietly becomes "the chain answered
// tier 0 from production" (issue #1463; spec 42 and the passkey suite hit the same class).
const RPC_PATTERN = /publicnode\.com|drpc\.org/

const APPS = [
  { id: 1, name: 'Token Mint', category: 0, version: 3 },
  { id: 2, name: 'ClearPath', category: 3, version: 2 },
  // Launchable but in review: a vendor with an update pending is STILL serving members. It has to
  // appear, because gating the catalogue on `status` would hand every vendor an offline switch for
  // their own live app.
  { id: 3, name: 'Ledger Notes', category: 5, status: 0, launchable: true, version: 1 },
  // Not launchable — suspended. It must NOT appear.
  { id: 4, name: 'Withdrawn Widget', category: 2, status: 2, launchable: false, version: 1 },
]

/**
 * Serve `answers` (selector -> encoded result) for every registry read, and answer the handful of
 * chain-plumbing calls a provider makes on the way. Anything else returns '0x', which ethers
 * rejects — so an unanswered read surfaces as this app's honest unavailable state rather than as a
 * fabricated value.
 */
function stubRegistry(answers, { fail = false } = {}) {
  cy.intercept({ method: 'POST', url: RPC_PATTERN }, (req) => {
    const body = req.body
    const one = (payload) => {
      const { method, params, id } = payload
      if (fail) return { jsonrpc: '2.0', id, error: { code: -32000, message: 'registry unreachable' } }
      let result
      switch (method) {
        case 'eth_chainId':
          result = '0x89'
          break
        case 'net_version':
          result = '137'
          break
        case 'eth_blockNumber':
          result = '0x4000000'
          break
        case 'eth_getCode':
          result = '0x60806040'
          break
        case 'eth_call':
          result = answers[String(params?.[0]?.data || '').slice(0, 10)] ?? '0x'
          break
        default:
          result = '0x'
      }
      return { jsonrpc: '2.0', id, result }
    }
    req.reply({
      statusCode: 200,
      body: Array.isArray(body) ? body.map(one) : one(body || {}),
    })
  }).as('registryRpc')
}

const openCatalog = () => {
  cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true })
  cy.visit(CATALOG_URL)
  cy.get('.miniapp-catalog', { timeout: 40000 }).should('exist')
}

describe('Apps catalogue (specs 073 + 077)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[MC-01] miniapp.browse-catalog — lists what the chain says is launchable, searches it, and pins one to Quick Access', () => {
    cy.task('miniappCatalogWorld', { apps: APPS }).then(({ answers, count }) => {
      expect(count, 'the world holds every record, launchable or not').to.equal(APPS.length)
      stubRegistry(answers)
      openCatalog()

      // ── `launchable`, never `status`. ────────────────────────────────────────────────
      cy.get('.miniapp-row-name').should('have.length.greaterThan', 0)
      cy.contains('.miniapp-row', 'Token Mint').should('exist')
      cy.contains('.miniapp-row', 'ClearPath').should('exist')
      // Pending-with-a-prior-approval is a LIVE app. Its presence is the whole rule.
      cy.contains('.miniapp-row', 'Ledger Notes').should('exist')
      // Suspended is not.
      cy.contains('.miniapp-row', 'Withdrawn Widget').should('not.exist')

      // The version chip is the APPROVED version — the one members would run — not the proposal's.
      cy.contains('.miniapp-row', 'Token Mint').find('.miniapp-row-chip').should('contain.text', 'v3')

      // ── Search narrows the list, and narrowing it is not the same as emptying it. ────
      // Scoped to the catalogue. At the phone width the nav drawer contributes its own search
      // field (spec 081), so the bare selector matches two inputs — and only one of them filters
      // this list.
      cy.get('.miniapp-catalog input[type="search"]').type('clear')
      cy.contains('.miniapp-row', 'ClearPath').should('exist')
      cy.contains('.miniapp-row', 'Token Mint').should('not.exist')
      cy.get('.miniapp-catalog input[type="search"]').clear()
      cy.contains('.miniapp-row', 'Token Mint').should('exist')

      // ── Pin one to Quick Access, through the sheet where the action lives. ──────────
      cy.contains('.miniapp-row', 'ClearPath').find('.miniapp-row-tap').click()
      cy.get('.miniapp-sheet[role="dialog"]').should('be.visible')
      cy.get('.miniapp-sheet-favorite').should('have.attr', 'aria-pressed', 'false').click()
      cy.get('.miniapp-sheet-favorite').should('have.attr', 'aria-pressed', 'true')
      cy.get('.miniapp-sheet-close').click()

      // The row says so too — one favorite, one indicator, no second source of truth.
      cy.contains('.miniapp-row', 'ClearPath').find('.miniapp-row-chip.is-favorite').should('exist')
      cy.contains('.miniapp-row', 'Token Mint').find('.miniapp-row-chip.is-favorite').should('not.exist')

      // A pin is device-scoped and survives a reload — that is what makes it a shortcut rather
      // than a session decoration.
      cy.reload()
      cy.get('.miniapp-catalog', { timeout: 40000 }).should('exist')
      cy.contains('.miniapp-row', 'ClearPath').find('.miniapp-row-chip.is-favorite').should('exist')
    })
  })

  it('[MC-02] miniapp.browse-catalog — an unreadable registry is said out loud, never rendered as an empty catalogue', () => {
    /*
     * This is the failure mode the surface exists to avoid, and it is not hypothetical: an app
     * suspended for a security problem and a registry that has gone quiet produce the SAME empty
     * list. Only one of them means "nothing is approved". So the unreachable branch has to say
     * which it is, and it has to refuse launches while it cannot tell.
     */
    stubRegistry({}, { fail: true })
    openCatalog()

    cy.get('.miniapp-catalog-unverified', { timeout: 40000 })
      .should('be.visible')
      .and('have.attr', 'role', 'alert')
    cy.get('.miniapp-catalog-state-title').should('contain.text', 'can’t be verified')

    // Nothing is offered for launch while the registry cannot be read.
    cy.get('.miniapp-row').should('not.exist')
  })

  it('[MC-03] miniapp.browse-catalog — a registry that answers and holds nothing is a different sentence again', () => {
    /*
     * The honest empty case. It reads as an empty state rather than as an alert, and — the part
     * that matters — it does NOT claim anything is wrong, because nothing is.
     */
    cy.task('miniappCatalogWorld', { apps: [] }).then(({ answers }) => {
      stubRegistry(answers)
      openCatalog()

      cy.get('.miniapp-row').should('not.exist')
      cy.get('.miniapp-catalog-unverified').should('not.exist')
    })
  })
})
