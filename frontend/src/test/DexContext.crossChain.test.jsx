import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { setWalletChain } from './helpers/walletChain'
import { DexProvider } from '../contexts/DexContext.jsx'
import { useDex } from '../hooks/useDex'
import { NETWORKS } from '../config/networks'

// Multi-network trading splits the DEX layer in two:
//   READ  — `getBestQuoteOn(chainId, …)` prices a pair on ANY swap-capable
//           network, using THAT network's quoter over THAT network's provider.
//   WRITE — `swap()` still runs against the connected chain's router, so it must
//           refuse an order aimed at another network BEFORE any signature. That
//           guard is the reason the UI can safely list off-network pairs.

const { mockQuoteBestRoute, mockMakeReadProvider, sendCalls } = vi.hoisted(() => ({
  mockQuoteBestRoute: vi.fn().mockResolvedValue({ amountOut: '1.0', feeTier: 3000 }),
  mockMakeReadProvider: vi.fn(() => ({ tag: 'read-provider' })),
  sendCalls: vi.fn().mockResolvedValue({ state: 'confirmed' }),
}))

vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: () => ({
    provider: null,
    signer: null,
    address: '0x1111222233334444555566667777888899990000',
    isConnected: true,
    sendCalls,
  }),
}))
vi.mock('../lib/uniswap/quote', () => ({ quoteBestRoute: mockQuoteBestRoute }))
vi.mock('../utils/rpcProvider', () => ({ makeReadProvider: mockMakeReadProvider }))

const POLYGON_WMATIC = NETWORKS[137].dex.wnative
const POLYGON_USDC = NETWORKS[137].stablecoin.address
const BASE_WETH = NETWORKS[8453].dex.wnative
const BASE_USDC = NETWORKS[8453].stablecoin.address

let dex = null

function Probe() {
  dex = useDex()
  return <span data-testid="ready">{String(Boolean(dex.getBestQuoteOn))}</span>
}

function renderAt(chainId) {
  setWalletChain(chainId)
  return render(
    <DexProvider>
      <Probe />
    </DexProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockQuoteBestRoute.mockResolvedValue({ amountOut: '1.0', feeTier: 3000 })
  mockMakeReadProvider.mockReturnValue({ tag: 'read-provider' })
  dex = null
})

describe('DexContext — cross-chain quoting (the read half of multi-network trading)', () => {
  it('quotes another network with that network’s quoter, decimals and symbols', async () => {
    renderAt(137)
    await screen.findByTestId('ready')

    await dex.getBestQuoteOn(8453, BASE_WETH, BASE_USDC, '1')

    const args = mockQuoteBestRoute.mock.calls.at(-1)[0]
    expect(args.chainId).toBe(8453)
    // Base's own quoter, ON BASE. This used to assert that `makeReadProvider` had been called
    // with `NETWORKS[8453].rpcUrl` — which pinned a hand-built provider that spec 069 forbids in
    // as many words, so a member who had repointed Base was quoted through the build default
    // anyway. The quote is read through the endpoint seam now, and the quoter carries the chain
    // it will read on, so the claim is checked where it actually lives rather than inferred from
    // a constructor's arguments.
    expect(args.quoter.address).toBe(NETWORKS[8453].dex.quoter)
    expect(args.quoter.chainId).toBe(8453)
    expect(args.decimalsIn).toBe(18)
    expect(args.decimalsOut).toBe(6)
    expect(args.symbolIn).toBe('WETH')
    expect(args.symbolOut).toBe('USDC')
    expect(args.slippageBps).toBe(50)
  })

  it('quotes the connected network through the context’s own contracts', async () => {
    renderAt(137)
    await screen.findByTestId('ready')

    await dex.getBestQuote(POLYGON_WMATIC, POLYGON_USDC, '1')

    const args = mockQuoteBestRoute.mock.calls.at(-1)[0]
    expect(args.chainId).toBe(137)
    expect(args.symbolIn).toBe('WPOL')
    expect(args.symbolOut).toBe('USDC')
  })

  it('refuses to quote a network with no DEX instead of borrowing another’s router', async () => {
    renderAt(137)
    await screen.findByTestId('ready')

    await expect(dex.getBestQuoteOn(1337, POLYGON_WMATIC, POLYGON_USDC, '1')).rejects.toThrow(
      /not available/i,
    )
    expect(mockQuoteBestRoute).not.toHaveBeenCalled()
  })
})

describe('DexContext — a swap never runs on a network the wallet is not on', () => {
  it('refuses an order aimed at another chain, before any signature', async () => {
    renderAt(137)
    await screen.findByTestId('ready')

    await expect(
      dex.swap(BASE_WETH, BASE_USDC, '1', { chainId: 8453 }),
    ).rejects.toThrow(/trades on Base/)
    // Nothing was quoted, approved, or sent.
    expect(mockQuoteBestRoute).not.toHaveBeenCalled()
    expect(sendCalls).not.toHaveBeenCalled()
  })

  it('lets a same-chain order through the guard and on to a fresh quote', async () => {
    mockQuoteBestRoute.mockResolvedValue({
      amountOut: '1.0',
      amountOutWei: 1_000_000n,
      feeTier: 3000,
      minimumReceivedWei: 995_000n,
    })
    renderAt(137)
    await screen.findByTestId('ready')

    // The order proceeds past the chain guard: it re-quotes at execution time so
    // the on-chain minimum matches the freshest price. (Signing itself needs a
    // real wallet runner, which a unit test has no business standing up.)
    await dex.swap(POLYGON_WMATIC, POLYGON_USDC, '1', { chainId: 137 }).catch(() => {})
    await waitFor(() =>
      expect(mockQuoteBestRoute.mock.calls.at(-1)[0].chainId).toBe(137),
    )
  })
})
