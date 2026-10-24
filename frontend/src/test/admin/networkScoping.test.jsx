/**
 * Spec 067 T157 (FR-050) — control state and history are scoped PER NETWORK, and nothing leaks
 * across the boundary.
 *
 * The two failures this guards against are opposite and both silent:
 *
 *   1. **Under-reading** — gating the tab on the connected chain, so an operator on Polygon is
 *      told there are no Ethereum routes. Earlier phases of this spec did exactly that; the tabs
 *      read every capable network from its own RPC instead, and each is a separate scope.
 *
 *   2. **Over-reading** — carrying one network's routes, pools, addresses, limits or history into
 *      another's view. There is no shared cache and no merged list: switching scope re-reads from
 *      the router address configured for THAT chain, and only that one is ever contacted.
 *
 * The second is what makes the testnet/mainnet half of FR-050 true: a testnet router is never
 * queried while a mainnet is in scope, so no testnet control state can reach a mainnet surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const m = vi.hoisted(() => ({ addr: {}, byAddr: {}, constructed: [], readCalls: [] }))

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: (name, chainId) =>
    name === 'bridgeRouter' || name === 'liquidityRouter' ? m.addr[Number(chainId)] || '' : '',
}))
vi.mock('../../config/blockExplorer', () => ({
  getBlockscoutUrl: () => '',
  getTransactionUrl: () => '',
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
// Every read is keyed by the CONTRACT ADDRESS the tab constructed, so a value from one network's
// router can only appear on screen if the tab actually asked that router for it.
// Spec 071 (T010): estate reads now resolve providers via `getReadProvider(chainId)` rather than
// hand-building one from `NETWORKS[chainId].rpcUrl`, so the member's own endpoint and failover
// apply. Both names are stubbed here — the assertions below are unchanged, and still key every
// read on the CONTRACT ADDRESS the tab constructed.
const fakeProvider = () => ({
  getBlockNumber: () => Promise.resolve(1_000_000),
  getBlock: () => Promise.resolve({ timestamp: 0 }),
  getTransactionReceipt: () => Promise.resolve(null),
})
vi.mock('../../utils/rpcProvider', () => ({
  makeReadProvider: () => fakeProvider(),
  getReadProvider: () => fakeProvider(),
}))
/**
 * Every read is keyed by the CONTRACT ADDRESS the tab asked, so a value from one network's router
 * can only appear on screen if the tab actually asked THAT router for it.
 *
 * That was the design before spec 110 too — but it was enforced through a fake `ethers.Contract`
 * that received the address as a constructor argument and, like every such fake, was free to
 * ignore it. Now the address arrives on each call and so does the CHAIN, so both are recorded.
 */
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: (chainId, { address, functionName, args = [] }) => {
      m.constructed.push(address)
      m.readCalls.push({ chainId, address, functionName })
      const reads = m.byAddr[address] || {}
      return reads[functionName] ? reads[functionName](...args) : Promise.resolve(undefined)
    },
  }
})

