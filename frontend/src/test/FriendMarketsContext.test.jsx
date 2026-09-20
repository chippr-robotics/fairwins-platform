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
  const { friendMarkets, unreadableNetworks, partial } = useContext(FriendMarketsContext)
  return (
    <div>
      <span data-testid="count">{friendMarkets.length}</span>
      <span data-testid="ids">{[...friendMarkets].map(m => `${m.id}@${m.chainId}`).sort().join(',')}</span>
      <span data-testid="unreadable">{(unreadableNetworks || []).join(',')}</span>
      <span data-testid="partial">{String(partial)}</span>
    </div>
  )
}

/*
 * The testnet cohort's chains that carry a wager contract. Asserted by the first test rather
 * than assumed, because every count below is a function of this roster.
 */
const WAGER_CHAINS = [63, 1337, 80002]

function renderProvider() {
  return render(
    <FriendMarketsProvider>
      <Consumer />
    </FriendMarketsProvider>
  )
}

describe('FriendMarketsContext — the list is the estate (spec 110 T040)', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    mockAccount = { address: '0xabc0000000000000000000000000000000000001', isConnected: true }
    mockChainId = 80002
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('reads every cohort chain that carries a wager contract, tagging each wager with its own', async () => {
    fetchMock.mockImplementation(async (_addr, chainId) => [{ id: `w${chainId}`, contractAddress: '0xfactory' }])

    await act(async () => { renderProvider() })

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe(String(WAGER_CHAINS.length))
    })
    // The roster, and the tag: a wager carries the chain it was READ from, which is what gives
    // Claim a target to name (T040's whole purpose).
    expect(screen.getByTestId('ids').textContent).toBe(
      WAGER_CHAINS.map((c) => `w${c}@${c}`).sort().join(','),
    )
    expect(fetchMock.mock.calls.map((c) => c[1]).sort()).toEqual([...WAGER_CHAINS].sort())

    // Still cached per chain, under the keys that existed before.
    for (const chainId of WAGER_CHAINS) {
      expect(localStorage.getItem(`friendMarkets:${chainId}`)).toBeTruthy()
    }
    expect(localStorage.getItem('friendMarkets')).toBeNull()
  })

  /*
   * THE BEHAVIOUR THAT CHANGED, AND THE REASON IT DID.
   *
   * This used to re-query and SWAP the view on every network change — a member switching chains
   * watched their wagers vanish and come back. The list no longer depends on where the wallet is,
   * which is exactly what lets a wager on another network be claimed at all.
   */
  it('does not re-query when the wallet changes network', async () => {
    fetchMock.mockImplementation(async (_addr, chainId) => [{ id: `w${chainId}`, contractAddress: '0xfactory' }])

    const { rerender } = await act(async () => renderProvider())
    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe(String(WAGER_CHAINS.length))
    })
    const callsAfterFirstRead = fetchMock.mock.calls.length

    mockChainId = 63
    await act(async () => {
      rerender(
        <FriendMarketsProvider>
          <Consumer />
        </FriendMarketsProvider>
      )
    })

    // Same list, no second sweep: the estate does not change because the wallet moved.
    expect(screen.getByTestId('count').textContent).toBe(String(WAGER_CHAINS.length))
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstRead)
  })

  /*
   * An unreachable chain is NAMED. Before, one chain failing meant the member was simply shown
   * nothing for it — indistinguishable from having no wagers there.
   */
  it('names a chain it could not read, and keeps the chains that answered', async () => {
    fetchMock.mockImplementation(async (_addr, chainId) => {
      if (chainId === 80002) throw new Error('endpoint down')
      return [{ id: `w${chainId}`, contractAddress: '0xfactory' }]
    })

    await act(async () => { renderProvider() })

    await waitFor(() => {
      expect(screen.getByTestId('partial').textContent).toBe('true')
    })
    expect(screen.getByTestId('unreadable').textContent).toBe('Polygon Amoy')
    // The chains that answered are unaffected — per-chain failure isolation.
    expect(screen.getByTestId('count').textContent).toBe(String(WAGER_CHAINS.length - 1))
  })
})
