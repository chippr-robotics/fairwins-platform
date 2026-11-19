/**
 * PositionSheet (spec 083, T034 + T040) — the exit surface, tested against US1 and US2.
 *
 * What these assert, and why each one is here rather than left to a reviewer's eye:
 *
 *   - the position renders the VENUE's figures, '—' where the venue reported nothing (never 0);
 *   - the cost breakdown appears BEFORE any signature, states the base honestly, and a zero rate
 *     produces no fee line anywhere;
 *   - an unreadable fee rate does not block the exit — the one rule most easily broken by copying
 *     the Earn sheet, which pauses deposits on exactly that condition;
 *   - inclusion is reported as "sent to the venue" and NEVER as closed; only the venue's execution
 *     event changes what the member is told they hold;
 *   - a venue rejection surfaces the venue's own words;
 *   - a stop beyond the liquidation price is refused before any wallet prompt (no send happens);
 *   - the calldata that actually reaches the wallet is the member's own close, at the trade index,
 *     in the venue's units.
 *
 * Nothing here touches a network: the trade hook's send rail, read provider, clock and sleep are
 * injected, and the fee read is a stub.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Interface } from 'ethers'

import { WalletContext } from '../../contexts/WalletContext'
import PositionSheet from '../../components/perps/PositionSheet'
import { buildExitDescriptor, buildProtectDescriptor } from '../../components/perps/positionSheetActions'
import sheetSource from '../../components/perps/PositionSheet.jsx?raw'
import actionsSource from '../../components/perps/positionSheetActions.js?raw'
import { GAINS_DIAMOND_ABI } from '../../abis/perps/gainsDiamond'
import { GAINS_DIAMOND_BY_CHAIN, GMX_ADDRESSES_BY_CHAIN } from '../../config/perps'
import { withGmxDerivedFigures } from '../../lib/perps/gmxDerived'
import { buildGmxMarketIndex } from '../../lib/perps/gmxMarkets'
import * as gains from '../../lib/perps/venues/gains'

const ARBITRUM = 42161
const MEMBER = '0xd504dC1ac094F45272f46b25A2874bDab45132Da'
const MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
/** Arbitrum WBTC.e — EIGHT decimals, which is the whole point of it being in this file. */
const WBTC = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'
const TX = `0x${'11'.repeat(32)}`

const diamond = new Interface(GAINS_DIAMOND_ABI)

/** The sheet's own source + its venue module, for the "nothing here can gate an exit" assertions. */
const src = `${sheetSource}\n${actionsSource}`

/* --------------------------------------------------------------------------------------------- *
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const wallet = { current: {} }

function gainsPosition(overrides = {}) {
  return {
    id: 'gains:42161:7',
    venue: 'gains',
    chainId: ARBITRUM,
    symbol: 'BTC/USD',
    direction: 'long',
    sizeUsd: 1000,
    collateralUsd: 100,
    entryPrice: 60_000,
    markPrice: 63_000,
    leverage: 10,
    liquidationPrice: 54_000,
    unrealizedPnlUsd: 50,
    venueRef: {
      venue: 'gains',
      chainId: ARBITRUM,
      tradeIndex: gains.tradeIndex(7),
      pairIndex: 1,
      collateralIndex: 3,
      collateralToken: USDC,
      collateralDecimals: 6,
      collateralPrecision: 1_000_000n,
    },
    ...overrides,
  }
}

function gmxPosition(overrides = {}) {
  return {
    id: 'gmx:42161:key',
    venue: 'gmx',
    chainId: ARBITRUM,
    symbol: null,
    direction: 'long',
    sizeUsd: 1000,
    collateralUsd: null,
    entryPrice: null,
    leverage: null,
    unrealizedPnlUsd: null,
    venueRef: {
      venue: 'gmx',
      chainId: ARBITRUM,
      positionKey: `0x${'ab'.repeat(32)}`,
      market: MARKET,
      collateralToken: USDC,
      isLong: true,
    },
    raw: { sizeInUsd: 1_000n * 10n ** 30n, collateralAmount: 100_000_000n },
    ...overrides,
  }
}

function gainsLog(name, args) {
  const encoded = diamond.encodeEventLog(diamond.getEvent(name), args)
  return { address: GAINS_DIAMOND_BY_CHAIN[ARBITRUM], topics: encoded.topics, data: encoded.data }
}

const MARKET_EXECUTED = () =>
  gainsLog('MarketExecuted', [
    [MEMBER, 4],
    MEMBER,
    7,
    [MEMBER, 7, 1, 10_000, true, true, 3, 0, 100_000_000n, 600_000_000_000_000n, 0, 0, false, 0, 0],
    false,
    63_000n * 10n ** 10n,
    63_000n * 10n ** 10n,
    54_000n * 10n ** 10n,
    [0n, 0n, 0n, 0n, 0n, 0n],
    0n,
    101_000_000n,
    10n ** 8n,
  ])

/** cancelReason 3 = SLIPPAGE — Gains' own mapped sentence. */
const MARKET_OPEN_CANCELED = () => gainsLog('MarketOpenCanceled', [[MEMBER, 4], MEMBER, 1, 3, 100_000_000n])

/** A classic-rail result: one awaited receipt per call. */
const receipt = (logs = []) => ({ route: 'direct', txHash: TX, receipts: [{ status: 1, hash: TX, blockNumber: 100, logs }] })

/** The watcher parks after its first poll, so a test sees the state the member sees. */
const parked = () => new Promise(() => {})

