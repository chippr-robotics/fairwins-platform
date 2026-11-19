/**
 * 46-sigil-operate-as-send.cy.js — spec 111, on-chain tier.
 *
 * A member acting as their Sigil cold account sends value, and the CHAIN says the Sigil account
 * paid. The e2e policy requires this tier for any flow where a member signs something that costs
 * them money; the no-chain tier (fast/51-protect-sigil) covers pairing, adding and the failure
 * vocabulary and is not repeated here.
 *
 * WHY THIS RAIL IS REACHABLE WHEN THE LEDGER/TREZOR ONE IS NOT. `full/40-acting-account-purchase`
 * explains that the spec-085 DEV adapter seam cannot sign, and that a seam fixture which did would
 * be testing the fixture. Sigil has a real boundary to test through instead: the app's real
 * adapter → the real `services/sigil-bridge` → a stand-in daemon on a real Unix socket that does
 * the daemon's exact math contract (prehash in, low-S r||s out). Everything the app does — digest
 * construction, v recovery, recover-and-verify, serialization, broadcast — is the shipped code.
 * See cypress/support/tasks/sigil.js for where the stand-in begins.
 *
 * What each assertion proves:
 *   · the RECIPIENT's token balance rose by exactly the amount — value moved;
 *   · the SIGIL account's balance fell by exactly that amount — the acting account paid, not the
 *     connected wallet (whose balance is asserted unchanged);
 *   · the chain recovered the Sigil address as the sender of the broadcast hash;
 *   · the daemon was asked for exactly ONE signature, on this chain, and was told the broadcast
 *     hash afterwards (the disk usage log's reconciliation record).
 *
 * Checklist: SGO-01
 */

import { resetChainBetweenTests } from '../../support/e2e'

const MEMBER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // #0 — the connected wallet
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // #1
// The disk's child key: Hardhat #7, used by no other spec.
const SIGIL_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'
const SIGIL_ADDRESS = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'
const LABEL = 'Floppy vault'
const HOME_URL = '/fairwins'
const E2E_CHAIN_ID = 80002

const sigil = (action, args = {}) =>
  cy.task('sigilWorld', { action, args }).then((r) => {
    expect(r.ok, `sigilWorld ${action}: ${r.error || ''}`).to.equal(true)
    return r
  })

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

const balanceOf = (token, address) => chain('tokenBalance', { token, address }).then((r) => BigInt(r.balance))

/** Re-read the chain until the assertion holds — see 33-transfers-swap-vouchers for why. */
const expectBalance = (token, address, assertion) =>
  cy.task('chainTx', { action: 'tokenBalance', args: { token, address } }, { timeout: 60000 }).should((r) => {
    expect(r.ok, `chainTx tokenBalance: ${r.error || ''}`).to.equal(true)
    assertion(BigInt(r.balance))
  })

const enterAmount = (amount) => {
  for (const ch of String(amount)) {
    cy.get(ch === '.' ? '#pay-amount-key-decimal' : `#pay-amount-key-${ch}`).click()
  }
}

/**
 * The saved account and this device's pairing, as the no-chain tier's add flow leaves them. Both
 * are client-side records (public metadata + a device credential), so arranging them here is not
 * a shortcut past anything under test: adding is fast/51's subject, sending is this spec's.
 */
const seedSigilAccount = (token) => (win) => {
  win.localStorage.setItem(
    `fw_user_${MEMBER.toLowerCase()}_hardware_accounts`,
    JSON.stringify({
      [SIGIL_ADDRESS.toLowerCase()]: { address: SIGIL_ADDRESS, vendor: 'sigil', path: 'sigil:5e1f0a17', label: LABEL, addedAt: 1 },
    }),
  )
  const prefs = JSON.parse(win.localStorage.getItem('fw_global_prefs') || '{}')
  prefs.sigil_bridge = { url: 'http://127.0.0.1:7318', token }
  win.localStorage.setItem('fw_global_prefs', JSON.stringify(prefs))
}

function actAs(optionText, expectedAddress) {
  cy.scrollTo('top', { ensureScrollable: false })
  cy.get('.wallet-account-button', { timeout: 30000 }).should('be.visible').click()
  cy.get('.account-identity-trigger', { timeout: 30000 }).click()
  cy.get('.account-switch-menu').contains('.account-switch-opt', optionText).click()
  cy.get('.account-address-full', { timeout: 30000 }).invoke('attr', 'title').should('eq', expectedAddress)
  cy.get('body').type('{esc}')
  cy.get('.account-switch-menu').should('not.exist')
}

