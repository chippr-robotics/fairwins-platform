/**
 * AssetDetailSheet (spec 044 v1.2, FR-024/FR-026/FR-027) — bottom-sheet
 * contract: instance list with separate balances and network badges,
 * instance selection, action eligibility, and deep-linking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AssetDetailSheet from '../../components/wallet/AssetDetailSheet'

// Semicolon required: vitest's hoisting transform concatenates this with
// the vi.mock call below.
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => mockNavigate }
})

function instance({ symbol, baselineSymbol = 'ETH', kind = 'erc20', chainId = 137, network = 'Polygon', balance = 1, usd = null, categoryId = 'digital-commodities', source = 'sec-baseline' }) {
  return {
    asset: { id: symbol.toLowerCase(), chainId, kind, address: kind === 'native' ? null : `0x${symbol}`, symbol, baselineSymbol, categoryId, source, decimals: 18 },
    balance,
    balanceRaw: 1n,
    usd,
    network,
  }
}

const ETH_AGG = {
  id: 'digital-commodities|ETH',
  categoryId: 'digital-commodities',
  underlying: 'ETH',
  name: 'Ethereum',
  kind: 'fungible',
  balance: 1.75,
  usd: 3500,
  unitPriceUsd: 2000,
  priceEntry: { source: 'chainlink', chainId: 137 },
  instances: [
    instance({ symbol: 'ETH', kind: 'native', chainId: 1, network: 'Ethereum', balance: 1, usd: 2000 }),
    instance({ symbol: 'WETH', chainId: 1, network: 'Ethereum', balance: 0.5, usd: 1000 }),
    instance({ symbol: 'WETH', chainId: 137, network: 'Polygon', balance: 0.25, usd: 500 }),
  ],
}

const VOUCHER_AGG = {
  id: 'digital-tools|FWMV',
  categoryId: 'digital-tools',
  underlying: 'FWMV',
  name: 'FairWins Membership Voucher',
  kind: 'nft',
  balance: 2,
  usd: null,
  unitPriceUsd: null,
  priceEntry: null,
  instances: [instance({ symbol: 'FWMV', baselineSymbol: undefined, kind: 'nft', chainId: 137, balance: 2, categoryId: 'digital-tools', source: 'app-config' })],
}

function renderSheet(aggregate, onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <AssetDetailSheet aggregate={aggregate} onClose={onClose} />
    </MemoryRouter>,
  )
  return onClose
}

beforeEach(() => {
  mockNavigate.mockReset()
})

describe('AssetDetailSheet content', () => {
  it('shows the aggregate position, unit price, and its on-chain source', () => {
    renderSheet(ETH_AGG)
    const sheet = screen.getByRole('dialog', { name: /ethereum details/i })
    expect(within(sheet).getByText(/1\.75 ETH/)).toBeInTheDocument()
    expect(within(sheet).getByText(/\$3,500\.00/)).toBeInTheDocument()
    expect(within(sheet).getByText(/\$2,000\.00 per ETH/)).toBeInTheDocument()
    expect(within(sheet).getByText(/Chainlink oracle \(Polygon\)/)).toBeInTheDocument()
  })

  it('lists each instance separately with form, network, provenance, and balance (FR-025)', () => {
    renderSheet(ETH_AGG)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(screen.getByText('Native')).toBeInTheDocument()
    expect(screen.getAllByText('Wrapped (WETH)')).toHaveLength(2)
    expect(screen.getByText(/1 ETH$/)).toBeInTheDocument()
    expect(screen.getByText('0.5 WETH')).toBeInTheDocument()
    expect(screen.getByText('0.25 WETH')).toBeInTheDocument()
    expect(screen.getAllByText(/SEC baseline/).length).toBeGreaterThan(0)
  })

  it('defaults the selection to the first nonzero instance and lets the member switch (FR-027)', () => {
    renderSheet(ETH_AGG)
    const radios = screen.getAllByRole('radio')
    expect(radios[0]).toBeChecked()
    fireEvent.click(radios[2])
    expect(radios[2]).toBeChecked()
    expect(radios[0]).not.toBeChecked()
  })
})

describe('AssetDetailSheet actions', () => {
  it('deep-links Trade to the selected instance network and token', () => {
    const onClose = renderSheet(ETH_AGG)
    // Select the Polygon WETH instance, then trade.
    fireEvent.click(screen.getAllByRole('radio')[2])
    fireEvent.click(screen.getByRole('button', { name: 'Trade' }))
    expect(mockNavigate).toHaveBeenCalledWith('/wallet?tab=trade&chain=137&token=WETH')
    expect(onClose).toHaveBeenCalled()
  })

  it('disables Trade on networks without an in-app DEX', () => {
    // Ethereum mainnet gained a DEX in spec 067, so it is no longer a no-DEX example.
    // Sepolia (11155111) is: it is outside SWAP_CHAIN_IDS and has no `dex` block.
    renderSheet({
      ...ETH_AGG,
      instances: [
        instance({
          symbol: 'ETH',
          kind: 'native',
          chainId: 11155111,
          network: 'Sepolia',
          balance: 1,
          usd: 2000,
        }),
      ],
    })
    fireEvent.click(screen.getAllByRole('radio')[0])
    expect(screen.getByRole('button', { name: 'Trade' })).toBeDisabled()
    expect(screen.getByText(/no in-app trading on this network/i)).toBeInTheDocument()
  })

  it('enables Transfer for native coins and disables it for plain wrapped tokens', () => {
    renderSheet(ETH_AGG)
    fireEvent.click(screen.getAllByRole('radio')[0]) // native ETH
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeEnabled()
    fireEvent.click(screen.getAllByRole('radio')[2]) // WETH on Polygon
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeDisabled()
  })

  it('deep-links Earn to the lend view scoped to the instance (spec 050, US3)', () => {
    const onClose = renderSheet(ETH_AGG)
    // WETH on Polygon — an earn-enabled network (chain 137).
    fireEvent.click(screen.getAllByRole('radio')[2])
    const earn = screen.getByRole('button', { name: 'Earn' })
    expect(earn).toBeEnabled()
    fireEvent.click(earn)
    expect(mockNavigate).toHaveBeenCalledWith('/wallet?tab=earn&view=lend&chain=137&token=WETH')
    expect(onClose).toHaveBeenCalled()
  })

  it('disables Earn with a reason on non-earn networks and for collectibles (spec 050)', () => {
    // Mordor voucher NFT: wrong kind AND (were it fungible) non-earn network.
    renderSheet(VOUCHER_AGG)
    const earn = screen.getByRole('button', { name: 'Earn' })
    expect(earn).toBeDisabled()
    expect(screen.getByText(/collectibles cannot be lent/i)).toBeInTheDocument()
  })

  it('enables Stake for ETH on Ethereum and deep-links to the stake view (spec 065)', () => {
    renderSheet(ETH_AGG)
    const stake = screen.getByRole('button', { name: 'Stake' })
    expect(stake).toBeEnabled()
    fireEvent.click(stake)
    expect(mockNavigate).toHaveBeenCalledWith('/wallet?tab=earn&view=stake&chain=1&token=ETH')
  })

  it('offers no trading for collectibles', () => {
    renderSheet(VOUCHER_AGG)
    expect(screen.getByRole('button', { name: 'Trade' })).toBeDisabled()
    expect(screen.getByText(/collectibles cannot be traded here/i)).toBeInTheDocument()
  })
})

describe('AssetDetailSheet voucher send (release 1.14.0 task 9)', () => {
  // FWMV is transferable by design (spec 026: gifted or resold), so the sheet must not leave
  // the member with four disabled actions. Send / Gift routes into the EXISTING voucher
  // transfer flow on VouchersPage — no transfer logic is re-implemented here.
  it('offers Send / Gift on the FWMV voucher asset', () => {
    renderSheet(VOUCHER_AGG)
    expect(screen.getByRole('button', { name: 'Send / Gift' })).toBeEnabled()
  })

  it('activating Send / Gift opens the voucher transfer flow and closes the sheet', () => {
    const onClose = renderSheet(VOUCHER_AGG)
    fireEvent.click(screen.getByRole('button', { name: 'Send / Gift' }))
    expect(mockNavigate).toHaveBeenCalledWith('/vouchers#vch-transfer')
    expect(onClose).toHaveBeenCalled()
  })

  it('does not offer Send / Gift on non-voucher assets', () => {
    renderSheet(ETH_AGG)
    expect(screen.queryByRole('button', { name: 'Send / Gift' })).not.toBeInTheDocument()
  })

  it('does not offer Send / Gift on other NFT aggregates', () => {
    renderSheet({
      ...VOUCHER_AGG,
      id: 'digital-collectibles|COOL',
      underlying: 'COOL',
      name: 'Cool Cats',
      instances: [instance({ symbol: 'COOL', baselineSymbol: undefined, kind: 'nft', chainId: 137, balance: 1, categoryId: 'digital-collectibles', source: 'curated-registry' })],
    })
    expect(screen.queryByRole('button', { name: 'Send / Gift' })).not.toBeInTheDocument()
  })
})

describe('AssetDetailSheet dismissal', () => {
  it('closes on Escape and on the backdrop scrim', () => {
    const onClose = renderSheet(ETH_AGG)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /close asset details/i }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
