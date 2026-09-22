/**
 * Spec 067 US4 (T123–T126, T130–T132, T135) — the BridgeTab operator control surface (AdminPanel → Liquidity → Bridge).
 *
 * What is asserted here is deliberately weighted toward the claims the tab MAKES, not just the
 * calls it dispatches: the Operations panel saying it cannot touch an in-flight bridge, the fee
 * card refusing to invent a rate it could not read, and the per-network scope working while the
 * wallet sits somewhere else. Those are the parts an operator acts on during an incident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ethers as ethersActual } from 'ethers'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe } from 'vitest-axe'

const m = vi.hoisted(() => ({
  scanCalls: [],
  readCalls: [],
  blockTimestamp: null,
  counts: {},
  scanFails: null,
  addr: {},
  reads: {},
  events: {},
  receipts: {},
  gateway: {},
  feeQuote: null,
  feeThrows: null,
  status: null,
}))

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: (name, chainId) => {
    if (name === 'bridgeRouter') return m.addr[Number(chainId)] || ''
    // The FeeRouter THIS BUILD is compiled against. The tab compares it with the one the router
    // actually holds, so the two have to be separately controllable here.
    if (name === 'feeRouter') return m.configFeeRouter
    return ''
  },
}))
vi.mock('../../config/blockExplorer', () => ({
  getBlockscoutUrl: () => 'https://explorer.example/address/0xrouter',
  getTransactionUrl: () => 'https://explorer.example/tx/0xdead',
}))
vi.mock('../../lib/fees/feeQuote', async (orig) => ({
  ...(await orig()),
  fetchFeeQuote: vi.fn(() => (m.feeThrows ? Promise.reject(m.feeThrows) : Promise.resolve(m.feeQuote))),
}))
vi.mock('../../hooks/useGatewayStatus', () => ({
  useGatewayStatus: () => ({ refresh: vi.fn(), ...m.gateway }),
}))
vi.mock('../../lib/bridge/bridgeStatus', async (orig) => ({
  ...(await orig()),
  fetchBridgeStatus: vi.fn(() => (m.status ? Promise.resolve(m.status) : Promise.reject(new Error('no gateway')))),
}))

// The router AUTHORITY read (`hasRole`) moved onto the spec-110 chain seam; the tab's own router
// reads still go through the contract mock above. Both serve `m.reads`, so a test's seed is unchanged.
/**
 * EVERY router read the tab makes, through the one chain seam.
 *
 * The `vi.mock('ethers')` this replaces had stopped intercepting anything once the tab left
 * ethers — the retired-mock shape `src/test/lint/ethersMockRatchet.test.js` exists to catch. It
 * mattered more than usual here: the per-read COUNTER lived in that fake, and the refetch-loop
 * regression test at the bottom of this file asserts on it. Left behind, that test would have
 * counted nothing while still looking like a guard.
 *
 * It records the CHAIN too, which the fake could not: it was handed a `runner` and the chain lived
 * inside it, so a read against the wrong network's endpoint passed every assertion in this file —
 * on a tab whose entire purpose is reading one network while the wallet sits on another.
 */
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: (chainId, { address, functionName, args = [] }) => {
      m.counts[functionName] = (m.counts[functionName] || 0) + 1
      m.readCalls.push({ chainId, address, functionName, args })
      return m.reads[functionName] ? m.reads[functionName](...args) : Promise.resolve(undefined)
    },
  }
})

/**
 * The event scans (history + operations) moved onto the spec-110 chain seam.
 *
 * `m.events` is keyed by EVENT NAME exactly as before, so every test's seed is unchanged — what is
 * new is that the mock records the CHAIN each scan was made on. The ethers fake it replaces got
 * its chain from a `runner` object, so a scan against the wrong network's endpoint passed every
 * assertion in this file, on a tab whose whole purpose is reading one network while the wallet
 * sits on another.
 */
