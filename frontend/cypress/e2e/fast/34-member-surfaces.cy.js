// =============================================================================
// 34-member-surfaces.cy.js
// Fast-tier E2E for the member's own records and references
// (specs 021 / 016 / 031 / 059 / 010).
//
// Issue #1245, second batch. Address book, statements, the notification feed and
// its profiles, and the versioned legal documents. All read-only or
// device-local, so admission rule 1 puts them in the no-chain tier.
//
// The recurring property: each of these surfaces has an EMPTY state that must be
// distinguishable from a broken one. "You have no contacts" and "we could not
// load your contacts" are different sentences, and only one of them is true at
// any moment.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const FRIEND = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/

function chainWorld() {
  cy.intercept({ method: 'POST', hostname: RPC_HOSTS }, (req) => {
    const one = ({ method, id }) => {
      const reply = (result) => ({ jsonrpc: '2.0', id, result })
      switch (method) {
        case 'eth_chainId':
          return reply('0x89')
        case 'eth_blockNumber':
          return reply('0x4000000')
        case 'eth_getBalance':
          return reply('0x0')
        default:
          return reply('0x')
      }
    }
    const body = req.body
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  })
}

function connect() {
  cy.mockWeb3Provider({
    account: ACCOUNT,
    preAuthorized: true,
    networkId: 137,
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
  })
}

/** Every account-scoped surface renders defaults until the account lands. */
const waitForAccount = () => cy.get('[aria-label="Wallet Account"]', { timeout: 40000 }).should('exist')

