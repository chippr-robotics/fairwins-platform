/**
 * E2E Tests: transfers, swap and vouchers (specs 058 / 033 / 026, Full-tier)
 *
 * Issue #1240, the on-chain half. Each of these is a member signing something that moves their own
 * money, which is admission rule 2 of the e2e policy: it MUST have on-chain-tier coverage, and the
 * outcome must be read back from the chain rather than from the interface that just claimed it.
 *
 *   TR-01  transfer.send-from-home          send funds to someone from the home screen
 *   SW-01  trade.swap-quote-and-execute     swap one asset for another on the active network
 *   VC-01  membership.redeem-voucher        redeem a voucher for membership without paying
 *
 * ── WHAT IS A DOUBLE HERE, AND WHAT THAT COSTS THE ASSERTIONS ─────────────────────────────
 * Only the swap flow uses one. A local node has no Uniswap deployment, so
 * `scripts/deploy/deploy-local-swap.js` puts `contracts/mocks/MockUniswapSwap.sol` behind the
 * `VITE_AMOY_UNISWAP_*` addresses that `networks.js` already builds Amoy's `dex` block from.
 *
 * That double answers a fixed rate. So SW-01 can claim — and does claim — that the app quoted,
 * showed the member a number, obtained the approval, encoded the swap, and that BOTH of the
 * member's balances then moved by exactly what the quote named. It claims nothing about Uniswap's
 * pricing or routing, which are not ours to regress. The rate is asymmetric on purpose (2 WPOL
 * per USDC, 0.5 the other way) so a swap that silently ran backwards cannot pass.
 *
 * TR-01 and VC-01 use no doubles at all: the transfer is a real ERC-20 transfer and the redemption
 * is a real `MembershipManager.redeemVoucher` against the real voucher NFT.
 *
 * ── WHY THE VOUCHER IS REDEEMED BY ACCOUNT #1 ────────────────────────────────────────────
 * The seed gives both #0 and #1 an active membership, and `redeemVoucher` refuses one to a member
 * who already has one — so VC-01 does not name its redeemer at all. It asks the fixture for the
 * first hardhat account that owes nothing to an earlier run, which is what keeps the flow
 * re-runnable: redeeming is permanent for the membership's duration, so a fixed account would make
 * this pass exactly once against any given node.
 */

import { resetChainBetweenTests } from '../../support/e2e'

const MEMBER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // #0 — the seeded member
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // #1 — the transfer's counterparty


const HOME_URL = '/fairwins'
const TRADE_URL = '/wallet?tab=trade'
const VOUCHERS_URL = '/vouchers'

