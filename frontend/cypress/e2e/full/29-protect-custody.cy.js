/**
 * E2E Tests: Protect — Safe custody and the policy guards (specs 043 / 049 / 068, Full-tier)
 *
 * Custody vaults hold member funds behind a guard that is deliberately NOT upgradeable, so what
 * matters here is what the CHAIN accepted, never what the screen said: every outcome below is read
 * back from the vault itself (owners, threshold, nonce, guard slot, balances).
 *
 * Requires `npm run setup:e2e`, which now runs `setup:e2e:custody` — a fresh node has no Safe
 * behind the canonical addresses the app hard-codes, and no policy guards. The `custodyFixture`
 * task fails loudly rather than mysteriously if that step was skipped.
 *
 * Only CV-01 drives the creation wizard, because only CV-01 is about creating a vault. The rest
 * take an on-chain vault from the fixture and bring it in through the app's own "Load a vault"
 * path (release 1.14.0: the four vault actions live behind the Protect vault ActionSheet), so each
 * test spends its assertions on its own flow.
 *
 * CV-02 drives the cycle through a governance change rather than a transfer, because the
 * governance panel is the ONLY propose-from-Protect path by design: there is deliberately no
 * vault-shaped send form, since spending from a vault is a normal transfer made while the vault is
 * your acting account — which is CV-03.
 *
 * Sub-issue of #1228. Flows:
 *   CV-01 custody.create-vault        — create a vault and add its owners
 *   CV-02 custody.propose-and-execute — propose, collect approvals, execute
 *   CV-03 custody.operate-as-vault    — act as the vault, and see which you are
 *   CV-04 custody.policy-v2-adoption  — the vault CONSENTS to the ordered guard, by threshold
 *   CV-05 custody.policy-v2-first-match — the FIRST matching rule decides, and no match denies
 *   CV-06 custody.multi-chain-vault-list — a chain that cannot be read is NAMED, not shown empty
 *   CV-07 custody.policy-v1-enforced   — the spec-049 guard still refuses what breaks its rules
 *
 * Checklist: CV-01..CV-08
 */

import { FIRST_MATCH_SCENARIOS } from '../../../src/test/fixtures/policyScenarios'

const OWNER_A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // #0 — the connected member
const OWNER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // #1 — co-owner
const ONE_COIN = (10n ** 18n).toString()
const PAYEE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' // #2 — a transfer destination
const NATIVE_SYMBOL = 'POL' // this chain's coin, as the app labels it
const HUB = '0x94b5b38C247CE51F7C42C83B63115998b7e970E7' // HARDHAT_CONTRACTS.safeProposalHub
// A custody chain this test deliberately cannot reach (NETWORKS[137].rpcUrl).
const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com'
const POLYGON_RPC_FAILOVER = 'https://polygon.drpc.org'
const POLYGON_VAULT = '0x1111111111111111111111111111111111111111'
const GUARD_V1 = '0xBE509C8E6c4F132e2Af49761A318FfA362e9CE38' // HARDHAT_CONTRACTS.safePolicyGuard
const NO_GUARD = '0x0000000000000000000000000000000000000000'
/*
 * The ordered engine the app is built with (HARDHAT_CONTRACTS.safePolicyGuardV2). Adoption is
 * judged by the vault's own guard slot holding exactly this — a vault is on v2 because it said so
 * on chain, never because the UI drew a badge.
 */
const GUARD_V2 = '0xc01E5F3EAFd2C0138e98382A3F54B6CeB3dc05cf'
/*
 * The PENDING queue only. History rows carry the same `custody-proposal-row` class, so an
 * unscoped count says "still queued" about a proposal that executed a minute ago.
 */
// Spec 102 — the queue lives in the vault sheet's Queue view: one row per pending proposal, on
// every network the vault is on, each tagged with its chain.
const PENDING_ROW = '[data-testid="vault-panel-queue"] [data-testid="vault-queue-row"]'
const CARD = '[data-testid^="vault-card-"]'
const MENU = '[data-testid^="vault-menu-"]'

