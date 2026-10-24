// =============================================================================
// 30-verify-message.cy.js
// Fast-tier E2E tests for Protect ▸ Verify (spec 084).
//
// Issue #1241. Verify has THREE verdicts, never two, and the third is the whole
// point: `unverifiable` is what an honest system says when it could not settle
// the question. Collapsing it into `invalid` would make an RPC timeout
// indistinguishable from a forgery, and a member acting on that would be acting
// on an accusation nothing supports.
//
// `verifyMessage` is offline and synchronous by type, so the VALID verdict and
// the first UNVERIFIABLE one here touch no network at all. The ESCALATION is a
// network read by design — a contract account has no public key, so only the
// account itself can say whether it stands behind the bytes — and it is the only
// thing stubbed. Making a node unreachable on purpose is the only way to test
// that an unreachable node is not a forged signature.
// =============================================================================

import {
  MESSAGE,
  SIGNATURE,
  SIGNER_ADDRESS,
  OTHER_ADDRESS,
} from '../../../src/test/fixtures/signedMessages'

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const CUSTODY_URL = '/wallet?tab=custody'


/** Every shipped read provider this build resolves runs through publicnode. */
// BOTH rails, or the stub is a lie: since 480720bf every EVM mainnet has a drpc.org FAILOVER,
// so makeReadProvider builds a FallbackProvider — a stub that fails only the publicnode primary
// is answered by LIVE drpc, and "the chain is unreachable" quietly becomes "the chain answered
// tier 0 from production" (issue #1463; spec 42 and the passkey suite hit the same class).
const RPC_PATTERN = /publicnode\.com|drpc\.org/


/**
 * Answer the escalation's `eth_getCode`, or refuse to.
 *
 * `mode: 'unreachable'` fails the request outright — a node that cannot be asked. `mode: 'no-code'`
 * answers honestly that the address holds no contract, which IS a definite negative and the reason
 * the escalation is worth offering at all.
 */
function stubEscalation(mode) {
  cy.intercept({ method: 'POST', url: RPC_PATTERN }, (req) => {
    if (mode === 'unreachable') {
      req.destroy()
      return
    }
    const body = req.body
    const one = ({ method, id }) => {
      switch (method) {
        case 'eth_chainId':
          return { jsonrpc: '2.0', id, result: '0x1' }
        case 'net_version':
          return { jsonrpc: '2.0', id, result: '1' }
        case 'eth_getCode':
          // No contract at that address on this chain — a plain account.
          return { jsonrpc: '2.0', id, result: '0x' }
        case 'eth_blockNumber':
          return { jsonrpc: '2.0', id, result: '0x1312d00' }
        default:
          return { jsonrpc: '2.0', id, result: '0x' }
      }
    }
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  }).as('escalationRpc')
}

/** A vault the member belongs to, seeded into the client-side reference store (spec 043). */
const VAULT_ADDRESS = '0x1111111111111111111111111111111111111111'

/**
 * Seed one vault reference for ACCOUNT before the app boots.
 *
 * `vaultReferences` is a client-side record of which vaults a member belongs to — it is not
 * authoritative over anything on chain, which is exactly why a no-chain test may write it: the
 * vault's existence is not what is under test, the refusal is.
 */
function seedVault() {
  const key = `fw_user_${ACCOUNT.toLowerCase()}_custody_vault_references`
  const value = JSON.stringify([
    { address: VAULT_ADDRESS, chainId: 137, label: 'Test vault', addedAt: 1, role: 'owner' },
  ])
  cy.on('window:before:load', (win) => win.localStorage.setItem(key, value))
}

const openVerify = () => {
  cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true })
  cy.visit(CUSTODY_URL)
  /*
   * Protect's sections are an accordion. `AccordionSection` puts the section id on
   * `data-attention` (the drawer-search deep-link target) and derives the trigger's DOM id from
   * it — there is no element with a bare `#custody-verify`, so addressing that finds nothing and
   * the failure says only "not found". The trigger is what a member clicks.
   */
  cy.get('#custody-verify-header', { timeout: 40000 }).should('exist').click()
  cy.get('[data-testid="custody-acc-verify"]').contains('button', /^Check$/, { timeout: 20000 }).click()
  cy.get('#verify-check-message', { timeout: 20000 }).should('be.visible')
}

const fillCheck = ({ message, signature, address }) => {
  cy.get('#verify-check-message').clear().type(message, { parseSpecialCharSequences: false, delay: 0 })
  cy.get('#verify-check-signature').clear().type(signature, { delay: 0 })
  if (address) cy.get('#verify-check-address').clear().type(address, { delay: 0 })
  cy.get('button.verify-primary').should('not.be.disabled').click()
}