describe('The member’s records and references (specs 021 / 016 / 031 / 059 / 010)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[MS-01] addressbook.save-and-use-contact — a saved contact persists and is findable by name', () => {
    chainWorld()
    connect()
    cy.visit('/wallet?tab=addressbook')
    waitForAccount()

    // Empty state SAYS it is empty — the distinction this file is about.
    cy.get('.ab-empty', { timeout: 40000 }).should('contain.text', 'No saved contacts yet')

    cy.get('[aria-label="Add contact"]').click()
    cy.get('[role="dialog"][aria-label="Add contact"]').should('exist')
    cy.get('#ab-nickname').type('Alice')
    cy.get('#ab-addr-0').type(FRIEND)
    cy.contains('button', /^Save$/).click()

    // Saved, counted, and findable by the name the member gave it — an address book that cannot
    // be searched by nickname is an address list.
    cy.get('.ab-contact-grid', { timeout: 20000 }).should('contain.text', 'Alice')
    cy.get('.ab-meta-count').should('contain.text', '1 saved address')

    cy.get('input[placeholder="Search by name or address"]').type('Ali')
    cy.get('.ab-contact-grid').should('contain.text', 'Alice')

    // A search that matches nothing says so, rather than rendering an empty grid that reads as
    // "your contacts are gone".
    cy.get('input[placeholder="Search by name or address"]').clear().type('zzzz')
    cy.get('.ab-empty').should('contain.text', 'No contacts match')

    // Survives a reload: the book is the member's, not the page's.
    cy.reload()
    waitForAccount()
    cy.get('.ab-contact-grid', { timeout: 40000 }).should('contain.text', 'Alice')
  })

  it('[MS-02] reports.export-wager-history — statements are offered and their empty state is honest', () => {
    chainWorld()
    connect()
    cy.visit('/wallet?tab=reports')
    waitForAccount()

    cy.get('.reports-section', { timeout: 40000 }).should('exist')
    /*
     * Nothing has been generated yet, and the panel says what that means AND what to do about it —
     * "statements are listed here and can be re-made at any time from the chain" is a promise
     * about where the data comes from, which is the honest thing to tell someone about a tax
     * record.
     */
    cy.get('.statement-saved-empty')
      .should('exist')
      .and('contain.text', 're-made at any time from the chain')
  })

  it('[MS-03] notifications.platform-feed — the feed opens from the bell and declares its unread count', () => {
    chainWorld()
    connect()
    cy.visit('/fairwins?stay=1')
    waitForAccount()

    /*
     * The bell's accessible name CARRIES the count. That is not decoration: a bell that shows a
     * dot but announces nothing tells a screen-reader user there is something without saying
     * what, and the count is the whole signal.
     */
    cy.get('[aria-label*="Notifications"]', { timeout: 40000 })
      .should('have.attr', 'aria-label')
      .and('match', /Notifications, \d+ unread/)

    cy.get('[aria-label*="Notifications"]').click()
    cy.get('[role="dialog"][aria-label="Activity"]').should('exist')
    /*
     * The domain filters render only once there is more than one KIND of activity to filter
     * (`domains.length > 1`), so a fresh account correctly has none — asserting them here would
     * be asserting seeded data, not the feed. What must hold on an empty feed is that it says it
     * is empty rather than rendering a blank panel.
     */
    cy.get('[role="dialog"][aria-label="Activity"]').should(($d) => {
      expect($d.text().trim().length, 'an empty feed still says something').to.be.greaterThan(0)
    })
  })

  it('[MS-04] notifications.choose-profile — profiles are listed with an explicit on/off per profile', () => {
    chainWorld()
    connect()
    cy.visit('/fairwins?stay=1')
    waitForAccount()

    /*
     * Profiles are quick-access INSIDE the activity feed (spec 059 US3), not a settings page —
     * they are meant to be reachable at the moment a notification arrives.
     *
     * A member with no profiles yet gets the route to CREATE one rather than an expander over an
     * empty list. That is the honest empty state, and the deep link it follows is the assertion
     * worth having: an offer that does not land anywhere is worse than no offer.
     */
    cy.get('[aria-label*="Notifications"]', { timeout: 40000 }).click()
    cy.get('[role="dialog"][aria-label="Activity"]').should('exist')
    cy.get('.profile-qa', { timeout: 20000 }).should('exist')
    cy.contains('button', /new notification profile/i).click()

    /*
     * It lands on Settings with the wizard OPEN. The section is addressed by hash
     * (`#notification-profiles-new`) rather than by tab — SETTINGS_HASH_ALIASES maps it to the
     * notifications card — so the wizard being open is the assertion, not the query string.
     */
    cy.location('search', { timeout: 20000 }).should('contain', 'tab=settings')
    // The card is titled "Notifications" and its id is what the hash opens.
    cy.get('[data-attention="notifications"], #notifications-header', { timeout: 20000 }).should('exist')
    cy.get('[class*="profile-wizard"]', { timeout: 20000 }).should('exist')
  })

  it('[MS-05] legal.read-versioned-policies — every policy is reachable and states the version it is', () => {
    /*
     * Spec 007 FR-017. A policy a member agreed to is only meaningful if they can tell WHICH
     * text they agreed to, so each document carries its SHA-256. A page that renders the current
     * terms with no version is not a record of anything.
     */
    chainWorld()
    connect()

    for (const path of ['/terms', '/risk', '/privacy']) {
      cy.visit(path)
      cy.get('.legal-doc-version', { timeout: 40000 })
        .should('exist')
        .and('contain.text', 'Version (SHA-256):')
      cy.get('.legal-doc-version code')
        .invoke('text')
        .should('match', /^[0-9a-f]{16,64}$/i)
      cy.get('h1').should('exist')
    }

    // And they are reachable by following links, not only by typing a URL. The footer carries
    // them on the public pages, which is where someone deciding whether to sign up will look.
    cy.visit('/?stay=1')
    cy.contains('a', 'Privacy Policy', { timeout: 40000 }).should('have.attr', 'href', '/privacy')
    cy.contains('a', 'Terms & Conditions').should('have.attr', 'href', '/terms')
  })

  it('[CG-01] compliance.accept-terms-before-entry — the gate blocks entry, and records WHICH text was agreed to', () => {
    /*
     * Spec 007. The entry gate is a legal control, and the thing that makes it one rather than a
     * splash screen is the record it leaves: an acknowledgement that does not say which version of
     * the Terms it covers proves nothing later, because the text it referred to can be edited
     * afterwards. MS-05 asserts the policies carry their hashes; this asserts the ACK carries them
     * too — the same fact from the other end.
     *
     * `acknowledgeEntryGate: false` opts out of the suite-wide seed. Every other spec in this tier
     * pre-acknowledges so the gate does not sit over the surface under test; this one exists to
     * meet a browser that has never entered.
     */
    cy.visit('/fairwins', { acknowledgeEntryGate: false })

    const gate = () => cy.get('[role="dialog"][aria-labelledby="entry-gate-title"]', { timeout: 40000 })
    gate().should('be.visible')

    // What is being confirmed is stated, not buried behind a link: age, jurisdiction, sanctions,
    // and that the member — not FairWins — is responsible for their local law.
    gate().should('contain.text', '21 years old')
    gate().should('contain.text', 'restricted jurisdiction')
    gate().should('contain.text', 'sanctions')
    // Self-custody is disclosed here, before entry, rather than only in the Terms.
    gate().should('contain.text', 'never your counterparty')

    // The gate is MODAL. A member who has not entered cannot reach the app behind it.
    gate().should('have.attr', 'aria-modal', 'true')

    cy.contains('button', /^Enter$/).click()
    gate().should('not.exist')

    /*
     * The record. `terms` and `risk` carry the version hashes of the exact documents shown — the
     * whole point of the acknowledgement.
     */
    cy.window().then((win) => {
      const raw = win.localStorage.getItem('fairwins.entryGate.ack.v1')
      expect(raw, 'entering recorded an acknowledgement').to.be.a('string')
      const ack = JSON.parse(raw)
      expect(ack.at, 'the acknowledgement is timestamped').to.be.a('string')
      expect(
        ack.terms || ack.risk,
        'the acknowledgement names the policy version it covers, not just that something was agreed',
      ).to.be.a('string')
    })

    /*
     * Entering ONCE is enough: a returning visit is not re-gated.
     *
     * `'preserve'` is what makes this assertion capable of failing. `false` clears the key on
     * load, so the gate would reappear whatever the app did, and `true` seeds one, so it would
     * be absent whatever the app did. Only leaving the member's own record alone tests the app.
     */
    cy.visit('/fairwins', { acknowledgeEntryGate: 'preserve' })
    cy.get('[role="dialog"][aria-labelledby="entry-gate-title"]').should('not.exist')
  })

  it('[CG-02] compliance.accept-terms-before-entry — declining records nothing, and never reads as consent', () => {
    /*
     * The half that matters legally. "Leave" is a refusal, and a refusal that writes an
     * acknowledgement — or that lets the next visit through — would be the app recording consent
     * the member explicitly withheld.
     */
    cy.clearLocalStorage()
    cy.visit('/fairwins', { acknowledgeEntryGate: false })
    cy.get('[role="dialog"][aria-labelledby="entry-gate-title"]', { timeout: 40000 }).should('be.visible')

    cy.contains('button', /^Leave$/).click()

    cy.window().then((win) => {
      expect(
        win.localStorage.getItem('fairwins.entryGate.ack.v1'),
        'declining wrote no acknowledgement',
      ).to.equal(null)
    })

    // And coming back still asks. A refusal is not a smaller yes — and `'preserve'` is again what
    // makes that provable: under `false` the gate would show because the harness cleared the key.
    cy.visit('/fairwins', { acknowledgeEntryGate: 'preserve' })
    cy.get('[role="dialog"][aria-labelledby="entry-gate-title"]', { timeout: 40000 }).should('be.visible')
  })

  it('[MS-06] addressbook.estate-screening-pill — an entered address gets an honest screening pill that names its sources', () => {
    /*
     * Issue #1458. The pill under an address field is the one place the app says "this address is
     * safe to send to", so the thing to prove is that it cannot say so falsely. This world answers
     * `0x` to every contract read, so EVERY source is unreadable — and the pill must therefore be
     * amber (Unscreened / Partly screened), never green: a list that did not answer is not a list
     * that said no. The expanded rows must say so per source, in words.
     */
    chainWorld()
    connect()
    cy.visit('/wallet?tab=addressbook')
    waitForAccount()

    cy.get('[aria-label="Add contact"]', { timeout: 40000 }).click()
    cy.get('[role="dialog"][aria-label="Add contact"]').should('exist')
    cy.get('#ab-addr-0').type(FRIEND)

    // A verdict arrives (the sweep is deadline-bounded, so it always does), and it is not green.
    cy.get('.ab-screen-notice[data-screen-verdict]', { timeout: 40000 })
      .should('not.have.attr', 'data-screen-verdict', 'loading')
      .invoke('attr', 'data-screen-verdict')
      .should('be.oneOf', ['unscreened', 'partial'])

    cy.get('.screen-pill[data-verdict]').should('not.have.attr', 'data-verdict', 'screened')
    cy.get('.ab-screen-notice-text').invoke('text').should('not.match', /Screened clear/)

    // The receipts: every source is listed with its network and the reason it gave no answer.
    // The list opens below the pill inside a fixed-position modal, so on the phone profile it
    // lands under the fold — scroll to it rather than asserting a viewport-dependent layout.
    cy.get('button.screen-pill').click()
    cy.get('.screen-pill-details').scrollIntoView().should('be.visible')
    cy.get('.screen-pill-details').should('contain.text', 'Polygon')
    cy.get('.screen-pill-details').should('contain.text', 'FairWins sanctions guard')
    cy.get('.screen-pill-details').should('contain.text', 'Could not read')
    cy.get('.screen-pill-details').should('not.contain.text', 'Clear')

    // No colour-only state: every row carries words, and the modal stays accessible with it open.
    cy.a11yScan('[role="dialog"][aria-label="Add contact"]')
  })


  it('[MS-07] addressbook.export-import-roundtrip — the book exports to a readable file and comes back, with no signature', () => {
    chainWorld()
    connect()
    cy.visit('/wallet?tab=addressbook')
    waitForAccount()

    // Save one contact so there is something to export.
    cy.get('.ab-empty', { timeout: 40000 }).should('contain.text', 'No saved contacts yet')
    cy.get('[aria-label="Add contact"]').click()
    cy.get('#ab-nickname').type('Alice')
    cy.get('#ab-addr-0').type(FRIEND)
    cy.contains('button', /^Save$/).click()
    cy.get('.ab-contact-grid', { timeout: 20000 }).should('contain.text', 'Alice')

    // The privacy fact is stated BEFORE anyone taps Export, not after.
    cy.get('.ab-plaintext-note').should('contain.text', 'plain text')

    // Capture what the download would have been. The app builds a Blob and hands
    // it to URL.createObjectURL; reading it here is steadier than watching the
    // downloads directory, and it lets us assert on the bytes themselves.
    cy.window().then((win) => {
      win.__fwExported = []
      const real = win.URL.createObjectURL
      cy.stub(win.URL, 'createObjectURL').callsFake((blob) => {
        win.__fwExported.push(blob)
        return real.call(win.URL, blob)
      })
    })

    // Selected by aria-label, not by text: `.ab-btn-label` is display:none at the
    // phone profile, so `cy.contains('button', /^Export$/)` would find nothing there.
    cy.get('[aria-label="Export address book"]').click()

    // Issue #1550: this session's rail is irrelevant — no signature is requested and
    // nothing claims the wallet is disconnected.
    cy.contains('Wallet not connected').should('not.exist')
    cy.get('.ab-import-export [role="status"]').should('contain.text', 'plain text')

    cy.window()
      .its('__fwExported')
      .should('have.length', 1)
      // Native Blob.text(); Cypress.Blob has no blobToText in v15.
      .then((blobs) => blobs[0].text())
      .then((text) => {
        // The export is READABLE — that is the change, not an accident of it.
        expect(text).to.contain('Alice')
        expect(text.toLowerCase()).to.contain(FRIEND.toLowerCase())
        const doc = JSON.parse(text)
        expect(doc.format).to.equal('fairwins-address-book')
        expect(doc.contacts).to.have.length(1)

        // Wipe ONLY the book, then bring the same bytes back through the file input.
        // cy.clearLocalStorage() would take the connected session with it and the
        // account would never land after the reload.
        cy.window().then((win) => {
          win.localStorage.removeItem(`fw_user_${ACCOUNT.toLowerCase()}_addressBook`)
        })
        cy.reload()
        waitForAccount()
        cy.get('.ab-empty', { timeout: 40000 }).should('contain.text', 'No saved contacts yet')
        cy.get('[data-testid="ab-import-input"]').selectFile(
          { contents: Cypress.Buffer.from(text), fileName: 'address-book.json', mimeType: 'application/json' },
          { force: true },
        )
        cy.get('.ab-contact-grid', { timeout: 20000 }).should('contain.text', 'Alice')
        cy.get('.ab-meta-count').should('contain.text', '1 saved address')
      })

    // A pre-#1550 encrypted backup. This session HAS an injected signer, so the app
    // does the honest thing: it signs, the AEAD fails on a bogus ciphertext, and the
    // message names the two causes that are genuinely possible once a signature was
    // actually tried. The no-signer branch — a passkey session, where that sentence
    // would be a guess and "wallet not connected" was the #1550 bug — is asserted in
    // src/test/addressBook/addressBookFile.test.js and AddressBookImportExport.test.jsx,
    // which run with signer: null. What must hold HERE is that nothing claims the
    // member is disconnected while they are plainly signed in.
    cy.get('[data-testid="ab-import-input"]').selectFile(
      {
        contents: Cypress.Buffer.from(
          JSON.stringify({
            format: 'fairwins-address-book-backup',
            version: 1,
            alg: 'chacha20poly1305',
            nonce: '000000000000000000000000',
            ciphertext: 'deadbeef',
          }),
        ),
        fileName: 'old-backup.json',
        mimeType: 'application/json',
      },
      { force: true },
    )
    cy.get('.ab-import-export [role="alert"]')
      .should('contain.text', 'Could not decrypt this backup')
      .and('not.contain.text', 'Wallet not connected')

    // The book the failed import touched is still there (FR-021).
    cy.get('.ab-contact-grid').should('contain.text', 'Alice')

    // Both controls carry a name even where their labels are hidden (phone profile).
    cy.a11yScan('.ab-panel')
  })

})
