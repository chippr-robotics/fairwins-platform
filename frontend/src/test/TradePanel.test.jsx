import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// TradePanel is the brokerage-style order ticket for on-chain swaps. It must:
//  - list pairs from EVERY swap-capable network, not just the connected one, and
//    keep a pair on ONE network: choosing the pay leg pins the receive leg's
//    chain (lib/assets/networkPin.js#samePair — never the bridge's bridgeDest);
//  - quote a pair on its own network (getBestQuoteOn) even while the wallet sits
//    elsewhere, then require the network switch BEFORE the order can be placed;
//  - offer a search filter in both pair selectors — ~35 legs across six networks
//    is not a scrollable list;
//  - carry each leg's balance on its own pay/receive card;
//  - name/link the DEX provider for the PAIR's network (ETCswap on the ETC
//    family, Uniswap elsewhere) while subtly attributing the Uniswap V3 protocol
//    that powers routing (Spec 033 provider-awareness, preserved);
//  - present a professional trade read-out (rate, price impact, minimum
//    received, route);
//  - trade as whichever account the member is ACTING AS (personal wallet,
//    multisig vault, recovered legacy account) without offering its own account
//    picker — that choice is made app-wide from the wallet menu's acting-account
//    switcher, and the ticket only reads it (Spec 043/062);
//  - offer the price types Uniswap V3 actually supports (Market, and Limit as
//    immediate-or-cancel via amountOutMinimum) and gate perpetuals order types
//    (Sell Short / Buy to Cover) on a per-network perps venue — hidden where
//    none exists (honest-state).
// The DEX/wallet/account hooks are mocked so the component is exercised in
// isolation; the pair UNIVERSE deliberately comes from the real network config,
// because "which pairs exist" is exactly what this feature is about.

const {
  mockUseDex,
  mockUseWallet,
  mockUseChainTokens,
  mockUseActiveAccount,
  mockUseSwapBalances,
  switchChainAsync,
} = vi.hoisted(() => ({
  mockUseDex: vi.fn(),
  mockUseWallet: vi.fn(),
  mockUseChainTokens: vi.fn(),
  mockUseActiveAccount: vi.fn(),
  mockUseSwapBalances: vi.fn(),
  switchChainAsync: vi.fn().mockResolvedValue({}),
}))

vi.mock('../hooks/useDex', () => ({ useDex: mockUseDex }))
vi.mock('../hooks', () => ({ useWallet: mockUseWallet }))
vi.mock('../hooks/useChainTokens', () => ({ useChainTokens: mockUseChainTokens }))
vi.mock('../hooks/useActiveAccount', () => ({ useActiveAccount: mockUseActiveAccount }))
vi.mock('../hooks/useSwapBalances', () => ({ useSwapBalances: mockUseSwapBalances }))
vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync, isPending: false }),
}))

import TradePanel from '../components/fairwins/TradePanel'

// Real config addresses — the pair universe is built from networks.js itself.
const POLYGON = {
  WPOL: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  WBTC: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
  SWAP_ROUTER_02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
}
const BASE = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}
const ETC = {
  WETC: '0x1953cab0E5bFa6D4a9BaD6E05fD46C1CC6527a5a',
  USC: '0xDE093684c796204224BC081f937aa059D903c52a',
}

const SAMPLE_QUOTE = {
  chainId: 137,
  amountOut: '1.23',
  amountOutWei: 1230000n,
  feeTier: 3000,
  gasEstimate: 0n,
  executionPrice: '1.23',
  executionPriceInverted: '0.813008',
  minimumReceived: '1.22385',
  minimumReceivedWei: 1223850n,
  priceImpactPercent: 0.42,
  tokenInSymbol: 'WPOL',
  tokenOutSymbol: 'USDC',
}

function dexValue(overrides = {}) {
  return {
    loading: false,
    quotingPrice: false,
    wrapNative: vi.fn(),
    unwrapNative: vi.fn(),
    swap: vi.fn().mockResolvedValue({}),
    getBestQuoteOn: vi.fn().mockResolvedValue(SAMPLE_QUOTE),
    slippage: 50,
    setSlippage: vi.fn(),
    isDexAvailable: true,
    dexProvider: { name: 'ETCswap', url: 'https://v3.etcswap.org' },
    network: { name: 'Ethereum Classic', chainId: 61 },
    tradingAddress: '0x1111222233334444555566667777888899990000',
    ...overrides,
  }
}

