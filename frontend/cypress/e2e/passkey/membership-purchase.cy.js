// =============================================================================
// spec 041 SC-002 / FR-016 — a passkey member BUYS MEMBERSHIP, and the chain says
// who paid for the gas.
//
// ACCOUNT-NATIVE TIER, full stack (chain + EntryPoint v0.6 + alto + the verifying
// paymaster + the relay gateway's /v1/paymaster). Admission rule 2 makes the tier
// mandatory rather than optional: the member signs a batch that moves their USDC,
// so the claim has to be settled against a chain. It also cannot be faked lower
// down — `sponsorPaymasterUrl` resolves at BUILD time (networks.js#passkeyConfig
// from VITE_SPONSOR_PAYMASTER_AMOY), so a build without it never constructs a
// paymaster transport and there is nothing to intercept, and `sendCalls` needs a
// real bundler to turn one WebAuthn ceremony into an executed UserOperation.
//
// ── WHAT THIS FILE IS FOR ──────────────────────────────────────────────────────
// It replaces `onboarding-journey.cy.js::PK-03`, which was a permanently-skipped
// sketch of "fund → membership → wager" written against three things that do not
// exist (`[data-testid="passkey-account-address"]`, `[data-testid="confirm-passkey"]`
// and a `cy.task('seedUsdc')`). Its reachable halves are already covered —
// first-use activation and a funded passkey account moving real money ride
// `sponsored-userop.cy.js::SU-01` — and the half that was NOT covered is this one:
// driving the multi-step PremiumPurchaseModal from a passkey session, which is the
// only membership rail no other spec exercises (`full/40-acting-account-purchase.cy.js`
// covers the vault and acting-signer rails and says explicitly that the passkey
// batch is out of its reach).
//
// ── THE TWO FACTS, EACH READ FROM THE CHAIN ───────────────────────────────────
// FR-016 is "approve + purchase in ONE ceremony", and spec 050 decides who pays for
// it. So each test pins the same two halves from opposite sides:
//
//   MP-01 sponsored   — the account holds ZERO native token before and after, and the
//                       paymaster's EntryPoint deposit FELL. An ERC-4337 operation is
//                       prefunded by its sender or by a paymaster and by nothing else,
//                       so an op that landed from an account that never held native was
//                       paid for by the pool. The membership itself is `getActiveTier`,
//                       and the price is the USDC delta — never the dialog that just
//                       claimed both.
//   MP-02 refused     — sponsorship is switched off AT THE GATEWAY (SIGUSR2, the real
//                       kill switch), and the purchase still lands, self-funded: native
//                       falls, the pool does not move. That is the never-stranded rule
//                       (spec 050 FR-020) on the membership money path.
//
// ── ON DISCLOSURE ─────────────────────────────────────────────────────────────
// The one cost the confirm UI states is the price: `Confirm Purchase ($X USDC)` and
// the settlement note's "credited to … paid from …". Both tests assert that quoted
// figure against the tier's ON-CHAIN price AND against what actually left the account,
// which is what makes the quote falsifiable. The modal makes no statement about the
// NETWORK fee at all — unlike the transfer surface, which badges "⚡ Gasless · sponsored"
// vs "Network fee applies" (TransferForm.jsx:424-427). That is honest on the sponsored
// path (nothing is charged beyond the price) and under-disclosed on the self-funded
// one; the gap is reported rather than asserted here, because a test that pinned the
// silence would make it permanent.
//
// Sub-issue of #1400 (closes #1407). Checklist: MP-01, MP-02
// =============================================================================

import {
  addVirtualAuthenticator,
  choosePasskey,
  connectedAddress,
  expectConnected,
  isChromium,
  resetAuthenticators,
} from '../../support/webauthn'

const BRONZE = 1
// The local payment token is the 18-dec MockERC20 (VITE_AMOY_USDC_DECIMALS=18 in
// `dev:e2e`, which `dev:e2e:passkey` wraps), which is what makes the modal's dollar
// figure comparable to the raw on-chain price below.
const TOKEN_DECIMALS = 18n

