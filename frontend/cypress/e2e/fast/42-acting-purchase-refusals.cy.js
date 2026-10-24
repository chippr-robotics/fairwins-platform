// =============================================================================
// 42-acting-purchase-refusals.cy.js
// Fast-tier E2E for spec 098's eligibility gate: which acting accounts may buy a
// membership, and what the ones that may not are TOLD.
//
// Flow: purchase.acting-refusals
//   "Purchase still refuses, with the reason, when the acting account cannot be
//    msg.sender on the membership chain."
//
// ── WHY NO CHAIN (admission rule 1) ─────────────────────────────────────────────
// Everything asserted here is decided in the client BEFORE any signature.
// `PremiumPurchaseModal.purchaseRail` (frontend/src/components/ui/PremiumPurchaseModal.jsx:171-196)
// resolves eligibility from the acting kind and the acting account's recorded chain
// against `membershipChainId()` — no contract call is involved in the decision, and a
// refused state produces no transaction, intent or proposal at all. Putting that in the
// on-chain tier would be a chain started to observe an outcome the chain never sees. The
// rails that DO cost money (a vault's proposal, a recovered account's own signature) are
// judged on chain in full/40-acting-account-purchase.cy.js.
//
// ── THE WORLD, AND WHY IT IS STUBBED ────────────────────────────────────────────
// The membership modal's Confirm button is disabled by SIX independent conditions
// (PremiumPurchaseModal.jsx:1341) — busy, disconnected, wrong chain, unreadable tier,
// unticked attestation, ineligible acting account. Asserting "disabled" proves nothing
// about the refusal unless the other five are known-satisfied, so this spec builds a world
// where they are: the wallet sits on the membership chain (Polygon in a no-chain build,
// `membershipChainId()` → MAINNET_CHAIN_ID), `getActiveTier` answers a real 0 so the tier is
// READABLE, and every attestation box is ticked. The only thing that changes between
// APR-01 and APR-02/03 is which account the member is acting as — so an enabled button in
// one and a disabled one in the other is attributable to eligibility and nothing else.
//
// Only `getActiveTier` is answered. Everything else returns `0x`, which ethers rejects, so a
// read this world does not model surfaces as the app's own fallback state rather than as a
// fabricated value (the same narrow-stub discipline as fast/31-identity-access.cy.js).
//
// ── WHAT IS NOT COVERED HERE, AND WHY ───────────────────────────────────────────
// FR-003's second refusal branch ("<account> has no sending identity on <chain>") is reached
// only by acting kind `derived`. `CustodyContext` exposes exactly four ways to change the
// acting identity — personal / vault / legacy / hardware (frontend/src/contexts/CustodyContext.jsx)
// — and none of them produces `derived`, so no member-facing route into that state exists yet.
// It is left to the matrix's `missing` rather than manufactured by writing React state a
// member cannot reach.
//
// Checklist: APR-01..APR-03
// =============================================================================

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

// A vault the member holds on a custody chain that is NOT the membership chain. All-digit
// addresses so `getAddress` (vaultReferences.sanitize) accepts them without a checksum quarrel.
const OTHER_CHAIN_VAULT = '0x1111111111111111111111111111111111111111'
const HOME_CHAIN_VAULT = '0x3333333333333333333333333333333333333333'
const HARDWARE_ACCOUNT = '0x2222222222222222222222222222222222222222'

// The membership chain in a no-chain build: `getCurrentChainId()` has no VITE_NETWORK_ID to
// read, so it answers PRIMARY_CHAIN_ID (137), which is a mainnet — `membershipChainId()`
// therefore resolves to MAINNET_CHAIN_ID. Both of Polygon's build endpoints are stubbed
// because the read provider is a quorum-1 FallbackProvider over the pair (rpcProvider.js).
const MEMBERSHIP_CHAIN = 137
const MEMBERSHIP_NETWORK_NAME = 'Polygon'
const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com'
// Matched as PATTERNS, not exact strings: ethers may normalise a trailing slash onto the URL it
// posts to, and an intercept that silently matched nothing would leave the tier unreadable and
// every assertion below attributable to the wrong cause (fast/31-identity-access.cy.js does the
// same for the same reason).
const POLYGON_RPC_PATTERN = /polygon-bor-rpc\.publicnode\.com/
const POLYGON_FAILOVER_PATTERN = /polygon\.drpc\.org/

