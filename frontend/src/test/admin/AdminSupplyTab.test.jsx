/**
 * Spec 067 US4 (T127–T132, T135) — the SupplyTab operator control surface (AdminPanel → Liquidity → Supply).
 *
 * Two assertions here matter more than the rest, and both are about what the tab REFUSES to
 * imply (research R3, FR-024):
 *
 *   - the pause is labelled "Pauses new Uniswap supplies" and says out loud that it cannot stop
 *     bridge-pool deposits, because no FairWins contract is in that path;
 *   - a retired pool stays in the table, with its position count, because members still hold
 *     positions in it and must keep being able to exit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ethers as ethersActual } from 'ethers'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { LIQUIDITY_ROUTER_ABI } from '../../abis/LiquidityRouter'

const m = vi.hoisted(() => ({ addr: {}, reads: {}, events: {}, scanCalls: [],
  readCalls: [],
  blockTimestamp: null, scanFails: null, sent: [], feeQuote: null, feeThrows: null, counts: {} }))

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: (name, chainId) =>
    name === 'liquidityRouter' ? m.addr[Number(chainId)] || '' : '',
}))
vi.mock('../../config/blockExplorer', () => ({
  getBlockscoutUrl: () => 'https://explorer.example/address/0xrouter',
  getTransactionUrl: () => 'https://explorer.example/tx/0xdead',
}))
vi.mock('../../lib/fees/feeQuote', async (orig) => ({
  ...(await orig()),
  fetchFeeQuote: vi.fn(() => (m.feeThrows ? Promise.reject(m.feeThrows) : Promise.resolve(m.feeQuote))),
}))
vi.mock('../../lib/liquidity/acrossLpPositions', () => ({
  // The bridge-pool SIZE comes from the Across HubPool, not from the router's events. `null` is the
  // unreadable case, which the tab must report as unknown rather than as an empty pool.
  readPooledToken: vi.fn(() => Promise.resolve(m.pooledToken)),
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

import SupplyTab from '../../components/admin/SupplyTab'
import { POOL_KIND } from '../../lib/liquidity/liquidityRouter'

const ROUTER = '0x2222222222222222222222222222222222222222'
const VALID = '0x00000000000000000000000000000000000000a1'
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const POOL_ADDR = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'
const HUB_POOL = '0xc186fA914353c44b2E33eBE05f21846F1048bEda'

const TRADING_POOL = {
  poolId: `0x${'11'.repeat(32)}`,
  kind: BigInt(POOL_KIND.TRADING_LP),
  enabled: true,
  feeTier: 500n,
  token0: USDC_ETH,
  token1: WETH,
  poolAddress: POOL_ADDR,
  maxDeposit0PerTx: 10_000_000_000n, // 10,000 USDC
  maxDeposit1PerTx: 0n,
}
const RETIRED_POOL = {
  poolId: `0x${'22'.repeat(32)}`,
  kind: BigInt(POOL_KIND.TRADING_LP),
  enabled: false,
  feeTier: 3000n,
  token0: USDC_ETH,
  token1: WETH,
  poolAddress: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8',
  maxDeposit0PerTx: 0n,
  maxDeposit1PerTx: 0n,
}
const BRIDGE_POOL = {
  poolId: `0x${'33'.repeat(32)}`,
  kind: BigInt(POOL_KIND.BRIDGE_LP),
  enabled: true,
  feeTier: 0n,
  token0: USDC_ETH,
  token1: '0x0000000000000000000000000000000000000000',
  poolAddress: HUB_POOL,
  maxDeposit0PerTx: 0n,
  maxDeposit1PerTx: 0n,
}

const providerStub = {
  getBlockNumber: () => Promise.resolve(1_000_000),
  getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
}


/** `runTx` resolves true on success — callers that send a sequence rely on the signal. */
const TX_OK = true
const ACCOUNT = '0x9999999999999999999999999999999999999999'

const SIGNER = {
  sendTransaction: vi.fn(async (tx) => {
    m.sent.push(tx)
    return { hash: '0xdeadbeef' }
  }),
}

