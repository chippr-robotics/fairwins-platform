import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Spec 032 US1 — backup(): build→encrypt→pin→writePointer; success ONLY after both pin and pointer-tx;
// honest failure leaves local data unchanged; blocked off the canonical network.

const h = vi.hoisted(() => ({ wallet: {}, showNotification: vi.fn(), uploadJson: vi.fn(), fetchByCid: vi.fn(), readPointer: vi.fn(), writePointer: vi.fn(), buildSetPointerCall: vi.fn(), resolveMasterSeed: vi.fn(), available: true }))
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => h.wallet }))
vi.mock('../../hooks/useUI', () => ({ useNotification: () => ({ showNotification: h.showNotification }) }))
vi.mock('../../utils/ipfsService', () => ({ uploadJson: (...a) => h.uploadJson(...a), fetchByCid: (...a) => h.fetchByCid(...a) }))
vi.mock('../../lib/backup/backupRegistry', () => ({
  isBackupAvailable: () => h.available,
  readPointer: (...a) => h.readPointer(...a),
  writePointer: (...a) => h.writePointer(...a),
  buildSetPointerCall: (...a) => h.buildSetPointerCall(...a),
  CANONICAL_CHAIN_ID: 137,
}))
vi.mock('../../lib/passkey/encryption', () => ({ resolveMasterSeed: (...a) => h.resolveMasterSeed(...a) }))
vi.mock('../../connectors/passkey', () => ({ readSession: () => ({ credentialId: 'cred-passkey-1' }) }))

import { useDataBackup } from '../../hooks/useDataBackup'
import { saveAddressBook } from '../../lib/addressBook/addressBookStore'

const ACCT = '0xAbC0000000000000000000000000000000000001'
const signer = { signMessage: vi.fn() }

beforeEach(() => {
  localStorage.clear()
  signer.signMessage.mockReset().mockResolvedValue('0xsig-fixed')
  h.wallet = { account: ACCT, signer, chainId: 137, isConnected: true, switchNetwork: vi.fn() }
  h.showNotification.mockReset()
  h.uploadJson.mockReset().mockResolvedValue({ cid: 'bafytest' })
  h.writePointer.mockReset().mockResolvedValue({})
  h.buildSetPointerCall.mockReset().mockImplementation((cid) => ({ target: '0xREGISTRY', data: `0xset:${cid}` }))
  h.resolveMasterSeed.mockReset().mockResolvedValue(new Uint8Array(32).fill(9))
  h.readPointer.mockReset().mockResolvedValue('')
  h.available = true
  saveAddressBook(ACCT, { schemaVersion: 1, contacts: [{ id: 'c1', nickname: 'A', addresses: [{ address: '0x1111111111111111111111111111111111111111', chainId: 137, notes: '', addedAt: 1 }], createdAt: 1, updatedAt: 1 }], updatedAt: 1 })
})

describe('useDataBackup.backup', () => {
  it('encrypts, pins, then records the pointer — success only after both', async () => {
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(true)
    expect(h.uploadJson).toHaveBeenCalled()
    expect(h.writePointer).toHaveBeenCalledWith(signer, 'bafytest')
    expect(h.showNotification).toHaveBeenCalledWith('Your data is backed up.', 'success')
  })

  it('honest failure: a pin error → no pointer write, no success, returns false (local unchanged)', async () => {
    h.uploadJson.mockRejectedValue(new Error('pin down'))
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(false)
    expect(h.writePointer).not.toHaveBeenCalled()
    expect(h.showNotification).not.toHaveBeenCalledWith('Your data is backed up.', 'success')
  })

  it('honest failure: a pointer-tx reject → not shown backed up', async () => {
    h.writePointer.mockRejectedValue(new Error('user rejected'))
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(false)
    expect(h.showNotification).not.toHaveBeenCalledWith('Your data is backed up.', 'success')
  })

  it('blocks + warns off the canonical network (no upload, no tx)', async () => {
    h.wallet = { ...h.wallet, chainId: 80002 }
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(false)
    expect(h.uploadJson).not.toHaveBeenCalled()
    expect(h.writePointer).not.toHaveBeenCalled()
    expect(h.showNotification).toHaveBeenCalledWith(expect.stringContaining('switch to that network'), 'warning')
  })

  it('warns when offline / registry unavailable', async () => {
    h.available = false
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(false)
    expect(h.uploadJson).not.toHaveBeenCalled()
  })

  it('passkey session backs up via sendCalls (no ethers signer) — PRF seed key + pointer call', async () => {
    // Passkey: no signer, loginMethod 'passkey', writes go through sendCalls (spec 041).
    const sendCalls = vi.fn(async () => ({ txHash: '0xpk' }))
    h.wallet = { account: ACCT, signer: null, chainId: 137, isConnected: true, switchNetwork: vi.fn(), loginMethod: 'passkey', sendCalls }
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(true)
    expect(h.resolveMasterSeed).toHaveBeenCalledWith({ account: ACCT, credentialId: 'cred-passkey-1' })
    expect(h.uploadJson).toHaveBeenCalled()
    expect(h.writePointer).not.toHaveBeenCalled() // never the signer path for a passkey
    expect(h.buildSetPointerCall).toHaveBeenCalledWith('bafytest')
    expect(sendCalls).toHaveBeenCalledWith([{ target: '0xREGISTRY', data: '0xset:bafytest' }])
    expect(h.showNotification).toHaveBeenCalledWith('Your data is backed up.', 'success')
  })

  /*
   * The write-settles race (#1327). `sendCalls` RESOLVES on a stalled or reverted UserOp rather than
   * throwing (submission.js#trackToInclusion), so the pointer can be un-recorded at the moment the
   * hook decides what to tell the member. "Backed up" here would be a claim about chain state that
   * nothing established, and remoteState 'yes' would keep claiming it on every later render.
   */
  it('passkey: a pointer UserOp that stalls is never reported as backed up', async () => {
    const sendCalls = vi.fn(async () => ({ state: 'stalled', userOpHash: '0xpk', lastKnown: { state: 'pending' } }))
    h.wallet = { account: ACCT, signer: null, chainId: 137, isConnected: true, switchNetwork: vi.fn(), loginMethod: 'passkey', sendCalls }
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(false)
    expect(h.showNotification).not.toHaveBeenCalledWith('Your data is backed up.', 'success')
    expect(result.current.hasRemote).toBe(false)
  })

  it('passkey: a pointer UserOp that reverted is never reported as backed up', async () => {
    const sendCalls = vi.fn(async () => ({ state: 'failed', reason: 'execution reverted' }))
    h.wallet = { account: ACCT, signer: null, chainId: 137, isConnected: true, switchNetwork: vi.fn(), loginMethod: 'passkey', sendCalls }
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(false)
    expect(h.showNotification).toHaveBeenCalledWith('execution reverted', 'error')
    expect(result.current.hasRemote).toBe(false)
  })

  it('passkey: an included pointer UserOp is reported as backed up', async () => {
    const sendCalls = vi.fn(async () => ({ state: 'included', txHash: '0xpk' }))
    h.wallet = { account: ACCT, signer: null, chainId: 137, isConnected: true, switchNetwork: vi.fn(), loginMethod: 'passkey', sendCalls }
    const { result } = renderHook(() => useDataBackup())
    let ok
    await act(async () => { ok = await result.current.backup() })
    expect(ok).toBe(true)
    expect(h.showNotification).toHaveBeenCalledWith('Your data is backed up.', 'success')
  })
})
