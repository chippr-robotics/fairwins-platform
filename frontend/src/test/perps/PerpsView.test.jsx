/**
 * PerpsView (spec 082, extended by spec 083) — view states: ready (merged table + badges),
 * per-venue degraded banner, unavailable, testnet cohort, fee disclosure (gated on Hyperliquid
 * management being AVAILABLE, which it is not — so absent at every rate, zero or not, with the
 * true economics stated instead), external marking + risk disclosure on link-outs.
 *
 * Spec 083 adds the COMPOSITION assertions, which are the ones a reviewer cannot make by eye:
 *
 *   - with the management flag OFF — the state CI runs in and the state most members will see —
 *     the view is the phase-0 read-only surface: no manage control, no sheet, nothing to click;
 *   - with it ON, a row on a venue this build can manage opens the PositionSheet, and a row on
 *     Hyperliquid does not (FR-021: read-only this release, and never a dead control);
 *   - the stuck-order list sits ABOVE the positions list, and — deliberately — is NOT behind the
 *     flag, because a recovery control may never be gated by one (US4 acceptance 3 / SC-004).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WalletContext } from '../../contexts/WalletContext.js'
import PerpsView from '../../components/perps/PerpsView'
import { defaultReadVenueQuote } from '../../components/perps/positionSheetActions'
import { GMX_ADDRESSES_BY_CHAIN, perpsManageEnabled } from '../../config/perps'
import {
  GMX_DECREASE_ORDER_GAS_LIMIT_KEY,
  GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY,
  GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY,
  GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY,
} from '../../lib/perps/venues/gmx'

const TRADER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const OTHER_TRADER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

// Cohort + management-flag control: mocked per-test via these switches. Both default to the state
// a CI build actually has — mainnet cohort, management OFF.
let cohortMainnet = true
let manageFlag = false
vi.mock('../../config/perps', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    perpsCohortSupported: () => cohortMainnet,
    perpsGatewayUrl: () => 'https://gateway.test',
    // `perpsManageEnabled` stays REAL: the per-venue capability is the thing that must keep
    // Hyperliquid out, and a stubbed one would prove nothing about it.
    perpsManageFeatureEnabled: () => manageFlag,
  }
})

const PAIRS = [
  {
    id: 'gains:137:BTC/USD',
    venue: 'gains',
    chainId: 137,
    symbol: 'BTC/USD',
    base: 'BTC',
    price: 63000,
    fundingRate: 0.0000125,
    fundingIntervalHours: 1,
    openInterestUsd: 8000,
    maxLeverage: 200,
    volume24hUsd: null,
  },
  {
    id: 'hyperliquid:ETH',
    venue: 'hyperliquid',
    chainId: null,
    symbol: 'ETH/USD',
    base: 'ETH',
    price: 3000,
    fundingRate: -0.00002,
    fundingIntervalHours: 1,
    openInterestUsd: 90_000_000,
    maxLeverage: 25,
    volume24hUsd: 4_000_000,
  },
]

const marketsDeps = (over = {}) => ({
  available: () => true,
  fetchPairs: vi.fn(async () => ({
    pairs: PAIRS,
    sources: { gains: { status: 'read', chains: [137] }, hyperliquid: { status: 'read', chains: [] } },
    asOf: 'now',
  })),
  ...over,
})
/**
 * The pairs feed WITH the GMX market the fixture position holds.
 *
 * A GMX exit needs a price as well as a keeper fee — `acceptablePrice` is the slippage bound the
 * order carries — and GMX rows are priced by matching the position's MARKET ADDRESS against the
 * feed (`lib/perps/gmxMarkets.js`), which is why the pair id carries it.
 */
const gmxMarketsDeps = (over = {}) =>
  marketsDeps({
    fetchPairs: vi.fn(async () => ({
      pairs: [
        ...PAIRS,
        {
          id: `gmx:42161:BTC/USD:${GMX_POSITION.venueRef.market}`,
          venue: 'gmx',
          chainId: 42161,
          symbol: 'BTC/USD',
          base: 'BTC',
          variant: 'WBTC.b-USDC',
          price: 64_000,
          fundingRate: 0.00001,
          fundingIntervalHours: 1,
          openInterestUsd: 1_000_000,
          maxLeverage: null,
          volume24hUsd: null,
        },
      ],
      sources: { gains: { status: 'read', chains: [137] }, gmx: { status: 'read', chains: [42161] } },
      asOf: 'now',
    })),
    ...over,
  })

const positionsDeps = (over = {}) => ({
  available: () => true,
  fetchPositions: vi.fn(async () => ({ positions: [], sources: {} })),
  // The hook also reads GMX positions from its Reader on Arbitrum (spec 083 T032). Stubbed here so
  // a component test never reaches a live endpoint; the read itself is covered in
  // `usePerpsPositions.test.jsx`.
  getProvider: () => ({}),
  makeContract: () => ({ getAccountPositions: async () => [] }),
  ...over,
})
const configDeps = (fee = { bps: 0, capBps: 10, source: 'env-fallback' }) => ({
  fetchConfig: vi.fn(async () => ({
    attribution: { gains: { referrer: '0x2222222222222222222222222222222222222222' }, gmx: { refCode: 'fairwins' }, hyperliquid: {} },
    hyperliquidBuilderFee: fee,
  })),
})

/**
 * A Gains position on Polygon — a venue/chain pair `perpsManageEnabled` really does support.
 *
 * THE FIELD LIST IS EXACTLY WHAT THE GATEWAY EMITS (`normalizeGainsPositions`), and that matters
 * more than it looks: there is deliberately NO `markPrice` here, because the gateway does not
 * publish one. A fixture that invented it hid the fact that the assembled view had no current
 * price to close against at all — the sheet refused every close, honestly, and US1 was unreachable.
 * The price is composed in `PerpsView` from the venue's own pairs feed; see the wiring test below.
 * Do not add a field here the producer does not produce.
 */
const GAINS_POSITION = {
  id: 'gains:137:7',
  venue: 'gains',
  chainId: 137,
  symbol: 'BTC/USD',
  direction: 'long',
  sizeUsd: 1000,
  collateralUsd: 100,
  entryPrice: 60_000,
  leverage: 10,
  liquidationPrice: 54_000,
  unrealizedPnlUsd: 50,
  venueRef: {
    venue: 'gains',
    chainId: 137,
    tradeIndex: 7,
    pairIndex: 1,
    collateralIndex: 3,
    collateralToken: USDC_POLYGON,
    collateralDecimals: 6,
    collateralPrecision: '1000000',
  },
}

/**
 * A GMX position EXACTLY as `usePerpsPositions#toGmxPosition` publishes it. The Reader returns
 * size and side and nothing else this app can price, so entry, leverage, collateral and P&L are
 * genuinely null and render '—' — do not add them here to make a test read better.
 */
