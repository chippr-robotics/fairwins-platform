/**
 * Ledger BLE transport for the NATIVE runtime (spec 102 US4,
 * contracts/native-runtime-seams.md §3).
 *
 * A native WebView has no Web Bluetooth, so `TransportWebBLE` cannot exist
 * there; this transport speaks the same Ledger BLE framing over the
 * `@capacitor-community/bluetooth-le` plugin instead. It extends the official
 * `@ledgerhq/hw-transport` base class, so `hw-app-eth` (and therefore
 * `HardwareSigner`, recover-and-verify, reconnect re-derivation) runs
 * UNCHANGED above it — the rung slots into `ledgerAdapter.js`'s ladder and
 * nothing higher learns a new transport exists.
 *
 * Ledger BLE protocol (as implemented by the official
 * `@ledgerhq/hw-transport-web-ble` / `react-native-hw-transport-ble`):
 *   Nano X GATT service  13d63400-2c97-0004-0000-4c6564676572
 *     notify  characteristic …-0001-…  (device → host frames)
 *     write   characteristic …-0002-…  (host → device frames)
 *   Frames: [tag u8][seq u16 BE][payload], where frame 0 additionally
 *   carries [total-length u16 BE] before the payload.
 *     tag 0x08 = MTU handshake (host sends an empty 0x08 frame; the device
 *                answers 0x08 whose payload's last byte is the usable
 *                per-frame payload size)
 *     tag 0x05 = APDU data
 *
 * Errors are NOT normalized here — `ledgerAdapter.js#classifyLedgerError` is
 * the single place raw failures become `HW_ERROR_CODES`, and this module
 * throws errors shaped so that mapping already applies (permission denials
 * from the plugin carry their own names; link drops surface with
 * gatt/bluetooth wording).
 */
import { Buffer } from 'buffer'
import Transport from '@ledgerhq/hw-transport'

export const LEDGER_BLE_SERVICE = '13d63400-2c97-0004-0000-4c6564676572'
export const LEDGER_BLE_NOTIFY = '13d63400-2c97-0004-0001-4c6564676572'
export const LEDGER_BLE_WRITE = '13d63400-2c97-0004-0002-4c6564676572'

const TAG_APDU = 0x05
const TAG_MTU = 0x08
const DEFAULT_MTU_PAYLOAD = 20

/**
 * Split one buffer into Ledger BLE frames. `mtuSize` is the FRAME size (the
 * value the device reports in the 0x08 handshake): the first frame carries a
 * 5-byte header (tag, seq, total length) so it holds `mtuSize - 5` payload
 * bytes; continuations carry 3-byte headers and hold `mtuSize - 3`. Mirrors
 * `@ledgerhq/devices`' sendAPDU exactly. Exported for tests.
 */
export function buildFrames(tag, payload, mtuSize) {
  const frames = []
  let seq = 0
  let offset = 0
  do {
    const headerLength = seq === 0 ? 5 : 3
    const chunk = payload.slice(offset, offset + Math.max(1, mtuSize - headerLength))
    const frame = new Uint8Array(headerLength + chunk.length)
    frame[0] = tag
    frame[1] = (seq >> 8) & 0xff
    frame[2] = seq & 0xff
    if (seq === 0) {
      frame[3] = (payload.length >> 8) & 0xff
      frame[4] = payload.length & 0xff
    }
    frame.set(chunk, headerLength)
    frames.push(frame)
    offset += chunk.length
    seq += 1
  } while (offset < payload.length)
  return frames
}

