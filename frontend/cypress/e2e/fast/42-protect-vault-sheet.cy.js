// =============================================================================
// 42-protect-vault-sheet.cy.js
// Fast-tier E2E for the Protect vault cards + vault sheet (spec 102 — one vault, every network).
//
// Runs WITHOUT a chain, but NOT without data: the two stubbed networks (Polygon + Base) answer
// real JSON-RPC through the app's own read path — `getProvider(chainId)` for every chain the
// wallet is not on, the wallet's provider for the one it is — via `cy.intercept` on the loopback
// URLs the spec-069 member override points them at (support/vaultRpcStub.js). Owners, threshold,
// nonce, hub `Proposed` logs with VERIFIABLE safeTxHashes: the queue below is the product's own
// decoding of ABI-encoded answers, not a fixture handed to a component. Optimism is seeded as a
// third instance and deliberately never answered, so "could not be read" is a fact the app found.
//
// Deliberately no-chain per the tier admission rule: nothing below can cost a member anything —
// the stub refuses every signing method, and the one flow that reaches one (VS-04) is asserting
// that the failure is STATED in the row. The money path through the sheet (approve + execute on
// a private chain) is the on-chain tier's job: full/29-protect-custody.cy.js, CV-08.
//
// Sub-issue of #1228. Flows:
//   VS-01 custody.vault-cards           — one compact card per vault address
//   VS-02 custody.vault-sheet-queue     — "⋯" opens Queue; rows from both chains, each tagged
//   VS-03 custody.vault-sheet-queue     — an unreadable network is NAMED with a retry, never "none pending"
//   VS-04 custody.cross-chain-approve   — approve elsewhere: switch at tap time; refusal stated, nothing signed
//   VS-05 custody.vault-style           — Style changes the card behind the sheet
//   VS-06 custody.vault-details         — owners cross-referenced; add an unknown one in place
//   VS-07 custody.acting-from-sheet     — acting account chosen from the sheet; header follows; one entry
//   VS-08 custody.remove-all-networks   — Remove from Protect forgets every network after confirmation
//   VS-09 custody.load-all-networks     — load an address onto every network it exists on
//   VS-10 wallet.balance-display        — Wrap shows an 18-decimal balance as a figure that fits
//   VS-11 custody.queue-chips           — spec 105: chips filter; read honesty untouched
//   VS-12 custody.vault-details         — spec 105: shared facts once, coverage named
//   VS-A11Y                             — each of the three sheet views scans clean
//
// Checklist: VS-01..VS-10, VS-A11Y
// =============================================================================

import {
  installVaultRpcStub,
  seedVaultEstate,
  forwardWalletToCurrentChain,
  TEST_ACCOUNT,
  OWNER_B,
  OWNER_C,
  VAULT,
  OTHER_VAULT,
  THIRD_VAULT,
  WALLET_CHAIN,
  STUB_CHAINS,
  stubUrl,
  PENDING_COUNT,
  SIGNING_METHODS,
} from '../../support/vaultRpcStub'

const lc = (a) => String(a).toLowerCase()
const ME = lc(TEST_ACCOUNT)
// Per-member stores (utils/userStorage.js): `fw_user_<lowercased wallet>_<key>`.
const REFS_KEY = `fw_user_${ME}_custody_vault_references`
const BOOK_KEY = `fw_user_${ME}_addressBook`
const WALLET_RPC = stubUrl(STUB_CHAINS[WALLET_CHAIN].port)
const RAW_WEI = '2006441459389172406'

const card = (a) => `[data-testid="vault-card-${lc(a)}"]`
// Every card item (the address-keyed ones — `vault-card-pending` inside a card is not a card).
const CARDS = '[data-testid^="vault-card-0x"]'
const menu = (a) => `[data-testid="vault-menu-${lc(a)}"]`
const ROW = '[data-testid="vault-queue-row"]'
const rowOn = (chainId) => `${ROW}[data-chain-id="${chainId}"]`
const chainEntry = (chainId) => `[data-testid="vault-queue-chain"][data-chain-id="${chainId}"]`
const ownerRow = (a) => `[data-testid="vault-owner-row"][data-address="${lc(a)}"]`
const DIALOG = '[role="dialog"]'
const SUMMARY = '[data-testid="vault-queue-summary"]'

