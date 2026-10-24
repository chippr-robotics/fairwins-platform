/**
 * Encrypted backup and restore, the half that costs gas (spec 032, #1228).
 *
 * The no-chain tier already drives this surface's HONEST-STATE rules — BK-01 (no secret material
 * is ever rendered) and BK-02 (a pointer read that did not settle is never reported as "no
 * backup"). Neither can drive the round trip itself, because recording the pointer is an on-chain
 * transaction the member pays gas for, and admission rule 2 puts that here.
 *
 * What this proves that a mock could not: the pointer the member paid for is ON CHAIN, it names
 * the blob that was actually uploaded, and a device that has been wiped gets its data back by
 * reading that pointer. A dialog saying "backed up" is not evidence of any of it.
 *
 * IPFS is stubbed (`cy.interceptIpfs`), which is the same posture as PRV-04: the stub stores what
 * was uploaded and serves it back, so the encrypt → pin → point → read → fetch → decrypt → apply
 * path runs end to end. Only the storage transport is a double; every assertion below is on chain
 * state or on the member's restored data.
 *
 * Checklist: BKC-01..BKC-02
 */

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // hardhat #0 — the signed-in member
const CONTACT_NICKNAME = 'Backup Round Trip Contact'
const CONTACT_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

/** localStorage key the address book lives under (utils/userStorage + addressBook/constants). */
const bookKey = (account) => `fw_user_${account.toLowerCase()}_addressBook`

/**
 * Put one contact in the member's address book.
 *
 * Seeded through storage rather than the address-book UI on purpose: what is under test is the
 * BACKUP round trip, and driving a second feature's forms to produce the input would make this
 * spec fail whenever that feature's markup moved — a failure that would say nothing about backup.
 */
function seedAddressBook(win, account) {
  win.localStorage.setItem(
    bookKey(account),
    JSON.stringify({
      contacts: [
        {
          id: 'bkc-01-contact',
          nickname: CONTACT_NICKNAME,
          addresses: [{ address: CONTACT_ADDRESS, chainId: 80002, label: 'primary' }],
          notes: '',
        },
      ],
      updatedAt: Date.now(),
    }),
  )
}

function readBook(win, account) {
  try {
    return JSON.parse(win.localStorage.getItem(bookKey(account)) || 'null')
  } catch {
    return null
  }
}

/**
 * Poll the on-chain pointer until it satisfies `predicate`.
 *
 * NOT `cy.task(...).should(...)`. `cy.task` is a command, not a query, so `.should()` retries the
 * ASSERTION against the value the task resolved ONCE — it never re-runs the task. The pointer is
 * written by a transaction that lands after the pin, so that reads a stale "no pointer" and then
 * re-asserts it for the full timeout. Same family as anti-pattern 3: a snapshot reported as state.
 *
 * PREDICATE ON THE CID, NEVER ON `has` ALONE (#1327). The task's `cid` and `has` are two separate
 * eth_calls, so a write landing between them yields `{ has: true, cid: '' }` — a tuple that cannot
 * exist at any single block (`hasPointer` IS `getPointer().length != 0`). A predicate of `r.has`
 * accepts that torn read as settled and the caller then asserts on the pre-write `cid`, which is
 * the flake this spec failed on. Requiring the CID itself means a torn read simply polls again.
 */
function waitForPointer(address, predicate, tries = 30) {
  const check = (remaining) =>
    cy.task('chainTx', { action: 'backupPointer', args: { address } }).then((r) => {
      expect(r.ok, r.error || 'the registry is deployed on this chain').to.equal(true)
      if (predicate(r)) return cy.wrap(r, { log: false })
      if (remaining <= 0) throw new Error(`backup pointer never settled (last: ${JSON.stringify(r)})`)
      cy.wait(1000)
      return check(remaining - 1)
    })
  return check(tries)
}

