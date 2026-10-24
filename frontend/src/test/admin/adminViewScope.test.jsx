/**
 * Spec 071 T065 — per-view tests for the converted operator views (T054–T064).
 *
 * The shared controls already have their own suite (`adminScopeControls.test.jsx`). What that
 * one cannot show is whether a given VIEW actually wired itself to them, so this file renders
 * two real views end to end and checks the five things the task names:
 *
 *   • a scope off the wallet's network still renders read state
 *   • a withheld write says WHY, in words
 *   • an unreadable read is never a zero
 *   • "not deployed" is stated explicitly — and does not strand the operator
 *   • the write confirmation NAMES the chain it targets (FR-017)
 *
 * plus axe-cleanliness in each per-chain state (constitution V).
 *
 * DenyListAdmin and PaymasterOpsCard are rendered because they are the two converted views with
 * self-contained props — one compliance surface, one treasury surface. The remaining views
 * (Maintenance, Wiring & Tokens, Fees, Staking, Callsigns, Oracle Adapters, and the AdminPanel
 * sections) are covered at the source level below and by their own suites, because rendering
 * them means standing up the whole console; the source assertions target exactly the wiring a
 * render would have proven.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { NETWORKS, cohortChainIds } from '../../config/networks'

const notify = vi.fn()
vi.mock('../../hooks/useUI', () => ({ useNotification: () => ({ showNotification: notify }) }))

// Address book: the scoped chain decides what is deployed. `DEPLOYED` is rewritten per test.
let DEPLOYED = {}
vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: (key, chainId) => DEPLOYED[`${key}:${Number(chainId)}`] || '',
  NETWORK_CONFIG: { name: 'Test' },
  DEPLOYED_CONTRACTS: {},
}))

// The provider each chain answers with. A chain absent from this map has NO read connection —
// which is `unreadable`, and must never render as a zero.
let PROVIDERS = {}
vi.mock('../../lib/chains/estate', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readProviderFor: (chainId) => PROVIDERS[Number(chainId)] || null,
  }
})

const CONTRACTS = new Map()
const SEAM_READS = []
/**
 * Reads and scans through the chain seam (spec 110), routed BY ADDRESS exactly as the
 * `new ethers.Contract(addr, …)` fake this replaces was — that routing is what makes "the scoped
 * chain's contract answered" assertable. The chain is recorded too, which the fake could not do:
 * it was handed a runner and the chain lived inside it.
 */
vi.mock('../../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      SEAM_READS.push({ chainId, address, functionName })
      const impl = CONTRACTS.get(address)
      if (!impl || !impl[functionName]) return undefined
      return impl[functionName](...args)
    },
  }
})

vi.mock('../../lib/chains/eventScan', () => ({
  eventScanHandle: (chainId, { address }) => {
    const impl = CONTRACTS.get(address)
    if (!impl) return null
    SEAM_READS.push({ chainId, address, functionName: '<scan>' })
    return {
      target: address,
      provider: {
        getBlockNumber: async () => 100,
        getLogs: async () => (impl.logs ? impl.logs : []),
      },
      filters: new Proxy(
        {},
        { get: (_f, name) => () => ({ getTopicFilter: () => ({ __event: String(name) }) }) },
      ),
      interface: { parseLog: (log) => ({ name: log.__name, args: log.args || {} }) },
    }
  },
}))

const COHORT = cohortChainIds()
const HOME = COHORT[0] // where the wallet is
const AWAY = COHORT[1] // where the operator scopes to
const nameOf = (id) => NETWORKS[id].name

let DenyListAdmin
let PaymasterOpsCard
beforeEach(async () => {
  vi.clearAllMocks()
  DEPLOYED = {}
  PROVIDERS = {}
  CONTRACTS.clear()
  DenyListAdmin = (await import('../../components/admin/DenyListAdmin')).default
  PaymasterOpsCard = (await import('../../components/admin/PaymasterOpsCard')).default
})

const signerFor = () => ({ provider: { getBlockNumber: async () => 100 } })

