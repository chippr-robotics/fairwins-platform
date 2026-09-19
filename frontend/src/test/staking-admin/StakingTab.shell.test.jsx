/**
 * Spec 066 (T019): StakingTab renders the honest "not deployed" empty state when no
 * router is on the network, role-gates its controls (config = STAKING_ADMIN, pause =
 * GUARDIAN), and is axe-clean.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { cohortChainIds } from '../../config/networks'

const m = vi.hoisted(() => ({ routerAddr: null, reads: {}, qfEvents: [], scanCalls: [] }))

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => m.routerAddr),
}))
vi.mock('../../config/blockExplorer', () => ({
  getBlockscoutUrl: () => 'https://explorer.example/address/0xrouter',
}))
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
const providerStub = {
  getBlockNumber: () => Promise.resolve(1000),
  getBlock: () => Promise.resolve({ timestamp: 0 }),
}

function baseProps(overrides = {}) {
  seedRoles(overrides)
  return {
    signer: {},
    chainId: WALLET_CHAIN,
    account: ACCOUNT,
    provider: providerStub,
    runTx: vi.fn(() => Promise.resolve()),
    pendingTx: false,
    isAdmin: false,
    isStakingAdmin: false,
    isGuardian: false,
    ...overrides,
  }
}

beforeEach(() => {
  m.routerAddr = null
  m.reads = {
    paused: () => Promise.resolve(false),
    validatorCount: () => Promise.resolve(0n),
    queryFilter: () => Promise.resolve([]),
  }
})

describe('StakingTab — not deployed', () => {
  it('shows the honest not-deployed empty state', () => {
    m.routerAddr = ''
    render(<StakingTab {...baseProps({ isAdmin: true })} />)
    expect(screen.getByText(/No StakingRouter is deployed/i)).toBeInTheDocument()
    expect(screen.queryByText(/Emergency pause/i)).not.toBeInTheDocument()
  })

  it('is axe-clean in the not-deployed state', async () => {
    m.routerAddr = ''
    const { container } = render(<StakingTab {...baseProps({ isAdmin: true })} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('StakingTab — role gating', () => {
  it('a guardian sees pause but not the config controls', async () => {
    m.routerAddr = ROUTER
    render(<StakingTab {...baseProps({ isGuardian: true })} />)
    await waitFor(() => expect(screen.getByText('Emergency pause')).toBeInTheDocument())
    expect(screen.queryByText('Provider addresses')).not.toBeInTheDocument()
    expect(screen.queryByText('Validator allowlist')).not.toBeInTheDocument()
  })

  it('a staking admin sees the config controls', async () => {
    m.routerAddr = ROUTER
    render(<StakingTab {...baseProps({ isStakingAdmin: true })} />)
    await waitFor(() => expect(screen.getByText('Provider addresses')).toBeInTheDocument())
    expect(screen.getByText('Validator allowlist')).toBeInTheDocument()
    // Not a guardian ⇒ no pause control.
    expect(screen.queryByText('Emergency pause')).not.toBeInTheDocument()
  })

  it('is axe-clean when loaded with controls', async () => {
    m.routerAddr = ROUTER
    const { container } = render(<StakingTab {...baseProps({ isAdmin: true })} />)
    await waitFor(() => expect(screen.getByText('Provider addresses')).toBeInTheDocument())
    expect(await axe(container)).toHaveNoViolations()
  })
})

/**
 * Spec 071 — the third failure mode the quickstart names: a write control offered on the strength
 * of an app-wide role flag rather than the contract on the scoped chain. That shows an operator an
 * enabled control that reverts.
 */
describe('StakingTab reads capability from the scoped router (FR-014, FR-044)', () => {
  it('withholds the pause when the ROUTER refuses, even with the app-wide guardian flag', async () => {
    m.routerAddr = ROUTER
    // Holding GUARDIAN_ROLE on another network is not holding it here.
    const p = baseProps({ isGuardian: true })
    seedRoles({})
    render(<StakingTab {...p} />)
    // Wait for the tab to finish loading, then assert the absence — so this cannot pass merely
    // because the render had not happened yet.
    await screen.findByText('Change history')
    await waitFor(() => expect(screen.queryByText('Emergency pause')).not.toBeInTheDocument())
  })

  it('offers the pause when the ROUTER grants it, with no app-wide flag at all', async () => {
    m.routerAddr = ROUTER
    const p = baseProps({})
    seedRoles({ isGuardian: true })
    render(<StakingTab {...p} />)
    await waitFor(() => expect(screen.getByText('Emergency pause')).toBeInTheDocument())
  })

  it('keeps the pause offered, and says so, when the role read FAILS', async () => {
    m.routerAddr = ROUTER
    const p = baseProps({})
    m.reads.hasRole = () => Promise.reject(new Error('rpc timeout'))
    render(<StakingTab {...p} />)
    // Hiding a killswitch because an RPC timed out tells an operator who holds it there isn't one.
    await waitFor(() => expect(screen.getByText('Emergency pause')).toBeInTheDocument())
    expect(screen.getAllByText(/authority could not be confirmed/i).length).toBeGreaterThan(0)
  })
})
