/**
 * useCollectibles (spec 055) — state machine per data-model.md: unsupported short-circuit
 * (no fetches, FR-007), ready/empty/degraded, cursor loadMore, network scoping (FR-010).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { WalletContext } from '../../contexts/WalletContext.js'
import { useCollectibles, useCollectiblesValuation } from '../../hooks/useCollectibles'
import {
  collectiblesAvailable,
  fetchAccountCollectibles,
  fetchCollectionStats,
  CollectiblesUnavailable,
} from '../../lib/collectibles/gatewayClient'

vi.mock('../../lib/collectibles/gatewayClient', () => ({
  collectiblesAvailable: vi.fn(() => true),
  collectiblesGatewayUrl: vi.fn(() => 'https://relay.example'),
  fetchAccountCollectibles: vi.fn(),
  fetchCollectibleDetail: vi.fn(),
  fetchCollectionStats: vi.fn(),
  CollectiblesUnavailable: class CollectiblesUnavailable extends Error {},
}))

const ITEM = {
  chainId: 137,
  contract: '0x2953399124F0cBB46d2CbACD8A89cF0599974963',
  identifier: '1',
  name: 'Cat #1',
  collectionSlug: 'cats',
  imageUrl: null,
  quantity: 1,
  isFlagged: false,
  openseaUrl: 'https://opensea.io/assets/matic/0x2953399124f0cbb46d2cbacd8a89cf0599974963/1',
}

const page = (items, next = null, stale = false) => ({ items, next, fetchedAt: '2026-07-13T20:00:00Z', stale })

// The hook reads WalletContext tolerantly (soft-fail); tests provide it via wrapper.
const wrapper = ({ children }) => (
  <WalletContext.Provider value={{ address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', isConnected: true }}>
    {children}
  </WalletContext.Provider>
)

beforeEach(() => {
  vi.clearAllMocks()
  setWalletChain(137)
  collectiblesAvailable.mockReturnValue(true)
})

describe('useCollectibles', () => {
  it('loads the first page and reports ready', async () => {
    fetchAccountCollectibles.mockResolvedValue(page([ITEM]))
    const { result } = renderHook(() => useCollectibles(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toEqual([ITEM])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.stale).toBe(false)
  })

  it('reports empty for a wallet with no collectibles', async () => {
    fetchAccountCollectibles.mockResolvedValue(page([]))
    const { result } = renderHook(() => useCollectibles(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('empty'))
  })

  it('reports degraded when the gateway is unreachable (FR-008)', async () => {
    fetchAccountCollectibles.mockRejectedValue(new CollectiblesUnavailable('down'))
    const { result } = renderHook(() => useCollectibles(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('degraded'))
    expect(result.current.items).toEqual([])
  })

  it('short-circuits on unsupported networks: {supported:false}, ZERO fetches (FR-007)', async () => {
    collectiblesAvailable.mockReturnValue(false)
    setWalletChain(63)
    const { result } = renderHook(() => useCollectibles(), { wrapper })
    expect(result.current.supported).toBe(false)
    expect(result.current.status).toBe('unsupported')
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchAccountCollectibles).not.toHaveBeenCalled()
  })

  it('appends cursor pages via loadMore and surfaces page staleness', async () => {
    fetchAccountCollectibles
      .mockResolvedValueOnce(page([ITEM], 'cursor-2'))
      .mockResolvedValueOnce(page([{ ...ITEM, identifier: '2' }], null, true))
    const { result } = renderHook(() => useCollectibles(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    expect(result.current.items).toHaveLength(2)
    expect(fetchAccountCollectibles).toHaveBeenLastCalledWith(137, expect.any(String), 'cursor-2')
    expect(result.current.hasMore).toBe(false)
    expect(result.current.stale).toBe(true)
  })
})

describe('useCollectiblesValuation', () => {
  it('fetches floor stats per distinct collection once items are ready', async () => {
    fetchAccountCollectibles.mockResolvedValue(
      page([ITEM, { ...ITEM, identifier: '2' }, { ...ITEM, identifier: '3', collectionSlug: 'dogs' }])
    )
    fetchCollectionStats.mockImplementation(async (slug) => ({
      slug,
      floorPrice: { amount: '1', currency: 'ETH' },
      fetchedAt: '2026-07-13T20:00:00Z',
      stale: false,
    }))
    const { result } = renderHook(() => useCollectiblesValuation(), { wrapper })
    await waitFor(() => expect(result.current.statsBySlug.size).toBe(2))
    expect(fetchCollectionStats).toHaveBeenCalledTimes(2)
    expect(result.current.statsBySlug.get('cats').floorPrice.amount).toBe('1')
  })

  it('leaves failed floor legs unpriced without failing the valuation', async () => {
    fetchAccountCollectibles.mockResolvedValue(page([ITEM, { ...ITEM, identifier: '9', collectionSlug: 'dogs' }]))
    fetchCollectionStats.mockImplementation(async (slug) => {
      if (slug === 'dogs') throw new CollectiblesUnavailable('down')
      return { slug, floorPrice: { amount: '1', currency: 'ETH' }, stale: false }
    })
    const { result } = renderHook(() => useCollectiblesValuation(), { wrapper })
    await waitFor(() => expect(result.current.statsBySlug.size).toBe(1))
    expect(result.current.statsBySlug.has('dogs')).toBe(false)
  })
})
