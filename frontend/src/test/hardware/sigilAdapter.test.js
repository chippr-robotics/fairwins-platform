/**
 * Spec 111 — the Sigil adapter, driven through a fake bridge that signs with a REAL secp256k1 key
 * exactly the way sigil-daemon does: a raw 32-byte prehash in, low-S `r||s` out, no recovery id.
 *
 * Every signing test ends in a recovery against the account address, through the same viem
 * verifiers the rest of the app (and the chain) uses — a test that only checked the adapter's own
 * return value would pass on a signature nothing else accepts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  recoverMessageAddress,
  recoverTransactionAddress,
  verifyTypedData,
  bytesToHex,
  hexToBytes,
  parseEther,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { connectSigil, addressFromCompressedKey, sigilPathFor, childIdFromPath } from '../../lib/hardware/sigilAdapter'
import { HardwareSigner } from '../../lib/hardware/hardwareSigner'
import { HardwareWalletError, HW_ERROR_CODES } from '../../lib/hardware/errors'
import {
  normalizeBridgeUrl,
  normalizeBridgeToken,
  redactBridgeToken,
  saveSigilBridge,
  loadSigilBridge,
  SIGIL_BRIDGE_PREF_KEY,
} from '../../lib/hardware/sigilBridgeStore'

// Hardhat account #1 — a well-known test key, so the address below is checkable by eye.
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY)
const PUBKEY = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIVATE_KEY), true))
const CHILD_ID = '9e8d7c6b'
const PATH = sigilPathFor(CHILD_ID)
const URL = 'http://127.0.0.1:7318'
const TOKEN = 'ab'.repeat(32)

/** sigil-daemon's signing contract: prehash in, low-S compact r||s out (no v). */
function daemonSign(digestHex, privateKey = PRIVATE_KEY) {
  const sig = secp256k1.sign(hexToBytes(digestHex), hexToBytes(privateKey), { prehash: false, lowS: true })
  return bytesToHex(sig).slice(2)
}

function fakeBridge({ disk = {}, signWith = PRIVATE_KEY, failSign, failStatus } = {}) {
  const calls = []
  let presigIndex = 40
  const state = {
    detected: true,
    childId: CHILD_ID,
    publicKey: PUBKEY,
    presigsRemaining: 742,
    presigsTotal: 1000,
    daysUntilExpiry: 30,
    valid: true,
    ...disk,
  }
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body })
  const fetchImpl = vi.fn(async (url, init) => {
    const route = new globalThis.URL(url).pathname
    const body = JSON.parse(init.body || '{}')
    calls.push({ route, body, headers: init.headers })
    if (init.headers.authorization !== `Bearer ${TOKEN}`) {
      return reply(401, { ok: false, error: { code: 'unauthorized', message: 'no' } })
    }
    if (route === '/v1/status') {
      if (failStatus) return reply(failStatus.status, { ok: false, error: { code: failStatus.code, message: 'x' } })
      return reply(200, { ok: true, daemon: { version: '0.7.0' }, disk: state })
    }
    if (route === '/v1/sign') {
      if (failSign) return reply(failSign.status, { ok: false, error: { code: failSign.code, message: failSign.message || 'x' } })
      presigIndex += 1
      return reply(200, { ok: true, signature: `0x${daemonSign(body.digest, signWith)}`, presigIndex, presigsRemaining: 741 })
    }
    if (route === '/v1/tx-hash') return reply(200, { ok: true, recorded: true })
    return reply(404, { ok: false, error: { code: 'not_found' } })
  })
  return { fetchImpl, calls, state }
}

const connect = (bridge) => connectSigil({ url: URL, token: TOKEN, fetchImpl: bridge.fetchImpl })

async function expectCode(promise, code) {
  const err = await promise.then(
    () => null,
    (e) => e,
  )
  expect(err).toBeInstanceOf(HardwareWalletError)
  expect(err.code).toBe(code)
  return err
}