/**
 * Decode what the tab actually put on the wire, with ETHERS, against the same ABI.
 *
 * A cross-library check rather than a read-back of a fake's argument list: the calldata is built
 * by viem now, and an assertion that only inspects the arguments a stub received cannot tell you
 * whether the bytes encode them. It also makes `to` assertable — `new Contract(addr, abi, runner)`
 * in the fake this replaced ignored the address it was handed.
 */
function decodeSent(index = -1) {
  const tx = m.sent.at(index)
  const parsed = new ethersActual.Interface(LIQUIDITY_ROUTER_ABI).parseTransaction({ data: tx.data })
  return { to: tx.to, method: parsed.name, args: parsed.args }
}
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
      // Writes are calldata now (spec 110): `encodeFunctionData` + `sendTransaction`. The recorded
      // transactions are decoded in the assertions, so the bytes are checked, not a fake's argument
      // list — and `to` is asserted, which `new Contract(addr, …)` in a fake silently ignored.
      signer: SIGNER,
      account: ACCOUNT,
      chainId: 1,
      provider: providerStub,
      runTx,
      pendingTx: false,
      ...node,
    },
  }
}

beforeEach(() => {
  m.addr = { 1: ROUTER }
  m.scanFails = null
  m.scanCalls = []
  m.readCalls = []
  m.blockTimestamp = null
  m.sent = []
  SIGNER.sendTransaction.mockClear()
  m.events = {}
  m.counts = {}
  m.feeQuote = { available: true, bps: 25, capBps: 250 }
  m.feeThrows = null
  m.pooledToken = null
  const pools = {
    [TRADING_POOL.poolId]: TRADING_POOL,
    [RETIRED_POOL.poolId]: RETIRED_POOL,
    [BRIDGE_POOL.poolId]: BRIDGE_POOL,
  }
  const ids = Object.keys(pools)
  m.reads = {
    paused: () => Promise.resolve(false),
    feeRouter: () => Promise.resolve(VALID),
    positionManager: () => Promise.resolve('0xC36442b4a4522E871399CD717aBDD847Ab11FE88'),
    sanctionsGuard: () => Promise.resolve(VALID),
    MAX_FEE_BPS: () => Promise.resolve(250n),
    poolCount: () => Promise.resolve(BigInt(ids.length)),
    poolAt: (i) => Promise.resolve(ids[Number(i)]),
    getPool: (id) => Promise.resolve(pools[id]),
    queryFilter: (filter) => Promise.resolve(m.events[filter?.__event] || []),
  }
})

