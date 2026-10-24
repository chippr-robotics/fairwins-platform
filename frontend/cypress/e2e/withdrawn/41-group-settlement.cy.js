/**
 * E2E Tests: settling a group payment (spec 058 group-pay amendment, Full-tier)
 *
 * The no-chain half of group pay already exists (`fast/41-group-pay.cy.js`): how a recipient list
 * is built, which recipients are refused and with what reason, and what the confirm screen
 * discloses BEFORE anything is signed. Nothing in that file signs or moves value, and it says so.
 *
 * THIS is the settlement half — the member presses the button and their own money leaves. That is
 * admission rule 2 of `docs/developer-guide/e2e-testing-policy.md` (a member signing something
 * that costs them money MUST have on-chain coverage), so every claim below is judged on CHAIN
 * STATE: recipient balances read back from the node, and the vault's own nonce and proposal queue
 * read back from the Safe and the hub. Not one assertion here is satisfied by a dialog's wording.
 *
 *   GS-01  the sequential rail   — N separate sends, per-recipient outcomes, one leg FAILS alone
 *   GS-02  the vault batch rail  — ONE MultiSend proposal, executed once, pays everybody
 *   GS-03  the vault split rail  — a policy that denies batches ⇒ N proposals at CONSECUTIVE nonces
 *
 * ── WHY THERE IS NO GS-04 (the passkey batched rail) ─────────────────────────────────────────
 * `useGroupPay` (frontend/src/hooks/useGroupPay.js:267-300) sends a passkey group payment as ONE
 * `sendCalls` batch (the call itself is line 294). That lands in `sendPasskeyBatch`, which
 * reaches the chain ONLY through
 * `bundlerClient.sendUserOperation` (frontend/src/lib/passkey/sendBatch.js:126) after
 * `chooseRoute` (frontend/src/lib/passkey/submission.js:61-82) has found either a healthy relayer
 * or a healthy BUNDLER — and the one route it will take optimistically still requires
 * `bundlerUrls.length > 0` (sendBatch.js:83). The "never-stranded self-funded fallback" at
 * sendBatch.js:118-136 is about PAYMASTER SPONSORSHIP, not about bypassing the bundler: it rebuilds
 * the same UserOp without a paymaster and submits it to the same bundler. So there is no
 * self-submitted batch, and this rail cannot be exercised on the ordinary on-chain tier, which
 * runs a bare hardhat node and no ERC-4337 stack. It needs the PASSKEY_FULL_STACK harness that was
 * never built (#1271), and the matrix row says so rather than this file skipping a test that
 * would look like coverage. The whole spec is deliberately NOT gated on that flag — the three
 * rails above are reachable today and are where the money actually moves for classic and vault
 * members.
 *
 * ── WHAT MAKES A LEG FAIL, AND WHY IT IS THAT ────────────────────────────────────────────────
 * GS-01 needs one recipient that genuinely cannot be paid while the others genuinely can, and the
 * form refuses to preview at all for the two obvious candidates: a sanctioned address is BLOCKING
 * before submit (`validateRecipients`, frontend/src/lib/payments/groupPay.js:187-193) and so is a
 * list whose total exceeds the balance (groupPay.js:227-228). So the failing recipient is the
 * local stablecoin's own CONTRACT — a plausible paste, a real member mistake, and an ERC-20 with
 * no `receive`/`fallback` (contracts/mocks/MockERC20.sol), so a plain coin transfer to it reverts
 * in `eth_estimateGas`. The mock provider surfaces that as a rejection rather than swallowing it
 * (cypress/support/commands.js:127-131), which is exactly the per-recipient failure the sequential
 * rail promises to survive.
 *
 * Checklist: GS-01..GS-03
 */

import { resetChainBetweenTests } from '../../support/e2e'

const MEMBER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // #0 — the seeded member and vault owner
const PAYEE_ONE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // #1
const PAYEE_TWO = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' // #2