const readStore = (win, key) => JSON.parse(win.localStorage.getItem(key) || 'null')

/**
 * Stub both chains, connect the wallet to Polygon (its RPC is the Polygon stub too), seed the
 * estate, and wait for the LIST to have been enriched through the stub — the multi-network card
 * says "3 networks" only once every instance has been read or found unreachable.
 */
function openProtect(walletOptions = {}) {
  const stub = installVaultRpcStub()
  cy.mockWeb3Provider({
    account: TEST_ACCOUNT,
    preAuthorized: true,
    networkId: WALLET_CHAIN,
    rpcUrl: WALLET_RPC,
    ...walletOptions,
  })
  cy.visit('/wallet?tab=custody', { onBeforeLoad: (win) => seedVaultEstate(win) })
  cy.get('.custody-panel', { timeout: 15000 }).should('be.visible')
  cy.get('.custody-onchain').should('be.visible')
  cy.get(card(VAULT), { timeout: 20000 }).should('contain.text', '3 networks')
  return stub
}

/** Open a vault's sheet from its "⋯", optionally landing on a named tab. */
function openSheet(address, tab = null) {
  cy.get(menu(address)).click()
  cy.get(DIALOG).should('be.visible')
  if (tab) {
    cy.get(`${DIALOG} [data-testid="vault-tab-${tab}"]`).click().should('have.attr', 'aria-selected', 'true')
    // `exist`, not `visible`: the panel is taller than the sheet's scroll box and Cypress reads a
    // fixed-position ancestor's overflow as "covered" — what matters is that THIS panel mounted.
    cy.get(`${DIALOG} [data-testid="vault-panel-${tab}"]`).should('exist')
  }
}

function closeSheet() {
  cy.get(`${DIALOG} [aria-label="Close"]`).click()
  cy.get(DIALOG).should('not.exist')
}

/** The Queue view with every stubbed chain read: exactly the seeded proposals, and no more. */
function queueSettled() {
  cy.get(`${DIALOG} ${ROW}`, { timeout: 20000 }).should('have.length', PENDING_COUNT)
  cy.get(`${DIALOG} ${SUMMARY}`).should('not.contain.text', 'Reading')
}

