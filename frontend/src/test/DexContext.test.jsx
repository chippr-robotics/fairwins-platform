import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { setWalletChain } from './helpers/walletChain'
import { DexProvider } from '../contexts/DexContext.jsx'
import { useDex } from '../hooks/useDex'

// Spec 033 — DexContext must expose the active network's `dexProvider` so the
// swap UI can name the provider. wagmi is mocked globally in test/setup.js; we
// put the wallet on a chain per render (`setWalletChain`). The wallet hook is stubbed since
// provider identity is derived purely from the active network.

vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: () => ({ provider: null, signer: null, address: null, isConnected: false }),
}))

function ProviderProbe() {
  const { dexProvider, isDexAvailable } = useDex()
  return (
    <div>
      <span data-testid="provider">{dexProvider ? dexProvider.name : 'none'}</span>
      <span data-testid="provider-url">{dexProvider?.url || ''}</span>
      <span data-testid="dex-available">{String(isDexAvailable)}</span>
    </div>
  )
}

function renderAt(chainId) {
  setWalletChain(chainId)
  return render(
    <DexProvider>
      <ProviderProbe />
    </DexProvider>
  )
}

describe('DexContext — exposes network-aware dexProvider (Spec 033 FR-005/009)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes ETCswap on Ethereum Classic mainnet (61)', () => {
    renderAt(61)
    expect(screen.getByTestId('provider')).toHaveTextContent('ETCswap')
    expect(screen.getByTestId('provider-url')).toHaveTextContent('etcswap')
  })

  it('exposes ETCswap on Mordor (63)', () => {
    renderAt(63)
    expect(screen.getByTestId('provider')).toHaveTextContent('ETCswap')
  })

  it('exposes Uniswap on Polygon (137)', () => {
    renderAt(137)
    expect(screen.getByTestId('provider')).toHaveTextContent('Uniswap')
    expect(screen.getByTestId('provider-url')).toHaveTextContent('uniswap.org')
  })

  it('exposes no provider on local Hardhat (1337)', () => {
    renderAt(1337)
    expect(screen.getByTestId('provider')).toHaveTextContent('none')
  })
})
