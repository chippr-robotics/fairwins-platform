/**
 * E2E Tests: a membership purchase lands on the ACTING account (spec 098, Full-tier)
 *
 * Flow: purchase.acting-account —
 *   "A member operating as another account purchases membership that lands on the acting
 *    account, on every submit rail — including the split approve/purchase proposals on a
 *    policy-guarded vault."
 *
 * ── WHY THIS TIER (admission rule 2) ────────────────────────────────────────────────────
 * `MembershipManager.purchaseTier` credits `msg.sender` and takes no beneficiary, so the whole
 * feature is the claim that the account which SIGNS is the account the modal names. That claim
 * only exists on chain: a mock would credit whoever the app said it credited. Every outcome
 * below is therefore read back from `MembershipManager` and the payment token — never from the
 * screen that just claimed it — and spec 098 FR-017 says so explicitly ("Purchase is a
 * money-costing signature, so the covered flows join the on-chain e2e tier").
 *
 * The invariant every test pins is the one the spec's security review names: on every rail the
 * PAYER and the CREDITED MEMBER are the same address, and it is the acting account. So each
 * test asserts both halves — the tier landed on the acting account, and the price left the
 * acting account — plus the negative: the connected operator's tier and stablecoin balance did
 * not move. There is no rail where the operator's funds buy the acting account's tier.
 *
 * ── THE RAILS, AND WHICH ONES THIS TIER CAN REACH ───────────────────────────────────────
 *   AAP-01  vault, no policy guard  → ONE proposal ([approve, purchase] via MultiSendCallOnly)
 *   AAP-02  vault, spec-049 policy  → TWO proposals at CONSECUTIVE nonces (issue #1368)
 *   AAP-03  recovered legacy account → the spec-088 ceremony's own signer, approve + pay
 *
 * Not reachable here, and deliberately not faked:
 *   · the HARDWARE rail needs a device that can sign and broadcast. The dev-only adapter seam
 *     (`window.__fwHardwareTestAdapter__`) exists to stand in for account DISCOVERY; its
 *     signing entry points reject by design (fast/27-protect-hardware.cy.js), and a fixture
 *     that signed real transactions would be testing the fixture. FR-004 is exercised here
 *     through the legacy account, which takes the identical `acting-signer` branch.
 *   · the PASSKEY-batch rail (FR-006) is personal-only by construction and the passkey tier
 *     runs without a chain.
 *   · the RELAYED rail (FR-007) needs a live relayer; `dev:e2e` sets no VITE_RELAYER_URL, so
 *     `useGaslessWrite` self-submits. AAP-03 therefore exercises the never-stranded fallback
 *     (FR-008) on the acting identity, which is the guaranteed path.
 *
 * Requires `npm run setup:e2e` (which runs `setup:e2e:custody` — a fresh node has no Safe
 * behind the canonical addresses, and the `custodyFixture` task fails loudly if it was skipped).
 *
 * Sub-issue of #1400. Checklist: AAP-01..AAP-03
 */

import { resetChainBetweenTests } from '../../support/e2e'

// Hardhat #4 — the connected member throughout: the vault owner who proposes and executes, and
// the operator who unlocks the recovered account. Never the account that ends up with a
// membership, which is the whole point.
const OPERATOR = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'

const HUB = '0x94b5b38C247CE51F7C42C83B63115998b7e970E7' // HARDHAT_CONTRACTS.safeProposalHub
const GUARD_V1 = '0xBE509C8E6c4F132e2Af49761A318FfA362e9CE38' // HARDHAT_CONTRACTS.safePolicyGuard
const ONE_COIN = (10n ** 18n).toString()
const PASSPHRASE = 'correct-horse-battery'
const BRONZE = 1

/*
 * The PENDING queue only. History rows carry the same `custody-proposal-row` class, so an
 * unscoped count says "still queued" about a proposal that executed a minute ago.
 */
// Spec 102 — the queue is the vault sheet's Queue view.
const PENDING_ROW = '[data-testid="vault-panel-queue"] [data-testid="vault-queue-row"]'