const GMX_POSITION = {
  id: 'gmx:42161:0xkey',
  venue: 'gmx',
  chainId: 42161,
  symbol: null,
  direction: 'long',
  sizeUsd: 1000,
  collateralUsd: null,
  entryPrice: null,
  leverage: null,
  unrealizedPnlUsd: null,
  venueRef: {
    venue: 'gmx',
    chainId: 42161,
    positionKey: `0x${'ab'.repeat(32)}`,
    market: '0x47c031236e19d024b42f8AE6780E44A573170703',
    collateralToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    isLong: true,
  },
  raw: { sizeInUsd: 1000n * 10n ** 30n, collateralAmount: 100_000_000n },
}

const HL_POSITION = {
  id: 'hyperliquid:ETH:long',
  venue: 'hyperliquid',
  chainId: null,
  symbol: 'ETH/USD',
  direction: 'long',
  sizeUsd: 4500,
  entryPrice: 3000,
  leverage: 10,
  unrealizedPnlUsd: -50,
}

/** A Gains market order the keeper never executed, in the wire shape `usePerpsOrders` reads. */
const STUCK_ORDER = {
  id: 'gains:137:pending:4',
  venue: 'gains',
  chainId: 137,
  symbol: 'BTC/USD',
  direction: 'long',
  orderType: 0, // MARKET_OPEN
  createdBlock: 100,
  timeoutBlocks: 30,
  venueRef: { pendingOrderIndex: 4 },
}

/**
 * `usePerpsOrders`, stubbed to touch no network. GMX resolves to "not deployed" so the Arbitrum log
 * read never runs; the Gains facet comes back through the stubbed gateway.
 */
const ordersDeps = ({ pendingOrders = [], head = 1000 } = {}) => ({
  fetchPositions: vi.fn(async () => ({
    positions: [],
    pendingOrders,
    sources: { gains: { status: 'read', pendingOrderChains: [137] } },
  })),
  getProvider: () => ({ getBlockNumber: async () => head, getLogs: async () => [] }),
  makeContract: () => ({ getMarketOrdersTimeoutBlocks: async () => 30n }),
  addressesFor: () => null,
})

/** The write rail for both the pending-order list and the sheet. `sleep` parks the venue watcher. */
const tradeDeps = () => ({
  sendOnChain: vi.fn(async () => ({ receipts: [{ status: 1, hash: `0x${'11'.repeat(32)}`, logs: [] }] })),
  getProvider: () => ({ getBlockNumber: async () => 1000, getLogs: async () => [] }),
  sleep: () => new Promise(() => {}),
  now: () => 0,
})

/**
 * GMX's DataStore and the network gas price, answering exactly what the deployed Arbitrum ones
 * answered on 2026-08-12 (see `gmxExecutionFee.test.js` for the read and the key derivation).
 *
 * The sheet's keeper-fee quote runs through the REAL producer over these — `defaultReadVenueQuote`
 * → `readExecutionFee` → `estimateExecutionFee` — rather than a hand-written `{ executionFee }`,
 * because the thing this file is for is the WIRING: a stub would keep passing if the sheet stopped
 * calling the producer at all.
 */
const GMX_GAS_CONFIG = {
  [GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY]: 207_024n,
  [GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY]: 525_368n,
  [GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY]: 1_584_563_439_287_042_000_000_000_000_000n,
  [GMX_DECREASE_ORDER_GAS_LIMIT_KEY]: 3_000_000n,
}
const gmxQuoteDeps = (over = {}) => ({
  // A viem PublicClient's gas-price surface — `eth_gasPrice`, with the 1559 ceiling behind it.
  getClient: () => ({ getGasPrice: async () => 20_000_000n, estimateFeesPerGas: async () => ({}) }),
  makeContract: () => ({ getUint: async (key) => GMX_GAS_CONFIG[key] ?? 0n }),
  ...over,
})

const sheetDeps = (over = {}) => ({
  readFee: async () => ({ bps: 0 }),
  // Every sheet render in this file goes through the real quote producer over a stubbed DataStore,
  // so no test reaches a network and none of them silently stops exercising it.
  readQuote: (args) => defaultReadVenueQuote({ ...args, deps: gmxQuoteDeps(over.quote) }),
  trade: tradeDeps(),
  ...over.sheet,
})

/**
 * The ENTRY sheet's two live reads, stubbed. Both are real reads in production — the venues' own
 * `getTradingActivated()` and an ERC-20 `balanceOf` per accepted collateral — and both run ONLY
 * while a pair is open, which is what keeps the flag-off view free of new network activity.
 *
 * `readVenueStatuses` answers OPEN by default so the sheet's happy path is reachable; the tests
 * that care about a refusal pass their own.
 */
const openDeps = (over = {}) => ({
  readVenueStatuses: vi.fn(async (chainId) => ({
    gains: { venue: 'gains', chainId, status: 'open', manageable: true },
    gmx: { venue: 'gmx', chainId, status: 'open', manageable: true },
  })),
  readCollateralBalances: vi.fn(async () => [
    { symbol: 'USDC', address: USDC_POLYGON, decimals: 6, balance: 1_000_000_000n, usdValue: 1000 },
  ]),
  ...over,
})

/** The entry sheet's own injected effects (fee rate, keeper-fee quote, allowance, attestation). */
const openSheetDeps = (over = {}) => ({
  readFee: async () => ({ bps: 5 }),
  readQuote: async () => null, // Gains has no keeper fee
  readAllowance: async () => 10n ** 30n,
  hasAttested: () => over.attested ?? true,
  subscribeAttestation: () => () => {},
  attestation: {
    state: () => ({ attested: over.attested ?? true, record: null, version: 1, superseded: false, reason: null }),
    record: () => ({ version: 1, items: [], at: '2026-08-12T00:00:00.000Z' }),
    subscribe: () => () => {},
  },
  trade: tradeDeps(),
  ...over.sheet,
})

function renderView({
  markets = marketsDeps(),
  positions = positionsDeps(),
  config = configDeps(),
  orders = ordersDeps(),
  trade = tradeDeps(),
  sheet = sheetDeps(),
  open = openDeps(),
  openSheet = openSheetDeps(),
  wallet = {},
} = {}) {
  return render(
    <WalletContext.Provider
      value={{ address: TRADER, isConnected: false, chainId: 137, loginMethod: 'injected', signer: {}, ...wallet }}
    >
      <PerpsView deps={{ markets, positions, config, orders, trade, sheet, open, openSheet }} />
    </WalletContext.Provider>,
  )
}

/** Positions from the gateway, as a connected member would see them. */
const withPositions = (rows) =>
  positionsDeps({ fetchPositions: vi.fn(async () => ({ positions: rows, sources: { gains: { status: 'read' } } })) })