/** Stateful reassembler for device → host frames. Exported for tests. */
export function createFrameAssembler() {
  let expected = null
  let received = []
  let receivedLength = 0
  return {
    /** @returns {Uint8Array | null} the full payload once complete, else null */
    push(frame) {
      if (frame.length < 3) throw new Error('ledger ble: truncated frame')
      const tag = frame[0]
      const seq = (frame[1] << 8) | frame[2]
      if (seq === 0) {
        if (frame.length < 5) throw new Error('ledger ble: truncated first frame')
        expected = (frame[3] << 8) | frame[4]
        received = [frame.slice(5)]
        receivedLength = frame.length - 5
      } else {
        if (expected === null) throw new Error('ledger ble: continuation before first frame')
        received.push(frame.slice(3))
        receivedLength += frame.length - 3
      }
      if (expected !== null && receivedLength >= expected) {
        const out = new Uint8Array(receivedLength)
        let at = 0
        for (const part of received) {
          out.set(part, at)
          at += part.length
        }
        expected = null
        received = []
        receivedLength = 0
        return { tag, payload: out }
      }
      return null
    },
  }
}

const toDataView = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const fromDataView = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)

export class LedgerNativeBleTransport extends Transport {
  constructor({ ble, deviceId, mtu }) {
    super()
    this.ble = ble
    this.deviceId = deviceId
    this.mtu = mtu
    this.assembler = createFrameAssembler()
    this.pending = []
    this.waiters = []
    this.closed = false
  }

  /**
   * Pair, connect, negotiate the MTU. `ble` is injectable for tests; the
   * default is the Capacitor community plugin's BleClient.
   */
  static async open({ ble } = {}) {
    const client = ble ?? (await import('@capacitor-community/bluetooth-le')).BleClient
    await client.initialize()
    const device = await client.requestDevice({ services: [LEDGER_BLE_SERVICE] })
    await client.connect(device.deviceId)

    const transport = new LedgerNativeBleTransport({ ble: client, deviceId: device.deviceId, mtu: DEFAULT_MTU_PAYLOAD })
    await client.startNotifications(device.deviceId, LEDGER_BLE_SERVICE, LEDGER_BLE_NOTIFY, (view) => {
      transport._onFrame(fromDataView(view))
    })

    // MTU handshake: empty 0x08 frame out; the answer payload's first byte is
    // the usable FRAME size (mirrors @ledgerhq/hw-transport-web-ble, which
    // reads byte 5 of the raw notify frame). A device that answers nothing
    // useful keeps the conservative default every firmware accepts.
    const answer = await transport._request(TAG_MTU, new Uint8Array(0))
    if (answer.payload.length > 0) {
      const negotiated = answer.payload[0]
      if (negotiated >= DEFAULT_MTU_PAYLOAD) transport.mtu = negotiated
    }
    return transport
  }

  _onFrame(bytes) {
    const complete = this.assembler.push(bytes)
    if (!complete) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(complete)
    else this.pending.push(complete)
  }

  _nextMessage() {
    // Checked HERE, not only in close(): an exchange that was still in its
    // write phase when close() ran would otherwise register a waiter nobody
    // will ever reject and hang forever.
    if (this.closed) return Promise.reject(new Error('ledger ble: transport closed'))
    if (this.pending.length > 0) return Promise.resolve(this.pending.shift())
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  async _request(tag, payload) {
    for (const frame of buildFrames(tag, payload, this.mtu)) {
      await this.ble.write(this.deviceId, LEDGER_BLE_SERVICE, LEDGER_BLE_WRITE, toDataView(frame))
    }
    return this._nextMessage()
  }

  /** The one method hw-app-eth needs: one APDU out, one APDU in. */
  async exchange(apdu) {
    const bytes = apdu instanceof Uint8Array ? apdu : new Uint8Array(apdu)
    const answer = await this._request(TAG_APDU, bytes)
    if (answer.tag !== TAG_APDU) {
      throw new Error(`ledger ble: unexpected response tag 0x${answer.tag.toString(16)}`)
    }
    return Buffer.from(answer.payload)
  }

  async close() {
    this.closed = true
    const drop = new Error('ledger ble: transport closed')
    for (const waiter of this.waiters.splice(0)) waiter.reject(drop)
    await this.ble.stopNotifications(this.deviceId, LEDGER_BLE_SERVICE, LEDGER_BLE_NOTIFY).catch(() => {})
    await this.ble.disconnect(this.deviceId).catch(() => {})
  }
}

export async function openNativeBleTransport(options) {
  return LedgerNativeBleTransport.open(options)
}