// The other custody chain, named in the refusal. Its endpoints are taken down so the vault row
// is genuinely unreachable — the estate still lists it, which is the point of spec 068's
// per-vault isolation, and this spec never needs to read it.
const OTHER_CHAIN = 8453
const OTHER_NETWORK_NAME = 'Base'
const BASE_RPC_PATTERN = /base-rpc\.publicnode\.com/
const BASE_FAILOVER_PATTERN = /base\.drpc\.org/

// MembershipManager.getActiveTier(address,bytes32) — the ONE read this world answers.
const SEL_GET_ACTIVE_TIER = '0xcfe099d2'
const TIER_NONE = `0x${'0'.repeat(64)}`

/** Answer the membership chain's reads: a real, readable tier of None. */
function stubMembershipChain() {
  const handler = (req) => {
    const one = ({ method, params, id }) => {
      switch (method) {
        case 'eth_chainId':
          return { jsonrpc: '2.0', id, result: `0x${MEMBERSHIP_CHAIN.toString(16)}` }
        case 'net_version':
          return { jsonrpc: '2.0', id, result: String(MEMBERSHIP_CHAIN) }
        case 'eth_blockNumber':
          return { jsonrpc: '2.0', id, result: '0x4000000' }
        case 'eth_getCode':
          return { jsonrpc: '2.0', id, result: '0x60806040' }
        case 'eth_call': {
          const data = String(params?.[0]?.data || '')
          return {
            jsonrpc: '2.0',
            id,
            result: data.startsWith(SEL_GET_ACTIVE_TIER) ? TIER_NONE : '0x',
          }
        }
        default:
          return { jsonrpc: '2.0', id, result: '0x' }
      }
    }
    req.reply({ statusCode: 200, body: Array.isArray(req.body) ? req.body.map(one) : one(req.body || {}) })
  }
  cy.intercept({ method: 'POST', url: POLYGON_RPC_PATTERN }, handler).as('membershipRpc')
  cy.intercept({ method: 'POST', url: POLYGON_FAILOVER_PATTERN }, handler)
  cy.intercept({ method: 'POST', url: BASE_RPC_PATTERN }, { forceNetworkError: true })
  cy.intercept({ method: 'POST', url: BASE_FAILOVER_PATTERN }, { forceNetworkError: true })
}

/**
 * The mocked wallet, plus a RECORDER over its `request` so a spec can assert that a refused
 * purchase signed, sent and proposed nothing.
 *
 * Registered inside `.then()` deliberately: `cy.on(...)` runs synchronously while
 * `cy.mockWeb3Provider()` only enqueues a command, so a wrapper written after it in source
 * order would otherwise install itself BEFORE `win.ethereum` exists and wrap nothing at all
 * (the trap full/02-membership.cy.js MEM-12 documents).
 */
function connectRecording() {
  cy.mockWeb3Provider({
    account: OWNER,
    preAuthorized: true,
    networkId: MEMBERSHIP_CHAIN,
    rpcUrl: POLYGON_RPC,
  }).then(() => {
    cy.on('window:before:load', (win) => {
      const original = win.ethereum && win.ethereum.request
      win.__cySeenMethods = []
      if (original) {
        win.ethereum.request = (args) => {
          win.__cySeenMethods.push(args?.method)
          return original(args)
        }
      }
    })
  })
}

