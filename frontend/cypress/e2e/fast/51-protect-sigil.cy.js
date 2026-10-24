// =============================================================================
// 51-protect-sigil.cy.js
// No-chain E2E for the Sigil cold signer in Protect ▸ Off chain (spec 111).
//
// Unlike 27-protect-hardware, this spec plants NO adapter seam. The app's real Sigil adapter talks
// over real fetch() to the REAL services/sigil-bridge, which talks over a real Unix socket to a
// stand-in sigil-daemon that signs with a local test key (cypress/support/tasks/sigil.js explains
// exactly where that line is and why it is the honest one). Every signature asserted below is a
// real secp256k1 signature, judged by the app's own Verify check.
//
// Checklist: SIG-01..SIG-04
// =============================================================================

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // connected wallet (Hardhat #0)
// The disk's child key. Hardhat #7: public test key, never funded on any real network.
const SIGIL_KEY = '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'
const SIGIL_ADDRESS = '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'
const CHALLENGE = 'Prove you control this Sigil account: e2e challenge 5e1f'

const sigil = (action, args = {}) =>
  cy.task('sigilWorld', { action, args }).then((r) => {
    expect(r.ok, `sigilWorld ${action}: ${r.error || ''}`).to.equal(true)
    return r
  })

const signRequests = () => sigil('log').then(({ requests }) => requests.filter((r) => r.type === 'Sign'))

const openOffChain = () => {
  cy.mockWeb3Provider({ account: OWNER, preAuthorized: true })
  cy.visit('/wallet?tab=custody#custody-offchain')
  cy.get('[data-testid="hw-add"]', { timeout: 40000 }).should('be.visible')
}

/** Drive vendor → pair → connect. Leaves the sheet on whatever step the bridge's answer produces. */
const pairAndConnect = (token) => {
  cy.get('[data-testid="hw-add"]').click()
  cy.get('[data-testid="hw-vendor-sigil"]').should('not.be.disabled').click()
  cy.get('[data-testid="hw-sigil-pairing"]').should('be.visible')
  cy.get('[data-testid="hw-sigil-url"]').should('have.value', 'http://127.0.0.1:7318')
  if (token) cy.get('[data-testid="hw-sigil-token"]').clear().type(token, { delay: 0, log: false })
  cy.get('[data-testid="hw-connect"]').click()
}

const addSigilAccount = (token, label = 'Floppy vault') => {
  pairAndConnect(token)
  cy.get('[data-testid="hw-step-pick"]', { timeout: 20000 }).should('be.visible')
  cy.get('.hw-account-row').should('have.length', 1)
  cy.get('input[placeholder="e.g. Cold storage"]').type(label)
  cy.get('.hw-account-row input[type="checkbox"]').check()
  cy.get('[data-testid="hw-save"]').click()
  cy.get('[data-testid="hw-step-saved"]').should('be.visible')
  cy.get('[data-testid="hw-done"]').click()
}