describe('SupplyTab — honest empty states', () => {
  it('says the router is not deployed rather than showing empty controls', async () => {
    m.addr = {}
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    expect(await screen.findByText(/No LiquidityRouter is deployed on Ethereum/i)).toBeInTheDocument()
  })

  it('is axe-clean in the not-deployed state', async () => {
    m.addr = {}
    const { container } = render(<SupplyTab {...props({ isAdmin: true }).node} />)
    await screen.findByText(/No LiquidityRouter is deployed/i)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('SupplyTab — the pause is narrow and says so (T128, research R3)', () => {
  it('is labelled "new Uniswap supplies", never "pooling"', async () => {
    render(<SupplyTab {...props({ isGuardian: true }).node} />)
    expect(await screen.findByRole('button', { name: 'Pause new Uniswap supplies' })).toBeInTheDocument()
    expect(screen.getByText('Pauses new Uniswap supplies')).toBeInTheDocument()
    expect(screen.queryByText(/Pauses pooling/i)).not.toBeInTheDocument()
  })

  it('states that it cannot stop bridge-pool deposits, and why', async () => {
    render(<SupplyTab {...props({ isGuardian: true }).node} />)
    await screen.findByRole('button', { name: 'Pause new Uniswap supplies' })
    // The emphasis tags split the sentence across nodes, so the paragraph is read whole.
    const note = screen.getByText(/pause bridge-pool deposits/i).closest('p')
    expect(note.textContent).toMatch(/It does not pause bridge-pool deposits/i)
    expect(note.textContent).toMatch(/no FairWins contract in the path/i)
    expect(note.textContent).toMatch(/what withholds a bridge pool is its enabled flag/i)
    expect(note.textContent).toMatch(/every existing position stays withdrawable/i)
  })

  it('names the paused state as Uniswap-only and keeps positions withdrawable', async () => {
    m.reads.paused = () => Promise.resolve(true)
    render(<SupplyTab {...props({ isGuardian: true }).node} />)
    expect(
      await screen.findByText(/PAUSED — no new Uniswap supplies\. Existing positions are untouched and still withdrawable\./),
    ).toBeInTheDocument()
    // ── A ROLE-GATED CONTROL IS AWAITED, NEVER READ WITH A PLAIN `getBy*` ────────────────────────
    // The tab makes TWO independent async reads: the router's own state (pause flag, pool list) and
    // `readRouterAuthority`, which decides whether an operator's controls are rendered at all.
    // Awaiting only the first — the PAUSED banner here, the "Curated pools" table below — and then
    // reaching for a gated control with a non-retrying query passed 28/28 locally and failed on a
    // loaded CI runner, where the authority read lands a render later: the test reported "unable to
    // find Set caps" when what actually happened is that it had not arrived yet. Every query for a
    // control behind `canPause`/`canConfig` therefore retries.
    expect(await screen.findByRole('button', { name: 'Resume new Uniswap supplies' })).toBeInTheDocument()
  })

  it('dispatches the pause with Uniswap-only wording', async () => {
    const { node, runTx } = props({ isGuardian: true })
    render(<SupplyTab {...node} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pause new Uniswap supplies' }))
    await waitFor(() => expect(runTx.mock.calls.some((c) => c[1] === 'New Uniswap supplies paused')).toBe(true))
  })
})

describe('SupplyTab — a retired pool is retired, not gone (T129, FR-024)', () => {
  it('keeps the retired pool listed, marked retired and still withdrawable', async () => {
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    expect(within(table).getByText(/RETIRED — closed to new deposits, still withdrawable/)).toBeInTheDocument()
    // Both trading pools are present: retiring one does not remove it from the list.
    expect(within(table).getAllByText(/Trading pool \(Uniswap V3\)/).length).toBe(2)
    expect(await screen.findByRole('button', { name: 'Reopen' })).toBeInTheDocument()
  })

  it('shows a position count for it, sourced from the router’s own deposits', async () => {
    m.events.LiquiditySupplied = [
      { blockNumber: 900_000, index: 0, transactionHash: '0xa', args: { poolId: RETIRED_POOL.poolId, tokenId: 1n, amount0: 1_000_000n, amount1: 0n } },
      { blockNumber: 900_001, index: 0, transactionHash: '0xb', args: { poolId: RETIRED_POOL.poolId, tokenId: 2n, amount0: 2_000_000n, amount1: 0n } },
    ]
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    const retiredRow = within(table).getByText(/RETIRED/).closest('tr')
    expect(within(retiredRow).getByText('2')).toBeInTheDocument()
    expect(within(retiredRow).getByText(/3\.0 USDC/)).toBeInTheDocument()
  })

  it('reports a bridge pool’s position COUNT as not observable, never as zero', async () => {
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    const bridgeRow = within(table).getByText(/Bridge pool \(Across\)/).closest('tr')
    // Exactly ONE cell, not two. Attributing LP balances to individual members needs an indexer, so
    // the COUNT genuinely cannot be produced — but the pool's SIZE is a plain HubPool read that the
    // member-facing Supply view already performs, so withholding it too left an operator deciding
    // whether to retire a bridge pool with no figure at all for the money inside it.
    expect(within(bridgeRow).getAllByText('not observable here').length).toBe(1)
    expect(screen.getByText(/would read as “no member has money in this pool”/)).toBeInTheDocument()
  })

  // ── AN UNREADABLE SCAN IS NOT A ZERO ─────────────────────────────────────────────────────────
  // The error path stored an EMPTY map rather than a null one, so the cell fell through to `?? 0` and
  // printed "0 positions" against a pool members still hold LP in — at the exact moment an operator
  // is deciding whether to retire it. That is the one claim FR-024 exists to prevent.
  it('says the position count is unknown when the deposit scan fails, never 0', async () => {
    m.scanFails = new Error('query returned more than 10000 results')
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    const retiredRow = within(table).getByText(/RETIRED/).closest('tr')
    await waitFor(() =>
      expect(within(retiredRow).getAllByText(/unknown — the scan failed/).length).toBe(2),
    )
    expect(within(retiredRow).queryByText('0')).not.toBeInTheDocument()
  })

  it('distinguishes "none in window" from a failed scan', async () => {
    // The lookback is bounded, so a pool whose deposits predate it has nothing to show — which is a
    // different statement from "the scan would not run", and a different one again from zero.
    m.reads.queryFilter = () => Promise.resolve([])
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    const retiredRow = within(table).getByText(/RETIRED/).closest('tr')
    await waitFor(() => expect(within(retiredRow).getAllByText('none in window').length).toBe(2))
  })

  it('reads a bridge pool’s size from the HubPool, and says so when that read fails', async () => {
    m.pooledToken = { liquidReserves: 4_000_000n, utilizedReserves: 1_000_000n }
    const { unmount } = render(<SupplyTab {...props({ isAdmin: true }).node} />)
    let table = await screen.findByRole('table', { name: 'Curated pools' })
    let bridgeRow = within(table).getByText(/Bridge pool \(Across\)/).closest('tr')
    await waitFor(() => expect(within(bridgeRow).getByText(/5\.0 USDC in the pool/)).toBeInTheDocument())
    unmount()

    // An unreadable HubPool is not an empty pool.
    m.pooledToken = null
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    table = await screen.findByRole('table', { name: 'Curated pools' })
    bridgeRow = within(table).getByText(/Bridge pool \(Across\)/).closest('tr')
    await waitFor(() =>
      expect(within(bridgeRow).getByText(/unknown — the HubPool could not be read/)).toBeInTheDocument(),
    )
  })

  it('dispatches retire and reopen', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<SupplyTab {...node} />)
    await screen.findByRole('table', { name: 'Curated pools' })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Retire' }))[0])
    await waitFor(() =>
      expect(runTx.mock.calls.some((c) => /existing positions untouched/.test(c[1]))).toBe(true),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(runTx.mock.calls.some((c) => /reopened/.test(c[1]))).toBe(true))
  })
})

describe('SupplyTab — per-leg caps (T130, FR-045)', () => {
  it('renders two ceilings for a trading pool and dispatches both', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<SupplyTab {...node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    // 10,000 USDC on leg 0, uncapped on leg 1 — not one scalar for both.
    expect(within(table).getByText(/10000\.0 USDC/)).toBeInTheDocument()

    fireEvent.change((await screen.findAllByLabelText(/Per-transaction cap for USDC in pool/i))[0], {
      target: { value: '500' },
    })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Set caps' }))[0])
    await waitFor(() => expect(runTx.mock.calls.some((c) => /caps updated/.test(c[1]))).toBe(true))
  })

  // ── SETTING ONE CEILING MUST NOT DELETE THE OTHER ────────────────────────────────────────────
  // `setPoolLimit` writes BOTH legs in one call, and 0 means UNCAPPED on-chain. The blank leg used to
  // default to '0', so typing a new WETH ceiling on a pool capped at 10,000 USDC silently removed the
  // USDC cap and reported success — a member-facing limit deleted by an operator who never touched
  // it. The old test filled only leg 0 and asserted nothing about the values sent, so it was blind
  // to this; these three assert the ARGUMENTS.
  it('keeps the untouched leg’s current ceiling instead of writing 0 over it', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<SupplyTab {...node} />)
    await screen.findByRole('table', { name: 'Curated pools' })

    // Type ONLY the WETH leg. The pool is capped at 10,000 USDC on leg 0 and uncapped on leg 1.
    fireEvent.change((await screen.findAllByLabelText(/Per-transaction cap for WETH in pool/i))[0], {
      target: { value: '2' },
    })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Set caps' }))[0])
    await waitFor(() => expect(runTx).toHaveBeenCalled())

    // Inspect what the transaction thunk actually put on the wire.
    m.sent = []
    await runTx.mock.calls[runTx.mock.calls.length - 1][0]()
    expect(m.sent.length).toBe(1)
    const sent = decodeSent()
    expect(sent.method).toBe('setPoolLimit')
    expect(sent.to).toBe(ROUTER) // the fake this replaced ignored the address entirely
    const [, max0, max1] = sent.args
    expect(max0).toBe(TRADING_POOL.maxDeposit0PerTx) // 10,000 USDC preserved, not zeroed
    expect(max1).toBe(ethersActual.parseUnits('2', 18))
  })

  it('refuses to write anything when both cap boxes are blank', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<SupplyTab {...node} />)
    await screen.findByRole('table', { name: 'Curated pools' })

    fireEvent.click((await screen.findAllByRole('button', { name: 'Set caps' }))[0])
    expect(screen.getByRole('alert')).toHaveTextContent(/Type a new ceiling first/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/enter 0 explicitly/i)
    expect(runTx).not.toHaveBeenCalled()
  })

  it('still accepts an explicit 0 as uncapped', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<SupplyTab {...node} />)
    await screen.findByRole('table', { name: 'Curated pools' })

    fireEvent.change((await screen.findAllByLabelText(/Per-transaction cap for USDC in pool/i))[0], {
      target: { value: '0' },
    })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Set caps' }))[0])
    await waitFor(() => expect(runTx.mock.calls.some((c) => /caps updated/.test(c[1]))).toBe(true))
  })

  it('marks a bridge pool’s cap as app-honoured, not contract-enforced', async () => {
    render(<SupplyTab {...props({ isLiquidityAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    const bridgeRow = within(table).getByText(/Bridge pool \(Across\)/).closest('tr')
    // The router's limit check lives inside the Uniswap supply path; a bridge-LP deposit is a direct
    // member call to Across that never enters it. Same property the pause card explains for the
    // enabled flag, so the number does not get to imply enforcement it does not have.
    expect(within(bridgeRow).getByText(/honoured by this app, not by the contract/i)).toBeInTheDocument()
  })

  it('refuses a mis-scaled cap before the wallet prompt', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<SupplyTab {...node} />)
    await screen.findByRole('table', { name: 'Curated pools' })
    fireEvent.change((await screen.findAllByLabelText(/Per-transaction cap for USDC in pool/i))[0], {
      target: { value: 'lots' },
    })
    fireEvent.click((await screen.findAllByRole('button', { name: 'Set caps' }))[0])
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter an amount in USDC/i)
    expect(runTx).not.toHaveBeenCalled()
  })
})

