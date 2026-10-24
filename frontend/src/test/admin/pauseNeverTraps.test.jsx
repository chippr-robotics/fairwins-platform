/**
 * Spec 067 T134 (FR-043) — a pause stops new value going in, and traps none that is already in.
 *
 * The two surfaces fail in different ways if this is got wrong, so they are asserted separately:
 *
 *   BRIDGE — a paused router must not imply anything about transfers already moving. Across
 *   settles them directly to the member with the router nowhere in the path, so the pause cannot
 *   reach them, and the Operations panel keeps reporting them while the pause is on.
 *
 *   SUPPLY — a paused router must not imply that positions are stuck. Withdrawing never routed
 *   through this contract in the first place; the member owns the position NFT and exits through
 *   Uniswap directly. And a RETIRED pool must still be listed while paused, because that is the
 *   state in which a member most needs to find their position (FR-024).
 *
 * The last test pins the structural half of the same promise: the frontend ABI carries no
 * `removePool` fragment, because the contract deliberately has no such function — retirement is
 * `setPoolEnabled(false)` precisely so a pool holding member money can never be erased.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { LIQUIDITY_ROUTER_ABI } from '../../abis/LiquidityRouter'
import { BRIDGE_ROUTER_ABI } from '../../abis/BridgeRouter'
import { POOL_KIND } from '../../lib/liquidity/liquidityRouter'

const m = vi.hoisted(() => ({ reads: {}, events: {}, paused: true }))

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: (name) =>
    name === 'bridgeRouter' || name === 'liquidityRouter'
      ? '0x1111111111111111111111111111111111111111'
      : '',
}))
vi.mock('../../config/blockExplorer', () => ({
  getBlockscoutUrl: () => '',
  getTransactionUrl: () => 'https://explorer.example/tx/0xdead',
}))
vi.mock('../../lib/fees/feeQuote', async (orig) => ({
  ...(await orig()),
  fetchFeeQuote: vi.fn(() => Promise.resolve({ available: false, bps: 0, capBps: 0 })),
}))
vi.mock('../../hooks/useGatewayStatus', () => ({
  useGatewayStatus: () => ({ configured: false, loading: false, reachable: false, status: null, refresh: vi.fn() }),
}))
vi.mock('../../lib/bridge/bridgeStatus', async (orig) => ({
  ...(await orig()),
  fetchBridgeStatus: vi.fn(() => Promise.reject(new Error('no gateway'))),
}))
/**
 * Reads and event scans through the one chain seam (spec 110). The `vi.mock('ethers')` this
 * replaces stopped intercepting anything the moment these tabs left ethers — a mock that guards
 * nothing while still looking like a guard, which `src/test/lint/ethersMockRatchet.test.js` now
 * fails on.
 */
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: (_chainId, { functionName, args = [] }) =>
      (m.reads[functionName] ? m.reads[functionName](...args) : Promise.resolve(undefined)),
  }
})

vi.mock('../../lib/chains/eventScan', () => ({
  eventScanHandle: (_chainId, { address }) => ({
    target: address,
    provider: {
      getBlockNumber: async () => 1_000_000,
      getLogs: async ({ topics }) => (m.events[topics?.__event] || []).map((e) => ({ ...e })),
    },
    filters: new Proxy(
      {},
      { get: (_f, name) => () => ({ getTopicFilter: () => ({ __event: String(name) }) }) },
    ),
    interface: { parseLog: (log) => ({ name: log.__name, args: log.args || {} }) },
  }),
}))

vi.mock('../../lib/chains/publicClient', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    getPublicClient: () => ({ getBlock: async () => ({ timestamp: 0n }) }),
  }
})

import BridgeTab from '../../components/admin/BridgeTab'
import SupplyTab from '../../components/admin/SupplyTab'

const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const VALID = '0x00000000000000000000000000000000000000a1'

const ROUTE = {
  inputToken: USDC_ETH,
  outputToken: USDC_ETH,
  destinationChainId: 137n,
  maxAmount: 0n,
  expectedFillSeconds: 900n,
  enabled: true,
  nativeInput: false,
}
const RETIRED_POOL = {
  kind: BigInt(POOL_KIND.TRADING_LP),
  enabled: false,
  feeTier: 500n,
  token0: USDC_ETH,
  token1: WETH,
  poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
  maxDeposit0PerTx: 0n,
  maxDeposit1PerTx: 0n,
}

const providerStub = {
  getBlockNumber: () => Promise.resolve(1_000_000),
  getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) - 30 }),
  getTransactionReceipt: () => Promise.resolve(null),
}