const idleChain = { getLogs: async () => [], getBlockNumber: async () => 100 }

/**
 * Render the sheet with every side effect injected. `deps` is created once per call because it
 * selects which trade hook runs — a changing identity would reorder hooks.
 */
function renderSheet({
  position = gainsPosition(),
  sendOnChain,
  readFee,
  readProtection,
  readQuote,
  sleep,
  tradeDeps,
  ...props
} = {}) {
  const send = sendOnChain ?? vi.fn(async () => receipt())
  const deps = {
    readFee: readFee ?? (async () => ({ bps: 5 })),
    // The venue re-read that confirms a DIRECT settlement. Unreadable by default, and the
    // confirmation's own clock parks — so a test that is not about the confirmation sees exactly
    // the state a member sees while it is still in flight, and touches no network to do it.
    readProtection: readProtection ?? (async () => ({ ok: false, reason: 'unreadable' })),
    // GMX's keeper-fee read, stubbed away by default. A GAINS position has no such fee, so the
    // real one returns null immediately and nothing changes for the suite above; a rendered GMX
    // position would otherwise reach for a provider, which is exactly what these tests do without.
    readQuote: readQuote ?? (async () => null),
    sleep: sleep ?? parked,
    trade: {
      sendOnChain: send,
      getProvider: () => idleChain,
      sleep: parked,
      now: () => 0,
      // Gate dependencies that FAIL the test if an exit ever reaches them.
      hasAttested: () => {
        throw new Error('an exit consulted the attestation')
      },
      screenAccount: () => {
        throw new Error('an exit consulted screening')
      },
      ...tradeDeps,
    },
  }
  const view = render(
    <WalletContext.Provider value={wallet.current}>
      <PositionSheet position={position} deps={deps} onClose={props.onClose ?? (() => {})} {...props} />
    </WalletContext.Provider>,
  )
  return { ...view, sendOnChain: send }
}

/** Flush the fee read (and any other queued microtask) so the breakdown has settled. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The value rendered for a fact, by its label. */
function factValue(label) {
  return screen.getByText(label, { selector: 'dt' }).parentElement.querySelector('dd')
}

beforeEach(() => {
  wallet.current = { address: MEMBER, chainId: ARBITRUM, loginMethod: 'wallet', signer: {}, sendCalls: vi.fn() }
})

/* --------------------------------------------------------------------------------------------- *
 * US1 acceptance 1 — the position, attributed to its venue
 * --------------------------------------------------------------------------------------------- */

