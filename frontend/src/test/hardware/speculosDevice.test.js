// @vitest-environment node
//
// NODE, not jsdom, and it is load-bearing: Speculos answers `/apdu` with a CHUNKED response whose
// first chunk is EMPTY (its Flask handler yields b"" to force the headers out). jsdom's fetch
// hands that back as an empty body — `{}` where the device really said `{"data":"…"}` — so under
// the suite's default environment every exchange silently returned nothing. Nothing about this
// file needs a DOM.
/**
 * The hardware signer against a REAL Ledger Ethereum app — spec 085/110, issue #1593.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────────────
 * `hardwareSigner.js` builds, serializes and cross-checks transactions that move a member's money,
 * and until now nothing could see a defect in it. Every other hardware suite mocks the session, so
 * it answers a question the device no longer asks: a fake that signs with an ethers `Wallet` key
 * proves the signer's own arithmetic and NOTHING about the APDUs, the derivation path the device
 * actually used, or what the member would have been shown before approving.
 *
 * Speculos is Ledger's own emulator of the device — real app firmware, real APDUs, real screens —
 * with the button press driven by automation rules instead of a thumb. The confirmation gate is
 * therefore KEPT and automated rather than removed, which is the distinction that makes this a
 * hardware test and not a mock with extra steps.
 *
 * ── WHAT GREEN HERE DOES AND DOES NOT MEAN ─────────────────────────────────────────────────────
 * Speculos is not the Secure Element; syscalls, the watchdog and timing differ, and Ledger says so.
 * Green means the protocol and the screen flow are right. USB/BLE quirks, firmware drift and the
 * Secure Element stay a physical-device soak (`docs/runbooks/hardware-wallet-staging-validation.md`).
 *
 * ── HOW TO RUN IT ──────────────────────────────────────────────────────────────────────────────
 *   npm run hw:speculos:up      # emulator + pinned app, known test seed
 *   HARDWARE_E2E=1 npx vitest run src/test/hardware/speculosDevice.test.js
 *
 * Skipped when `HARDWARE_E2E` is unset so PR CI stays cheap — and the skip is LOUD: a reason is
 * printed, because a hardware suite that silently vanishes is how this coverage would rot back to
 * nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mnemonicToAccount } from 'viem/accounts'
import { parseTransaction, recoverTransactionAddress, hashTypedData, recoverMessageAddress } from 'viem'
import { connectLedger } from '../../lib/hardware/ledgerAdapter'
import { TransportSpeculosHttp, DEFAULT_SPECULOS_URL } from '../../lib/hardware/speculosTransport'
import { HardwareSigner } from '../../lib/hardware/hardwareSigner'
import { TRANSPORT_KINDS } from '../../lib/hardware/adapters'
import { HardwareWalletError, HW_ERROR_CODES } from '../../lib/hardware/errors'

// The BIP-39 test vector. A WELL-KNOWN, EMPTY seed on purpose: a funded one in a test that a
// contributor can run locally is a seed that gets drained (spec 097's rule about key material —
// nothing here is secret, and nothing here should ever hold value).
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PATH = "m/44'/60'/0'/0/0"
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const URL = process.env.SPECULOS_URL || DEFAULT_SPECULOS_URL

const ENABLED = process.env.HARDWARE_E2E === '1'
const suite = ENABLED ? describe : describe.skip
if (!ENABLED) {
  console.log('[speculosDevice] SKIPPED — set HARDWARE_E2E=1 with `npm run hw:speculos:up` running.')
}

/*
 * ── WHY THE TEST DRIVES THE SCREEN INSTEAD OF `--automation` ──────────────────────────────────
 * Speculos' automation rules look like the obvious answer and cannot express what this needs.
 * Three things were measured on the live device before landing here:
 *
 * 1. `text` is an EXACT match, not containment. The approve screen reads "Sign transaction", so
 *    `{ text: "Sign" }` — which looks right — never fires, and the failure is SILENT: the
 *    catch-all keeps pressing right, the carousel loops, and the APDU never returns.
 * 2. Rules fire PER TEXT EVENT, not per screen (`seproxyhal.apply_automation` loops over every
 *    event in the batch). One screen emits several — "Network" and "Polygon" are two — so a
 *    catch-all pressing right advances TWICE for that screen and overshoots the decision screen.
 *    The both-press then lands on "Reject transaction", and every signature comes back 0x6985:
 *    a suite that looks like the device refusing when it is the automation pressing the wrong
 *    button one screen late.
 * 3. Rules are first-match-wins, so a catch-all cannot be made to skip a screen it matches.
 *
 * Driving from the test is what Ledger's own app tests do (Ragger's navigate-and-compare), and it
 * buys the property that matters here: ONE press per screen actually observed, and the screens are
 * COLLECTED, so a test can assert what the member would have been shown rather than trusting that
 * something somewhere pressed the right button.
 */