const polygonDex = (overrides = {}) =>
  dexValue({
    dexProvider: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=polygon' },
    network: { name: 'Polygon', chainId: 137 },
    ...overrides,
  })

function personalAccount(overrides = {}) {
  return {
    identity: { mode: 'personal' },
    isVault: false,
    isLegacy: false,
    canActAsVault: false,
    submit: vi.fn(),
    operateAsPersonal: vi.fn(),
    operateAsVault: vi.fn(),
    ...overrides,
  }
}

/** The acting account is a multisig vault on `chainId` — the app-wide selection. */
const vaultAccount = (chainId = 137) =>
  personalAccount({
    identity: { mode: 'vault', vaultAddress: '0xVaultAAA', chainId, label: 'Ops Treasury' },
    isVault: true,
    canActAsVault: true,
  })

/** Balances keyed by lower-cased address, the shape useSwapBalances returns. */
const balancesFor = (entries) =>
  Object.fromEntries(Object.entries(entries).map(([addr, v]) => [addr.toLowerCase(), v]))

beforeEach(() => {
  vi.clearAllMocks()
  mockUseActiveAccount.mockReturnValue(personalAccount())
  mockUseSwapBalances.mockReturnValue({
    balances: balancesFor({
      [POLYGON.WPOL]: '5',
      [POLYGON.USDC]: '100',
      [POLYGON.WBTC]: '0.25',
      [BASE.WETH]: '2',
      [BASE.USDC]: '40',
      [ETC.WETC]: '5',
      [ETC.USC]: '100',
    }),
    loading: false,
    refresh: vi.fn(),
  })
})

/** Open a pair selector and return its listbox. */
function openSelector(name) {
  fireEvent.click(screen.getByRole('button', { name }))
  return screen.getByRole('listbox')
}

describe('TradePanel — provider identity & attribution', () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 61 })
    mockUseChainTokens.mockReturnValue({ native: 'ETC', stable: 'USC' })
  })

  it('names ETCswap and links to it for an ETC-family pair', () => {
    mockUseDex.mockReturnValue(dexValue())
    render(<TradePanel />)

    // Venue badge + subtitle name the DEX of the pair's network.
    expect(screen.getAllByText('ETCswap').length).toBeGreaterThan(0)
    expect(screen.getByText('ETCswap Router ↗')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Open ETCswap/ })
    expect(link).toHaveAttribute('href', 'https://v3.etcswap.org')
    // Subtle attribution still credits the underlying Uniswap V3 protocol.
    expect(screen.getByText(/Uniswap v3 protocol/i)).toBeInTheDocument()
  })

  it('names Uniswap and links to it for a Polygon pair', () => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 137 })
    mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    expect(screen.getByText('Uniswap Router ↗')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Open Uniswap/ })
    expect(link).toHaveAttribute('href', expect.stringContaining('app.uniswap.org'))
    expect(screen.getByText(/Powered by Uniswap v3/i)).toBeInTheDocument()
    // No ETCswap for a Polygon pair.
    expect(screen.queryByText(/ETCswap/)).toBeNull()
  })

  it('prompts to connect when the wallet is disconnected', () => {
    mockUseWallet.mockReturnValue({ isConnected: false, chainId: 61 })
    mockUseDex.mockReturnValue(dexValue())
    render(<TradePanel />)

    expect(screen.getByText(/Connect your wallet to start trading/)).toBeInTheDocument()
  })
})