/**
 * Re-invoke a task until `check` holds, then hand the last reading back for a real
 * assertion.
 *
 * `cy.task(...).should(...)` looks equivalent and is not: `cy.task` is not a query, so
 * Cypress never re-invokes it and `should` would re-assert the same stale answer until
 * it timed out. Gives up after the budget and returns the last reading, so the
 * assertion at the call site fails with the actual number rather than with "timed out".
 */
function pollTask(task, args, check, tries = 40) {
  return cy.task(task, args).then((r) => {
    if (check(r) || tries === 0) return r
    return cy.wait(3000).then(() => pollTask(task, args, check, tries - 1))
  })
}

/** The tier MembershipManager reports for an address — the membership, from the contract. */
const pollTier = (address, want) =>
  pollTask('voucherFixture', { action: 'membership', args: { address } }, (r) => r.ok && r.tier === want)

const balances = (address) => cy.task('passkeyStack', { action: 'balances', args: { address } })

/** The modal's own dollar rendering of a raw on-chain price (`selectedPrice.toFixed(2)`). */
function priceLabel(rawPrice) {
  const whole = rawPrice / 10n ** TOKEN_DECIMALS
  const cents = (rawPrice % 10n ** TOKEN_DECIMALS) / 10n ** (TOKEN_DECIMALS - 2n)
  return `${whole}.${String(cents).padStart(2, '0')}`
}

/** Sign in with a fresh passkey and fund the account. Native stays 0 unless asked for. */
function signInAndFund({ native = '0' } = {}) {
  resetAuthenticators()
  addVirtualAuthenticator()
  cy.visit('/fairwins')
  cy.contains('button', /connect wallet/i).click()
  choosePasskey()
  expectConnected()
  return connectedAddress().then((address) => {
    /*
     * NO `ownerBytes`. The account is left COUNTERFACTUAL on purpose: FR-016 says the
     * purchase is one ceremony, and on a first-use account that ceremony has to carry the
     * deployment too. Passing ownerBytes would pre-deploy it and quietly remove the harder
     * half of the claim.
     */
    cy.task('seedUsdcForActiveSession', { address, usdc: '1000', native }).then((r) => {
      expect(r.ok, 'the passkey account was funded with USDC').to.equal(true)
      expect(r.deployed, 'and is still counterfactual — its first action deploys it').to.equal(false)
    })
    return cy.wrap(address, { log: false })
  })
}

/**
 * Open the purchase modal from the Membership tab.
 *
 * That tab's button is the entry that exists in every membership state
 * (WalletPage.jsx:486-497); the wallet dropdown's upsell renders only for a definitely
 * inactive read, which is not a stable door while a first-use account is being read.
 */
function openPurchaseModal() {
  cy.visit('/wallet?tab=membership')
  // The visit reloads, so the session has to come back through the silent reconnect (FR-003)
  // before the tab can render anything about a membership. Asserted rather than assumed: a
  // reconnect that did not happen would otherwise surface as "the button was never there".
  expectConnected()
  cy.get('.membership-section', { timeout: 40000 }).should('exist')
  cy.get('.membership-section .get-roles-btn', { timeout: 30000 }).click()
  cy.get('.ppm-overlay', { timeout: 30000 }).should('exist')
}

/**
 * Drive the modal from tier grid to the confirm click, asserting the quoted cost on the
 * way through. Returns nothing: everything worth believing is read from the chain after.
 */
function confirmBronzePurchase(rawPrice) {
  cy.contains('.ppm-tier-card', /Bronze/i, { timeout: 30000 }).click()
  cy.get('.ppm-overlay').contains('button', /^Continue$/).click()

  // FR-010: ONE place says who is credited, who pays, and where it settles. On the personal
  // passkey rail that is the member's own account, on the membership reference chain.
  cy.get('.ppm-settlement-note', { timeout: 30000 })
    .should('contain.text', 'credited to')
    .and('contain.text', 'your account')
    .and('contain.text', 'Memberships are held on')

  // Spec 007 US5: the attestations are un-pre-ticked and gate the purchase button.
  cy.get('.ppm-btn-purchase', { timeout: 30000 }).should('be.disabled')
  cy.get('.ppm-panel input[type="checkbox"]', { timeout: 30000 })
    .should('have.length.at.least', 1)
    .check({ force: true })

  /*
   * THE QUOTE. The button names the amount the member is agreeing to, and it is compared
   * against the tier price read from MembershipManager — not against a constant in this
   * file. The same figure is checked against the account's balance delta after settlement,
   * so a modal that quoted one price and charged another fails here or there.
   */
  cy.get('.ppm-btn-purchase')
    .should('not.be.disabled')
    .and('contain.text', `Confirm Purchase ($${priceLabel(rawPrice)} USDC)`)
    .click({ force: true })

  // ONE ceremony, no browser-wallet prompt, no separate on-chain approval step (FR-016).
  cy.get('.ppm-complete-title', { timeout: 180000 }).should('contain.text', 'Purchase Complete')
}

