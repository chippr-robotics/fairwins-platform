/**
 * E2E Tests: Protect — spec-105 rules realization on chain (Full-tier), issue #1452
 *
 * Spec 105's creation flow installs ONE semantic rules config per vault, realized per chain
 * through the spec-068 ordered engine. What matters here is what the GUARD holds and enforces,
 * never what a sheet rendered: every outcome below is read back from the chain (the vault's guard
 * slot, the guard's own getRules, token balances, the vault's nonce).
 *
 * Requires `npm run setup:e2e` (canonical Safe set + both policy guards + the proposal hub).
 *
 * RL-01 drives the DIRECT install path: a Joint account (1-of-2) creator alone meets the
 * threshold, so the flow installs the rules inline — and then the realized lanes actually govern
 * money: an everyday send clears on one signature, an over-cap send is refused by the guard until
 * every owner has approved it (the big-send lane), after which the SAME proposal executes.
 *
 * RL-02 drives the QUEUED install path: a Controlled (2-of-2) vault cannot self-install, so the
 * flow queues both installs as hub proposals, states "rules awaiting approval" (never "active"),
 * and the vault stays ungoverned until the co-owner approves BOTH. It also proves the deploy-later
 * gate against real state: the creator (who holds the creation record) is offered Deploy for the
 * cohort network the vault is not on; the co-owner (who loaded by address and holds no record)
 * gets the honest FR-018 reason, never a dead control.
 *
 * Sub-issue of #1228 / #1451. Flows:
 *   RL-01 custody.create-rules-install — direct install; lanes govern money (allow / refuse / vote)
 *   RL-02 custody.create-rules-install — queued installs; consent completes them
 *        + custody.deploy-later         — record-gated Deploy vs the honest no-record reason
 */

const OWNER_A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // #0 — the connected member
const OWNER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // #1 — co-owner
const PAYEE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' // #2 — a transfer destination
const HUB = '0x94b5b38C247CE51F7C42C83B63115998b7e970E7' // HARDHAT_CONTRACTS.safeProposalHub
const GUARD_V2 = '0xc01E5F3EAFd2C0138e98382A3F54B6CeB3dc05cf' // ordered engine (spec 068)
const NO_GUARD = '0x0000000000000000000000000000000000000000'
// SafePolicyGuardV2.ANY_ASSET — the catch-all lane's asset sentinel (policyV2.js keeps the twin).
const ANY_ASSET = '0x0000000000000000000000000000000000000001'
// The LOCAL stable the 80002 seam resolves (dev:e2e VITE_AMOY_USDC, 18 decimals) — the token the
// everyday/big-send lanes are realized in, and the transfer form's default asset.
const ONE_UNIT = 10n ** 18n
// Mordor — the other custody network in the testnet cohort (creationChainIds). This suite never
// deploys there; it only asserts how the Details view OFFERS (or honestly withholds) doing so.
const MORDOR = 63

const PENDING_ROW = '[data-testid="vault-panel-queue"] [data-testid="vault-queue-row"]'
const CARD = '[data-testid^="vault-card-"]'
const MENU = '[data-testid^="vault-menu-"]'

