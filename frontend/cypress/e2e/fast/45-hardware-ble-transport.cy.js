// =============================================================================
// 45-hardware-ble-transport.cy.js
// Fast-tier E2E for the Ledger-over-Bluetooth rail (spec 085 + spec 102's BLE
// rung). Matrix row `hardware.bluetooth-transport`, issue #1370.
//
// ── WHY THIS IS NO-CHAIN, AND WHY IT STOPS SHORT OF SIGNING ──────────────────
// This file extends 27-protect-hardware.cy.js's pattern (same DEV-only test-adapter
// seam, `window.__fwHardwareTestAdapter__` — adapters.js) rather than duplicating
// it: HW-01..HW-05 there already cover the guided add flow, the accordion, and the
// real-availability fallback, all against whatever transport headless Chromium
// happens to expose (its own HW-05 notes that is WebHID). What is NOT covered
// anywhere is the BLE-FLAVORED copy (connectCopy.js's "pair" strings, only reachable
// with HID absent) and that the metadata a BLE-driven save persists is exactly as
// public as a USB-driven one — both are pure client-side/localStorage facts, so
// admission rule 1 puts them here with no chain.
//
// The matrix note's suggested check — stub navigator (delete hid, plant bluetooth)
// in cy.visit onBeforeLoad, assert the phone-profile copy pairs rather than plugs —
// is exactly what BLE-01 does. What this file deliberately does NOT attempt is
// signing a real transaction over a real Bluetooth Ledger: that requires an actual
// device pairing over an OS-level BLE stack, which no CDP/browser automation can
// simulate honestly. Spec 102 rule 5 (CLAUDE.md) already draws this line for the
// whole native-channels effort — "device-bound flows (BLE signing, real passkey
// PRF) are staged MANUAL protocols in the runbooks, never fake CI coverage" — so
// the signing leg is OUT OF SCOPE for automation, tracked instead by
// docs/runbooks/hardware-wallet-staging-validation.md's manual protocol. Risk is
// tagged `custody` at the matrix level because the FEATURE is custody-adjacent
// (which vendor/rail is offered decides how a member reaches their cold-storage
// keys), but everything actually exercised below — copy, and what gets written to
// storage — is a browser/UI fact, not a signing guarantee, which is why the tier
// is honestly no-chain rather than a fabricated on-chain-shaped test.
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const HARDWARE_STORAGE_KEY = `fw_user_${TEST_ACCOUNT.toLowerCase()}_hardware_accounts`

// Deterministic fake device, same shape as 27-protect-hardware.cy.js's `planted()` —
// the seam's contract (adapters.js) doesn't vary by transport, only the connect
// COPY does (connectCopy.js derives it from detectTransports()).
const HW_ADDRESSES = Array.from({ length: 5 }, (_, i) =>
  `0x${(i + 1).toString(16).padStart(2, '0')}${'cd'.repeat(19)}`,
)

function plantTestAdapter(win) {
  win.__fwHardwareTestAdapter__ = () => ({
    vendor: 'ledger',
    getAddress: (path) => {
      const m = path.match(/(\d+)'?\/0\/0$|0'\/0\/(\d+)$/)
      const idx = Number(m ? m[1] ?? m[2] : 0)
      return Promise.resolve({ address: HW_ADDRESSES[idx] || HW_ADDRESSES[0] })
    },
    getAddresses(paths) {
      return Promise.all(paths.map((p) => this.getAddress(p))).then((r) =>
        r.map((x, i) => ({ path: paths[i], address: x.address })),
      )
    },
    signPersonalMessage: () => Promise.reject(new Error('not exercised here')),
    signTransaction: () => Promise.reject(new Error('not exercised here')),
    close: () => Promise.resolve(),
  })
}

/**
 * The browser-capability stub the matrix note prescribes: HID absent, Bluetooth
 * present — `ledgerTransportKind` (adapters.js) checks WebHID first and only
 * falls to WebBLE when it is truly gone, so this has to REMOVE the accessor, not
 * merely set it to a falsy value (`'hid' in navigator` is true either way; `in`
 * tests for the KEY, not the value). WebHID is an own accessor on
 * `Navigator.prototype`, not the instance, so `delete win.navigator.hid` (which
 * only ever deletes OWN properties) is a silent no-op — the delete has to target
 * the prototype it is actually defined on.
 */
function bleWorld(win) {
  const proto = Object.getPrototypeOf(win.navigator)
  if ('hid' in win.navigator) {
    try {
      delete proto.hid
    } catch {
      /* not configurable in this engine — the precondition assertion below catches it */
    }
  }
  // Always (re)defined as an OWN property, so the test does not depend on whatever
  // Web Bluetooth support the CI runner's Chromium happens to ship.
  Object.defineProperty(win.navigator, 'bluetooth', { value: {}, configurable: true })
}

const openOffchain = (onBeforeLoad) => {
  cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true })
  cy.visit('/wallet?tab=custody#custody-offchain', { onBeforeLoad })
  cy.get('.custody-panel', { timeout: 15000 }).should('be.visible')
  cy.get('[data-testid="custody-acc-offchain"] .acc__trigger').should('have.attr', 'aria-expanded', 'true')
}