vi.mock('../../lib/chains/eventScan', () => ({
  eventScanHandle: (chainId, { address }) => {
    m.scanCalls.push({ chainId, address })
    return {
      target: address,
      provider: {
        getBlockNumber: async () => 1_000_000,
        // The seam hands `getLogsRange` a reader; the name rides on the topic filter so one stub
        // can answer per event, exactly as the old `queryFilter` stub did.
        getLogs: async ({ topics }) => {
          // A seeded rejection stands in for an RPC that refuses the range — the path that must
          // report the scan as UNREADABLE rather than as zero.
          if (m.scanFails) throw m.scanFails
          return (m.events[topics?.__event] || []).map((e) => ({ ...e }))
        },
      },
      filters: new Proxy(
        {},
        {
          get: (_f, name) => () => ({ getTopicFilter: () => ({ __event: String(name) }) }),
        },
      ),
      // Logs are seeded already decoded — the seam's own parseLog has its own suite.
      interface: { parseLog: (log) => ({ name: log.__name, args: log.args || {} }) },
    }
  },
}))

vi.mock('../../lib/chains/publicClient', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    getPublicClient: (chainId) => ({
      // Block timestamps come from the SCOPED chain's client now, not from the wallet's provider,
      // so "this happened two hours ago" is seeded here.
      getBlock: async () => ({
        timestamp: BigInt(m.blockTimestamp ?? Math.floor(Date.now() / 1000) - 60),
      }),
      __chainId: chainId,
    }),
  }
})

import BridgeTab from '../../components/admin/BridgeTab'

const ROUTER = '0x1111111111111111111111111111111111111111'
const VALID = '0x00000000000000000000000000000000000000a1' // lowercase ⇒ checksum-safe
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

const ROUTE_TO_POLYGON = {
  routeId: `0x${'a1'.repeat(32)}`,
  inputToken: USDC_ETH,
  outputToken: USDC_POLYGON,
  destinationChainId: 137n,
  maxAmount: 5_000_000_000n, // 5,000 USDC
  expectedFillSeconds: 900n,
  enabled: true,
  nativeInput: false,
}
const ROUTE_TO_BASE = {
  routeId: `0x${'a2'.repeat(32)}`,
  inputToken: USDC_ETH,
  outputToken: USDC_ETH,
  destinationChainId: 8453n,
  maxAmount: 0n,
  expectedFillSeconds: 600n,
  enabled: false,
  nativeInput: false,
}

const providerStub = {
  getBlockNumber: () => Promise.resolve(1_000_000),
  getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) - 60 }),
  getTransactionReceipt: (hash) => Promise.resolve(m.receipts[hash] || null),
}


/** `runTx` resolves true on success — callers that send a sequence rely on the signal. */
const TX_OK = true
const ACCOUNT = '0x9999999999999999999999999999999999999999'
const ROLE_HASH = {
  admin: ethersActual.ZeroHash,
  guardian: ethersActual.id('GUARDIAN_ROLE'),
  liquidityAdmin: ethersActual.id('LIQUIDITY_ADMIN_ROLE'),
}

function props(overrides = {}) {
  const runTx = vi.fn(() => Promise.resolve(TX_OK))
  // ── ROLE FLAGS ARE TRANSLATED INTO ON-CHAIN ANSWERS, NOT PASSED AS PROPS ──────────────────────
  // The tab asks the router in scope `hasRole(...)` rather than trusting an app-wide flag, because
  // the flags were resolved against the wrong contract and the wrong network (see
  // readRouterAuthority). Call sites keep the readable `{ isGuardian: true }` shape; what it now
  // means is "the router says so", which is the thing that actually gates the control.
  const { isAdmin = false, isLiquidityAdmin = false, isGuardian = false, ...node } = overrides
  const held = []
  if (isAdmin) held.push(ROLE_HASH.admin)
  if (isGuardian) held.push(ROLE_HASH.guardian)
  if (isLiquidityAdmin) held.push(ROLE_HASH.liquidityAdmin)
  m.reads.hasRole = (role) => Promise.resolve(held.includes(role))
  return {
    runTx,
    node: {
      signer: {},
      account: ACCOUNT,
      chainId: 1,
      provider: providerStub,
      runTx,
      pendingTx: false,
      ...node,
    },
  }
}