beforeEach(() => {
  cohortMainnet = true
  manageFlag = false
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('PerpsView', () => {
  it('renders the merged table with venue badges, prices, funding, OI and leverage', async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getByText('BTC/USD')).toBeInTheDocument()
    expect(screen.getByText('ETH/USD')).toBeInTheDocument()
    expect(screen.getByText('63,000.0')).toBeInTheDocument()
    expect(screen.getByText('+0.0013%')).toBeInTheDocument()
    expect(screen.getByText('$90.0M')).toBeInTheDocument()
    expect(screen.getByText('200×')).toBeInTheDocument()
    // Venue badges: gains carries its network name; hyperliquid never does (non-EVM, FR-012).
    expect(screen.getByText('Gains')).toBeInTheDocument()
    expect(screen.getByText('HL')).toBeInTheDocument()
  })

  it('marks link-outs external and shows the risk disclosure', async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    const links = screen.getAllByRole('link', { name: /opens the venue in a new tab/i })
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    }
    expect(screen.getByText(/leverage multiplies losses/i)).toBeInTheDocument()
    expect(screen.getByText(/you are leaving fairwins/i)).toBeInTheDocument()
  })

  it('names a degraded venue while the rest keep rendering', async () => {
    const markets = marketsDeps({
      fetchPairs: vi.fn(async () => ({
        pairs: PAIRS.filter((p) => p.venue !== 'hyperliquid'),
        sources: { gains: { status: 'read', chains: [137] }, hyperliquid: { status: 'degraded', chains: [] } },
        asOf: 'now',
      })),
    })
    renderView({ markets })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getByText(/hyperliquid market data is temporarily unavailable/i)).toBeInTheDocument()
    expect(screen.getByText('BTC/USD')).toBeInTheDocument()
    expect(screen.queryByText('ETH/USD')).not.toBeInTheDocument()
  })

  it('renders one honest unavailable state on total failure', async () => {
    const markets = marketsDeps({ fetchPairs: vi.fn(async () => Promise.reject(new Error('down'))) })
    renderView({ markets })
    await waitFor(() => expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument())
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('discloses mainnet-only on a testnet cohort instead of showing cross-cohort data', () => {
    cohortMainnet = false
    const markets = marketsDeps()
    const orders = ordersDeps({ pendingOrders: [STUCK_ORDER] })
    renderView({ markets, orders, wallet: { isConnected: true } })
    expect(screen.getByText(/mainnet venues only/i)).toBeInTheDocument()
    expect(markets.fetchPairs).not.toHaveBeenCalled()
    // The order read has no `available()` of its own, so the cohort boundary is honoured by
    // withholding the account. A testnet build reading mainnet venues would cross it (constitution III).
    expect(orders.fetchPositions).not.toHaveBeenCalled()
  })

  it('shows NO fee line at a zero builder fee', async () => {
    renderView({ config: configDeps({ bps: 0, capBps: 10, source: 'chain' }) })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.queryByText(/fairwins charges/i)).not.toBeInTheDocument()
  })

  /**
   * THE TRAP, AND THE WHOLE POINT OF THIS BLOCK.
   *
   * `perps.hyperliquid.builder` is admin-settable TODAY from the Fees tab (Polygon, ConfigOnly,
   * cap 10 bps), while FairWins sends Hyperliquid no orders at all and — per
   * `specs/083-perps-position-management/hyperliquid-decision.md` — is not going to: HL's L1
   * actions need a browser-held agent key even to CLOSE, so management does not ship. A footnote
   * conditioned on the rate therefore let ONE admin edit publish a member-facing claim that orders
   * are placed through FairWins. Conditioning it on the capability is what these assertions pin,
   * and a non-zero rate is the input that proves it: a rate-conditioned render fails here.
   *
   * `perpsManageEnabled` is deliberately NOT stubbed in this file, so "unavailable" here is the
   * real shipped capability answer rather than a test's opinion of it.
   */
  describe('the Hyperliquid fee footnote is gated on the CAPABILITY, never on the rate', () => {
    it('discloses nothing at a NON-ZERO rate while Hyperliquid management is unavailable', async () => {
      renderView({ config: configDeps({ bps: 5, capBps: 10, source: 'chain' }) })
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
      expect(screen.queryByText(/fairwins charges/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/orders placed through fairwins/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/0\.05%/)).not.toBeInTheDocument()
    })

    it('stays absent at a non-zero rate even with the management flag ON — HL is still not manageable', async () => {
      manageFlag = true
      renderView({ config: configDeps({ bps: 5, capBps: 10, source: 'chain' }) })
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
      expect(screen.queryByText(/fairwins charges/i)).not.toBeInTheDocument()
    })

    it('states the true economics instead — FairWins earns nothing on Hyperliquid', async () => {
      renderView({ config: configDeps({ bps: 5, capBps: 10, source: 'chain' }) })
      await waitFor(() =>
        expect(screen.getByText(/hyperliquid trades cost you nothing extra/i)).toBeInTheDocument(),
      )
    })

    it('has nothing to fail to confirm either — a dead config read shows no fee note at all', async () => {
      // The "could not be confirmed" note promises the venue will not charge above the rate you
      // approved on it. With no order ever placed there is no rate and no approval, so the note
      // would describe the same absent capability the rate line does.
      renderView({ config: { fetchConfig: vi.fn(async () => Promise.reject(new Error('down'))) } })
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
      expect(screen.queryByText(/could not be confirmed/i)).not.toBeInTheDocument()
      expect(screen.getByText(/hyperliquid trades cost you nothing extra/i)).toBeInTheDocument()
    })
  })

  it('shows positions for a connected wallet', async () => {
    renderView({ positions: withPositions([HL_POSITION]), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    expect(screen.getByText('Long')).toBeInTheDocument()
    expect(screen.getByText('−$50.00')).toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Spec 083 — the management gate
 * --------------------------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------------------------- *
 * Issue #1440 — the controls are one row at rest, and a collapsed panel never hides a live filter
 *
 * The venue pills and the sort select cost roughly a fifth of a phone viewport before a single pair
 * was on screen. Collapsing them is only safe if the closed control still SAYS what is shaping the
 * table: a table quietly missing rows is indistinguishable from a venue that stopped reporting,
 * which is the exact confusion the rest of this view is built to avoid.
 * ------------------------------------------------------------------------------------------- */
describe('PerpsView market controls', () => {
  it('rests as one row: search visible, venue pills and sort UNMOUNTED', async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    // The one control a member reaches for first stays on the toolbar.
    expect(screen.getByLabelText('Search pairs')).toBeInTheDocument()

    // Not `display: none` — a control in the tab order under `aria-expanded="false"` is claiming
    // something untrue, so the panel is genuinely absent.
    const toggle = screen.getByRole('button', { name: /filters/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: /filter by venue/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Sort pairs')).not.toBeInTheDocument()
  })

  it('reveals the venue filter and the sort on demand, and folds them away again', async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    const toggle = screen.getByRole('button', { name: /filters/i })

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: /filter by venue/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Sort pairs')).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Sort pairs')).not.toBeInTheDocument()
  })

  it('NAMES the active venue filter on the closed control, and still filters the table', async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /filters/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Hyperliquid' }))
    // Fold the panel away — the filter it set is still shaping the table.
    await userEvent.click(screen.getByRole('button', { name: /filters/i }))

    expect(screen.queryByRole('group', { name: /filter by venue/i })).not.toBeInTheDocument()
    // The toggle carries the live filter, so nothing about the short table is hidden.
    expect(screen.getByRole('button', { name: /filters/i })).toHaveTextContent('Hyperliquid')
    expect(screen.queryByText('BTC/USD')).not.toBeInTheDocument()
    expect(screen.getByText('ETH/USD')).toBeInTheDocument()
  })

  it('names a non-default sort on the closed control too', async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /filters/i }))
    await userEvent.selectOptions(screen.getByLabelText('Sort pairs'), 'symbol')
    await userEvent.click(screen.getByRole('button', { name: /filters/i }))

    expect(screen.getByRole('button', { name: /filters/i })).toHaveTextContent('Pair name')
  })

  it('shows the result count only while something is narrowing the list', async () => {
    renderView()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    // Announced to a screen reader from the start, but not taking height on a resting view.
    const before = screen.getByText(/showing 2 of 2 pairs/i)
    expect(before).toHaveClass('sr-only')

    await userEvent.type(screen.getByLabelText('Search pairs'), 'BTC')
    const after = screen.getByText(/showing 1 of 2 pairs/i)
    expect(after).not.toHaveClass('sr-only')
    expect(after).toHaveClass('perps-result-count')
  })
})