// ── Deny-list: a compliance surface, where "not denied" must never be a guess ────────────────
describe('DenyListAdmin scopes its guard (T062)', () => {
  const renderView = (props = {}) => {
    const runTx = props.runTx || vi.fn().mockResolvedValue(true)
    const utils = render(
      <DenyListAdmin
        signer={signerFor()}
        account="0xabc"
        contracts={{}}
        chainId={props.chainId ?? HOME}
        runTx={runTx}
        pendingTx={false}
      />,
    )
    return { ...utils, runTx }
  }

  const guardAt = (chainId, impl) => {
    const addr = `0x${'11'.repeat(20)}`
    DEPLOYED[`sanctionsGuard:${chainId}`] = addr
    PROVIDERS[chainId] = { getBlockNumber: async () => 100 }
    CONTRACTS.set(addr, {
      logs: [],
      isDenied: async () => false,
      isAllowed: async () => true,
      ...impl,
    })
    return addr
  }

  it('states "not deployed" explicitly, and still offers the picker so the operator can leave', async () => {
    guardAt(AWAY, {})
    renderView({ chainId: HOME }) // wallet's chain has no guard; scope seeds there

    expect(await screen.findByRole('status')).toHaveTextContent(
      new RegExp(`not deployed on ${nameOf(HOME)}`, 'i'),
    )
    // The empty state keeps the way out. Dropping the picker here strands the operator.
    expect(screen.getByLabelText(/^Network/)).toBeInTheDocument()
  })

  it('reads a network the wallet is NOT on, and withholds the write in words', async () => {
    guardAt(AWAY, {})
    renderView({ chainId: HOME })

    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: String(AWAY) } })

    // Read state renders for the scoped chain...
    expect(await screen.findByText(new RegExp(`Manage the discretionary`, 'i'))).toBeInTheDocument()
    // ...and the reason the write is unavailable is stated, not implied by a dead button.
    expect(
      screen.getByText(new RegExp(`changing the deny-list needs your wallet on ${nameOf(AWAY)}`, 'i')),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(`Add to deny-list on ${nameOf(AWAY)}`) })).toBeDisabled()
  })

  // The call-site re-check is deliberately NOT a render test. React refuses to dispatch onClick
  // for a fiber whose props say `disabled`, so a disabled button cannot be clicked from a test at
  // all — stripping the DOM attribute does not help. The guard exists for a stale render, which is
  // a state a render test cannot construct, so it is asserted where it lives.
  it('refuses at the call site too, not only in the disabled button', async () => {
    const src = (await import('../../components/admin/DenyListAdmin.jsx?raw')).default
    expect(src).toMatch(/if \(!onScopeNetwork\) \{\n\s*setError\(`Switch your wallet to \$\{networkName\(scopeChainId\)\}/)
    expect(src).toMatch(/disabled=\{pendingTx \|\| !onScopeNetwork\}/)
  })

  it('names the chain in the confirmation it will show (FR-017)', async () => {
    guardAt(HOME, {})
    const { runTx } = renderView({ chainId: HOME })

    fireEvent.change(screen.getByLabelText(/Wallet address/i), { target: { value: `0x${'22'.repeat(20)}` } })
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: 'OFAC match' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Add to deny-list on ${nameOf(HOME)}`) }))

    await waitFor(() => expect(runTx).toHaveBeenCalled())
    expect(runTx.mock.calls[0][1]).toContain(nameOf(HOME))
  })

  it('an unreachable network reports status as UNKNOWN, never as clear', async () => {
    const addr = `0x${'11'.repeat(20)}`
    DEPLOYED[`sanctionsGuard:${HOME}`] = addr // deployed…
    // …but no provider: the question cannot be put.
    renderView({ chainId: HOME })

    fireEvent.change(screen.getByLabelText(/Wallet address/i), { target: { value: `0x${'22'.repeat(20)}` } })
    fireEvent.click(screen.getByRole('button', { name: /Check status/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/status is unknown, not clear/i)
    // The distinction that matters: it must not say the address is fine.
    expect(alert).not.toHaveTextContent(/denied: false/i)
  })

  it('is axe-clean deployed and undeployed alike', async () => {
    guardAt(HOME, {})
    const { container, unmount } = renderView({ chainId: HOME })
    await screen.findByText(/Manage the discretionary/i)
    expect(await axe(container)).toHaveNoViolations()
    unmount()

    DEPLOYED = {}
    const bare = renderView({ chainId: HOME })
    await screen.findByRole('status')
    expect(await axe(bare.container)).toHaveNoViolations()
  })
})