describe('Sigil cold signer — operate-as send (spec 111)', () => {
  resetChainBetweenTests()

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  after(() => {
    cy.task('sigilWorld', { action: 'stop' })
  })

  it('[SGO-01] sigil.operate-as-send — acting as the Sigil account, a send settles and the chain names Sigil as the sender', () => {
    const AMOUNT = '7.5'
    const sent = 75n * 10n ** 17n // 7.5 in the local token's 18 decimals

    vouchers('swapRate').then(({ usdc }) => {
      // The Sigil account holds the token it sends and the gas to send it; nothing else does it a favour.
      cy.task('seedUsdcForActiveSession', { address: SIGIL_ADDRESS, usdc: '100', native: '5' }).then((r) => {
        expect(r.ok, 'seed the Sigil account').to.equal(true)
      })

      sigil('start', { privateKey: SIGIL_KEY }).then(({ token }) => {
        balanceOf(usdc, SIGIL_ADDRESS).then((sigilBefore) => {
          balanceOf(usdc, RECIPIENT).then((recipientBefore) => {
            balanceOf(usdc, MEMBER).then((memberBefore) => {
              cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
              cy.visit(HOME_URL, { onBeforeLoad: seedSigilAccount(token) })

              actAs(LABEL, SIGIL_ADDRESS)

              cy.get('.pay-panel', { timeout: 40000 }).should('be.visible')
              enterAmount(AMOUNT)
              cy.get('[data-testid="amount-keypad-hero"]').should('contain.text', AMOUNT)
              cy.get('#pay-to').clear().type(RECIPIENT)
              cy.get('.pay-panel .fm-success-actions').contains('button', /^Pay$/).scrollIntoView().should('not.be.disabled').click()

              cy.get('[data-testid="pay-confirm"]', { timeout: 20000 }).should('be.visible')
              cy.get('.pay-confirm-amount').should('contain.text', AMOUNT)
              cy.contains('button', /^Confirm$/).click()

              // The deferred ceremony (spec 088) for a Sigil account: the disk is the consent.
              cy.contains(/every signature needs this account.s Sigil disk in the drive/, { timeout: 30000 }).should('be.visible')
              cy.contains('.action-sheet button', /^Connect/).click()

              // The member is told it went — and then the chain is asked whether it did. The notice
              // is also the retryable wait: `cy.task` is not re-run by `.should()`, so reading a
              // balance before the send lands would judge a transaction that has not been mined.
              cy.get('.notification-message', { timeout: 60000 })
                .invoke('text')
                .should('match', /Sent 7\.5 USDC|Submitted 7\.5 USDC/i)

              expectBalance(usdc, RECIPIENT, (after) => {
                expect(after - recipientBefore, 'the recipient received exactly the amount').to.equal(sent)
              })
              expectBalance(usdc, SIGIL_ADDRESS, (after) => {
                expect(sigilBefore - after, 'the SIGIL account paid it').to.equal(sent)
              })
              expectBalance(usdc, MEMBER, (after) => {
                expect(after, 'the connected wallet paid nothing').to.equal(memberBefore)
              })

              // The daemon: one signature, on this chain, then told which transaction it became.
              cy.task('sigilWorld', { action: 'log' }, { timeout: 30000 })
                .should((r) => {
                  expect(r.requests.some((q) => q.type === 'UpdateTxHash'), 'the broadcast hash was recorded').to.equal(true)
                })
                .then(({ requests }) => {
                  const signs = requests.filter((q) => q.type === 'Sign')
                  expect(signs, 'exactly one presignature spent').to.have.length(1)
                  expect(signs[0].chain_id).to.equal(E2E_CHAIN_ID)
                  expect(signs[0].description.toLowerCase()).to.contain(String(usdc).toLowerCase())
                  const update = requests.find((q) => q.type === 'UpdateTxHash')
                  sigil('txFrom', { hash: update.tx_hash }).then(({ from, to }) => {
                    expect(from.toLowerCase(), 'the chain recovered Sigil as the sender').to.equal(SIGIL_ADDRESS.toLowerCase())
                    expect(to.toLowerCase()).to.equal(String(usdc).toLowerCase())
                  })
                })
            })
          })
        })
      })
    })
  })
})