describe('TradePanel — multi-network pair selection', () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 137 })
    mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
    mockUseDex.mockReturnValue(polygonDex())
  })

  it('lists pay-leg tokens from every supported network, named with their network', () => {
    render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    // The connected network's own legs…
    expect(within(sellList).getByRole('option', { name: 'WPOL on Polygon' })).toBeInTheDocument()
    expect(within(sellList).getByRole('option', { name: 'WBTC on Polygon' })).toBeInTheDocument()
    // …plus other networks', which the single-chain ticket could never show.
    expect(within(sellList).getByRole('option', { name: 'WETH on Base' })).toBeInTheDocument()
    expect(within(sellList).getByRole('option', { name: 'USDC on Optimism' })).toBeInTheDocument()
    expect(within(sellList).getByRole('option', { name: 'WETH on Arbitrum One' })).toBeInTheDocument()
    expect(within(sellList).getByRole('option', { name: 'WETC on Ethereum Classic' })).toBeInTheDocument()
    // Each option carries the shared asset artwork (glyph + network sub-badge).
    expect(
      within(sellList).getByRole('option', { name: 'WETH on Base' }).querySelector('.asset-logo'),
    ).toBeInTheDocument()
  })

  it('groups the list by network, connected network first', () => {
    render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    const headings = Array.from(sellList.querySelectorAll('.trade-token-group')).map((el) =>
      el.textContent.trim(),
    )
    expect(headings[0]).toBe('Polygon')
    expect(headings).toContain('Base')
    expect(headings).toContain('Ethereum Classic')
  })

  it('filters the list by token symbol, token name, or network name', () => {
    render(<TradePanel />)

    openSelector('Token to sell')
    const search = screen.getByLabelText('Search tokens')

    fireEvent.change(search, { target: { value: 'base' } })
    let list = screen.getByRole('listbox')
    expect(within(list).getByRole('option', { name: 'WETH on Base' })).toBeInTheDocument()
    expect(within(list).queryByRole('option', { name: 'WPOL on Polygon' })).toBeNull()

    fireEvent.change(search, { target: { value: 'wrapped btc' } })
    list = screen.getByRole('listbox')
    expect(within(list).getByRole('option', { name: 'WBTC on Polygon' })).toBeInTheDocument()
    expect(within(list).queryByRole('option', { name: 'WETH on Base' })).toBeNull()

    // A query that matches nothing says so, and names what can be searched.
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByText(/No token matches/)).toBeInTheDocument()
  })

  it('pins the receive leg to the pay leg’s network (one pool, one chain)', () => {
    render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    fireEvent.click(within(sellList).getByRole('option', { name: 'WETH on Base' }))

    // Picking Base moved the pair: the counterpart is Base's stablecoin.
    expect(screen.getByRole('button', { name: 'Token to sell' })).toHaveTextContent('WETH')
    expect(screen.getByRole('button', { name: 'Token to buy' })).toHaveTextContent('USDC')

    const buyList = openSelector('Token to buy')
    expect(within(buyList).getByRole('option', { name: 'USDC on Base' })).toBeInTheDocument()
    // Nothing off-network, and never the leg already being sold.
    expect(within(buyList).queryByRole('option', { name: 'USDC on Polygon' })).toBeNull()
    expect(within(buyList).queryByRole('option', { name: 'WETH on Base' })).toBeNull()
    expect(screen.getByText(/a pair lives on one network/i)).toBeInTheDocument()
  })

  it('quotes the pair on its own network, not the wallet’s', async () => {
    const getBestQuoteOn = vi.fn().mockResolvedValue({ ...SAMPLE_QUOTE, chainId: 8453 })
    mockUseDex.mockReturnValue(polygonDex({ getBestQuoteOn }))
    render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    fireEvent.click(within(sellList).getByRole('option', { name: 'WETH on Base' }))
    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })

    await waitFor(() =>
      expect(getBestQuoteOn).toHaveBeenCalledWith(8453, BASE.WETH, BASE.USDC, '1'),
    )
  })

  it('asks for the network switch before an off-network order, and never offers to place it', async () => {
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    fireEvent.click(within(sellList).getByRole('option', { name: 'WETH on Base' }))
    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })

    // Disclosed before any signature, with the switch as the only primary action.
    expect(screen.getByText(/This pair trades on Base and your wallet is on Polygon/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Swap / })).toBeNull()

    const switchBtn = screen.getByRole('button', { name: 'Switch to Base' })
    fireEvent.click(switchBtn)
    await waitFor(() => expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 8453 }))
  })

  it('keeps a cross-network pick when the wallet follows it to that network', async () => {
    const { rerender } = render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    fireEvent.click(within(sellList).getByRole('option', { name: 'WETH on Base' }))

    // The member switched networks; the pair they chose must survive it.
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 8453 })
    mockUseDex.mockReturnValue(polygonDex({ network: { name: 'Base', chainId: 8453 } }))
    rerender(<TradePanel />)

    expect(screen.getByRole('button', { name: 'Token to sell' })).toHaveTextContent('WETH')
    expect(screen.queryByText(/Switch to Base/)).toBeNull()
    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })
    expect(await screen.findByRole('button', { name: /Swap WETH for USDC/ })).toBeInTheDocument()
  })

  it('offers pairs from other networks when the connected chain has no DEX', () => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 63 })
    mockUseChainTokens.mockReturnValue({ native: 'ETC', stable: 'USC' })
    mockUseDex.mockReturnValue(
      dexValue({
        isDexAvailable: false,
        dexProvider: { name: 'ETCswap', url: 'https://etcswap.org' },
        network: { name: 'Ethereum Classic Mordor', chainId: 63 },
      }),
    )
    render(<TradePanel />)

    // Honest about the connected network without becoming a dead end.
    expect(
      screen.getByText(/Ethereum Classic Mordor has no DEX deployment/),
    ).toBeInTheDocument()
    const sellList = openSelector('Token to sell')
    expect(within(sellList).getByRole('option', { name: 'WPOL on Polygon' })).toBeInTheDocument()
    expect(within(sellList).queryByRole('option', { name: /on Ethereum Classic Mordor/ })).toBeNull()
  })
})