describe('Verify a signature (spec 084)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[VF-01] verify.three-verdicts — valid, invalid, and unverifiable are three different answers', () => {
    /*
     * The rule this exists to hold: a mismatching ECDSA recovery is NOT a negative while the
     * on-chain leg could not run, because that is exactly what a legitimate smart-account
     * signature looks like from outside. Two verdicts would make an RPC timeout indistinguishable
     * from a forgery, and a member acting on that would be acting on a fabricated accusation.
     */

    // ── VALID. Offline, no network, nothing to stub. ────────────────────────────────
    openVerify()
    fillCheck({ message: MESSAGE, signature: SIGNATURE, address: SIGNER_ADDRESS })
    cy.get('[data-testid="verify-result"]', { timeout: 20000 })
      .should('have.attr', 'data-status', 'valid')
      .and('contain.text', SIGNER_ADDRESS)

    // ── UNVERIFIABLE. The same bytes, claimed for somebody else. Offline arithmetic alone
    //    cannot settle it: the claimed account might be a contract that stands behind them.
    fillCheck({ message: MESSAGE, signature: SIGNATURE, address: OTHER_ADDRESS })
    cy.get('[data-testid="verify-result"]')
      .should('have.attr', 'data-status', 'unverifiable')
      .and('contain.text', 'not a failed check')

    // The escalation is offered, and ONLY here — this is the one outcome a network can settle.
    cy.get('#verify-check-chain').should('exist')

    // ── STILL UNVERIFIABLE when the node cannot be asked. THE ASSERTION THAT MATTERS. ──
    stubEscalation('unreachable')
    cy.get('#verify-check-chain').select('1')
    cy.contains('button', /Check on-chain/i).click()
    cy.get('[data-testid="verify-result"]', { timeout: 30000 })
      .should('have.attr', 'data-status', 'unverifiable')
    cy.get('[data-testid="verify-result"]').should('not.have.attr', 'data-status', 'invalid')
    // The offline fact survives the failed escalation rather than being replaced by less.
    cy.get('[data-testid="verify-result"]').should('contain.text', SIGNER_ADDRESS)
  })

  it('[VF-02] verify.three-verdicts — a negative is reported only when it is knowable', () => {
    /*
     * The companion to VF-01, and the reason the escalation is worth offering: when the account
     * ANSWERS — here, by holding no code at all — the claim really is settled, and saying so is
     * not an accusation but a fact the member came for.
     */
    openVerify()
    fillCheck({ message: MESSAGE, signature: SIGNATURE, address: OTHER_ADDRESS })
    cy.get('[data-testid="verify-result"]', { timeout: 20000 })
      .should('have.attr', 'data-status', 'unverifiable')

    stubEscalation('no-code')
    cy.get('#verify-check-chain').select('1')
    cy.contains('button', /Check on-chain/i).click()

    cy.get('[data-testid="verify-result"]', { timeout: 30000 })
      .should('have.attr', 'data-status', 'invalid')
      .and('contain.text', 'holds no contract')
  })


  it('[VF-03] verify.refused-while-operating-as-vault — a vault cannot sign, and the button is not offered', () => {
    /*
     * Spec 084's hardest refusal, and the reason it is a refusal rather than a failed signature.
     *
     * A Safe has no key. If the app signed anyway while the member was operating as a vault, the
     * signature would be their OWN account's — a true signature under a false label, which is the
     * one output a proof-of-control surface must never produce. So the control is withheld and the
     * reason shown in its place, rather than a button that fails on click.
     *
     * Reaching this state is the whole difficulty: the active identity is MEMORY-ONLY (spec 043 —
     * nothing persists an operate-as choice, deliberately), and operate-as is offered only in
     * Transfer. So the test switches there and then walks to Protect THROUGH THE APP. A cy.visit
     * would reload, drop the identity, and quietly test the personal-account path instead — which
     * passes, and proves nothing.
     */
    seedVault()
    cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true, networkId: 137 })
    cy.visit('/wallet?tab=paytransfer')

    // Operate as the vault.
    cy.get('[aria-label="Sending account"]', { timeout: 40000 }).click()
    cy.get('[role="listbox"][aria-label="Sending accounts"]').contains('[role="option"]', 'Test vault').click()
    // The switch took effect — Transfer says so before we leave it, so a failure downstream is
    // never ambiguous about whether the identity was ever set.
    cy.contains('Sending creates a proposal', { timeout: 20000 }).should('exist')

    // …and now walk to Protect through the app, without a page load.
    cy.get('[aria-label="Open menu"], [aria-label="Toggle navigation menu"]', { timeout: 20000 })
      .first()
      .click({ force: true })
    /*
     * Protect lives in the Tools group, and spec 081 folds every group that is not the active one
     * — the active section here is Finance, because that is where the vault was selected. A
     * collapsed section is UNMOUNTED, not hidden, so the item genuinely is not in the DOM until
     * its heading is opened. Headings are named "<label> section" (a group and one of its items
     * can share a name).
     */
    cy.get('[aria-label="Tools section"]', { timeout: 20000 }).then(($h) => {
      if ($h.attr('aria-expanded') !== 'true') cy.wrap($h).click({ force: true })
    })
    cy.get('[aria-label="Site navigation"]').contains('Protect').click({ force: true })
    cy.location('search', { timeout: 20000 }).should('contain', 'tab=custody')

    cy.get('#custody-verify-header', { timeout: 40000 }).should('exist').click()
    cy.get('[data-testid="custody-acc-verify"]').contains('button', /^Sign$/, { timeout: 20000 }).click()

    // The refusal: stated, and specific about why a vault is different.
    cy.get('form[aria-label="Sign a message"]', { timeout: 20000 })
      .should('exist')
      .and('contain.text', 'A vault has no signing key of its own')

    // No signing control is offered at all — not a disabled one, and not one that would fail.
    cy.get('form[aria-label="Sign a message"]').find('button[type="submit"]').should('not.exist')

    /*
     * CHECKING is unaffected. The refusal is about producing a proof under an identity that cannot
     * make one; reading somebody else's proof needs no key and is still available. A blanket
     * "Verify is unavailable while acting as a vault" would be the over-correction.
     */
    // Both forms live in an action sheet, so the Sign one is dismissed before opening Check.
    cy.get('.action-sheet__close').click()
    cy.get('.action-sheet__backdrop').should('not.exist')
    cy.get('[data-testid="custody-acc-verify"]').contains('button', /^Check$/).click()
    cy.get('#verify-check-message', { timeout: 20000 }).should('be.visible').and('not.be.disabled')
  })

})
