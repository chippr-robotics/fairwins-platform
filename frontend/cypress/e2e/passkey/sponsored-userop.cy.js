// =============================================================================
// spec 050 — a passkey member sends money and FairWins pays the gas.
//
// ACCOUNT-NATIVE TIER, full stack (chain + EntryPoint v0.6 + alto + the verifying
// paymaster + the relay gateway's /v1/paymaster). Admission rule 2 makes this
// mandatory rather than optional: the member signs something that costs money,
// so the flow must be proved against a chain.
//
// WHY THIS CANNOT BE FAKED AT A LOWER TIER. `sponsorPaymasterUrl` resolves at
// BUILD time (networks.js#passkeyConfig from VITE_SPONSOR_PAYMASTER_AMOY), so a
// build without it never constructs a paymaster transport and never issues
// POST /v1/paymaster — there is nothing to intercept. `paymaster-disclosure.cy.js`
// covers exactly that build and asserts the honest negative ("Network fee
// applies"); this file is its positive twin and needs the endpoint to exist.
//
// WHAT MAKES THE CLAIM AIRTIGHT. The account is funded with USDC and ZERO native
// token. An ERC-4337 operation must be prefunded by the sender or by a paymaster,
// and nothing else. So an op that lands from an account whose native balance was
// 0 before and 0 after was paid for by the paymaster — the paymaster's EntryPoint
// deposit falling is the same fact read from the other side. No dialog wording is
// load-bearing here; the disclosure assertions are extra, not the proof.
// =============================================================================

import {
  addVirtualAuthenticator,
  choosePasskey,
  connectedAddress,
  expectConnected,
  isChromium,
  resetAuthenticators,
} from '../../support/webauthn'

// Hardhat account #6 — not the deployer, not alto's executor/utility keys, not the paymaster signer.
const RECIPIENT = '0x976EA74026E726554dB657fA54763abd0C3a0aa9'
const FIVE = 5n * 10n ** 18n // the local stablecoin mock is 18-dec (see dev:e2e)

/**
 * Poll a balance until `check` holds, then hand it back for a real assertion.
 * `cy.task(...).should(...)` cannot do this — cy.task is not a query, so Cypress never re-invokes
 * it and the retry would re-assert the same stale answer. Gives up after the budget and returns
 * the last reading, so the assertion at the call site fails with the actual number.
 */
function pollBalance(address, check, tries = 40) {
  return cy.task('passkeyStack', { action: 'balances', args: { address } }).then((r) => {
    if (check(r) || tries === 0) return r
    return cy.wait(3000).then(() => pollBalance(address, check, tries - 1))
  })
}

function sendUsdc(amount) {
  cy.visit('/wallet?tab=paytransfer')
  cy.get('.pt-form', { timeout: 40000 }).should('exist')
  cy.get('.uas-trigger[aria-label="Asset to send"]').click()
  cy.get('.uas-search').type('USDC')
  cy.get('.uas-list').contains('.uas-sym', 'USDC').click()
  cy.get('#pt-to').type(RECIPIENT)
  cy.get('#pt-amount').type(amount)
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
    cy.task('seedUsdcForActiveSession', { address, usdc: '1000', native })
    return cy.wrap(address, { log: false })
  })
}