/** Seed the member's saved vaults + hardware accounts, as the app itself stores them. */
function seedAccounts(win) {
  win.localStorage.setItem(
    `fw_user_${OWNER.toLowerCase()}_custody_vault_references`,
    JSON.stringify([
      { address: OTHER_CHAIN_VAULT, chainId: OTHER_CHAIN, label: 'Ops Treasury', addedAt: 1, role: 'owner' },
      { address: HOME_CHAIN_VAULT, chainId: MEMBERSHIP_CHAIN, label: 'Home Treasury', addedAt: 2, role: 'owner' },
    ]),
  )
  win.localStorage.setItem(
    `fw_user_${OWNER.toLowerCase()}_hardware_accounts`,
    JSON.stringify({
      [HARDWARE_ACCOUNT.toLowerCase()]: {
        address: HARDWARE_ACCOUNT,
        vendor: 'ledger',
        path: "m/44'/60'/0'/0/0",
        label: 'Cold storage',
        addedAt: 1,
      },
    }),
  )
}

function openMembershipTab() {
  cy.visit('/wallet?tab=membership', { onBeforeLoad: seedAccounts })
  cy.get('.membership-section', { timeout: 40000 }).should('exist')
}

/**
 * Switch the acting identity through the ONE control that changes it — the caret on the
 * wallet biticon. Scrolled to the top first: the button lives in a position:fixed header and
 * is refused as "covered" from a scrolled page.
 */
function actAs(optionText, expectedAddress) {
  cy.scrollTo('top', { ensureScrollable: false })
  cy.get('.wallet-account-button', { timeout: 30000 }).should('be.visible').click()
  cy.get('.account-identity-trigger', { timeout: 30000 }).click()
  cy.get('.account-switch-menu').contains('.account-switch-opt', optionText).click()
  // Being somebody else has to be VISIBLE before anything else is asserted about it.
  cy.get('.account-address-full', { timeout: 30000 })
    .invoke('attr', 'title')
    .should('eq', expectedAddress)
  // Close the dropdown so it cannot cover the membership panel at 390px.
  cy.get('body').type('{esc}')
  cy.get('.account-switch-menu').should('not.exist')
}

/**
 * Open the purchase modal from the Membership tab and drive it to the Review step with the
 * attestation satisfied.
 *
 * The Membership tab's button is the entry that exists in EVERY membership state (WalletPage.jsx
 * :480-499) — the dropdown's "Get Access" upsell renders only for a definitely-inactive read, so
 * it is not a stable door for a spec that also acts as accounts the modal refuses.
 */
function openReviewStep() {
  cy.get('.membership-section .get-roles-btn', { timeout: 30000 }).click()
  cy.get('.ppm-overlay', { timeout: 30000 }).should('exist')
  cy.get('.ppm-tier-card', { timeout: 30000 }).should('have.length.at.least', 1)
  cy.get('.ppm-overlay').contains('button', /^Continue$/).click()
  /*
   * Every attestation, not a named subset: `allTicked` is what enables Confirm, and a new
   * statement added to that block must not silently stop being confirmed here. The Review panel
   * scrolls inside a position:fixed overlay, so this targets the CONTROLS rather than asserting
   * visibility on the panel.
   */
  cy.get('.ppm-panel input[type="checkbox"]', { timeout: 30000 })
    .should('have.length.at.least', 1)
    .check({ force: true })
  cy.get('.ppm-settlement-note', { timeout: 30000 }).should('exist')
}

/** The refusal card, distinguished from the wrong-network card that shares its class. */
const refusalCard = () =>
  cy.contains('.ppm-overlay .ppm-network-warning', 'This account cannot hold a membership bought here')

