/**
 * FeesTab tests (spec 060, US2) — the unified fee screen renders every fee
 * system with live rates and caps, gates edits by role, validates caps
 * client-side before any transaction, renders the on-chain change history,
 * and is honest when no router is deployed or the gateway is unreachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ethers } from 'ethers'
import { cohortChainIds, NETWORKS } from '../config/networks'

const m = vi.hoisted(() => ({
  routerAddr: null,
  reads: {},
  logs: [],
  logsRangeCap: null,
  // Observations. Every one of these is a chain or an address the old ethers fake could not show:
  // `new ethers.Contract(addr, abi, runner)` ignored its address in the fake and carried its chain
  // inside the runner, so a read or a write aimed at the wrong place passed every assertion here.
  readCalls: [],
  scanCalls: [],
  blockCalls: [],
  sent: [],
}))

vi.mock('../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => m.routerAddr),
}))
vi.mock('../hooks/useGatewayStatus', () => ({
  gatewayBaseUrl: () => '', // gateway rows exercise the unreachable path by default
}))
vi.mock('../config/blockExplorer', () => ({
  getBlockscoutUrl: () => 'https://explorer.example/address/0xrouter',
}))

/**
 * Every read the tab makes — the tab's own FeeRouter reads and the estate AUTHORITY read
 * (`hasRole` on the router that will enforce it) — resolves through the ONE chain seam.
 *
 * It records the chainId and address of each, which the ethers fake this replaced could not:
 * `new ethers.Contract(addr, abi, runner)` was handed its address and ignored it, and carried its
 * chain inside the runner. So the thing this tab exists to get right — one chain's fee schedule,
 * read from the chain the operator SCOPED to and not from the one their wallet happens to be on —
 * was the one thing its tests could not see.
 */
vi.mock('../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      m.readCalls.push({ chainId, address, functionName, args })
      const f = m.reads[functionName]
      if (!f) throw new Error('unmocked contract method: ' + functionName)
      return f(...args)
    },
  }
})

const TOPIC_FEE_BPS_CHANGED = ['0xfeebps']

vi.mock('../lib/chains/eventScan', () => ({
  eventScanHandle: (chainId, { address, abi }) => {
    m.scanCalls.push({ chainId, address, abi: Boolean(abi) })
    return {
      target: address,
      provider: {
        getBlockNumber: async () => 500_000,
        getLogs: async ({ address: a, topics, fromBlock, toBlock }) => {
          m.scanCalls.push({ getLogs: { address: a, topics, fromBlock, toBlock } })
          // Public RPCs cap log ranges. `logsRangeCap` null means "accepts anything".
          if (m.logsRangeCap != null && toBlock - fromBlock + 1 > m.logsRangeCap) {
            throw new Error('query returned more than 10000 results')
          }
          return m.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        },
      },
      filters: { FeeBpsChanged: () => ({ getTopicFilter: () => TOPIC_FEE_BPS_CHANGED }) },
      // Logs are seeded already decoded; the seam's real parseLog is covered by its own suite.
      interface: { parseLog: (log) => ({ name: 'FeeBpsChanged', args: log.args }) },
    }
  },
}))

vi.mock('../lib/chains/publicClient', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    getPublicClient: (chainId) => ({
      getBlock: async ({ blockNumber }) => {
        m.blockCalls.push({ chainId, blockNumber })
        return { timestamp: 1_752_800_000n }
      },
    }),
  }
})

import FeesTab from '../components/admin/FeesTab'
import { FEE_ROUTER_ABI } from '../abis/FeeRouter'

const EARN_LEND = ethers.id('earn.lend')
const PM_TAKER = ethers.id('polymarket.taker')
const TREASURY = '0x1111111111111111111111111111111111111111'
const ACCOUNT = '0x2222222222222222222222222222222222222222'

// Spec 071: the tab now scopes to a network the operator picks, seeded from the wallet's chain
// when that chain is in this build's cohort. A chainId outside the cohort would seed the scope
// elsewhere and gate every write off — which is correct behaviour, and not what these tests are
// about, so they run on a chain the build can actually reach.
const WALLET_CHAIN = cohortChainIds()[0]
const WALLET_CHAIN_NAME = NETWORKS[WALLET_CHAIN].name