/** Screens whose text means "this is the decision", anchored so Reject can never read as Sign. */
const APPROVE_SCREEN = /^(Sign|Accept|Approve)\b/
const REJECT_SCREEN = /^Reject\b/

/**
 * Walk the device to its decision screen and answer it, collecting every screen on the way.
 *
 * The signing promise is deliberately NOT awaited before this runs: the device is blocked waiting
 * for a button, so the APDU only resolves once we answer. That ordering is the whole ceremony.
 *
 * @returns {Promise<string[]>} the screens shown, in order — the review the member would have read
 */
async function answerOnDevice(control, { accept }) {
  const screens = []
  for (let i = 0; i < 80; i += 1) {
    const text = await control.screenText()
    if (text && screens[screens.length - 1] !== text) screens.push(text)
    if (APPROVE_SCREEN.test(text)) {
      if (accept) {
        await control.button('both')
        return screens
      }
      await control.button('right')
      continue
    }
    if (REJECT_SCREEN.test(text)) {
      if (!accept) {
        await control.button('both')
        return screens
      }
      await control.button('left')
      continue
    }
    await control.button('right')
  }
  throw new Error(`device never reached a decision screen; saw: ${JSON.stringify(screens)}`)
}

/** Run a device action and answer its prompt, returning both the result and what was displayed. */
async function withDevice(control, accept, run) {
  const pending = run().then((value) => ({ value }), (error) => ({ error }))
  const screens = await answerOnDevice(control, { accept })
  const settled = await pending
  return { ...settled, screens }
}

