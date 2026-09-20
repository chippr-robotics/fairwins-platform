import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { useContext } from 'react'

// Controllable wagmi mocks so we can simulate a testnet ↔ mainnet switch.
let mockAccount = { address: '0xabc0000000000000000000000000000000000001', isConnected: true }
let mockChainId = 80002
vi.mock('wagmi', () => ({
  // The chain rides on the CONNECTION now (spec 110 Phase 3) — `useWalletChainId` reads it
  // from `useAccount()`, never from wagmi's configured-chain singleton.
  useAccount: () => ({ ...mockAccount, chainId: mockChainId }),
}))

// The blockchain fetch returns different wager sets per chain so we can assert
// the view follows the active network.
const fetchMock = vi.fn()
vi.mock('../utils/blockchainService', () => ({
  fetchFriendMarketsForUser: (...args) => fetchMock(...args),
}))

import { FriendMarketsProvider } from '../contexts/FriendMarketsContext.jsx'
import { FriendMarketsContext } from '../contexts/FriendMarketsContext'

function Consumer() {
  const { friendMarkets } = useContext(FriendMarketsContext)
  return (
    <div>
      <span data-testid="count">{friendMarkets.length}</span>
      <span data-testid="ids">{friendMarkets.map(m => `${m.id}@${m.chainId}`).join(',')}</span>
    </div>
  )
}

function renderProvider() {
  return render(
    <FriendMarketsProvider>
      <Consumer />
    </FriendMarketsProvider>
  )
}

describe('FriendMarketsContext chain scoping', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    mockAccount = { address: '0xabc0000000000000000000000000000000000001', isConnected: true }
    mockChainId = 80002
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('tags fetched wagers with the active chain id and caches them per chain', async () => {
    fetchMock.mockResolvedValue([{ id: '1', contractAddress: '0xfactory' }])

    await act(async () => {
      renderProvider()
    })

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('1')
    })
    expect(screen.getByTestId('ids').textContent).toBe('1@80002')

    // Cache is stored under a chain-scoped key, not the global one.
    expect(localStorage.getItem('friendMarkets:80002')).toBeTruthy()
    expect(localStorage.getItem('friendMarkets')).toBeNull()
  })

  it('re-queries the chain and swaps the view when the network switches', async () => {
    fetchMock.mockImplementation(async () => {
      // Return data appropriate to whichever chain is currently active.
      return mockChainId === 80002
        ? [{ id: '1', contractAddress: '0xfactory' }, { id: '2', contractAddress: '0xfactory' }]
        : []
    })

    const { rerender } = await act(async () => renderProvider())

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('2')
    })

    // Switch to mainnet (137), where this user has no wagers.
    mockChainId = 137
    await act(async () => {
      rerender(
        <FriendMarketsProvider>
          <Consumer />
        </FriendMarketsProvider>
      )
    })

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('0')
    })

    // The fetch was re-issued for the new network.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