describe('TradePanel — balances live on the pair cards', () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({
      isConnected: true,
      chainId: 137,
      address: '0x1111222233334444555566667777888899990000',
    })
    mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
    mockUseDex.mockReturnValue(polygonDex())
  })

  it('shows each leg’s balance on its own card and nowhere else', () => {
    render(<TradePanel />)

    const balances = screen.getAllByText(/^Balance:/)
    expect(balances).toHaveLength(2)
    expect(balances[0].closest('.trade-leg')).toBeInTheDocument()
    // The old account-card read-outs are gone.
    expect(screen.queryByText(/Available to trade/)).toBeNull()
    expect(screen.queryByText(/Cash available/)).toBeNull()
  })

  it('reads balances for the PAIR’s network and account', () => {
    render(<TradePanel />)

    expect(mockUseSwapBalances).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 137,
        address: '0x1111222233334444555566667777888899990000',
        tokens: [
          { address: POLYGON.WPOL, decimals: 18 },
          { address: POLYGON.USDC, decimals: 6 },
        ],
      }),
    )
  })

  it('MAX fills the pay leg from its balance', () => {
    render(<TradePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'MAX' }))
    expect(screen.getByLabelText('You pay')).toHaveValue(5)
  })

  it('never renders an unread balance as zero', () => {
    mockUseSwapBalances.mockReturnValue({ balances: {}, loading: true, refresh: vi.fn() })
    render(<TradePanel />)

    expect(screen.getAllByLabelText('balance loading').length).toBe(2)
    expect(screen.getByRole('button', { name: 'MAX' })).toBeDisabled()
  })
})

describe('TradePanel — SDK-driven trade read-out', () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 137 })
    mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
  })

  it('quotes via getBestQuoteOn and surfaces rate, impact, minimum received and route', async () => {
    const getBestQuoteOn = vi.fn().mockResolvedValue(SAMPLE_QUOTE)
    mockUseDex.mockReturnValue(polygonDex({ getBestQuoteOn }))
    render(<TradePanel />)

    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })

    await waitFor(() =>
      expect(getBestQuoteOn).toHaveBeenCalledWith(137, POLYGON.WPOL, POLYGON.USDC, '1'),
    )

    // Best-execution output is shown on the receive leg.
    expect(await screen.findByText('1.23')).toBeInTheDocument()
    // Rate, price impact, minimum received, and the routed fee-tier pool.
    expect(screen.getByText(/1 WPOL = 1.23 USDC/)).toBeInTheDocument()
    expect(screen.getByText('0.42%')).toBeInTheDocument()
    // The minimum-received amount is wrapped in <SensitiveValue> for tilt-to-hide
    // (spec 047), so assert against the row that holds both amount and symbol.
    expect(screen.getByText('1.22385').closest('.trade-summary-val')).toHaveTextContent(/1.22385\s*USDC/)
    expect(screen.getByText('0.3% pool')).toBeInTheDocument()
    // The route names the network it runs on — with six networks listed, the
    // fee tier alone no longer identifies the pool.
    expect(screen.getByText('on Polygon')).toBeInTheDocument()
  })

  it('inverts the rate line when tapped', async () => {
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })
    const rate = await screen.findByText(/1 WPOL = 1.23 USDC/)
    fireEvent.click(rate)
    expect(screen.getByText(/1 USDC = 0.813008 WPOL/)).toBeInTheDocument()
  })

  it('executes the swap through the DEX swap(), pinned to the pair’s network', async () => {
    const swap = vi.fn().mockResolvedValue({})
    mockUseDex.mockReturnValue(polygonDex({ swap }))
    render(<TradePanel />)

    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })
    const execBtn = await screen.findByRole('button', { name: /Swap WPOL for USDC/ })
    fireEvent.click(execBtn)

    await waitFor(() =>
      expect(swap).toHaveBeenCalledWith(POLYGON.WPOL, POLYGON.USDC, '1', { chainId: 137 }),
    )
  })

  it('has no swap/wrap/unwrap mode selector', () => {
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    expect(screen.queryByRole('tablist', { name: 'Trade mode' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Wrap' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Unwrap' })).toBeNull()
  })
})