vi.mock('../../lib/chains/eventScan', () => ({
  eventScanHandle: (chainId, { address }) => {
    m.constructed.push(address)
    m.readCalls.push({ chainId, address, functionName: '<scan>' })
    return {
      target: address,
      provider: {
        getBlockNumber: async () => 1_000_000,
        getLogs: async () => [],
      },
      filters: new Proxy(
        {},
        { get: (_f, name) => () => ({ getTopicFilter: () => ({ __event: String(name) }) }) },
      ),
      interface: { parseLog: (log) => ({ name: log.__name, args: log.args || {} }) },
    }
  },
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
import { POOL_KIND } from '../../lib/liquidity/liquidityRouter'

const ETH_ROUTER = '0x1111111111111111111111111111111111111111'
const POLY_ROUTER = '0x2222222222222222222222222222222222222222'
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_POLY = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'

const providerStub = {
  getBlockNumber: () => Promise.resolve(1_000_000),
  getBlock: () => Promise.resolve({ timestamp: 0 }),
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

const routerReads = (extra) => ({
  paused: () => Promise.resolve(false),
  MAX_FEE_BPS: () => Promise.resolve(250n),
  ...extra,
})

beforeEach(() => {
  m.addr = { 1: ETH_ROUTER, 137: POLY_ROUTER }
  m.constructed = []
  m.readCalls = []
})

describe('Bridge control state is per network', () => {
  beforeEach(() => {
    m.byAddr = {
      [ETH_ROUTER]: routerReads({
        spokePool: () => Promise.resolve('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'),
        routeCount: () => Promise.resolve(1n),
        routeAt: () => Promise.resolve('0xeth-route'),
        getRoute: () =>
          Promise.resolve({
            inputToken: USDC_ETH,
            outputToken: USDC_POLY,
            destinationChainId: 137n,
            maxAmount: 1_000_000n,
            expectedFillSeconds: 900n,
            enabled: true,
            nativeInput: false,
          }),
      }),
      [POLY_ROUTER]: routerReads({
        spokePool: () => Promise.resolve('0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096'),
        routeCount: () => Promise.resolve(1n),
        routeAt: () => Promise.resolve('0xpoly-route'),
        getRoute: () =>
          Promise.resolve({
            inputToken: WMATIC,
            outputToken: WETH,
            destinationChainId: 1n,
            maxAmount: 0n,
            expectedFillSeconds: 1800n,
            enabled: false,
            nativeInput: true,
          }),
      }),
    }
  })

  it('shows only the scoped network’s routes, and swaps them wholesale on switch', async () => {
    render(<BridgeTab {...tabProps()} />)
    const table = await screen.findByRole('table', { name: 'Curated bridge routes' })
    expect(within(table).getByText('Ethereum → Polygon')).toBeInTheDocument()
    expect(within(table).queryByText('Polygon → Ethereum')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: '137' } })
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Curated bridge routes' })).getByText('Polygon → Ethereum'),
      ).toBeInTheDocument(),
    )
    // The first network's route is GONE, not merged in beneath the second's.
    expect(
      within(screen.getByRole('table', { name: 'Curated bridge routes' })).queryByText('Ethereum → Polygon'),
    ).not.toBeInTheDocument()
  })

  it('contacts only the router deployed on the network in scope', async () => {
    render(<BridgeTab {...tabProps()} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })
    expect(m.constructed).toContain(ETH_ROUTER)
    expect(m.constructed).not.toContain(POLY_ROUTER)

    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: '137' } })
    await waitFor(() => expect(m.constructed).toContain(POLY_ROUTER))
  })

  it('reads a network the wallet is not on, and says changes need the wallet there', async () => {
    // The wallet is on Polygon; the scope opens there, and Ethereum is still fully readable.
    render(<BridgeTab {...tabProps({ chainId: 137 })} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })
    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: '1' } })
    await waitFor(() =>
      expect(screen.getByText(/You are reading Ethereum while your wallet is on Polygon/i)).toBeInTheDocument(),
    )
    expect(
      within(screen.getByRole('table', { name: 'Curated bridge routes' })).getByText('Ethereum → Polygon'),
    ).toBeInTheDocument()
  })

  it('treats a network with no deployment as its own honest state, not the other’s', async () => {
    m.addr = { 1: ETH_ROUTER }
    render(<BridgeTab {...tabProps()} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })
    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: '137' } })
    await waitFor(() =>
      expect(screen.getByText(/No BridgeRouter is deployed on Polygon/i)).toBeInTheDocument(),
    )
    expect(screen.queryByRole('table', { name: 'Curated bridge routes' })).not.toBeInTheDocument()
  })
})

describe('Supply control state is per network', () => {
  beforeEach(() => {
    m.byAddr = {
      [ETH_ROUTER]: routerReads({
        positionManager: () => Promise.resolve('0xC36442b4a4522E871399CD717aBDD847Ab11FE88'),
        poolCount: () => Promise.resolve(1n),
        poolAt: () => Promise.resolve('0xeth-pool'),
        getPool: () =>
          Promise.resolve({
            kind: BigInt(POOL_KIND.BRIDGE_LP),
            enabled: true,
            feeTier: 0n,
            token0: USDC_ETH,
            token1: '0x0000000000000000000000000000000000000000',
            poolAddress: '0xc186fA914353c44b2E33eBE05f21846F1048bEda',
            maxDeposit0PerTx: 0n,
            maxDeposit1PerTx: 0n,
          }),
      }),
      [POLY_ROUTER]: routerReads({
        positionManager: () => Promise.resolve('0xC36442b4a4522E871399CD717aBDD847Ab11FE88'),
        poolCount: () => Promise.resolve(1n),
        poolAt: () => Promise.resolve('0xpoly-pool'),
        getPool: () =>
          Promise.resolve({
            kind: BigInt(POOL_KIND.TRADING_LP),
            enabled: true,
            feeTier: 500n,
            token0: USDC_POLY,
            token1: WMATIC,
            poolAddress: '0xa374094527e1673a86de625aa59517c5de346d32',
            maxDeposit0PerTx: 0n,
            maxDeposit1PerTx: 0n,
          }),
      }),
    }
  })

  it('does not carry one network’s pools into another’s list', async () => {
    render(<SupplyTab {...tabProps()} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    // Ethereum is the only network with an Across HubPool (research R8) — its bridge pool must
    // not follow the operator to Polygon.
    expect(within(table).getByText(/Bridge pool \(Across\)/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: '137' } })
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Curated pools' })).getByText(/Trading pool \(Uniswap V3\)/),
      ).toBeInTheDocument(),
    )
    expect(
      within(screen.getByRole('table', { name: 'Curated pools' })).queryByText(/Bridge pool \(Across\)/),
    ).not.toBeInTheDocument()
  })

  it('contacts only the router deployed on the network in scope', async () => {
    render(<SupplyTab {...tabProps()} />)
    await screen.findByRole('table', { name: 'Curated pools' })
    expect(m.constructed).toContain(ETH_ROUTER)
    expect(m.constructed).not.toContain(POLY_ROUTER)
  })
})