const custody = (action, args = {}) =>
  cy.task('custodyFixture', { action, args }).then((r) => {
    expect(r.ok, `custodyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

const chain = (action, args = {}) =>
  cy.task('chainTx', { action, args }).then((r) => {
    expect(r.ok, `chainTx ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

const legacyFixture = (action, args = {}) =>
  cy.task('legacyFixture', { action, args }).then((r) => {
    expect(r.ok, `legacyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/** The membership MembershipManager reports for an address, read once. */
const tierOf = (address) =>
  cy.task('voucherFixture', { action: 'membership', args: { address } }).then((r) => {
    expect(r.ok, `voucherFixture membership: ${r.error || 'no error message returned'}`).to.equal(true)
    return r.tier
  })

/**
 * Assert an address's tier, RE-READING the chain until it agrees.
 *
 * `tierOf(...).should(...)` looks equivalent and is not: the `.then()` inside it ends the
 * retryable chain, so `should` would re-run against one frozen value forever. Ending in
 * `.should()` on the task itself is what waits for the transaction to mine instead of racing it.
 */
const expectTier = (address, expected, label) =>
  cy
    .task('voucherFixture', { action: 'membership', args: { address } }, { timeout: 90000 })
    .should((r) => {
      expect(r.ok, `voucherFixture membership: ${r.error || 'no error message returned'}`).to.equal(true)
      expect(r.tier, label).to.equal(expected)
    })

const tokenBalanceOf = (address) =>
  chain('tokenBalance', { address }).then((r) => BigInt(r.balance))

const expectTokenBalance = (address, assertion) =>
  cy.task('chainTx', { action: 'tokenBalance', args: { address } }, { timeout: 90000 }).should((r) => {
    expect(r.ok, `chainTx tokenBalance: ${r.error || 'no error message returned'}`).to.equal(true)
    assertion(BigInt(r.balance))
  })

/** Poll the VAULT until it has executed `expected` transactions — the only honest "it landed". */
function waitForNonce(address, expected, tries = 90) {
  return custody('vaultInfo', { address }).then((info) => {
    if (info.nonce >= expected) return info
    if (tries <= 0) {
      throw new Error(`vault ${address} has executed ${info.nonce} transactions, expected ${expected}`)
    }
    cy.wait(1000, { log: false })
    return waitForNonce(address, expected, tries - 1)
  })
}

function openProtect() {
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 30000 }).should('be.visible')
}

/** Bring an existing on-chain vault into the app the way a member would: by address. */
function loadVault(address, label) {
  cy.get('[data-testid="custody-open-vault-actions"]', { timeout: 30000 }).click()
  cy.get('[data-testid="vault-action-load"]').click()
  cy.get('form.custody-load').within(() => {
    cy.get('#load-address').clear().type(address)
    cy.get('#load-label').clear().type(label)
    cy.contains('button', /^Load/).click()
  })
  cy.get('[data-testid^="vault-card-"]', { timeout: 60000 }).should('have.length.at.least', 1)
  cy.get('[data-testid^="vault-card-"] .account-card-label').should('contain.text', label)
}

/** Spec 102 — the card's "⋯" opens the vault sheet; the proposal queue is its Queue view. */
function openVaultCard() {
  cy.get('body').then(($b) => {
    if ($b.find('[data-testid="vault-panel-queue"]').length === 0) {
      if ($b.find('.vault-sheet').length === 0) cy.get('[data-testid^="vault-menu-"]', { timeout: 30000 }).first().click()
      cy.get('[data-testid="vault-tab-queue"]', { timeout: 20000 }).click()
    }
  })
  cy.get('[data-testid="vault-panel-queue"]', { timeout: 20000 }).should('be.visible')
}

/**
 * Execute the proposal sitting at the vault's next acceptable nonce, then wait for the CHAIN
 * to say it landed.
 *
 * By NONCE, never by rendered position: a split purchase queues two proposals at once, both
 * READY at 1-of-1, and nothing promises the list is in nonce order. A Safe only executes a
 * transaction whose nonce equals its current one — so draining them in nonce order, and
 * watching the vault's own nonce advance, is itself the proof that they were queued
 * consecutively.
 */
function executeAtNonce(vaultAddress, safeNonce) {
  cy.contains(PENDING_ROW, `nonce ${safeNonce}`, { timeout: 60000 })
    .contains('button', 'Execute', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
  waitForNonce(vaultAddress, safeNonce + 1)
}

/**
 * Switch the acting identity through the ONE control that changes it — the caret on the wallet
 * biticon. Scrolled to the top first: the button lives in a position:fixed header and is refused
 * as "covered" from a scrolled page.
 */
function actAs(optionText, expectedAddress) {
  cy.scrollTo('top', { ensureScrollable: false })
  cy.get('.wallet-account-button', { timeout: 30000 }).should('be.visible').click()
  cy.get('.account-identity-trigger', { timeout: 30000 }).click()
  cy.get('.account-switch-menu').contains('.account-switch-opt', optionText).click()
  // Acting as somebody else has to be VISIBLE — signing as one account while the header shows
  // another is how a member signs the wrong thing.
  cy.get('.account-address-full', { timeout: 30000 })
    .invoke('attr', 'title')
    .should('eq', expectedAddress)
  cy.get('body').type('{esc}')
  cy.get('.account-switch-menu').should('not.exist')
}

/**
 * Open the purchase modal from the Membership tab.
 *
 * That tab's button is the entry that exists in every membership state (WalletPage.jsx:480-499);
 * the wallet dropdown's "Get Access" upsell renders only for a definitely-inactive read of the
 * account, which is not a stable door while the acting identity is being changed underneath it.
 */
function openPurchaseModal() {
  cy.get('.membership-section .get-roles-btn', { timeout: 30000 }).click()
  cy.get('.ppm-overlay', { timeout: 30000 }).should('exist')
}

describe('Membership purchase lands on the acting account (spec 098)', () => {
  /*
   * PER-TEST CHAIN ISOLATION. Every test here grants a membership that is permanent for its
   * duration and creates a vault that then holds one — without a revert, a re-run against the
   * same node would find the acting account already a member and `purchaseTier` would revert
   * `AlreadyActive`. That is the "passes exactly once" shape the policy calls unfalsifiable.
   */
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    cy.mockWeb3Provider({ account: OPERATOR, preAuthorized: true, realBalances: true })
  })

  // ---------------------------------------------------------------------------
  // AAP-01 — a vault buys its own membership: one proposal, nothing charged until
  // the vault executes, and then the tier is the VAULT's
  // ---------------------------------------------------------------------------
  it('[AAP-01] proposes one batched purchase to a vault, and the tier lands on the vault when it executes', () => {
    custody('createVault', { owners: [OPERATOR], threshold: 1 }).then(({ address: vault }) => {
      // The vault pays with its OWN stablecoin — FR-005. Funding it is the precondition, and
      // `buildMembershipPurchaseCalls` refuses to shape a purchase the holder cannot afford.
      chain('fund', { address: vault })

      chain('membershipAdminState', { tier: BRONZE }).then(({ tierPriceUSDC, tierActive }) => {
        const price = BigInt(tierPriceUSDC)
        // Both stated rather than assumed: an inactive tier is never offered in the grid and a
        // zero price would let "exactly the price was charged" pass at a charge of nothing.
        expect(tierActive, 'Bronze is on sale on this chain').to.equal(true)
        // Chai's ordering assertions are not a contract for BigInt (see full/28's note), so this
        // compares explicitly rather than through `.greaterThan`.
        expect(price > 0n, `Bronze has a real on-chain price to charge (got ${price})`).to.equal(true)

        tierOf(vault).then((vaultTierBefore) => {
          expect(vaultTierBefore, 'a fresh vault holds no membership').to.equal(0)

          tierOf(OPERATOR).then((operatorTierBefore) => {
            tokenBalanceOf(vault).then((vaultBalanceBefore) => {
              tokenBalanceOf(OPERATOR).then((operatorBalanceBefore) => {
                openProtect()
                loadVault(vault, 'Purchase Vault')

                cy.visit('/wallet?tab=membership')
                cy.get('.membership-section', { timeout: 30000 }).should('exist')
                actAs('Purchase Vault', vault)
                openPurchaseModal()

                cy.contains('.ppm-tier-card', /Bronze/i, { timeout: 30000 }).click()
                cy.get('.ppm-overlay').contains('button', /^Continue$/).click()

                // FR-010: before any signature, ONE place says who is credited, who pays, where
                // it settles, and that the outcome is a proposal.
                cy.get('.ppm-settlement-note', { timeout: 30000 })
                  .should('contain.text', 'Purchase Vault')
                  .and('contain.text', "the vault's own USDC")
                  .and('contain.text', 'Confirming creates a')
                  .and('contain.text', 'proposal')
                // Issue #1368: an unguarded vault CAN execute a delegatecall, so the purchase is
                // one proposal carrying both legs — and the screen describes the shape it will
                // actually create.
                cy.get('.ppm-settlement-note', { timeout: 60000 })
                  .should('contain.text', 'one proposal')
                  .and('contain.text', 'the USDC approval and the purchase together')

                cy.get('.ppm-panel input[type="checkbox"]', { timeout: 30000 })
                  .should('have.length.at.least', 1)
                  .check({ force: true })
                cy.get('.ppm-btn-purchase', { timeout: 30000 }).should('not.be.disabled').click({ force: true })

                /*
                 * FR-005/FR-014: `proposed` is NOT `paid`. The terminal state is visually and
                 * verbally distinct, and the modal must not claim an active membership for a
                 * purchase the vault has not executed.
                 */
                cy.get('.ppm-complete-title', { timeout: 120000 }).should('contain.text', 'Proposed to your vault')
                cy.get('.ppm-overlay').invoke('text').should('not.match', /purchase complete/i)

                // The chain agrees: nothing charged, no membership, exactly one proposal recorded.
                tierOf(vault).then((tierWhilePending) => {
                  expect(tierWhilePending, 'a proposed purchase grants nothing until it executes').to.equal(0)
                })
                tokenBalanceOf(vault).then((balanceWhilePending) => {
                  expect(balanceWhilePending, 'and charges nothing').to.equal(vaultBalanceBefore)
                })
                custody('proposalCount', { address: vault, hub: HUB }).then(({ count }) => {
                  expect(count, 'approve + purchase are ONE proposal, never two').to.equal(1)
                })

                // The vault executes it — the member's own next act, as an owner.
                cy.get('.ppm-overlay').contains('button', /^Done$/).click()
                cy.visit('/wallet?tab=custody')
                cy.get('.custody-panel', { timeout: 30000 }).should('be.visible')
                openVaultCard()
                executeAtNonce(vault, 0)

                // SC-002 + the payer/member symmetry: the tier is the vault's and the price came
                // out of the vault, while the operator who signed the proposal paid nothing and
                // gained nothing.
                expectTier(vault, BRONZE, 'the executed proposal credited the VAULT')
                expectTokenBalance(vault, (after) => {
                  expect(vaultBalanceBefore - after, 'exactly the tier price left the vault').to.equal(price)
                })
                expectTier(OPERATOR, operatorTierBefore, "the operator's own membership is untouched")
                expectTokenBalance(OPERATOR, (after) => {
                  expect(after, "and the operator's stablecoin balance is untouched").to.equal(operatorBalanceBefore)
                })
              })
            })
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // AAP-02 — a policy-guarded vault: TWO proposals at consecutive nonces (#1368)
  // ---------------------------------------------------------------------------
  it('[AAP-02] splits the purchase into two consecutive proposals on a policy-guarded vault, and both execute', () => {
    /*
     * Both policy guards deny `operation != 0` once a vault has an active policy, so a batched
     * MultiSend proposal would be approved by the owners and then revert — on exactly the vaults
     * that followed our own starter-policy guidance. The purchase is therefore proposed as the
     * approval at nonce N and the purchase at N+1, and the member is told so before signing.
     */
    custody('createV1PolicyVault', {
      owners: [OPERATOR],
      threshold: 1,
      perTxLimit: (10n ** 17n).toString(), // 0.1 coin per transaction — a native-asset rule
    }).then(({ address: vault }) => {
      custody('vaultInfo', { address: vault }).then((info) => {
        expect(info.guard.toLowerCase(), 'governed by the spec-049 guard, which denies delegatecall')
          .to.equal(GUARD_V1.toLowerCase())
      })
      chain('fund', { address: vault })

      chain('membershipAdminState', { tier: BRONZE }).then(({ tierPriceUSDC, tierActive }) => {
        const price = BigInt(tierPriceUSDC)
        expect(tierActive, 'Bronze is on sale on this chain').to.equal(true)
        // Chai's ordering assertions are not a contract for BigInt (see full/28's note), so this
        // compares explicitly rather than through `.greaterThan`.
        expect(price > 0n, `Bronze has a real on-chain price to charge (got ${price})`).to.equal(true)

        tokenBalanceOf(vault).then((vaultBalanceBefore) => {
          openProtect()
          loadVault(vault, 'Policy Vault')

          cy.visit('/wallet?tab=membership')
          cy.get('.membership-section', { timeout: 30000 }).should('exist')
          actAs('Policy Vault', vault)
          openPurchaseModal()

          cy.contains('.ppm-tier-card', /Bronze/i, { timeout: 30000 }).click()
          cy.get('.ppm-overlay').contains('button', /^Continue$/).click()

          // The shape is DISCLOSED before signature, with its reason and its residual risk —
          // discovered here rather than when a batched proposal reverts at execution.
          cy.get('.ppm-settlement-note', { timeout: 60000 })
            .should('contain.text', 'two separate proposals')
            .and('contain.text', "this vault's policy does not allow batched transactions")
            .and('contain.text', 'the purchase cannot execute before the approval')

          cy.get('.ppm-panel input[type="checkbox"]', { timeout: 30000 })
            .should('have.length.at.least', 1)
            .check({ force: true })
          cy.get('.ppm-btn-purchase', { timeout: 30000 }).should('not.be.disabled').click({ force: true })

          cy.get('.ppm-complete-title', { timeout: 120000 }).should('contain.text', 'Proposed to your vault')

          custody('proposalCount', { address: vault, hub: HUB }).then(({ count }) => {
            expect(count, 'the approval and the purchase are proposed separately').to.equal(2)
          })

          cy.get('.ppm-overlay').contains('button', /^Done$/).click()
          cy.visit('/wallet?tab=custody')
          cy.get('.custody-panel', { timeout: 30000 }).should('be.visible')
          openVaultCard()

          // CONSECUTIVE, and in that order: the queue shows nonce 0 and nonce 1, and the Safe
          // will only ever accept them in that sequence.
          cy.get(PENDING_ROW, { timeout: 60000 }).should('have.length', 2)
          cy.contains(PENDING_ROW, 'nonce 0').should('exist')
          cy.contains(PENDING_ROW, 'nonce 1').should('exist')

          // Nothing has been charged while both sit in the queue.
          tokenBalanceOf(vault).then((whilePending) => {
            expect(whilePending, 'two queued proposals charge nothing').to.equal(vaultBalanceBefore)
          })

          executeAtNonce(vault, 0)
          tierOf(vault).then((afterApprove) => {
            expect(afterApprove, 'the approval alone grants no membership').to.equal(0)
          })
          executeAtNonce(vault, 1)

          expectTier(vault, BRONZE, 'the second proposal credited the VAULT')
          expectTokenBalance(vault, (after) => {
            expect(after, 'and the approval authorised exactly the price, no more')
              .to.equal(vaultBalanceBefore - price)
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // AAP-03 — a recovered account signs for itself: the ceremony runs at CONFIRM
  // time, and both the tier and the payment are the acting account's
  // ---------------------------------------------------------------------------
  it('[AAP-03] buys for a recovered account with its own signer, and never with the operator wallet', () => {
    /*
     * A FRESH legacy EOA every run: a fixed key would carry a membership between runs and make
     * "did the purchase land" a function of how often the suite had been run.
     */
    legacyFixture('newAccount').then(({ address: recovered, privateKey }) => {
      legacyFixture('fundNative', { address: recovered, amount: ONE_COIN }) // its own gas
      chain('fund', { address: recovered }) // its own stablecoin

      chain('membershipAdminState', { tier: BRONZE }).then(({ tierPriceUSDC, tierActive }) => {
        const price = BigInt(tierPriceUSDC)
        expect(tierActive, 'Bronze is on sale on this chain').to.equal(true)
        // Chai's ordering assertions are not a contract for BigInt (see full/28's note), so this
        // compares explicitly rather than through `.greaterThan`.
        expect(price > 0n, `Bronze has a real on-chain price to charge (got ${price})`).to.equal(true)

        tierOf(recovered).then((recoveredTierBefore) => {
          expect(recoveredTierBefore, 'a fresh recovered account holds no membership').to.equal(0)

          tierOf(OPERATOR).then((operatorTierBefore) => {
            tokenBalanceOf(recovered).then((recoveredBalanceBefore) => {
              tokenBalanceOf(OPERATOR).then((operatorBalanceBefore) => {
                cy.openLegacyRecovery()
                cy.importLegacyKey({ secret: privateKey, passphrase: PASSPHRASE })
                cy.get('.action-sheet').contains('button', /^Done$/).click()

                cy.visit('/wallet?tab=membership')
                cy.get('.membership-section', { timeout: 30000 }).should('exist')
                actAs('Recovered', recovered)
                openPurchaseModal()

                cy.contains('.ppm-tier-card', /Bronze/i, { timeout: 30000 }).click()
                cy.get('.ppm-overlay').contains('button', /^Continue$/).click()

                // FR-010: the recovered account is named as both the credited member and the payer.
                cy.get('.ppm-settlement-note', { timeout: 30000 })
                  .should('contain.text', 'credited to')
                  .and('contain.text', 'own USDC')
                  // The ADDRESS, not just a label: the disclosure names the account that will be
                  // charged and credited, which is what makes "the connected wallet was
                  // substituted" a visible failure rather than a silent one.
                  .and('contain.text', `${recovered.slice(0, 6)}...${recovered.slice(-4)}`)

                cy.get('.ppm-panel input[type="checkbox"]', { timeout: 30000 })
                  .should('have.length.at.least', 1)
                  .check({ force: true })

                /*
                 * FR-004: the ceremony runs at CONFIRM, not at modal-open and not at
                 * account-switch time. Its absence before the click is part of the claim —
                 * spec 088 made switching address-only, and a passphrase prompt on selection
                 * would be the behaviour that change removed.
                 */
                cy.get('input[aria-label="Passphrase"]').should('not.exist')
                cy.get('.ppm-btn-purchase', { timeout: 30000 }).should('not.be.disabled').click({ force: true })

                cy.get('input[aria-label="Passphrase"]', { timeout: 60000 })
                  .should('be.visible')
                  .type(PASSPHRASE, { log: false })
                cy.contains('button', /^Unlock$/, { timeout: 30000 }).should('not.be.disabled').click()

                // One ceremony serves the whole run — approve, pay, and the key steps behind it.
                cy.get('.ppm-complete-title', { timeout: 180000 }).should('contain.text', 'Purchase Complete')

                /*
                 * SC-001 + SC-003. The tier is on the account the modal named, the price came out
                 * of that account, and the connected operator — whose wallet signed nothing here
                 * but the page it was standing on — is unchanged on both counts.
                 */
                expectTier(recovered, BRONZE, 'the membership landed on the RECOVERED account')
                expectTokenBalance(recovered, (after) => {
                  expect(recoveredBalanceBefore - after, 'exactly the tier price left the recovered account')
                    .to.equal(price)
                })
                expectTier(OPERATOR, operatorTierBefore, "the operator's own membership is untouched")
                expectTokenBalance(OPERATOR, (after) => {
                  expect(after, "and the operator's stablecoin balance is untouched").to.equal(operatorBalanceBefore)
                })
              })
            })
          })
        })
      })
    })
  })
})