suite('HardwareSigner against a real Ledger Ethereum app (Speculos)', () => {
  let session
  let control
  let expectedAddress

  beforeAll(async () => {
    expectedAddress = mnemonicToAccount(SEED).address
    control = new TransportSpeculosHttp(URL)
    // No automation rules at all: this suite presses every button itself (see the note above), so
    // a rule firing in the background would be a second hand on the device.
    await control.setAutomation({ version: 1, rules: [] })
    // The REAL connect path, not a hand-rolled transport: this is what the app runs.
    session = await connectLedger({ transport: TRANSPORT_KINDS.SPECULOS, speculosUrl: URL })
  }, 120_000)

  afterAll(async () => {
    await session?.close?.()
  })

  /*
   * 1. DERIVATION PARITY — the same oracle idea as `derivationParity.test.js`, one layer down.
   *
   * The device is the authority on which key a path names. If our documented path and the app's
   * disagree, a member is shown an address that is not the one their device will sign with, and
   * nothing anywhere errors — the worst failure shape this migration has found, on the surface
   * where it costs the most.
   */
  it('derives the address the seed says it should, at the documented path', async () => {
    const { address } = await session.getAddress(PATH)
    expect(address.toLowerCase()).toBe(expectedAddress.toLowerCase())
  }, 60_000)

  /*
   * 2. APPROVE-THEN-PAY — the AAP-03 class of bug, on a device account.
   *
   * Two consecutive signatures at nonce 0 then 1, each recovered back to the device's own address.
   * A signer that reuses a nonce, or that serializes something other than what it asked the device
   * to sign, fails here and cannot fail in a mocked suite.
   */
  it('signs two consecutive transactions that each recover to the device account', async () => {
    const signer = new HardwareSigner(session, { path: PATH, address: expectedAddress })
    const base = { to: TO, value: 1n, chainId: 137, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 }

    const signed = []
    for (const nonce of [0, 1]) {
      const { value, error, screens } = await withDevice(control, true, () =>
        signer.signTransaction({ ...base, nonce }))
      expect(error, `nonce ${nonce} failed after screens ${JSON.stringify(screens)}`).toBeUndefined()
      signed.push(value)
      /*
       * What the member was actually shown, on the device's own screen.
       *
       * Asserted on CONTENT, not on the title: the driver polls, so a title screen the app passes
       * through quickly ("Review transaction") may not be sampled, and an assertion on it would
       * fail for a reason that says nothing about the transaction. The destination address is the
       * fact that matters — a signer aiming at the wrong account would show a different one — and
       * the Nano wraps it across lines, so the spaces come out before comparing.
       */
      const review = screens.join(' | ')
      expect(review.replace(/\s+/g, '')).toContain(TO.replace(/^0x/, '0x'))
      expect(review, 'the network the member approved').toMatch(/Polygon/)
    }

    for (const [raw, nonce] of [[signed[0], 0], [signed[1], 1]]) {
      const parsed = parseTransaction(raw)
      expect(parsed.nonce).toBe(nonce)
      expect(parsed.chainId).toBe(137)
      expect(parsed.to.toLowerCase()).toBe(TO.toLowerCase())
      const from = await recoverTransactionAddress({ serializedTransaction: raw })
      expect(from.toLowerCase()).toBe(expectedAddress.toLowerCase())
    }
    expect(signed[0]).not.toBe(signed[1])
  }, 180_000)

  /*
   * 3. REJECT — declining on the device is not a sent transaction. The app answers 0x6985, the
   * adapter must classify it USER_CANCELLED, and nothing broadcastable may come back.
   */
  it('surfaces a device rejection as USER_CANCELLED and returns no signature', async () => {
    const signer = new HardwareSigner(session, { path: PATH, address: expectedAddress })
    const { value, error } = await withDevice(control, false, () =>
      signer.signTransaction({ to: TO, value: 1n, chainId: 137, nonce: 2, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 }))

    expect(value, 'a declined signature must never resolve').toBeUndefined()
    expect(error).toBeInstanceOf(HardwareWalletError)
    expect(error.code).toBe(HW_ERROR_CODES.USER_CANCELLED)
  }, 120_000)

  /*
   * 4. PERSONAL MESSAGE — signed by the device, verified by recovering it back. The adapter
   * assembles `0x{r}{s}{v}` by hand, which is exactly the kind of string concatenation a mocked
   * session cannot get wrong and a real one can.
   */
  it('signs a personal message that recovers to the device account', async () => {
    const signer = new HardwareSigner(session, { path: PATH, address: expectedAddress })
    const message = 'FairWins hardware check'
    const { value: signature, error, screens } = await withDevice(control, true, () =>
      signer.signMessage(message))

    expect(error, `signing failed after screens ${JSON.stringify(screens)}`).toBeUndefined()
    // The device showed the message it was asked to sign, not a hash.
    expect(screens.join(' | ')).toMatch(/FairWins hardware/)
    const recovered = await recoverMessageAddress({ message, signature })
    expect(recovered.toLowerCase()).toBe(expectedAddress.toLowerCase())
  }, 120_000)

  /*
   * 5. TYPED DATA — and the device's answer was not the one this test was written expecting.
   *
   * `signEIP712HashedMessage` hands the app two 32-byte hashes, the variant the adapter chose
   * because "every firmware supports it". Every firmware does — but only with BLIND SIGNING turned
   * on: with default settings the Nano's own screen says "Blind signing must be enabled in
   * settings" and the app answers 0x6a80. The adapter was classifying that UNKNOWN, whose sentence
   * is "reconnect the device and try again" — advice that can never work, on the path a member
   * takes to sign an intent. That is a real defect, it was invisible to every mocked suite, and it
   * is what this rail was built to find.
   *
   * So the assertion is the honest one: with blind signing off the device REFUSES, and the refusal
   * must arrive as the typed, actionable code. Enabling blind signing is a device SETTINGS change,
   * not a protocol one, so the recover-to-address half belongs to a fixture that toggles it.
   */
  it('reports the blind-signing requirement in words a member can act on', async () => {
    const signer = new HardwareSigner(session, { path: PATH, address: expectedAddress })
    const domain = { name: 'FairWins', version: '1', chainId: 137, verifyingContract: TO }
    const types = { Check: [{ name: 'who', type: 'address' }, { name: 'amount', type: 'uint256' }] }
    const value = { who: TO, amount: 42n }

    // The hashes handed to the device are the hashes of the table we claim to be sending.
    expect(hashTypedData({ domain, types, primaryType: 'Check', message: value })).toMatch(/^0x[0-9a-f]{64}$/)

    const raised = await signer.signTypedData(domain, types, value).then(() => null, (e) => e)
    expect(raised, 'a device that will not review must reject, never resolve').toBeInstanceOf(HardwareWalletError)
    expect(raised.code).toBe(HW_ERROR_CODES.BLIND_SIGNING_REQUIRED)
    expect(raised.message).toMatch(/blind signing/i)
    expect(raised.message, 'never the reconnect sentence, which cannot fix this').not.toMatch(/reconnect/i)
  }, 120_000)

  /*
   * 6. ETC — a product question, asked of the device rather than assumed.
   *
   * Ethereum Classic (61) and Mordor (63) are in this app's cohort, and whether the Ethereum app
   * will sign for them is a fact about the firmware. This test RECORDS the answer either way
   * instead of skipping: a refusal is a constraint the product must state, not a gap to hide.
   */
  it('signs for ETC (chain 61) and names the network on screen', async () => {
    const signer = new HardwareSigner(session, { path: PATH, address: expectedAddress })
    const { value, error, screens } = await withDevice(control, true, () =>
      signer.signTransaction({ to: TO, value: 1n, chainId: 61, nonce: 3, gasLimit: 21000n, gasPrice: 1n, type: 0 }))

    expect(error, `ETC signing failed after screens ${JSON.stringify(screens)}`).toBeUndefined()
    const from = await recoverTransactionAddress({ serializedTransaction: value })
    expect(from.toLowerCase()).toBe(expectedAddress.toLowerCase())
    // The app KNOWS this chain — it renders "Ethereum Classic" and prices in ETC rather than
    // showing an unnamed chain id, which is what makes 61 a supported cohort chain in fact and
    // not just in our config.
    expect(screens.join(' | ')).toMatch(/Ethereum Classic/)
    expect(screens.join(' | ')).toMatch(/ETC/)
  }, 120_000)
})