describe('TradePanel — acting account (spec 043/062)', () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({
      isConnected: true,
      chainId: 137,
      address: '0x1111222233334444555566667777888899990000',
    })
    mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
    mockUseDex.mockReturnValue(polygonDex())
  })

  // The ticket must not carry its own account picker: switching accounts is one
  // app-wide control (the wallet menu's acting-account switcher), so Trade behaves
  // like Pay/Transfer and a second, ticket-local selector can never disagree with it.
  it('offers no account picker of its own', () => {
    render(<TradePanel />)

    expect(screen.queryByLabelText('Account')).toBeNull()
    expect(document.querySelector('#trade-account-select')).toBeNull()
    expect(screen.queryByRole('option', { name: /Personal wallet/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Multisig$/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Recovered$/ })).toBeNull()
  })

  it('never switches the acting identity from the ticket', () => {
    const operateAsPersonal = vi.fn()
    const operateAsVault = vi.fn()
    mockUseActiveAccount.mockReturnValue(personalAccount({ operateAsPersonal, operateAsVault }))
    render(<TradePanel />)

    // Exercise the whole ticket — order type, pair, direction, amount.
    fireEvent.change(screen.getByLabelText(/Order Type/), { target: { value: 'buy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch direction' }))
    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })

    expect(operateAsPersonal).not.toHaveBeenCalled()
    expect(operateAsVault).not.toHaveBeenCalled()
  })

  it('reads the acting account from the app-wide identity: multisig proposal flow', () => {
    mockUseActiveAccount.mockReturnValue(vaultAccount(137))
    render(<TradePanel />)

    expect(screen.getByText('Multisig proposal')).toBeInTheDocument()
    expect(screen.getByText(/proposed to the multisig/)).toBeInTheDocument()
  })

  it('reads the acting account from the app-wide identity: recovered account', () => {
    mockUseActiveAccount.mockReturnValue(
      personalAccount({
        identity: { mode: 'legacy', address: '0xLegacyAAA', label: '0xLega…yAAA' },
        isLegacy: true,
      }),
    )
    render(<TradePanel />)

    expect(screen.getByText(/Orders sign with your recovered account/)).toBeInTheDocument()
    expect(screen.getByText('Network fee applies')).toBeInTheDocument()
  })

  it('says plainly that a multisig cannot trade a pair on another network', async () => {
    mockUseActiveAccount.mockReturnValue(vaultAccount(137))
    render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    fireEvent.click(within(sellList).getByRole('option', { name: 'WETH on Base' }))

    expect(screen.getByText(/This multisig lives on Polygon/)).toBeInTheDocument()
    // …and points at the one place accounts are switched, not a picker on the ticket.
    expect(screen.getByText(/switch accounts from your wallet menu/)).toBeInTheDocument()
  })
})

