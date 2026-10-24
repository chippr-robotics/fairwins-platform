/**
 * E2E Tests: Admin Panel (Full-tier)
 *
 * Requires a running Hardhat node with deployed contracts. Verifies the admin control
 * surface renders for an admin (account #0, which the local deploy seeds with all admin
 * roles), that a non-admin is denied, and that the Membership & Revenue app's WRITES
 * actually land on the chain the console names (specs 071 + 093, issue #1228):
 *
 *   ADM-01  the control sections render, treasury recipient prefilled     (read-only)
 *   ADM-02  a non-admin is denied                                          (read-only)
 *   ADM-03  admin.grant-revoke-membership — Members view, judged on-chain
 *   ADM-04  admin.configure-tier — Tiers view, judged on-chain
 *   ADM-05  admin.treasury-withdrawal — Treasury view, judged by balances
 *
 * The write flows follow the 35-admin-single-chain-write pattern: wait on the console's
 * own confirmation FIRST (useAdminTx has awaited tx.wait()), then ask the chain — the
 * contract, not the toast, is the authority on what happened.
 */

import { resetChainBetweenTests } from '../../support/e2e'

const ADMIN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'    // #0 — all admin roles
const NON_ADMIN = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' // #4 — no roles
// Hardhat #17 — never seeded with a membership, so it starts at tier 0. The per-test
// chain revert below makes that a fact rather than a hope on re-runs.
const GRANT_TARGET = '0xbDA5747bFD65F08deb54cb465eB87D40e51B197E'
// A burner recipient for the withdrawal: no seed funds it, so its balance delta IS the
// withdrawal.
const WITHDRAW_RECIPIENT = '0x000000000000000000000000000000000000beef'

const USDC = 10n ** 6n // the app parses USDC amounts at 6 decimals (MembershipRevenueApp)

function connectThenVisitAdmin(account, path = '/admin') {
  cy.mockWeb3Provider({ account })
  cy.visit('/fairwins')
  cy.connectWallet()
  cy.visit(path)
}

const membershipOf = (address) =>
  cy.task('voucherFixture', { action: 'membership', args: { address } }, { timeout: 60000 })

const adminState = (args = {}) =>
  cy.task('chainTx', { action: 'membershipAdminState', args }, { timeout: 60000 })

