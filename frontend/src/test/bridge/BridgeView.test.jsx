/**
 * BridgeView / BridgeQuoteCard tests (spec 067, US1 — T084/T085/T152).
 *
 * The four things this suite exists to keep true:
 *
 *   1. THE R11b INVERSION (T085, FR-063, SC-021). The destination selector offers the
 *      SAME asset on OTHER networks. Swap the predicate to `samePair` — the pair/swap
 *      rule — and the bridge silently becomes a same-chain transfer that still quotes and
 *      still signs. The `destination selector` block below fails outright if that happens.
 *   2. THE SIGNING-TIME SWITCH (T152, FR-061, SC-020). An asset on a network the wallet is
 *      not on is fully usable: the switch is disclosed before the signature and performed
 *      at submit, and no network switcher is ever a prerequisite.
 *   3. HONEST QUOTES (T084, FR-007/FR-008/FR-012). Every cost on its own labelled line, a
 *      figure the protocol did not give us shown as unavailable rather than as zero, an
 *      expired quote gating the confirm control, and the destination-gas disclosure only
 *      on an observed zero balance.
 *   4. HONEST UNAVAILABLE STATES (T083, FR-051/FR-053/FR-054) plus vitest-axe coverage.
 *
 * The router/gateway seams are mocked; `buildBridgeQuote` is NOT — the quote under test is
 * assembled by the real quote layer from a real gateway DTO, so the itemization the member
 * sees here is the itemization the app produces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { encodeEventLog } from '../helpers/encodeEventLog'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { ZeroAddress } from 'ethers'

// ---- seams -------------------------------------------------------------------------
const walletState = { address: '0x1111111111111111111111111111111111111111', chainId: 137 }
let selectableOptions = []
let portfolioHoldings = []
const sendOnChain = vi.fn()
const canTransactOn = vi.fn(() => true)

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletState }))
// Fresh array + object identities on EVERY render, exactly like the real hooks under a
// portfolio poll or balance read. Stable identities here are what hid the issue-1027 quote
// loop from this suite — keep the churn (see 'one quote per input change' below).
vi.mock('../../hooks/useSelectableAssets', () => ({
  useSelectableAssets: () => ({
    options: selectableOptions.map((o) => ({ ...o })),
    defaultKey: null,
    isGasless: () => false,
  }),
}))
vi.mock('../../hooks/usePortfolio', () => ({
  default: () => ({ holdings: portfolioHoldings.map((h) => ({ ...h })), status: 'ready' }),
}))
vi.mock('../../hooks/useEarnSend', () => ({
  useEarnSend: () => ({
    sendOnChain,
    canTransactOn,
    cannotTransactReason: (id) => `Passkey accounts can't send transactions on chain ${id} yet.`,
    isPasskey: false,
  }),
}))

const readBridgeRouterConfig = vi.fn()
const readBridgeRoute = vi.fn()
const buildBridgeCalls = vi.fn(() => ({ calls: [{ target: '0xrouter', data: '0x', value: 0n }], requiresApproval: false }))
vi.mock('../../lib/bridge/bridgeRouter', () => ({
  readBridgeRouterConfig: (...args) => readBridgeRouterConfig(...args),
  readBridgeRoute: (...args) => readBridgeRoute(...args),
  buildBridgeCalls: (...args) => buildBridgeCalls(...args),
}))

const fetchBridgeQuote = vi.fn()
vi.mock('../../lib/bridge/acrossQuotes', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchBridgeQuote: (...args) => fetchBridgeQuote(...args) }
})

// The cohort-bounded bridge roster (#1265). This suite runs in a TESTNET build
// (`VITE_NETWORK_ID=63`), where the real roster is empty because Across ships only on
// mainnets — so every fixture below would be filtered out of the form and the suite would
// test the empty state 27 times. Declaring the roster the fixtures assume keeps the suite
// about the bridge form; `test/liquidity/cohortRosters.test.js` is what asserts the real
// roster is cohort-bounded, and `test/bridge/BridgeStatusList.test.jsx` owns the empty case.
const mockBridgeRoster = { current: [] }
vi.mock('../../lib/bridge/bridgeCopy', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, bridgeNetworks: () => mockBridgeRoster.current }
})

const getTransactionReceipt = vi.fn()
vi.mock('../../utils/rpcProvider', () => ({
  makeReadProvider: () => ({ getTransactionReceipt: (...args) => getTransactionReceipt(...args) }),
}))

const captureBridgeSubmission = vi.fn(() => 'entry-1')
// Partial: `bridgeStatus` reads BRIDGE_STATE from this same module, so the real exports
// have to stay — only the ledger WRITE is intercepted.
vi.mock('../../data/ledger/sources/bridgeLedgerSource', async (importOriginal) => ({
  ...(await importOriginal()),
  captureBridgeSubmission: (...args) => captureBridgeSubmission(...args),
}))

import BridgeView from '../../components/wallet/BridgeView'
import { buildBridgeQuote, QUOTE_VALIDITY_MS } from '../../lib/bridge/acrossQuotes'
import { SPOKE_POOL_ABI } from '../../lib/bridge/bridgeStatus'
// Fixture logs are built from the SAME fragments the module parses, via the shared viem helper —
// `Interface.encodeEventLog` has no single viem twin (spec 110). SPOKE_POOL_ABI is the parsed form.
const encodeSpokeLog = (name, values) => encodeEventLog(SPOKE_POOL_ABI, name, values)
import { BRIDGE_UNAVAILABLE, BRIDGE_SETTLEMENT } from '../../lib/bridge/bridgeCopy'

// ---- fixtures ----------------------------------------------------------------------
const USDC = {
  137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}
const GATEWAY = 'https://relay.example.test'

const usdcOption = (chainId, networkName) => ({
  key: `${chainId}:${USDC[chainId].toLowerCase()}`,
  chainId,
  kind: 'erc20',
  address: USDC[chainId],
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  networkName,
  balance: 250,
})

const POL_OPTION = {
  key: '137:native',
  chainId: 137,
  kind: 'native',
  address: null,
  symbol: 'MATIC',
  name: 'MATIC',
  decimals: 18,
  networkName: 'Polygon',
  balance: 12,
}

const BTC_OPTION = {
  key: 'bitcoin:native',
  chainId: 'bitcoin', // STRING id — spec 061; must never reach a chain-keyed call
  kind: 'btc-native',
  address: null,
  symbol: 'BTC',
  name: 'Bitcoin',
  decimals: 8,
  networkName: 'Bitcoin',
  balance: 0.5,
}

const route = (destinationChainId, overrides = {}) => ({
  routeId: `0xroute-${destinationChainId}`,
  inputToken: USDC[137],
  outputToken: USDC[destinationChainId] || USDC[42161],
  destinationChainId,
  maxAmount: 0n,
  expectedFillSeconds: 180,
  enabled: true,
  nativeInput: false,
  ...overrides,
})

const routerConfig = (routes) => ({
  routerAddress: '0x000000000000000000000000000000000000dEaD',
  spokePool: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
  feeRouter: ZeroAddress,
  sanctionsGuard: ZeroAddress,
  bridgeTransferServiceId: '0x00',
  maxFeeBps: 250,
  paused: false,
  routes,
  routesComplete: true,
})

/** A real BridgeQuote, assembled by the real quote layer from a real gateway DTO. */
function makeQuote({ feeAmount = 0n, platformFeeBps = 0, fetchedAt = Date.now(), destinationNativeBalance = null, suggested: overrides = {} } = {}) {
  const gross = 100_000_000n // 100 USDC
  const bridged = gross - feeAmount
  const totalRelayFee = 1_500_000n
  const suggested = {
    totalRelayFee: { total: totalRelayFee.toString() },
    outputAmount: (bridged - totalRelayFee).toString(),
    relayerGasFee: { total: '500000' },
    lpFee: { total: '600000' },
    relayerCapitalFee: { total: '400000' },
    quoteTimestamp: String(Math.floor(fetchedAt / 1000)),
    fillDeadline: String(Math.floor(fetchedAt / 1000) + 3600),
    exclusivityDeadline: '0',
    exclusiveRelayer: ZeroAddress,
    estimatedFillSeconds: 180,
    ...overrides,
  }
  return buildBridgeQuote({
    suggested,
    inputAmount: gross,
    feeAmount,
    platformFeeBps,
    tokenSymbol: 'USDC',
    decimals: 6,
    originChainId: 137,
    destinationChainId: 42161,
    inputToken: USDC[137],
    outputToken: USDC[42161],
    fetchedAt,
    destinationNativeBalance,
  })
}