describe('Membership purchase — acting-account eligibility (spec 098)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    stubMembershipChain()
    connectRecording()
  })

  // ---------------------------------------------------------------------------
  // APR-01 — a vault that exists only on another chain: refused, by name, before
  // anything is signed
  // ---------------------------------------------------------------------------
  it('[APR-01] refuses a vault on another chain, naming the vault and both networks', () => {
    openMembershipTab()
    actAs('Ops Treasury', OTHER_CHAIN_VAULT)
    openReviewStep()

    /*
     * FR-003/US4: the reason is SPECIFIC. "Switch back to your personal wallet" told a member
     * nothing about whether switching accounts, switching chains, or nothing at all would help;
     * this copy names the account, the chain memberships live on, and the chain this vault lives
     * on — and states that nothing was proposed.
     */
    refusalCard()
      .should('contain.text', `Memberships live on ${MEMBERSHIP_NETWORK_NAME}`)
      .and('contain.text', 'Ops Treasury')
      .and('contain.text', `exists only on ${OTHER_NETWORK_NAME}`)
      .and('contain.text', 'Nothing has been proposed')

    // The disclosure and the refusal agree about WHICH account is in play — a refusal naming one
    // account over an order summary naming another would be worse than no refusal at all.
    cy.get('.ppm-recipient-badge').should('contain.text', 'Ops Treasury')

    // In this world the other five disable conditions are satisfied (see the header), so the
    // refusal is the only thing holding the button.
    cy.get('.ppm-btn-purchase').should('be.disabled')

    /*
     * FR-003: "refused BEFORE any signature ... produces no signature, transaction, or proposal."
     * The recorder's own presence is asserted first — a wrapper that failed to install would
     * make an empty list look like proof.
     */
    cy.window().then((win) => {
      const seen = win.__cySeenMethods
      expect(seen, 'the provider recorder was installed').to.be.an('array')
      expect(seen, `provider methods seen: ${seen.join(', ')}`).to.not.include('eth_sendTransaction')
      expect(seen, `provider methods seen: ${seen.join(', ')}`).to.not.include('eth_signTypedData_v4')
      expect(seen, `provider methods seen: ${seen.join(', ')}`).to.not.include('wallet_sendCalls')
    })
  })

  // ---------------------------------------------------------------------------
  // APR-02 — a hardware account is ELIGIBLE: the blanket refusal is gone (SC-004)
  // ---------------------------------------------------------------------------
  it('[APR-02] offers the purchase to a hardware account, credited and paid by that account', () => {
    openMembershipTab()
    actAs('Cold storage', HARDWARE_ACCOUNT)
    openReviewStep()

    // No refusal of ANY kind: this asserts the absence of the whole `.ppm-network-warning` class,
    // which also covers the wrong-network card — the wallet really is on the membership chain.
    cy.get('.ppm-overlay .ppm-network-warning').should('not.exist')

    // FR-010: one place names who is credited, who pays, and where it settles.
    cy.get('.ppm-settlement-note')
      .should('contain.text', 'credited to')
      .and('contain.text', 'Cold storage')
      .and('contain.text', "Cold storage's own USDC")
      .and('contain.text', `Memberships are held on ${MEMBERSHIP_NETWORK_NAME}`)
    cy.get('.ppm-recipient-badge').should('contain.text', 'Cold storage')

    /*
     * THE CONTRAST THAT MAKES APR-01 MEAN SOMETHING. Same world, same steps, same six disable
     * conditions — only the acting account differs, and here the control is open. Before spec 098
     * this button was disabled for every acting account there was.
     */
    cy.get('.ppm-btn-purchase').should('not.be.disabled')
  })

  // ---------------------------------------------------------------------------
  // APR-03 — the refusal is about the CHAIN, not about vaults
  // ---------------------------------------------------------------------------
  it('[APR-03] offers the vault rail to a vault that lives on the membership chain', () => {
    openMembershipTab()
    actAs('Home Treasury', HOME_CHAIN_VAULT)
    openReviewStep()

    cy.get('.ppm-overlay .ppm-network-warning').should('not.exist')

    // FR-005/FR-010: a vault's outcome is a PROPOSAL, and the member is told so before signing —
    // the disclosure that distinguishes this rail from every other one.
    cy.get('.ppm-settlement-note')
      .should('contain.text', "the vault's own USDC")
      .and('contain.text', 'Confirming creates a')
      .and('contain.text', 'proposal')
      .and('contain.text', "activates when the vault")
    cy.get('.ppm-recipient-badge').should('contain.text', 'Home Treasury')
    cy.get('.ppm-btn-purchase').should('not.be.disabled')
  })
})