// `window.confirm` is stubbed by the removeRoute tests. Restoring inside the test body is not
// enough: any assertion that throws first skips the restore, leaving the stub installed for every
// later test in the worker — which showed up as two different admin tests failing intermittently
// depending on run order. `stubConfirm` registers the cleanup so it runs even when a test fails.
let confirmSpy = null
function stubConfirm(answer) {
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(answer)
  return confirmSpy
}
afterEach(() => {
  confirmSpy?.mockRestore()
  confirmSpy = null
})

beforeEach(() => {
  m.addr = { 1: ROUTER }
  m.scanFails = null
  m.scanCalls = []
  m.readCalls = []
  m.blockTimestamp = null
  m.counts = {}
  m.events = {}
  m.receipts = {}
  m.feeQuote = { available: true, bps: 10, capBps: 250 }
  m.feeThrows = null
  m.status = null
  m.configFeeRouter = VALID // matches the router's own feeRouter by default
  m.gateway = { configured: false, loading: false, reachable: false, status: null }
  const routes = { [ROUTE_TO_POLYGON.routeId]: ROUTE_TO_POLYGON, [ROUTE_TO_BASE.routeId]: ROUTE_TO_BASE }
  const ids = [ROUTE_TO_POLYGON.routeId, ROUTE_TO_BASE.routeId]
  m.reads = {
    paused: () => Promise.resolve(false),
    spokePool: () => Promise.resolve('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'),
    feeRouter: () => Promise.resolve(VALID),
    sanctionsGuard: () => Promise.resolve(VALID),
    MAX_FEE_BPS: () => Promise.resolve(250n),
    routeCount: () => Promise.resolve(BigInt(ids.length)),
    routeAt: (i) => Promise.resolve(ids[Number(i)]),
    getRoute: (id) => Promise.resolve(routes[id]),
    queryFilter: (filter) => Promise.resolve(m.events[filter?.__event] || []),
  }
})

describe('BridgeTab — honest empty states', () => {
  it('says the router is not deployed rather than showing empty controls', async () => {
    m.addr = {}
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    expect(await screen.findByText(/No BridgeRouter is deployed on Ethereum/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pause new bridges/i })).not.toBeInTheDocument()
  })

  it('is axe-clean in the not-deployed state', async () => {
    m.addr = {}
    const { container } = render(<BridgeTab {...props({ isAdmin: true }).node} />)
    await screen.findByText(/No BridgeRouter is deployed/i)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('reports an unreadable router as unreadable, never as “no routes”', async () => {
    m.reads.paused = () => Promise.reject(new Error('rpc down'))
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Could not read the BridgeRouter on Ethereum/i)
    expect(alert).toHaveTextContent(/Nothing below can be trusted as current/i)
  })
})

