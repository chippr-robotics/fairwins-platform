/**
 * Spec 066 (T026/T029/T032/T035): the StakingTab control actions —
 *   US2 pause/resume (GUARDIAN), US3 provider addresses (STAKING_ADMIN, validate-before-send),
 *   US4 validator add/remove (STAKING_ADMIN), US5 on-chain history — dispatch through runTx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cohortChainIds } from '../../config/networks'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({ routerAddr: null, reads: {}, qfEvents: [], scanCalls: [] }))

vi.mock('../../config/contracts', () => ({ getContractAddressForChain: vi.fn(() => m.routerAddr) }))
vi.mock('../../config/blockExplorer', () => ({ getBlockscoutUrl: () => 'https://explorer.example/address/0x' }))
vi.mock('../../lib/fees/feeQuote', async (orig) => ({
  ...(await orig()),
  fetchFeeQuote: vi.fn(() => Promise.resolve({ available: false, bps: 0, capBps: 0 })),
}))
/**
 * The ethers fake that stood here is GONE: StakingTab reads through the chain seam now (spec
 * 110), so it intercepted nothing — the retired-mock shape `src/test/lint/ethersMockRatchet.test.js`
 * fails on. The `readContract` mock below already serves `m.reads`, so every seed is unchanged.
 */


// Spec 071: the tab scopes to a network the operator picks (seeded from the wallet's chain when
// that chain is in this build's cohort) and reads capability from the ROUTER's own AccessControl
// on that network. A chainId outside the cohort would scope elsewhere and gate every write off —
// correct behaviour, and not what these tests are about — so they run on a reachable chain and
// answer hasRole the way that network's router would.
const WALLET_CHAIN = cohortChainIds()[0]
const ACCOUNT = '0x2222222222222222222222222222222222222222'

import { ethers } from 'ethers'
// The estate AUTHORITY read (`hasRole` on the router that will enforce it) moved onto the
// spec-110 chain seam; the tab's own router reads still go through the contract mock above.
// Both serve `m.reads`, so what a test seeds is unchanged.
vi.mock('../../lib/chains/eventScan', () => ({
  eventScanHandle: (chainId, { address }) => {
    // Honours the address, so a scan pointed at nothing cannot quietly return seeded events —
    // a mock that ignores its address cannot distinguish what the assertion claims it does.
    if (!address) return null
    m.scanCalls.push({ chainId, address })
    return {
    target: address,
    provider: {
      getBlockNumber: async () => 1_000_000,
      // Seeded events, already decoded — the seam's own parseLog has its own suite.
      getLogs: async () => (m.qfEvents || []).map((e, i) => ({ ...e, index: e.index ?? i })),
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
    getPublicClient: () => ({ getBlock: async () => ({ timestamp: 1_752_800_000n }) }),
  }
})

vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [] }) => {
      const f = m.reads[functionName]
      return f ? f(...args) : undefined
    },
  }
})

import StakingTab from '../../components/admin/StakingTab'
// Capability now comes from the router's own AccessControl, so "a guardian" in these tests means
// the router answers hasRole(GUARDIAN_ROLE) — not that an app-wide prop said so. The props stay
// as the pre-read stand-in and are mirrored here so each test's intent is unchanged.
const ROLE_HASH = {
  admin: ethers.ZeroHash,
  stakingAdmin: ethers.id('STAKING_ADMIN_ROLE'),
  guardian: ethers.id('GUARDIAN_ROLE'),
}

function seedRoles({ isAdmin = false, isStakingAdmin = false, isGuardian = false } = {}) {
  const held = new Map([
    [ROLE_HASH.admin, isAdmin],
    [ROLE_HASH.stakingAdmin, isStakingAdmin],
    [ROLE_HASH.guardian, isGuardian],
  ])
  m.reads.hasRole = (role) => Promise.resolve(Boolean(held.get(role)))
}


const ROUTER = '0x1111111111111111111111111111111111111111'
const VALID = '0x00000000000000000000000000000000000000a1' // all-lowercase ⇒ checksum-safe
const provider = { getBlockNumber: () => Promise.resolve(1000), getBlock: () => Promise.resolve({ timestamp: 0 }) }