describe('PerpsView management controls', () => {
  it('renders the phase-0 read-only surface with the management flag OFF', async () => {
    // This is the CI state and the state most members will see, so it is asserted rather than
    // assumed: no manage control on a venue this build CAN manage, and nothing that opens a sheet.
    renderView({ positions: withPositions([GAINS_POSITION]), wallet: { isConnected: true } })
    // Anchor on the ROW, not the section header: "Your positions" renders during the loading
    // state too (fetchPositions is async), so asserting absences against the header alone
    // passes vacuously on an empty list and loses the race on a slow worker — which it did,
    // once, in the full-suite CI run. The never-stranded link is phase 0's own artifact.
    const manageLink = await screen.findByRole('link', {
      name: /Manage this position on Gains Network/i,
    })
    expect(manageLink).toBeInTheDocument()

    // …and it is the FLAG withholding it, not the capability: this build can build calldata for
    // this venue on this chain. Without this line the case would pass for the wrong reason.
    expect(perpsManageEnabled('gains', 137)).toBe(true)
    expect(screen.queryByRole('button', { name: /close or protect/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(/positions are read-only in FairWins this release/i)).toBeInTheDocument()
  })

  it('opens the PositionSheet from a row when the flag is ON', async () => {
    manageFlag = true
    renderView({ positions: withPositions([GAINS_POSITION]), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    const manage = screen.getByRole('button', {
      name: 'Close or protect your Long BTC/USD position on Gains Network',
    })
    await userEvent.click(manage)

    const sheet = await screen.findByRole('dialog')
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: /Long BTC\/USD/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close this position' })).toBeEnabled()

    // Dismissing gives the view back, with the row still there.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /close or protect/i })).toBeInTheDocument()
  })

  it('closes the sheet the moment the account changes', async () => {
    // A sheet aimed at the previous account's position carries that account's venue handles. It
    // must go before anything is painted for the new one (spec 083 edge case).
    manageFlag = true
    const positions = withPositions([GAINS_POSITION])
    const { rerender } = renderView({ positions, wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    rerender(
      <WalletContext.Provider
        value={{ address: OTHER_TRADER, isConnected: true, chainId: 137, loginMethod: 'injected', signer: {} }}
      >
        <PerpsView
          deps={{ markets: marketsDeps(), positions, config: configDeps(), orders: ordersDeps(), trade: tradeDeps(), sheet: sheetDeps() }}
        />
      </WalletContext.Provider>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers NO in-app control for Hyperliquid even with the flag ON (FR-021)', async () => {
    manageFlag = true
    renderView({ positions: withPositions([HL_POSITION]), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    // Not a disabled button — no button at all, plus the honest per-venue statement.
    expect(screen.queryByRole('button', { name: /close or protect/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Hyperliquid positions are read-only in FairWins this release/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Manage this position on Hyperliquid/i })).toBeInTheDocument()
  })

  it('states management per venue when one venue is manageable and another is not', async () => {
    manageFlag = true
    renderView({ positions: withPositions([GAINS_POSITION, HL_POSITION]), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    expect(screen.getByText(/close, reduce and protect your Gains Network positions here/i)).toBeInTheDocument()
    expect(screen.getByText(/Hyperliquid positions are read-only/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /close or protect/i })).toHaveLength(1)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Spec 083 US1 — the exit actually reaches the venue from the ASSEMBLED view
 *
 * Every other test here mounts the sheet with props a test wrote. These mount it the way the app
 * does, from a position payload in the gateway's own shape, and follow the tap all the way to the
 * send rail. That is the only level at which a missing prop is visible: a position read carries
 * what the member holds, never what the market is doing, so without the composition below the
 * sheet has no price to bound a close with and refuses every one of them — honestly, and with US1
 * unreachable. It refused exactly that way until this was wired.
 * --------------------------------------------------------------------------------------------- */

describe('PerpsView prices the exit from the venue’s own feed', () => {
  it('shows the venue’s current price on the sheet, and the close reaches the send rail', async () => {
    manageFlag = true
    const sheet = sheetDeps()
    renderView({ positions: withPositions([GAINS_POSITION]), sheet, wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')

    // The same number the pairs table one section up is rendering for this venue's BTC/USD.
    const current = screen.getByText('Current price', { selector: 'dt' }).parentElement.querySelector('dd')
    expect(current).toHaveTextContent('63,000.0')

    await userEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    await waitFor(() => expect(sheet.trade.sendOnChain).toHaveBeenCalled())
    // The venue's chain, and a call to the venue — not a refusal.
    expect(sheet.trade.sendOnChain.mock.calls[0][0]).toBe(137)
    expect(document.querySelector('.pps-error')).toBeNull()
  })

  /* THE VENUE'S OWN FEE reaches the exit sheet from the same seam, and for the same reason: a
   * position read carries no fee schedule, so without this composition the sheet showed FairWins'
   * fee in money beside the venue's as a dash — which reads as though ours were the cost of
   * closing. */
  it('hands the exit sheet the venue’s own closing rate, off the pair row it already resolved', async () => {
    manageFlag = true
    const markets = marketsDeps({
      fetchPairs: vi.fn(async () => ({
        pairs: [
          {
            ...PAIRS[0],
            venueFee: { openRate: 0.00035, closeRate: 0.00035, feeFloorNotionalUsd: 285.715, minFeeUsd: 0.10000025 },
          },
          PAIRS[1],
        ],
        sources: { gains: { status: 'read', chains: [137] } },
        asOf: 'now',
      })),
    })
    renderView({ markets, positions: withPositions([GAINS_POSITION]), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')

    // 0.035% of the whole $1,000 position.
    const feeRow = screen.getByText('Gains’s own fee (0.035% of size), estimated', { selector: 'dt' })
    expect(feeRow.parentElement.querySelector('dd')).toHaveTextContent('$0.35')
  })

  it('leaves the venue’s fee a dash when the feed does not list the position’s pair', async () => {
    // Same rule as the price: a rate is never borrowed from another venue's row, and an absent one
    // is disclosed rather than filled in. It can never withhold the exit.
    manageFlag = true
    const sheet = sheetDeps()
    renderView({ positions: withPositions([GAINS_POSITION]), sheet, wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')

    expect(screen.getByText('Gains’s own fee', { selector: 'dt' }).parentElement.querySelector('dd')).toHaveTextContent('—')
    await userEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    await waitFor(() => expect(sheet.trade.sendOnChain).toHaveBeenCalled())
  })

  it('takes the price from the venue that holds the position, never from another venue’s pair', async () => {
    // A same-symbol pair on a different venue at a different price. Borrowing it would price a
    // Gains close off Hyperliquid's book — a fabricated number bounding a leveraged exit.
    manageFlag = true
    const markets = marketsDeps({
      fetchPairs: vi.fn(async () => ({
        pairs: [{ ...PAIRS[1], id: 'hyperliquid:BTC', symbol: 'BTC/USD', base: 'BTC', price: 1 }],
        sources: { hyperliquid: { status: 'read', chains: [] } },
        asOf: 'now',
      })),
    })
    renderView({ markets, positions: withPositions([GAINS_POSITION]), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')

    const current = screen.getByText('Current price', { selector: 'dt' }).parentElement.querySelector('dd')
    expect(current).toHaveTextContent('—')
  })

  /**
   * THE FORMER KNOWN GAP, NOW CLOSED — GMX's keeper fee has a producer.
   *
   * Every GMX order is settled by keepers the member pays, so `createOrder` refuses one whose
   * `executionFee` is short. For a release this app had no producer for that number, `venueQuote`
   * was never supplied, and every GMX close, reduce and protect refused — a control that was
   * offered and could not act, which is what FR-021 forbids. The estimator (GMX's own
   * `ESTIMATED_GAS_FEE_*` DataStore keys and `GasUtils` formula) and its live read now exist in
   * `lib/perps/venues/gmx.js`, and the sheet reads it itself.
   *
   * These two tests are what stops that regressing: the first is the send assertion the Gains
   * sibling above already made, and the second is the honest half — a fee that genuinely cannot be
   * read still refuses BEFORE any wallet prompt and still names GMX as the way through.
   */
  it('a GMX exit produces a usable keeper fee and reaches the send rail', async () => {
    manageFlag = true
    const sheet = sheetDeps()
    renderView({
      markets: gmxMarketsDeps(),
      positions: withPositions([GMX_POSITION]),
      sheet,
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')

    // The fee is disclosed BEFORE the member acts: an estimate, in the network's own coin, with
    // the refund of the unspent part named. 6,536,818 gas × 0.02 gwei × 1.10 = 0.0001438 ETH.
    const keeperFee = await screen.findByText('GMX keeper fee (estimated)', { selector: 'dt' })
    expect(keeperFee.parentElement.querySelector('dd')).toHaveTextContent('0.0001438 ETH')
    expect(screen.getByText(/returns whatever the keeper does not spend/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    await waitFor(() => expect(sheet.trade.sendOnChain).toHaveBeenCalled())
    // GMX's own chain, and a call to the venue — not a refusal.
    expect(sheet.trade.sendOnChain.mock.calls[0][0]).toBe(42161)
    expect(document.querySelector('.pps-error')).toBeNull()
    // The member is msg.sender and the fee rides as the transaction's value, both of which the
    // calldata suites assert in detail; here it is enough that a real call object was produced.
    const [, calls] = sheet.trade.sendOnChain.mock.calls[0]
    expect(calls[0].value).toBe(143_809_996_000_000n)
    expect(calls[0].target).toBe(GMX_ADDRESSES_BY_CHAIN[42161].exchangeRouter)
  })

  it('still refuses honestly — and never silently — when GMX’s fee cannot be read', async () => {
    manageFlag = true
    // The DataStore answers nothing. A zero there is a mis-derived key or the wrong contract, and
    // treating it as "zero gas" would have the member sign an order no keeper will ever execute.
    const sheet = sheetDeps({ quote: { makeContract: () => ({ getUint: async () => 0n }) } })
    renderView({
      markets: gmxMarketsDeps(),
      positions: withPositions([GMX_POSITION]),
      sheet,
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')

    // Said up front, not only after a tap — and no fee line is invented in its place.
    await waitFor(() =>
      expect(screen.getByText(/keeper fee could not be read just now/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText('GMX keeper fee (estimated)', { selector: 'dt' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close this position' }))
    await waitFor(() => expect(screen.getByText(/keeper fee for this order could not be read/i)).toBeInTheDocument())
    // Refused BEFORE a wallet prompt, and the venue's own surface is named as the way through.
    expect(sheet.trade.sendOnChain).not.toHaveBeenCalled()
    expect(screen.getAllByRole('link', { name: /Manage this position on GMX/i }).length).toBeGreaterThan(0)
  })

  it('keeps the price when the member filters the pairs table down to nothing', async () => {
    // The table's list is a VIEW shaped by the search box. Pricing a position off it would make a
    // close stop being possible because of a control that has nothing to do with the position.
    manageFlag = true
    const sheet = sheetDeps()
    renderView({ positions: withPositions([GAINS_POSITION]), sheet, wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('Search pairs'), 'ZZZZ')
    await waitFor(() => expect(screen.getByText(/No pairs match/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')
    const current = screen.getByText('Current price', { selector: 'dt' }).parentElement.querySelector('dd')
    expect(current).toHaveTextContent('63,000.0')
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Spec 083 US3/US5 — a GMX market becomes a pair, or stays honestly unnamed
 *
 * GMX's Reader names a MARKET ADDRESS and nothing else, so its rows arrive with `symbol: null` and
 * read "Current price —" forever — the sheet then refuses every close for want of a price. The
 * mapping is composed here from the pairs feed the view already fetched (each GMX pair carries its
 * market token inside its id). These tests are the ones that would catch a resolution that GUESSES:
 * two GMX markets on one base pair are on screen at once, at different prices.
 * --------------------------------------------------------------------------------------------- */

describe('PerpsView resolves a GMX market address to its pair', () => {
  const BTC_WBTC = GMX_POSITION.venueRef.market
  const BTC_SYNTH = '0x7C11F78Ce78768518D743E81Fdfa2F860C6b9A77'
  /** A market the member holds and the feed does not list. */
  const UNLISTED = '0x0418643F94Ef14917f1345cE5C460C37dE463ef7'

  // Two REAL-shaped GMX pairs on one base pair — this is how GMX actually lists BTC.
  const GMX_PAIRS = [
    {
      id: `gmx:42161:BTC/USD:${BTC_WBTC}`,
      venue: 'gmx',
      chainId: 42161,
      symbol: 'BTC/USD',
      base: 'BTC',
      variant: 'WBTC.b-USDC',
      price: 64_000,
      fundingRate: 0.00001,
      fundingIntervalHours: 1,
      openInterestUsd: 1_000_000,
      maxLeverage: null,
      volume24hUsd: null,
    },
    {
      id: `gmx:42161:BTC/USD:${BTC_SYNTH}`,
      venue: 'gmx',
      chainId: 42161,
      symbol: 'BTC/USD',
      base: 'BTC',
      variant: 'BTC-USDC',
      price: 64_010,
      fundingRate: 0.00002,
      fundingIntervalHours: 1,
      openInterestUsd: 2_000_000,
      maxLeverage: null,
      volume24hUsd: null,
    },
  ]

  const withGmxPairs = () =>
    marketsDeps({
      fetchPairs: vi.fn(async () => ({
        pairs: [...PAIRS, ...GMX_PAIRS],
        sources: { gains: { status: 'read', chains: [137] }, gmx: { status: 'read', chains: [42161] } },
        asOf: 'now',
      })),
    })

  const currentPrice = () =>
    screen.getByText('Current price', { selector: 'dt' }).parentElement.querySelector('dd')

  it('names the position’s market and prices it from THAT market, not its sibling', async () => {
    manageFlag = true
    renderView({
      markets: withGmxPairs(),
      positions: withPositions([GMX_POSITION]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    const row = document.querySelector('.perps-position-row')
    expect(row.querySelector('.perps-position-symbol')).toHaveTextContent('BTC/USD')
    // The variant is what keeps two markets on one base pair apart.
    expect(row.querySelector('.perps-position-variant')).toHaveTextContent('WBTC.b-USDC')

    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')
    // Its own market's price — the other BTC market is 64,010.0 and must not be borrowed.
    expect(currentPrice()).toHaveTextContent('64,000.0')
    expect(currentPrice()).not.toHaveTextContent('64,010.0')
  })

  it('keeps two positions on the same base pair distinguishable', async () => {
    manageFlag = true
    renderView({
      markets: withGmxPairs(),
      positions: withPositions([
        { ...GMX_POSITION, id: 'gmx:42161:0xone' },
        {
          ...GMX_POSITION,
          id: 'gmx:42161:0xtwo',
          venueRef: { ...GMX_POSITION.venueRef, market: BTC_SYNTH },
        },
      ]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    const variants = [...document.querySelectorAll('.perps-position-variant')].map((n) => n.textContent)
    expect(variants).toEqual(['WBTC.b-USDC', 'BTC-USDC'])
  })

  it('leaves a market the feed does not list unnamed and unpriced — never the nearest BTC market', async () => {
    manageFlag = true
    renderView({
      markets: withGmxPairs(),
      positions: withPositions([
        { ...GMX_POSITION, venueRef: { ...GMX_POSITION.venueRef, market: UNLISTED } },
      ]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    const row = document.querySelector('.perps-position-row')
    expect(row.querySelector('.perps-position-symbol')).toHaveTextContent('')
    expect(row.querySelector('.perps-position-variant')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')
    expect(currentPrice()).toHaveTextContent('—')
  })

  it('still names the market when the member has filtered the pairs table down to nothing', async () => {
    // The search box shapes the TABLE. It must never decide whether a member's own position can be
    // named or priced — that is the `allPairs` rule, and GMX resolution rides it too.
    manageFlag = true
    renderView({
      markets: withGmxPairs(),
      positions: withPositions([GMX_POSITION]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('Search pairs'), 'ZZZZ')
    await waitFor(() => expect(screen.getByText(/No pairs match/i)).toBeInTheDocument())

    expect(document.querySelector('.perps-position-symbol')).toHaveTextContent('BTC/USD')
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')
    expect(currentPrice()).toHaveTextContent('64,000.0')
  })

  /* A feed that could not be read resolves nothing — but this view hides the whole positions list
   * behind the market-data outage (the pre-existing `markets.status === 'unavailable'` branch), so
   * there is no row to assert on here. The empty-index case is covered directly in
   * `gmxMarkets.test.js`, where the answer is null and the row renders '—'. */
})

/* --------------------------------------------------------------------------------------------- *
 * Spec 083 US4 — the stuck-order list
 * --------------------------------------------------------------------------------------------- */

describe('PerpsView stuck orders', () => {
  it('lists a stuck order ABOVE the positions list, with its recovery control', async () => {
    renderView({
      orders: ordersDeps({ pendingOrders: [STUCK_ORDER] }),
      positions: withPositions([GAINS_POSITION]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Orders waiting at the venue')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Recover your collateral' })).toBeEnabled()

    // Urgency is expressed as document order: collateral in limbo comes before a healthy position.
    const orders = screen.getByText('Orders waiting at the venue')
    const positions = screen.getByText('Your positions')
    expect(orders.compareDocumentPosition(positions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('still offers the recovery control with the management flag OFF (US4 acceptance 3)', async () => {
    // The flag withholds the management surface; it may never withhold a member's collateral. A
    // stuck order can exist from the venue's own app whatever this build has enabled.
    manageFlag = false
    renderView({
      orders: ordersDeps({ pendingOrders: [STUCK_ORDER] }),
      positions: withPositions([GAINS_POSITION]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recover your collateral' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: /close or protect/i })).not.toBeInTheDocument()
  })

  it('renders nothing for the order list when nothing is waiting', async () => {
    renderView({ positions: withPositions([GAINS_POSITION]), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    expect(screen.queryByText('Orders waiting at the venue')).not.toBeInTheDocument()
  })

  it('keeps the recovery surface alive when market data is unavailable', async () => {
    // A dead pairs feed says nothing about a member's collateral — the recovery path is not
    // downstream of it.
    const markets = marketsDeps({ fetchPairs: vi.fn(async () => Promise.reject(new Error('down'))) })
    renderView({
      markets,
      orders: ordersDeps({ pendingOrders: [STUCK_ORDER] }),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recover your collateral' })).toBeEnabled())
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Spec 083 US3 — THE ENTRY SURFACE, wired
 *
 * `OpenPositionSheet` is tested exhaustively against US3 in its own file, driven directly with
 * props. What CANNOT be tested there, and what is asserted here, is the composition: that a pair
 * row actually reaches it, that the two gates the view owns decide whether the control exists at
 * all, and — the one most easily broken — that with the flag OFF this view is byte-for-byte the
 * phase-0 read-only surface it shipped as, with no new controls, no new markup and no new reads.
 * --------------------------------------------------------------------------------------------- */

/** A Gains BTC/USD row carrying the venue's own open handles (gateway spec 083 US3). */
const OPENABLE_GAINS_PAIR = {
  ...PAIRS[0],
  pairIndex: 4,
  minLeverage: 1.1,
  collaterals: [
    { symbol: 'USDC', address: USDC_POLYGON, decimals: 6, collateralIndex: 3, usdPrice: 1 },
  ],
}

const openableMarketsDeps = (pairs = [OPENABLE_GAINS_PAIR, PAIRS[1]]) =>
  marketsDeps({
    fetchPairs: vi.fn(async () => ({
      pairs,
      sources: { gains: { status: 'read', chains: [137] }, hyperliquid: { status: 'read', chains: [] } },
      asOf: 'now',
    })),
  })

const openBtn = () => screen.getByRole('button', { name: /Open a position on BTC\/USD at Gains Network/i })

describe('PerpsView entry surface', () => {
  it('opens the OpenPositionSheet from a pair row when the flag is ON', async () => {
    manageFlag = true
    renderView({ markets: openableMarketsDeps(), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    await userEvent.click(openBtn())
    const sheet = await screen.findByRole('dialog')
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: /Open a long on BTC\/USD/i })).toBeInTheDocument()

    // The venue's own handles reached the sheet: the collateral it published is offered, and the
    // leverage default is derived from the limits on the row rather than invented.
    await waitFor(() => expect(screen.getByLabelText(/Amount \(USDC\)/i)).toBeInTheDocument())
    expect(screen.getByText(/You hold 1000 USDC/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('offers NO in-app open on Hyperliquid even with the flag ON (FR-021)', async () => {
    // The venue this build has no calldata path for must never grow a control. This is the
    // per-venue capability doing the work — `perpsManageEnabled` is deliberately NOT stubbed.
    manageFlag = true
    renderView({ markets: openableMarketsDeps(), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(openBtn()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open a position on ETH\/USD/i })).not.toBeInTheDocument()
    // …and its link-out is untouched, which is the never-stranded path.
    expect(screen.getByRole('link', { name: /Trade ETH\/USD on hyperliquid/i })).toBeInTheDocument()
  })

  it('THE ATTESTATION GATES THE OPEN — and only the open', async () => {
    manageFlag = true
    renderView({
      markets: openableMarketsDeps(),
      positions: withPositions([GAINS_POSITION]),
      openSheet: openSheetDeps({ attested: false }),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    await userEvent.click(openBtn())
    await screen.findByRole('dialog')

    // The acknowledgement is asked for in place, nothing is pre-ticked, and the open is refused
    // until it is given.
    expect(screen.getByRole('heading', { name: 'Before you open a position' })).toBeInTheDocument()
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked()
    expect(screen.getByRole('button', { name: /Open this long/i })).toBeDisabled()
    // Said plainly: it is not needed for anything a member already holds.
    expect(screen.getByText(/not needed to close, reduce or recover anything you already hold/i)).toBeInTheDocument()

    // …and the EXIT beneath it is untouched by the missing acknowledgement.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Close this position' })).toBeEnabled()
    expect(screen.queryByRole('heading', { name: 'Before you open a position' })).not.toBeInTheDocument()
  })

  it('refuses the open with the VENUE named when the venue is not taking new positions', async () => {
    manageFlag = true
    renderView({
      markets: openableMarketsDeps(),
      open: openDeps({
        readVenueStatuses: vi.fn(async (chainId) => ({
          gains: { venue: 'gains', chainId, status: 'close-only', manageable: true },
        })),
      }),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    await userEvent.click(openBtn())
    await screen.findByRole('dialog')

    await waitFor(() =>
      expect(screen.getByText(/Gains is in close-only mode right now/i)).toBeInTheDocument(),
    )
    expect(screen.getByText(/No venue is taking new positions on BTC\/USD/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open this long/i })).not.toBeInTheDocument()
  })

  it('fails CLOSED while the venue status is unknown — silence is not permission', async () => {
    manageFlag = true
    renderView({
      markets: openableMarketsDeps(),
      // The read never resolves: this is the window between the tap and the answer.
      open: openDeps({ readVenueStatuses: vi.fn(() => new Promise(() => {})) }),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    await userEvent.click(openBtn())
    await screen.findByRole('dialog')
    expect(screen.getByText(/trading status could not be confirmed/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open this long/i })).not.toBeInTheDocument()
  })

  it('closes the entry sheet the moment the account changes', async () => {
    manageFlag = true
    const markets = openableMarketsDeps()
    const { rerender } = renderView({ markets, wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    await userEvent.click(openBtn())
    await screen.findByRole('dialog')

    rerender(
      <WalletContext.Provider
        value={{ address: OTHER_TRADER, isConnected: true, chainId: 137, loginMethod: 'injected', signer: {} }}
      >
        <PerpsView
          deps={{
            markets,
            positions: positionsDeps(),
            config: configDeps(),
            orders: ordersDeps(),
            trade: tradeDeps(),
            sheet: sheetDeps(),
            open: openDeps(),
            openSheet: openSheetDeps(),
          }}
        />
      </WalletContext.Provider>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  /**
   * Both venues on ARBITRUM, where `perpsManageEnabled` really does answer true for each. Doing
   * this on Polygon would prove nothing: GMX has no calldata path there at all, so the venue would
   * be absent for a reason that has nothing to do with the composition under test.
   */
  const ARB_GAINS = {
    ...OPENABLE_GAINS_PAIR,
    id: 'gains:42161:BTC/USD',
    chainId: 42161,
    collaterals: [{ symbol: 'USDC', address: USDC_ARB, decimals: 6, collateralIndex: 3, usdPrice: 1 }],
  }
  const arbGmx = (marketToken, variant) => ({
    id: `gmx:42161:BTC/USD:${marketToken}`,
    venue: 'gmx',
    chainId: 42161,
    symbol: 'BTC/USD',
    base: 'BTC',
    variant,
    price: 63_100,
    maxLeverage: 50,
    market: marketToken,
    collaterals: [{ symbol: 'USDC', address: USDC_ARB, decimals: 6, collateralIndex: null, usdPrice: 1 }],
  })
  const arbBalances = () =>
    openDeps({
      readCollateralBalances: vi.fn(async () => [
        { symbol: 'USDC', address: USDC_ARB, decimals: 6, balance: 1_000_000_000n, usdValue: 1000 },
      ]),
    })

  it('offers BOTH venues that list the market on that chain, with the reason for the pick', async () => {
    manageFlag = true
    expect(perpsManageEnabled('gmx', 42161)).toBe(true) // else the case below proves nothing
    renderView({
      markets: openableMarketsDeps([ARB_GAINS, arbGmx(`0x${'aa'.repeat(20)}`, 'WBTC.b-USDC')]),
      open: arbBalances(),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    await userEvent.click(openBtn())
    await screen.findByRole('dialog')

    await waitFor(() => expect(screen.getByRole('radio', { name: /Gains/i })).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: /GMX/i })).toBeInTheDocument()
    // US3 acceptance 1: the choice is made FOR the member, and the reason NAMES the venue it was
    // weighed against — `pickVenue`'s own comparison, not a generic "we picked one for you".
    expect(screen.getByText(/Gains is chosen for you:/i)).toHaveTextContent(/GMX/)
  })

  it('does not offer another venue’s market as if it were this one', async () => {
    // The SAME setup, plus a second GMX market on the same base pair and chain. Neither is "the"
    // BTC market, so GMX drops out — the member reaches it by tapping its own row. The test above
    // is what proves this exclusion is the ambiguity and not the capability.
    manageFlag = true
    renderView({
      markets: openableMarketsDeps([
        ARB_GAINS,
        arbGmx(`0x${'aa'.repeat(20)}`, 'WBTC.b-USDC'),
        arbGmx(`0x${'bb'.repeat(20)}`, 'BTC-USDC'),
      ]),
      open: arbBalances(),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    await userEvent.click(openBtn())
    await screen.findByRole('dialog')

    // One venue, stated as such — never a picker offering an arbitrary one of the two GMX markets.
    await waitFor(() =>
      expect(screen.getByText(/Gains is the only venue trading this pair here/i)).toBeInTheDocument(),
    )
    expect(screen.queryByRole('radio', { name: /GMX/i })).not.toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * THE FLAG-OFF STATE, asserted as an absence of everything
 *
 * This is the state CI runs in and the state every member sees until the terms gate clears
 * (FR-025). "No dead control" is easy to satisfy by disabling one; the requirement is stronger —
 * with the flag off this view must be indistinguishable from the read-only surface phase 0
 * shipped, in markup AND in network behaviour.
 * --------------------------------------------------------------------------------------------- */

describe('PerpsView with the management flag OFF is exactly the phase-0 view', () => {
  it('renders no entry control, on any row, even where the feed publishes every open handle', async () => {
    manageFlag = false
    renderView({ markets: openableMarketsDeps(), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    // The capability is present — this is the FLAG withholding it, not a missing calldata path.
    // Without this line the case would pass for the wrong reason.
    expect(perpsManageEnabled('gains', 137)).toBe(true)
    expect(screen.queryByRole('button', { name: /Open a position/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Every row still links out, exactly as it always did.
    expect(screen.getByRole('link', { name: /Trade BTC\/USD on gains/i })).toBeInTheDocument()
  })

  it('adds NO markup to the trade cell — the link is still the only thing in it', async () => {
    manageFlag = false
    renderView({ markets: openableMarketsDeps(), wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    const cells = [...document.querySelectorAll('.perps-trade-cell')]
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) {
      expect(cell.querySelectorAll('button')).toHaveLength(0)
      expect(cell.children).toHaveLength(1) // the link-out, and nothing else
    }
  })

  it('performs NONE of the entry surface’s reads — no venue status, no balances', async () => {
    // The strongest form of "the flag off is phase 0": not just that nothing renders, but that
    // nothing is asked of any chain on the member's behalf. Both reads are started by a tap, and
    // with the flag off there is nothing to tap.
    manageFlag = false
    const open = openDeps()
    renderView({ markets: openableMarketsDeps(), open, wallet: { isConnected: true } })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(open.readVenueStatuses).not.toHaveBeenCalled()
    expect(open.readCollateralBalances).not.toHaveBeenCalled()
  })

  it('still shows the read-only positions statement and the venue link-out', async () => {
    manageFlag = false
    renderView({
      markets: openableMarketsDeps(),
      positions: withPositions([GAINS_POSITION]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: /Manage this position on Gains Network/i })).toBeInTheDocument()
    expect(screen.getByText(/positions are read-only in FairWins this release/i)).toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * THE TWO SHEETS ARE MUTUALLY EXCLUSIVE
 *
 * Both take the body scroll lock on mount and restore what they FOUND on unmount. Two of them open
 * at once means the second captures `overflow: hidden` as the previous value, and the page is left
 * unscrollable after both are dismissed — with no control anywhere to undo it. They also both bind
 * a capture-phase Escape handler. The positions list stays in the DOM behind the entry sheet and is
 * reachable by keyboard, so this is a state a member can get into, not a theoretical one.
 * --------------------------------------------------------------------------------------------- */

describe('PerpsView never has two sheets open at once', () => {
  const openablePairs = () =>
    marketsDeps({
      fetchPairs: vi.fn(async () => ({
        pairs: [
          {
            ...PAIRS[0],
            pairIndex: 4,
            collaterals: [{ symbol: 'USDC', address: USDC_POLYGON, decimals: 6, collateralIndex: 3, usdPrice: 1 }],
          },
          PAIRS[1],
        ],
        sources: { gains: { status: 'read', chains: [137] }, hyperliquid: { status: 'read', chains: [] } },
        asOf: 'now',
      })),
    })

  it('opening the entry sheet closes the exit sheet, and the body scroll lock is released once', async () => {
    manageFlag = true
    renderView({
      markets: openablePairs(),
      positions: withPositions([GAINS_POSITION]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await screen.findByRole('dialog')
    expect(document.body.style.overflow).toBe('hidden')

    // Now the entry sheet, reached from the pairs table behind it.
    await userEvent.click(screen.getByRole('button', { name: /Open a position on BTC\/USD/i }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Open a long on BTC\/USD/i })).toBeInTheDocument(),
    )
    // ONE dialog, not two.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Close this position' })).not.toBeInTheDocument()

    // …and dismissing the survivor gives the page back. If both had mounted, the second would have
    // captured 'hidden' as the previous value and this would still be locked.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('and the other way round — opening a position sheet closes the entry sheet', async () => {
    manageFlag = true
    renderView({
      markets: openablePairs(),
      positions: withPositions([GAINS_POSITION]),
      wallet: { isConnected: true },
    })
    await waitFor(() => expect(screen.getByText('Your positions')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /Open a position on BTC\/USD/i }))
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByRole('button', { name: /close or protect/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close this position' })).toBeInTheDocument())
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: /Open a long on BTC\/USD/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.body.style.overflow).not.toBe('hidden')
  })
})