const NATIVE_SYMBOL = 'POL' // this chain's coin, as the app labels it
const HUB = '0x94b5b38C247CE51F7C42C83B63115998b7e970E7' // HARDHAT_CONTRACTS.safeProposalHub
// getSafeContracts().multiSendCallOnly — the address a BATCHED vault proposal delegatecalls into.
// A proposal addressed here is one transaction carrying N payments; a proposal addressed to a
// recipient is one payment. That difference is what GS-02 and GS-03 are about.
const MULTISEND = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'
/*
 * The PENDING queue only. History rows carry the same `custody-proposal-row` class, so an
 * unscoped count says "still queued" about a proposal that executed a minute ago.
 */
// Spec 102 — the queue is the vault sheet's Queue view.
const PENDING_ROW = '[data-testid="vault-panel-queue"] [data-testid="vault-queue-row"]'

const COIN = 10n ** 18n
const TENTH = 10n ** 17n

/** How GroupPaySummary abbreviates an address, verbatim (GroupPaySummary.jsx:5). */
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

const fixture = (action, args = {}) =>
  cy.task('custodyFixture', { action, args }).then((r) => {
    expect(r.ok, `custodyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

const legacy = (action, args = {}) =>
  cy.task('legacyFixture', { action, args }).then((r) => {
    expect(r.ok, `legacyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/** One coin balance, read from the node, as a BigInt. Used for the BEFORE values. */
const nativeBalanceOf = (address) =>
  fixture('nativeBalance', { address }).then((r) => BigInt(r.balance))

/**
 * Assert a coin balance, RE-READING the chain until it agrees or the timeout expires.
 *
 * `nativeBalanceOf(...).should(...)` looks equivalent and is not: the `.then()` inside it ends the
 * retryable chain, so `should` re-runs its callback against one frozen value forever. This ends in
 * `.should()` directly on the `cy.task`, which Cypress does re-invoke — so the assertion waits for
 * the transaction to mine instead of racing it (the lesson TR-01 paid for in
 * `full/33-transfers-swap-vouchers.cy.js`).
 */
const expectNativeBalance = (address, assertion) =>
  cy.task('custodyFixture', { action: 'nativeBalance', args: { address } }, { timeout: 60000 }).should((r) => {
    expect(r.ok, `custodyFixture nativeBalance: ${r.error || 'no error message returned'}`).to.equal(true)
    assertion(BigInt(r.balance))
  })

/** Poll the VAULT until it has executed `expected` transactions. */
function waitForNonce(address, expected, tries = 60) {
  return fixture('vaultInfo', { address }).then((info) => {
    if (info.nonce >= expected) return info
    if (tries <= 0) {
      throw new Error(`vault ${address} has executed ${info.nonce} transactions, expected ${expected}`)
    }
    cy.wait(1000, { log: false })
    return waitForNonce(address, expected, tries - 1)
  })
}

function openProtect(account = MEMBER) {
  cy.mockWeb3Provider({ account, preAuthorized: true, realBalances: true })
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
}

/** Open the Protect vault ActionSheet and pick one of its actions (release 1.14.0). */
function openVaultAction(action) {
  cy.contains('.custody-onchain button', 'Vault actions').click()
  cy.get(`[data-testid="vault-action-${action}"]`).click()
}

/** Bring an existing on-chain vault into the app the way a member would: by address. */
function loadVault(address, label) {
  openVaultAction('load')
  cy.get('form.custody-load').within(() => {
    cy.get('#load-address').clear().type(address)
    cy.get('#load-label').clear().type(label)
    cy.contains('button', /^Load/).click()
  })
  cy.get('[data-testid^="vault-card-"]', { timeout: 30000 }).should('have.length.at.least', 1)
}

/**
 * The full recipient of a queue row.
 *
 * Spec 102 — a row shows the recipient cross-referenced (address book > callsign > ENS) beside a
 * SHORTENED address, so the row's text no longer contains the 42-character address these
 * assertions are about. The full address is carried on the element itself, which is also what a
 * member reads on hover, so that is what is asserted.
 */
function recipientOf(row) {
  return row.find('[data-testid="vault-queue-to"]').invoke('attr', 'title')
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
 * Switch the acting account to a vault by its label.
 *
 * Deliberately NOT followed by a cy.visit: the acting identity lives in React state, so a reload
 * puts the member back to personal. Navigate first, then switch.
 */
function actAsVault(label) {
  cy.get('.wallet-account-button', { timeout: 20000 }).click()
  cy.get('.account-identity-trigger', { timeout: 20000 }).click()
  cy.get('.account-switch-menu').contains('.account-switch-opt', label).click()
}

/**
 * Execute the proposal at the safe nonce the vault will accept next, then wait for the CHAIN.
 *
 * Found by the nonce the row itself displays, never by rendered position: a split group payment
 * queues several proposals at once and a proposal one nonce ahead is deliberately NOT executable
 * yet, so `.first()` would be a guess. And a row leaving the queue is not proof it mined — the
 * vault's own nonce is the only honest "it landed".
 */
function executeTop(address, expectedNonce) {
  cy.contains(PENDING_ROW, `nonce ${expectedNonce - 1}`, { timeout: 60000 })
    .contains('button', 'Execute', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
  waitForNonce(address, expectedNonce)
}

/**
 * Choose the COIN in the send form's asset picker.
 *
 * The form defaults to the stablecoin. Picked by the option's own symbol rather than by position
 * or by typing in the search box: the query matches network names too, so "POL" also matches every
 * asset on Polygon Amoy and `.first()` could quietly select USDC — which would then send the wrong
 * asset and still look like a passing test.
 */
function pickNativeAsset() {
  cy.get('[aria-label="Asset to send"]', { timeout: 20000 }).should('not.be.disabled').click()
  cy.contains('.uas-popover [role="option"] .uas-sym', new RegExp(`^${NATIVE_SYMBOL}$`)).click()
  cy.get('[aria-label="Asset to send"]').should('contain.text', NATIVE_SYMBOL)
}

/**
 * Draft a group payment. `recipients[0]` is the form's OWN To/amount pair (spec 058: the send form
 * stays a single-recipient form and the list is additive); the rest are added rows.
 */
function draftGroup(recipients) {
  cy.get('#pt-to', { timeout: 20000 }).clear().type(recipients[0].address, { delay: 0 })
  cy.get('#pt-amount').clear().type(recipients[0].amount, { delay: 0 })
  recipients.slice(1).forEach((r, i) => {
    cy.get('[data-testid="group-pay-add"]').click()
    cy.get('input[id^="pt-gp-addr-"]').eq(i).type(r.address, { delay: 0 })
    cy.get('input[id^="pt-gp-amt-"]').eq(i).type(r.amount, { delay: 0 })
  })
  cy.get('[data-testid="group-pay-row"]').should('have.length', recipients.length - 1)
}

function preview() {
  cy.contains('.pt-actions button', 'Preview').should('not.be.disabled').click()
  cy.get('[data-testid="group-pay-confirm"]', { timeout: 20000 }).should('be.visible')
}

// ── Issue #1441: the affordance this file drives is WITHDRAWN ────────────────────────────────
// `GROUP_PAY_ENABLED` in `frontend/src/lib/payments/groupPay.js` is false, so no send surface
// renders "Add another recipient" and none of the journeys below can start. They are GUARDED,
// not deleted: the engine, the lib and the components they exercise are all still in the tree,
// and #1538 flips this constant back with them. A guarded describe reports as pending — which is
// the point, because "passed" and "never ran" must not look alike (spec 094).
//
// Keep this in step with the constant. There is deliberately no import: a Cypress spec cannot
// read the app's module graph, and a fetch-and-parse would fail open — reporting the suite green
// on any error, which is the one outcome worse than a pending suite.
const GROUP_PAY_ENABLED = false
const groupPayDescribe = GROUP_PAY_ENABLED ? describe : describe.skip

groupPayDescribe('Group settlement — how a group payment actually settles (spec 058)', () => {
  /*
   * PER-TEST CHAIN ISOLATION. Every test here moves coin and two of them create a vault, so a
   * re-run against a long-lived node would otherwise read "before" balances that already contain
   * an earlier run's payments — and a delta assertion would then be a function of run count. The
   * revert also puts each vault back to nonce 0, which is what makes "the vault executed exactly
   * one transaction" a statement about THIS payment.
   */
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  // ---------------------------------------------------------------------------
  // GS-01 — the sequential rail: one failure does not stop the rest
  // ---------------------------------------------------------------------------
  it('[GS-01] pays three people one at a time — the leg that cannot be paid fails alone, and the other two land', () => {
    /*
     * The claim under test is the one the confirm screen makes to a classic wallet: "If one
     * payment fails the rest still go through, and you'll see the outcome for each"
     * (`describeRail`, frontend/src/lib/payments/groupPay.js:331). A rail that aborted on the
     * first failure would leave two people unpaid with a green banner, which is why the failing
     * recipient is FIRST in the list.
     */
    legacy('deploymentAddresses').then(({ paymentToken }) => {
      nativeBalanceOf(paymentToken).then((refuserBefore) => {
        nativeBalanceOf(PAYEE_ONE).then((oneBefore) => {
          nativeBalanceOf(PAYEE_TWO).then((twoBefore) => {
            cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
            cy.visit('/wallet?tab=paytransfer')
            pickNativeAsset()

            draftGroup([
              { address: paymentToken, amount: '0.1' }, // a token contract: cannot receive the coin
              { address: PAYEE_ONE, amount: '0.2' },
              { address: PAYEE_TWO, amount: '0.3' },
            ])
            preview()

            // A classic wallet cannot batch, and the disclosure says so before anything is signed.
            cy.get('[data-testid="group-pay-rail"]')
              .should('have.attr', 'data-shape', 'sequential')
              .and('contain.text', '3 separate transactions')

            cy.contains('.pt-actions button', /send to 3 recipients/i).click()

            // Three sequential sends, each awaited to inclusion, so the outcome panel only renders
            // once every leg has an answer.
            cy.get('[data-testid="group-pay-outcomes"]', { timeout: 120000 }).should('be.visible')

            // The member is told the truth in one line — a partial result reported as a partial
            // result, never rolled into a total.
            // One `should`, not two: a notification can auto-dismiss, and a second read of the
            // same banner would then fail on the passage of time rather than on the product.
            cy.get('.notification-message').invoke('text').should((text) => {
              expect(text, 'the banner names what went').to.match(/2 sent/i)
              expect(text, 'and what did not').to.match(/1 failed/i)
            })

            cy.get('[data-testid="group-pay-outcome"]').should('have.length', 3)
            cy.get('[data-testid="group-pay-outcome"]').eq(0).should('contain.text', 'Failed')
            cy.get('[data-testid="group-pay-outcome"]').eq(1).should('contain.text', 'Sent')
            cy.get('[data-testid="group-pay-outcome"]').eq(2).should('contain.text', 'Sent')
            cy.get('[data-testid="group-pay-summary"]')
              .should('contain.text', '2 sent')
              .and('contain.text', '1 failed')

            // The failure is NAMED — which recipient, and why. A list that failed anonymously
            // would leave the member unable to retry the one payment that did not go.
            cy.get('[data-testid="group-pay-outcome"]').eq(0).invoke('text').then((text) => {
              expect(text.toLowerCase(), 'the failed row names the recipient it could not pay')
                .to.contain(short(paymentToken).toLowerCase())
            })
            cy.get('[data-testid="group-pay-outcome"]')
              .eq(0)
              .find('.gp-outcome-reason')
              .invoke('text')
              .should('have.length.greaterThan', 0)

            // And now the chain, which is the only authority on who was actually paid.
            expectNativeBalance(PAYEE_ONE, (after) => {
              expect(after - oneBefore, 'the second recipient received exactly what was drafted')
                .to.equal(2n * TENTH)
            })
            expectNativeBalance(PAYEE_TWO, (after) => {
              expect(after - twoBefore, 'and so did the third — a failure ahead of them stopped nothing')
                .to.equal(3n * TENTH)
            })
            // Asserted LAST, on purpose: by now both successful legs have mined, so "unchanged"
            // is a statement about a settled chain rather than one the read simply got to first.
            expectNativeBalance(paymentToken, (after) => {
              expect(after, 'the leg that failed moved nothing at all').to.equal(refuserBefore)
            })
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // GS-02 — the vault rail: ONE MultiSend proposal covering every payment
  // ---------------------------------------------------------------------------
  it('[GS-02] proposes ONE batched transaction from a vault, and executing it once pays both recipients', () => {
    /*
     * A 1-of-1 vault with no policy guard: `previewBatchSupport` reads the vault's own guard slot,
     * finds nothing there, and answers `batch-ok` (frontend/src/lib/custody/batchPreflight.js:70).
     * So the group payment is ONE proposal whose MultiSend carries both transfers — and the vault
     * executes exactly ONE transaction, which is the whole claim.
     *
     * 1-of-1 because this test is about the SHAPE of the proposal, not about collecting approvals:
     * proposing records the proposer's approval on chain, so the row is born ready. CV-02 in
     * `full/29-protect-custody.cy.js` is where the threshold itself is under test.
     */
    fixture('createVault', { owners: [MEMBER], threshold: 1 }).then(({ address }) => {
      fixture('fundVault', { address, amount: (5n * COIN).toString() })

      nativeBalanceOf(PAYEE_ONE).then((oneBefore) => {
        nativeBalanceOf(PAYEE_TWO).then((twoBefore) => {
          openProtect()
          loadVault(address, 'Batch Vault')

          cy.visit('/wallet?tab=paytransfer')
          actAsVault('Batch Vault')
          pickNativeAsset()

          draftGroup([
            { address: PAYEE_ONE, amount: '0.1' },
            { address: PAYEE_TWO, amount: '0.2' },
          ])
          preview()

          // What the member is told they are creating, before they sign it.
          cy.get('[data-testid="group-pay-rail"]')
            .should('have.attr', 'data-shape', 'batch')
            .and('contain.text', 'One proposal covering all 2 payments')

          cy.contains('.pt-actions button', /propose 2 payments/i).click()
          cy.get('[data-testid="group-pay-outcomes"]', { timeout: 60000 }).should('be.visible')
          cy.get('[data-testid="group-pay-summary"]').should('contain.text', '2 proposed')
          cy.get('[data-testid="group-pay-outcome"]').should('have.length', 2)

          // Proposing is not paying. Nothing has moved and the vault has executed nothing.
          fixture('vaultInfo', { address }).then((info) => {
            expect(info.nonce, 'a proposal executes nothing on its own').to.equal(0)
          })

          cy.visit('/wallet?tab=custody')
          cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
          openVaultCard()

          // Distinguish "nothing was proposed" from "the queue cannot find it" before waiting on a
          // row that may never come — and ONE is the number that matters here.
          fixture('proposalCount', { address, hub: HUB }).then(({ count }) => {
            expect(count, 'the hub recorded exactly one proposal for both payments').to.equal(1)
          })
          cy.get(PENDING_ROW, { timeout: 60000 }).should('have.length', 1)

          // …and that one proposal is addressed to MultiSendCallOnly, which is what makes it a
          // batch rather than two payments that happen to be queued together.
          recipientOf(cy.get(PENDING_ROW).first()).then((to) => {
            expect(String(to).toLowerCase(), 'the proposal delegatecalls MultiSendCallOnly')
              .to.equal(MULTISEND.toLowerCase())
          })

          executeTop(address, 1)

          expectNativeBalance(PAYEE_ONE, (after) => {
            expect(after - oneBefore, 'the first recipient was paid').to.equal(TENTH)
          })
          expectNativeBalance(PAYEE_TWO, (after) => {
            expect(after - twoBefore, 'the second recipient was paid').to.equal(2n * TENTH)
          })
          fixture('vaultInfo', { address }).then((info) => {
            // Exactly one, not "at least one": two payments that cost the vault two transactions
            // would not be the batch the confirm screen promised.
            expect(info.nonce, 'both payments rode ONE vault transaction').to.equal(1)
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // GS-03 — a vault whose policy denies batches: N proposals at consecutive nonces
  // ---------------------------------------------------------------------------
  it('[GS-03] splits into consecutive-nonce proposals when the vault policy denies a batch, and each one executes', () => {
    /*
     * Issue #1368. A batched proposal is a MultiSend DELEGATECALL, and a vault with an ACTIVE
     * policy denies delegatecall outright (`SafePolicyGuard._checkPolicy`,
     * contracts/custody/SafePolicyGuard.sol:287). Proposing one anyway would have the vault's
     * signers approve something that then reverts — on exactly the vaults that followed our own
     * policy guidance. So the shape falls back to one proposal per recipient, and the member is
     * told that BEFORE signing.
     *
     * The vault is created governed by the spec-049 guard (the fixture's `createV1PolicyVault`,
     * the only fixture that produces a policy-bearing vault without driving the adoption journey
     * — which is CV-04's subject, not this test's). Its per-transaction limit is a whole coin, so
     * both payments are comfortably ALLOWED: what is under test is the batch denial, and a policy
     * that also refused the payments would make a passing test unable to tell the two apart.
     */
    fixture('createV1PolicyVault', {
      owners: [MEMBER],
      threshold: 1,
      perTxLimit: COIN.toString(), // 1 coin per transaction — both legs are well inside it
    }).then(({ address }) => {
      fixture('fundVault', { address, amount: (5n * COIN).toString() })

      // The vault really is governed, on chain, before anything else is claimed about it.
      fixture('vaultInfo', { address }).then((info) => {
        expect(info.guard, 'the vault carries a policy guard').to.not.equal(
          '0x0000000000000000000000000000000000000000',
        )
      })

      nativeBalanceOf(PAYEE_ONE).then((oneBefore) => {
        nativeBalanceOf(PAYEE_TWO).then((twoBefore) => {
          openProtect()
          loadVault(address, 'Policy Vault')

          cy.visit('/wallet?tab=paytransfer')
          actAsVault('Policy Vault')
          pickNativeAsset()

          draftGroup([
            { address: PAYEE_ONE, amount: '0.1' },
            { address: PAYEE_TWO, amount: '0.2' },
          ])
          preview()

          /*
           * The disclosure is the vault's OWN guard answering, not a guess: "denied" and "could
           * not confirm" produce the same SHAPE but different sentences, and asserting the denial
           * wording is what keeps an unreadable policy from passing as a read one.
           */
          cy.get('[data-testid="group-pay-rail"]', { timeout: 30000 })
            .should('have.attr', 'data-shape', 'split')
            .and('contain.text', '2 separate proposals')
            .and('contain.text', 'does not allow batched transactions')

          cy.contains('.pt-actions button', /propose 2 payments/i).click()
          cy.get('[data-testid="group-pay-outcomes"]', { timeout: 60000 }).should('be.visible')
          cy.get('[data-testid="group-pay-summary"]').should('contain.text', '2 proposed')

          cy.visit('/wallet?tab=custody')
          cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
          openVaultCard()

          fixture('proposalCount', { address, hub: HUB }).then(({ count }) => {
            expect(count, 'the hub recorded one proposal per recipient').to.equal(2)
          })
          cy.get(PENDING_ROW, { timeout: 60000 }).should('have.length', 2)

          /*
           * CONSECUTIVE nonces, one payment each. Two proposals sharing a nonce are mutually
           * exclusive on a Safe — executing one invalidates the other — so a split that reused a
           * nonce would leave exactly ONE of the two payments executable while looking identical
           * on screen.
           */
          recipientOf(cy.contains(PENDING_ROW, 'nonce 0')).then((to) => {
            expect(String(to).toLowerCase(), 'the first proposal pays the first recipient directly')
              .to.equal(PAYEE_ONE.toLowerCase())
            expect(String(to).toLowerCase(), 'and is not a batch').to.not.equal(MULTISEND.toLowerCase())
          })
          recipientOf(cy.contains(PENDING_ROW, 'nonce 1')).then((to) => {
            expect(String(to).toLowerCase(), 'the second proposal pays the second recipient directly')
              .to.equal(PAYEE_TWO.toLowerCase())
          })

          // The second is HELD until the first lands — the ordering the confirm screen described
          // ("queued in order … approved and executed one at a time"). Its counterpart is
          // `executeTop(address, 2)` below, which only passes once that Execute button DOES appear.
          cy.contains(PENDING_ROW, 'nonce 1').within(() => {
            cy.contains('button', 'Execute').should('not.exist')
          })

          executeTop(address, 1)
          executeTop(address, 2)

          expectNativeBalance(PAYEE_ONE, (after) => {
            expect(after - oneBefore, 'the first recipient was paid').to.equal(TENTH)
          })
          expectNativeBalance(PAYEE_TWO, (after) => {
            expect(after - twoBefore, 'the second recipient was paid').to.equal(2n * TENTH)
          })
          fixture('vaultInfo', { address }).then((info) => {
            expect(info.nonce, 'the vault executed exactly two transactions — one per payment')
              .to.equal(2)
          })
        })
      })
    })
  })
})