describe('Protect — vault cards and the vault sheet (spec 102)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  // ---------------------------------------------------------------------------
  // VS-01 — one compact card per vault ADDRESS
  // ---------------------------------------------------------------------------
  it('[VS-01] renders one compact card per vault, however many networks it lives on', () => {
    openProtect()
    // Four references (three networks + one other vault) are TWO cards.
    cy.get(CARDS).should('have.length', 2)
    cy.get(card(VAULT)).should('contain.text', '3 networks').and('contain.text', '2 of 3')
    cy.get(card(OTHER_VAULT)).should('contain.text', 'Polygon').and('not.contain.text', 'networks')
    // The pending badge is the same cross-chain read the sheet's Queue makes: the seeded proposals
    // on both readable networks, counted — never a bare zero for a vault whose chains answered.
    cy.get(`${card(VAULT)} [data-testid="vault-card-pending"]`, { timeout: 20000 })
      .should('contain.text', String(PENDING_COUNT))
      .and('contain.text', 'pending')

    // A listbox may own nothing interactive but its options, so the "⋯" lives OUTSIDE every option
    // — a button inside one would be unreachable to assistive tech and invalid ARIA.
    cy.get('[role="listbox"][aria-label="Your vaults"] [role="option"]')
      .should('have.length', 2)
      .each(($opt) => {
        expect($opt.find('button').length, 'no button nested inside an option').to.equal(0)
        expect($opt.text(), 'the option does not carry the menu glyph').not.to.include('⋯')
      })
    cy.get(menu(VAULT)).should('be.visible').and('contain.text', '⋯')
    cy.get(menu(OTHER_VAULT)).should('be.visible')
  })

  // ---------------------------------------------------------------------------
  // VS-02 — "⋯" opens the sheet on Queue; every network's pending work, tagged
  // ---------------------------------------------------------------------------
  it('[VS-02] opens the sheet on Queue with each proposal tagged by its network', () => {
    openProtect()
    // Closed by default: the sheet is a door, not a permanent panel.
    cy.get(DIALOG).should('not.exist')
    openSheet(VAULT)
    cy.get(`${DIALOG} [data-testid="vault-tab-queue"]`).should('have.attr', 'aria-selected', 'true')
    cy.get(`${DIALOG} [data-testid="vault-sheet-networks"]`).should('contain.text', '3 networks')

    queueSettled()
    cy.get(`${DIALOG} ${rowOn(137)}`).should('have.length', 2)
    cy.get(`${DIALOG} ${rowOn(8453)}`).should('have.length', 1)
    cy.get(`${DIALOG} ${rowOn(8453)} .ab-net-pill`).should('contain.text', 'Base')
    cy.get(`${DIALOG} ${rowOn(137)} .ab-net-pill`).each(($pill) => {
      expect($pill.text()).to.include('Polygon')
    })

    // The member's own approval is READ from the chain (approvedHashes), not assumed: Polygon's
    // nonce-5 proposal already carries it, the one queued behind it does not.
    cy.get(`${DIALOG} ${rowOn(137)}`).contains('nonce 5').closest(ROW).within(() => {
      cy.contains('button', 'Approved').should('be.disabled')
      cy.contains('1/2 approvals').should('exist')
    })
    cy.get(`${DIALOG} ${rowOn(137)}`).contains('nonce 6').closest(ROW).within(() => {
      cy.contains('button', 'Approve').should('not.be.disabled')
      cy.contains('0/2 approvals').should('exist')
    })
    cy.get(`${DIALOG} ${SUMMARY}`).should('contain.text', `${PENDING_COUNT} pending`)
  })

  // ---------------------------------------------------------------------------
  // VS-03 — a network that could not be read is named, never shown as empty (FR-019)
  // ---------------------------------------------------------------------------
  it('[VS-03] names the network it could not read, offers a retry, and never calls it "none pending"', () => {
    openProtect()
    openSheet(VAULT)
    queueSettled()

    cy.get(`${DIALOG} ${chainEntry(10)}`)
      .should('have.attr', 'data-state', 'unreadable')
      .and('contain.text', 'Optimism')
      .and('not.contain.text', 'none pending')
      .find('[data-testid="vault-queue-retry"]')
      // The per-network list sits below the rows; the sheet's panel scrolls (max-height 85vh).
      .scrollIntoView()
      .should('be.visible')
    cy.get(`${DIALOG} ${rowOn(10)}`).should('not.exist')
    // The read chains are read, and say so.
    cy.get(`${DIALOG} ${chainEntry(137)}`).should('have.attr', 'data-state', 'read').and('contain.text', 'Polygon: 2 pending')
    cy.get(`${DIALOG} ${chainEntry(8453)}`).should('have.attr', 'data-state', 'read').and('contain.text', 'Base: 1 pending')
    // A total missing a chain is labelled partial and NAMES the chain it is missing.
    cy.get(`${DIALOG} ${SUMMARY}`).should('have.attr', 'data-partial', 'true').and('contain.text', 'Optimism')
  })

  // ---------------------------------------------------------------------------
  // VS-04 — approving on another network: the wallet is switched AT TAP TIME
  // ---------------------------------------------------------------------------
  it('[VS-04] switches the wallet at tap time to approve elsewhere; a refusal is stated and nothing is signed', () => {
    // Phase 1 — the member declines the switch (or the wallet has no such chain).
    const stub = openProtect({ rejectChainSwitch: true })
    openSheet(VAULT)
    queueSettled()
    cy.get(`${DIALOG} ${rowOn(8453)}`).within(() => {
      cy.contains('button', 'Approve').should('not.be.disabled').click()
      // Stated in the row, naming BOTH chains: where the proposal is, and where the wallet stayed.
      cy.get('[role="alert"]').should('be.visible').and('contain.text', 'Base').and('contain.text', 'Polygon')
      cy.contains('button', 'Approve').should('not.be.disabled')
    })
    cy.window().its('ethereum.chainId').should('eq', '0x89')
    cy.then(() => {
      const reached = stub.log.filter((c) => SIGNING_METHODS.includes(c.method) || c.method === 'eth_estimateGas')
      expect(reached, 'nothing was estimated, signed or sent after a refused switch').to.deep.equal([])
    })

    // Phase 2 — the wallet accepts. Same estate, a wallet that honours the switch; the mock now
    // forwards to whichever chain it is ON, as a real wallet does (see vaultRpcStub.js).
    cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true, networkId: WALLET_CHAIN, rpcUrl: WALLET_RPC })
    cy.visit('/wallet?tab=custody', { onBeforeLoad: (win) => seedVaultEstate(win) })
    cy.get(card(VAULT), { timeout: 20000 }).should('contain.text', '3 networks')
    cy.window().then((win) => forwardWalletToCurrentChain(win))
    openSheet(VAULT)
    queueSettled()
    cy.get(`${DIALOG} ${rowOn(8453)}`).contains('button', 'Approve').should('not.be.disabled').click()

    // The wallet moved to Base — at tap time, not at some later confirm.
    cy.window()
      .then((win) => win.ethereum.request({ method: 'eth_chainId' }))
      .should('eq', '0x2105')
    // ...and the action ran against the rebound signer. This tier has no signer that can sign,
    // so the honest outcome is a stated failure in THAT row — never a silent no-op, never a
    // "Switching…" that hangs, and never the row vanishing under the member.
    cy.get(`${DIALOG} ${rowOn(8453)}`, { timeout: 30000 }).should('have.length', 1)
    cy.get(`${DIALOG} ${rowOn(8453)} [role="alert"]`, { timeout: 30000 })
      .scrollIntoView()
      .should('be.visible')
      .invoke('text')
      .should('match', /\S/)
    cy.get(`${DIALOG} ${rowOn(8453)}`).contains('button', 'Switching…').should('not.exist')
  })

  // ---------------------------------------------------------------------------
  // VS-05 — Style is one look for the ADDRESS, on every network
  // ---------------------------------------------------------------------------
  it('[VS-05] restyles the card behind the sheet from the Style view', () => {
    openProtect()
    cy.get(card(VAULT)).find('.account-card').should('not.have.attr', 'data-tint', 'sky')
    openSheet(VAULT, 'style')
    cy.get(`${DIALOG} [data-testid="vault-style-intro"]`).should('contain.text', 'every network').and('contain.text', '(3)')
    cy.get(`${DIALOG} .acs-swatch[data-tint="sky"]`)
      .should('have.attr', 'aria-label', 'Sky shade')
      .click()
      .should('have.attr', 'aria-checked', 'true')
    closeSheet()
    cy.get(card(VAULT)).find('.account-card').should('have.attr', 'data-tint', 'sky')
    // Cosmetics are per address: the other vault is untouched.
    cy.get(card(OTHER_VAULT)).find('.account-card').should('not.have.attr', 'data-tint', 'sky')
  })

  // ---------------------------------------------------------------------------
  // VS-06 — Details: networks, and owners cross-referenced against the address book
  // ---------------------------------------------------------------------------
  it('[VS-06] cross-references owners against the address book and adds an unknown one in place', () => {
    openProtect()
    openSheet(VAULT, 'details')

    // One article per network the vault lives on — the unreachable one says so, in place.
    cy.get(`${DIALOG} [data-testid="vault-network"]`).should('have.length', 3)
    cy.get(`${DIALOG} [data-testid="vault-network"][data-chain-id="137"]`).should('contain.text', 'Polygon').and('contain.text', '2 of 3')
    cy.get(`${DIALOG} [data-testid="vault-network"][data-chain-id="8453"]`).should('contain.text', 'Base').and('contain.text', '2 of 3')
    cy.get(`${DIALOG} [data-testid="vault-network"][data-chain-id="10"]`).should('contain.text', 'Could not be read')

    cy.get(`${DIALOG} [data-testid="vault-owner-row"]`).should('have.length', 3)
    cy.get(`${DIALOG} ${ownerRow(TEST_ACCOUNT)}`).should('have.attr', 'data-source', 'you').and('contain.text', 'You')
    cy.get(`${DIALOG} ${ownerRow(OWNER_B)}`)
      .should('have.attr', 'data-source', 'addressBook')
      .and('contain.text', 'Alice')
      .find('[data-testid="vault-owner-add-book"]')
      .should('not.exist')
    cy.get(`${DIALOG} ${ownerRow(OWNER_C)}`).should('have.attr', 'data-source', 'generated')

    // Add the unknown owner: the row re-renders as an address-book contact without a reload...
    cy.get(`${DIALOG} ${ownerRow(OWNER_C)} [data-testid="vault-owner-add-book"]`).click()
    cy.get(`${DIALOG} ${ownerRow(OWNER_C)}`).should('have.attr', 'data-source', 'addressBook')
    cy.get(`${DIALOG} ${ownerRow(OWNER_C)} [data-testid="vault-owner-add-book"]`).should('not.exist')
    // ...and the contact was written on every network where the chain CONFIRMED the ownership —
    // Optimism could not be read, so nothing is claimed about it.
    cy.window().then((win) => {
      const book = readStore(win, BOOK_KEY)
      expect(book, 'the address book store').to.be.an('object')
      const chains = (book.contacts || [])
        .flatMap((c) => c.addresses || [])
        .filter((a) => lc(a.address) === lc(OWNER_C))
        .map((a) => Number(a.chainId))
        .sort((x, y) => x - y)
      expect(chains, 'the owner is in the book on each readable network').to.deep.equal([137, 8453])
    })
  })

  // ---------------------------------------------------------------------------
  // VS-07 — the acting account, chosen from the sheet; the header follows
  // ---------------------------------------------------------------------------
  it('[VS-07] chooses the acting account from Details; the header follows and the switcher lists the vault once', () => {
    openProtect()
    openSheet(VAULT, 'details')
    cy.get(`${DIALOG} [data-testid="vault-act-as-personal"]`).should('have.attr', 'aria-checked', 'true')
    // ONE entry for the vault, not one per network.
    cy.get(`${DIALOG} [data-testid="vault-act-as-vault:${lc(VAULT)}"]`)
      .should('have.length', 1)
      .click()
      .should('have.attr', 'aria-checked', 'true')
    cy.get(`${DIALOG} [data-testid="vault-act-as-personal"]`).should('have.attr', 'aria-checked', 'false')
    closeSheet()

    // The card marks which vault the member is acting as.
    cy.get(card(VAULT)).find('.account-card').should('have.class', 'is-active')
    cy.get(card(OTHER_VAULT)).find('.account-card').should('not.have.class', 'is-active')

    // The header identity IS the acting account (WalletButton: address, acting tag), and the
    // switcher behind it lists the vault exactly once, selected.
    cy.scrollTo('top', { ensureScrollable: false })
    cy.get('.wallet-account-button').should('be.visible').click()
    cy.get('.account-address-value')
      .invoke('text')
      .should((text) => {
        expect(lc(text)).to.include(lc(VAULT).slice(0, 6))
        expect(lc(text)).to.include(lc(VAULT).slice(-4))
      })
    cy.get('.account-acting-tag').invoke('text').should('match', /Treasury|Multisig/)
    cy.get('.account-identity-trigger').click()
    cy.get('.account-switch-menu [role="option"]')
      .filter((_, el) => lc(el.textContent).includes(lc(VAULT).slice(0, 6)))
      .should('have.length', 1)
      .and('have.attr', 'aria-selected', 'true')
  })

  // ---------------------------------------------------------------------------
  // VS-08 — Remove from Protect forgets EVERY network, after one confirmation
  // ---------------------------------------------------------------------------
  it('[VS-08] removes the vault on every network after confirmation, and the other vault stays', () => {
    openProtect()
    openSheet(VAULT, 'details')
    cy.get(`${DIALOG} [data-testid="vault-remove-confirm"]`).should('not.exist')
    cy.get(`${DIALOG} [data-testid="vault-remove"]`).scrollIntoView().click()
    cy.get(`${DIALOG} [data-testid="vault-remove-confirm"]`).should('contain.text', '3 networks').click()

    cy.get(DIALOG).should('not.exist')
    cy.get(card(VAULT)).should('not.exist')
    cy.get(CARDS).should('have.length', 1)
    cy.get(card(OTHER_VAULT)).should('exist')
    cy.window().then((win) => {
      const refs = readStore(win, REFS_KEY) || []
      expect(refs.filter((r) => lc(r.address) === lc(VAULT)), 'no reference left on any network').to.deep.equal([])
      expect(refs.filter((r) => lc(r.address) === lc(OTHER_VAULT)), 'the other vault is untouched').to.have.length(1)
    })
  })

  // ---------------------------------------------------------------------------
  // VS-09 — load an address onto EVERY network it is a Safe on; never "pick one"
  // ---------------------------------------------------------------------------
  it('[VS-09] loads a vault onto every network it exists on without asking the member to pick one', () => {
    openProtect()
    cy.get('[data-testid="custody-open-vault-actions"]').click()
    cy.get('[data-testid="vault-action-load"]').click()
    cy.get('form.custody-load').scrollIntoView().should('be.visible')
    cy.get('#load-address').clear().type(THIRD_VAULT)
    cy.get('#load-label').clear().type('Ops')
    cy.get('[data-testid="load-vault-submit"]').click()

    // Added somewhere ⇒ the form closes; it does not hold the member for a network choice.
    cy.get('form.custody-load', { timeout: 30000 }).should('not.exist')
    cy.get(DIALOG).should('not.exist')
    cy.get('.custody-onchain button').each(($b) => {
      expect($b.text().trim(), 'no "Use <network>" chooser survives').not.to.match(/^Use /)
    })

    // One new card, on both networks the stub reported a Safe, labelled as the member asked.
    cy.get(CARDS, { timeout: 20000 }).should('have.length', 3)
    cy.get(card(THIRD_VAULT)).should('contain.text', '2 networks').and('contain.text', 'Ops')
    cy.window().then((win) => {
      const refs = readStore(win, REFS_KEY) || []
      const mine = refs.filter((r) => lc(r.address) === lc(THIRD_VAULT)).map((r) => Number(r.chainId)).sort((x, y) => x - y)
      expect(mine, 'one reference per network it was found on').to.deep.equal([137, 8453])
    })
    // The sheet names both networks — the same fact the load reported, read back from the chain.
    openSheet(THIRD_VAULT, 'details')
    cy.get(`${DIALOG} [data-testid="vault-network"]`).should('have.length', 2)
    cy.get(`${DIALOG} [data-testid="vault-network"][data-chain-id="137"]`).should('contain.text', 'Polygon')
    cy.get(`${DIALOG} [data-testid="vault-network"][data-chain-id="8453"]`).should('contain.text', 'Base')
    cy.get(`${DIALOG} button`).each(($b) => {
      expect($b.text().trim()).not.to.match(/^Use /)
    })
  })

  // ---------------------------------------------------------------------------
  // VS-10 — an 18-decimal balance is DISPLAYED rounded; the raw units never reach the screen
  // ---------------------------------------------------------------------------
  it('[VS-10] shows the Wrap balance as a figure that fits, never the raw 18-decimal string', () => {
    installVaultRpcStub()
    // `realBalances` makes the mock ask the chain (the Polygon stub) instead of answering 100 ETH.
    cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true, networkId: WALLET_CHAIN, rpcUrl: WALLET_RPC, realBalances: true })
    cy.visit('/wallet?tab=trade&view=wrap', { onBeforeLoad: (win) => seedVaultEstate(win) })

    cy.get('.pt-wrap-balance-val', { timeout: 20000 })
      .first()
      .should('contain.text', '2.0064')
      .and('not.contain.text', RAW_WEI)
      .and('not.contain.text', '2.006441459389172406')
    cy.get('#pt-wrap-amount-hint')
      .should('contain.text', 'Balance:')
      .and('contain.text', '2.0064')
      .and('not.contain.text', RAW_WEI)
      .and('not.contain.text', '2.006441459389172406')
  })

  // ---------------------------------------------------------------------------
  // Accessibility — the sheet is a modal dialog the app portals over the page, so each scan is
  // scoped to its own root (spec 094), once per view.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // VS-11 (spec 105 US5) — queue chips filter without touching the read honesty
  // ---------------------------------------------------------------------------
  it('[VS-11] chips filter the queue per network and by "Needs you" — the per-chain disclosure stays', () => {
    openProtect()
    openSheet(VAULT)
    queueSettled()

    cy.get(`${DIALOG} [data-testid="vault-queue-row"]`).should('have.length', 3)
    // One chip per network with items, plus All and Needs you.
    cy.get(`${DIALOG} [data-testid="vault-queue-chip-8453"]`).click()
    cy.get(`${DIALOG} [data-testid="vault-queue-row"]`).should('have.length', 1)
    cy.get(`${DIALOG} ${rowOn(8453)}`).should('have.length', 1)
    // Filtering must never hide what could and could not be read (constitution III).
    cy.get(`${DIALOG} [data-testid="vault-queue-chain"]`).should('have.length', 3)
    cy.get(`${DIALOG} [data-testid="vault-queue-chip-needs-you"]`).click()
    // Every visible row now needs THIS member's signature.
    cy.get(`${DIALOG} [data-testid="vault-queue-row"] [data-testid="vault-queue-signed"]`).each(($line) => {
      expect($line.text()).to.match(/needs you/i)
    })
    cy.get(`${DIALOG} .vault-queue__chip`).contains('All').click()
    cy.get(`${DIALOG} [data-testid="vault-queue-row"]`).should('have.length', 3)
    // The honest footer states the abstraction.
    cy.get(`${DIALOG} .vault-queue__footer`).should('contain.text', 'stay on their own chain')
  })

  // ---------------------------------------------------------------------------
  // VS-12 (spec 105 US2) — shared facts stated once, coverage named
  // ---------------------------------------------------------------------------
  it('[VS-12] Details states the shared arrangement once and NAMES the network it could not cover', () => {
    openProtect()
    openSheet(VAULT, 'details')
    cy.get(`${DIALOG} [data-testid="vault-fact-approvals"]`).should('contain.text', '2 of 3 owners')
    // Optimism is seeded and never answers, so the shared facts claim only what was read.
    cy.get(`${DIALOG} [data-testid="vault-facts-coverage"]`).should('contain.text', 'Optimism')
    cy.get(`${DIALOG} [data-testid="vault-same-address"]`).should('exist')
  })

  it('[VS-A11Y] each of the three sheet views has no serious or critical violations', () => {
    openProtect()
    openSheet(VAULT)
    queueSettled()
    for (const view of ['queue', 'style', 'details']) {
      cy.get(`${DIALOG} [data-testid="vault-tab-${view}"]`).click().should('have.attr', 'aria-selected', 'true')
      cy.get(`${DIALOG} [data-testid="vault-panel-${view}"]`).should('exist')
      cy.get(DIALOG).then(($sheet) => {
        cy.a11yScan({ context: $sheet[0], label: `vault sheet — ${view}` })
      })
    }
  })
})