describe('Hardware wallets — Bluetooth transport (spec 085 + 102)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[BLE-01] hardware.bluetooth-transport — with HID gone and Bluetooth present, the connect copy pairs rather than plugs', () => {
    openOffchain(bleWorld)

    // Stated as an assertion, not assumed: a browser where the HID accessor cannot be
    // deleted would silently fall through to the USB copy and this test would prove
    // nothing about the BLE rail at all.
    cy.window().should((win) => {
      expect('hid' in win.navigator, 'WebHID was removed').to.equal(false)
      expect('bluetooth' in win.navigator, 'Web Bluetooth is present').to.equal(true)
    })

    cy.get('[data-testid="hw-add"]').click()
    cy.get('[data-testid="hw-step-vendor"]').should('be.visible')

    // The vendor-step hint (adapters.js#vendorAvailability + connectCopy.js#connectGuidance,
    // exact source strings) — "Pair over Bluetooth", never the USB "Connect over USB".
    cy.get('[data-testid="hw-vendor-ledger"] .hw-vendor-option__hint').should('have.text', 'Pair over Bluetooth')
    cy.get('[data-testid="hw-vendor-ledger"]').should('be.enabled')
    cy.get('[data-testid="hw-step-vendor"]').should('not.contain.text', 'Connect over USB')

    cy.get('[data-testid="hw-vendor-ledger"]').click()
    cy.get('[data-testid="hw-step-connect"]').should('be.visible')

    // The full BLE checklist (connectCopy.js LEDGER_BLE_STEPS), verbatim.
    cy.contains('[data-testid="hw-step-connect"] li', 'Turn on your Ledger and unlock it with your PIN.').should(
      'exist',
    )
    cy.contains('[data-testid="hw-step-connect"] li', 'Open the Ethereum app on the device.').should('exist')
    cy.contains(
      '[data-testid="hw-step-connect"] li',
      'Choose your Ledger in the Bluetooth pairing prompt.',
    ).should('exist')

    // The HID-only copy is absent, not just unequal to the shown string — this is what
    // "pairs rather than plugs" actually rules out.
    cy.get('[data-testid="hw-step-connect"]').should('not.contain.text', 'Plug the device into this computer.')

    cy.get('[data-testid="hw-connect"]').should('contain.text', 'Connect Ledger')
  })

  it('[BLE-02] hardware.bluetooth-transport — driving the test adapter through a BLE connect saves PUBLIC METADATA ONLY', () => {
    openOffchain((win) => {
      bleWorld(win)
      plantTestAdapter(win)
    })

    cy.get('[data-testid="hw-add"]').click()
    cy.get('[data-testid="hw-vendor-ledger"]').click()
    cy.get('[data-testid="hw-step-connect"]').should('be.visible')
    cy.get('[data-testid="hw-connect"]').click()

    cy.get('[data-testid="hw-step-pick"]').should('be.visible')
    cy.get('.hw-account-row').should('have.length', 5)
    cy.get('.hw-account-row').first().find('input[type="checkbox"]').check()
    cy.get('input[placeholder="e.g. Cold storage"]').type('BLE cold storage')
    cy.get('[data-testid="hw-save"]').click()
    cy.get('[data-testid="hw-step-saved"]').should('be.visible')
    cy.get('[data-testid="hw-done"]').click()

    cy.get('.hw-list__row').should('have.length', 1).and('contain.text', 'BLE cold storage')
    cy.get('.hw-vendor-badge').should('contain.text', 'Ledger')

    // The authority for "public metadata only" is the persisted record itself
    // (hardwareAccountsStore.js's own shape), not the UI's wording.
    cy.window().then((win) => {
      const raw = win.localStorage.getItem(HARDWARE_STORAGE_KEY)
      expect(raw, 'a hardware account record was persisted').to.be.a('string')

      const entries = Object.values(JSON.parse(raw))
      expect(entries, 'exactly one saved account').to.have.length(1)
      const entry = entries[0]

      // The EXACT field set (hardwareAccounts.js: { address, vendor, path, label, addedAt })
      // — not a superset, not a subset. A field this list does not name would be new data
      // riding along with a BLE save that a USB save never had to declare.
      expect(Object.keys(entry).sort()).to.deep.equal(['address', 'addedAt', 'label', 'path', 'vendor'].sort())
      expect(entry.vendor).to.equal('ledger')
      expect(entry.address).to.match(/^0x[0-9a-fA-F]{40}$/)
      expect(entry.address.toLowerCase()).to.equal(HW_ADDRESSES[0].toLowerCase())
      expect(entry.label).to.equal('BLE cold storage')
      expect(typeof entry.addedAt).to.equal('number')

      // Belt-and-braces over the RAW bytes, not just the known keys: no key material, no
      // xpub, no device identifier beyond the vendor name, whatever shape a future field
      // might take.
      expect(raw.toLowerCase()).to.not.match(/xpub|privkey|private_key|seed|mnemonic|pubkey|publickey/)
    })
  })
})
