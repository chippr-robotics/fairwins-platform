/**
 * Wagers inside Finance ▸ Transfer (spec 073).
 *
 * Wagers was an absolute `/wagers` page (spec 053) and was then planned as a mini-app package
 * (T030–T033). It is neither. It is the third view of the Transfer section, beside Transfer and
 * Bridge, because all three are ways money leaves this section: send it, move it across networks,
 * or stake it against a counterparty.
 *
 * The move is only worth anything if nothing was lost on the way, so what this file pins is the
 * part that can silently break:
 *
 *   1. The view exists, is reachable by click AND by direct link, and does not displace the
 *      default send flow — a member who came here to send money must still land on the send form.
 *   2. The legacy `/wagers` route still resolves. It is in bookmarks and shared links; a redirect
 *      costs nothing where a 404 costs a member their way in.
 *   3. Tenant gating survives the move. `wagers` is an optional manifest feature (spec 072), so a
 *      tenant without it gets no tab — and a saved `?view=wagers` link falls back to Transfer
 *      rather than rendering an empty panel.
 *
 * Dashboard is stubbed throughout: what is under test is which view the panel picked, not what the
 * wager tree then reads from the chain (that has its own suites).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'

const mockWallet = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => mockWallet.current,
}))

vi.mock('../../components/fairwins/Dashboard', () => ({
  default: () => <div data-testid="wagers-dashboard">wager quick actions</div>,
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

import PayTransferPanel from '../../components/wallet/PayTransferPanel'
import { WAGERS_PATH, WAGERS_VIEW, pathForNavItem } from '../../config/appNav'

function renderPanel(path = '/wallet?tab=paytransfer') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PayTransferPanel />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockWallet.current = { address: '0x4444444444444444444444444444444444444444', chainId: 137, isConnected: true }
})

describe('Wagers is a view of the Transfer section', () => {
  it('appears last in a row that is now all actions', () => {
    renderPanel()
    // Wrap left this row for Trade (release 1.14.0, wrapInTrade.test.jsx pins the move).
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Transfer', 'Bridge', 'Wagers',
    ])
  })

  it('does not displace the send flow: Transfer is still the default view', () => {
    renderPanel()
    expect(screen.getByTestId('transfer-form')).toBeInTheDocument()
    expect(screen.queryByTestId('wagers-dashboard')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Transfer' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens by click and returns to the send flow', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('tab', { name: 'Wagers' }))
    expect(screen.getByTestId('wagers-dashboard')).toBeInTheDocument()
    expect(screen.queryByTestId('transfer-form')).toBeNull()

    await userEvent.click(screen.getByRole('tab', { name: 'Transfer' }))
    expect(screen.getByTestId('transfer-form')).toBeInTheDocument()
  })

  it('opens from a direct link at the path the nav model publishes', () => {
    // Asserted against WAGERS_PATH rather than a literal, so the route helper, the redirect and
    // this panel can only ever agree or fail together.
    expect(WAGERS_PATH).toBe(pathForNavItem(WAGERS_VIEW.id))
    renderPanel(WAGERS_PATH)
    expect(screen.getByTestId('wagers-dashboard')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Wagers' })).toHaveAttribute('aria-selected', 'true')
  })

  it('labels its own tabpanel, so the view is announced as Wagers and not as Transfer', () => {
    renderPanel(WAGERS_PATH)
    expect(screen.getByRole('tabpanel', { name: 'Wagers' })).toBeInTheDocument()
  })
})

// --- The legacy route --------------------------------------------------------------------------

function LocationProbe() {
  const { pathname, search } = useLocation()
  return <span data-testid="loc">{`${pathname}${search}`}</span>
}

describe('the legacy /wagers link', () => {
  it('still resolves — it redirects to the view instead of 404ing', () => {
    // App.jsx owns the redirect. Re-declared here against the SAME constant rather than rendering
    // <App />, which would drag every provider in the tree into a routing assertion. What this
    // catches is the thing that actually rots: WAGERS_PATH moving while a hardcoded target does not.
    render(
      <MemoryRouter initialEntries={['/wagers']}>
        <Routes>
          <Route path="/wagers" element={<Navigate to={WAGERS_PATH} replace />} />
          <Route path="/wallet" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('loc')).toHaveTextContent('/wallet?tab=paytransfer&view=wagers')
  })
})

// --- Tenant gating -----------------------------------------------------------------------------

// `wagers` is an optional manifest feature (spec 072). The tab list is built at module load from
// the frozen tenant manifest, so a different tenant is only observable by re-importing the panel
// against a mocked feature set.
describe('a tenant without the wagers feature', () => {
  afterEach(() => {
    vi.doUnmock('../../config/tenant')
    vi.resetModules()
  })

  async function withoutWagers() {
    vi.resetModules()
    vi.doMock('../../config/tenant', async (importOriginal) => {
      const actual = await importOriginal()
      return { ...actual, isFeatureEnabled: (id) => id !== 'wagers' && actual.isFeatureEnabled(id) }
    })
    return (await import('../../components/wallet/PayTransferPanel')).default
  }

  it('gets no Wagers tab at all — absent, never present-and-broken', async () => {
    const Panel = await withoutWagers()
    render(
      <MemoryRouter initialEntries={['/wallet?tab=paytransfer']}>
        <Panel />
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Transfer', 'Bridge'])
  })

  it('falls a saved ?view=wagers link back to Transfer rather than an empty panel', async () => {
    const Panel = await withoutWagers()
    render(
      <MemoryRouter initialEntries={[WAGERS_PATH]}>
        <Panel />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('transfer-form')).toBeInTheDocument()
    expect(screen.queryByTestId('wagers-dashboard')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Transfer' })).toHaveAttribute('aria-selected', 'true')
  })
})