;(isChromium ? describe : describe.skip)('Sponsored UserOperations (spec 050)', () => {
  beforeEach(function () {
    if (!Cypress.env('PASSKEY_FULL_STACK')) this.skip()
    cy.clearLocalStorage()
    cy.clearCookies()
    // Leave sponsorship ON for every test; SU-02 turns it off for itself and this puts it back
    // however the previous test ended.
    cy.task('passkeyStack', { action: 'setSponsorship', args: { enabled: true } })
  })

  it('[SU-01] the member pays nothing: the op lands, their native balance never moves, the pool falls', () => {
    let account
    signInAndFund().then((address) => {
      account = address
    })

    cy.then(() => {
      cy.task('passkeyStack', { action: 'balances', args: { address: account } }).as('memberBefore')
      cy.task('passkeyStack', { action: 'balances', args: { address: RECIPIENT } }).as('recipientBefore')
      cy.task('passkeyStack', { action: 'deposit' }).as('poolBefore')
      cy.task('passkeyStack', { action: 'deployed', args: { address: account } }).then((r) => {
        expect(r.deployed, 'the account is still counterfactual — its first action deploys it').to.equal(false)
      })
    })

    cy.get('@memberBefore').then((m) => {
      expect(BigInt(m.native), 'the account holds NO native token, so it cannot pay its own gas').to.equal(0n)
    })

    sendUsdc('5')
    // The rail is disclosed before the amount is even committed, and again in the preview. Both
    // are asserted because they are what the member reads before authorising.
    cy.get('.pt-badge-gasless').should('have.text', '⚡ Gasless · sponsored')
    cy.contains('button', /^Preview$/).click()
    cy.get('.pt-preview', { timeout: 20000 }).should('contain.text', 'Gasless — no network fee')
    cy.contains('button', /^Send$/).click()

    cy.get('@recipientBefore').then((before) => {
      const want = BigInt(before.usdc) + FIVE
      pollBalance(RECIPIENT, (r) => BigInt(r.usdc) >= want).then((after) => {
        expect(BigInt(after.usdc) - BigInt(before.usdc), 'the recipient received 5 USDC').to.equal(FIVE)
      })
    })

    // `account` is assigned inside an earlier `.then`, but a command's ARGUMENTS are built when the
    // command is enqueued — before any of the queue has run — so a top-level
    // `cy.task(..., { address: account })` serialises `undefined` (→ null) and the task reads
    // `getCode(null)`. Every read of `account` below therefore sits inside `cy.then`.
    // (a) The first action activated the account on chain — the deploy rode the same sponsored op.
    cy.then(() => cy.task('passkeyStack', { action: 'deployed', args: { address: account } })).then((r) => {
      expect(r.deployed, 'first-use deployment happened inside the sponsored operation').to.equal(true)
    })

    // (b) THE PROOF. The sender still holds zero native, so it prefunded nothing.
    cy.then(() => cy.task('passkeyStack', { action: 'balances', args: { address: account } })).then((after) => {
      expect(BigInt(after.native), 'the member paid no gas — their native balance never moved').to.equal(0n)
      expect(BigInt(after.usdc), 'and 5 USDC left the account').to.equal(1000n * 10n ** 18n - FIVE)
    })

    // (c) The same fact from the paymaster's side: the sponsorship pool paid for it. Strict, not
    // "non-increasing" — gas on this chain is never free (base fee plus a priority tip), so a
    // deposit that did not move would mean nothing was sponsored.
    cy.get('@poolBefore').then((before) => {
      cy.task('passkeyStack', { action: 'deposit' }).then((after) => {
        // Explicit comparison: chai's ordering matchers are not a contract for BigInt.
        expect(BigInt(after.deposit) < BigInt(before.deposit), 'the paymaster deposit paid the bundler').to.equal(true)
      })
    })

    // (d) And the member is told it was sponsored, in the outcome as well as the offer.
    cy.get('.notification-message').should('contain.text', '(gasless)')
  })

  it('[SU-02] sponsorship refused: the send still lands, self-funded, and says so (never-stranded)', () => {
    let account
    // The member CAN pay here — that is the point of the fallback. Without native they would be
    // stranded, which is a different (and also honest) outcome not under test.
    signInAndFund({ native: '1' }).then((address) => {
      account = address
    })

    // Refuse at the GATEWAY, not in the browser. SIGUSR2 flips the real kill switch and the task
    // waits for /status to agree, so what refuses is the deployment's own policy — an intercept
    // would only prove the client can handle a refusal the test invented.
    cy.task('passkeyStack', { action: 'setSponsorship', args: { enabled: false } }).then((r) => {
      expect(r.sponsorship, 'the gateway confirms sponsorship is paused').to.equal(false)
    })

    cy.then(() => {
      cy.task('passkeyStack', { action: 'balances', args: { address: account } }).as('memberBefore')
      cy.task('passkeyStack', { action: 'balances', args: { address: RECIPIENT } }).as('recipientBefore')
      cy.task('passkeyStack', { action: 'deposit' }).as('poolBefore')
    })

    sendUsdc('5')
    cy.contains('button', /^Preview$/).click()
    cy.get('.pt-preview', { timeout: 20000 }).should('exist')
    cy.contains('button', /^Send$/).click()

    // NEVER STRANDED: the money still moves.
    cy.get('@recipientBefore').then((before) => {
      const want = BigInt(before.usdc) + FIVE
      pollBalance(RECIPIENT, (r) => BigInt(r.usdc) >= want).then((after) => {
        expect(BigInt(after.usdc) - BigInt(before.usdc), 'the recipient received 5 USDC anyway').to.equal(FIVE)
      })
    })

    // The MEMBER paid, and the pool did not — the two halves of "self-funded", each read from the
    // chain rather than inferred from the other.
    cy.get('@memberBefore').then((before) => {
      cy.task('passkeyStack', { action: 'balances', args: { address: account } }).then((after) => {
        expect(BigInt(after.native) < BigInt(before.native), 'the member funded their own gas').to.equal(true)
      })
    })
    cy.get('@poolBefore').then((before) => {
      cy.task('passkeyStack', { action: 'deposit' }).then((after) => {
        expect(BigInt(after.deposit), 'the sponsorship pool paid nothing').to.equal(BigInt(before.deposit))
      })
    })

    /*
     * DISCLOSURE. The outcome notification carries "(gasless)" only when the batch was ACTUALLY
     * sponsored (TransferForm.jsx:382 reads `res.route`, which useTransfer derives from
     * `res.sponsored` — not from the build's configuration). SU-01 proves that suffix can appear
     * at all, which is what stops this absence check from being satisfied by a deleted string.
     */
    cy.get('.notification-message', { timeout: 60000 })
      .should('contain.text', 'Sent 5')
      .and('not.contain.text', 'gasless')
  })
})
