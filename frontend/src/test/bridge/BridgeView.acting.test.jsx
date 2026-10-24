/**
 * BridgeView — the account switcher and this surface must never disagree (spec 088 FR-001/FR-002).
 *
 * Every read and every write in BridgeView belongs to the CONNECTED wallet: the asset roster, the
 * balance behind Max, the screened address, the `recipient` baked into the Across deposit, the
 * ledger entry, and — through `useEarnSend.sendOnChain` — the signature itself. None of it consults
 * the acting account. So while the switcher shows a vault, a recovered or a hardware account, the
 * pre-fix behaviour was to quote, sign and record a bridge of the CONNECTED wallet's money under
 * that account's name, with nothing on screen saying so.
 *
 * This suite pins the refusal, and the two halves of it are different claims:
 *   1. THE SURFACE IS WITHHELD, with a reason naming the acting account and the way out. Leaving
 *      the form up with a disabled button would still show the connected wallet's assets and
 *      balances under the acting account's label — the FR-001 half of the same bug.
 *   2. NOTHING IS SIGNED. `sendOnChain` is never called and no ledger entry is written, whatever
 *      the member does.
 * And the third, which is what stops the fix from being a regression: a PERSONAL member's bridge
 * is untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ZeroAddress } from 'ethers'

// ---- seams (mirrors test/bridge/BridgeView.screening.test.jsx) -----------------------
const walletState = { address: '0x1111111111111111111111111111111111111111', chainId: 137 }
let selectableOptions = []
const sendOnChain = vi.fn()

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletState }))
vi.mock('../../hooks/useSelectableAssets', () => ({
  useSelectableAssets: () => ({ options: selectableOptions, defaultKey: null, isGasless: () => false }),
}))
vi.mock('../../hooks/usePortfolio', () => ({ default: () => ({ holdings: [], status: 'ready' }) }))
vi.mock('../../hooks/useEarnSend', () => ({
  useEarnSend: () => ({
    sendOnChain,
    canTransactOn: () => true,
    cannotTransactReason: () => 'nope',
    isPasskey: false,
  }),
}))
vi.mock('../../hooks/useAddressScreening', () => ({
  useAddressScreening: () => ({
    screenOne: vi.fn(async () => 'clear'),
    getStatus: () => 'clear',
    screen: vi.fn(),
    anyRestricted: () => false,
  }),
}))

/**
 * The acting identity, driven per test. Mocked at `useEffectiveAccount` — the ONE hook FR-001
 * names as the resolver — rather than at CustodyContext, so the test asserts on the seam the
 * requirement is written about instead of on how the provider happens to store it today.
 */
let acting = { type: 'personal', address: null, label: null, isActingAccount: false }
vi.mock('../../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => acting,
  default: () => acting,
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

vi.mock('../../utils/rpcProvider', () => ({
  makeReadProvider: () => ({ getTransactionReceipt: vi.fn(async () => ({ logs: [] })) }),
}))

// This suite runs in a TESTNET build, where the real cohort-bounded roster (#1265) is empty and
// every mainnet fixture below would be filtered out, leaving nothing to refuse. Declare the roster
// the fixtures assume; its own cohort bounding is asserted by test/liquidity/cohortRosters.test.js.
vi.mock('../../lib/bridge/bridgeCopy', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    bridgeNetworks: () => [
      { chainId: 137, name: 'Polygon' },
      { chainId: 42161, name: 'Arbitrum One' },
    ],
  }
})

const captureBridgeSubmission = vi.fn(() => 'entry-1')
vi.mock('../../data/ledger/sources/bridgeLedgerSource', async (importOriginal) => ({
  ...(await importOriginal()),
  captureBridgeSubmission: (...args) => captureBridgeSubmission(...args),
}))

import BridgeView from '../../components/wallet/BridgeView'

