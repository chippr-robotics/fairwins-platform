/**
 * Transfer → Bridge tab tests (spec 067, US1 — T082/T083/T084, SC-014).
 *
 * Two things are being proved here:
 *
 *   1. FR-004 — the Bridge surface sits BESIDE the other money-moving surfaces, is
 *      reachable by a direct link, and does not displace or degrade the same-chain
 *      send flow (which stays the default tab).
 *
 *   2. FR-051/FR-052/FR-053 — every way bridging can be unavailable is presented with
 *      its own stated reason and, where the state came from a read, "as of" that read.
 *      In every one of those states the in-flight list still renders: an outage must
 *      never hide a transfer that is already moving.
 *
 * `BridgeView` and `BridgeStatusList` are stubbed so this file is about the tab and the
 * availability decision; each is covered by its own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { MemoryRouter } from 'react-router-dom'

const mockWallet = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => mockWallet.current,
}))

const mockRouter = vi.hoisted(() => ({
  address: vi.fn(() => '0x00000000000000000000000000000000000000b1'),
  config: vi.fn(async () => ({ routerAddress: '0x00000000000000000000000000000000000000b1', paused: false, routes: [] })),
}))
vi.mock('../../lib/bridge/bridgeRouter', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getBridgeRouterAddress: (...args) => mockRouter.address(...args),
    readBridgeRouterConfig: (...args) => mockRouter.config(...args),
  }
})

const mockGateway = vi.hoisted(() => ({ current: 'https://gateway.example' }))
vi.mock('../../lib/bridge/acrossQuotes', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, bridgeGatewayUrl: () => mockGateway.current }
})

vi.mock('../../components/wallet/BridgeView', () => ({
  default: () => <div data-testid="bridge-view">bridge form</div>,
}))
vi.mock('../../components/wallet/BridgeStatusList', () => ({
  default: () => <div data-testid="bridge-status-list">in-flight transfers</div>,
}))
vi.mock('../../components/wallet/TransferForm', () => ({
  default: () => <div data-testid="transfer-form">same-chain send</div>,
}))
// Wagers joined this tab row (spec 073). Stubbed like every other sibling — a real Dashboard would
// drag the whole wager tree, its providers and its chain reads into a test about tab placement.
vi.mock('../../components/fairwins/Dashboard', () => ({
  default: () => <div data-testid="wagers-dashboard">wagers</div>,
}))

import PayTransferPanel from '../../components/wallet/PayTransferPanel'

const POLYGON = 137
const ETC = 61

function renderPanel(path = '/wallet?tab=paytransfer') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PayTransferPanel />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockWallet.current = { address: '0x4444444444444444444444444444444444444444', chainId: POLYGON, isConnected: true }
  mockGateway.current = 'https://gateway.example'
  mockRouter.address = vi.fn(() => '0x00000000000000000000000000000000000000b1')
  mockRouter.config = vi.fn(async () => ({
    routerAddress: '0x00000000000000000000000000000000000000b1',
    paused: false,
    routes: [],
  }))
})

describe('Bridge tab placement (FR-004)', () => {
  it('sits beside Transfer without displacing the send flow', async () => {
    renderPanel()
    const tabs = screen.getAllByRole('tab')
    // Every tab in this row is an ACTION: send it, move it across networks, stake it.
    // Activity is gone from here — the ledger feed lives in My Account ▸ Activity.
    // Wrap left for Trade (release 1.14.0, wrapInTrade.test.jsx pins the move).
    expect(tabs.map((t) => t.textContent)).toEqual(['Transfer', 'Bridge', 'Wagers'])
    // Default tab is unchanged: the same-chain send flow.
    expect(screen.getByTestId('transfer-form')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Transfer' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('bridge-view')).toBeNull()
  })

  it('opens from a direct link (?view=bridge) and leaves the send flow reachable', async () => {
    renderPanel('/wallet?tab=paytransfer&view=bridge')
    expect(await screen.findByTestId('bridge-view')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Bridge' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('transfer-form')).toBeNull()

    await userEvent.click(screen.getByRole('tab', { name: 'Transfer' }))
    expect(screen.getByTestId('transfer-form')).toBeInTheDocument()
  })

  it('switches to Bridge by click and shows the in-flight list with the form', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('tab', { name: 'Bridge' }))
    expect(await screen.findByTestId('bridge-view')).toBeInTheDocument()
    expect(screen.getByTestId('bridge-status-list')).toBeInTheDocument()
  })
})

describe('Tab-level availability is GLOBAL, not per-wallet-chain (FR-059/FR-061)', () => {
  const openBridge = () => renderPanel('/wallet?tab=paytransfer&view=bridge')

  // The tab used to gate the whole surface on useBridgeAvailability() for the WALLET's active
  // chain. That contradicted the premise of the feature: a bridge originates on the SOURCE asset's
  // network, and FR-059/FR-061 exist so a member never has to switch networks to find or select an
  // asset. The old behaviour told a member on Ethereum Classic to "pick an asset on one of those
  // networks" while rendering no asset selector to pick from.
  //
  // Per-SOURCE states (router paused / undeployed / unreachable, Bitcoin, empty list) are resolved
  // and explained inside BridgeView and are covered in BridgeView.test.jsx.

  it('renders the bridge form even when the wallet sits on a network that cannot bridge', async () => {
    mockWallet.current = { ...mockWallet.current, chainId: ETC }
    openBridge()

    expect(await screen.findByTestId('bridge-view')).toBeInTheDocument()
    expect(screen.getByTestId('bridge-status-list')).toBeInTheDocument()
  })

  it('renders the bridge form even when the wallet sits on Bitcoin (FR-006 stays a per-asset rule)', async () => {
    mockWallet.current = { ...mockWallet.current, chainId: 'bitcoin' }
    openBridge()

    expect(await screen.findByTestId('bridge-view')).toBeInTheDocument()
  })

  it('does not read the router at tab level — that is the selected source\'s business', async () => {
    mockWallet.current = { ...mockWallet.current, chainId: ETC }
    openBridge()
    await screen.findByTestId('bridge-view')
    // The tab makes no chain-keyed lookup of its own; BridgeView drives reads off the source.
    expect(mockRouter.address).not.toHaveBeenCalledWith(ETC)
  })

  it('gateway unset: refuses to price a transfer rather than inventing a number', async () => {
    // The one genuinely GLOBAL precondition — no gateway means no honest price on ANY network
    // (research R10), so this one legitimately belongs at tab level.
    mockGateway.current = ''
    openBridge()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/cannot reach the service that prices transfers/)
    expect(alert).toHaveTextContent(/we will not show you a made-up price/)
    expect(screen.queryByTestId('bridge-view')).toBeNull()
    // FR-053 — an outage never hides a transfer that is already moving.
    expect(screen.getByTestId('bridge-status-list')).toBeInTheDocument()
  })
})

describe('Bridge tab accessibility (SC-014)', () => {
  it('has no axe violations when bridging is available', async () => {
    const { container } = renderPanel('/wallet?tab=paytransfer&view=bridge')
    await screen.findByTestId('bridge-view')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations in the (gateway-unset) unavailable state', async () => {
    mockGateway.current = ''
    mockRouter.config = vi.fn(async () => ({ routerAddress: '0xb1', paused: true, routes: [] }))
    const { container } = renderPanel('/wallet?tab=paytransfer&view=bridge')
    await screen.findByRole('alert')
    expect(await axe(container)).toHaveNoViolations()
  })
})
