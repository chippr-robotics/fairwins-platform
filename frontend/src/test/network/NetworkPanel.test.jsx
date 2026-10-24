import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { useSwitchChain } from 'wagmi'
import { setWalletChain } from '../helpers/walletChain'
import NetworkPanel from '../../components/account/NetworkPanel'
import {
  getEndpointSettings,
  saveEndpointSettings,
  __resetEndpointStoreForTests,
} from '../../lib/network/endpointStore'

// The network panel, reached from the account button beside Preferences (spec 069). wagmi
// hooks are mocked globally in test/setup.js; we override per-test for chain state.

// The Bitcoin card deep-links to the Bitcoin wallet surface (release 1.14.0, task 13) —
// mock the router hook so the panel renders without a Router and the destination is
// observable.
const navigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}))

describe('NetworkPanel — network selector', () => {
  const switchChain = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    setWalletChain(61) // unsupported chain → every network offers "Switch"
    useSwitchChain.mockReturnValue({
      switchChain,
      isPending: false,
      variables: undefined,
      error: null,
    })
  })

  it('lists the user-switchable networks', () => {
    render(<NetworkPanel />)
    expect(screen.getByText('Polygon')).toBeInTheDocument()
    expect(screen.getByText('Polygon Amoy')).toBeInTheDocument()
  })

  it('shows capability tags so members can make an informed switch', () => {
    render(<NetworkPanel />)
    // Each card renders the full capability set; assert the compliance + oracle tags.
    expect(screen.getAllByText('Sanctions Guard').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Polymarket Oracle').length).toBeGreaterThan(0)
    expect(screen.getAllByText('UMA Oracle').length).toBeGreaterThan(0)
  })

  it('marks Token Swap available on mainnet but not on the testnet', () => {
    render(<NetworkPanel />)
    const polygonCard = screen.getByText('Polygon').closest('.network-card')
    const amoyCard = screen.getByText('Polygon Amoy').closest('.network-card')

    const polygonSwap = within(polygonCard).getByText('Token Swap').closest('.network-tag')
    const amoySwap = within(amoyCard).getByText('Token Swap').closest('.network-tag')

    expect(polygonSwap).toHaveClass('available')
    expect(amoySwap).toHaveClass('unavailable')
  })

  it('marks the connected network instead of offering a switch button', () => {
    setWalletChain(137)
    render(<NetworkPanel />)
    const polygonCard = screen.getByText('Polygon').closest('.network-card')
    expect(within(polygonCard).getByText('Connected')).toBeInTheDocument()
    expect(within(polygonCard).queryByRole('button', { name: /Switch to Polygon/ })).toBeNull()
  })

  it('switches chains through wagmi when a switch button is clicked', () => {
    render(<NetworkPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Polygon Amoy' }))
    expect(switchChain).toHaveBeenCalledWith({ chainId: 80002 })
  })

  it('lists Mordor (Ethereum Classic) as a selectable testnet', () => {
    render(<NetworkPanel />)
    const card = screen.getByText('Ethereum Classic Mordor').closest('.network-card')
    expect(card).toBeInTheDocument()
    expect(within(card).getByText('Testnet')).toBeInTheDocument()
  })

  it('switches to Mordor (chainId 63) through wagmi', () => {
    render(<NetworkPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Ethereum Classic Mordor' }))
    expect(switchChain).toHaveBeenCalledWith({ chainId: 63 })
  })

  it('marks oracle + swap features unavailable on Mordor (no oracle adapters, no DEX configured)', () => {
    render(<NetworkPanel />)
    const card = screen.getByText('Ethereum Classic Mordor').closest('.network-card')
    expect(within(card).getByText('Polymarket Oracle').closest('.network-tag')).toHaveClass('unavailable')
    expect(within(card).getByText('Chainlink Oracle').closest('.network-tag')).toHaveClass('unavailable')
    expect(within(card).getByText('UMA Oracle').closest('.network-tag')).toHaveClass('unavailable')
    expect(within(card).getByText('Token Swap').closest('.network-tag')).toHaveClass('unavailable')
  })

  it('documents Mordor explorer and Classic USD stablecoin on the card', () => {
    render(<NetworkPanel />)
    const card = screen.getByText('Ethereum Classic Mordor').closest('.network-card')
    const explorer = within(card).getByRole('link', { name: 'Blockscout' })
    expect(explorer).toHaveAttribute('href', 'https://etc-mordor.blockscout.com')
    expect(explorer).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(within(card).getByText('Classic USD (USC)')).toBeInTheDocument()
  })

  // Spec 033 — the Network tab DEX link comes from the per-network dexProvider.
  it('lists Ethereum Classic (mainnet, chainId 61) as a selectable network', () => {
    render(<NetworkPanel />)
    const card = screen.getByText('Ethereum Classic').closest('.network-card')
    expect(card).toBeInTheDocument()
    expect(within(card).getByText('Mainnet')).toBeInTheDocument()
  })

  it('shows the ETCswap provider link on the Ethereum Classic card', () => {
    render(<NetworkPanel />)
    const card = screen.getByText('Ethereum Classic').closest('.network-card')
    const link = within(card).getByRole('link', { name: /Open ETCswap/ })
    expect(link).toHaveAttribute('href', 'https://v3.etcswap.org')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('shows the Uniswap provider link on the Polygon card', () => {
    render(<NetworkPanel />)
    const card = screen.getByText('Polygon').closest('.network-card')
    const link = within(card).getByRole('link', { name: /Open Uniswap/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('app.uniswap.org'))
  })

  // Spec 061 + release 1.14.0 task 13 — Bitcoin is a first-class network card, but a
  // non-EVM one (network-registry rule 2): there is still no wagmi chain switch. The
  // card for the app's CURRENT testnet/mainnet mode carries a "Use" action that
  // deep-links to the Bitcoin wallet surface (Transfer ▸ Send, where the BTC asset
  // lives); the other side of the pair stays display-only, so exactly one Bitcoin
  // network is ever offered (constitution III cohort rule).
  describe('Bitcoin network cards (spec 061, FR-020 + task 13)', () => {
    it('lists Bitcoin mainnet and its testnet pair, never with a wagmi switch affordance', () => {
      render(<NetworkPanel />)
      const mainnetCard = screen.getByText('Bitcoin').closest('.network-card')
      const testnetCard = screen.getByText('Bitcoin Testnet4').closest('.network-card')
      expect(mainnetCard).toBeInTheDocument()
      expect(within(mainnetCard).getByText('Mainnet')).toBeInTheDocument()
      expect(within(testnetCard).getByText('Testnet')).toBeInTheDocument()
      for (const card of [mainnetCard, testnetCard]) {
        expect(within(card).queryByRole('button', { name: /switch/i })).toBeNull()
      }
    })

    it('offers "Use Bitcoin" on the mainnet card while the app is in mainnet mode (wallet on 61)', () => {
      render(<NetworkPanel />)
      const mainnetCard = screen.getByText('Bitcoin').closest('.network-card')
      const testnetCard = screen.getByText('Bitcoin Testnet4').closest('.network-card')
      expect(within(mainnetCard).getByRole('button', { name: 'Use Bitcoin' })).toBeInTheDocument()
      // Exactly one Bitcoin network is offered — the pair's other side stays display-only.
      expect(within(testnetCard).queryByRole('button', { name: /Use Bitcoin/ })).toBeNull()
      expect(within(testnetCard).getByText('No wallet switch')).toBeInTheDocument()
    })

    it('offers the testnet card instead while the app is in testnet mode (wallet on 80002)', () => {
      setWalletChain(80002)
      render(<NetworkPanel />)
      const mainnetCard = screen.getByText('Bitcoin').closest('.network-card')
      const testnetCard = screen.getByText('Bitcoin Testnet4').closest('.network-card')
      expect(within(testnetCard).getByRole('button', { name: 'Use Bitcoin Testnet4' })).toBeInTheDocument()
      expect(within(mainnetCard).queryByRole('button', { name: /Use Bitcoin/ })).toBeNull()
      expect(within(mainnetCard).getByText('No wallet switch')).toBeInTheDocument()
    })

    it('activates Bitcoin by deep-linking to the wallet surface — never via wagmi switchChain', () => {
      render(<NetworkPanel />)
      const mainnetCard = screen.getByText('Bitcoin').closest('.network-card')
      fireEvent.click(within(mainnetCard).getByRole('button', { name: 'Use Bitcoin' }))
      // The Bitcoin surfaces activate per feature (send/receive/portfolio live behind
      // Transfer) — the app's EVM chain state is untouched and no string id can ever
      // reach the wagmi switch path.
      expect(navigate).toHaveBeenCalledWith('/wallet?tab=paytransfer')
      expect(switchChain).not.toHaveBeenCalled()
    })

    it('states supported capabilities truthfully: portfolio, send, receive, Stamps collectibles', () => {
      render(<NetworkPanel />)
      const card = screen.getByText('Bitcoin').closest('.network-card')
      for (const label of ['Portfolio', 'Send', 'Receive', 'Stamps collectibles']) {
        expect(within(card).getByText(label).closest('.network-tag')).toHaveClass('available')
      }
    })

    it('states unsupported capabilities truthfully: wagers, pools, membership, gasless, swap, earn, predict', () => {
      render(<NetworkPanel />)
      const card = screen.getByText('Bitcoin').closest('.network-card')
      for (const label of ['P2P Wagers', 'Wager Pools', 'Memberships', 'Gasless', 'Token Swap', 'Earn', 'Predict']) {
        expect(within(card).getByText(label).closest('.network-tag')).toHaveClass('unavailable')
      }
    })

    it('discloses the wallet requirement and that members pay the Bitcoin network fee', () => {
      render(<NetworkPanel />)
      const card = screen.getByText('Bitcoin').closest('.network-card')
      expect(within(card).getByText(/Requires a FairWins passkey on a PRF-capable device/)).toBeInTheDocument()
      expect(within(card).getByText(/always pay the Bitcoin network fee/)).toBeInTheDocument()
    })

    it('documents the mempool.space explorer on the Bitcoin card', () => {
      render(<NetworkPanel />)
      const card = screen.getByText('Bitcoin').closest('.network-card')
      const link = within(card).getByRole('link', { name: 'mempool.space' })
      expect(link).toHaveAttribute('href', 'https://mempool.space')
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    })

    it('never routes a Bitcoin row through wagmi switchChain', () => {
      render(<NetworkPanel />)
      // Clicking around the Bitcoin card can produce no switchChain call —
      // there is no button — and the EVM switch buttons never carry a
      // bitcoin id.
      expect(switchChain).not.toHaveBeenCalled()
      for (const btn of screen.getAllByRole('button', { name: /^Switch to / })) {
        expect(btn.getAttribute('aria-label')).not.toMatch(/Bitcoin/)
      }
    })
  })
})

// Spec 069 — the panel is where a member takes ownership of the route their reads use.
describe('NetworkPanel — member RPC endpoints (spec 069)', () => {
  const MEMBER_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/member-key'

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    __resetEndpointStoreForTests()
    setWalletChain(137)
    useSwitchChain.mockReturnValue({
      switchChain: vi.fn(),
      isPending: false,
      variables: undefined,
      error: null,
    })
  })

  const polygonCard = () => screen.getByText('Polygon').closest('.network-card')
  const openEditor = () => {
    fireEvent.click(within(polygonCard()).getByRole('button', { name: /Edit Polygon endpoints/ }))
    return polygonCard()
  }

  // Matched on the claim, not on its phrasing: the sentence was shortened once already, and what
  // must survive is that switching is framed as the exception rather than the routine.
  it('frames switching as optional because reads span every network', () => {
    render(<NetworkPanel />)
    expect(screen.getByText(/only need to switch when sending/i)).toBeInTheDocument()
  })

  it('shows which route a network is on before anything is configured', () => {
    render(<NetworkPanel />)
    expect(within(polygonCard()).getByText('App default')).toBeInTheDocument()
  })

  it('saves a member endpoint and reports it as theirs, redacted', () => {
    render(<NetworkPanel />)
    const card = openEditor()

    fireEvent.change(within(card).getByLabelText('RPC URL'), { target: { value: MEMBER_RPC } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))

    expect(getEndpointSettings(137)).toMatchObject({ url: MEMBER_RPC })
    expect(within(polygonCard()).getByText('Your endpoint')).toBeInTheDocument()
    // The API key lives in the URL path — the summary row must never print it.
    expect(within(polygonCard()).getByText('https://polygon-mainnet.g.alchemy.com/…')).toBeInTheDocument()
    expect(polygonCard().textContent).not.toContain('member-key')
  })

  it('refuses to save an endpoint that serves a different chain', async () => {
    render(<NetworkPanel />)
    const card = openEditor()
    fireEvent.change(within(card).getByLabelText('RPC URL'), { target: { value: MEMBER_RPC } })

    // Answer the eth_chainId probe with Ethereum mainnet while editing Polygon.
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: '0x1' }) })
    fireEvent.click(within(card).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByText(/serves chain 1, not chain 137/)).toBeInTheDocument())

    fireEvent.click(within(polygonCard()).getByRole('button', { name: 'Save' }))
    expect(getEndpointSettings(137)).toBeNull()
  })

  it('saves a self-hosted node on an arbitrary https host without complaint', () => {
    render(<NetworkPanel />)
    const card = openEditor()
    fireEvent.change(within(card).getByLabelText('RPC URL'), {
      target: { value: 'https://rpc.my-own-node.example/eth' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))

    expect(getEndpointSettings(137)).toMatchObject({ url: 'https://rpc.my-own-node.example/eth' })
    expect(within(polygonCard()).getByText('Your endpoint')).toBeInTheDocument()
  })

  it('accepts a local node over loopback http and states the local-node caveats', () => {
    render(<NetworkPanel />)
    const card = openEditor()
    fireEvent.change(within(card).getByLabelText('RPC URL'), {
      target: { value: 'http://localhost:8545' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))

    expect(getEndpointSettings(137)).toMatchObject({ url: 'http://localhost:8545' })
    expect(screen.getByText(/reachable only from this device/)).toBeInTheDocument()
    expect(screen.getByText(/CORS/)).toBeInTheDocument()
  })

  it('refuses a non-loopback http endpoint the browser would block anyway', () => {
    render(<NetworkPanel />)
    const card = openEditor()
    fireEvent.change(within(card).getByLabelText('RPC URL'), {
      target: { value: 'http://192.168.1.5:8545' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))

    expect(screen.getByText(/browsers block insecure http:\/\/ requests/)).toBeInTheDocument()
    expect(getEndpointSettings(137)).toBeNull()
  })

  it('blocks a WebSocket endpoint with a reason instead of saving it', () => {
    render(<NetworkPanel />)
    const card = openEditor()
    fireEvent.change(within(card).getByLabelText('RPC URL'), {
      target: { value: 'wss://polygon-mainnet.g.alchemy.com/v2/k' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))

    expect(screen.getByText(/must be an HTTP\(S\) endpoint/)).toBeInTheDocument()
    expect(getEndpointSettings(137)).toBeNull()
  })

  it('masks the API key field and only reveals it on request', () => {
    render(<NetworkPanel />)
    const card = openEditor()
    fireEvent.change(within(card).getByLabelText('RPC URL'), { target: { value: MEMBER_RPC } })
    fireEvent.change(within(card).getByLabelText('Authentication'), { target: { value: 'bearer' } })

    const key = within(polygonCard()).getByLabelText('Key')
    expect(key).toHaveAttribute('type', 'password')
    fireEvent.click(within(polygonCard()).getByRole('button', { name: 'Show' }))
    expect(within(polygonCard()).getByLabelText('Key')).toHaveAttribute('type', 'text')
  })

  it('resets a network back to the app default', () => {
    saveEndpointSettings(137, { url: MEMBER_RPC })
    render(<NetworkPanel />)
    const card = openEditor()

    fireEvent.click(within(card).getByRole('button', { name: 'Reset to default' }))
    expect(getEndpointSettings(137)).toBeNull()
    expect(within(polygonCard()).getByText('App default')).toBeInTheDocument()
  })

  it('says plainly that wallet transactions need a reload to use a new endpoint', () => {
    render(<NetworkPanel />)
    const card = openEditor()
    fireEvent.change(within(card).getByLabelText('RPC URL'), { target: { value: MEMBER_RPC } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))

    // Two disclosures, both honest: the save confirmation, and the panel-level banner.
    expect(screen.getByText(/Saved\. Reads use this route immediately/)).toBeInTheDocument()
    expect(
      screen.getByText(/Endpoint changes apply to new lookups right away/),
    ).toBeInTheDocument()
  })
})