describe('the position as the venue reports it', () => {
  it('shows size, entry, leverage, liquidation and P&L, with ONE primary close action', async () => {
    renderSheet()
    await settle()

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: /Long BTC\/USD/ })).toBeInTheDocument()
    expect(factValue('Size')).toHaveTextContent('$1,000.00')
    expect(factValue('Entry price')).toHaveTextContent('60,000.0')
    expect(factValue('Leverage')).toHaveTextContent('10×')
    expect(factValue('Liquidation price')).toHaveTextContent('54,000.0')
    expect(factValue('Unrealized P&L')).toHaveTextContent('+$50.00')
    expect(screen.getByRole('button', { name: 'Close this position' })).toBeEnabled()
  })

  it('renders a value the venue did not report as “—”, never as zero', async () => {
    renderSheet({
      position: gainsPosition({ sizeUsd: null, entryPrice: null, leverage: null, liquidationPrice: null, unrealizedPnlUsd: null }),
    })
    await settle()

    for (const label of ['Size', 'Entry price', 'Leverage', 'Liquidation price', 'Unrealized P&L']) {
      expect(factValue(label)).toHaveTextContent('—')
      expect(factValue(label)).not.toHaveTextContent('0')
    }
    // …and it says so, so a dash is never read as "nothing there".
    expect(screen.getByText(/did not report that value — it is not zero/)).toBeInTheDocument()
  })

  it('colours P&L with the financial semantics, in both directions', async () => {
    const { unmount } = renderSheet({ position: gainsPosition({ unrealizedPnlUsd: 50 }) })
    await settle()
    expect(factValue('Unrealized P&L')).toHaveClass('pps-pnl-up')
    unmount()

    renderSheet({ position: gainsPosition({ unrealizedPnlUsd: -50 }) })
    await settle()
    expect(factValue('Unrealized P&L')).toHaveClass('pps-pnl-down')
  })

  it('names the venue and always offers its own surface', async () => {
    renderSheet()
    await settle()
    expect(screen.getByText(/On Gains Network/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Manage on [^:]*: this position on Gains Network/ })).toHaveAttribute(
      'href',
      expect.stringContaining('gains.trade'),
    )
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US1 acceptance 1, the GMX half — a figure FairWins worked out is never presented as the venue's
 *
 * The visual review found this sheet rendering six blank figures on a GMX position, because GMX's
 * Reader returns raw venue units and no entry, leverage or P&L at all. Three of them are now
 * composed from the pairs feed (`lib/perps/gmxDerived.js`), which makes the attribution sentence
 * the thing under test: "every figure above is as GMX reports it" was true of six dashes and would
 * be a lie over our own arithmetic.
 * --------------------------------------------------------------------------------------------- */

describe('a GMX position, where some figures are FairWins’ own arithmetic', () => {
  /** The feed row for the position's market, in the shape `normalizeGmxPairs` publishes. */
  const GMX_PAIRS = [
    {
      id: `gmx:${ARBITRUM}:BTC/USD:${MARKET}`,
      venue: 'gmx',
      chainId: ARBITRUM,
      symbol: 'BTC/USD',
      base: 'BTC',
      quote: 'USD',
      variant: 'WBTC.e-USDC',
      price: 63_000,
      market: MARKET,
      collaterals: [
        { symbol: 'WBTC.e', address: WBTC, decimals: 8, usdPrice: 62_990 },
        { symbol: 'USDC', address: USDC, decimals: 6, usdPrice: 1 },
      ],
    },
  ]

  /** 0.02 BTC of a $1,000 long (so an entry of $50,000) backed by 100 USDC, marked at $63,000. */
  const derivedGmx = (over = {}) =>
    withGmxDerivedFigures(
      [
        gmxPosition({
          symbol: 'BTC/USD',
          raw: {
            sizeInUsd: 1_000n * 10n ** 30n,
            sizeInTokens: 2_000_000n, // 0.02 × 1e8 — WBTC is EIGHT decimals
            collateralAmount: 100_000_000n, // 100 × 1e6 — USDC is SIX
            isLong: true,
          },
          ...over,
        }),
      ],
      buildGmxMarketIndex(GMX_PAIRS),
    )[0]

  it('shows the figures GMX’s own numbers imply, each tagged as calculated', async () => {
    renderSheet({ position: derivedGmx(), markPrice: 63_000 })
    await settle()

    expect(factValue('Entry price')).toHaveTextContent('50,000.0')
    expect(factValue('Leverage')).toHaveTextContent('10×')
    // 0.02 × 63,000 − 1,000 = +$260.
    expect(factValue('Unrealized P&L')).toHaveTextContent('+$260.00')
    for (const label of ['Entry price', 'Leverage', 'Unrealized P&L']) {
      expect(factValue(label).querySelector('.pps-derived')).toHaveTextContent('calculated')
    }
    // The current price is the venue's own, so it carries no tag.
    expect(factValue('Current price').querySelector('.pps-derived')).toBeNull()
  })

  it('stops claiming every figure is the venue’s, and says the calculated P&L is not GMX’s settlement figure', async () => {
    renderSheet({ position: derivedGmx(), markPrice: 63_000 })
    await settle()

    expect(screen.queryByText(/Every figure above is as GMX reports it/)).toBeNull()
    expect(screen.getByText(/are not reported by GMX/)).toBeInTheDocument()
    expect(screen.getByText(/is not what GMX will settle at/)).toBeInTheDocument()
  })

  it('leaves the venue-reported sentence exactly as it was when nothing was calculated', async () => {
    renderSheet()
    await settle()
    expect(screen.getByText(/Every figure above is as Gains reports it/)).toBeInTheDocument()
    expect(document.querySelector('.pps-derived')).toBeNull()
  })

  it('explains WHY there is no liquidation price rather than leaving a bare dash', async () => {
    renderSheet({ position: derivedGmx(), markPrice: 63_000 })
    await settle()

    expect(factValue('Liquidation price')).toHaveTextContent('—')
    expect(factValue('Liquidation price').querySelector('.pps-derived')).toBeNull()
    expect(screen.getByText(/GMX does not publish a liquidation price/)).toBeInTheDocument()
    expect(screen.getByText(/Your position can still be liquidated/)).toBeInTheDocument()
  })

  it('can now estimate the proceeds, and says GMX’s own fee is not taken out of them', async () => {
    renderSheet({ position: derivedGmx(), markPrice: 63_000 })
    await settle()

    // $100 collateral + $260 P&L on a full close.
    expect(screen.getByText('Estimated proceeds').parentElement).toHaveTextContent('$360.00')
    expect(screen.getByText('GMX’s own fee').parentElement).toHaveTextContent('—')
    expect(screen.getByText(/own fee for this exit is not published to this app/)).toBeInTheDocument()
  })

  it('renders “—” with no tag at all on a market the feed does not list, and never a zero', async () => {
    const unlisted = withGmxDerivedFigures([gmxPosition()], buildGmxMarketIndex([]))[0]
    renderSheet({ position: unlisted, markPrice: null })
    await settle()

    for (const label of ['Entry price', 'Leverage', 'Liquidation price', 'Unrealized P&L']) {
      expect(factValue(label)).toHaveTextContent('—')
      expect(factValue(label)).not.toHaveTextContent('0')
    }
    expect(document.querySelector('.pps-derived')).toBeNull()
    expect(screen.getByText(/Every figure above is as GMX reports it/)).toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US1 acceptance 2 — the cost breakdown, before any signature
 * --------------------------------------------------------------------------------------------- */

describe('the cost breakdown before any signature', () => {
  it('shows proceeds, the venue’s fees and the FairWins fee, with the base stated honestly', async () => {
    const { sendOnChain } = renderSheet({ venueFeeUsd: 2.5, readFee: async () => ({ bps: 5 }) })
    await settle()

    expect(screen.getByText('Estimated proceeds').parentElement).toHaveTextContent('$150.00')
    expect(screen.getByText('Gains’s own fee').parentElement).toHaveTextContent('$2.50')
    // 5 bps of the $1,000 position = $0.50 — charged on SIZE, and the copy says exactly that.
    expect(screen.getByText(/FairWins fee \(0\.05% of size\)/).parentElement).toHaveTextContent('$0.50')
    expect(screen.getByText(/charged on the position’s size .* not\s+on the amount you put in/s)).toBeInTheDocument()
    // Disclosure comes before the signature, not after it.
    expect(sendOnChain).not.toHaveBeenCalled()
  })

  it('shows NO fee line at all at a zero rate', async () => {
    renderSheet({ readFee: async () => ({ bps: 0 }) })
    await settle()
    expect(screen.queryByText(/FairWins fee/)).not.toBeInTheDocument()
    expect(screen.queryByText(/of size/)).not.toBeInTheDocument()
  })

  it('renders the venue’s own fee as “—” rather than a fabricated zero', async () => {
    renderSheet()
    await settle()
    expect(screen.getByText('Gains’s own fee').parentElement).toHaveTextContent('—')
  })

  /* ------------------------------------------------------------------------------------------- *
   * The venue's own fee for the exit (spec 083)
   *
   * The rate comes from the pairs feed and the SHARE is chosen here, which is why the sheet is
   * handed a rate rather than an amount: a dollar figure passed in would be right for "all of it"
   * and wrong for every preset beside it.
   * ------------------------------------------------------------------------------------------- */

  const BTC_FEE = { openRate: 0.00035, closeRate: 0.00035, feeFloorNotionalUsd: 285.715, minFeeUsd: 0.10000025 }

  it('estimates the venue’s own closing fee from its published rate, and labels it', async () => {
    renderSheet({ venueFee: BTC_FEE })
    await settle()
    // Closing all of a $1,000 position: 0.035% = $0.35.
    expect(screen.getByText('Gains’s own fee (0.035% of size), estimated').parentElement).toHaveTextContent('$0.35')
    expect(screen.getByText(/rate Gains publishes for this market, not from a quote/)).toBeInTheDocument()
    // The one thing the estimate changes about the line above it, said either way.
    expect(screen.getByText(/estimated proceeds above do not have it taken out/)).toBeInTheDocument()
  })

  it('rescales the venue’s fee with the share the member actually picks', async () => {
    renderSheet({ venueFee: BTC_FEE })
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('50%'))
    })
    // Half of a $1,000 position is $500 — 0.035% of that ($0.175), not of the whole.
    expect(screen.getByText('Gains’s own fee (0.035% of size), estimated').parentElement).toHaveTextContent('$0.18')
    expect(screen.queryByText(/smallest fee size/)).not.toBeInTheDocument()
  })

  it('says when the venue’s fee floor is what is being charged on a small partial close', async () => {
    renderSheet({ venueFee: BTC_FEE })
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('25%'))
    })
    // $250 is below the $285.72 floor, so the venue charges the floor's fee — and says so.
    expect(screen.getByText(/below Gains’s smallest fee size/)).toBeInTheDocument()
    expect(screen.getByText(/Closing a larger share pays the same fee/)).toBeInTheDocument()
  })

  it('lets a caller’s real number win over the estimate, and drops the “estimated” label', async () => {
    renderSheet({ venueFee: BTC_FEE, venueFeeUsd: 2.5 })
    await settle()
    expect(screen.getByText('Gains’s own fee (0.035% of size)').parentElement).toHaveTextContent('$2.50')
  })

  it('NEVER blocks closing when the venue’s rate is absent — an exit depends on nothing here', async () => {
    const { sendOnChain } = renderSheet({ venueFee: null })
    await settle()
    expect(screen.getByText('Gains’s own fee').parentElement).toHaveTextContent('—')
    expect(screen.getByText(/own fee for this exit is not published to this app/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Close/i }))
    })
    await settle()
    expect(sendOnChain).toHaveBeenCalled()
  })

  it('NEVER blocks closing when the fee rate cannot be read', async () => {
    const { sendOnChain } = renderSheet({ readFee: async () => ({ failed: true }) })
    await settle()

    expect(screen.getByText(/fee rate could not be confirmed/)).toBeInTheDocument()
    expect(screen.getByText(/Closing is\s+not affected/s)).toBeInTheDocument()
    const close = screen.getByRole('button', { name: 'Close this position' })
    expect(close).toBeEnabled()
    await act(async () => {
      fireEvent.click(close)
    })
    expect(sendOnChain).toHaveBeenCalledTimes(1)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US1 acceptances 3–5 — the async lifecycle
 * --------------------------------------------------------------------------------------------- */

describe('the async lifecycle', () => {
  it('reports inclusion as SENT to the venue — never as closed', async () => {
    const onActionComplete = vi.fn()
    renderSheet({ onActionComplete })
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    })

    expect(screen.getByRole('status')).toHaveTextContent('Sent to Gains.')
    expect(screen.queryByText(/Position closed/)).not.toBeInTheDocument()
    expect(onActionComplete).not.toHaveBeenCalled()
  })

  it('reports closed ONLY once the venue’s execution event arrives', async () => {
    const onActionComplete = vi.fn()
    const sendOnChain = vi.fn(async () => receipt([MARKET_EXECUTED()]))
    renderSheet({ sendOnChain, onActionComplete })
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Position closed.'))
    expect(onActionComplete).toHaveBeenCalledTimes(1)
  })

  it('surfaces the venue’s own reason on a rejection, and leaves the position manageable', async () => {
    const sendOnChain = vi.fn(async () => receipt([MARKET_OPEN_CANCELED()]))
    renderSheet({ sendOnChain })
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    })

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('The price moved more than your slippage allowed.'),
    )
    // Still exitable — a refusal by the venue is not the end of the member's options.
    expect(screen.getByRole('button', { name: 'Close this position' })).toBeEnabled()
    expect(screen.getByRole('link', { name: /Manage on [^:]*: this position on Gains Network/ })).toBeInTheDocument()
  })

  it('refuses with a plain reason, before any wallet prompt, when the venue handle is missing', async () => {
    const position = gainsPosition({ venueRef: { venue: 'gains', chainId: ARBITRUM, tradeIndex: null } })
    const { sendOnChain } = renderSheet({ position })
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    })

    expect(sendOnChain).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/handle for this position could not be read/)
    expect(screen.getByRole('alert')).toHaveTextContent(/close it on Gains/)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US1 — close and reduce, down to the calldata the wallet is handed
 * --------------------------------------------------------------------------------------------- */