function props(overrides = {}) {
  const runTx = vi.fn(() => Promise.resolve())
  seedRoles(overrides)
  return {
    runTx,
    node: {
      signer: {}, chainId: WALLET_CHAIN, account: ACCOUNT, provider, runTx, pendingTx: false,
      isAdmin: false, isStakingAdmin: false, isGuardian: false, ...overrides,
    },
  }
}

beforeEach(() => {
  m.routerAddr = ROUTER
  m.qfEvents = []
  let qf = 0
  m.reads = {
    paused: () => Promise.resolve(false),
    feeRouter: () => Promise.resolve('0xfee'),
    lidoSteth: () => Promise.resolve('0xste'),
    lidoWsteth: () => Promise.resolve('0xwst'),
    spolController: () => Promise.resolve('0xctl'),
    spolToken: () => Promise.resolve('0xspt'),
    polToken: () => Promise.resolve('0xpol'),
    polygonStakeManager: () => Promise.resolve('0xmgr'),
    validatorCount: () => Promise.resolve(1n),
    validatorAt: () => Promise.resolve('0x00000000000000000000000000000000000000b2'),
    // Return each seeded event with a unique index so React keys don't collide across event names.
    queryFilter: () => Promise.resolve(m.qfEvents.map((e) => ({ ...e, index: qf++ }))),
  }
})

describe('US2 pause/resume (GUARDIAN)', () => {
  it('dispatches pause for a guardian', async () => {
    const { node, runTx } = props({ isGuardian: true })
    render(<StakingTab {...node} />)
    const btn = await screen.findByRole('button', { name: 'Pause staking' })
    fireEvent.click(btn)
    await waitFor(() => expect(runTx).toHaveBeenCalled())
    expect(runTx.mock.calls.some((c) => c[1] === 'Staking paused')).toBe(true)
  })
})

describe('US3 provider addresses (STAKING_ADMIN)', () => {
  it('rejects invalid input before send and dispatches a valid update', async () => {
    const { node, runTx } = props({ isStakingAdmin: true })
    render(<StakingTab {...node} />)
    await screen.findByText('Provider addresses')

    // Invalid: only one field / bad address → rejected, no runTx.
    fireEvent.change(screen.getByPlaceholderText('stETH 0x…'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set Lido' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(runTx).not.toHaveBeenCalled()

    // Valid pair → dispatched.
    fireEvent.change(screen.getByPlaceholderText('stETH 0x…'), { target: { value: VALID } })
    fireEvent.change(screen.getByPlaceholderText('wstETH 0x…'), { target: { value: VALID } })
    fireEvent.click(screen.getByRole('button', { name: 'Set Lido' }))
    await waitFor(() => expect(runTx).toHaveBeenCalled())
    expect(runTx.mock.calls.some((c) => c[1] === 'Lido contracts updated')).toBe(true)
  })
})

describe('US4 validator allowlist (STAKING_ADMIN)', () => {
  it('dispatches add and remove', async () => {
    const { node, runTx } = props({ isStakingAdmin: true })
    render(<StakingTab {...node} />)
    await screen.findByText('Validator allowlist')

    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: VALID } })
    fireEvent.click(screen.getByRole('button', { name: 'Add validator' }))
    await waitFor(() => expect(runTx.mock.calls.some((c) => /added/.test(c[1]))).toBe(true))

    const removeBtn = await screen.findByRole('button', { name: 'Remove' })
    fireEvent.click(removeBtn)
    await waitFor(() => expect(runTx.mock.calls.some((c) => /removed/.test(c[1]))).toBe(true))
  })
})

describe('US5 history', () => {
  it('renders a row per control event', async () => {
    m.qfEvents = [{ args: { actor: VALID }, blockNumber: 5, index: 0, transactionHash: '0xhist' }]
    const { node } = props({ isAdmin: true })
    render(<StakingTab {...node} />)
    await waitFor(() => expect(screen.getByText('FeeRouterUpdated')).toBeInTheDocument())
  })
})