/**
 * The wallet's provider. It is now ONLY the availability gate (`readProviderFor` returns it, and
 * null means this build may not read that chain) — no block number and no timestamp comes from it
 * any more, because those were being taken from the WALLET's chain while the logs came from the
 * scoped one. `blockCalls` below is what pins that down.
 */
const PROVIDER = { isReadProvider: true }

/** Writes are calldata now. The signer records what it was asked to send so it can be decoded. */
const SIGNER = {
  isSigner: true,
  sendTransaction: vi.fn(async (tx) => {
    m.sent.push(tx)
    return { hash: '0xdeadbeef' }
  }),
}

/**
 * Decode what the tab actually put on the wire, with ETHERS, against the same ABI.
 *
 * This is deliberately a cross-library check rather than a recorded `{method, args}` pair: the
 * calldata is built by viem now, and an assertion that only reads back the arguments a fake was
 * handed cannot tell you whether the bytes encode them. `FEE_ROUTER_ABI` is the ethers-v6
 * human-readable form the contract's own callers use.
 */
function decodeSent(index = 0) {
  const tx = m.sent[index]
  const parsed = new ethers.Interface(FEE_ROUTER_ABI).parseTransaction({ data: tx.data })
  return { to: tx.to, method: parsed.name, args: parsed.args }
}

// Spec 071: capability comes from the ROUTER's own AccessControl on the scoped chain, not from
// the app-wide props. `roles` here is what that router answers for the connected account — the
// props stay only as the pre-read stand-in while the first hasRole round-trip is in flight.
const ADMIN_ROLE = ethers.ZeroHash
const FEE_ADMIN_ROLE = ethers.id('FEE_ADMIN_ROLE')

function seedReads({ feeBps = { [EARN_LEND]: 50, [PM_TAKER]: 40 }, events = [], roles = { admin: true, feeAdmin: true } } = {}) {
  m.logs = events
  const ids = [EARN_LEND, PM_TAKER]
  const svc = {
    [EARN_LEND]: { capBps: 250n, feeBps: BigInt(feeBps[EARN_LEND] ?? 0), kind: 1n },
    [PM_TAKER]: { capBps: 100n, feeBps: BigInt(feeBps[PM_TAKER] ?? 0), kind: 2n },
  }
  m.reads = {
    serviceCount: async () => 2n,
    serviceAt: async (i) => ids[i],
    getService: async (id) => svc[id],
    treasury: async () => TREASURY,
    MAX_WRAPPED_FEE_BPS: async () => 250n,
    hasRole: async (role) => {
      if (role === ADMIN_ROLE) return Boolean(roles.admin)
      if (role === FEE_ADMIN_ROLE) return Boolean(roles.feeAdmin)
      return false
    },
  }
}

function renderTab({ isAdmin = true, isFeeAdmin = false, runTx } = {}) {
  const tx = runTx ?? vi.fn(async (fn) => fn())
  render(
    <FeesTab
      signer={SIGNER}
      account={ACCOUNT}
      chainId={WALLET_CHAIN}
      provider={PROVIDER}
      runTx={tx}
      pendingTx={false}
      isAdmin={isAdmin}
      isFeeAdmin={isFeeAdmin}
    />,
  )
  return tx
}

beforeEach(() => {
  m.routerAddr = '0x00000000000000000000000000000000000000f1'
  m.readCalls = []
  m.scanCalls = []
  m.blockCalls = []
  m.sent = []
  m.logsRangeCap = null
  SIGNER.sendTransaction.mockClear()
  seedReads()
})

