import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Stub the heavy children to assert the HomeScreen wiring (not their internals).
vi.mock('../components/fairwins/CreateChallengePanel', () => ({
  default: ({ embedded, initialResolutionType, onDone, onOracleModeChange, isConnected, onConnect }) => (
    <div
      data-testid="create-panel"
      data-embedded={String(!!embedded)}
      data-initial-resolution={initialResolutionType ?? ''}
      data-connected={String(!!isConnected)}
    >
      <button type="button" onClick={() => onDone?.()}>done</button>
      <button type="button" onClick={() => onOracleModeChange?.(true)}>enter oracle mode</button>
      <button type="button" onClick={() => onConnect?.()}>panel connect</button>
    </div>
  ),
}))
// Stateful stubs for the new mode panels so draft retention across hidden
// mounts is observable (spec 058 FR-015).
vi.mock('../components/fairwins/PayPanel', async () => {
  const { useState } = await import('react')
  return {
    default: () => {
      const [draft, setDraft] = useState('')
      return (
        <div data-testid="pay-panel">
          <input aria-label="Pay draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
      )
    },
  }
})
vi.mock('../components/fairwins/RequestPanel', async () => {
  const { useState } = await import('react')
  return {
    default: () => {
      const [draft, setDraft] = useState('')
      return (
        <div data-testid="request-panel">
          <input aria-label="Request draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
      )
    },
  }
})
vi.mock('../components/fairwins/UnifiedLookupModal', () => ({
  default: ({ isOpen, initialPhrase, autoResolve }) => isOpen ? (
    <div data-testid="unified-modal" data-phrase={initialPhrase} data-auto={String(autoResolve)} />
  ) : null,
}))
vi.mock('../components/fairwins/MyMarketsModal', () => ({
  default: ({ isOpen }) => isOpen ? <div data-testid="my-wagers-modal" /> : null,
}))
vi.mock('../components/fairwins/PolymarketTickerCrawler', () => ({
  default: ({ onSelectMarket }) => (
    <button type="button" onClick={() => onSelectMarket?.()}>Ticker item</button>
  ),
}))

const walletHolder = { isConnected: true, connectWallet: vi.fn() }
vi.mock('../hooks', () => ({
  useWallet: () => ({ isConnected: walletHolder.isConnected, account: '0xabc' }),
  useWalletConnection: () => ({ connectWallet: walletHolder.connectWallet }),
}))
// The screen mounts the FR-021 creation-moment DeviceLossWarning (issue #1405), which reads the
// passkey session through usePasskeyAccount → useWallet (the useWalletManagement module, NOT the
// `hooks` barrel mocked above). A classic session renders nothing, which is what these tests want.
vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: () => ({
    address: '0xabc', chainId: 137, loginMethod: 'wallet', isConnected: true, provider: null,
  }),
}))
vi.mock('../hooks/useUI', () => ({ useModal: () => ({ showModal: vi.fn(), hideModal: vi.fn() }) }))
vi.mock('../contexts/FriendMarketsContext.js', () => ({ useFriendMarkets: () => ({ friendMarkets: [] }) }))

const mediaHolder = { isMobile: false }
vi.mock('../hooks/useMediaQuery', () => ({ useIsMobile: () => mediaHolder.isMobile }))

import HomeScreen from '../components/fairwins/HomeScreen'
import { OPEN_RESOLUTION_TYPES } from '../hooks/useOpenChallengeCreate'
import { setDefaultHomeMode } from '../utils/homePreference'

const renderHome = (entries = ['/app']) =>
  render(<MemoryRouter initialEntries={entries}><HomeScreen /></MemoryRouter>)

/** Switch the home surface via the desktop segmented switcher. */
const switchMode = (name) => fireEvent.click(screen.getByRole('radio', { name }))

const paySection = () => screen.getByTestId('pay-panel').closest('section')
const requestSection = () => screen.getByTestId('request-panel').closest('section')
const wagerSection = () => screen.getByTestId('create-panel').closest('section')

