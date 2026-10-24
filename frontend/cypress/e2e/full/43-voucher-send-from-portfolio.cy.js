/**
 * E2E Tests: sending a held membership voucher from the Portfolio (spec 026, Full-tier)
 *
 * Flow: membership.send-voucher-from-portfolio —
 *   "Send/Gift a held FWMV voucher from the Portfolio asset sheet, voucher preselected."
 *
 * ── WHY THIS TIER, WHEN HALF THE FLOW LOOKS LIKE NAVIGATION ─────────────────────────────
 * The flow is two claims, and neither survives without a chain:
 *
 *   1. THE DEEP LINK'S PRESELECTION. `/vouchers#vch-transfer` preselects "the first held
 *      voucher" (VouchersPage.jsx:97-107), and the FWMV row only appears in the portfolio at
 *      all because `balanceOf` answered ≥ 1. Both halves are statements ABOUT A HOLDING. In a
 *      no-chain tier the holding would have to be invented — an ERC-721 balance and a
 *      `Transfer`-log scan, stubbed — and the test would then be asserting that the app
 *      preselects a voucher the test made up. That is a test of the stub.
 *   2. THE TRANSFER ITSELF. A voucher is worth the tier price its buyer paid, so sending one
 *      is a member signing something that moves their own money — admission rule 2 puts it in
 *      this tier unconditionally, and the outcome must be read back from the NFT contract
 *      rather than from the line that says "Sent voucher #n".
 *
 * So both live in ONE test, on a real voucher: the deep link is exercised on the way to the
 * transfer, and every claim is settled by `ownerOf` on chain. Splitting the preselection into
 * the no-chain tier would have bought a second test that could only prove the fixture.
 *
 * Nothing here is a double: the voucher is a real `MembershipVoucher` mint and the send is a
 * real `safeTransferFrom`.
 *
 * ── WHY THE ACCOUNTS ARE CHOSEN, NOT NAMED ──────────────────────────────────────────────
 * `freshRedeemer` walks hardhat's own unlocked accounts and returns one that owes nothing to an
 * earlier run — the same reason VC-01 does it. The recipient is chosen the same way from a
 * disjoint range, because this test also asserts that RECEIVING a voucher grants no membership,
 * which is only a claim about an account that had none.
 *
 * Requires `npm run setup:e2e`.
 *
 * Sub-issue of #1400. Checklist: VSP-01
 */

import { resetChainBetweenTests } from '../../support/e2e'

const PORTFOLIO_URL = '/wallet?tab=account&view=portfolio'
const FWMV_ROW_NAME = 'FairWins Membership Voucher'