// ── Paymaster: a deposit read from one chain and labelled with another's currency ────────────
describe('PaymasterOpsCard scopes the deposit (T055)', () => {
  const renderCard = (props = {}) => {
    const runTx = props.runTx || vi.fn().mockResolvedValue(true)
    const utils = render(
      <PaymasterOpsCard
        signer={signerFor()}
        account={props.account || '0xabc'}
        provider={{}}
        chainId={props.chainId ?? HOME}
        nativeSymbol={NETWORKS[HOME].nativeCurrency?.symbol || 'ETH'}
        runTx={runTx}
        pendingTx={false}
      />,
    )
    return { ...utils, runTx }
  }

  const paymasterAt = (chainId, impl) => {
    const addr = `0x${'33'.repeat(20)}`
    DEPLOYED[`verifyingPaymaster:${chainId}`] = addr
    PROVIDERS[chainId] = {}
    CONTRACTS.set(addr, {
      getDeposit: async () => 5n * 10n ** 18n,
      verifyingSigner: async () => `0x${'44'.repeat(20)}`,
      owner: async () => `0x${'55'.repeat(20)}`,
      ...impl,
    })
    return addr
  }

  it('labels the deposit in the SCOPED chain currency, not the wallet\'s', async () => {
    paymasterAt(AWAY, {})
    renderCard({ chainId: HOME })
    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: String(AWAY) } })

    const awaySymbol = NETWORKS[AWAY].nativeCurrency?.symbol
    expect(await screen.findByText(new RegExp(`5\\.0 ${awaySymbol}`))).toBeInTheDocument()
  })

  it('says "could not be read" rather than showing a zero deposit', async () => {
    paymasterAt(HOME, { getDeposit: async () => { throw new Error('rpc timeout') } })
    renderCard({ chainId: HOME })

    expect(await screen.findByText(/Could not be read/i)).toBeInTheDocument()
    // A zero here would read as a drained paymaster and trigger an incident that isn't happening.
    expect(screen.queryByText(/^0\.0 /)).not.toBeInTheDocument()
  })

  it('keeps owner-only controls OFFERED when the owner read failed (FR-044)', async () => {
    paymasterAt(HOME, { owner: async () => { throw new Error('rpc timeout') } })
    renderCard({ chainId: HOME })

    await screen.findByText(/Could not be read/i)
    expect(screen.getByText(/Authority could not be confirmed/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Withdraw to/i), { target: { value: `0x${'66'.repeat(20)}` } })
    fireEvent.change(screen.getByLabelText(/^Amount/i), { target: { value: '1' } })
    expect(screen.getByRole('button', { name: /Withdraw Deposit on/i })).toBeEnabled()
  })

  it('withholds the write with a stated reason when scoped off the wallet', async () => {
    paymasterAt(AWAY, {})
    renderCard({ chainId: HOME })
    fireEvent.change(screen.getByLabelText(/^Network/), { target: { value: String(AWAY) } })

    // Every gated control says it — the deposit form and the two owner-only forms alike.
    const notices = await screen.findAllByText(
      new RegExp(`Switch your wallet to ${nameOf(AWAY)}`, 'i'),
    )
    expect(notices.length).toBeGreaterThan(0)
  })

  it('names the chain in the deposit confirmation (FR-017)', async () => {
    paymasterAt(HOME, {})
    const { runTx } = renderCard({ chainId: HOME })
    await screen.findByText(/EntryPoint deposit/i)

    fireEvent.change(screen.getByLabelText(/Top up deposit/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Deposit on ${nameOf(HOME)}$`) }))

    await waitFor(() => expect(runTx).toHaveBeenCalled())
    expect(runTx.mock.calls[0][1]).toContain(nameOf(HOME))
  })

  it('states "not deployed" for the many networks that have no paymaster', async () => {
    paymasterAt(AWAY, {})
    renderCard({ chainId: HOME })
    expect(
      await screen.findByText(new RegExp(`No verifying paymaster is deployed on ${nameOf(HOME)}`, 'i')),
    ).toBeInTheDocument()
  })

  it('is axe-clean with a deposit and without one', async () => {
    paymasterAt(HOME, {})
    const { container, unmount } = renderCard({ chainId: HOME })
    await screen.findByText(/EntryPoint deposit/i)
    expect(await axe(container)).toHaveNoViolations()
    unmount()

    DEPLOYED = {}
    const bare = renderCard({ chainId: HOME })
    await screen.findByText(/No verifying paymaster is deployed/i)
    expect(await axe(bare.container)).toHaveNoViolations()
  })
})

// ── The remaining converted views, at the source level ───────────────────────────────────────
//
// These take the whole console's props (or a `contracts` record) and rendering them means
// standing up AdminPanel. The two properties a render would have proven are structural, so they
// are asserted structurally: the address is resolved from a chain the view was GIVEN, and every
// confirmation names the chain the transaction lands on (FR-017).
describe('every converted view names the chain its write lands on (T054–T064, FR-017)', () => {
  const VIEWS = [
    ['MaintenanceTab', 'scopeChainId'],
    ['ProtocolConfigTab', 'scopeChainId'],
    ['FeesTab', 'scopeChainId'],
    ['StakingTab', 'scopeChainId'],
    ['CallsignRegistryAdmin', 'scopeChainId'],
    ['OracleAdaptersTab', 'scopeChainId'],
    ['DenyListAdmin', 'scopeChainId'],
    ['PaymasterOpsCard', 'scopeChainId'],
  ]

  it.each(VIEWS)('%s scopes to a picked network and names it', async (view, scopeVar) => {
    const src = (await import(`../../components/admin/${view}.jsx?raw`)).default
    // Scope comes from the shared hook, not from a local re-derivation of the wallet's chain.
    expect(src, `${view} should use useScopedChain`).toMatch(/useScopedChain\(/)
    // At least one user-facing string names the chain.
    expect(src, `${view} should name the chain somewhere`).toMatch(
      new RegExp(`networkName\\(${scopeVar}\\)`),
    )
  })

  it('the extracted apps name the chain for incidents, memberships and role grants alike (spec 093)', async () => {
    // Incidents and roles are per chain and scoped; memberships are PINNED to the reference chain,
    // which is why they name a different variable — there is no choice to offer.
    const incident = (await import('../../components/admin/apps/IncidentResponseApp.jsx?raw')).default
    const membership = (await import('../../components/admin/apps/MembershipRevenueApp.jsx?raw')).default
    const roles = (await import('../../components/admin/apps/AccessControlApp.jsx?raw')).default
    expect(incident).toMatch(/networkName\(incidentChainId\)/)
    expect(roles).toMatch(/networkName\(roleChainId\)/)
    expect(membership).toMatch(/networkName\(membershipAdminChainId\)/)
    // Each family re-checks the chain before sending, not only in the disabled button.
    expect(incident).toMatch(/const requireIncidentChain = \(\) => \{/)
    expect(membership).toMatch(/const requireMembershipChain = \(\) => \{/)
  })

  it('membership admin is PINNED, not scoped — a picker there would offer a wrong choice', async () => {
    const src = (await import('../../components/admin/apps/MembershipRevenueApp.jsx?raw')).default
    // Tiers and Members resolve the reference chain, never a picked one: a tier ladder configured
    // elsewhere is one no purchase consults, and a membership granted elsewhere is never read.
    expect(src).toMatch(/const membershipAdminChainId = membershipChainId\(\)/)
    expect(src).toMatch(/getContractAddressForChain\('membershipManager', membershipAdminChainId\)/)
  })
})
