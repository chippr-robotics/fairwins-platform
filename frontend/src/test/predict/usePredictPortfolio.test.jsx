/**
 * usePredictPositions / usePredictOpenOrders (spec 057) — per-address reads. Positions are public (gateway).
 * Open orders are client-direct via the SDK and load ONLY when creds are cached (else 'locked' — no prompt).
 * Soft-fail off Polygon (no fetch), load on connect, degrade on error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { WalletContext } from '../../contexts/WalletContext.js'
import { usePredictPositions, usePredictOpenOrders } from '../../hooks/usePredictPortfolio'
import * as client from '../../lib/predict/predictClient'

vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchPositions: vi.fn(),
}))

const TRADER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const wrapperFor = (wallet) => ({ children }) => <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>

beforeEach(() => {
  vi.clearAllMocks()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
})

describe('usePredictPositions', () => {
  it('loads positions for a connected wallet', async () => {
    client.fetchPositions.mockResolvedValue({ positions: [{ tokenId: '1', outcome: 'Yes', size: '10' }] })
    const { result } = renderHook(() => usePredictPositions(), { wrapper: wrapperFor({ address: TRADER, isConnected: true }) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.positions).toHaveLength(1)
  })

  it('does NOT fetch when unsupported (off Polygon)', async () => {
    client.predictAvailable.mockReturnValue(false)
    const { result } = renderHook(() => usePredictPositions(), { wrapper: wrapperFor({ address: TRADER, isConnected: true }) })
    expect(result.current.status).toBe('unsupported')
    expect(client.fetchPositions).not.toHaveBeenCalled()
  })

  it('degrades on error', async () => {
    client.fetchPositions.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => usePredictPositions(), { wrapper: wrapperFor({ address: TRADER, isConnected: true }) })
    await waitFor(() => expect(result.current.status).toBe('degraded'))
  })
})

describe('usePredictOpenOrders', () => {
  const ooDeps = (over = {}) => ({
    loadCachedCreds: vi.fn(() => ({ key: 'k', secret: 's', passphrase: 'p' })),
    makeClient: vi.fn(() => ({ id: 'clob-client' })),
    fetchOpenOrders: vi.fn().mockResolvedValue([{ id: '0xo1', side: 'BUY' }]),
    ...over,
  })

  it('loads open orders client-direct when trading creds are cached', async () => {
    const deps = ooDeps()
    const { result } = renderHook(() => usePredictOpenOrders({ deps }), { wrapper: wrapperFor({ address: TRADER, isConnected: true }) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.orders).toHaveLength(1)
    expect(deps.fetchOpenOrders).toHaveBeenCalled()
  })

  it("is 'locked' until trading is enabled — never prompts just to read the portfolio", async () => {
    const deps = ooDeps({ loadCachedCreds: vi.fn(() => null) })
    const { result } = renderHook(() => usePredictOpenOrders({ deps }), { wrapper: wrapperFor({ address: TRADER, isConnected: true }) })
    await waitFor(() => expect(result.current.status).toBe('locked'))
    expect(deps.fetchOpenOrders).not.toHaveBeenCalled()
  })

  it('is disconnected without a wallet', () => {
    const { result } = renderHook(() => usePredictOpenOrders({ deps: ooDeps() }), { wrapper: wrapperFor({}) })
    expect(result.current.status).toBe('disconnected')
  })

  it('does NOT fetch when passkey (trading deferred)', () => {
    const { result } = renderHook(() => usePredictOpenOrders({ deps: ooDeps() }), {
      wrapper: wrapperFor({ address: TRADER, isConnected: true, loginMethod: 'passkey' }),
    })
    expect(result.current.status).toBe('unsupported')
  })
})