describe('BridgeTab — least privilege (FR-049)', () => {
  it('a guardian gets the pause and no configuration controls', async () => {
    render(<BridgeTab {...props({ isGuardian: true }).node} />)
    expect(await screen.findByRole('button', { name: 'Pause new bridges' })).toBeInTheDocument()
    expect(screen.queryByText('Protocol addresses')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save route' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })

  it('a liquidity admin gets route curation, and neither the pause nor the fund-path addresses', async () => {
    render(<BridgeTab {...props({ isLiquidityAdmin: true }).node} />)
    expect(await screen.findByRole('button', { name: 'Save route' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pause new bridges/i })).not.toBeInTheDocument()
    // `setSpokePool` / `setFeeRouter` decide where a member's money goes and are DEFAULT_ADMIN_ROLE
    // on the contract. Curating which routes are offered is not authority to redirect the funds
    // moving through them, and the tab must not offer what the contract will refuse.
    expect(screen.queryByText('Protocol addresses')).not.toBeInTheDocument()
  })

  it('an admin gets the fund-path addresses, with the consequence stated', async () => {
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    expect(await screen.findByText('Protocol addresses')).toBeInTheDocument()
    expect(screen.getByText(/fund-path references, not settings/i)).toBeInTheDocument()
  })

  it('an operator with none of the three sees the state and can act on none of it', async () => {
    render(<BridgeTab {...props().node} />)
    await screen.findByRole('heading', { name: 'Routes' })
    expect(screen.queryByRole('button', { name: /Pause/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Disable/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Set limit/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Protocol addresses')).not.toBeInTheDocument()
  })
})

describe('BridgeTab — routes (T124, FR-041/FR-045)', () => {
  it('renders each curated route with its limit, window and state', async () => {
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated bridge routes' })
    expect(within(table).getByText('Ethereum → Polygon')).toBeInTheDocument()
    expect(within(table).getByText('5000.0 USDC')).toBeInTheDocument()
    expect(within(table).getByText('15m')).toBeInTheDocument()
    // A 0 maximum is UNCAPPED, not "nothing may pass".
    expect(within(table).getByText('uncapped')).toBeInTheDocument()
    expect(within(table).getByText('disabled')).toBeInTheDocument()
  })

  it('dispatches enable, limit and remove for a liquidity admin', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<BridgeTab {...node} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })

    /*
     * ── A canConfig-GATED CONTROL IS AWAITED, NEVER READ WITH A PLAIN `getBy*` ──────────────────
     * This tab makes TWO independent async reads: the router's own state (the route list, which
     * renders the table awaited above) and `readRouterAuthority` (BridgeTab.jsx:404), which sets
     * `gates.config` — and every control below lives inside `{canConfig && …}`. Awaiting only the
     * first and then reaching for a gated control with a non-retrying query passes locally and
     * fails on a loaded CI runner, where the authority read lands a render later.
     *
     * Same defect as #1029 in the sibling AdminSupplyTab, which was fixed there and not here.
     */
    fireEvent.click((await screen.findAllByRole('button', { name: 'Disable' }))[0])
    await waitFor(() => expect(runTx.mock.calls.some((c) => /disabled/.test(c[1]))).toBe(true))

    fireEvent.change(await screen.findByLabelText(/Per-transaction maximum for USDC to Polygon/i), {
      target: { value: '1000' },
    })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Set limit' }))[0])
    await waitFor(() => expect(runTx.mock.calls.some((c) => /Per-transaction maximum updated/.test(c[1]))).toBe(true))

    // Removal ASKS FIRST, and the question names what it costs — removal is not the harder version
    // of Disable, it is the one that deletes the entry and blinds the Operations panel's lateness
    // detection for transfers still moving on the route.
    const confirm = stubConfirm(true)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0])
    await waitFor(() => expect(runTx.mock.calls.some((c) => /removed/.test(c[1]))).toBe(true))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatch(/Disable/)
    expect(confirm.mock.calls[0][0]).toMatch(/expected delivery window/i)
  })

  it('does not remove a route when the operator declines the confirm', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<BridgeTab {...node} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })

    const confirm = stubConfirm(false)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0])
    expect(confirm).toHaveBeenCalled()
    expect(runTx).not.toHaveBeenCalled()
  })

  it('refuses an invalid route before the wallet prompt and dispatches a valid one', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<BridgeTab {...node} />)
    await screen.findByRole('button', { name: 'Save route' })

    // No addresses at all.
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/valid, non-zero token addresses/i)
    expect(runTx).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('input token 0x…'), { target: { value: USDC_ETH } })
    fireEvent.change(screen.getByPlaceholderText('output token 0x…'), { target: { value: USDC_POLYGON } })

    // No destination chosen.
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be the network this router is on/i)
    expect(runTx).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Destination network/i), { target: { value: '137' } })

    // A delivery window the contract would refuse.
    fireEvent.change(screen.getByLabelText(/Expected delivery window/i), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/between 60 and 86400 seconds/i)
    expect(runTx).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Expected delivery window/i), { target: { value: '900' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }))
    await waitFor(() => expect(runTx.mock.calls.some((c) => /Route to Polygon saved/.test(c[1]))).toBe(true))
  })

  it('offers bulk enable/disable per destination and says how many transactions it costs', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<BridgeTab {...node} />)
    const coverage = await screen.findByRole('table', { name: 'Destination coverage' })
    // One route to Polygon (enabled), one to Base (disabled), none elsewhere.
    expect(within(coverage).getByText('1 of 1 enabled')).toBeInTheDocument()
    expect(within(coverage).getByText('0 of 1 enabled')).toBeInTheDocument()
    expect(within(coverage).getAllByText('none — not offered to members').length).toBeGreaterThan(0)

    // The bulk column is canConfig-gated too (BridgeTab.jsx:814/828), so awaiting the coverage
    // table is not the same as awaiting this button.
    fireEvent.click((await within(coverage).findAllByRole('button', { name: 'Enable all (1 tx)' }))[0])
    await waitFor(() => expect(runTx).toHaveBeenCalled())
  })
})