const vouchers = (action, args = {}) =>
  cy.task('voucherFixture', { action, args }).then((r) => {
    expect(r.ok, `voucherFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/**
 * Who holds a voucher, RE-READ until the chain agrees.
 *
 * `.then()` would end the retryable chain and freeze one answer, so this ends in `.should()` on
 * the task itself — otherwise the ownership check races the transfer it is meant to observe.
 */
const expectHeld = (address, assertion) =>
  cy.task('voucherFixture', { action: 'vouchersOf', args: { address } }, { timeout: 90000 }).should((r) => {
    expect(r.ok, `voucherFixture vouchersOf: ${r.error || 'no error message returned'}`).to.equal(true)
    assertion(r.held.map(String))
  })

describe('Send a held membership voucher from the Portfolio (spec 026)', () => {
  /*
   * PER-TEST CHAIN ISOLATION: this test mints a voucher to a chosen account and then moves it.
   * Without a revert, a re-run against the same node would start from an account that already
   * gave its voucher away, and `freshRedeemer`'s pool would drift — the "passes exactly once"
   * shape the policy calls unfalsifiable.
   */
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[VSP-01] sends the voucher the asset sheet deep-linked to, and the chain hands it to the recipient', () => {
    vouchers('freshRedeemer', { startIndex: 3, endIndex: 10 }).then(({ index, address: SENDER }) => {
      vouchers('freshRedeemer', { startIndex: 12, endIndex: 20 }).then(({ address: RECIPIENT }) => {
        expect(RECIPIENT.toLowerCase(), 'sender and recipient are different accounts')
          .to.not.equal(SENDER.toLowerCase())

        vouchers('mintVoucher', { index, address: SENDER, tier: 1 }).then(({ held }) => {
          expect(held.length, 'the sender holds exactly one voucher to send').to.equal(1)
          const tokenId = String(held[0])

          vouchers('membership', { address: RECIPIENT }).then((before) => {
            expect(before.tier, 'the recipient starts with no membership').to.equal(0)
          })

          cy.mockWeb3Provider({ account: SENDER, preAuthorized: true, realBalances: true })
          /*
           * The portfolio scans testnets only when the member has opted in
           * (`getPortfolioChainIds({ includeTestnets })`), and this whole tier runs on a node
           * impersonating Amoy — so without the preference the FWMV holding is not scanned and
           * the row this flow starts from does not exist. Seeded as the app itself stores it
           * (Preferences → Portfolio writes the same key); the toggle's own UI is not what this
           * flow is about.
           */
          cy.visit(PORTFOLIO_URL, {
            onBeforeLoad(win) {
              win.localStorage.setItem(`fw_user_${SENDER.toLowerCase()}_show_testnet_assets`, 'true')
            },
          })

          // The holding is visible in the portfolio because the chain says the account holds one.
          cy.contains('.portfolio-row-button', FWMV_ROW_NAME, { timeout: 90000 }).click()

          /*
           * The voucher is the ONE NFT with a first-party send flow (AssetDetailSheet.jsx:52-79):
           * a transferable asset must not be presented as four disabled actions. The action's
           * presence and its enabled state are both part of the claim.
           */
          cy.get('.asset-sheet', { timeout: 30000 }).should('be.visible')
          cy.get('.asset-sheet').contains('button', 'Send / Gift').should('not.be.disabled').click()

          // It lands on the transfer block, addressed by its own anchor.
          cy.location('pathname', { timeout: 30000 }).should('eq', '/vouchers')
          cy.location('hash').should('eq', '#vch-transfer')
          cy.get('#vch-transfer', { timeout: 60000 }).should('exist')

          /*
           * PRESELECTED — the point of the deep link. A member who arrived here to SEND lands on
           * a usable form, not a disabled Transfer button, and the control names the exact
           * voucher it will move.
           */
          cy.get(`input[name="redeem-voucher"][value="${tokenId}"]`, { timeout: 60000 }).should('be.checked')
          cy.get('#vch-transfer').contains('button', `Transfer voucher #${tokenId}`).should('be.disabled')

          // Entering a recipient is the only thing the member still owes the form.
          cy.get('#vch-transfer-to').clear().type(RECIPIENT)
          cy.get('#vch-transfer')
            .contains('button', `Transfer voucher #${tokenId}`)
            .should('not.be.disabled')
            .click()

          /*
           * Deliberately NOT the "Sent voucher #n" line. That message lives INSIDE the transfer
           * block, which the page renders only `while myVouchers.length > 0` — so `onTransfer`'s
           * own `refreshVouchers()` takes the message away with the block the moment the re-read
           * lands. Asserting it would be a race against a success notice that is designed to
           * disappear. The STABLE post-condition is the page's own re-read: the sender no longer
           * holds a voucher, so the empty state replaces the list.
           */
          cy.get('.vch-empty', { timeout: 120000 }).should('contain.text', 'any vouchers to redeem')
          cy.get('#vch-transfer').should('not.exist')

          // The chain is the authority: the voucher left the sender and reached the recipient.
          expectHeld(SENDER, (held) => {
            expect(held, 'the voucher is no longer the sender\'s').to.not.include(tokenId)
          })
          expectHeld(RECIPIENT, (held) => {
            expect(held, 'and the recipient now holds it').to.include(tokenId)
          })

          /*
           * Spec 026: "Transferring doesn't grant a membership here." The recipient holds a
           * voucher and still holds NO membership until they redeem it themselves — the whole
           * reason a voucher is a separate, transferable object.
           */
          vouchers('membership', { address: RECIPIENT }).then((after) => {
            expect(after.tier, 'receiving a voucher grants no membership on its own').to.equal(0)
          })
        })
      })
    })
  })
})
