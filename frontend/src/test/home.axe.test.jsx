import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

// Spec 064: stub the asset-selector data hook so provider-light home panels render
// (the real UniversalAssetSelect component still renders, so a11y stays covered).
vi.mock('../hooks/useSelectableAssets', async () => await import('./helpers/selectableAssetsMock'))
vi.mock('../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ identity: { mode: 'personal' }, isVault: false, isLegacy: false }),
}))
vi.mock('../hooks/useBitcoinWallet', () => ({
  useBitcoinWallet: () => ({ status: 'idle', receive: { nextReceiveAddress: () => null } }),
}))
import { axe } from 'vitest-axe'
import { MemoryRouter } from 'react-router-dom'

// Accessibility (WCAG 2.1 AA) checks for the three-mode home surface —
// spec 058 FR-017/SC-008, constitution Principle V. The real PayPanel and
// RequestPanel render (their controls are the surface under audit); the
// wager create panel and modals are stubbed as in HomeScreen.test.jsx.

vi.mock('../components/fairwins/CreateChallengePanel', () => ({
  default: () => <div data-testid="create-panel" />,
}))
vi.mock('../components/fairwins/UnifiedLookupModal', () => ({ default: () => null }))
vi.mock('../components/fairwins/MyMarketsModal', () => ({ default: () => null }))
vi.mock('../components/fairwins/PolymarketTickerCrawler', () => ({
  default: () => <div>ticker</div>,
}))

vi.mock('../hooks', () => ({
  useWallet: () => ({ isConnected: true, address: '0x5555555555555555555555555555555555555555', chainId: 137, openConnectModal: vi.fn() }),
  useWalletConnection: () => ({ connectWallet: vi.fn() }),
}))
// HomeScreen mounts the FR-021 creation-moment DeviceLossWarning (issue #1405), which reads the
// session through usePasskeyAccount → useWallet — the useWalletManagement module, not the `hooks`
// barrel mocked above. This audit runs a classic session, so the warning renders nothing.
vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: () => ({
    address: '0x5555555555555555555555555555555555555555',
    chainId: 137,
    loginMethod: 'wallet',
    isConnected: true,
    provider: null,
  }),
}))
vi.mock('../hooks/useUI', () => ({
  useModal: () => ({ showModal: vi.fn(), hideModal: vi.fn() }),
  useNotification: () => ({ showNotification: vi.fn() }),
}))
vi.mock('../contexts/FriendMarketsContext.js', () => ({ useFriendMarkets: () => ({ friendMarkets: [] }) }))

const TOKENS = {
  chainId: 137, networkName: 'Polygon',
  native: 'POL', nativeName: 'Polygon', nativeDecimals: 18,
  stable: 'USDC', stableName: 'USD Coin',
  stableAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', stableDecimals: 6,
}
vi.mock('../hooks/useTransfer', () => ({
  useTransfer: () => ({
    status: 'idle', error: null, send: vi.fn(), quoteGasless: () => true,
    balanceOf: () => '100', refreshBalances: vi.fn(), tokens: TOKENS,
  }),
  TRANSFER_KIND: { NATIVE: 'native', STABLE: 'stable' },
}))
vi.mock('../hooks/useChainTokens', () => ({ useChainTokens: () => TOKENS }))
vi.mock('../hooks/useAddressScreening', () => ({
  useAddressScreening: () => ({ screenOne: vi.fn(async () => 'clear') }),
}))
vi.mock('wagmi', () => ({ useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }) }))
vi.mock('../components/ui/AddressInput', () => ({
  default: ({ id }) => <input id={id} aria-label="To" />,
}))
vi.mock('../components/ui/AddressBookButton', () => ({
  default: () => <button type="button" aria-label="Address book">book</button>,
}))
vi.mock('../components/ui/QRScanner', () => ({ default: () => null }))

const mediaHolder = { isMobile: false }
vi.mock('../hooks/useMediaQuery', () => ({ useIsMobile: () => mediaHolder.isMobile }))

import HomeScreen from '../components/fairwins/HomeScreen'
import RequestPanel from '../components/fairwins/RequestPanel'

const renderHome = () => render(<MemoryRouter initialEntries={['/app']}><HomeScreen /></MemoryRouter>)

describe('Home surface accessibility (spec 058)', () => {
  beforeEach(() => {
    localStorage.clear()
    mediaHolder.isMobile = false
  })

  it('Pay mode with the desktop switcher has no a11y violations', async () => {
    const { container } = renderHome()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('Request mode has no a11y violations', async () => {
    const { container } = renderHome()
    fireEvent.click(screen.getByRole('radio', { name: /request/i }))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('the mobile bottom bar exposes accessible names for the three glyph items (FR-017)', async () => {
    mediaHolder.isMobile = true
    const { container } = renderHome()
    const nav = within(screen.getByRole('navigation', { name: /home mode/i }))
    expect(nav.getByRole('button', { name: /^pay$/i })).toBeInTheDocument()
    expect(nav.getByRole('button', { name: /^request$/i })).toBeInTheDocument()
    expect(nav.getByRole('button', { name: /^wager$/i })).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('the generated request-QR view has no a11y violations', async () => {
    const { container } = render(<RequestPanel />)
    fireEvent.click(screen.getByRole('button', { name: '5' }))
    fireEvent.click(screen.getByRole('button', { name: /^request$/i }))
    expect(await screen.findByRole('img', { name: /payment request qr/i })).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })
})