describe('the calldata the member is asked to sign', () => {
  /** The single Gains diamond call the sheet sent. */
  function sentCall(sendOnChain) {
    expect(sendOnChain).toHaveBeenCalledTimes(1)
    const [chainId, calls] = sendOnChain.mock.calls[0]
    expect(chainId).toBe(ARBITRUM)
    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe(GAINS_DIAMOND_BY_CHAIN[ARBITRUM])
    return calls[0]
  }

  it('a full close is closeTradeMarket at the TRADE index, at the venue’s price scale', async () => {
    const { sendOnChain } = renderSheet()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    })

    // The default 1% closing tolerance rides along in one diamond multicall, as the venue's SDK does.
    const [inner] = diamond.decodeFunctionData('multicall', sentCall(sendOnChain).data)
    const parsed = inner.map((data) => diamond.parseTransaction({ data }))
    expect(parsed.map((p) => p.name)).toEqual(['updateMaxClosingSlippageP', 'closeTradeMarket'])
    expect(parsed[1].args[0]).toBe(7n)
    expect(parsed[1].args[1]).toBe(63_000n * 10n ** 10n)
  })

  it('a 25% reduce is decreasePositionSize for a quarter of the position', async () => {
    const { sendOnChain } = renderSheet()
    await settle()

    fireEvent.click(screen.getByLabelText('25%'))
    expect(screen.getByRole('button', { name: 'Close 25% of this position' })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close 25% of this position' }))
    })

    const parsed = diamond.parseTransaction({ data: sentCall(sendOnChain).data })
    expect(parsed.name).toBe('decreasePositionSize')
    expect(parsed.args[0]).toBe(7n) // the TRADE index
    expect(parsed.args[1]).toBe(0n) // collateral stays in the position
    expect(parsed.args[2]).toBe(2_500n) // a quarter of 10× leverage, 1e3-scaled
    // …and the sheet says so rather than letting the member discover it afterwards.
    expect(screen.getByText(/Your collateral stays in the\s+position/s)).toBeInTheDocument()
  })

  it('closes ALL of it by default — the ordinary exit is one tap', async () => {
    renderSheet()
    await settle()
    expect(screen.getByLabelText('All of it')).toBeChecked()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US2 — protection
 * --------------------------------------------------------------------------------------------- */

describe('protection (US2)', () => {
  it('pre-fills a stop and a target from the position’s own risk, and shows the money impact', async () => {
    renderSheet()
    await settle()

    // suggestProtection: half the distance from the mark (63,000) to liquidation (54,000).
    expect(screen.getByLabelText('Stop-loss price')).toHaveValue('58500')
    expect(screen.getByLabelText('Take-profit price')).toHaveValue('72000')
    expect(screen.getByText(/At 58,500.0, about −\$25\.00 — estimated/)).toBeInTheDocument()
    expect(screen.getByText(/At 72,000.0, about \+\$200\.00 — estimated/)).toBeInTheDocument()
  })

  it('reflects the venue’s STORED levels over any suggestion', async () => {
    renderSheet({ protection: { stopLoss: 57_000, takeProfit: 70_000 } })
    await settle()
    expect(screen.getByLabelText('Stop-loss price')).toHaveValue('57000')
    expect(screen.getByLabelText('Take-profit price')).toHaveValue('70000')
  })

  it('REFUSES a stop beyond the liquidation price before any wallet prompt', async () => {
    const { sendOnChain } = renderSheet()
    await settle()

    fireEvent.change(screen.getByLabelText('Stop-loss price'), { target: { value: '50000' } })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/liquidation price/)
    expect(alert).toHaveTextContent(/liquidated before the stop could close it/)
    const save = screen.getByRole('button', { name: 'Save protection' })
    expect(save).toBeDisabled()
    await act(async () => {
      fireEvent.click(save)
    })
    expect(sendOnChain).not.toHaveBeenCalled()
  })

  it('refuses a stop on the wrong side of the market, too', async () => {
    renderSheet()
    await settle()
    fireEvent.change(screen.getByLabelText('Stop-loss price'), { target: { value: '70000' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/has to sit below the current price/)
  })

  it('saves the stop FIRST, then the target, in the venue’s own units', async () => {
    const { sendOnChain } = renderSheet()
    await settle()

    fireEvent.change(screen.getByLabelText('Stop-loss price'), { target: { value: '59000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save protection' }))
    })

    const [, calls] = sendOnChain.mock.calls[0]
    const parsed = calls.map((call) => diamond.parseTransaction({ data: call.data }))
    // The protective leg first: a member who abandons the second signature keeps the stop.
    expect(parsed.map((p) => p.name)).toEqual(['updateSl', 'updateTp'])
    expect(parsed[0].args[0]).toBe(7n)
    expect(parsed[0].args[1]).toBe(59_000n * 10n ** 10n)
    expect(parsed[1].args[1]).toBe(72_000n * 10n ** 10n)
  })

  it('removing a level sends the venue’s own “no stop” (zero), not an absent field', async () => {
    const { sendOnChain } = renderSheet({ protection: { stopLoss: 57_000, takeProfit: 70_000 } })
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Remove stop-loss' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save protection' }))
    })

    const [, calls] = sendOnChain.mock.calls[0]
    const parsed = calls.map((call) => diamond.parseTransaction({ data: call.data }))
    expect(parsed.map((p) => p.name)).toEqual(['updateSl'])
    expect(parsed[0].args[1]).toBe(0n)
  })

  it('does not ask for a signature when nothing changed', async () => {
    const { sendOnChain } = renderSheet({ protection: { stopLoss: 57_000, takeProfit: 70_000 } })
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save protection' }))
    })
    expect(sendOnChain).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/already the levels the venue has stored/)
  })

  it('reports protection as UPDATED only when the venue has recorded it', async () => {
    renderSheet()
    await settle()

    fireEvent.change(screen.getByLabelText('Stop-loss price'), { target: { value: '59000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save protection' }))
    })

    // Gains applies tp/sl inside the member's own transaction and emits no order event, so the
    // machine stops at "sent" while the venue is re-read — inclusion alone never claims success.
    expect(screen.getByRole('status')).toHaveTextContent('Sent to Gains.')
    expect(screen.queryByText('Protection updated.')).not.toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US2 acceptance 3 — the sheet reflects the VENUE's stored values, not the requested ones
 *
 * A Gains protect settles inside the member's own transaction and emits no order event, so there is
 * nothing to watch: the confirmation is a re-read of the diamond. Before it existed the machine
 * rested at "Sent to Gains" for ever, `onActionComplete` never fired, and the fields kept showing
 * the number the member typed as though the venue had agreed to it.
 * --------------------------------------------------------------------------------------------- */

