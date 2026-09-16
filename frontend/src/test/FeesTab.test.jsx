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

const m = vi.hoisted(() => ({ routerAddr: null, reads: {}, writes: {} }))

vi.mock('../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => m.routerAddr),
}))
vi.mock('../hooks/useGatewayStatus', () => ({
  gatewayBaseUrl: () => '', // gateway rows exercise the unreachable path by default
}))
vi.mock('../config/blockExplorer', () => ({
  getBlockscoutUrl: () => 'https://explorer.example/address/0xrouter',
}))

// One fake Contract serves reads (provider) and writes (signer): methods come
// from m.reads / m.writes, plus the queryFilter/filters event surface.
vi.mock('ethers', async (orig) => {
  const actual = await orig()
  function FakeContract(_addr, _abi, signerOrProvider) {
    const table = signerOrProvider?.isSigner ? m.writes : m.reads
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return undefined
          if (prop === 'filters') return { FeeBpsChanged: () => ({}) }
          const key = String(prop)
          return (...args) => {
            const f = table[key]
            if (!f) throw new Error('unmocked contract method: ' + key)
            return f(...args)
          }
        },
      },
    )
  }
  return { ...actual, ethers: { ...actual.ethers, Contract: FakeContract }, Contract: FakeContract }
})

// The estate AUTHORITY read (`hasRole` on the router that will enforce it) moved onto the
// spec-110 chain seam; the tab's own FeeRouter reads still go through the contract mock above.
// Both tables are `m.reads`, so what a test seeds is unchanged.
vi.mock('../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [] }) => {
      const f = m.reads[functionName]
      if (!f) throw new Error('unmocked contract method: ' + functionName)
      return f(...args)
    },
  }
})

import FeesTab from '../components/admin/FeesTab'

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

const PROVIDER = { getBlockNumber: async () => 500_000, getBlock: async () => ({ timestamp: 1_752_800_000 }) }
const SIGNER = { isSigner: true }

// Spec 071: capability comes from the ROUTER's own AccessControl on the scoped chain, not from
// the app-wide props. `roles` here is what that router answers for the connected account — the
// props stay only as the pre-read stand-in while the first hasRole round-trip is in flight.
const ADMIN_ROLE = ethers.ZeroHash
const FEE_ADMIN_ROLE = ethers.id('FEE_ADMIN_ROLE')

function seedReads({ feeBps = { [EARN_LEND]: 50, [PM_TAKER]: 40 }, events = [], roles = { admin: true, feeAdmin: true } } = {}) {
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
    queryFilter: async () => events,
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
  m.writes = { setFeeBps: vi.fn(async () => ({})), setTreasury: vi.fn(async () => ({})) }
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
    await waitFor(() => expect(m.writes.setFeeBps).toHaveBeenCalledWith(EARN_LEND, 75))
    expect(tx).toHaveBeenCalled()
  })

  it('blocks an above-cap rate client-side with a clear error (contract would refuse too)', async () => {
    renderTab()
    await screen.findAllByText(/earn — vault lending/i)
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: EARN_LEND } })
    fireEvent.change(screen.getByLabelText(/new rate/i), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: /set fee rate/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/above this service's hard cap/i)
    expect(m.writes.setFeeBps).not.toHaveBeenCalled()
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
    expect(m.writes.setTreasury).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/treasury address/i), { target: { value: TREASURY } })
    fireEvent.click(screen.getByRole('button', { name: /set treasury/i }))
    await waitFor(() => expect(m.writes.setTreasury).toHaveBeenCalledWith(TREASURY))
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