describe('TradePanel — order & price types', () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 137 })
    mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
  })

  it('keeps order type and pair direction in sync (Buy receives the network asset)', () => {
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    // Default direction WPOL → USDC reads as Sell.
    expect(screen.getByLabelText(/Order Type/).value).toBe('sell')

    fireEvent.change(screen.getByLabelText(/Order Type/), { target: { value: 'buy' } })
    // Buy pays the stablecoin to receive the wrapped-native asset.
    expect(screen.getByRole('button', { name: 'Token to sell' })).toHaveTextContent('USDC')
    expect(screen.getByRole('button', { name: 'Token to buy' })).toHaveTextContent('WPOL')

    // Flipping the pair back flips the order type too.
    fireEvent.click(screen.getByRole('button', { name: 'Switch direction' }))
    expect(screen.getByLabelText(/Order Type/).value).toBe('sell')
  })

  it('re-seeds Buy/Sell on the pair’s own network, never the wallet’s', () => {
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    const sellList = openSelector('Token to sell')
    fireEvent.click(within(sellList).getByRole('option', { name: 'WETH on Base' }))
    fireEvent.change(screen.getByLabelText(/Order Type/), { target: { value: 'buy' } })

    // Base's own USDC → WETH, and the pair is still a Base pair.
    expect(screen.getByRole('button', { name: 'Token to sell' })).toHaveTextContent('USDC')
    expect(screen.getByRole('button', { name: 'Token to buy' })).toHaveTextContent('WETH')
    expect(screen.getByRole('button', { name: 'Switch to Base' })).toBeInTheDocument()
  })

  it('offers Market and Limit price types and passes the limit floor to swap()', async () => {
    const swap = vi.fn().mockResolvedValue({})
    mockUseDex.mockReturnValue(polygonDex({ swap }))
    render(<TradePanel />)

    fireEvent.change(screen.getByLabelText(/Price Type/), { target: { value: 'limit' } })
    fireEvent.change(screen.getByLabelText(/Limit Price/), { target: { value: '1.3' } })
    fireEvent.change(screen.getByLabelText('You pay'), { target: { value: '1' } })

    // Limit orders are immediate-or-cancel — the term row says so honestly.
    expect(screen.getByText('Fill at limit or cancel')).toBeInTheDocument()

    const execBtn = await screen.findByRole('button', { name: /Place limit order/ })
    fireEvent.click(execBtn)

    // 1 × 1.3 at 6 stable decimals → 1300000n enforced as amountOutMinimum.
    await waitFor(() =>
      expect(swap).toHaveBeenCalledWith(POLYGON.WPOL, POLYGON.USDC, '1', {
        chainId: 137,
        limitMinOutWei: 1300000n,
      }),
    )
  })

  it('hides perpetuals order types on networks without a perps venue', () => {
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    expect(screen.queryByRole('option', { name: 'Sell Short' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Buy to Cover' })).toBeNull()
  })

  it('offers Sell Short / Buy to Cover only where the pair’s network has a perps venue', () => {
    mockUseDex.mockReturnValue(
      polygonDex({ network: { name: 'Polygon', chainId: 137, perps: { name: 'TestPerps' } } }),
    )
    render(<TradePanel />)

    expect(screen.getByRole('option', { name: 'Sell Short' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Buy to Cover' })).toBeInTheDocument()
  })
})

describe('TradePanel — session rails (passkey & gasless)', () => {
  beforeEach(() => {
    mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
  })

  it('shows the sponsored-gasless badge for passkey sessions on sponsored networks', () => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 137, loginMethod: 'passkey' })
    mockUseDex.mockReturnValue(
      polygonDex({
        network: {
          name: 'Polygon',
          chainId: 137,
          passkey: { sponsorPaymasterUrl: 'https://relay.example/v1/paymaster' },
        },
      }),
    )
    render(<TradePanel />)

    expect(screen.getByText(/Gasless · sponsored/)).toBeInTheDocument()
    expect(screen.getByText(/One passkey confirmation covers the whole order/)).toBeInTheDocument()
  })

  it('is honest when a passkey session cannot transact on the pair’s network', () => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 61, loginMethod: 'passkey' })
    mockUseDex.mockReturnValue(dexValue()) // network has no passkey rail
    render(<TradePanel />)

    expect(screen.getByText(/Passkey accounts can’t send transactions on Ethereum Classic yet/)).toBeInTheDocument()
    expect(screen.getByText('Network fee applies')).toBeInTheDocument()
  })

  it('shows the fee badge for classic wallet sessions', () => {
    mockUseWallet.mockReturnValue({ isConnected: true, chainId: 137 })
    mockUseDex.mockReturnValue(polygonDex())
    render(<TradePanel />)

    expect(screen.getByText('Network fee applies')).toBeInTheDocument()
  })
})
