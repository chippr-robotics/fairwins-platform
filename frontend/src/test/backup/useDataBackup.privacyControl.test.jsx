import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Spec 032 US4 — privacy & control: opt-in (nothing published until an explicit backup) and removal
// (clear the on-chain pointer; local data unaffected).

const h = vi.hoisted(() => ({ wallet: {}, showNotification: vi.fn(), uploadJson: vi.fn(), fetchByCid: vi.fn(), readPointer: vi.fn(), writePointer: vi.fn(), buildSetPointerCall: vi.fn(), available: true }))
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

import { useDataBackup } from '../../hooks/useDataBackup'

const ACCT = '0xAbC0000000000000000000000000000000000001'
const signer = { signMessage: vi.fn().mockResolvedValue('0xsig') }

beforeEach(() => {
  localStorage.clear()
  h.wallet = { account: ACCT, signer, chainId: 137, isConnected: true, switchNetwork: vi.fn() }
  h.showNotification.mockReset()
  h.uploadJson.mockReset()
  h.writePointer.mockReset().mockResolvedValue({})
  h.buildSetPointerCall.mockReset().mockImplementation((cid) => ({ target: '0xREGISTRY', data: `0xset:${cid}` }))
  h.readPointer.mockReset().mockResolvedValue('')
  h.available = true
})

describe('useDataBackup privacy & control', () => {
  it('is opt-in: mounting the hook publishes nothing off-device', async () => {
    renderHook(() => useDataBackup())
    await act(async () => {}) // flush mount effect (status refresh reads only)
    expect(h.uploadJson).not.toHaveBeenCalled()
    expect(h.writePointer).not.toHaveBeenCalled()
  })

  it('remove() clears the on-chain pointer and updates status', async () => {
    h.readPointer.mockResolvedValue('bafyexisting')
    const { result } = renderHook(() => useDataBackup())
    await act(async () => { await result.current.refreshStatus() })
    expect(result.current.hasRemote).toBe(true)
    let ok
    await act(async () => { ok = await result.current.remove() })
    expect(ok).toBe(true)
    expect(h.writePointer).toHaveBeenCalledWith(signer, '')
    expect(result.current.hasRemote).toBe(false)
    expect(h.showNotification).toHaveBeenCalledWith(expect.stringContaining('removed'), 'success')
  })

  /*
   * The write-settles race (#1327), removal direction. A stalled clear reported as "removed" is the
   * worse half of the bug: the member believes their backup is gone off the chain while the pointer
   * is still published, and stops trying to remove it.
   */
  it('passkey: a clear that stalls is never reported as removed', async () => {
    h.readPointer.mockResolvedValue('bafyexisting')
    const sendCalls = vi.fn(async () => ({ state: 'stalled', userOpHash: '0xpk' }))
    h.wallet = { account: ACCT, signer: null, chainId: 137, isConnected: true, switchNetwork: vi.fn(), loginMethod: 'passkey', sendCalls }
    const { result } = renderHook(() => useDataBackup())
    await act(async () => { await result.current.refreshStatus() })
    let ok
    await act(async () => { ok = await result.current.remove() })
    expect(ok).toBe(false)
    expect(h.showNotification).not.toHaveBeenCalledWith(expect.stringContaining('removed'), 'success')
    expect(result.current.hasRemote).toBe(true) // still pointed at — the read said so and nothing changed it
  })
})