describe('FeesTab rendering', () => {
  it('lists every registered service with live rate, cap, and enforcement', async () => {
    renderTab()
    expect((await screen.findAllByText(/earn — vault lending/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/polymarket builder fee \(taker\)/i).length).toBeGreaterThan(0)
    expect(screen.getByText('50 bps (0.50%)')).toBeInTheDocument()
    expect(screen.getByText('40 bps (0.40%)')).toBeInTheDocument()
    expect(screen.getByText(/charged on-chain \(wrapper\)/i)).toBeInTheDocument()
    expect(screen.getByText(/read by the gateway/i)).toBeInTheDocument()
    // Treasury + OpenSea display-only row + unreachable-gateway honesty.
    expect(screen.getByText('0x1111...1111')).toBeInTheDocument()
    expect(screen.getByText('OpenSea referral (Collect)')).toBeInTheDocument()
    expect(screen.getAllByText(/gateway unreachable/i).length).toBeGreaterThan(0)
  })

  it('is honest when no FeeRouter is deployed on the network', async () => {
    m.routerAddr = null
    renderTab()
    // It names the network rather than saying "this network" — the tab is no longer showing
    // whatever the wallet is on, so "this" would be ambiguous.
    expect(
      await screen.findByText(
        new RegExp(`no feerouter is deployed on ${WALLET_CHAIN_NAME}`, 'i'),
      ),
    ).toBeInTheDocument()
  })

  /**
   * THE DEFECT THIS PINS (spec 110 T028). The history scan took its `latest` block and every
   * entry's timestamp from the WALLET's provider while the logs came from the scoped chain's
   * router. This tab exists precisely because a fee schedule is per-chain and you read one chain
   * while your wallet sits on another — the tab's own banner says so — so the mismatch was the
   * normal case, not an edge: the 200k-block window was measured against the wrong chain's height
   * and every "changed at" date was whatever block shared that number on the wallet's chain.
   * Nothing failed; a date simply rendered, from somewhere else.
   *
   * Asserting on the REQUESTS is the only way to see it. The rendered output is identical either
   * way, which is exactly why it survived: the old ethers fake carried its chain inside a runner
   * object and could not be asked which one it used.
   */
  it('reads every chain-bound thing on the SCOPED chain, never the wallet\'s', async () => {
    const AWAY = cohortChainIds().find((c) => Number(c) !== Number(WALLET_CHAIN))
    expect(AWAY, 'this build needs a second cohort chain to scope to').toBeTruthy()
    seedReads({
      events: [
        {
          args: { serviceId: EARN_LEND, oldBps: 0n, newBps: 50n, actor: TREASURY },
          blockNumber: 499_000,
          transactionHash: '0xabc',
        },
      ],
    })
    renderTab()
    await screen.findAllByText(/earn — vault lending/i)
    m.readCalls = []
    m.scanCalls = []
    m.blockCalls = []
    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: String(AWAY) } })

    await waitFor(() => expect(m.blockCalls.length).toBeGreaterThan(0))
    const chains = new Set([
      ...m.readCalls.map((c) => Number(c.chainId)),
      ...m.scanCalls.filter((c) => c.chainId != null).map((c) => Number(c.chainId)),
      ...m.blockCalls.map((c) => Number(c.chainId)),
    ])
    expect([...chains]).toEqual([Number(AWAY)])
    expect(chains.has(Number(WALLET_CHAIN))).toBe(false)
  })

  it('still renders history on an RPC that caps log ranges, by bisecting', async () => {
    // The window is 200,000 blocks and public RPCs cap `eth_getLogs` at ~10,000. The single
    // `queryFilter` this replaced threw on every one of them, and the catch rendered an empty
    // history — a statement about the CHAIN made from a fact about the REQUEST. With the
    // bisecting scan the same provider answers.
    m.logsRangeCap = 10_000
    seedReads({
      events: [
        {
          args: { serviceId: EARN_LEND, oldBps: 0n, newBps: 50n, actor: TREASURY },
          blockNumber: 499_000,
          transactionHash: '0xabc',
        },
      ],
    })
    renderTab()
    expect(await screen.findByText('0 → 50 bps')).toBeInTheDocument()

    const accepted = m.scanCalls
      .filter((c) => c.getLogs)
      .filter((c) => c.getLogs.toBlock - c.getLogs.fromBlock + 1 <= m.logsRangeCap)
    expect(accepted.length).toBeGreaterThan(1) // it did have to split
    for (const c of accepted) {
      expect(c.getLogs.topics).toEqual(TOPIC_FEE_BPS_CHANGED)
      expect(c.getLogs.address).toBe(m.routerAddr) // the ethers fake ignored the address
    }
  })

  it('renders the change history from FeeBpsChanged events', async () => {
    seedReads({
      events: [
        {
          args: { serviceId: EARN_LEND, oldBps: 0n, newBps: 50n, actor: TREASURY },
          blockNumber: 499_000,
          transactionHash: '0xabc',
        },
      ],
    })
    renderTab()
    expect(await screen.findByText('0 → 50 bps')).toBeInTheDocument()
  })
})