describe('Protect — Sigil cold signer (spec 111)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  after(() => {
    cy.task('sigilWorld', { action: 'stop' })
  })

  // ---------------------------------------------------------------------------
  // SIG-01 sigil.pair-and-add
  // ---------------------------------------------------------------------------
  it('[SIG-01] sigil.pair-and-add — pairs with the bridge, reads the disk, saves public metadata only', () => {
    sigil('start', { privateKey: SIGIL_KEY }).then(({ token }) => {
      openOffChain()
      pairAndConnect(token)

      cy.get('[data-testid="hw-step-pick"]', { timeout: 20000 }).should('be.visible')
      // The address the page shows is derived from the key the DISK reported — not typed, not guessed.
      cy.get('.hw-account-row').should('have.length', 1)
      cy.get('.hw-account-row__address').should('contain.text', SIGIL_ADDRESS.slice(0, 6))
      cy.get('.hw-account-row__address').should('contain.text', SIGIL_ADDRESS.slice(-4))
      cy.get('.hw-account-row__path').first().should('contain.text', 'sigil:5e1f0a17')
      cy.get('[data-testid="hw-sigil-budget"]').should('contain.text', '742 of 1000 signatures left · disk expires in 30 days')
      // One account per disk: no derivation scheme and no paging to offer.
      cy.get('[data-testid="hw-load-more"]').should('not.exist')
      cy.a11yScan({ context: '.action-sheet', label: 'sigil pick step' })

      cy.get('input[placeholder="e.g. Cold storage"]').type('Floppy vault')
      cy.get('.hw-account-row input[type="checkbox"]').check()
      cy.get('[data-testid="hw-save"]').click()
      cy.get('[data-testid="hw-step-saved"]').should('contain.text', 'unless its Sigil disk is in the drive')
      cy.get('[data-testid="hw-done"]').click()

      cy.get('.hw-list__row').should('have.length', 1).and('contain.text', 'Floppy vault')
      cy.get('.hw-vendor-badge').should('contain.text', 'Sigil')

      // Stored: public metadata in the account store, the token ONLY in device-scoped prefs.
      cy.window().then((win) => {
        const accounts = JSON.parse(win.localStorage.getItem(`fw_user_${OWNER.toLowerCase()}_hardware_accounts`))
        const entry = accounts[SIGIL_ADDRESS.toLowerCase()]
        expect(Object.keys(entry).sort()).to.deep.equal(['addedAt', 'address', 'label', 'path', 'vendor'])
        expect(entry).to.include({ vendor: 'sigil', path: 'sigil:5e1f0a17' })
        expect(JSON.stringify(accounts)).not.to.contain(token)
        const prefs = JSON.parse(win.localStorage.getItem('fw_global_prefs'))
        expect(prefs.sigil_bridge).to.deep.equal({ url: 'http://127.0.0.1:7318', token })
      })

      // Adding an account reads the disk; it never spends a presignature.
      signRequests().should('have.length', 0)
    })
  })

  // ---------------------------------------------------------------------------
  // SIG-02 sigil.failure-vocabulary
  // ---------------------------------------------------------------------------
  it('[SIG-02] sigil.failure-vocabulary — no disk, wrong token and no bridge each say what fixes them', () => {
    sigil('start', { privateKey: SIGIL_KEY }).then(({ token }) => {
      openOffChain()

      // A wrong pairing token: the bridge refuses before the daemon is asked anything.
      pairAndConnect('ab'.repeat(32))
      cy.get('[data-testid="hw-step-connect"] [role="alert"]', { timeout: 20000 }).should(
        'contain.text',
        'did not accept this browser’s pairing token',
      )

      // No disk in the drive.
      sigil('setDisk', { detected: false })
      cy.get('[data-testid="hw-sigil-token"]').clear().type(token, { delay: 0, log: false })
      cy.get('[data-testid="hw-connect"]').click()
      cy.get('[data-testid="hw-step-connect"] [role="alert"]', { timeout: 20000 }).should('contain.text', 'No Sigil disk is inserted')

      // The bridge is not running at all.
      sigil('stopBridge')
      cy.get('[data-testid="hw-connect"]').click()
      cy.get('[data-testid="hw-step-connect"] [role="alert"]', { timeout: 20000 }).should(
        'contain.text',
        'The Sigil bridge on this computer did not answer',
      )

      // None of it spent a presignature.
      signRequests().should('have.length', 0)
    })
  })

  // ---------------------------------------------------------------------------
  // SIG-03 acting as the Sigil account, a message signature verifies to it
  // ---------------------------------------------------------------------------
  it('[SIG-03] sigil.sign-message — acting as the Sigil account, Verify signs with the disk and the proof checks out', () => {
    sigil('start', { privateKey: SIGIL_KEY }).then(({ token }) => {
      openOffChain()
      addSigilAccount(token)

      // Act as it through the one control that changes identity.
      cy.scrollTo('top', { ensureScrollable: false })
      cy.get('.wallet-account-button', { timeout: 30000 }).should('be.visible').click()
      cy.get('.account-identity-trigger', { timeout: 30000 }).click()
      cy.get('.account-switch-menu').contains('.account-switch-opt', 'Floppy vault').click()
      cy.get('.account-address-full', { timeout: 30000 }).invoke('attr', 'title').should('eq', SIGIL_ADDRESS)
      cy.get('body').type('{esc}')

      cy.get('#custody-verify-header', { timeout: 40000 }).click()
      cy.get('[data-testid="custody-acc-verify"]').contains('button', /^Sign$/, { timeout: 20000 }).click()
      cy.get('#verify-sign-message', { timeout: 20000 }).type(CHALLENGE, { delay: 0 })
      cy.get('form[aria-label="Sign a message"]').find('button[type="submit"]').click()

      // The deferred ceremony: the reconnect dialog names the disk, not a device screen.
      cy.contains(/every signature needs this account.s Sigil disk in the drive/, { timeout: 20000 }).should('be.visible')
      cy.contains('.action-sheet button', /^Connect/).click()

      cy.get('[data-testid="signed-document"]', { timeout: 30000 })
        .should('contain.text', SIGIL_ADDRESS)
        .invoke('text')
        .then((doc) => {
          // Exactly one presignature was spent, for an EIP-191 message, on the disk this account names.
          signRequests().then((signs) => {
            expect(signs).to.have.length(1)
            expect(signs[0].chain_id).to.equal(0)
            expect(signs[0].description).to.match(/EIP-191/)
          })

          // And the app's OWN checker — the offline, synchronous verifier — accepts it.
          const signature = doc.match(/0x[0-9a-fA-F]{130}/)?.[0]
          expect(signature, 'the signed document carries a 65-byte signature').to.be.a('string')
          cy.get('.action-sheet__close').click()
          cy.get('[data-testid="custody-acc-verify"]').contains('button', /^Check$/).click()
          cy.get('#verify-check-message', { timeout: 20000 }).type(CHALLENGE, { delay: 0 })
          cy.get('#verify-check-signature').type(signature, { delay: 0 })
          cy.get('#verify-check-address').type(SIGIL_ADDRESS, { delay: 0 })
          cy.get('button.verify-primary').should('not.be.disabled').click()
          cy.get('[data-testid="verify-result"]', { timeout: 20000 }).should('have.attr', 'data-status', 'valid')
        })
    })
  })

  // ---------------------------------------------------------------------------
  // SIG-04 an exhausted disk is refused by name and nothing is signed
  // ---------------------------------------------------------------------------
  it('[SIG-04] sigil.exhausted-disk — an empty disk is named in the add flow before the member relies on it', () => {
    sigil('start', { privateKey: SIGIL_KEY, disk: { presigs_remaining: 0 } }).then(({ token }) => {
      openOffChain()
      pairAndConnect(token)
      cy.get('[data-testid="hw-sigil-low"]', { timeout: 20000 }).should('contain.text', 'no signatures left')
      signRequests().should('have.length', 0)
    })
  })
})