describe('BridgeTab — addresses (T125, FR-042)', () => {
  it('shows the current value and refuses invalid input with a reason', async () => {
    // Admin, not liquidity-admin: these three addresses are DEFAULT_ADMIN_ROLE on the contract.
    const { node, runTx } = props({ isAdmin: true })
    render(<BridgeTab {...node} />)
    await screen.findByText('Protocol addresses')
    expect(screen.getByText(/now: 0x5c7B\.\.\.35C5/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('SpokePool 0x…'), { target: { value: 'not-an-address' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set SpokePool' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/valid, non-zero address for the SpokePool/i)
    expect(runTx).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('SpokePool 0x…'), { target: { value: VALID } })
    fireEvent.click(screen.getByRole('button', { name: 'Set SpokePool' }))
    await waitFor(() => expect(runTx.mock.calls.some((c) => /SpokePool updated/.test(c[1]))).toBe(true))
  })
})

describe('BridgeTab — the pause is always visible, and honest about who can pull it', () => {
  // Hiding the card behind the authority check made a network WITH a working killswitch look like a
  // network without one, mid-incident: the operator stops looking and starts improvising. The card
  // now always renders and says separately whether this account can use it.
  it('renders the card with a reason, not nothing, when the account holds neither role', async () => {
    render(<BridgeTab {...props().node} />)
    expect(await screen.findByText('Emergency pause')).toBeInTheDocument()
    /*
     * The NOTICE is awaited before the absence below is asserted. "Emergency pause" is a static
     * heading, so it arrives long before the authority read resolves — and until it does, the
     * button is absent for the ordinary reason that nothing has been decided yet. Asserting the
     * absence at that moment would pass without ever observing the refusal this test is named
     * for. The notice only renders on a definite no, so it is the point at which the absence
     * means something.
     */
    const notice = await screen.findByText(/the killswitch exists and is exercisable/i)
    expect(screen.queryByRole('button', { name: /^Pause new bridges/i })).not.toBeInTheDocument()
    expect(notice).toBeInTheDocument()
    expect(notice.parentElement.textContent).toMatch(/does not carry here/i)
    expect(notice.parentElement.textContent).toMatch(/Role Manager grants/i)
  })

  it('offers the killswitch when authority cannot be read, and says it is unconfirmed (FR-044)', async () => {
    // Built first: `props()` installs its own hasRole stub, so the rejection has to land after it.
    const { node } = props()
    m.reads.hasRole = () => Promise.reject(new Error('missing revert data'))
    render(<BridgeTab {...node} />)
    await screen.findByRole('button', { name: /^Pause new bridges/i })
    expect(screen.getByText(/could not be confirmed/i)).toBeInTheDocument()
  })

  it('tells a guardian that the narrower per-route lever exists behind another role', async () => {
    render(<BridgeTab {...props({ isGuardian: true }).node} />)
    await screen.findByRole('button', { name: /^Pause new bridges/i })
    // Otherwise a one-destination incident gets a network-wide pause, because the guardian cannot
    // see that disabling a single route is even possible.
    expect(screen.getByText(/covers/i).parentElement.textContent).toMatch(/LIQUIDITY_ADMIN_ROLE/)
  })
})

describe('BridgeTab — bulk toggles stop on the first refusal (FR-041)', () => {
  it('does not queue the remaining prompts after a rejected signature', async () => {
    // The loop's comment claimed this; `runTx` swallowed every error and resolved with no signal, so
    // rejecting the first prompt to abort still fired the rest — and any accepted by reflex disabled
    // a live route. `runTx` now reports failure and the loop honours it.
    const { node, runTx } = props({ isLiquidityAdmin: true })
    runTx.mockImplementation(() => Promise.resolve(false)) // wallet rejected
    render(<BridgeTab {...node} />)
    // One row per destination network; take the one that actually has an enabled route to disable.
    const bulk = (await screen.findAllByRole('button', { name: /Disable all \(1 tx\)/i }))[0]
    fireEvent.click(bulk)
    await waitFor(() => expect(runTx).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('alert')).toHaveTextContent(/Stopped after 0 of/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/left untouched/i)
  })
})

describe('BridgeTab — fee is read-only (T132, FR-048/FR-051)', () => {
  it('shows the live rate, its cap and the router ceiling, and says where it is edited', async () => {
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    expect(await screen.findByText(/10 bps \(0\.10%\) — service cap 250 bps/)).toBeInTheDocument()
    expect(screen.getByText(/250 bps — enforced by the router itself/)).toBeInTheDocument()
    expect(screen.getByText(/read-only here/i)).toBeInTheDocument()
    expect(screen.getByText(/Fee Administrator/i)).toBeInTheDocument()
  })

  it('says the rate could not be read — and leaves every other control usable', async () => {
    m.feeThrows = new Error('FeeRouter unreachable')
    render(<BridgeTab {...props({ isAdmin: true, isLiquidityAdmin: true }).node} />)
    expect(await screen.findByText(/could not be read — members cannot start a fee-bearing bridge/i)).toBeInTheDocument()
    // The pause and the route controls are untouched by an unreadable fee. Awaited, not assumed:
    // the fee quote is a THIRD independent read, and its arrival says nothing about the authority
    // read that decides whether either of these buttons is rendered at all.
    expect(await screen.findByRole('button', { name: 'Pause new bridges' })).toBeEnabled()
    expect(await screen.findByRole('button', { name: 'Save route' })).toBeEnabled()
  })
})

describe('BridgeTab — the fee is quoted from the router in the path (T132, FR-048)', () => {
  it('quotes the FeeRouter the ROUTER holds, not the one in the app config', async () => {
    // `fetchFeeQuote` defaults to the configured address, which is right for members and wrong here:
    // the contract that will charge them is whatever `BridgeRouter.feeRouter()` returns right now.
    const { fetchFeeQuote } = await import('../../lib/fees/feeQuote')
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    await screen.findByText(/10 bps/)
    expect(fetchFeeQuote).toHaveBeenCalledWith(expect.objectContaining({ routerAddress: VALID }))
  })

  it('says so when the router and the app disagree about which FeeRouter charges', async () => {
    // A real, temporary state — someone repoints the router before the config ships, or the reverse.
    // In that window members are quoted by a contract that is not the one charging them, and the
    // member path refuses rather than overcharging. Invisible from every other screen.
    m.reads.feeRouter = () => Promise.resolve('0x00000000000000000000000000000000000000b2')
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    const alert = await screen.findByText(/Members are being quoted a different FeeRouter/i)
    expect(alert).toBeInTheDocument()
    expect(alert.parentElement.textContent).toMatch(/sync:frontend-contracts/)
  })
})

describe('BridgeTab — operations are observational only (T126, FR-047)', () => {
  it('states plainly that no action can touch an in-flight bridge', async () => {
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    await screen.findByText('Operations')
    expect(screen.getByText(/This panel is observational only\./)).toBeInTheDocument()
    expect(screen.getByText(/no rescue or refund function/i)).toBeInTheDocument()
    expect(screen.getByText(/There is no button to hunt for/i)).toBeInTheDocument()
  })

  it('reports an unset gateway without claiming transfers are lost', async () => {
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    await screen.findByText('Operations')
    expect(
      screen.getByText(/not configured — members cannot start a bridge .* transfers already moving still resolve/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/this router cannot observe it/i)).toBeInTheDocument()
  })

  it('lists recent bridges and marks a late one without calling it lost', async () => {
    const longAgo = Math.floor(Date.now() / 1000) - 7200
    m.events.BridgeInitiated = [
      {
        blockNumber: 999_000,
        index: 0,
        transactionHash: '0xdead',
        args: {
          routeId: ROUTE_TO_POLYGON.routeId,
          member: VALID,
          recipient: VALID,
          destinationChainId: 137n,
          grossAmount: 1_000_000n,
          feeAmount: 0n,
        },
      },
    ]
    // Two hours ago against a 15-minute window ⇒ past its expected delivery. Seeded on the
    // SCOPED chain's client, which is where the timestamp is read from (spec 110) — it used to
    // come from the wallet's provider, which is a different chain whenever this tab is doing the
    // job it exists for.
    m.blockTimestamp = longAgo
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Recent bridges' })
    expect(within(table).getByText('Taking longer than expected')).toBeInTheDocument()
    expect(within(table).getByText('1.0 USDC')).toBeInTheDocument()
    expect(within(table).getByText(/origin transaction only/)).toBeInTheDocument()
  })
})

describe('BridgeTab — history (T131, FR-046)', () => {
  it('decodes each control action with before → after', async () => {
    m.events.RouteLimitChanged = [
      {
        blockNumber: 999_900,
        index: 1,
        transactionHash: '0xhist',
        args: { routeId: ROUTE_TO_POLYGON.routeId, destinationChainId: 137n, oldMax: 0n, newMax: 5_000_000n, actor: VALID },
      },
    ]
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Change history' })
    expect(within(table).getByText('Per-transaction maximum')).toBeInTheDocument()
    expect(within(table).getByText('uncapped')).toBeInTheDocument()
    expect(within(table).getByText('5000000 raw units')).toBeInTheDocument()
  })
})

describe('BridgeTab — scope is a network, not the wallet (FR-050)', () => {
  it('reads another network and says why changes need the wallet there', async () => {
    m.addr = { 1: ROUTER, 137: ROUTER }
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })

    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: '137' } })
    await waitFor(() =>
      expect(screen.getByText(/You are reading Polygon while your wallet is on Ethereum/i)).toBeInTheDocument(),
    )
    // The controls are still rendered — they are simply not signable from here.
    expect(screen.getByRole('button', { name: 'Pause new bridges' })).toBeDisabled()
  })

  it('is axe-clean fully loaded', async () => {
    const { container } = render(<BridgeTab {...props({ isAdmin: true }).node} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })
    expect(await axe(container)).toHaveNoViolations()
  })

  /**
   * THE ASSERTION THE OLD FAKE COULD NOT MAKE (spec 110).
   *
   * This tab exists to read ONE network while the wallet sits on another. The ethers fake carried
   * its chain inside a `runner` object and ignored the address it was constructed with, so a read
   * or a scan aimed at the WRONG network — or at the other network's router — passed every
   * assertion in this file. The chain is an argument now and the mocks record it.
   *
   * The invariant asserted is CHAIN AND ADDRESS ALWAYS AGREE, over every call, rather than "after
   * the switch, everything is on 137". The second phrasing is what this test said first and it was
   * FLAKY: clearing the recorder does not cancel reads already in flight from the previous mount,
   * so a late chain-1 read lands after the clear and fails an assertion that is only usually true.
   * Same defect as the mnemonic fixtures earlier in this task — a test that is right most of the
   * time is a test that fails on somebody else's commit.
   */
  it('never reads one network at another network\'s router', async () => {
    const OTHER = '0x7777777777777777777777777777777777777777'
    // The two addresses must DIFFER, or every assertion below is satisfied by a collision rather
    // than by correct routing — which is exactly how this test first passed with the defect
    // reintroduced: the OTHER address chosen happened to equal this file's ROUTER.
    expect(OTHER).not.toBe(ROUTER)
    const HOME_OF = { 1: ROUTER, 137: OTHER }
    m.addr = HOME_OF
    render(<BridgeTab {...props({ isAdmin: true }).node} />)
    await screen.findByRole('table', { name: 'Curated bridge routes' })

    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: '137' } })
    await waitFor(() =>
      expect(m.readCalls.some((c) => Number(c.chainId) === 137)).toBe(true),
    )

    // Every call, whenever it landed: the address must be the router that lives on the chain the
    // call names. A read for Polygon sent to Ethereum's router is the failure this tab must never
    // have, and it is the one the fake could not see.
    for (const call of [...m.readCalls, ...m.scanCalls]) {
      expect(call.address, `chain ${call.chainId}`).toBe(HOME_OF[Number(call.chainId)])
    }
    // And both chains really were exercised, or the loop above proves nothing.
    expect(m.readCalls.some((c) => Number(c.chainId) === 1)).toBe(true)
  })

})