const tabProps = (overrides = {}) => ({
  signer: {},
  chainId: 1,
  provider: providerStub,
  runTx: vi.fn(() => Promise.resolve()),
  pendingTx: false,
  isAdmin: true,
  isLiquidityAdmin: true,
  isGuardian: true,
  ...overrides,
})

beforeEach(() => {
  m.events = {}
  m.reads = {
    // Both routers are PAUSED for every test in this file.
    paused: () => Promise.resolve(true),
    MAX_FEE_BPS: () => Promise.resolve(250n),
    spokePool: () => Promise.resolve(VALID),
    feeRouter: () => Promise.resolve(VALID),
    positionManager: () => Promise.resolve(VALID),
    sanctionsGuard: () => Promise.resolve(VALID),
    routeCount: () => Promise.resolve(1n),
    routeAt: () => Promise.resolve('0xroute1'),
    getRoute: () => Promise.resolve(ROUTE),
    poolCount: () => Promise.resolve(1n),
    poolAt: () => Promise.resolve('0xpool1'),
    getPool: () => Promise.resolve(RETIRED_POOL),
  }
})

describe('a paused BridgeRouter stops new bridges and reaches no moving one', () => {
  it('says exactly that in the status line and on the control', async () => {
    render(<BridgeTab {...tabProps()} />)
    expect(
      await screen.findByText(/PAUSED — no new bridges start\. Transfers already moving are unaffected\./),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume bridging' })).toBeInTheDocument()

    const pauseCard = screen.getByText('Emergency pause').closest('.admin-card')
    expect(pauseCard.textContent).toMatch(/cannot touch a transfer already moving/i)
    expect(pauseCard.textContent).toMatch(/a pause never traps member value/i)
    // FR-044: the pause does not depend on optional infrastructure being healthy.
    expect(pauseCard.textContent).toMatch(/no dependency on the gateway or any other optional service/i)
  })

  it('keeps reporting an in-flight transfer while paused', async () => {
    m.events.BridgeInitiated = [
      {
        blockNumber: 999_000,
        index: 0,
        transactionHash: '0xdead',
        args: {
          routeId: '0xroute1',
          member: VALID,
          recipient: VALID,
          destinationChainId: 137n,
          grossAmount: 1_000_000n,
          feeAmount: 0n,
        },
      },
    ]
    render(<BridgeTab {...tabProps()} />)
    const table = await screen.findByRole('table', { name: 'Recent bridges' })
    // Started 30s ago against a 15-minute window: still on its way, pause or no pause.
    expect(within(table).getByText('Sent')).toBeInTheDocument()
    expect(screen.getByText(/This panel is observational only\./)).toBeInTheDocument()
  })

  it('offers no control that claims to recall or refund one', () => {
    // The contract has no such function, so no button may suggest it exists.
    expect(BRIDGE_ROUTER_ABI.some((f) => /rescue|recall|refund|cancelDeposit/i.test(f))).toBe(false)
  })
})

describe('a paused LiquidityRouter leaves every position withdrawable', () => {
  it('says positions are untouched and still withdrawable', async () => {
    render(<SupplyTab {...tabProps()} />)
    expect(
      await screen.findByText(/PAUSED — no new Uniswap supplies\. Existing positions are untouched and still withdrawable\./),
    ).toBeInTheDocument()
    const pauseCard = screen.getByText('Emergency pause').closest('.admin-card')
    expect(pauseCard.textContent).toMatch(/Nothing here can trap member value/i)
    expect(pauseCard.textContent).toMatch(/withdrawing never went through this router in the first place/i)
  })

  it('still lists a retired pool while paused — that is when it is most needed', async () => {
    render(<SupplyTab {...tabProps()} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    expect(within(table).getByText(/RETIRED — closed to new deposits, still withdrawable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
  })

  it('has no way to remove a pool at all — retirement is the only exit from the list', () => {
    expect(LIQUIDITY_ROUTER_ABI.some((f) => /removePool/.test(f))).toBe(false)
    expect(LIQUIDITY_ROUTER_ABI.some((f) => /setPoolEnabled/.test(f))).toBe(true)
    // Nor is there any withdrawal entrypoint: exits never route through the router, so no
    // router state — paused, retired, or misconfigured — can stand between a member and theirs.
    expect(LIQUIDITY_ROUTER_ABI.some((f) => /function (withdraw|burn|collect|decreaseLiquidity)/i.test(f))).toBe(false)
  })
})
