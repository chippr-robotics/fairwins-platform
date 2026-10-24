/**
 * The EMULATOR rail for a Ledger — spec 085/110, the instrument that makes the hardware signer
 * testable without a human thumb.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * A hardware wallet exists so a signature cannot complete until the device's own screen accepts
 * it. That is the security property, and it is also why every other rail in this repo is
 * unreachable from CI: WebHID needs a picker click, and a real Nano needs a finger. The result was
 * that `hardwareSigner.js` — which builds and serializes transactions that move a member's money —
 * had no instrument that could see a defect in it. The suites mock the device, so they answer a
 * question the device no longer asks.
 *
 * Speculos is Ledger's own QEMU of the device: the REAL app firmware, the REAL APDUs, the REAL
 * screen flow, with the button press driven by software instead of a thumb. So the confirmation
 * gate is KEPT and automated, rather than removed. `--automation` rules fire on screen TEXT, which
 * means an unexpected screen is a failure rather than a silent approval (see `automation.json`).
 *
 * ── WHY IT IS A HAND-WRITTEN TRANSPORT AND NOT A LEDGER PACKAGE ───────────────────────────────
 * `@ledgerhq/device-transport-kit-speculos` and `@ledgerhq/hw-transport-node-speculos-http` both
 * do this job, and both are the wrong answer HERE: adding either re-resolves the root lockfile,
 * which is the npm/cli#4828 rolldown-binary hazard that has broken this repo's builds repeatedly
 * (spec 075 — 3 of 5 lockfile-touching Dependabot PRs in one week dropped the platform binary).
 * Paying that for a TEST rail is a bad trade. Speculos' APDU endpoint is plain HTTP
 * (`POST /apdu {"data": hex}` → `{"data": hex}`), and `@ledgerhq/hw-transport` — whose `Transport`
 * base class is all that `hw-app-eth` requires — is ALREADY a direct dependency. So the whole rail
 * is this file, and the dependency graph does not move.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────────────
 * Speculos is not the Secure Element: syscalls, the watchdog and timing differ, and Ledger says so.
 * Green here means "the protocol and the screen flow are right", never "this firmware is
 * certified". USB/BLE quirks and firmware drift stay a physical-device soak
 * (`docs/runbooks/hardware-wallet-staging-validation.md`), not a PR gate.
 *
 * ── AND IT MUST NEVER SHIP ─────────────────────────────────────────────────────────────────────
 * This rail points signing at an arbitrary HTTP origin. In a production bundle that would be a way
 * to aim a member's device session somewhere they never chose, so every path that can reach it is
 * behind `import.meta.env.DEV` and dead-code-eliminated from a release build — the same rule the
 * `window.__fwHardwareTestAdapter__` seam already lives under (adapters.js), and
 * `src/test/hardware/speculosSeam.test.js` is what keeps it true.
 */
import Transport from '@ledgerhq/hw-transport'

/** Speculos' default REST port, as its own docs and Docker image use it. */
export const DEFAULT_SPECULOS_URL = 'http://127.0.0.1:5000'

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The bytes back as the ethers-era transports returned them.
 *
 * `hw-app-eth` reads its responses with `Buffer` methods (`readUInt16BE`, `slice`, `toString`), so
 * a `Uint8Array` is not a drop-in — `nodeShims.js` already installs the polyfill for exactly this
 * reason, and it is the caller's job to have done so (as `connectHardware` does).
 */
function toBuffer(hex) {
  const BufferCtor = globalThis.Buffer
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return BufferCtor ? BufferCtor.from(bytes) : bytes
}

export class TransportSpeculosHttp extends Transport {
  constructor(baseUrl = DEFAULT_SPECULOS_URL) {
    super()
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
  }

  /** Open a session, failing loudly when nothing is listening — never a silent no-device. */
  static async open(baseUrl = DEFAULT_SPECULOS_URL) {
    const transport = new TransportSpeculosHttp(baseUrl)
    const res = await fetch(`${transport.baseUrl}/events?currentscreenonly=true`).catch((cause) => {
      throw new Error(`no Speculos at ${transport.baseUrl} — start the emulator first`, { cause })
    })
    if (!res.ok) throw new Error(`Speculos at ${transport.baseUrl} answered ${res.status}`)
    return transport
  }

  /** The one method `hw-app-eth` needs: APDU in, APDU out. */
  async exchange(apdu) {
    const res = await fetch(`${this.baseUrl}/apdu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: toHex(apdu) }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Speculos /apdu answered ${res.status}: ${text}`)
    // Read as TEXT and parse. Speculos streams this response and its first chunk is EMPTY, so a
    // `res.json()` on an implementation that stops at the first chunk yields `{}` and the device's
    // answer is lost silently — which is how this looked under jsdom before the environment was
    // pinned. Parsing the whole body ourselves means a malformed answer NAMES itself instead.
    let body
    try {
      body = JSON.parse(text)
    } catch (cause) {
      throw new Error(`Speculos /apdu returned non-JSON: ${JSON.stringify(text.slice(0, 120))}`, { cause })
    }
    if (typeof body?.data !== 'string') {
      throw new Error(`Speculos /apdu returned no data field: ${JSON.stringify(body)}`)
    }
    return toBuffer(body.data)
  }

  async close() {
    // Nothing to release: the emulator owns its own lifetime (the compose file does).
  }

  /*
   * ── DRIVING THE SCREEN, which is the half that replaces the thumb ────────────────────────────
   * These are not part of the `Transport` contract; they are how a test states what the device is
   * supposed to do and then checks what it actually showed.
   */

  /** Replace the automation rules mid-run — how the REJECT path is driven without a second boot. */
  async setAutomation(rules) {
    const res = await fetch(`${this.baseUrl}/automation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rules),
    })
    if (!res.ok) throw new Error(`Speculos /automation answered ${res.status}`)
  }

  /**
   * Every line the device has displayed since the last drain.
   *
   * This is what turns "it signed" into "it signed THIS": the app renders the domain, the primary
   * type and the amounts on screen, so an assertion over these strings is an assertion about what
   * the member would have been asked to approve.
   */
  async events({ current = false } = {}) {
    const res = await fetch(`${this.baseUrl}/events${current ? '?currentscreenonly=true' : ''}`)
    if (!res.ok) throw new Error(`Speculos /events answered ${res.status}`)
    const body = await res.json()
    return Array.isArray(body?.events) ? body.events : []
  }

  /** The current screen as one string — several text events can make up one screen. */
  async screenText() {
    return (await this.events({ current: true })).map((e) => e.text ?? '').join(' ').trim()
  }

  /** Press a physical button. `which` is 'left' | 'right' | 'both'. */
  async button(which, { delay = 0.1 } = {}) {
    const res = await fetch(`${this.baseUrl}/button/${which}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'press-and-release', delay }),
    })
    if (!res.ok) throw new Error(`Speculos /button/${which} answered ${res.status}`)
  }
}

export default TransportSpeculosHttp
