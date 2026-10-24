// Spec 102 (T004, D6, FR-013) — acting as a vault binds to the ADDRESS. `active.chainId` follows the
// wallet's chain where the vault EXISTS there and holds its pin where it does not; the single-chainId
// call shape every existing caller uses keeps working.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

let walletCtx = { address: '0xowner', chainId: 137 }
vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))

import { CustodyProvider } from '../../contexts/CustodyContext.jsx'
import { useCustody } from '../../hooks/useCustody'

function Probe({ vault }) {
  const { active, operateAsVault } = useCustody()
  return (
    <div>
      <span data-testid="mode">{active.mode}</span>
      <span data-testid="chain">{String(active.chainId)}</span>
      <span data-testid="chains">{(active.chainIds || []).join(',')}</span>
      <button onClick={() => operateAsVault(vault)}>as-vault</button>
    </div>
  )
}

const renderWith = (vault) =>
  render(
    <CustodyProvider>
      <Probe vault={vault} />
    </CustodyProvider>,
  )

beforeEach(() => {
  walletCtx = { address: '0xowner', chainId: 137 }
})

describe('CustodyContext — the acting vault follows the wallet where it can (spec 102)', () => {
  it('resolves to the wallet chain when the vault is on it, and stores every chain', () => {
    renderWith({ address: '0xVault', chainIds: [8453, 137], label: 'Treasury' })
    fireEvent.click(screen.getByText('as-vault'))
    expect(screen.getByTestId('mode')).toHaveTextContent('vault')
    expect(screen.getByTestId('chain')).toHaveTextContent('137')
    expect(screen.getByTestId('chains')).toHaveTextContent('8453,137')
  })

  it('pins to the first instance when the wallet is on a chain the vault is NOT on', () => {
    walletCtx = { address: '0xowner', chainId: 1 }
    renderWith({ address: '0xVault', chainIds: [8453, 137] })
    fireEvent.click(screen.getByText('as-vault'))
    expect(screen.getByTestId('chain')).toHaveTextContent('8453')
  })

  it('honours an explicit chainId the vault is on over the wallet chain', () => {
    renderWith({ address: '0xVault', chainIds: [8453, 137], chainId: 8453 })
    fireEvent.click(screen.getByText('as-vault'))
    expect(screen.getByTestId('chain')).toHaveTextContent('8453')
  })

  it('follows a wallet chain change to a chain in chainIds — no prompt', () => {
    const { rerender } = renderWith({ address: '0xVault', chainIds: [137, 8453] })
    fireEvent.click(screen.getByText('as-vault'))
    expect(screen.getByTestId('chain')).toHaveTextContent('137')

    walletCtx = { address: '0xowner', chainId: 8453 }
    rerender(
      <CustodyProvider>
        <Probe vault={{ address: '0xVault', chainIds: [137, 8453] }} />
      </CustodyProvider>,
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('vault')
    expect(screen.getByTestId('chain')).toHaveTextContent('8453')
  })

  it('holds the pin when the wallet moves to a chain the vault is NOT on', () => {
    const { rerender } = renderWith({ address: '0xVault', chainIds: [137, 8453] })
    fireEvent.click(screen.getByText('as-vault'))

    walletCtx = { address: '0xowner', chainId: 1 }
    rerender(
      <CustodyProvider>
        <Probe vault={{ address: '0xVault', chainIds: [137, 8453] }} />
      </CustodyProvider>,
    )
    expect(screen.getByTestId('chain')).toHaveTextContent('137') // pinned; a send auto-switches back
    expect(screen.getByTestId('mode')).toHaveTextContent('vault')
  })

  it('keeps the single-chainId call shape working (back-compat) and does not follow off it', () => {
    const { rerender } = renderWith({ address: '0xVault', chainId: 63, label: 'Coop' })
    fireEvent.click(screen.getByText('as-vault'))
    expect(screen.getByTestId('chain')).toHaveTextContent('63')
    expect(screen.getByTestId('chains')).toHaveTextContent('63')

    walletCtx = { address: '0xowner', chainId: 137 }
    rerender(
      <CustodyProvider>
        <Probe vault={{ address: '0xVault', chainId: 63 }} />
      </CustodyProvider>,
    )
    expect(screen.getByTestId('chain')).toHaveTextContent('63')
  })

  it('ignores a vault with neither chainIds nor chainId', () => {
    renderWith({ address: '0xVault', chainIds: [] })
    fireEvent.click(screen.getByText('as-vault'))
    expect(screen.getByTestId('mode')).toHaveTextContent('personal')
  })
})