describe('SupplyTab — listing a pool (FR-041/FR-042)', () => {
  it('refuses the listing shapes the contract refuses, with the reason', async () => {
    const { node, runTx } = props({ isLiquidityAdmin: true })
    render(<SupplyTab {...node} />)
    await screen.findByRole('button', { name: 'Save pool listing' })

    fireEvent.click(screen.getByRole('button', { name: 'Save pool listing' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/pool address and the first asset must both be valid/i)

    fireEvent.change(screen.getByPlaceholderText('pool 0x…'), { target: { value: POOL_ADDR } })
    fireEvent.change(screen.getByPlaceholderText('token0 0x…'), { target: { value: USDC_ETH } })
    fireEvent.change(screen.getByPlaceholderText('token1 0x…'), { target: { value: WETH } })
    fireEvent.click(screen.getByRole('button', { name: 'Save pool listing' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/needs its Uniswap fee tier/i)
    expect(runTx).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('500 / 3000 / 10000'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save pool listing' }))
    await waitFor(() => expect(runTx.mock.calls.some((c) => /Pool listing saved/.test(c[1]))).toBe(true))
  })

  it('checks the named pool before signing and explains a non-pool address', async () => {
    const { node } = props({ isLiquidityAdmin: true })
    m.reads.token0 = () => Promise.reject(new Error('not a pool'))
    render(<SupplyTab {...node} />)
    await screen.findByRole('button', { name: 'Check pool' })
    fireEvent.change(screen.getByPlaceholderText('pool 0x…'), { target: { value: POOL_ADDR } })
    fireEvent.click(screen.getByRole('button', { name: 'Check pool' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/did not answer as a Uniswap V3 pool/i),
    )
  })

  it('fills the legs from the pool itself when it does answer', async () => {
    const { node } = props({ isLiquidityAdmin: true })
    m.reads.token0 = () => Promise.resolve(USDC_ETH)
    m.reads.token1 = () => Promise.resolve(WETH)
    m.reads.fee = () => Promise.resolve(500n)
    render(<SupplyTab {...node} />)
    await screen.findByRole('button', { name: 'Check pool' })
    fireEvent.change(screen.getByPlaceholderText('pool 0x…'), { target: { value: POOL_ADDR } })
    fireEvent.click(screen.getByRole('button', { name: 'Check pool' }))
    await waitFor(() => expect(screen.getByText(/Pool confirmed: USDC \/ WETH at 0\.05%/)).toBeInTheDocument())
  })
})

describe('SupplyTab — fee is read-only (T132, FR-048)', () => {
  it('shows the live rate with its cap and the bridge-pool fee-free rule', async () => {
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    expect(await screen.findByText(/25 bps \(0\.25%\) — service cap 250 bps/)).toBeInTheDocument()
    expect(screen.getByText(/read-only here/i)).toBeInTheDocument()
    expect(screen.getByText(/carries no FairWins fee/i)).toBeInTheDocument()
  })

  it('says the rate could not be read and keeps the other controls usable', async () => {
    m.feeThrows = new Error('FeeRouter unreachable')
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    expect(await screen.findByText(/could not be read — members cannot start a fee-bearing supply/i)).toBeInTheDocument()
    // The fee quote is a THIRD independent read; arriving first says nothing about the authority
    // read that gates these two buttons, so both are awaited rather than assumed present.
    expect(await screen.findByRole('button', { name: 'Pause new Uniswap supplies' })).toBeEnabled()
    expect(await screen.findByRole('button', { name: 'Save pool listing' })).toBeEnabled()
  })
})

describe('SupplyTab — least privilege and history', () => {
  it('a guardian gets the pause and no configuration controls', async () => {
    render(<SupplyTab {...props({ isGuardian: true }).node} />)
    await screen.findByRole('button', { name: 'Pause new Uniswap supplies' })
    expect(screen.queryByText('Protocol addresses')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save pool listing' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument()
  })

  it('an operator with none of the three can act on nothing', async () => {
    render(<SupplyTab {...props().node} />)
    await screen.findByRole('table', { name: 'Curated pools' })
    // Awaited because these are ABSENCE assertions: before the authority read lands, every control
    // below is absent for the ordinary reason that nothing has been decided yet, and the test would
    // pass without ever observing the refusal it exists to check. The "not yours to pull" copy only
    // renders on a definite no, so it is the point at which the absences below mean something.
    await screen.findByText(/the pause is not yours to pull/i)
    expect(screen.queryByRole('button', { name: /Pause/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retire/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Set caps/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Protocol addresses')).not.toBeInTheDocument()
  })

  it('decodes retirement in the history and says it stays withdrawable', async () => {
    m.events.PoolEnabledChanged = [
      {
        blockNumber: 999_000,
        index: 0,
        transactionHash: '0xhist',
        args: { poolId: RETIRED_POOL.poolId, enabled: false, actor: VALID },
      },
    ]
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Change history' })
    expect(within(table).getByText('Pool availability')).toBeInTheDocument()
    expect(within(table).getByText('retired (still visible and withdrawable)')).toBeInTheDocument()
  })

  it('is axe-clean fully loaded', async () => {
    const { container } = render(<SupplyTab {...props({ isAdmin: true }).node} />)
    await screen.findByRole('table', { name: 'Curated pools' })
    // "Fully loaded" has to include the operator controls — the per-row cap inputs and the listing
    // form are the labelled widgets most likely to carry a violation, and awaiting only the table
    // would have scanned a tree they had not been added to yet.
    await screen.findAllByRole('button', { name: 'Set caps' })
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ── HOW MANY TIMES THE TAB ASKS IS ITSELF A CORRECTNESS PROPERTY (issue #1031) ──────────────────
//
// Every assertion above is about WHAT the tab says, and all of them passed while it was asking the
// router four hundred times in two seconds. The mount reads once shared a single effect keyed on all
// four fetch callbacks, and `fetchState` clears `state` before reading (deliberately — the FR-050
// no-mixing rule). That cleared `state?.feeRouter`, which is a declared dependency of `fetchFee`, so
// `fetchFee` was rebuilt, so the shared effect re-ran, so `fetchState` cleared `state` again: a loop
// whose period is one RPC round-trip, running for as long as an operator left the tab open.
//
// It is invisible to a mocked read that resolves on a microtask — React batches the blank away — so
// these mount the tab against a round-trip that costs a macrotask, as a real one does.
const settleFor = async (ms) => {
  for (let i = 0; i < ms / 10; i += 1) {
    // Each `act` boundary flushes React's queued work, so laps are actually taken rather than
    // collapsed into one batch at the end of a single long `act`.
    await act(async () => { await new Promise((r) => { setTimeout(r, 10) }) })
  }
}

describe('SupplyTab — reads the router once, not in a loop (issue #1031)', () => {
  it('asks each read exactly once per mount and leaves the table standing', async () => {
    const later = (v) => new Promise((res) => { setTimeout(() => res(v), 0) })
    const basePaused = m.reads.paused
    const baseFeeRouter = m.reads.feeRouter
    const basePoolCount = m.reads.poolCount
    m.reads.paused = (...a) => basePaused(...a).then(later)
    m.reads.feeRouter = (...a) => baseFeeRouter(...a).then(later)
    m.reads.poolCount = (...a) => basePoolCount(...a).then(later)

    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    const table = await screen.findByRole('table', { name: 'Curated pools' })
    await settleFor(200)

    // One round of reads, not one per render. Before the fix this was 51 in 250ms and rising
    // linearly with how long the tab stayed open.
    expect(m.counts.paused).toBe(1)
    expect(m.counts.poolCount).toBe(1)
    // The pool fan-out is per pool, once — three pools, not three per lap.
    expect(m.counts.getPool).toBe(3)

    // ── AND THE TABLE AN OPERATOR IS LOOKING AT IS THE SAME TABLE ────────────────────────────────
    // The loop tore the table out of the DOM and rebuilt it ~100 times a second. A `findBy*` still
    // resolved, so tests "passed" holding a node that was already detached — the failure signature
    // is a click or a `within()` that silently addresses nothing.
    expect(table.isConnected).toBe(true)
    expect(screen.getByRole('table', { name: 'Curated pools' })).toBe(table)
  })

  // The clearing itself is NOT the bug and must survive the fix: an operator who pauses network A,
  // switches to B and still sees A's PAUSED banner and A's pools walks away believing B is stopped.
  it('still blanks the previous network’s pools the moment the scope changes', async () => {
    m.addr = { 1: ROUTER, 137: '0x3333333333333333333333333333333333333333' }
    render(<SupplyTab {...props().node} />)
    await screen.findByRole('table', { name: 'Curated pools' })

    // Polygon's router never answers, so `state` can only be cleared, never repopulated: whatever is
    // on screen afterwards is what the tab is willing to show about a network it has not read.
    m.reads.paused = () => new Promise(() => {})
    // Only one select renders for an operator with no authority — the network scope.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '137' } })

    await waitFor(() => expect(screen.queryByRole('table', { name: 'Curated pools' })).toBeNull())
    expect(screen.getByText('Loading pools…')).toBeInTheDocument()
    // Ethereum's "not paused" answer must not be showing under Polygon's name either.
    expect(screen.queryByText(/PAUSED/)).not.toBeInTheDocument()
    expect(screen.queryByText(/open to new deposits\)/)).not.toBeInTheDocument()
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
    render(<SupplyTab {...props({ isAdmin: true }).node} />)
    await screen.findByRole('table', { name: 'Curated pools' })

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