const fixture = (action, args = {}) =>
  cy.task('custodyFixture', { action, args }).then((r) => {
    expect(r.ok, `custodyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/**
 * Poll the VAULT until its guard slot holds `expected` (the chain is the authority).
 *
 * Tolerates a vault that does not EXIST yet (vaultInfo cannot decode against an empty address):
 * these waits start the moment the member taps Deploy, which is before the create transaction
 * lands — "not deployed yet" is a retry, only the timeout is a failure.
 */
function waitForGuard(address, expected, tries = 90) {
  return cy.task('custodyFixture', { action: 'vaultInfo', args: { address } }).then((r) => {
    if (r.ok && r.guard.toLowerCase() === expected.toLowerCase()) return r
    if (tries <= 0) {
      throw new Error(
        r.ok
          ? `vault ${address} still reports guard ${r.guard} after executing ${r.nonce} ` +
            `transaction(s); expected guard ${expected}`
          : `vault ${address} never became readable: ${r.error}`,
      )
    }
    cy.wait(1000, { log: false })
    return waitForGuard(address, expected, tries - 1)
  })
}

/** Poll the VAULT until it has executed `expected` transactions (same not-yet-deployed tolerance). */
function waitForNonce(address, expected, tries = 60) {
  return cy.task('custodyFixture', { action: 'vaultInfo', args: { address } }).then((r) => {
    if (r.ok && r.nonce >= expected) return r
    if (tries <= 0) {
      throw new Error(
        r.ok
          ? `vault ${address} has executed ${r.nonce} transactions, expected ${expected}`
          : `vault ${address} never became readable: ${r.error}`,
      )
    }
    cy.wait(1000, { log: false })
    return waitForNonce(address, expected, tries - 1)
  })
}

/** Poll an address until its STABLE balance rises above `floor` (base units, strings). */
function waitForTokenBalanceAbove(address, floor, tries = 30) {
  return fixture('tokenBalance', { address }).then((info) => {
    if (BigInt(info.balance) > BigInt(floor)) return info
    if (tries <= 0) throw new Error(`${address} stable balance never rose above ${floor} (still ${info.balance})`)
    cy.wait(1000, { log: false })
    return waitForTokenBalanceAbove(address, floor, tries - 1)
  })
}

/** Wait for the HUB to have recorded `expected` proposals before the queue is read. */
function waitForProposalCount(address, expected, tries = 60) {
  return fixture('proposalCount', { address, hub: HUB }).then(({ count }) => {
    if (count >= expected) return count
    if (tries <= 0) {
      throw new Error(`the hub recorded ${count} proposal(s) for ${address}, expected ${expected}`)
    }
    cy.wait(1000, { log: false })
    return waitForProposalCount(address, expected, tries - 1)
  })
}

function openProtect(account = OWNER_A) {
  cy.mockWeb3Provider({ account, preAuthorized: true, realBalances: true })
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
}

/** Open the Protect vault ActionSheet and pick one of its actions. */
function openVaultAction(action) {
  cy.contains('.custody-onchain button', 'Vault actions').click()
  cy.get(`[data-testid="vault-action-${action}"]`).click()
}

/** Bring an existing on-chain vault into the app the way a member would: by address. */
function loadVault(address, label = 'E2E Vault') {
  openVaultAction('load')
  cy.get('form.custody-load').within(() => {
    cy.get('#load-address').clear().type(address)
    cy.get('#load-label').clear().type(label)
    cy.contains('button', /^Load/).click()
  })
  // 60s, as in full/29: loading probes every custody network before the card lists, and that
  // read burst has exceeded 30s on a loaded runner while the load itself was fine.
  cy.get(CARD, { timeout: 60000 }).should('have.length.at.least', 1)
}

/** Open the FIRST vault card's sheet on the given view (these flows hold one vault). */
function openVaultCard(view = 'queue') {
  cy.get('body').then(($b) => {
    if ($b.find('[data-testid="vault-panel-' + view + '"]').length === 0) {
      if ($b.find('.vault-sheet').length === 0) cy.get(MENU, { timeout: 30000 }).first().click()
      cy.get('[data-testid="vault-tab-' + view + '"]', { timeout: 20000 }).click()
    }
  })
  cy.get('[data-testid="vault-tab-' + view + '"]', { timeout: 20000 })
    .should('have.attr', 'aria-selected', 'true')
  cy.get('[data-testid="vault-panel-' + view + '"]', { timeout: 20000 }).should('exist').scrollIntoView()
}

/** Become the co-owner and bring the vault into THEIR list (references are per-member). */
function asCoOwner(address, label = 'Co-owner view') {
  cy.switchAccount(1)
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
  loadVault(address, label)
}

/** Approve and execute the queue row whose safe nonce precedes `expectedNonce`. */
function approveAndExecuteTop(address, expectedNonce) {
  cy.contains(PENDING_ROW, `nonce ${expectedNonce - 1}`, { timeout: 60000 })
    .contains('button', 'Approve', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
  executeTop(address, expectedNonce)
}

/**
 * Execute the queue row whose safe nonce precedes `expectedNonce`, without approving first.
 *
 * Used where the Safe's own threshold is already met, so the row is READY and never offers an
 * Approve button — the guard still counts the EXECUTOR as an approver (SafePolicyGuardV2
 * `_countApprovals`: `approver == ctx.executor || approvedHashes == 1`), which is exactly how a
 * second owner completes a big-send vote on a 1-of-2: by executing it themselves.
 */
function executeTop(address, expectedNonce) {
  const safeNonce = expectedNonce - 1
  cy.contains(PENDING_ROW, `nonce ${safeNonce}`, { timeout: 60000 })
    .contains('button', 'Execute', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
  waitForNonce(address, expectedNonce)
}

/** Switch the acting account to a vault by its label (no reload afterwards — state is in React). */
function actAsVault(label) {
  cy.get('.wallet-account-button', { timeout: 20000 }).click()
  cy.get('.account-identity-trigger', { timeout: 20000 }).click()
  cy.get('.account-switch-menu').contains('.account-switch-opt', label).click()
}

/**
 * Propose sending STABLE from the vault (the form's default asset), then try to execute it.
 * A vault never sends directly — the transfer becomes a threshold-gated proposal, and the guard
 * has its say at EXECUTION, which is where a lane refusal shows up.
 */
function transferStableAsVault(vaultAddress, vaultLabel, to, amount) {
  cy.visit('/wallet?tab=paytransfer')
  actAsVault(vaultLabel)

  cy.get('#pt-to', { timeout: 20000 }).clear().type(to)
  cy.get('#pt-amount').clear().type(amount)
  cy.contains('.pt-actions button', 'Preview').click()
  cy.get('.pt-preview').should('contain.text', 'Vault proposal')
  cy.contains('.pt-actions button', 'Propose').click()
  cy.get('.notification-message', { timeout: 30000 }).should('contain.text', 'Proposed sending')

  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
  openVaultCard('queue')
  fixture('proposalCount', { address: vaultAddress, hub: HUB }).then(({ count }) => {
    expect(count, 'the hub recorded the proposal').to.be.greaterThan(0)
  })
  // Deliberately no "row leaves the queue" assertion: a guard REFUSAL keeps the proposal queued,
  // which is exactly the outcome RL-01 goes on to check.
  cy.get(PENDING_ROW, { timeout: 60000 })
    .first()
    .contains('button', 'Execute', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
}

/**
 * Assert the guard's stored rules ARE the spec-105 realization of the default semantic config
 * (daily cap 500 in the local stable, big sends = everyone, allowed money = stable):
 *   1. the everyday lane — the stable, banded, perTx == window == 500
 *   2. the big-send lane — the stable, full owner vote
 *   3. the catch-all — ANY_ASSET, full owner vote (allowed money is the stable alone)
 */
function expectRealizedLanes(rules, owners) {
  const CAP = (500n * ONE_UNIT).toString()
  const ownerSet = owners.map((o) => o.toLowerCase())
  expect(rules, 'three lanes, in order').to.have.length(3)

  const [everyday, bigSend, catchAll] = rules
  expect(everyday.banded, 'lane 1 is BANDED — over-cap does not match it at all').to.equal(true)
  expect(everyday.perTxLimit, 'lane 1 per-tx bound is the cap').to.equal(CAP)
  expect(everyday.windowLimit, 'lane 1 window is the cap').to.equal(CAP)
  expect(everyday.approvalsRequired, 'lane 1 needs no extra approvers').to.equal(0)

  expect(bigSend.asset.toLowerCase(), 'lanes 1 and 2 share the SAME asset scope (the fall-through pair)')
    .to.equal(everyday.asset.toLowerCase())
  expect(bigSend.banded, 'lane 2 is not banded').to.equal(false)
  expect(bigSend.approvalsRequired, 'lane 2 is a full vote').to.equal(owners.length)
  expect(bigSend.approvers.map((a) => a.toLowerCase()), 'lane 2 approvers are the owners')
    .to.have.members(ownerSet)

  expect(catchAll.asset.toLowerCase(), 'lane 3 is the catch-all').to.equal(ANY_ASSET.toLowerCase())
  expect(catchAll.approvalsRequired, '"allowed money: stable" ⇒ everything else is a full vote')
    .to.equal(owners.length)
}

describe('Protect — spec-105 rules realization on chain (issue #1452)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  // ---------------------------------------------------------------------------
  // RL-01 — direct install (creator meets threshold), and the lanes govern money
  // ---------------------------------------------------------------------------
  it('[RL-01] installs the rules inline on a Joint vault, allows an everyday send, refuses an over-cap send until every owner approves', () => {
    openProtect()
    openVaultAction('create')

    // Sheet 1 — Joint account: 1-of-2, exactly two owners.
    cy.get('[data-testid="create-step-type"]').as('typeSheet')
    cy.get('@typeSheet').contains('[role="radio"]', 'Joint account').click()
    cy.get('#create-owner-0').clear().type(OWNER_A)
    cy.get('#create-owner-1').clear().type(OWNER_B)
    cy.get('#create-vault-label').type('Lane Vault')
    cy.contains('button', 'Next: set rules').click()

    /*
     * Sheet 2 — keep the DEFAULT semantic config (cap 500, allowed money = stable, big sends =
     * everyone) but set the wait to none: this test sends twice in a minute, and a cooldown
     * refusal would be the right behaviour for the wrong reason — the lane assertions below are
     * about amounts and votes, not spacing.
     */
    cy.get('[data-testid="create-step-rules"]').should('be.visible')
    cy.get('[data-testid="rule-tile-wait"]').click()
    cy.contains('[role="radio"]', 'No wait').click()
    cy.get('[data-testid="rules-summary"]').should('contain.text', '500')
    cy.contains('button', 'Next: pick networks').click()

    // Sheet 3 — the local chain is preselected; deploy + inline install are one orchestration.
    cy.get('[data-testid="create-step-networks"]').should('be.visible')
    cy.get('[data-testid="deploy-button"]').click()
    cy.get('[data-testid="predicted-address"] code', { timeout: 30000 })
      .invoke('text')
      .then((predictedRaw) => {
        const address = predictedRaw.trim()

        /*
         * The chain is the finish line, not the status row: a 1-of-2 creator meets the threshold,
         * so the flow installs setRules + setGuard directly, and the vault is governed the moment
         * the guard slot holds the ordered engine.
         */
        waitForGuard(address, GUARD_V2).then((info) => {
          expect(info.threshold, 'Joint ⇒ either owner can move funds').to.equal(1)
          expect(info.owners.map((o) => o.toLowerCase())).to.have.members([
            OWNER_A.toLowerCase(), OWNER_B.toLowerCase(),
          ])
        })

        // The guard's stored rules ARE the realization — field by field, not a summary string.
        fixture('policyRules', { address, guard: GUARD_V2 }).then((policy) => {
          expect(policy.cooldown, 'the member chose "No wait"').to.equal(0)
          expectRealizedLanes(policy.rules, [OWNER_A, OWNER_B])
        })

        // Finish the flow; the status row must state Live with no failure text.
        cy.get('[data-testid="deploy-status-80002"]', { timeout: 60000 }).should('contain.text', 'Live')
        cy.contains('button', 'Continue', { timeout: 60000 }).should('not.be.disabled').click()
        cy.get('[data-testid="create-step-done"]').should('be.visible')
        cy.contains('button', 'Done').click()
        cy.get(CARD, { timeout: 60000 }).should('have.length.at.least', 1)

        // Deploy-later gate, record side (FR-018): the creator HOLDS the creation record, so the
        // cohort network the vault is not on offers a real Deploy control.
        openVaultCard('details')
        cy.get(`[data-testid="vault-network-missing"][data-chain-id="${MORDOR}"]`, { timeout: 20000 })
          .should('contain.text', 'Not deployed')
        cy.get(`[data-testid="vault-deploy-${MORDOR}"]`).should('exist')

        // Fund the vault with the stable the lanes are realized in.
        fixture('mintToken', { address, amount: (1000n * ONE_UNIT).toString() })

        /*
         * Nonce arithmetic for everything below: the DIRECT install already executed TWO Safe
         * transactions (setRules, then setGuard), so the vault stands at nonce 2 before any
         * transfer — the everyday send is nonce 3, the big send nonce 4. Counting from 1 here
         * was the first CI run's failure: the chain reported 3 where the test assumed 1.
         */

        // (a) An everyday send — inside lane 1's band — clears on the creator's signature alone.
        fixture('tokenBalance', { address: PAYEE }).then((before) => {
          transferStableAsVault(address, 'Lane Vault', PAYEE, '10')
          waitForTokenBalanceAbove(PAYEE, before.balance)
          waitForNonce(address, 3)
        })

        // (b) An over-cap send SKIPS the banded lane and lands on the big-send lane, which needs
        // every owner. One approval is not a vote: the guard refuses, nothing moves, and the
        // proposal STAYS queued rather than dying.
        fixture('tokenBalance', { address: PAYEE }).then((before) => {
          transferStableAsVault(address, 'Lane Vault', PAYEE, '600')
          fixture('tokenBalance', { address: PAYEE }).then((after) => {
            expect(after.balance, 'the refused transfer moved nothing').to.equal(before.balance)
          })
          fixture('vaultInfo', { address }).then((info) => {
            expect(info.nonce, 'the vault executed nothing beyond the installs + everyday send').to.equal(3)
          })
          cy.get(PENDING_ROW).should('have.length.at.least', 1)

          /*
           * (c) The co-owner completes the vote by EXECUTING the same proposal: the Safe's
           * threshold (1) was met at propose time, so the row is READY and offers no Approve —
           * and the guard counts the executor as an approver, making A (approved hash) + B
           * (executor) the full vote the big-send lane demands.
           */
          asCoOwner(address, 'Lane Vault (B)')
          openVaultCard('queue')
          executeTop(address, 4)
          waitForTokenBalanceAbove(PAYEE, before.balance).then((finalBal) => {
            expect(
              BigInt(finalBal.balance) - BigInt(before.balance),
              'the big send moved exactly what was proposed',
            ).to.equal(600n * ONE_UNIT)
          })
        })
      })
  })

  // ---------------------------------------------------------------------------
  // RL-02 — queued installs (co-owners must sign), consent completes them
  // ---------------------------------------------------------------------------
  it('[RL-02] queues the installs on a Controlled vault as awaiting approval, and the co-owner’s consent makes them law', () => {
    openProtect()
    openVaultAction('create')

    // Sheet 1 — Controlled: everyone must approve (2 owners ⇒ 2-of-2).
    cy.get('[data-testid="create-step-type"]').as('typeSheet')
    cy.get('@typeSheet').contains('[role="radio"]', 'Controlled').click()
    cy.get('#create-owner-0').clear().type(OWNER_A)
    cy.get('#create-owner-1').clear().type(OWNER_B)
    cy.get('#create-vault-label').type('Consent Vault')
    cy.contains('button', 'Next: set rules').click()

    // Sheet 2 — the DEFAULT config as-is (cap 500, 1 hour wait, stable-only, big sends everyone).
    cy.get('[data-testid="create-step-rules"]').should('be.visible')
    cy.contains('button', 'Next: pick networks').click()

    // Sheet 3 — deploy. A 2-of-2 cannot self-install: the rules queue as hub proposals and the
    // status row SAYS so — "awaiting approval", never shown active (FR-010).
    cy.get('[data-testid="create-step-networks"]').should('be.visible')
    cy.get('[data-testid="deploy-button"]').click()
    cy.get('[data-testid="predicted-address"] code', { timeout: 30000 })
      .invoke('text')
      .then((predictedRaw) => {
        const address = predictedRaw.trim()

        cy.get('[data-testid="deploy-status-80002"]', { timeout: 60000 })
          .should('contain.text', 'rules awaiting approval')

        // The chain agrees with the label: two queued proposals, no guard, nothing installed.
        waitForProposalCount(address, 2)
        fixture('vaultInfo', { address }).then((info) => {
          expect(info.threshold, 'Controlled ⇒ everyone signs').to.equal(2)
          expect(info.guard, 'queued installs govern nothing yet').to.equal(NO_GUARD)
          expect(info.nonce, 'nothing has executed').to.equal(0)
        })

        cy.contains('button', 'Continue', { timeout: 60000 }).should('not.be.disabled').click()
        cy.get('[data-testid="create-step-done"]').should('be.visible')
        cy.contains('button', 'Done').click()
        cy.get(CARD, { timeout: 60000 }).should('have.length.at.least', 1)

        /*
         * The co-owner loads the vault by address — so THEY hold no creation record. The same
         * missing-network row that offered the creator a Deploy button gives this member the
         * honest reason instead: absence of the record is stated, never a dead control (FR-018).
         */
        asCoOwner(address, 'Consent Vault (B)')
        openVaultCard('details')
        cy.get(`[data-testid="vault-network-missing"][data-chain-id="${MORDOR}"]`, { timeout: 20000 })
          .should('contain.text', 'Not deployed')
          .and('contain.text', 'creation details')
        cy.get(`[data-testid="vault-deploy-${MORDOR}"]`).should('not.exist')

        // Approve + execute the installs IN ORDER (consecutive nonces: setRules, then setGuard).
        openVaultCard('queue')
        approveAndExecuteTop(address, 1)
        // The rules landed first and they are inert: the vault is still ungoverned.
        fixture('vaultInfo', { address }).then((info) => {
          expect(info.guard, 'rules alone do not govern a vault').to.equal(NO_GUARD)
        })
        approveAndExecuteTop(address, 2)

        // Both landed: the vault is governed, and the guard holds the SAME realization the
        // creator configured — including the 1-hour wait this test deliberately kept.
        waitForGuard(address, GUARD_V2).then((info) => {
          expect(info.threshold, 'adoption does not change the arrangement').to.equal(2)
        })
        fixture('policyRules', { address, guard: GUARD_V2 }).then((policy) => {
          expect(policy.cooldown, 'the default 1-hour wait was installed as configured').to.equal(3600)
          expectRealizedLanes(policy.rules, [OWNER_A, OWNER_B])
        })
      })
  })
})