const chain = (action, args = {}) =>
  cy.task('chainTx', { action, args }).then((r) => {
    expect(r.ok, `chainTx ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

const vouchers = (action, args = {}) =>
  cy.task('voucherFixture', { action, args }).then((r) => {
    expect(r.ok, `voucherFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/**
 * Enter an amount on the home screen's keypad.
 *
 * `AmountKeypad` is a BUTTON PAD, not a text input — there is no `#pay-amount` field to type into,
 * only `#pay-amount-key-<digit>` and `#pay-amount-key-decimal`. Pressing the keys is also what a
 * member does, so this drives the surface rather than working around it.
 */
const enterAmount = (amount) => {
  for (const ch of String(amount)) {
    cy.get(ch === '.' ? '#pay-amount-key-decimal' : `#pay-amount-key-${ch}`).click()
  }
}

/** Choose a token in one of the Trade panel's two pickers, by symbol. */
const pickToken = (pickerLabel, symbol) => {
  cy.get(`[aria-label="${pickerLabel}"]`, { timeout: 20000 }).click()
  cy.get('.trade-token-popover .trade-token-search').type(symbol)
  cy.get(`.trade-token-popover [role="option"][aria-label^="${symbol} on "]`).first().click()
  cy.get(`[aria-label="${pickerLabel}"]`).should('contain.text', symbol)
}

/** A token balance as a BigInt, read once from the chain rather than from the interface. */
const balanceOf = (token, address) =>
  chain('tokenBalance', { token, address }).then((r) => BigInt(r.balance))

/**
 * Assert a token balance, RE-READING the chain until it agrees or the timeout expires.
 *
 * `balanceOf(...).should(...)` looks equivalent and is not: the `.then()` inside it ends the
 * retryable chain, so `should` re-runs its callback against one frozen value forever. This ends in
 * `.should()` directly on the `cy.task`, which Cypress does re-invoke — so the assertion waits for
 * the transaction to mine instead of racing it. TR-01 failed exactly this way first: the confirm
 * button still read "Sending…" while the balance check had already decided nothing moved.
 */
const expectBalance = (token, address, assertion) =>
  cy.task('chainTx', { action: 'tokenBalance', args: { token, address } }, { timeout: 60000 }).should((r) => {
    expect(r.ok, `chainTx tokenBalance: ${r.error || 'no error message returned'}`).to.equal(true)
    assertion(BigInt(r.balance))
  })

describe('Transfers, swap and vouchers (specs 058 / 033 / 026)', () => {
  /*
   * PER-TEST CHAIN ISOLATION, because every test here writes state a re-run would trip over.
   *
   * VC-01 is the sharp case: it asserts the redeemer has NO active membership, and then grants
   * them one. Without a revert it would pass exactly once against any given node and fail for the
   * rest of that node's life — the same shape as a test that depends on what an earlier test left
   * behind, which the policy calls unfalsifiable. The transfer and the swap move balances that
   * each test reads before and after, so they are indifferent to the revert; VC-01 needs it.
   *
   * There is no spec-level `before` fixture to survive the reverts, so this sits at the top of the
   * describe rather than after one.
   */
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[TR-01] transfer.send-from-home — the home screen sends, and both balances move by the amount sent', () => {
    /*
     * The home screen's default mode IS the send surface (spec 058 US1), which is the whole point
     * of that spec: paying someone is not a thing you navigate to. So this drives the panel where
     * a member actually meets it, and judges it from the token contract.
     */
    const AMOUNT = '12.5'

    vouchers('swapRate').then(({ usdc }) => {
      // Make the precondition rather than assume it: the member must hold enough to send.
      chain('fund', { address: MEMBER })

      balanceOf(usdc, MEMBER).then((senderBefore) => {
        balanceOf(usdc, RECIPIENT).then((recipientBefore) => {
          cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
          cy.visit(HOME_URL)

          // Pay is the default mode; assert that rather than click to it, because "the default"
          // is the claim spec 058 makes.
          cy.get('section[aria-label="Pay"]', { timeout: 40000 }).should('not.have.attr', 'hidden')
          cy.get('.pay-panel', { timeout: 30000 }).should('be.visible')

          enterAmount(AMOUNT)
          cy.get('[data-testid="amount-keypad-hero"]').should('contain.text', AMOUNT)
          cy.get('#pay-to').clear().type(RECIPIENT)
          cy.get('#pay-note').type('e2e coverage')

          /*
           * Scoped to the panel's own action row. The home screen's MODE SWITCHER also carries a
           * button reading "Pay" — it is how a member gets to this panel — so an unscoped
           * `cy.contains('button', /^Pay$/)` matches the pill, clicks it, and re-selects the mode
           * that is already open. Nothing errors; the confirm step simply never arrives.
           */
          cy.get('.pay-panel .fm-success-actions')
            .contains('button', /^Pay$/)
            .scrollIntoView()
            .should('not.be.disabled')
            .click()

          // The confirm step is where the fee is disclosed, before any signature.
          cy.get('[data-testid="pay-confirm"]', { timeout: 20000 }).should('be.visible')
          cy.get('.pay-confirm-amount').should('contain.text', AMOUNT)
          cy.get('.pay-confirm-row').contains('Fee').parent().should('be.visible')
          cy.contains('button', /^Confirm$/).click()

          // The member is TOLD it went, and then the token is asked whether it did. Both matter:
          // a notification without a transfer is the failure this tier exists to catch, and a
          // transfer without a notification leaves a member unsure whether to send again.
          cy.get('.notification-message', { timeout: 60000 })
            .invoke('text')
            .should('match', /Sent 12\.5 USDC|Submitted 12\.5 USDC/i)

          const sent = 125n * 10n ** 17n // 12.5, in the local token's 18 decimals
          expectBalance(usdc, RECIPIENT, (after) => {
            expect(after - recipientBefore, 'the recipient received exactly the amount sent').to.equal(sent)
          })
          expectBalance(usdc, MEMBER, (after) => {
            expect(senderBefore - after, 'and the sender is down exactly that much').to.equal(sent)
          })
        })
      })
    })
  })

  it('[SW-01] trade.swap-quote-and-execute — the member is shown a number, and both balances move by it', () => {
    /*
     * The claim under test is the one a member cares about: what the quote said is what they got.
     * So the quote is read off the surface and turned into an expected pair of balance deltas,
     * which are then checked against the two token contracts — not against the success banner.
     */
    vouchers('swapRate').then(({ usdc, wmatic, usdcToWmatic }) => {
      // chai's numeric comparisons reject a BigInt outright, so compare in BigInt and assert the
      // boolean — `to.be.greaterThan(0n)` fails with "expected 2000000000000000000 to be a number".
      expect(BigInt(usdcToWmatic) > 0n, 'the local pair has a rate').to.equal(true)
      chain('fund', { address: MEMBER })

      balanceOf(usdc, MEMBER).then((usdcBefore) => {
        balanceOf(wmatic, MEMBER).then((wmaticBefore) => {
          cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
          cy.visit(TRADE_URL)

          // The Trade surface exists here only because the local impersonation opts Amoy into
          // SWAP_CHAIN_IDS and supplies dex addresses (see networks.swap.test.js). If either half
          // were missing this would be an honest absence, and failing here is the right answer.
          cy.get('#trade-amount', { timeout: 40000 }).should('be.visible')

          /*
           * The picker's options carry `aria-label="<symbol> on <network>"`, and their text is the
           * symbol and the network run together — so matching on `/^USDC$/` finds nothing. Going
           * through the popover's own search field is both robust and the member's path.
           */
          pickToken('Token to sell', 'USDC')
          cy.get('#trade-amount').clear().type('10')
          pickToken('Token to buy', 'WPOL')

          // A quote must actually arrive — the summary only renders when one does.
          cy.get('.trade-summary', { timeout: 40000 }).should('be.visible')
          cy.contains('.trade-summary-row', 'Minimum received').should('be.visible')

          cy.get('.trade-execute-btn').should('not.be.disabled').click()

          cy.get('.trade-message.trade-success, .trade-success', { timeout: 90000 }).should('exist')

          const amountIn = 10n * 10n ** 18n
          const expectedOut = (amountIn * BigInt(usdcToWmatic)) / 10n ** 18n
          expectBalance(usdc, MEMBER, (after) => {
            expect(usdcBefore - after, 'exactly the amount offered left the member').to.equal(amountIn)
          })
          expectBalance(wmatic, MEMBER, (after) => {
            expect(after - wmaticBefore, 'and the quoted amount arrived').to.equal(expectedOut)
          })
        })
      })
    })
  })

  it('[VC-01] membership.redeem-voucher — redeeming grants the membership and costs the redeemer nothing', () => {
    /*
     * "Without paying" is half the flow's name and the half a test can get wrong by omission: the
     * USDC was paid at MINT, and redemption moves no funds at all. So the redeemer's balance is
     * asserted UNCHANGED across the redemption, alongside the membership appearing.
     *
     * Minting is a precondition and goes through the fixture; redeeming is the flow and goes
     * through the page.
     */
    vouchers('freshRedeemer').then(({ address: REDEEMER, index }) => {
      vouchers('membership', { address: REDEEMER }).then((before) => {
        expect(before.tier, 'the chosen redeemer starts with no active membership').to.equal(0)
      })

      vouchers('mintVoucher', { index, address: REDEEMER, tier: 1 }).then(({ held, tier }) => {
        expect(held, 'the fixture minted a voucher to the redeemer').to.have.length.greaterThan(0)

        vouchers('swapRate').then(({ usdc }) => {
          balanceOf(usdc, REDEEMER).then((usdcBefore) => {
            cy.mockWeb3Provider({ account: REDEEMER, preAuthorized: true, realBalances: true })
            cy.visit(VOUCHERS_URL)

            cy.get('#vch-redeem-h', { timeout: 40000 }).should('be.visible')

            // One voucher held, so the radio list has exactly the one to choose.
            cy.get('input[name="redeem-voucher"]', { timeout: 30000 }).first().check({ force: true })

            /*
             * The eligibility attestation is the SAME block the membership purchase uses, and it
             * gates the button. Checking every box rather than a named subset is deliberate: a new
             * statement added to that list must not silently stop being confirmed here, and this
             * flow has no opinion about which statements exist — only that a member confirms them.
             */
            cy.get('#membership-attest-title')
              .parents('section, div')
              .first()
              .find('input[type="checkbox"]')
              .each(($box) => cy.wrap($box).check({ force: true }))

            cy.contains('button', /Redeem to this wallet/i).should('not.be.disabled').click()

            cy.contains(/Redeemed/i, { timeout: 90000 }).should('be.visible')

            // The chain is the authority on both halves of the claim.
            cy.then(() => {
              cy.task('voucherFixture', { action: 'membership', args: { address: REDEEMER } }).then((after) => {
                expect(after.ok, after.error).to.equal(true)
                expect(after.tier, 'the membership the voucher carried is now active').to.equal(tier)
                expect(after.expiresAt, 'and it has a real expiry').to.be.greaterThan(0)
              })
              expectBalance(usdc, REDEEMER, (after) => {
                expect(after, 'redeeming moved no funds — the voucher was paid for at mint').to.equal(usdcBefore)
              })
              cy.task('voucherFixture', { action: 'vouchersOf', args: { address: REDEEMER } }).then((r) => {
                expect(r.held, 'and the voucher was burned').to.not.include(held[0])
              })
            })
          })
        })
      })
    })
  })

  it('[VC-02] membership.buy-voucher — the Buy section takes exactly the tier price and the chain holds the voucher', () => {
    /*
     * Spec 026 US1/FR-001a: minting a voucher pulls the tier's USDC price from the buyer —
     * a member signing something that costs them money, which admission rule 2 puts in this
     * tier. VC-01 arranges its voucher through the fixture (correct, as a precondition);
     * this is the flow that proves the Buy section itself. The fixture only FUNDS the buyer:
     * the page sends its own `approve` before the mint, and pre-approving would leave that
     * half of the purchase untested.
     *
     * The buyer is chosen the same way as VC-01's redeemer, and for the same reason: the
     * Vouchers page needs an account the node can sign for, and a fixed one stops being
     * representative after its first purchase-and-redeem against a given node.
     */
    vouchers('freshRedeemer').then(({ address: BUYER }) => {
      vouchers('fundBuyer', { address: BUYER, tier: 1 }).then(({ priceUSDC }) => {
        vouchers('vouchersOf', { address: BUYER }).then(({ held: heldBefore }) => {
          vouchers('swapRate').then(({ usdc }) => {
            balanceOf(usdc, BUYER).then((usdcBefore) => {
              cy.mockWeb3Provider({ account: BUYER, preAuthorized: true, realBalances: true })
              cy.visit(VOUCHERS_URL)

              cy.get('#vch-buy-h', { timeout: 40000 }).should('be.visible')

              // Bronze is the default selection; the button restates tier and quantity, so
              // matching its text is also an assertion that the page quoted ONE Bronze voucher.
              cy.contains('button', /^Buy 1 Bronze voucher/, { timeout: 30000 })
                .should('not.be.disabled')
                .click()

              // Two wallet transactions (approve, then mint) sit behind this one status line.
              cy.contains(/minted to your wallet/i, { timeout: 90000 }).should('be.visible')

              // The chain is the authority on both halves: the voucher exists in the buyer's
              // hands, and exactly the quoted price left them — no more, no less.
              cy.then(() => {
                cy.task('voucherFixture', { action: 'vouchersOf', args: { address: BUYER } }, { timeout: 60000 })
                  .should((r) => {
                    expect(r.ok, r.error).to.equal(true)
                    expect(r.held.length - heldBefore.length, 'one voucher was minted to the buyer').to.equal(1)
                  })
                expectBalance(usdc, BUYER, (after) => {
                  expect(usdcBefore - after, 'exactly the tier price was paid').to.equal(BigInt(priceUSDC))
                })
              })
            })
          })
        })
      })
    })
  })
})