;(isChromium ? describe : describe.skip)('Membership from a passkey account (spec 041 SC-002)', () => {
  let account
  let price

  beforeEach(function () {
    // The bundler, the EntryPoint and the paymaster are all real here; a membership purchase
    // that never reached a chain would be a claim about a React step list.
    if (!Cypress.env('PASSKEY_FULL_STACK')) this.skip()
    cy.clearLocalStorage()
    cy.clearCookies()
    // Leave sponsorship ON for every test; MP-02 turns it off for itself.
    cy.task('passkeyStack', { action: 'setSponsorship', args: { enabled: true } })

    cy.task('chainTx', { action: 'membershipAdminState', args: { tier: BRONZE } }).then((r) => {
      expect(r.ok, `chainTx membershipAdminState: ${r.error || 'no error message returned'}`).to.equal(true)
      // Both stated rather than assumed: an inactive tier is never offered in the grid, and a
      // zero price would let "exactly the price was charged" pass at a charge of nothing.
      expect(r.tierActive, 'Bronze is on sale on this chain').to.equal(true)
      price = BigInt(r.tierPriceUSDC)
      // Chai's ordering assertions are not a contract for BigInt, so this compares explicitly.
      expect(price > 0n, `Bronze has a real on-chain price to charge (got ${price})`).to.equal(true)
    })
  })

  /*
   * RESTORE THE GATEWAY. MP-02 pauses sponsorship at the deployment, and the specs that run
   * after this file in the job's --spec list would then meet a paymaster that refuses. In an
   * `afterEach` so it runs even when the test fails half way through, which is exactly when
   * the switch would otherwise be left off.
   */
  afterEach(() => {
    if (!Cypress.env('PASSKEY_FULL_STACK')) return
    cy.task('passkeyStack', { action: 'setSponsorship', args: { enabled: true } })
  })

  // ---------------------------------------------------------------------------
  // MP-01 — the sponsored purchase: one ceremony, the tier lands, and the member's
  // native balance never moves
  // ---------------------------------------------------------------------------
  it('[MP-01] buys Bronze in one ceremony from a zero-native passkey account, and FairWins pays the gas', () => {
    signInAndFund().then((address) => {
      account = address
    })

    cy.then(() => {
      balances(account).as('memberBefore')
      cy.task('passkeyStack', { action: 'deposit' }).as('poolBefore')
    })

    cy.get('@memberBefore').then((m) => {
      expect(BigInt(m.native), 'the account holds NO native token, so it cannot pay its own gas').to.equal(0n)
    })
    cy.then(() => pollTier(account, 0)).then((r) => {
      expect(r.tier, 'a fresh passkey account holds no membership').to.equal(0)
    })

    cy.then(() => {
      openPurchaseModal()
      confirmBronzePurchase(price)
    })

    // (a) THE MEMBERSHIP. `getActiveTier` on MembershipManager — the contract's own answer to
    // "is this account entitled", which is what every gate in the app reads.
    cy.then(() => pollTier(account, BRONZE)).then((r) => {
      expect(r.tier, 'the batched purchase credited the passkey account itself').to.equal(BRONZE)
    })

    // (b) THE PRICE. Exactly what the button quoted left the account — no more (a batch that
    // over-approved and over-charged would land the same tier) and no less.
    cy.get('@memberBefore').then((before) => {
      balances(account).then((after) => {
        expect(BigInt(before.usdc) - BigInt(after.usdc), 'exactly the Bronze price left the account')
          .to.equal(price)
        // (c) THE PROOF THAT IT WAS SPONSORED. The sender still holds zero native, so it
        // prefunded nothing — and a UserOperation is prefunded by its sender or a paymaster.
        expect(BigInt(after.native), 'the member paid no gas — their native balance never moved').to.equal(0n)
      })
    })

    // (d) The same fact from the paymaster's side. Strict, not "non-increasing": gas on this
    // chain is never free, so a deposit that did not move would mean nothing was sponsored.
    cy.get('@poolBefore').then((before) => {
      cy.task('passkeyStack', { action: 'deposit' }).then((after) => {
        // Explicit comparison: chai's ordering assertions are not a contract for BigInt.
        expect(BigInt(after.deposit) < BigInt(before.deposit), 'the paymaster deposit paid the bundler').to.equal(true)
      })
    })

    // (e) FR-016's "one ceremony" includes the account's first-use deployment: it was
    // counterfactual before this purchase and is code on chain after it. Inside `cy.then`
    // because command arguments are built at enqueue time, when `account` is still unset.
    cy.then(() => cy.task('passkeyStack', { action: 'deployed', args: { address: account } })).then((r) => {
      expect(r.deployed, 'first-use deployment rode the same sponsored batch').to.equal(true)
    })

    // (f) And the app agrees on a fresh read of the membership tab — the member sees the
    // entitlement the chain just granted, rather than only the dialog that claimed it.
    cy.get('.ppm-overlay').contains('button', /^Done$/).click()
    cy.visit('/wallet?tab=membership')
    expectConnected()
    cy.get('.membership-section .membership-status-badge.active', { timeout: 60000 }).should('exist')
  })

  // ---------------------------------------------------------------------------
  // MP-02 — sponsorship refused: the purchase still lands, self-funded (never stranded)
  // ---------------------------------------------------------------------------
  it('[MP-02] still buys Bronze when sponsorship is paused, paying its own gas and leaving the pool untouched', () => {
    // The member CAN pay here — that is the point of the fallback. Without native they would
    // be stranded, which is a different (and also honest) outcome not under test.
    signInAndFund({ native: '1' }).then((address) => {
      account = address
    })

    /*
     * Refuse at the GATEWAY, not in the browser. SIGUSR2 flips the real kill switch and the
     * task waits for /status to agree, so what refuses is the deployment's own policy — an
     * intercept would only prove the client can handle a refusal the test invented.
     */
    cy.task('passkeyStack', { action: 'setSponsorship', args: { enabled: false } }).then((r) => {
      expect(r.sponsorship, 'the gateway confirms sponsorship is paused').to.equal(false)
    })

    cy.then(() => {
      balances(account).as('memberBefore')
      cy.task('passkeyStack', { action: 'deposit' }).as('poolBefore')
    })

    cy.then(() => pollTier(account, 0)).then((r) => {
      expect(r.tier, 'a fresh passkey account holds no membership').to.equal(0)
    })

    cy.then(() => {
      openPurchaseModal()
      confirmBronzePurchase(price)
    })

    // NEVER STRANDED: the membership is still bought, on the same quoted price.
    cy.then(() => pollTier(account, BRONZE)).then((r) => {
      expect(r.tier, 'a paused paymaster does not stop a member buying membership').to.equal(BRONZE)
    })

    cy.get('@memberBefore').then((before) => {
      balances(account).then((after) => {
        expect(BigInt(before.usdc) - BigInt(after.usdc), 'exactly the Bronze price left the account')
          .to.equal(price)
        // The MEMBER paid the gas — the half of "self-funded" that is about them.
        expect(BigInt(after.native) < BigInt(before.native), 'the member funded their own gas').to.equal(true)
      })
    })

    // ...and the other half, read from the pool rather than inferred from the first.
    cy.get('@poolBefore').then((before) => {
      cy.task('passkeyStack', { action: 'deposit' }).then((after) => {
        expect(BigInt(after.deposit), 'the sponsorship pool paid nothing').to.equal(BigInt(before.deposit))
      })
    })
  })
})
