/**
 * Wrap inside Finance ▸ Trade (release 1.14.0 task 7).
 *
 * Wrap moved from the Transfer section into Trade: wrapping the network coin into its ERC-20
 * form is a trade-shaped action (it changes the FORM you hold, not where the money is), and it
 * sits beside Swap where a member preparing for a DEX actually needs it.
 *
 * What this file pins is the part that can silently break, mirroring wagersInTransfer.test.jsx:
 *
 *   1. Trade gains a Wrap view (`?view=wrap`) rendering the existing WrapView unchanged, without
 *      disturbing the Swap default or the Perps gating (spec 082).
 *   2. The OLD Transfer wrap URL (`/wallet?tab=paytransfer&view=wrap`) still resolves — it
 *      redirects to the new Trade location the same way `/wagers` redirects into Transfer
 *      (spec 073 FR-030): a redirect costs nothing where a dead link costs a member the surface.
 *   3. Transfer no longer offers a Wrap tab of its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const mockPerpsGateway = vi.hoisted(() => ({ current: 'https://perps.example' }))
vi.mock('../../config/perps', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, perpsGatewayUrl: () => mockPerpsGateway.current }
})

vi.mock('../../components/fairwins/TradePanel', () => ({
  default: () => <div data-testid="trade-panel">swap form</div>,
}))
vi.mock('../../components/perps/PerpsView', () => ({
  default: () => <div data-testid="perps-view">perps</div>,
}))
vi.mock('../../components/wallet/WrapView', () => ({
  default: () => <div data-testid="wrap-view">wrap form</div>,
}))

// PayTransferPanel siblings, stubbed like every neighbouring suite — under test is which view a
// panel picked, not what the trees underneath read from the chain.
const mockWallet = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => mockWallet.current,
}))
vi.mock('../../components/wallet/TransferForm', () => ({
  default: () => <div data-testid="transfer-form">same-chain send</div>,
}))
vi.mock('../../components/wallet/BridgeView', () => ({
  default: () => <div data-testid="bridge-view">bridge form</div>,
}))
vi.mock('../../components/wallet/BridgeStatusList', () => ({
  default: () => <div data-testid="bridge-status-list">in-flight</div>,
}))
vi.mock('../../components/fairwins/Dashboard', () => ({
  default: () => <div data-testid="wagers-dashboard">wagers</div>,
}))

import TradeSection from '../../components/fairwins/TradeSection'
import PayTransferPanel from '../../components/wallet/PayTransferPanel'
import { TRADE_WRAP_PATH } from '../../config/appNav'

function renderTrade(path = '/wallet?tab=trade') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TradeSection />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockPerpsGateway.current = 'https://perps.example'
  mockWallet.current = { address: '0x4444444444444444444444444444444444444444', chainId: 137, isConnected: true }
})

describe('Wrap is a view of the Trade section', () => {
  it('does not displace the swap flow: Swap is still the default view', () => {
    renderTrade()
    expect(screen.getByTestId('trade-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('wrap-view')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Swap' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Swap', 'Wrap', 'Perps'])
  })

  it('opens by click and returns to the swap flow', async () => {
    renderTrade()
    await userEvent.click(screen.getByRole('tab', { name: 'Wrap' }))
    expect(screen.getByTestId('wrap-view')).toBeInTheDocument()
    expect(screen.queryByTestId('trade-panel')).toBeNull()

    await userEvent.click(screen.getByRole('tab', { name: 'Swap' }))
    expect(screen.getByTestId('trade-panel')).toBeInTheDocument()
  })

  it('opens from a direct link at the path the nav model publishes', () => {
    expect(TRADE_WRAP_PATH).toBe('/wallet?tab=trade&view=wrap')
    renderTrade(TRADE_WRAP_PATH)
    expect(screen.getByTestId('wrap-view')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Wrap' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Wrap' })).toBeInTheDocument()
  })

  it('keeps the Perps gating: no gateway means no Perps tab, Wrap survives', () => {
    mockPerpsGateway.current = ''
    renderTrade()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Swap', 'Wrap'])
    expect(screen.getByTestId('trade-panel')).toBeInTheDocument()
  })

  it('still renders Perps at ?view=perps when the gateway is configured', () => {
    renderTrade('/wallet?tab=trade&view=perps')
    expect(screen.getByTestId('perps-view')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Perps' })).toHaveAttribute('aria-selected', 'true')
  })
})

// --- The legacy Transfer wrap link -------------------------------------------------------------

function LocationProbe() {
  const { pathname, search } = useLocation()
  return <span data-testid="loc">{`${pathname}${search}`}</span>
}

describe('the legacy Transfer wrap link', () => {
  it('is no longer a Transfer tab', () => {
    render(
      <MemoryRouter initialEntries={['/wallet?tab=paytransfer']}>
        <PayTransferPanel />
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Transfer', 'Bridge', 'Wagers',
    ])
  })

  it('redirects ?tab=paytransfer&view=wrap to the Trade location instead of 404ing the view', () => {
    // The old URL is on saved links and in muscle memory. PayTransferPanel owns the redirect
    // (a query-level move cannot live in App.jsx's route table), and it points at the SAME
    // constant the Trade section publishes, so the two cannot drift.
    render(
      <MemoryRouter initialEntries={['/wallet?tab=paytransfer&view=wrap']}>
        <Routes>
          <Route
            path="/wallet"
            element={
              <>
                <PayTransferPanel />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('loc')).toHaveTextContent('/wallet?tab=trade&view=wrap')
  })
})