describe('account identity', () => {
  it('derives the EVM address from the compressed key the daemon reports', () => {
    expect(addressFromCompressedKey(PUBKEY)).toBe(ACCOUNT.address)
  })

  it('names the disk in the saved path, one account per disk', () => {
    expect(PATH).toBe('sigil:9e8d7c6b')
    expect(childIdFromPath(PATH)).toBe(CHILD_ID)
    expect(childIdFromPath("m/44'/60'/0'/0/0")).toBeNull()
  })

  it('describes the single account with the disk budget it reported', async () => {
    const session = await connect(fakeBridge())
    const [row] = await session.describeAccounts()
    expect(row).toEqual({
      path: PATH,
      address: ACCOUNT.address,
      detail: { childId: CHILD_ID, presigsRemaining: 742, presigsTotal: 1000, daysUntilExpiry: 30, valid: true },
    })
  })

  it('refuses a daemon that does not report the key (older than sigil spec 004)', async () => {
    await expectCode(connect(fakeBridge({ disk: { publicKey: null } })), HW_ERROR_CODES.SIGIL_DAEMON_OUTDATED)
  })

  it('refuses to connect with no disk, naming the remedy', async () => {
    const err = await expectCode(connect(fakeBridge({ disk: { detected: false } })), HW_ERROR_CODES.SIGIL_NO_DISK)
    expect(err.message).toMatch(/Insert the floppy/)
  })

  it('reconnecting with a different disk inserted is WRONG_DISK, not "a different address"', async () => {
    const session = await connect(fakeBridge({ disk: { childId: 'ffff0000' } }))
    await expectCode(session.getAddress(PATH), HW_ERROR_CODES.SIGIL_WRONG_DISK)
  })

  it('sends the token only in the Authorization header, never in the URL', async () => {
    const bridge = fakeBridge()
    await connect(bridge)
    const [url] = bridge.fetchImpl.mock.calls[0]
    expect(url).toBe(`${URL}/v1/status`)
    expect(url).not.toContain(TOKEN)
    expect(bridge.fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
  })
})

describe('signing: every digest is built here, every signature recovers to the account', () => {
  it('personal_sign recovers to the disk account', async () => {
    const bridge = fakeBridge()
    const signer = new HardwareSigner(await connect(bridge), { path: PATH, address: ACCOUNT.address })
    const message = 'I control this Sigil account — challenge 42'
    const signature = await signer.signMessage(message)
    expect(await recoverMessageAddress({ message, signature })).toBe(ACCOUNT.address)
    // The byte-identical signature a plain key would produce (RFC 6979 on both sides).
    expect(signature).toBe(await ACCOUNT.signMessage({ message }))
    const sign = bridge.calls.find((c) => c.route === '/v1/sign')
    expect(sign.body).toMatchObject({ chainId: 0, expectedPublicKey: PUBKEY })
    expect(sign.body.description).toMatch(/EIP-191/)
  })

  it('EIP-712 typed data verifies against the account', async () => {
    const signer = new HardwareSigner(await connect(fakeBridge()), { path: PATH, address: ACCOUNT.address })
    const domain = { name: 'FairWins WagerRegistry', version: '1', chainId: 137, verifyingContract: '0x1111111111111111111111111111111111111111' }
    const types = { Accept: [{ name: 'wagerId', type: 'uint256' }, { name: 'actor', type: 'address' }] }
    const message = { wagerId: 7n, actor: ACCOUNT.address }
    const signature = await signer.signTypedData(domain, types, message)
    expect(await verifyTypedData({ address: ACCOUNT.address, domain, types, primaryType: 'Accept', message, signature })).toBe(true)
  })

  it.each([
    ['EIP-1559 on Polygon', { chainId: 137, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }],
    ['legacy on Ethereum Classic', { chainId: 61, type: 0, gasPrice: 1_000_000_000n }],
    ['legacy on Mordor', { chainId: 63, type: 0, gasPrice: 1_000_000_000n }],
    ['EIP-1559 on Base', { chainId: 8453, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n }],
  ])('a transaction (%s) recovers to the account', async (_name, fees) => {
    const bridge = fakeBridge()
    const signer = new HardwareSigner(await connect(bridge), { path: PATH, address: ACCOUNT.address })
    const serialized = await signer.signTransaction({
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      value: parseEther('0.5'),
      nonce: 3,
      gasLimit: 21000n,
      ...fees,
    })
    expect(await recoverTransactionAddress({ serializedTransaction: serialized })).toBe(ACCOUNT.address)
    const sign = bridge.calls.find((c) => c.route === '/v1/sign')
    expect(sign.body.chainId).toBe(fees.chainId)
    expect(sign.body.description).toContain('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
  })

  it('a signature from any other key is refused before it can be broadcast', async () => {
    const other = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
    const signer = new HardwareSigner(await connect(fakeBridge({ signWith: other })), { path: PATH, address: ACCOUNT.address })
    await expectCode(signer.signMessage('hello'), HW_ERROR_CODES.UNKNOWN)
    await expect(
      signer.signTransaction({ to: ACCOUNT.address, value: 1n, nonce: 0, gasLimit: 21000n, chainId: 1, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    ).rejects.toThrow(/does not verify/)
  })

  it('records the broadcast hash against the presignature that signed it', async () => {
    const bridge = fakeBridge()
    const session = await connect(bridge)
    const signer = new HardwareSigner(session, { path: PATH, address: ACCOUNT.address })
    await signer.signTransaction({ to: ACCOUNT.address, value: 1n, nonce: 0, gasLimit: 21000n, chainId: 1, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    const txHash = `0x${'33'.repeat(32)}`
    expect(await session.noteBroadcast(txHash)).toBe(true)
    expect(bridge.calls.at(-1)).toMatchObject({ route: '/v1/tx-hash', body: { presigIndex: 41, txHash } })
    // Once only: a second note has no presignature to attribute.
    expect(await session.noteBroadcast(txHash)).toBe(false)
  })
})

describe('failure vocabulary: each refusal names its own remedy', () => {
  it.each([
    [{ status: 409, code: 'no_disk' }, HW_ERROR_CODES.SIGIL_NO_DISK],
    [{ status: 409, code: 'disk_exhausted' }, HW_ERROR_CODES.SIGIL_DISK_EXHAUSTED],
    [{ status: 409, code: 'disk_invalid' }, HW_ERROR_CODES.SIGIL_DISK_INVALID],
    [{ status: 409, code: 'wrong_disk' }, HW_ERROR_CODES.SIGIL_WRONG_DISK],
    [{ status: 403, code: 'operator_declined' }, HW_ERROR_CODES.USER_CANCELLED],
    [{ status: 503, code: 'daemon_unreachable' }, HW_ERROR_CODES.SIGIL_DAEMON_DOWN],
    [{ status: 504, code: 'daemon_timeout' }, HW_ERROR_CODES.TIMEOUT],
  ])('bridge %o → %s', async (failSign, code) => {
    const session = await connect(fakeBridge({ failSign }))
    await expectCode(session.signPersonalMessage(PATH, new TextEncoder().encode('x')), code)
  })

  it('a wrong token is NOT_PAIRED', async () => {
    const bridge = fakeBridge()
    await expectCode(connectSigil({ url: URL, token: 'cd'.repeat(32), fetchImpl: bridge.fetchImpl }), HW_ERROR_CODES.SIGIL_NOT_PAIRED)
  })

  it('an origin the bridge does not allow names the flag that fixes it', async () => {
    const err = await expectCode(connect(fakeBridge({ failStatus: { status: 403, code: 'origin_not_allowed' } })), HW_ERROR_CODES.SIGIL_NOT_PAIRED)
    expect(err.message).toMatch(/--allow-origin/)
  })

  it('a bridge that is not running is BRIDGE_UNREACHABLE, not a generic device error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expectCode(connectSigil({ url: URL, token: TOKEN, fetchImpl }), HW_ERROR_CODES.SIGIL_BRIDGE_UNREACHABLE)
  })

  it('a daemon refusal carries the daemon’s own reason', async () => {
    const session = await connect(fakeBridge({ failSign: { status: 502, code: 'daemon_refused', message: 'Disk rollback detected' } }))
    const err = await expectCode(session.signPersonalMessage(PATH, new Uint8Array([1])), HW_ERROR_CODES.UNKNOWN)
    expect(err.message).toMatch(/rollback/)
  })

  it('no pairing at all is NOT_PAIRED before any request', async () => {
    await expectCode(connectSigil({}), HW_ERROR_CODES.SIGIL_NOT_PAIRED)
  })
})

describe('pairing store (spec-069 credential rules)', () => {
  beforeEach(() => localStorage.clear())

  it('accepts only a loopback bridge the CSP grants', () => {
    expect(normalizeBridgeUrl('http://127.0.0.1:7318')).toBe('http://127.0.0.1:7318')
    expect(normalizeBridgeUrl('http://localhost:9000/')).toBe('http://localhost:9000')
    expect(() => normalizeBridgeUrl('http://192.168.1.4:7318')).toThrow(/this computer/)
    expect(() => normalizeBridgeUrl('https://bridge.example')).toThrow(/this computer/)
    expect(() => normalizeBridgeUrl('http://127.0.0.1:7318/v1/sign')).toThrow(/nothing after it/)
    expect(() => normalizeBridgeUrl('http://user:pw@127.0.0.1:7318')).toThrow()
  })

  it('accepts only a hex token, and redacts it to the last four characters', () => {
    expect(normalizeBridgeToken(` ${TOKEN.toUpperCase()} `)).toBe(TOKEN)
    expect(() => normalizeBridgeToken('short')).toThrow(/token file/)
    expect(redactBridgeToken(TOKEN)).toBe(`…${TOKEN.slice(-4)}`)
    expect(redactBridgeToken(TOKEN)).not.toContain(TOKEN.slice(0, 8))
  })

  it('round-trips through device-scoped global prefs', () => {
    saveSigilBridge({ url: 'http://localhost:7318', token: TOKEN })
    expect(loadSigilBridge()).toEqual({ url: 'http://localhost:7318', token: TOKEN })
    expect(JSON.parse(localStorage.getItem('fw_global_prefs'))[SIGIL_BRIDGE_PREF_KEY]).toBeTruthy()
  })

  it('is absent from the spec-032 synced backup', () => {
    // A synced token would pair every device the member restores onto with this computer's bridge.
    const registry = readFileSync(resolve(process.cwd(), 'src/lib/backup/syncedObjects.js'), 'utf-8')
    expect(registry).not.toContain(SIGIL_BRIDGE_PREF_KEY)
    expect(registry).not.toContain('sigilBridge')
  })
})