const openSelect = async (user, label) => {
  await user.click(screen.getByRole('button', { name: label }))
  return screen.findByRole('listbox', { name: label })
}

/** The network names shown as options in an open selector. */
const optionNetworks = (listbox) =>
  within(listbox)
    .getAllByRole('option')
    .map((el) => el.textContent)

beforeEach(() => {
  vi.stubEnv('VITE_RELAYER_URL', GATEWAY)
  mockBridgeRoster.current = [
    { chainId: 137, name: 'Polygon' },
    { chainId: 42161, name: 'Arbitrum One' },
    { chainId: 8453, name: 'Base' },
  ]
  walletState.address = '0x1111111111111111111111111111111111111111'
  walletState.chainId = 137
  selectableOptions = [
    usdcOption(137, 'Polygon'),
    POL_OPTION,
    usdcOption(42161, 'Arbitrum One'),
    usdcOption(8453, 'Base'),
  ]
  portfolioHoldings = []
  sendOnChain.mockReset().mockResolvedValue({ txHash: '0xabc' })
  canTransactOn.mockReset().mockReturnValue(true)
  readBridgeRouterConfig.mockReset().mockResolvedValue(routerConfig([route(42161), route(8453)]))
  readBridgeRoute.mockReset().mockResolvedValue(route(42161))
  buildBridgeCalls.mockClear()
  fetchBridgeQuote.mockReset().mockResolvedValue(makeQuote())
  getTransactionReceipt.mockReset().mockResolvedValue({ logs: [] })
  captureBridgeSubmission.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------------------
describe('BridgeView — destination selector (T085, FR-063: the R11b inversion)', () => {
  it('offers the same asset on OTHER networks and never on the source network', async () => {
    const user = userEvent.setup()
    render(<BridgeView />)

    // The router read decides availability, so wait for it before opening the list.
    await screen.findByText(/Route availability as of/i)
    const listbox = await openSelect(user, 'Destination network')
    const shown = optionNetworks(listbox)

    // The same asset, on other networks — the whole point of a bridge.
    expect(shown.some((t) => /Arbitrum One/.test(t))).toBe(true)
    expect(shown.some((t) => /Base/.test(t))).toBe(true)
    // …and NEVER the source network. `samePair` here would leave only Polygon rows,
    // turning the bridge into a same-chain transfer that still quotes and still signs.
    expect(shown.some((t) => /Polygon/.test(t))).toBe(false)
    for (const text of shown) expect(text).toMatch(/USDC/)
  })

  it('never offers a different asset, even on a bridgeable network', async () => {
    const user = userEvent.setup()
    // MATIC is on Polygon (the pinned source network) and is a different asset besides.
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    const listbox = await openSelect(user, 'Destination network')
    expect(optionNetworks(listbox).some((t) => /MATIC/.test(t))).toBe(false)
  })

  it('offers only destinations the router has an enabled route for (FR-005/FR-051)', async () => {
    readBridgeRouterConfig.mockResolvedValue(routerConfig([route(42161), route(8453, { enabled: false })]))
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    const listbox = await openSelect(user, 'Destination network')
    const shown = optionNetworks(listbox)
    expect(shown.some((t) => /Arbitrum One/.test(t))).toBe(true)
    expect(shown.some((t) => /Base/.test(t))).toBe(false)
  })

  it('explains an empty destination list instead of showing a dead control (FR-065)', async () => {
    readBridgeRouterConfig.mockResolvedValue(routerConfig([]))
    render(<BridgeView />)
    expect(await screen.findByText(BRIDGE_UNAVAILABLE.noRoute)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Destination network' })).toBeDisabled()
  })

  it('keeps Bitcoin out of the asset list and says why (FR-006/FR-066)', async () => {
    selectableOptions = [...selectableOptions, BTC_OPTION]
    const user = userEvent.setup()
    render(<BridgeView />)
    expect(await screen.findByText(BRIDGE_UNAVAILABLE.bitcoin)).toBeInTheDocument()
    const listbox = await openSelect(user, 'Asset to send')
    expect(optionNetworks(listbox).some((t) => /BTC/.test(t))).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------
describe('BridgeQuoteCard — itemization and staleness (T079/T084, FR-007/FR-008)', () => {
  const enterAmount = async (user) => {
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
  }

  it('shows the amount received, every cost on its own line, the total, and the arrival', async () => {
    const user = userEvent.setup()
    render(<BridgeView />)
    await enterAmount(user)

    const card = await screen.findByRole('region', { name: /What this transfer costs/i })
    const q = within(card)
    expect(q.getByText(/Amount received on Arbitrum One/)).toBeInTheDocument()
    expect(q.getByText('98.5 USDC')).toBeInTheDocument() // 100 − 1.5 total relay fee
    expect(q.getByText('Bridge fee')).toBeInTheDocument()
    expect(q.getByText('1 USDC')).toBeInTheDocument() // lpFee + relayerCapitalFee
    expect(q.getByText('Delivery on the destination network')).toBeInTheDocument()
    expect(q.getByText('0.5 USDC')).toBeInTheDocument() // relayerGasFee
    expect(q.getByText('Total cost')).toBeInTheDocument()
    expect(q.getByText('1.5 USDC')).toBeInTheDocument()
    expect(q.getByText(/about 3 minutes/)).toBeInTheDocument()
    // FR-014 — the settling third party is named on the quote itself.
    expect(q.getByText(BRIDGE_SETTLEMENT.attribution, { exact: false })).toBeInTheDocument()
  })

  it('shows no FairWins fee line at all when the rate is zero (FR-029)', async () => {
    const user = userEvent.setup()
    render(<BridgeView />)
    await enterAmount(user)
    const card = await screen.findByRole('region', { name: /What this transfer costs/i })
    expect(within(card).queryByText(/FairWins fee/)).not.toBeInTheDocument()
  })

  it('shows the FairWins fee with its live rate when one is charged (FR-007)', async () => {
    fetchBridgeQuote.mockResolvedValue(makeQuote({ feeAmount: 700_000n, platformFeeBps: 70 }))
    const user = userEvent.setup()
    render(<BridgeView />)
    await enterAmount(user)
    const card = await screen.findByRole('region', { name: /What this transfer costs/i })
    // The label and its live rate are separate text nodes (the InfoTip sits between them),
    // so match on the whole term's text content.
    const feeTerm = within(card)
      .getAllByRole('term')
      .find((dt) => /FairWins fee/.test(dt.textContent))
    expect(feeTerm.textContent).toMatch(/FairWins fee \(0\.70%\)/)
    expect(within(card).getByText('0.7 USDC')).toBeInTheDocument() // the fee itself
    expect(within(card).getByText('2.2 USDC')).toBeInTheDocument() // total = 1.5 + 0.7
  })

  it('marks a cost the protocol did not return as unavailable, never as zero (FR-054)', async () => {
    // The protocol returned no LP-fee leg, so the bridge-fee line cannot be assembled.
    // The headline figures it DID return stay exactly as quoted.
    fetchBridgeQuote.mockResolvedValue(makeQuote({ suggested: { lpFee: null } }))
    const user = userEvent.setup()
    render(<BridgeView />)
    await enterAmount(user)
    const card = await screen.findByRole('region', { name: /What this transfer costs/i })
    expect(within(card).getAllByText('Not available').length).toBeGreaterThan(0)
    expect(within(card).queryByText('0 USDC')).not.toBeInTheDocument()
    expect(within(card).getByText('98.5 USDC')).toBeInTheDocument()
  })

  it('marks an expired quote stale, blocks the confirm control, and refreshes (FR-008)', async () => {
    fetchBridgeQuote.mockResolvedValue(makeQuote({ fetchedAt: Date.now() - QUOTE_VALIDITY_MS - 1_000 }))
    const user = userEvent.setup()
    render(<BridgeView />)
    await enterAmount(user)

    expect(await screen.findByText(BRIDGE_UNAVAILABLE.quoteStale)).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: /Refresh the quote to confirm/i })
    expect(confirm).toBeDisabled()

    fetchBridgeQuote.mockResolvedValue(makeQuote())
    await user.click(screen.getByRole('button', { name: /Refresh quote/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Bridge USDC$/ })).toBeEnabled())
  })

  it('discloses arriving without gas only when the balance was read as zero (T080/FR-012)', async () => {
    fetchBridgeQuote.mockResolvedValue(makeQuote({ destinationNativeBalance: 0n }))
    const user = userEvent.setup()
    render(<BridgeView />)
    await enterAmount(user)
    const card = await screen.findByRole('region', { name: /What this transfer costs/i })
    expect(within(card).getByText(/do not hold any of the destination network/i)).toBeInTheDocument()
    expect(within(card).getByText(/ETH on Arbitrum One/)).toBeInTheDocument()
  })

  it('says nothing about destination gas when the balance is unknown (FR-054)', async () => {
    const user = userEvent.setup()
    render(<BridgeView />)
    await enterAmount(user)
    const card = await screen.findByRole('region', { name: /What this transfer costs/i })
    expect(within(card).queryByText(/do not hold any of the destination network/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------------------
describe('BridgeView — signing-time network switch (T151/T152, FR-061, SC-020)', () => {
  beforeEach(() => {
    // The member's only bridgeable holding is on a network the wallet is NOT on.
    selectableOptions = [usdcOption(42161, 'Arbitrum One'), usdcOption(137, 'Polygon')]
    readBridgeRouterConfig.mockResolvedValue(
      routerConfig([route(137, { inputToken: USDC[42161], outputToken: USDC[137] })]),
    )
    readBridgeRoute.mockResolvedValue(route(137, { inputToken: USDC[42161], outputToken: USDC[137] }))
    walletState.chainId = 137
  })

  it('discloses the switch before the signature and never demands a switcher first', async () => {
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
    await screen.findByRole('region', { name: /What this transfer costs/i })

    expect(screen.getByText(/will switch to Arbitrum One when you confirm/i)).toBeInTheDocument()
    // SC-020 — no switch step stands between the member and the confirm control.
    expect(screen.queryByRole('button', { name: /^Switch to/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Bridge USDC$/ })).toBeEnabled()
  })

  it('submits on the SOURCE chain, so the switch happens at signing', async () => {
    getTransactionReceipt.mockResolvedValue({
      logs: [
        {
          ...encodeSpokeLog('V3FundsDeposited', [
            USDC[42161], USDC[137], 100_000_000n, 98_500_000n, 137, 4242,
            Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600, 0,
            walletState.address, walletState.address, ZeroAddress, '0x',
          ]),
          transactionHash: '0xabc',
        },
      ],
    })
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
    await screen.findByRole('region', { name: /What this transfer costs/i })
    await user.click(screen.getByRole('button', { name: /^Bridge USDC$/ }))

    await waitFor(() => expect(sendOnChain).toHaveBeenCalled())
    expect(sendOnChain.mock.calls[0][0]).toBe(42161) // the ASSET's network, not the wallet's
    // The quoted rate travels back as the ceiling the router enforces (FR-028).
    expect(buildBridgeCalls.mock.calls[0][0].maxFeeBps).toBe(0)
    // FR-010 — the in-flight transfer is recorded so it survives the app closing.
    await waitFor(() => expect(captureBridgeSubmission).toHaveBeenCalled())
    expect(captureBridgeSubmission.mock.calls[0][1]).toBe(42161)
    expect(captureBridgeSubmission.mock.calls[0][2].depositId).toBe('4242')
    // FR-009 — submitted is never presented as delivered.
    expect(await screen.findByText(/not delivered until Polygon/i)).toBeInTheDocument()
  })

  it('brings the confirm control back when the member starts another transfer', async () => {
    getTransactionReceipt.mockResolvedValue({
      logs: [
        {
          ...encodeSpokeLog('V3FundsDeposited', [
            USDC[42161], USDC[137], 100_000_000n, 98_500_000n, 137, 4242,
            Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600, 0,
            walletState.address, walletState.address, ZeroAddress, '0x',
          ]),
          transactionHash: '0xabc',
        },
      ],
    })
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
    await screen.findByRole('region', { name: /What this transfer costs/i })
    await user.click(screen.getByRole('button', { name: /^Bridge USDC$/ }))
    await screen.findByText(/not delivered until Polygon/i)

    await user.type(screen.getByLabelText(/^Amount/), '5')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Bridge USDC$/ })).toBeInTheDocument())
  })

  it('refuses to sign a route the operator disabled between quote and signature', async () => {
    readBridgeRoute.mockResolvedValue(null)
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
    await screen.findByRole('region', { name: /What this transfer costs/i })
    await user.click(screen.getByRole('button', { name: /^Bridge USDC$/ }))

    expect(await screen.findByText(BRIDGE_UNAVAILABLE.routeDisabled)).toBeInTheDocument()
    expect(sendOnChain).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------
describe('BridgeView — honest unavailable states (T083, FR-051/FR-053/FR-054)', () => {
  it('hides the surface with a stated reason when no gateway is configured (research R10)', async () => {
    vi.stubEnv('VITE_RELAYER_URL', '')
    render(<BridgeView />)
    expect(screen.getByText(BRIDGE_UNAVAILABLE.gateway)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Asset to send' })).not.toBeInTheDocument()
  })

  it('says Bitcoin is not part of bridging rather than going silently missing (FR-006)', () => {
    walletState.chainId = 'bitcoin'
    render(<BridgeView />)
    expect(screen.getByText(BRIDGE_UNAVAILABLE.bitcoin)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Asset to send' })).not.toBeInTheDocument()
  })

  it('withholds availability when the router cannot be read (FR-051)', async () => {
    readBridgeRouterConfig.mockResolvedValue(null)
    render(<BridgeView />)
    expect(await screen.findByText(BRIDGE_UNAVAILABLE.router)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Destination network' })).toBeDisabled()
  })

  it('says bridging is paused when the operator paused it', async () => {
    readBridgeRouterConfig.mockResolvedValue({ ...routerConfig([route(42161)]), paused: true })
    render(<BridgeView />)
    expect(await screen.findByText(BRIDGE_UNAVAILABLE.paused)).toBeInTheDocument()
  })

  it('states what would change an empty asset list rather than rendering nothing', async () => {
    selectableOptions = [BTC_OPTION]
    render(<BridgeView />)
    expect(await screen.findByText(/do not hold anything on a network this can bridge from/i)).toBeInTheDocument()
  })

  // ── Issue #1265: one roster across the form, the copy and the list underneath ─────────
  //
  // The asset CATALOG is mainnets-always and knows nothing about the build's cohort, so
  // before this the form would quote, sign and record a mainnet bridge in a testnet build
  // while the copy and `BridgeStatusList` — now cohort-bounded — stated underneath that no
  // network here bridges at all. These two pin the form to the same roster they read.

  it('does not offer an asset on a bridgeable network outside this build (#1265)', async () => {
    mockBridgeRoster.current = [{ chainId: 137, name: 'Polygon' }]
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    const listbox = await openSelect(user, 'Asset to send')
    const shown = optionNetworks(listbox)
    expect(shown.some((t) => /Polygon/.test(t))).toBe(true)
    expect(shown.some((t) => /Arbitrum One|Base/.test(t))).toBe(false)
    // FR-006c — named, with the reason that is actually true of them. "The bridge protocol
    // is not deployed there" would be false: it is, this build just does not reach it.
    expect(
      screen.getByText(/Arbitrum One, Base are not listed — this build does not bridge on those networks/i),
    ).toBeInTheDocument()
  })

  it('offers no source at all when this build bridges nowhere, and says so (#1265)', async () => {
    mockBridgeRoster.current = []
    render(<BridgeView />)
    expect(
      await screen.findByText(/No network is set up for bridging in this build yet/i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Asset to send' })).not.toBeInTheDocument()
    // …and the fallback is never the OTHER sentence, which would name networks this build
    // will not bridge from and invite the member to fund one of them.
    expect(
      screen.queryByText(/do not hold anything on a network this can bridge from/i),
    ).not.toBeInTheDocument()
  })

  it('reports a failed quote by its real cause and offers a retry when it is transient', async () => {
    const err = Object.assign(new Error('nope'), { code: 'fee_unavailable', retryable: true, disabled: false })
    fetchBridgeQuote.mockRejectedValue(err)
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
    expect(await screen.findByText(BRIDGE_UNAVAILABLE.fees)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------------------
describe('BridgeView — one quote per input change (issue #1027)', () => {
  // The hook seams above hand back fresh object identities on every render, like the real
  // hooks do. Pre-fix, the quote debounce was keyed on `loadQuote`'s identity, so every
  // quote completion re-rendered, re-armed the timer, and fetched again — an endless loop
  // that flickered between "Getting a price…" and the unavailable copy. These tests pin
  // the fix: the debounce is keyed on the quote's INPUTS, so a settled state stays put.

  it('holds a failed quote steady instead of looping between loading and unavailable', async () => {
    const err = Object.assign(new Error('gateway unreachable'), {
      code: 'network_error',
      retryable: true,
      disabled: false,
    })
    fetchBridgeQuote.mockRejectedValue(err)
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')

    expect(await screen.findByText(BRIDGE_UNAVAILABLE.gateway)).toBeInTheDocument()
    const callsAfterFailure = fetchBridgeQuote.mock.calls.length

    // Give a re-render-driven loop more than a full debounce window (400ms) to refire.
    // Nothing periodic runs in the error state, so just past the debounce is enough.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(fetchBridgeQuote.mock.calls.length).toBe(callsAfterFailure)
    expect(screen.getByText(BRIDGE_UNAVAILABLE.gateway)).toBeInTheDocument()
    expect(screen.queryByText(/Getting a price/i)).not.toBeInTheDocument()
  })

  it('fetches exactly one quote for a typed amount despite unstable hook identities', async () => {
    const user = userEvent.setup()
    render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
    await screen.findByRole('region', { name: /What this transfer costs/i })

    // The countdown re-renders every second while a quote is on screen; none of those
    // renders may turn into another fetch while the inputs are unchanged. The full
    // second is load-bearing here: a shorter wait would never span a countdown tick,
    // and the tick is exactly the re-render this test exists to prove harmless.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(fetchBridgeQuote).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------------------
describe('BridgeView — accessibility (WCAG 2.1 AA)', () => {
  it('has no violations with a quote on screen', async () => {
    const user = userEvent.setup()
    const { container } = render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await user.type(screen.getByLabelText(/^Amount/), '100')
    await screen.findByRole('region', { name: /What this transfer costs/i })
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no violations in the unavailable state', async () => {
    vi.stubEnv('VITE_RELAYER_URL', '')
    const { container } = render(<BridgeView />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no violations with the destination list open', async () => {
    const user = userEvent.setup()
    const { container } = render(<BridgeView />)
    await screen.findByText(/Route availability as of/i)
    await openSelect(user, 'Destination network')
    expect(await axe(container)).toHaveNoViolations()
  })
})