// ---- fixtures -----------------------------------------------------------------------
const USDC = {
  137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
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

const route = (destinationChainId) => ({
  routeId: `0xroute-${destinationChainId}`,
  inputToken: USDC[137],
  outputToken: USDC[destinationChainId],
  destinationChainId,
  maxAmount: 0n,
  expectedFillSeconds: 180,
  enabled: true,
  nativeInput: false,
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

beforeEach(() => {
  vi.stubEnv('VITE_RELAYER_URL', GATEWAY)
  acting = { type: 'personal', address: null, label: null, isActingAccount: false }
  walletState.address = '0x1111111111111111111111111111111111111111'
  walletState.chainId = 137
  selectableOptions = [usdcOption(137, 'Polygon'), usdcOption(42161, 'Arbitrum One')]
  sendOnChain.mockReset().mockResolvedValue({ txHash: '0xabc' })
  readBridgeRouterConfig.mockReset().mockResolvedValue(routerConfig([route(42161)]))
  readBridgeRoute.mockReset().mockResolvedValue(route(42161))
  buildBridgeCalls.mockClear()
  fetchBridgeQuote.mockReset()
  captureBridgeSubmission.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// =====================================================================================
describe('BridgeView — acting as a non-personal account (spec 088 FR-001/FR-002)', () => {
  const kinds = [
    ['hardware', { type: 'hardware', address: '0xHardware', label: 'Ledger Nano', isActingAccount: true }, /hardware account|Ledger Nano/i],
    ['legacy (recovered)', { type: 'legacy', address: '0xLegacy', label: null, isActingAccount: true }, /recovered account/i],
    ['vault', { type: 'vault', address: '0xVault', label: 'Ops vault', isActingAccount: true }, /Ops vault/i],
    ['derived', { type: 'derived', address: '0xDerived', label: null, isActingAccount: true }, /recovered account/i],
  ]

  it.each(kinds)('withholds the bridge form and says why while acting as %s', async (_name, identity, names) => {
    acting = identity
    render(<BridgeView />)

    const refusal = await screen.findByTestId('bridge-acting-refusal')
    // It names the account, so the member can tell which of their accounts it means…
    expect(refusal).toHaveTextContent(names)
    // …says what would change it…
    expect(refusal).toHaveTextContent(/switch back to acting as yourself/i)
    // …and does not read as an outage: nothing is broken and nothing already sent is affected.
    expect(refusal).toHaveTextContent(/nothing has been sent/i)
    expect(refusal).toHaveTextContent(/transfers already on their way are unaffected/i)

    // The FR-001 half: no form, so no connected-wallet balance can be shown under this label.
    expect(screen.queryByLabelText(/^Amount/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Bridge USDC/i })).toBeNull()
  })

  it.each(kinds)('signs nothing and records nothing while acting as %s', async (_name, identity) => {
    acting = identity
    render(<BridgeView />)
    await screen.findByTestId('bridge-acting-refusal')

    expect(sendOnChain).not.toHaveBeenCalled()
    expect(buildBridgeCalls).not.toHaveBeenCalled()
    expect(captureBridgeSubmission).not.toHaveBeenCalled()
    // Not even priced: a quote is a claim about a transfer this member cannot make here.
    expect(fetchBridgeQuote).not.toHaveBeenCalled()
  })

  it('refuses BEFORE it blames the network — an acting account is not a bridge outage', async () => {
    acting = { type: 'vault', address: '0xVault', label: 'Ops vault', isActingAccount: true }
    vi.stubEnv('VITE_RELAYER_URL', '') // the gateway is also down
    render(<BridgeView />)

    const refusal = await screen.findByTestId('bridge-acting-refusal')
    expect(refusal).toHaveTextContent(/Ops vault/i)
    // The gateway copy would be true too, but it is not the reason this member cannot bridge, and
    // telling them to "try again shortly" about a state that will never resolve is a false promise.
    expect(refusal).not.toHaveTextContent(/try again shortly/i)
  })

  it('leaves the personal member’s bridge exactly as it was', async () => {
    acting = { type: 'personal', address: walletState.address, label: null, isActingAccount: false }
    render(<BridgeView />)

    await screen.findByText(/Route availability as of/i)
    expect(screen.queryByTestId('bridge-acting-refusal')).toBeNull()
    expect(screen.getByLabelText(/^Amount/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Bridge USDC/i })).toBeInTheDocument()
  })
})