const fixture = (action, args = {}) =>
  cy.task('custodyFixture', { action, args }).then((r) => {
    expect(r.ok, `custodyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/**
 * Poll the VAULT until it reports the expected threshold.
 *
 * A retrying chain read, not a screen assertion: the vault is the authority on its own
 * configuration, and a UI that renders the new threshold before the transaction lands (or never
 * refreshes after it does) must not be able to pass or fail this on its own.
 */
function waitForThreshold(address, expected, tries = 60) {
  return fixture('vaultInfo', { address }).then((info) => {
    if (info.threshold === expected) return info
    if (tries <= 0) {
      throw new Error(`vault ${address} still reports threshold ${info.threshold}, expected ${expected}`)
    }
    cy.wait(1000, { log: false })
    return waitForThreshold(address, expected, tries - 1)
  })
}

/**
 * Poll the VAULT until it has executed `expected` transactions.
 *
 * This is what sequences a multi-step change. The queue can show two rows both offering Execute
 * while the first is still in flight, and clicking the second then sends a Safe transaction at
 * nonce N+1 while the chain is still at N — which reverts, leaving a vault half-adopted with
 * nothing on screen to say so. The vault's own nonce is the only honest "it landed".
 */
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

/** Poll the VAULT until its guard slot holds `expected`. */
function waitForGuard(address, expected, tries = 60) {
  return fixture('vaultInfo', { address }).then((info) => {
    if (info.guard.toLowerCase() === expected.toLowerCase()) return info
    if (tries <= 0) {
      // Report what the vault DID, not just what it lacks: "guard is zero after 2 executed
      // transactions" and "after 0" are completely different bugs, and the screenshot cannot
      // tell them apart.
      throw new Error(
        `vault ${address} still reports guard ${info.guard} after executing ${info.nonce} ` +
        `transaction(s); expected guard ${expected}`,
      )
    }
    cy.wait(1000, { log: false })
    return waitForGuard(address, expected, tries - 1)
  })
}

/** Become the co-owner and bring the vault into THEIR list (references are per-member). */
function asCoOwner(address) {
  cy.switchAccount(1)
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
  loadVault(address, 'Co-owner view')
  openVaultCard()
}

/**
 * Approve and execute the TOP proposal, leaving `remaining` in the queue.
 *
 * One at a time on purpose: a multi-step change (adoption is two — configure the rules, then point
 * the guard slot at them) is proposed at consecutive nonces, so the second is not executable until
 * the first has landed. Draining the queue in order is what an owner actually does, and it is the
 * only order the chain will accept.
 */
function approveAndExecuteTop(address, expectedNonce) {
  cy.contains(PENDING_ROW, `nonce ${expectedNonce - 1}`, { timeout: 60000 })
    .contains('button', 'Approve', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
  executeTop(address, expectedNonce)
}

/**
 * Execute the TOP proposal, leaving `remaining` in the queue.
 *
 * Used on its own where the proposal is born ready: submitting as the vault records the
 * proposer's approval on chain, so at 1-of-1 the threshold is already met and the row never
 * offers an Approve button to click.
 */
function executeTop(address, expectedNonce) {
  /*
   * Execute the proposal whose SAFE NONCE is the one the vault will accept next, found by the
   * nonce the row itself displays — not by rendered position. A multi-step change queues several
   * proposals at once and nothing promises the list is in nonce order, so `.first()` was a guess
   * that happened to hold on this machine.
   *
   * Then wait for the CHAIN to say it landed: a row leaving the queue is not proof it mined, and
   * on a slow runner the next step was being clicked while the previous was still in flight.
   */
  const safeNonce = expectedNonce - 1
  cy.contains(PENDING_ROW, `nonce ${safeNonce}`, { timeout: 60000 })
    .contains('button', 'Execute', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
  waitForNonce(address, expectedNonce)
}


/** Compose one ordered rule: the coin, capped per transaction. */
function addCoinRule(perTx) {
  cy.contains('button', 'Add a rule').click()
  cy.contains('label', `${NATIVE_SYMBOL} only`).find('input[type="radio"]').check()
  cy.get('#rule-per-tx').clear().type(perTx)
  cy.contains('button', 'Save rule').click()
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
 * Move the coin AS the vault, and then execute it.
 *
 * A vault never sends directly — `submitAsActiveAccount` turns a vault-mode transfer into a
 * threshold-gated proposal, even at 1-of-1 — so the guard has its say at EXECUTION, which is
 * where a policy refusal shows up. Executing is done as the owner, so the reload back to Protect
 * (which resets the acting identity to personal) is correct rather than incidental.
 */
function transferAsVault(vaultAddress, vaultLabel, to, amount) {
  cy.visit('/wallet?tab=paytransfer')
  actAsVault(vaultLabel)

  // Pick the COIN. The form defaults to the stablecoin, which the vault holds none of, and a
  // zero balance disables Preview — so without this the test fails on an unrelated guard.
  cy.get('[aria-label="Asset to send"]', { timeout: 20000 }).click()
  cy.get('.uas-search').type(NATIVE_SYMBOL)
  cy.get('[role="option"]').first().click()

  cy.get('#pt-to', { timeout: 20000 }).clear().type(to)
  cy.get('#pt-amount').clear().type(amount)
  cy.contains('.pt-actions button', 'Preview').click()
  // The member is told which account is spending before they commit to it.
  cy.get('.pt-preview').should('contain.text', 'Vault proposal')
  cy.contains('.pt-actions button', 'Propose').click()
  /*
   * Assert the POSITIVE signal, not the absence of an error. On success the form resets and
   * leaves the preview, so `.pt-notice-error` is missing either way — a test that only checked
   * for its absence would pass on a click that did nothing at all.
   */
  cy.get('.notification-message', { timeout: 30000 }).should('contain.text', 'Proposed sending')

  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
  openVaultCard()
  // Distinguish "nothing was proposed" from "the queue cannot find it" before waiting 60s on a
  // row that may never come.
  fixture('proposalCount', { address: vaultAddress, hub: HUB }).then(({ count }) => {
    expect(count, 'the hub recorded the proposal').to.be.greaterThan(0)
  })
  // Deliberately no count assertion here: a policy REFUSAL leaves the proposal in the queue,
  // which is the outcome CV-05 goes on to check.
  cy.get(PENDING_ROW, { timeout: 60000 })
    .first()
    .contains('button', 'Execute', { timeout: 60000 })
    .should('not.be.disabled')
    .click()
}

/** Poll an address until its coin balance rises above `floor`. */
function waitForBalanceAbove(address, floor, tries = 30) {
  return fixture('nativeBalance', { address }).then((info) => {
    if (BigInt(info.balance) > BigInt(floor)) return info
    if (tries <= 0) throw new Error(`${address} balance never rose above ${floor} (still ${info.balance})`)
    cy.wait(1000, { log: false })
    return waitForBalanceAbove(address, floor, tries - 1)
  })
}

function openProtect(account = OWNER_A) {
  cy.mockWeb3Provider({ account, preAuthorized: true, realBalances: true })
  cy.visit('/wallet?tab=custody')
  cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
}

/** Open the Protect vault ActionSheet and pick one of its four actions (release 1.14.0). */
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
  /*
   * 60s, matching CV-01's card wait: loading probes the vault on every custody network before a
   * card can list, and on a loaded runner that read burst has exceeded 30s (CV-02, 2026-09-06)
   * while the same machinery passed in the same run — the deadline was the flake, not the load.
   */
  cy.get(CARD, { timeout: 60000 }).should('have.length.at.least', 1)
}

/**
 * Spec 102 — a vault card no longer expands; its "⋯" opens the vault sheet, and the proposal
 * queue is the sheet's Queue view. Opens the FIRST card's sheet (these flows hold one vault).
 */
/**
 * Wait for the HUB to have recorded `expected` proposals before the queue is read.
 *
 * Spec 102 — the Queue view reads when it OPENS (and on Refresh); it does not poll. Opening it
 * while a proposal is still being mined would assert against a queue that is honestly reporting
 * what the chain said a moment earlier, so the wait belongs before the read rather than as a
 * retry around it.
 */
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

function openVaultCard(view = 'queue') {
  cy.get('body').then(($b) => {
    if ($b.find('[data-testid="vault-panel-' + view + '"]').length === 0) {
      if ($b.find('.vault-sheet').length === 0) cy.get(MENU, { timeout: 30000 }).first().click()
      cy.get('[data-testid="vault-tab-' + view + '"]', { timeout: 20000 }).click()
    }
  })
  /*
   * Asserted by the TAB's own state, not the panel's visibility: the sheet is `position: fixed`
   * with `max-height: 85vh; overflow-y: auto`, so a panel taller than that — Details, which
   * carries a policy panel per network — is judged "not visible" by Cypress even though every
   * part of it is reachable by scrolling (and Cypress scrolls to it before each click below).
   * What this helper needs to establish is that the sheet is SHOWING this view.
   */
  cy.get('[data-testid="vault-tab-' + view + '"]', { timeout: 20000 })
    .should('have.attr', 'aria-selected', 'true')
  cy.get('[data-testid="vault-panel-' + view + '"]', { timeout: 20000 }).should('exist').scrollIntoView()
}


describe('Protect — Safe custody (specs 043 / 049 / 068)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  // ---------------------------------------------------------------------------
  // CV-01 — create a vault and its owner set, judged by the deployed Safe
  // ---------------------------------------------------------------------------
  it('[CV-01] creates a 2-of-2 vault on chain through the guided flow and lists it', () => {
    openProtect()

    cy.get('.custody-onchain').should('be.visible')
    openVaultAction('create')

    // Sheet 1 — "Controlled": everyone must approve (2 owners ⇒ 2-of-2). No bare threshold typed.
    cy.get('[data-testid="create-step-type"]').as('typeSheet')
    cy.get('@typeSheet').contains('[role="radio"]', 'Controlled').click()
    cy.get('#create-owner-0').clear().type(OWNER_A)
    cy.get('#create-owner-1').clear().type(OWNER_B)
    cy.get('@typeSheet').contains(/all 2 owners must sign/i).should('exist')
    cy.get('#create-vault-label').type('E2E Vault')
    cy.contains('button', 'Next: set rules').click()

    /*
     * Sheet 2 — switch every rule OFF. This test judges the SAFE the flow deploys; with rules on,
     * a 2-of-2 would queue their installation for the co-owner (spec 105 FR-010), and the guard
     * assertion below is about the no-rules path staying byte-identical to spec 043.
     */
    cy.get('[data-testid="create-step-rules"]').should('be.visible')
    cy.get('[data-testid="rule-tile-cap"]').click()
    cy.get('input[aria-label="Daily cap amount"]').clear()
    cy.get('[data-testid="rule-tile-wait"]').click()
    cy.contains('[role="radio"]', 'No wait').click()
    cy.get('[data-testid="rule-tile-allowed"]').click()
    cy.contains('[role="radio"]', /Everything — one set of rules/).click()
    cy.contains('button', 'Next: pick networks').click()

    // Sheet 3 — the local chain is preselected; the app orchestrates and reports live status.
    cy.get('[data-testid="create-step-networks"]').should('be.visible')
    cy.get('[data-testid="deploy-button"]').click()
    // The predicted address renders before any signature lands (FR-007)…
    cy.get('[data-testid="predicted-address"] code', { timeout: 30000 }).should('contain.text', '0x')
    // …and the network row reaches LIVE from a real receipt, never a timer.
    cy.get('[data-testid^="deploy-status-"]', { timeout: 60000 }).should('contain.text', 'Live')
    cy.contains('button', 'Continue').click()

    // Sheet 4 — done: one address, one badge.
    cy.get('[data-testid="create-step-done"]').should('be.visible')
    cy.get('[data-testid="create-step-done"] code').invoke('text').then((predicted) => {
      cy.contains('button', 'Done').click()

      cy.get(CARD, { timeout: 60000 }).should('have.length.at.least', 1)
      cy.get(`${CARD} .account-card-label`).should('contain.text', 'E2E Vault')

      // The card is a claim; the chain is the fact — and the deployed address must BE the
      // predicted one (same-address determinism is the whole feature).
      cy.get(CARD).first().invoke('attr', 'data-testid').then((id) => {
        const address = id.replace('vault-card-', '')
        expect(address.toLowerCase(), 'deployed at the predicted address').to.equal(predicted.trim().toLowerCase())
        fixture('vaultInfo', { address }).then((info) => {
          expect(info.version, 'a real Safe v1.4.1').to.equal('1.4.1')
          expect(info.threshold, 'Controlled ⇒ everyone signs').to.equal(2)
          expect(info.owners.map((o) => o.toLowerCase()), 'both owners').to.have.members([
            OWNER_A.toLowerCase(), OWNER_B.toLowerCase(),
          ])
          expect(info.guard, 'a vault created with rules OFF carries no guard')
            .to.equal('0x0000000000000000000000000000000000000000')
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CV-02 — propose, collect the second approval, execute
  // ---------------------------------------------------------------------------
  it('[CV-02] holds a governance change until both owners approve, then executes it', () => {
    fixture('createVault', { owners: [OWNER_A, OWNER_B], threshold: 2 }).then(({ address }) => {
      fixture('fundVault', { address, amount: ONE_COIN })
      openProtect()
      loadVault(address)
      // Spec 102 — governance lives in the sheet's Details view, beside the owner list.
      openVaultCard('details')

      // Propose lowering the threshold to 1. A 2-of-2 cannot make this change on one signature,
      // which is exactly what the test needs to observe.
      cy.get('[data-testid="vault-governance"] .custody-governance', { timeout: 20000 }).within(() => {
        cy.contains('button', 'Change threshold').click()
        cy.get('#gov-threshold').type('{selectall}1').should('have.value', '1')
        cy.contains('button', /^Propose/).click()
      })

      /*
       * Wait for the CHAIN to carry the proposal before opening the Queue. The queue reads its
       * networks on mount and does not poll (Refresh is the member's re-read), so opening it
       * while the propose transaction is still in flight yields an empty queue that no amount of
       * Cypress retrying will refill — observed as a CI-only failure of this test.
       */
      waitForProposalCount(address, 1)
      // Queued, not applied — the vault still says 2. The Queue view re-reads on mount.
      openVaultCard('queue')
      cy.get(PENDING_ROW, { timeout: 60000 }).should('have.length.at.least', 1)
      fixture('vaultInfo', { address }).then((info) => {
        expect(info.threshold, 'one approval does not change a 2-of-2').to.equal(2)
      })

      /*
       * The co-owner approves, which is what a second owner actually does — including bringing
       * the vault into THEIR list. The saved vault references are per-member and device-local, so
       * owner B does not inherit owner A's; a test that assumed otherwise would be asserting on a
       * shared list the product deliberately does not have.
       */
      asCoOwner(address)
      approveAndExecuteTop(address, 1)

      waitForThreshold(address, 1).then((info) => {
        expect(info.nonce, 'the vault executed exactly one transaction').to.equal(1)
        expect(info.owners.length, 'the owner set is unchanged by a threshold change').to.equal(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CV-03 — act as the vault, and be told plainly which account you are
  // ---------------------------------------------------------------------------
  it('[CV-03] switches the acting identity to the vault and says so', () => {
    fixture('createVault', { owners: [OWNER_A, OWNER_B], threshold: 2 }).then(({ address }) => {
      fixture('fundVault', { address, amount: ONE_COIN })
      openProtect()
      loadVault(address, 'Ops Vault')

      // The account menu is the ONE way to change acting account — Protect deliberately has no
      // "Operate as this vault" button of its own. It lives inside the wallet dropdown, and the
      // identity trigger only renders once there is something to switch TO (a loaded vault).
      cy.get('.wallet-account-button', { timeout: 20000 }).click()
      cy.get('.account-identity-trigger', { timeout: 20000 }).click()
      cy.get('.account-switch-menu').within(() => {
        cy.contains('.account-switch-opt', 'Ops Vault').click()
      })

      // Being the vault has to be VISIBLE — acting as a multisig while the UI still shows the
      // member's own account is how somebody signs the wrong thing.
      cy.get('.account-address-full', { timeout: 20000 })
        .invoke('attr', 'title')
        .should('eq', address)
      // Spec 102 — the compact card marks the vault the member is acting as.
      cy.get(CARD).first().find('.account-card-state').should('contain.text', 'Active')
    })
  })

  // ---------------------------------------------------------------------------
  // CV-04 — adopting the ordered guard is the VAULT's decision, taken by threshold
  // ---------------------------------------------------------------------------
  it('[CV-04] adopts the ordered policy guard only once the owners approve setGuard', () => {
    fixture('createVault', { owners: [OWNER_A, OWNER_B], threshold: 2 }).then(({ address }) => {
      fixture('fundVault', { address, amount: ONE_COIN })
      openProtect()
      loadVault(address)
      openVaultCard('details')

      // A vault starts with no guard, and migration is vault-consented — never release-time.
      fixture('vaultInfo', { address }).then((info) => {
        expect(info.guard, 'no guard before the owners adopt one').to.equal(NO_GUARD)
      })

      // Spec 105 — the policy panel sits behind the one "Manage rules" disclosure in Details.
      cy.get('[data-testid="vault-manage-rules"] > summary', { timeout: 20000 }).click()
      cy.get('.custody-policy', { timeout: 20000 }).within(() => {
        cy.contains('button', /Add rules|Upgrade to ordered rules/).click()
        cy.contains('button', 'Add a rule').click()
      })
      // The composer's defaults describe a permissive first rule; this test is about ADOPTION,
      // so what the rule says matters less than the vault agreeing to be governed at all.
      cy.get('.custody-policy').within(() => {
        cy.contains('button', /^(Save|Add) rule/).click()
        cy.contains('button', 'Propose policy change').click()
      })

      /*
       * Adoption is TWO transactions, at consecutive nonces: configure the rules (inert while no
       * guard is active), then point the vault's guard slot at the engine. Both are proposed at
       * once, and the vault is governed only after BOTH land — asserted below, because a test that
       * executed one and saw a guard would be describing a product that cannot exist.
       */
      waitForProposalCount(address, 2)
      openVaultCard('queue')
      cy.get(PENDING_ROW, { timeout: 60000 }).should('have.length', 2)
      fixture('vaultInfo', { address }).then((info) => {
        expect(info.guard, 'still ungoverned on one approval').to.equal(NO_GUARD)
      })

      asCoOwner(address)
      approveAndExecuteTop(address, 1)
      // The rules landed first, and they are inert: the vault is still ungoverned.
      fixture('vaultInfo', { address }).then((info) => {
        expect(info.guard, 'rules alone do not govern a vault').to.equal(NO_GUARD)
      })
      approveAndExecuteTop(address, 2)

      waitForGuard(address, GUARD_V2).then((info) => {
        expect(info.threshold, 'adoption does not change the owner set or threshold').to.equal(2)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CV-05 — first-match governs, and silence is denial
  // ---------------------------------------------------------------------------
  it('[CV-05] lets the first matching rule decide, and denies what no rule matches', () => {
    const SCENARIO = FIRST_MATCH_SCENARIOS.find((sc) => sc.id === 'tight-rule-first')
    const ALLOWED = SCENARIO.attempts.find((a) => a.allowed)
    const REFUSED = SCENARIO.attempts.find((a) => !a.allowed)

    // A 1-of-1 vault: the member is the whole threshold, so the guard's verdict is the ONLY thing
    // standing between the transfer and the chain. Nothing here is about collecting approvals.
    fixture('createVault', { owners: [OWNER_A], threshold: 1 }).then(({ address }) => {
      fixture('fundVault', { address, amount: (10n * 10n ** 18n).toString() })
      openProtect()
      loadVault(address, 'Policy Vault')
      // Spec 102 — the policy panel lives in the sheet's Details view, per network.
      openVaultCard('details')

      /*
       * The rules come from the SHARED scenario table (src/test/fixtures/policyScenarios.js), the
       * same one the Solidity suite drives against the real guard and the Vitest suite checks
       * `matchPreview` against. Composing them here in the UI and letting the chain decide is the
       * third leg: if the client twin and enforcement ever drift, one of the three fails.
       *
       * `tight-rule-first` is two rules of identical scope, tight one first — so rule 001 decides
       * every coin transfer and rule 002 is unreachable for them. That is what separates this
       * engine from a best-match or last-match one.
       */
      // Spec 105 — the policy panel sits behind the one "Manage rules" disclosure in Details.
      cy.get('[data-testid="vault-manage-rules"] > summary', { timeout: 20000 }).click()
      cy.get('.custody-policy', { timeout: 20000 }).within(() => {
        cy.contains('button', /Add rules|Upgrade to ordered rules|Change rules/).click()
        SCENARIO.rules.forEach((r) => addCoinRule(r.perTx))
        cy.contains('button', 'Propose policy change').click()
      })

      /*
       * Adoption is two proposals — configure the rules, then point the guard slot at them.
       * Asserted before executing anything, so "only one was created" fails here saying that,
       * rather than later as a vault that mysteriously ends up ungoverned.
       */
      waitForProposalCount(address, 2)
      openVaultCard('queue')
      cy.get(PENDING_ROW, { timeout: 60000 }).should('have.length', 2)

      // 1-of-1: proposing already recorded the only approval the vault needs, so each step is
      // executable the moment it appears — there is no second owner to wait for.
      executeTop(address, 1)
      executeTop(address, 2)
      waitForGuard(address, GUARD_V2)

      // (a) Within rule 001 — allowed, and the coin actually moves.
      fixture('nativeBalance', { address: PAYEE }).then((before) => {
        transferAsVault(address, 'Policy Vault', PAYEE, ALLOWED.amount)
        waitForBalanceAbove(PAYEE, before.balance)
      })

      // (b) Over rule 001's limit but inside rule 002's. A later rule cannot rescue it: the first
      // rule whose scope matches is the one that governs, and it said no.
      fixture('vaultInfo', { address }).then((beforeVault) => {
        fixture('nativeBalance', { address: PAYEE }).then((before) => {
          transferAsVault(address, 'Policy Vault', PAYEE, REFUSED.amount)
          fixture('nativeBalance', { address: PAYEE }).then((after) => {
            expect(after.balance, 'the refused transfer moved nothing').to.equal(before.balance)
          })
          // A refusal is not a quiet no-op: the vault never advanced its nonce, so nothing it
          // signed took effect, and the proposal is still sitting in the queue.
          fixture('vaultInfo', { address }).then((afterVault) => {
            expect(afterVault.nonce, 'the vault executed nothing').to.equal(beforeVault.nonce)
          })
          cy.get(PENDING_ROW).should('have.length.at.least', 1)
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CV-06 — the estate spans chains, and an unreadable one says so
  // ---------------------------------------------------------------------------
  it('[CV-06] names a chain it cannot read instead of showing the vault as gone', () => {
    fixture('createVault', { owners: [OWNER_A], threshold: 1 }).then(({ address }) => {
      /*
       * Two vaults on two chains: one on this node (genuinely readable) and one on Polygon, whose
       * RPC is made unreachable. Only the FAILING side is stubbed — the readable side is a real
       * Safe on a real chain, so this cannot pass against an emulator that agrees with itself.
       */
      // Both endpoints must be dead: since the RPC-failover work, chain 137 declares a build-level
      // rpcFailoverUrl that participates in default reads, so killing only the primary leaves the
      // vault genuinely READABLE through the failover — and the honest state is then "unreadable"
      // (provider answered, no Safe there), not "unreachable". This test is about the unreachable
      // state, so it takes the whole chain down.
      cy.intercept('POST', POLYGON_RPC, { forceNetworkError: true }).as('polygonDown')
      cy.intercept('POST', POLYGON_RPC_FAILOVER, { forceNetworkError: true }).as('polygonFailoverDown')

      cy.mockWeb3Provider({ account: OWNER_A, preAuthorized: true, realBalances: true })
      cy.visit('/wallet?tab=custody', {
        onBeforeLoad(win) {
          win.localStorage.setItem(
            `fw_user_${OWNER_A.toLowerCase()}_custody_vault_references`,
            JSON.stringify([
              { address, chainId: 80002, label: 'Local Vault', addedAt: 1, role: 'owner' },
              { address: POLYGON_VAULT, chainId: 137, label: 'Polygon Vault', addedAt: 2, role: 'owner' },
            ]),
          )
        },
      })
      cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')

      // BOTH vaults are listed. The estate is the member's, not the connected chain's — a vault
      // vanishing because its chain is unreachable would read as "my funds are gone".
      cy.get(CARD, { timeout: 30000 }).should('have.length', 2)

      // The unreachable one is named, with its chain, rather than rendered as an empty vault.
      cy.contains(CARD, 'Polygon Vault')
        .should('contain.text', 'Polygon')
        .and('contain.text', 'unreachable')

      // …and the readable one is unaffected: per-vault failure isolation, not a global error.
      cy.contains(CARD, 'Local Vault').should('not.contain.text', 'unreachable')
    })
  })

  // ---------------------------------------------------------------------------
  // CV-07 — the v1 guard is still live, and still enforcing
  // ---------------------------------------------------------------------------
  it('[CV-07] refuses a transfer that breaks a v1 policy, on a vault that never adopted v2', () => {
    // Both guards enforce side by side on purpose: adoption is vault-consented, so a vault that
    // never opted in is still governed by spec 049 and must still be protected by it.
    fixture('createV1PolicyVault', {
      owners: [OWNER_A],
      threshold: 1,
      perTxLimit: (10n ** 17n).toString(), // 0.1 coin per transaction
    }).then(({ address }) => {
      fixture('fundVault', { address, amount: (10n * 10n ** 18n).toString() })

      fixture('vaultInfo', { address }).then((info) => {
        expect(info.guard.toLowerCase(), 'governed by the v1 guard, not the ordered one')
          .to.equal(GUARD_V1.toLowerCase())
      })

      openProtect()
      loadVault(address, 'Legacy Policy Vault')

      // Over the v1 per-transaction limit: the guard refuses, and nothing moves.
      fixture('vaultInfo', { address }).then((beforeVault) => {
        fixture('nativeBalance', { address: PAYEE }).then((before) => {
          transferAsVault(address, 'Legacy Policy Vault', PAYEE, '1')
          fixture('nativeBalance', { address: PAYEE }).then((after) => {
            expect(after.balance, 'the refused transfer moved nothing').to.equal(before.balance)
          })
          fixture('vaultInfo', { address }).then((afterVault) => {
            expect(afterVault.nonce, 'the vault executed nothing').to.equal(beforeVault.nonce)
          })
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // CV-08 — the vault sheet's Queue is the money path (spec 102)
  // ---------------------------------------------------------------------------
  it('[CV-08] approves and executes a transfer from the vault sheet queue, tagged with its network', () => {
    fixture('createVault', { owners: [OWNER_A, OWNER_B], threshold: 2 }).then(({ address }) => {
      fixture('fundVault', { address, amount: (2n * 10n ** 18n).toString() })
      openProtect()
      loadVault(address, 'Sheet Vault')

      // Owner A proposes an ordinary transfer while acting as the vault (the one send path).
      cy.visit('/wallet?tab=paytransfer')
      actAsVault('Sheet Vault')
      cy.get('[aria-label="Asset to send"]', { timeout: 20000 }).click()
      cy.get('.uas-search').type(NATIVE_SYMBOL)
      cy.get('[role="option"]').first().click()
      cy.get('#pt-to', { timeout: 20000 }).clear().type(PAYEE)
      cy.get('#pt-amount').clear().type('0.5')
      cy.contains('.pt-actions button', 'Preview').click()
      cy.get('.pt-preview').should('contain.text', 'Vault proposal')
      cy.contains('.pt-actions button', 'Propose').click()
      cy.get('.notification-message', { timeout: 30000 }).should('contain.text', 'Proposed sending')

      // The sheet's Queue shows it, tagged with the network it is on, one approval short.
      cy.visit('/wallet?tab=custody')
      cy.get('.custody-panel', { timeout: 20000 }).should('be.visible')
      openVaultCard('queue')
      cy.get(PENDING_ROW, { timeout: 60000 }).should('have.length', 1)
      cy.get(PENDING_ROW).first().find('.ab-net-pill').should('exist')
      cy.get(PENDING_ROW).first().should('contain.text', '1/2 approvals')
      cy.get('[data-testid="vault-queue-summary"]').should('contain.text', '1 pending')
      fixture('vaultInfo', { address }).then((info) => {
        expect(info.nonce, 'nothing executed on one approval').to.equal(0)
      })

      // Owner B approves and executes from THEIR sheet; the chain is the judge.
      fixture('nativeBalance', { address: PAYEE }).then((before) => {
        asCoOwner(address)
        approveAndExecuteTop(address, 1)
        waitForBalanceAbove(PAYEE, before.balance)
      })
      // Executed proposals leave the queue.
      openVaultCard('queue')
      cy.get('[data-testid="vault-panel-queue"]', { timeout: 60000 }).should('not.contain.text', '1/2 approvals')
    })
  })
})