describe('HomeScreen (specs 053 + 058) — the three-mode money landing', () => {
  beforeEach(() => {
    localStorage.clear()
    mediaHolder.isMobile = false
    walletHolder.isConnected = true
    walletHolder.connectWallet = vi.fn()
  })

  describe('mode hosting (spec 058 foundational)', () => {
    it('opens on the Pay mode by default — Pay visible, Request and Wager mounted but hidden (FR-002/FR-015)', () => {
      renderHome()
      expect(paySection()).not.toHaveAttribute('hidden')
      expect(requestSection()).toHaveAttribute('hidden')
      expect(wagerSection()).toHaveAttribute('hidden')
    })

    it('opens in the mode saved in the device preference (US4)', () => {
      setDefaultHomeMode('wager')
      renderHome()
      expect(wagerSection()).not.toHaveAttribute('hidden')
      expect(paySection()).toHaveAttribute('hidden')
    })

    it('a live preference change moves the surface until the user picks a mode themselves', () => {
      renderHome()
      expect(paySection()).not.toHaveAttribute('hidden')
      act(() => { setDefaultHomeMode('request') })
      expect(requestSection()).not.toHaveAttribute('hidden')
      // The user now picks Wager by hand — a later preference change must not yank them off it.
      switchMode(/wager/i)
      act(() => { setDefaultHomeMode('pay') })
      expect(wagerSection()).not.toHaveAttribute('hidden')
    })

    it('renders the desktop segmented switcher with the three modes, and switches in place', () => {
      renderHome()
      expect(screen.getByRole('radio', { name: /pay/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /request/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /wager/i })).toBeInTheDocument()
      switchMode(/request/i)
      expect(requestSection()).not.toHaveAttribute('hidden')
      expect(paySection()).toHaveAttribute('hidden')
    })

    it('keeps each mode’s draft while switching — nothing lost, nothing leaked (FR-015)', () => {
      renderHome()
      fireEvent.change(screen.getByLabelText('Pay draft'), { target: { value: 'pay-42' } })
      switchMode(/wager/i)
      switchMode(/request/i)
      fireEvent.change(screen.getByLabelText('Request draft'), { target: { value: 'req-7' } })
      switchMode(/pay/i)
      expect(screen.getByLabelText('Pay draft')).toHaveValue('pay-42')
      expect(screen.getByLabelText('Request draft')).toHaveValue('req-7')
    })

    it('shows the wager extras (Accept / My Wagers / ticker) ONLY in wager mode (research R8)', () => {
      renderHome()
      expect(screen.queryByRole('button', { name: /accept a challenge/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /my wagers/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /ticker item/i })).toBeNull()
      switchMode(/wager/i)
      expect(screen.getByRole('button', { name: /accept a challenge/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /my wagers/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /ticker item/i })).toBeInTheDocument()
    })
  })

  describe('mobile bottom nav (spec 058 US3)', () => {
    beforeEach(() => { mediaHolder.isMobile = true })

    it('renders the three-glyph bottom bar with accessible names and the active mode marked', () => {
      renderHome()
      const nav = screen.getByRole('navigation', { name: /home mode/i })
      const buttons = ['Pay', 'Request', 'Wager'].map((name) =>
        screen.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }))
      expect(nav).toBeInTheDocument()
      expect(buttons).toHaveLength(3)
      expect(buttons[0]).toHaveAttribute('aria-current', 'page')
      expect(buttons[2]).not.toHaveAttribute('aria-current')
    })

    it('taps switch the mode in place and keep drafts', () => {
      renderHome()
      fireEvent.change(screen.getByLabelText('Pay draft'), { target: { value: 'kept' } })
      fireEvent.click(screen.getByRole('button', { name: /^wager$/i }))
      expect(wagerSection()).not.toHaveAttribute('hidden')
      expect(screen.getByRole('button', { name: /^wager$/i })).toHaveAttribute('aria-current', 'page')
      fireEvent.click(screen.getByRole('button', { name: /^pay$/i }))
      expect(screen.getByLabelText('Pay draft')).toHaveValue('kept')
    })

    it('does not render the desktop segmented switcher on mobile', () => {
      renderHome()
      expect(screen.queryByRole('radio', { name: /pay/i })).toBeNull()
    })
  })

  describe('wager mode — the spec-053 behavior, unchanged (FR-012)', () => {
    beforeEach(() => { setDefaultHomeMode('wager') })

    it('renders the inline create view as the wager mode content — no quick-action grid', () => {
      renderHome()
      expect(screen.getByTestId('create-panel')).toHaveAttribute('data-embedded', 'true')
      expect(screen.queryByText('Make an Offer')).toBeNull()
      expect(screen.queryByText('Group Pool')).toBeNull()
      expect(screen.queryByText('Open Oracle Challenge')).toBeNull()
    })

    it('Accept a challenge opens the unified phrase lookup', () => {
      renderHome()
      expect(screen.queryByTestId('unified-modal')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /accept a challenge/i }))
      expect(screen.getByTestId('unified-modal')).toBeInTheDocument()
    })

    it('My Wagers opens the My Wagers modal', () => {
      renderHome()
      expect(screen.queryByTestId('my-wagers-modal')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /my wagers/i }))
      expect(screen.getByTestId('my-wagers-modal')).toBeInTheDocument()
    })

    it('hides the secondary actions while the create panel is on its oracle path (design feedback)', () => {
      renderHome()
      expect(screen.getByRole('button', { name: /accept a challenge/i })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /enter oracle mode/i }))
      expect(screen.queryByRole('button', { name: /accept a challenge/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /my wagers/i })).toBeNull()
    })

    it('a ticker pick routes the create view into its oracle path', () => {
      renderHome()
      expect(screen.getByTestId('create-panel')).toHaveAttribute('data-initial-resolution', '')
      fireEvent.click(screen.getByRole('button', { name: /ticker item/i }))
      expect(screen.getByTestId('create-panel'))
        .toHaveAttribute('data-initial-resolution', String(OPEN_RESOLUTION_TYPES.Polymarket))
    })

    it('shows no connect banner when disconnected — the create panel handles connect in its own flow', () => {
      walletHolder.isConnected = false
      renderHome()
      const panel = screen.getByTestId('create-panel')
      expect(panel).toBeInTheDocument()
      expect(screen.queryByText(/connect your wallet to create/i)).toBeNull()
      expect(panel).toHaveAttribute('data-connected', 'false')
      fireEvent.click(screen.getByRole('button', { name: /panel connect/i }))
      expect(walletHolder.connectWallet).toHaveBeenCalled()
    })
  })

  describe('deep links land in wager mode regardless of the default (FR-012)', () => {
    it('a ?oc=take&code= deep link switches to wager and opens the unified lookup prefilled + auto-resolving', () => {
      renderHome(['/app?oc=take&code=river%20tiger%20kite%20zoo'])
      const modal = screen.getByTestId('unified-modal')
      expect(modal).toHaveAttribute('data-phrase', 'river tiger kite zoo')
      expect(modal).toHaveAttribute('data-auto', 'true')
      expect(wagerSection()).not.toHaveAttribute('hidden')
    })
  })
})
