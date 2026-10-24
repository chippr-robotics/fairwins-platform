import { describe, it, expect, vi, beforeEach } from 'vitest'

// Spec 102 US4 — the native BLE rung. What has teeth here:
//  · the Ledger frame arithmetic (first frame mtu-5 payload bytes,
//    continuations mtu-3, big-endian seq + total length) — wrong framing is a
//    device that silently ignores us;
//  · reassembly across split responses;
//  · plugin failures normalizing to the existing HW_ERROR_CODES with DISTINCT
//    codes for radio-off vs pairing-declined (a raw plugin message reaching a
//    member is the must-fail).

const platformRef = { value: 'android', plugins: { BluetoothLe: true } }
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => platformRef.value,
    isPluginAvailable: (name) => Boolean(platformRef.plugins[name]),
  },
}))

import {
  buildFrames,
  createFrameAssembler,
  LedgerNativeBleTransport,
  LEDGER_BLE_SERVICE,
  LEDGER_BLE_NOTIFY,
} from '../../lib/native/ledgerBleTransport'
import { classifyLedgerError } from '../../lib/hardware/ledgerAdapter'
import { HW_ERROR_CODES } from '../../lib/hardware/errors'
import { __resetRuntimeForTests } from '../../lib/native/runtime'

describe('ledger BLE framing', () => {
  it('splits an APDU into correctly headed frames at the negotiated size', () => {
    const payload = new Uint8Array(50).map((_, i) => i)
    const frames = buildFrames(0x05, payload, 20)
    // 20-byte frames: first carries 15 payload bytes, continuations 17 each.
    expect(frames[0].length).toBe(20)
    expect(Array.from(frames[0].slice(0, 5))).toEqual([0x05, 0, 0, 0, 50])
    expect(frames[1][0]).toBe(0x05)
    expect(Array.from(frames[1].slice(1, 3))).toEqual([0, 1])
    const total = frames.reduce((n, f, i) => n + f.length - (i === 0 ? 5 : 3), 0)
    expect(total).toBe(50)
  })

  it('an empty payload still sends exactly one first frame (the MTU handshake)', () => {
    const frames = buildFrames(0x08, new Uint8Array(0), 20)
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0])).toEqual([0x08, 0, 0, 0, 0])
  })

  it('reassembles a response split across frames, byte-exact', () => {
    const payload = new Uint8Array(40).map((_, i) => 255 - i)
    const assembler = createFrameAssembler()
    const frames = buildFrames(0x05, payload, 20)
    let out = null
    for (const frame of frames) out = assembler.push(frame) ?? out
    expect(out.tag).toBe(0x05)
    expect(out.payload).toEqual(payload)
  })

  it('a continuation before a first frame is a protocol error, not garbage output', () => {
    const assembler = createFrameAssembler()
    expect(() => assembler.push(new Uint8Array([0x05, 0, 1, 9, 9]))).toThrow(/continuation/)
  })
})

describe('native BLE transport over a stub plugin', () => {
  function stubBle({ mtuAnswer = 23 } = {}) {
    let notifyCb = null
    const writes = []
    const ble = {
      initialize: vi.fn(async () => {}),
      requestDevice: vi.fn(async () => ({ deviceId: 'dev-1' })),
      connect: vi.fn(async () => {}),
      startNotifications: vi.fn(async (id, svc, chr, cb) => { notifyCb = cb }),
      stopNotifications: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      write: vi.fn(async (id, svc, chr, view) => {
        writes.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
        const frame = writes.at(-1)
        if (frame[0] === 0x08) {
          // Answer the MTU handshake with the negotiated frame size.
          queueMicrotask(() => notifyCb(new DataView(new Uint8Array([0x08, 0, 0, 0, 1, mtuAnswer]).buffer)))
        }
      }),
      emit: (bytes) => notifyCb(new DataView(bytes.buffer)),
      writes,
    }
    return ble
  }

  it('negotiates the MTU and exchanges an APDU end to end', async () => {
    const ble = stubBle({ mtuAnswer: 60 })
    const transport = await LedgerNativeBleTransport.open({ ble })
    expect(transport.mtu).toBe(60)
    expect(ble.requestDevice).toHaveBeenCalledWith({ services: [LEDGER_BLE_SERVICE] })
    expect(ble.startNotifications.mock.calls[0][2]).toBe(LEDGER_BLE_NOTIFY)

    const answerPromise = transport.exchange(new Uint8Array([0xe0, 0x02, 0, 0, 0]))
    // The APDU went out as one 0x05 frame with the length header.
    const apduFrame = ble.writes.at(-1)
    expect(Array.from(apduFrame.slice(0, 5))).toEqual([0x05, 0, 0, 0, 5])
    // Device answers 0x9000 over the notify characteristic.
    ble.emit(new Uint8Array([0x05, 0, 0, 0, 2, 0x90, 0x00]))
    const answer = await answerPromise
    expect(Array.from(answer)).toEqual([0x90, 0x00])
  })

  it('close rejects in-flight waiters and tears the link down', async () => {
    const ble = stubBle()
    const transport = await LedgerNativeBleTransport.open({ ble })
    const pending = transport.exchange(new Uint8Array([0xe0, 0x01, 0, 0, 0]))
    await transport.close()
    await expect(pending).rejects.toThrow(/closed/)
    expect(ble.disconnect).toHaveBeenCalledWith('dev-1')
  })
})

describe('plugin failure normalization', () => {
  beforeEach(() => {
    platformRef.value = 'android'
    platformRef.plugins = { BluetoothLe: true }
    __resetRuntimeForTests()
  })

  it('radio-off and pairing-declined map to DISTINCT codes with recovery meaning', () => {
    expect(classifyLedgerError(new Error('Bluetooth disabled.'))).toBe(HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE)
    expect(classifyLedgerError(new Error('Bluetooth LE is turned off'))).toBe(HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE)
    expect(classifyLedgerError(new Error('requestDevice cancelled by the user'))).toBe(HW_ERROR_CODES.PERMISSION_DENIED)
    // Link drop mid-session stays the existing DISCONNECTED fact.
    expect(classifyLedgerError(new Error('GATT operation failed'))).toBe(HW_ERROR_CODES.DISCONNECTED)
  })
})