/** Open the Recovery tab and expand the backup card. */
function openBackupPanel() {
  cy.visit('/wallet?tab=security')
  cy.get('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 30000 }).should('exist')
  cy.get('#backup-header', { timeout: 40000 }).should('exist').click()
  return cy.get('.backup-panel', { timeout: 20000 }).should('be.visible')
}

describe('Encrypted backup and restore — the on-chain pointer (spec 032)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    cy.interceptIpfs()
    cy.mockWeb3Provider({ account: OWNER, preAuthorized: true, realBalances: true })
  })

  /*
   * Whether the load hook seeds. It has to be switchable, because `window:before:load` fires on
   * EVERY page load — including the reload that is supposed to leave the device empty, which
   * silently re-seeded the book and made the wipe a no-op.
   */
  let seeding = true

  /** Seed a contact, open the panel, back up, and yield the interception that pinned it. */
  function backUpAndYieldCid() {
    seeding = true
    cy.on('window:before:load', (win) => { if (seeding) seedAddressBook(win, OWNER) })
    openBackupPanel()
    cy.get('.backup-panel').contains('button', /back up my data/i).click()
    return cy.wait('@ipfsUpload', { timeout: 60000 }).then((interception) => {
      expect(interception.response.statusCode, 'the encrypted blob was pinned').to.equal(200)
      return cy.wrap(interception, { log: false })
    })
  }

  // ---------------------------------------------------------------------------
  // BKC-01 — backing up records a pointer on chain, naming the blob that was pinned
  // ---------------------------------------------------------------------------
  it('[BKC-01] backup.encrypted-sync-roundtrip — the pointer the member paid for is on chain and names the uploaded blob', () => {
    /*
     * Read the pointer BEFORE rather than asserting there is none.
     *
     * "No pointer yet" would be a precondition on a FRESH chain only, and the on-chain tier's
     * checkpoint rewinds within one `cypress run`, not across them — so a reused local node would
     * fail this on state a previous run left, which says nothing about the product (anti-pattern
     * 12). Asserting the pointer MOVED to this run's CID is both state-independent and the
     * stronger claim: it pins that THIS backup wrote it, not that one exists.
     */
    // Start from a KNOWN absence. See clearBackupPointer for why this is cleared rather than
    // asserted: the mock's CIDs come from a per-run counter, so a second run against one node
    // pins the same CID and "the pointer changed" would not be a claim this spec could make.
    cy.task('chainTx', { action: 'clearBackupPointer', args: { ownerIndex: 0 } }).then((r) => {
      expect(r.ok, r.error || 'the pointer was cleared').to.equal(true)
    })
    cy.task('chainTx', { action: 'backupPointer', args: { address: OWNER } }).then((before) => {
      expect(before.ok, before.error || 'the registry is deployed on this chain').to.equal(true)
      expect(before.has, 'the member starts with no pointer').to.equal(false)

      backUpAndYieldCid().then((interception) => {
        const cid = interception.response.body.IpfsHash

        /*
         * What was pinned must be CIPHERTEXT. The whole promise of this feature is that only
         * ciphertext leaves the device, and the one place to check that is the bytes that left.
         */
        const pinned = JSON.stringify(interception.request.body || {})
        expect(pinned, 'the contact nickname must not be pinned in the clear').to.not.include(CONTACT_NICKNAME)
        expect(pinned, 'nor the contact address').to.not.include(CONTACT_ADDRESS)

        // And the chain now points at exactly that blob. Judged on chain, not on the dialog.
        waitForPointer(OWNER, (r) => r.has && Boolean(r.cid)).then((after) => {
          expect(after.cid, 'the pointer names the blob this run pinned').to.include(cid)
        })
      })
    })
  })

  // ---------------------------------------------------------------------------
  // BKC-02 — a wiped device gets its data back from the pointer
  // ---------------------------------------------------------------------------
  it('[BKC-02] backup.encrypted-sync-roundtrip — a cleared device restores from the on-chain pointer', () => {
    /*
     * Backs up again rather than leaning on BKC-01's pointer. A restore test whose precondition is
     * "the previous test passed" reports the previous test twice and cannot be run alone.
     */
    backUpAndYieldCid()

    /*
     * WIPE THE DEVICE. This is the scenario: the member's data now exists only inside the
     * encrypted blob the chain points at. `cy.reload()` after clearing is what makes the app read
     * from a genuinely empty device rather than from state still in memory.
     */
    cy.then(() => { seeding = false })
    cy.window().then((win) => win.localStorage.removeItem(bookKey(OWNER)))
    cy.reload()
    openBackupPanel()
    cy.window().then((win) => {
      expect(readBook(win, OWNER), 'the device starts with no address book').to.equal(null)
    })

    cy.get('.backup-panel').contains('button', /restore my data/i).click()
    cy.get('[role="dialog"]', { timeout: 20000 }).within(() => {
      // Replace, not merge: with nothing on the device the two agree, and replace states the
      // intent under test — everything comes from the backup.
      cy.get('input[type="radio"][value="replace"]').check({ force: true })
      cy.contains('button', /restore|confirm/i).last().click()
    })

    // The blob is fetched from the CID the chain named.
    cy.wait('@ipfsFetch', { timeout: 60000 }).its('response.statusCode').should('eq', 200)

    // The member's data is back — read from storage, not from a success message.
    cy.window({ timeout: 30000 }).should((win) => {
      const book = readBook(win, OWNER)
      expect(book, 'the address book was restored').to.not.equal(null)
      const names = (book.contacts || []).map((c) => c.nickname)
      expect(names, 'the contact that only existed in the backup is back').to.include(CONTACT_NICKNAME)
    })
  })
})