describe('confirming a Gains protection change from the venue (US2 acceptance 3)', () => {
  /** The venue's stored levels, in the shape `readStoredProtection` publishes. */
  const storedLevels = (stopLoss, takeProfit) => ({
    ok: true,
    stored: {
      stopLoss,
      takeProfit,
      sl: stopLoss === null ? 0n : BigInt(stopLoss) * 10n ** 10n,
      tp: takeProfit === null ? 0n : BigInt(takeProfit) * 10n ** 10n,
    },
  })

  /** Answers each read from a script, then repeats the last answer for ever. */
  function venueReads(...answers) {
    const readProtection = vi.fn(async () => answers[Math.min(readProtection.mock.calls.length - 1, answers.length - 1)])
    return readProtection
  }

  it('pre-fills from what the venue HOLDS, ahead of any suggestion', async () => {
    renderSheet({ readProtection: venueReads(storedLevels(57_000, 70_000)) })
    await settle()
    // Not 58,500 / 72,000, which is what `suggestProtection` would have offered.
    expect(screen.getByLabelText('Stop-loss price')).toHaveValue('57000')
    expect(screen.getByLabelText('Take-profit price')).toHaveValue('70000')
  })

  it('shows the level GAINS STORED when it differs from the one requested, and says so', async () => {
    // The venue rounded 59,000 to its own price step. The member asked for one number and holds
    // another: showing the requested one would tell them they have protection they do not have.
    const readProtection = venueReads(storedLevels(57_000, 70_000), storedLevels(59_050, 70_000))
    const onActionComplete = vi.fn()
    renderSheet({ readProtection, sleep: async () => {}, onActionComplete })
    await settle()

    fireEvent.change(screen.getByLabelText('Stop-loss price'), { target: { value: '59000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save protection' }))
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Protection updated.'))

    // The field carries the VENUE's number, not the member's.
    expect(screen.getByLabelText('Stop-loss price')).toHaveValue('59050')
    const note = screen.getByText(/Gains stored a stop-loss of 59,050/)
    expect(note).toHaveTextContent('not the 59,000.0 you asked for')
    // …and the position is re-read once, off the venue's own confirmation.
    expect(onActionComplete).toHaveBeenCalledTimes(1)
  })

  it('confirms a level the venue stored exactly as asked, without inventing a discrepancy', async () => {
    const readProtection = venueReads(storedLevels(57_000, 70_000), storedLevels(59_000, 70_000))
    renderSheet({ readProtection, sleep: async () => {} })
    await settle()

    fireEvent.change(screen.getByLabelText('Stop-loss price'), { target: { value: '59000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save protection' }))
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Protection updated.'))

    expect(screen.getByText('Gains has stored a stop-loss of 59,000.0.')).toBeInTheDocument()
    expect(screen.queryByText(/you asked for/)).not.toBeInTheDocument()
  })

  it('a venue that never reports the change ends in "we can’t confirm", never in success', async () => {
    // The read is bounded. When the bound is spent the machine lands in `unknown` — not a claim
    // that it worked, not a claim that it failed, and never a spinner with no end.
    const readProtection = venueReads(storedLevels(57_000, 70_000))
    const onActionComplete = vi.fn()
    renderSheet({ readProtection, sleep: async () => {}, onActionComplete })
    await settle()

    fireEvent.change(screen.getByLabelText('Stop-loss price'), { target: { value: '59000' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save protection' }))
    })

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('We can’t confirm this — check on Gains.'),
    )
    expect(screen.queryByText('Protection updated.')).not.toBeInTheDocument()
    expect(onActionComplete).not.toHaveBeenCalled()
    // The way through is named, and it is the venue's own surface.
    expect(screen.getByText(/could not confirm what Gains stored/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Manage on [^:]*: this position on Gains Network/ })).toBeInTheDocument()
    // The controls come back — a confirmation we lost must not leave the sheet frozen.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save protection' })).toBeEnabled())
  })

  it('does not re-read the venue for a CLOSE — only a direct settlement is confirmed this way', async () => {
    // A close is keeper-settled: the venue's own execution event is the only thing that may report
    // it, and a re-read minting an execution there is exactly what rule 2 forbids.
    const readProtection = venueReads(storedLevels(57_000, 70_000))
    renderSheet({ readProtection, sleep: async () => {} })
    await settle()
    const before = readProtection.mock.calls.length

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    })
    await settle()

    expect(readProtection.mock.calls.length).toBe(before)
    expect(screen.getByRole('status')).toHaveTextContent('Sent to Gains.')
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Exits are never gated (SC-004)
 * --------------------------------------------------------------------------------------------- */

describe('nothing on this sheet can gate an exit', () => {
  it('does not import the attestation, the kill switch, or the open-permission question', () => {
    expect(src).not.toMatch(/from\s+['"].*perps\/attestation['"]/)
    expect(src).not.toMatch(/hasAttested|PERPS_ATTESTATION/)
    expect(src).not.toMatch(/perpsManageFeatureEnabled|VITE_PERPS_MANAGE_ENABLED/)
    expect(src).not.toMatch(/\bcanOpen\b|openBlockedNote/)
    expect(src).not.toMatch(/screenAccount|useAddressScreening/)
  })

  it('closes with the gate dependencies wired to throw if they are ever consulted', async () => {
    // `renderSheet` injects gates that throw. An exit that reached them would fail this test.
    const { sendOnChain } = renderSheet()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    })
    expect(sendOnChain).toHaveBeenCalledTimes(1)
  })

  it('offers the exit even when the venue itself is paused, with the venue’s warning shown', async () => {
    const { sendOnChain } = renderSheet({ venueStatus: 'paused' })
    await settle()
    expect(screen.getByText(/paused trading, so it may refuse this until it resumes/)).toBeInTheDocument()
    const close = screen.getByRole('button', { name: 'Close this position' })
    expect(close).toBeEnabled()
    await act(async () => {
      fireEvent.click(close)
    })
    expect(sendOnChain).toHaveBeenCalledTimes(1)
  })

  it('says nothing about a venue status nobody supplied', async () => {
    renderSheet()
    await settle()
    expect(screen.queryByText(/may refuse this right now/)).not.toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The sheet shell
 * --------------------------------------------------------------------------------------------- */

describe('the bottom-sheet shell', () => {
  it('closes on Escape and on the backdrop, and restores focus', async () => {
    const onClose = vi.fn()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const { unmount } = renderSheet({ onClose })
    await settle()
    expect(document.body.style.overflow).toBe('hidden')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this position panel' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    unmount()
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('names the dismiss control something a member cannot confuse with closing the position', async () => {
    renderSheet()
    await settle()
    // Two controls a tap apart both called "Close" is the ambiguity this avoids.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('does NOT lock the page when it is mounted with nothing to show', async () => {
    // The sheet renders null without a position. Locking `body { overflow: hidden }` there would
    // leave the page unscrollable with no visible sheet to dismiss — a leak with no way out.
    const { unmount } = renderSheet({ position: null })
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.style.overflow).toBe('')
    unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('keeps the focus it must return to across a re-render of the parent', async () => {
    // This sheet lives inside a view that re-renders on a 30s market poll and a 60s position poll.
    // A shell effect keyed on a caller's inline `onClose` would re-run on each one, re-record the
    // element to restore to (by then the sheet itself), and yank a member out of the field they
    // were typing in. The shell is mount-scoped precisely so this cannot happen.
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const { rerender, unmount } = renderSheet({ onClose: () => {} })
    await settle()

    const stop = screen.getByLabelText('Stop-loss price')
    stop.focus()
    expect(document.activeElement).toBe(stop)

    // A parent re-render handing down a FRESH onClose identity, as an inline arrow would.
    rerender(
      <WalletContext.Provider value={wallet.current}>
        <PositionSheet
          position={gainsPosition()}
          onClose={() => {}}
          deps={{ readFee: async () => ({ bps: 5 }), trade: { sendOnChain: vi.fn(), getProvider: () => idleChain, sleep: parked, now: () => 0 } }}
        />
      </WalletContext.Provider>,
    )
    await settle()
    // The member is still where they were, not thrown back to the top of the sheet.
    expect(document.activeElement).toBe(stop)

    unmount()
    expect(document.activeElement).toBe(trigger)
    expect(document.body.style.overflow).toBe('')
    trigger.remove()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The descriptor builders, directly
 * --------------------------------------------------------------------------------------------- */

describe('buildExitDescriptor / buildProtectDescriptor', () => {
  it('is total: junk in yields a refusal with a member-facing reason, never a throw', () => {
    for (const input of [null, undefined, {}, { position: null }, { position: { venue: 'nope', chainId: 1 } }]) {
      const built = buildExitDescriptor(input)
      expect(built.ok).toBe(false)
      expect(typeof built.reason).toBe('string')
      const protect = buildProtectDescriptor(input)
      expect(protect.ok).toBe(false)
      expect(typeof protect.reason).toBe('string')
    }
  })

  it('refuses a Gains close it cannot price rather than sending a bound of zero', () => {
    const built = buildExitDescriptor({ position: gainsPosition(), markPrice: null })
    expect(built.ok).toBe(false)
    expect(built.reason).toMatch(/current price/)
  })

  it('carries the FairWins fee receiver into GMX calldata as uiFeeReceiver and NOWHERE else', () => {
    const built = buildExitDescriptor({
      position: gmxPosition(),
      markPrice: 63_000,
      quote: { executionFee: 1_500_000_000_000_000n },
      uiFeeReceiver: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
    })
    expect(built.ok).toBe(true)
    expect(built.descriptor.params.uiFeeReceiver).toBe('0x52502d049571C7893447b86c4d8B38e6184bF6e1')
    // There is no ownership field here to fill — the builder writes the member into both.
    expect(Object.keys(built.descriptor.params)).not.toContain('receiver')
    expect(Object.keys(built.descriptor.params)).not.toContain('cancellationReceiver')
    expect(built.descriptor.params.market).toBe(MARKET)
    expect(GMX_ADDRESSES_BY_CHAIN[ARBITRUM].exchangeRouter).toBeTruthy()
  })

  it('reduces GMX by the share asked for, in the venue’s 1e30 units', () => {
    const built = buildExitDescriptor({
      position: gmxPosition(),
      percent: 25,
      markPrice: 63_000,
      quote: { executionFee: 1_500_000_000_000_000n },
    })
    expect(built.ok).toBe(true)
    expect(built.descriptor.action).toBe('reduce')
    expect(built.descriptor.params.sizeDeltaUsd).toBe(250n * 10n ** 30n)
    expect(built.descriptor.params.collateralAmount).toBe(25_000_000n)
  })

  it('bounds a SHORT decrease above the market and a LONG decrease below it', () => {
    const long = buildExitDescriptor({
      position: gmxPosition(),
      markPrice: 100,
      quote: { executionFee: 1n },
    })
    const short = buildExitDescriptor({
      position: gmxPosition({ direction: 'short', venueRef: { ...gmxPosition().venueRef, isLong: false } }),
      markPrice: 100,
      quote: { executionFee: 1n },
    })
    // 0 is a safe "any price" for a long decrease and an order that can never fill for a short —
    // which is why the bound is computed from the direction rather than defaulted.
    expect(long.descriptor.params.acceptablePrice).toBeLessThan(100)
    expect(short.descriptor.params.acceptablePrice).toBeGreaterThan(100)
  })

  it('refuses a GMX exit it has no keeper fee for, naming GMX as the way through', () => {
    const built = buildExitDescriptor({ position: gmxPosition(), markPrice: 63_000, quote: null })
    expect(built.ok).toBe(false)
    expect(built.reason).toMatch(/keeper fee/)
    expect(built.reason).toMatch(/close it on GMX/)
  })

  it('sends only the protection legs that actually changed', () => {
    const built = buildProtectDescriptor({
      position: gainsPosition(),
      stopLoss: 59_000,
      takeProfit: 70_000,
      stored: { stopLoss: 58_000, takeProfit: 70_000 },
      markPrice: 63_000,
    })
    expect(built.ok).toBe(true)
    expect('sl' in built.descriptor.params).toBe(true)
    expect('tp' in built.descriptor.params).toBe(false)
  })
})

/*
 * Findings from the actor-critic VISUAL review (specs/083-.../screenshots/). Neither of these was
 * catchable by the suite as it stood: the first is a formatting choice that only looks wrong next
 * to a real four-figure price, and the second is two sentences that are each true in isolation and
 * contradictory when rendered together.
 */
describe('PositionSheet — suggested protection levels (visual-review findings)', () => {
  it('rounds a suggested level to what a member would type, not to float noise', async () => {
    // A flat 8-decimal precision printed `4011.69153226` into the field for a $4,011 pair while the
    // helper line beneath it said "At 4,011.7" — the same number, twice, disagreeing.
    renderSheet({
      position: gainsPosition({
        symbol: 'ETH/USD',
        entryPrice: 4102.4,
        markPrice: 4180.4,
        leverage: 12.4,
        liquidationPrice: 3854.321987654321,
      }),
    })
    await settle()

    const stop = screen.getByLabelText(/Stop-loss price/i)
    expect(stop.value).not.toBe('')
    const decimals = (stop.value.split('.')[1] ?? '').length
    expect(decimals).toBeLessThanOrEqual(2) // a >= 1000 price
    // Rounding must never hand the member a pre-fill the sheet then refuses.
    expect(screen.queryByText(/would be liquidated first/i)).not.toBeInTheDocument()
  })

  it('names the basis it actually used, and never claims a liquidation price it could not read', async () => {
    // With a liquidation price the suggestion IS derived from it...
    const { unmount } = renderSheet({ position: gainsPosition({ liquidationPrice: 54_000 }) })
    await settle()
    expect(screen.getByText(/worked out from this position’s own liquidation price/i)).toBeInTheDocument()
    unmount()

    // ...without one, suggestProtection falls back to leverage, so claiming the liquidation price
    // would contradict the "could not be read" line this sheet renders directly below.
    renderSheet({ position: gainsPosition({ liquidationPrice: null }) })
    await settle()
    expect(screen.queryByText(/worked out from this position’s own liquidation price/i)).not.toBeInTheDocument()
    expect(screen.getByText(/worked out from this position’s leverage/i)).toBeInTheDocument()
  })
})
