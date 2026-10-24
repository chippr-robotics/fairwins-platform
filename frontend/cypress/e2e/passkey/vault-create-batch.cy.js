// =============================================================================
// spec 105 / issue #1454 — a passkey member creates a governed vault in ONE batch.
//
// ACCOUNT-NATIVE TIER, full stack (chain + EntryPoint v0.6 + alto + the relay
// gateway). On the passkey rail the orchestrator batches `createProxyWithNonce`
// plus both direct-install `execTransaction`s into one `sendCalls`: the CREATE2
// address is known before deployment, and the pre-validated signature works
// because the smart account IS the owner and msg.sender. Admission rule 2 puts
// this here: deploying a vault costs the member money, so the flow is proved
// against a chain — and the UserOp path specifically needs the bundler.
//
// What the chain must say afterwards: a real Safe at the PREDICTED address
// (never receipt-parsed), governed by the ordered engine with the realized
// lanes, with the reference + creation record written under that same address.
//
// The same session also proves the write-rail gate the unit suite promises:
// Mordor has no bundler, so its network chip must state the reason in place
// and never let the batch be attempted there (spec "write rail" rules).
// =============================================================================

import {
  addVirtualAuthenticator,
  choosePasskey,
  connectedAddress,
  expectConnected,
  isChromium,
  resetAuthenticators,
} from '../../support/webauthn'

const GUARD_V2 = '0xc01E5F3EAFd2C0138e98382A3F54B6CeB3dc05cf'
const ANY_ASSET = '0x0000000000000000000000000000000000000001'
const MORDOR = 63

const fixture = (action, args = {}) =>
  cy.task('custodyFixture', { action, args }).then((r) => {
    expect(r.ok, `custodyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/** Poll the VAULT until its guard slot holds `expected`, tolerating "not deployed yet". */
function waitForGuard(address, expected, tries = 90) {
  return cy.task('custodyFixture', { action: 'vaultInfo', args: { address } }).then((r) => {
    if (r.ok && r.guard.toLowerCase() === expected.toLowerCase()) return r
    if (tries <= 0) {
      throw new Error(
        r.ok
          ? `vault ${address} still reports guard ${r.guard} after ${r.nonce} executed transaction(s)`
          : `vault ${address} never became readable: ${r.error}`,
      )
    }
    cy.wait(1000, { log: false })
    return waitForGuard(address, expected, tries - 1)
  })
}

/** Sign in with a fresh passkey; fund the account with native so a self-funded batch can pay. */
function signInAndFund() {
  resetAuthenticators()
  addVirtualAuthenticator()
  cy.visit('/fairwins')
  cy.contains('button', /connect wallet/i).click()
  choosePasskey()
  expectConnected()
  return connectedAddress().then((address) => {
    cy.task('seedUsdcForActiveSession', { address, usdc: '100', native: '1' })
    return cy.wrap(address, { log: false })
  })
}

;(isChromium ? describe : describe.skip)('Passkey vault creation — one sendCalls batch (spec 105)', () => {
  beforeEach(function () {
    if (!Cypress.env('PASSKEY_FULL_STACK')) this.skip()
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PVC-01] deploys + installs the rules in one batch, at the predicted address, and gates chains without a bundler', () => {
    let account
    signInAndFund().then((address) => {
      account = address
    })

    cy.visit('/wallet?tab=custody')
    cy.get('.custody-panel', { timeout: 30000 }).should('be.visible')
    cy.contains('.custody-onchain button', 'Vault actions').click()
    cy.get('[data-testid="vault-action-create"]').click()

    // Sheet 1 — one owner (the passkey account itself), which FR-003 allows only WITH rules.
    cy.get('[data-testid="create-step-type"]').contains('[role="radio"]', 'Complex').click()
    cy.then(() => {
      cy.get('#create-owner-0').clear().type(account)
    })
    cy.get('#create-vault-label').type('Passkey Vault')
    cy.contains('button', 'Next: set rules').click()

    // Sheet 2 — keep the default semantic rules: they are what makes a 1-of-1 a vault at all.
    cy.get('[data-testid="create-step-rules"]').should('be.visible')
    cy.contains('button', 'Next: pick networks').click()
    cy.get('[data-testid="create-step-networks"]').should('be.visible')

    /*
     * The write-rail gate, stated BEFORE anything is attempted: a passkey session has no signer,
     * and Mordor has no bundler, so its chip is disabled with the reason in place — the batch is
     * never attempted there, and the reason names the way out rather than only the obstacle.
     */
    cy.get(`[data-testid="network-chip-${MORDOR}"]`).should('be.disabled')
    cy.get('.create-flow__rail-reason').should('contain.text', 'Connect a wallet that can sign there')

    // Deploy on the local chain: ONE UserOp carrying create + setRules + setGuard.
    cy.get('[data-testid="deploy-button"]').click()
    cy.get('[data-testid="predicted-address"] code', { timeout: 30000 })
      .invoke('text')
      .then((predictedRaw) => {
        const address = predictedRaw.trim()

        // The chain is the finish line: the vault exists at the PREDICTED address and is governed.
        waitForGuard(address, GUARD_V2).then((info) => {
          expect(info.version, 'a real Safe v1.4.1 at the predicted address').to.equal('1.4.1')
          expect(info.threshold).to.equal(1)
          cy.then(() => {
            expect(info.owners.map((o) => o.toLowerCase()), 'the smart account is the owner').to.deep.equal([
              account.toLowerCase(),
            ])
          })
        })
        fixture('policyRules', { address, guard: GUARD_V2 }).then((policy) => {
          expect(policy.rules, 'the realized lanes installed in the same batch').to.have.length(3)
          expect(policy.rules[0].banded, 'lane 1 is the banded everyday lane').to.equal(true)
          expect(policy.rules[2].asset.toLowerCase(), 'lane 3 is the catch-all').to.equal(ANY_ASSET.toLowerCase())
        })

        cy.get('[data-testid="deploy-status-80002"]', { timeout: 90000 }).should('contain.text', 'Live')
        cy.contains('button', 'Continue', { timeout: 60000 }).should('not.be.disabled').click()
        cy.get('[data-testid="create-step-done"]').should('be.visible')
        cy.contains('button', 'Done').click()

        // The record + reference carry the PREDICTED address — nothing was parsed from a receipt.
        cy.then(() => {
          const lc = account.toLowerCase()
          cy.window().then((win) => {
            const records = JSON.parse(win.localStorage.getItem(`fw_user_${lc}_vault_creation_records`) || '[]')
            expect(records.map((r) => r.address.toLowerCase()), 'creation record at the predicted address').to.include(
              address.toLowerCase(),
            )
            const refs = JSON.parse(win.localStorage.getItem(`fw_user_${lc}_custody_vault_references`) || '[]')
            expect(
              refs.some((r) => r.address.toLowerCase() === address.toLowerCase() && Number(r.chainId) === 80002),
              'vault reference on the deployed chain',
            ).to.equal(true)
          })
        })
      })
  })
})