describe('Admin Panel', () => {
  /*
   * ADM-03/04/05 write membership state (a grant, a tier price, a withdrawal). The revert
   * makes each re-runnable against the same node and keeps a changed Gold price from
   * leaking into every later purchase-flow spec on the shard.
   */
  resetChainBetweenTests()

  /*
   * Spec 093 replaced the single tabbed panel with a Control Room: `/admin` is a launcher of
   * app tiles and each group of controls lives at `/admin/<appId>?view=<viewId>`. The old
   * assertions looked for tab BUTTONS named "Tiers"/"Treasury" on `/admin` itself, which is now
   * a page of tiles — hence the timeout on /tiers/i. App and view ids come from
   * components/admin/adminApps.js, the single app/view/role matrix.
   */
  it('[ADM-01] an admin sees the control sections and the treasury-default withdrawal recipient', () => {
    connectThenVisitAdmin(ADMIN)

    // The Control Room lists the apps this admin is entitled to.
    cy.contains(/membership & revenue/i, { timeout: 15000 }).should('be.visible')
    cy.contains(/incident response/i).should('be.visible')
    cy.contains(/access control/i).should('be.visible')

    // Tier config controls.
    cy.visit('/admin/membership-revenue?view=tiers')
    cy.contains(/configure tier/i, { timeout: 15000 }).should('be.visible')

    // Freeze / unfreeze controls.
    cy.visit('/admin/incident-response?view=moderation')
    cy.contains(/freeze\s*\/\s*unfreeze/i, { timeout: 15000 }).should('be.visible')

    // Treasury withdrawal: recipient pre-filled with the on-chain treasury address.
    cy.visit('/admin/membership-revenue?view=treasury')
    cy.contains(/treasury withdrawal/i, { timeout: 15000 }).should('be.visible')
    cy.get('input[placeholder*="name.eth"]').invoke('val').should('match', /^0x[0-9a-fA-F]{40}$/)
  })

  it('[ADM-02] a non-admin is denied access to the admin panel', () => {
    connectThenVisitAdmin(NON_ADMIN)
    cy.contains(/access restricted/i, { timeout: 15000 }).should('be.visible')
    cy.contains(/configure tier/i).should('not.exist')
  })

  it('[ADM-03] admin.grant-revoke-membership — the Members view grants a tier the chain confirms, and revokes it', () => {
    // The target starts with nothing — asserted, not assumed, so a failed revert would
    // fail HERE with the reason rather than downstream as a grant that "already existed".
    membershipOf(GRANT_TARGET).should((r) => {
      expect(r.ok, r.error).to.equal(true)
      expect(r.tier, 'the target starts with no active membership').to.equal(0)
    })

    connectThenVisitAdmin(ADMIN, '/admin/membership-revenue?view=members')
    cy.contains('h3', /grant membership/i, { timeout: 15000 }).should('be.visible')

    // The Grant card and the Revoke card carry identically-shaped address inputs, so each
    // is addressed through its own heading rather than by input order.
    cy.contains('h3', /grant membership/i)
      .closest('.admin-card')
      .within(() => {
        cy.get('input[type="text"]').first().type(GRANT_TARGET)
        cy.contains('button', /grant membership/i).should('not.be.disabled').click()
      })

    // Console first (useAdminTx has awaited tx.wait()), then the chain — in that order,
    // so the chain read below cannot race the miner.
    cy.contains(/granted bronze wager participant membership/i, { timeout: 90000 }).should('be.visible')
    membershipOf(GRANT_TARGET).should((r) => {
      expect(r.tier, 'the grant reached the MembershipManager').to.equal(1)
      expect(r.expiresAt, 'with a real expiry').to.be.greaterThan(0)
    })

    cy.contains('h3', /revoke membership/i)
      .closest('.admin-card')
      .within(() => {
        cy.get('input[type="text"]').first().type(GRANT_TARGET)
        cy.contains('button', /revoke membership/i).should('not.be.disabled').click()
      })

    cy.contains(/revoked wager participant membership/i, { timeout: 90000 }).should('be.visible')
    membershipOf(GRANT_TARGET).should((r) => {
      expect(r.tier, 'the revoke reached the MembershipManager').to.equal(0)
    })
  })

  it('[ADM-04] admin.configure-tier — a saved tier price is the one the chain then reports', () => {
    // Gold rather than Bronze, so a mis-wired tier selector cannot pass by accident: the
    // default selection is Bronze, and the assertion below reads tier 3 specifically.
    adminState({ tier: 3 }).should((r) => {
      expect(r.ok, r.error).to.equal(true)
      expect(r.tierPriceUSDC, 'the starting Gold price is not the one this test sets').to.not.equal(String(7n * USDC))
    })

    connectThenVisitAdmin(ADMIN, '/admin/membership-revenue?view=tiers')
    cy.contains('h3', /configure tier/i, { timeout: 15000 }).should('be.visible')

    // NOT /^Tier$/: a label wrapping a <select> carries every option's text in its own
    // textContent, so an exact match can never hit. 'Tier' as a substring is unique here.
    cy.contains('label', 'Tier').find('select').select('Gold')
    cy.contains('label', /price \(usdc\)/i).find('input').clear().type('7')
    cy.contains('button', /save tier config/i).should('not.be.disabled').click()

    cy.contains(/tier gold configured at \$7/i, { timeout: 90000 }).should('be.visible')
    adminState({ tier: 3 }).should((r) => {
      expect(r.tierPriceUSDC, 'the price every future Gold purchase will be quoted').to.equal(String(7n * USDC))
      expect(r.tierActive, 'and the tier stayed purchasable').to.equal(true)
    })
  })

  it('[ADM-05] admin.treasury-withdrawal — accrued fees leave the manager and arrive at the named recipient', () => {
    /*
     * Accrued fees exist only because someone PURCHASED — grants and voucher mints do not
     * touch `accruedFees`. So the precondition is a real purchase by a fresh account,
     * through the fixture; the withdrawal is the flow and goes through the console.
     */
    cy.task('voucherFixture', { action: 'purchaseTier', args: {} }, { timeout: 60000 }).then((p) => {
      expect(p.ok, `purchaseTier precondition: ${p.error || ''}`).to.equal(true)

      adminState().then((before) => {
        expect(before.ok, before.error).to.equal(true)
        // Compared as a boolean: this Chai's `greaterThan` takes numbers/dates only, and
        // these are BigInts (`.to.equal` handles BigInt; `.greaterThan` throws on it).
        expect(BigInt(before.accruedFees) > 0n, 'the purchase accrued withdrawable fees').to.equal(true)

        cy.task('chainTx', {
          action: 'tokenBalance',
          args: { token: before.paymentToken, address: WITHDRAW_RECIPIENT },
        }).then((bal) => {
          const recipientBefore = BigInt(bal.balance)

          connectThenVisitAdmin(ADMIN, '/admin/membership-revenue?view=treasury')
          cy.contains('h3', /treasury withdrawal/i, { timeout: 15000 }).should('be.visible')

          // The recipient field arrives prefilled with the configured treasury; this
          // withdrawal names its own recipient so the balance delta is unambiguous.
          cy.contains('label', /recipient/i)
            .find('input')
            .clear()
            .type(WITHDRAW_RECIPIENT)
          cy.contains('label', /^Amount/)
            .find('input')
            .clear()
            .type('1')
          cy.contains('button', /^Withdraw on /, { timeout: 20000 }).should('not.be.disabled').click()

          cy.contains(/withdrew 1/i, { timeout: 90000 }).should('be.visible')

          /*
           * Both halves of the money movement, judged by the chain — WITHOUT assuming the
           * unit. The console parses "1" at whatever decimals the estate read resolved for
           * this chain's payment token (the local mock is 18-dec where real USDC is 6), so
           * the falsifiable claim is conservation: the recipient gained EXACTLY what the
           * manager's accrued figure lost, and it was not nothing.
           */
          adminState().should((after) => {
            expect(BigInt(before.accruedFees) - BigInt(after.accruedFees) > 0n, 'accrued fell').to.equal(true)
          })
          adminState().then((after) => {
            const withdrawn = BigInt(before.accruedFees) - BigInt(after.accruedFees)
            cy.task('chainTx', {
              action: 'tokenBalance',
              args: { token: before.paymentToken, address: WITHDRAW_RECIPIENT },
            }, { timeout: 60000 }).should((bal2) => {
              expect(BigInt(bal2.balance) - recipientBefore, 'the named recipient received exactly what accrued lost').to.equal(withdrawn)
            })
          })
        })
      })
    })
  })
})