describe('FeesTab editing & gating', () => {
  it('sends setFeeBps through runTx for an in-cap change', async () => {
    const tx = renderTab({ isAdmin: false, isFeeAdmin: true })
    await screen.findAllByText(/earn — vault lending/i)
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: EARN_LEND } })
    fireEvent.change(screen.getByLabelText(/new rate/i), { target: { value: '75' } })
    fireEvent.click(screen.getByRole('button', { name: /set fee rate/i }))
    await waitFor(() => expect(m.sent).toHaveLength(1))
    const sent = decodeSent()
    expect(sent.method).toBe('setFeeBps')
    expect(sent.to).toBe(m.routerAddr) // the fake it replaced ignored the address entirely
    expect(sent.args[0]).toBe(EARN_LEND)
    expect(Number(sent.args[1])).toBe(75)
    expect(tx).toHaveBeenCalled()
  })

  it('blocks an above-cap rate client-side with a clear error (contract would refuse too)', async () => {
    renderTab()
    await screen.findAllByText(/earn — vault lending/i)
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: EARN_LEND } })
    fireEvent.change(screen.getByLabelText(/new rate/i), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: /set fee rate/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/above this service's hard cap/i)
    expect(m.sent).toEqual([])
  })

  it('hides the rate editor entirely without the fee-admin capability', async () => {
    // The router says no — which is the answer that counts, since it is the contract that refuses.
    seedReads({ roles: { admin: false, feeAdmin: false } })
    renderTab({ isAdmin: false, isFeeAdmin: false })
    await screen.findAllByText(/earn — vault lending/i)
    expect(screen.queryByRole('button', { name: /set fee rate/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /set treasury/i })).not.toBeInTheDocument()
  })

  it('treasury changes are admin-only and validate the address', async () => {
    renderTab({ isAdmin: true })
    await screen.findAllByText(/earn — vault lending/i)
    fireEvent.change(screen.getByLabelText(/treasury address/i), { target: { value: 'nonsense' } })
    fireEvent.click(screen.getByRole('button', { name: /set treasury/i }))
    expect(await screen.findByText(/valid, nonzero treasury address/i)).toBeInTheDocument()
    expect(m.sent).toEqual([])

    fireEvent.change(screen.getByLabelText(/treasury address/i), { target: { value: TREASURY } })
    fireEvent.click(screen.getByRole('button', { name: /set treasury/i }))
    await waitFor(() => expect(m.sent).toHaveLength(1))
    const sent = decodeSent()
    expect(sent.method).toBe('setTreasury')
    expect(sent.to).toBe(m.routerAddr)
    expect(sent.args[0].toLowerCase()).toBe(TREASURY.toLowerCase())
  })

  it('fee admins without full admin cannot change the treasury', async () => {
    seedReads({ roles: { admin: false, feeAdmin: true } })
    renderTab({ isAdmin: false, isFeeAdmin: true })
    await screen.findAllByText(/earn — vault lending/i)
    expect(screen.getByRole('button', { name: /set fee rate/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /set treasury/i })).not.toBeInTheDocument()
  })
})

/**
 * Spec 071 — capability is read from the router that enforces it, and an unconfirmed read keeps
 * the control offered rather than withheld (FR-044).
 */
describe('FeesTab reads capability from the scoped router', () => {
  it('offers the editor when the ROUTER grants it, even with no app-wide flag', async () => {
    seedReads({ roles: { admin: false, feeAdmin: true } })
    renderTab({ isAdmin: false, isFeeAdmin: false })
    expect(await screen.findByRole('button', { name: /set fee rate/i })).toBeInTheDocument()
  })

  it('withholds the editor when the ROUTER refuses, even with an app-wide flag', async () => {
    // Holding FEE_ADMIN_ROLE on another network is not holding it here. Showing the form on the
    // strength of an estate-wide flag offers a control that reverts.
    seedReads({ roles: { admin: false, feeAdmin: false } })
    renderTab({ isAdmin: true, isFeeAdmin: true })
    await screen.findAllByText(/earn — vault lending/i)
    expect(screen.queryByRole('button', { name: /set fee rate/i })).not.toBeInTheDocument()
  })

  it('keeps the editor available, and says so, when the role read FAILS', async () => {
    seedReads()
    m.reads.hasRole = async () => { throw new Error('rpc timeout') }
    renderTab({ isAdmin: false, isFeeAdmin: false })
    expect(await screen.findByRole('button', { name: /set fee rate/i })).toBeInTheDocument()
    expect(screen.getAllByText(/authority could not be confirmed/i).length).toBeGreaterThan(0)
  })
})
