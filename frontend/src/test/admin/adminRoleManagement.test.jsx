/**
 * Admin role management — three verified gaps in the "screens to add and
 * remove roles from users" (specs 071 + 093):
 *
 *  1. ROLE_MANAGER's home contract is the reference-chain MembershipManager,
 *     so a grant signed on the SCOPED chain lands on an address with no code
 *     and "succeeds" as a no-op. The write must require the wallet on
 *     `membershipChainId()`, be withheld in words otherwise, and name the
 *     membership chain in its confirmation.
 *  2. FEE_ADMIN_ROLE (spec 060, FeeRouter) gates the whole Fees tab but was
 *     absent from the picker — no in-app way to grant it. It must appear with
 *     the FeeRouter as its home contract, resolved per scoped chain.
 *  3. The MembershipManager is role-keyed and pools (spec 034) gate on
 *     POOL_PARTICIPANT_ROLE, which a WAGER_PARTICIPANT membership does not
 *     satisfy. The tier/grant/revoke forms carry a role selector that
 *     DEFAULTS to Wager Participant (existing behaviour unchanged) and passes
 *     the selected role hash through.
 *  4. FR-019: both apps offered their writes on ESTATE-WIDE role flags
 *     (`isAdmin` / `isRoleManager` — true when held on ANY cohort chain,
 *     against a candidate list that need not include the contract being
 *     written to) plus a wallet-chain match. No `hasRole` was ever asked of
 *     the contract that would enforce the call. Authority now comes from that
 *     contract, on the chain the transaction signs on, in three states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ethers as realEthers } from 'ethers'
import { membershipChainId, cohortChainIds } from '../../config/networks'
import { networkName } from '../../lib/chains/estate'
import { readOk } from '../../lib/chains/chainReadResult'

const m = vi.hoisted(() => ({
  chainId: 137,
  deployed: {},
  contractCalls: [],
  notify: null, // assigned in beforeEach
  runTx: null,
  // Every readAuthority the apps make lands here, and its answer comes from
  // `authorityFor` — the seam these FR-019 tests drive.
  authorityReads: [],
  authorityFor: null, // assigned in beforeEach
  feeEstate: null, // assigned in beforeEach
}))

vi.mock('../../hooks/useRoles', () => ({
  useRoles: () => ({
    hasRole: () => true,
    hasAnyRole: () => true,
    estateRead: { read: [137], unreadable: [], swept: true },
    chainsForRole: () => [],
    loadRoles: vi.fn(),
  }),
}))
vi.mock('../../hooks/useWeb3', () => ({
  useWeb3: () => ({ account: '0xabc', signer: m.signer, provider: null, chainId: m.chainId }),
}))
vi.mock('../../hooks/useUI', () => ({ useNotification: () => ({ showNotification: m.notify }) }))
vi.mock('../../hooks/useMediaQuery', () => ({
  useIsMobile: () => false, useMediaQuery: () => false, useIsTablet: () => false, useIsExtraSmall: () => false,
}))
vi.mock('../../hooks/useEnsResolution', () => ({
  useEnsResolution: () => ({ resolvedAddress: '', isEns: false, isLoading: false }),
}))
vi.mock('../../utils/blockchainService', () => ({ getProvider: () => null }))
vi.mock('../../lib/miniapps/registryAuthority', () => ({
  readCuratorAuthority: () => Promise.resolve({ held: false, outcome: 'not-held' }),
}))
vi.mock('../../hooks/useFeeEstate', () => ({ useFeeEstate: () => m.feeEstate }))
vi.mock('../../config/contracts', () => ({
  NETWORK_CONFIG: { name: 'Test', blockExplorer: 'https://x' },
  DEPLOYED_CONTRACTS: {},
  getContractAddressForChain: (key, chainId) => m.deployed[`${key}:${Number(chainId)}`] || '',
}))
// Data reads in these apps are not under test; a null provider keeps them inert.
// The AUTHORITY read is under test, so it is the one seam this file controls: the
// default answer is the honest one a null provider produces (UNCONFIRMED), which
// is what every pre-FR-019 assertion in this file was written against.
vi.mock('../../lib/chains/estate', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readProviderFor: () => null,
    readAuthority: (args) => {
      m.authorityReads.push(args)
      return Promise.resolve(m.authorityFor(args))
    },
  }
})
// Heavy re-hosted views are not under test here.
vi.mock('../../components/admin/MembershipTreasuryOverview', () => ({ default: () => <div data-testid="mto" /> }))
vi.mock('../../components/admin/ChainStateTable', () => ({ default: () => <table data-testid="chain-state" /> }))
vi.mock('../../components/admin/FeesTab', () => ({ default: () => <div /> }))
vi.mock('../../components/admin/PerpsFeesPanel', () => ({ default: () => <div /> }))

// The write runner: invokes the tx factory so the recording Contract below
// captures the address + calldata the view would actually sign.
vi.mock('../../components/admin/useAdminTx', () => ({
  useAdminTx: () => ({ runTx: m.runTx, pendingTx: false }),
}))

// Every ethers.Contract the views construct records its address and calls.

/**
 * BOTH apps in this file write calldata now (spec 110): `encodeFunctionData` +
 * `sendTransaction`. The signer DECODES what it is asked to send back into the same
 * `{address, method, args}` shape the `RecordingContract` fake used to record, so every assertion
 * in this file reads UNCHANGED — and is now backed by the actual bytes rather than by the argument
 * list a fake was handed. That fake is deleted: with both apps off ethers it guarded nothing, the
 * retired-mock shape `src/test/lint/ethersMockRatchet.test.js` fails on.
 *
 * It was one of the better fakes — it kept the address it was constructed with, so its assertions
 * really did check targeting. Decoding here preserves that rather than trading it away.
 */
m.signer = {
  sendTransaction: async ({ to, data }) => {
    const parsed = new realEthers.Interface([
      'function grantRole(bytes32 role, address account)',
      'function revokeRole(bytes32 role, address account)',
      'function setTier(bytes32 role, uint8 tier, uint128 priceUSDC, uint32 durationDays, (uint32 monthlyMarketCreation,uint32 maxConcurrentMarkets) limits, bool active)',
      'function grantMembership(address user, bytes32 role, uint8 tier, uint32 durationDays)',
      'function revokeMembership(address user, bytes32 role)',
      'function withdrawFees(uint128 amount, address to)',
    ]).parseTransaction({ data })
    m.contractCalls.push({
      address: to,
      method: parsed.name,
      // `parseTransaction` returns a Result; the assertions compare against plain arrays.
      args: Array.from(parsed.args),
    })
    return { hash: '0xdeadbeef', wait: async () => ({}) }
  },
}

import AccessControlApp from '../../components/admin/apps/AccessControlApp'
import MembershipRevenueApp from '../../components/admin/apps/MembershipRevenueApp'

const MEMBERSHIP = Number(membershipChainId())
// A cohort chain that is NOT the membership home — where the scope picker can
// legitimately sit while ROLE_MANAGER must still refuse to sign.
const OTHER = cohortChainIds().map(Number).find((id) => id !== MEMBERSHIP)
const membershipName = networkName(MEMBERSHIP)
const otherName = networkName(OTHER)

const ADDRS = {
  membershipManager: `0x${'aa'.repeat(20)}`,
  feeRouter: `0x${'bb'.repeat(20)}`,
  wagerRegistry: `0x${'cc'.repeat(20)}`,
}
const TARGET = `0x${'22'.repeat(20)}`

const keccakRole = (name) => realEthers.keccak256(realEthers.toUtf8Bytes(name))

const mount = (El, path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <El />
    </MemoryRouter>,
  )

/** The three authority answers, in the shape `readAuthority` returns. */
const UNCONFIRMED = { roles: {}, readable: false, deployed: true, reason: 'no read connection to this network' }
const heldAuthority = (roles) => ({ roles, readable: true, deployed: true, reason: null })

beforeEach(() => {
  m.chainId = OTHER
  m.contractCalls = []
  m.authorityReads = []
  m.authorityFor = () => UNCONFIRMED
  m.feeEstate = { accrued: [], received: [], accruedTotals: null, receivedTotals: null, refresh: vi.fn() }
  m.notify = vi.fn()
  m.runTx = vi.fn(async (fn) => {
    await fn()
    return true
  })
  m.deployed = {
    [`membershipManager:${MEMBERSHIP}`]: ADDRS.membershipManager,
    [`feeRouter:${OTHER}`]: ADDRS.feeRouter,
    [`wagerRegistry:${OTHER}`]: ADDRS.wagerRegistry,
    [`wagerRegistry:${MEMBERSHIP}`]: ADDRS.wagerRegistry,
  }
})

// ── Finding 1: ROLE_MANAGER signs on the membership chain, never the scope ──
describe('AccessControlApp: ROLE_MANAGER is pinned to the membership chain', () => {
  const openRolesView = () => mount(AccessControlApp, '/admin/access-control?view=admin-roles')

  it('withholds the write IN WORDS when the wallet is off the membership chain', async () => {
    m.chainId = OTHER // wallet and scope both sit on a non-membership cohort chain
    openRolesView()

    fireEvent.change(await screen.findByLabelText(/^Role/), { target: { value: 'ROLE_MANAGER' } })

    // The header names the chain the transaction will actually land on —
    // never the scoped chain the write does not touch.
    expect(
      await screen.findByRole('heading', { name: `Grant / Revoke Admin Roles on ${membershipName}` }),
    ).toBeInTheDocument()
    // The scope/sign divergence is spelled out…
    expect(screen.getByText(new RegExp(`This view is scoped to ${otherName}, but Role Manager`)))
      .toBeInTheDocument()
    // …the reason the write is withheld is stated, naming the signing chain…
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent(/Role Manager lives on the MembershipManager/i)
    expect(notice).toHaveTextContent(membershipName)
    // …and the buttons are disabled with words, not silently dead.
    expect(
      screen.getByRole('button', { name: new RegExp(`Switch to ${membershipName} to grant`) }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: new RegExp(`Switch to ${membershipName} to revoke`) }),
    ).toBeDisabled()
    expect(m.runTx).not.toHaveBeenCalled()
  })

  it('other roles keep the scoped-chain gate: on-scope wallet leaves them offered', async () => {
    m.chainId = OTHER
    openRolesView()
    // GUARDIAN (default) signs on the scoped chain, where the wallet is —
    // and the header says so.
    expect(
      await screen.findByRole('heading', { name: `Grant / Revoke Admin Roles on ${otherName}` }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grant Role' })).toBeEnabled()
    expect(screen.queryByText(/This grant is signed on/)).toBeNull()
    expect(screen.queryByText(/Role Manager lives on the MembershipManager/)).toBeNull()
    expect(screen.queryByText(/This view is scoped to/)).toBeNull()
  })

  it('a ROLE_MANAGER grant targets the MembershipManager and NAMES the membership chain, even scoped elsewhere', async () => {
    m.chainId = MEMBERSHIP // wallet where the grant actually signs
    openRolesView()

    // Scope the view AWAY from the membership chain: the pin, not the scope,
    // must decide both the target contract and the named chain.
    fireEvent.change(await screen.findByLabelText(/^Network/), { target: { value: String(OTHER) } })
    fireEvent.change(screen.getByLabelText(/^Role/), { target: { value: 'ROLE_MANAGER' } })
    // The header follows the SIGNING chain, not the scope.
    expect(
      screen.getByRole('heading', { name: `Grant / Revoke Admin Roles on ${membershipName}` }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Account \(address or ENS\)/), { target: { value: TARGET } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant Role' }))

    await waitFor(() => expect(m.runTx).toHaveBeenCalled())
    // Signed against the membership chain's MembershipManager…
    expect(m.contractCalls).toEqual([
      {
        address: ADDRS.membershipManager,
        method: 'grantRole',
        args: [keccakRole('ROLE_MANAGER_ROLE'), TARGET],
      },
    ])
    // …and the success message names the membership chain, not the scope.
    const message = m.runTx.mock.calls[0][1]
    expect(message).toContain(membershipName)
    expect(message).not.toContain(otherName)
  })

  it('re-checks the wallet chain at the call site, not only in the disabled button', async () => {
    // A stale render cannot be constructed from a render test (React refuses
    // to dispatch onClick on a disabled fiber), so the guard is asserted where
    // it lives — the same precedent as adminViewScope.test.jsx.
    const src = (await import('../../components/admin/apps/AccessControlApp.jsx?raw')).default
    const grantBody = src.slice(src.indexOf('const handleGrantAdminRole'), src.indexOf('const handleRevokeAdminRole'))
    const revokeBody = src.slice(src.indexOf('const handleRevokeAdminRole'), src.indexOf('// Dashboard:'))
    expect(grantBody).toMatch(/if \(!requireRoleWriteChain\(adminRoleForm\.role\)\) return false/)
    expect(revokeBody).toMatch(/if \(!requireRoleWriteChain\(adminRoleForm\.role\)\) return false/)
    // And the required chain for ROLE_MANAGER is the membership chain.
    expect(src).toMatch(/role === 'ROLE_MANAGER' \? Number\(membershipChainId\(\)\) : Number\(roleChainId\)/)
  })
})

// ── Finding 2: FEE_ADMIN_ROLE is grantable, homed on the FeeRouter ──────────
describe('AccessControlApp: FEE_ADMIN_ROLE on the FeeRouter', () => {
  it('appears in the role picker', async () => {
    mount(AccessControlApp, '/admin/access-control?view=admin-roles')
    const picker = await screen.findByLabelText(/^Role/)
    expect(
      within(picker).getByRole('option', { name: /Fee Administrator — service fee rates \(FeeRouter\)/ }),
    ).toBeInTheDocument()
  })

  it('lists the FeeRouter as its home contract on the scoped network dashboard', async () => {
    mount(AccessControlApp, '/admin/access-control')
    const row = (await screen.findByText('Fee Administrator (FeeRouter)')).closest('tr')
    expect(within(row).getByTitle(ADDRS.feeRouter)).toBeInTheDocument()
  })

  it('grants keccak(FEE_ADMIN_ROLE) against the scoped chain FeeRouter', async () => {
    m.chainId = OTHER
    mount(AccessControlApp, '/admin/access-control?view=admin-roles')

    fireEvent.change(await screen.findByLabelText(/^Role/), { target: { value: 'FEE_ADMIN' } })
    fireEvent.change(screen.getByLabelText(/Account \(address or ENS\)/), { target: { value: TARGET } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant Role' }))

    await waitFor(() => expect(m.runTx).toHaveBeenCalled())
    expect(m.contractCalls).toEqual([
      {
        address: ADDRS.feeRouter,
        method: 'grantRole',
        // Matches contracts/fees/FeeRouter.sol: keccak256("FEE_ADMIN_ROLE").
        args: [keccakRole('FEE_ADMIN_ROLE'), TARGET],
      },
    ])
    expect(m.runTx.mock.calls[0][1]).toContain(otherName)
  })

  it('refuses honestly where no FeeRouter is deployed', async () => {
    delete m.deployed[`feeRouter:${OTHER}`]
    m.chainId = OTHER
    mount(AccessControlApp, '/admin/access-control?view=admin-roles')

    fireEvent.change(await screen.findByLabelText(/^Role/), { target: { value: 'FEE_ADMIN' } })
    fireEvent.change(screen.getByLabelText(/Account \(address or ENS\)/), { target: { value: TARGET } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant Role' }))

    await waitFor(() =>
      expect(m.notify).toHaveBeenCalledWith('Role contract not deployed on this network', 'error'),
    )
    expect(m.runTx).not.toHaveBeenCalled()
  })
})

// ── Finding 3: membership forms are role-keyed, defaulting to wager ─────────
describe('MembershipRevenueApp: membership role selector', () => {
  const WAGER_HASH = keccakRole('WAGER_PARTICIPANT_ROLE')
  const POOL_HASH = keccakRole('POOL_PARTICIPANT_ROLE')

  const openMembers = () => mount(MembershipRevenueApp, '/admin/membership-revenue?view=members')

  it('defaults every selector to Wager Participant, keeping existing behaviour', async () => {
    m.chainId = MEMBERSHIP
    openMembers()

    const selectors = await screen.findAllByLabelText(/^Membership role/)
    expect(selectors).toHaveLength(2) // grant + revoke forms
    for (const sel of selectors) expect(sel).toHaveValue('WAGER_PARTICIPANT')

    // Driving the grant form WITHOUT touching the selector still grants
    // WAGER_PARTICIPANT_ROLE — the pre-selector behaviour, byte for byte.
    fireEvent.change(screen.getByLabelText(/Recipient/), { target: { value: TARGET } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant Membership' }))
    await waitFor(() => expect(m.runTx).toHaveBeenCalled())
    // `1n` / `30n`, not `1` / `30`: these are now DECODED FROM THE CALLDATA, and ethers decodes
    // `uint8`/`uint32` as bigints. The fake this replaced recorded the JS numbers the component
    // handed it, having never encoded anything — so the old expectation described the call site
    // rather than the transaction. The component still passes numbers and viem encodes them
    // identically; what changed is that the assertion now reads the bytes.
    expect(m.contractCalls).toEqual([
      {
        address: ADDRS.membershipManager,
        method: 'grantMembership',
        args: [TARGET, WAGER_HASH, 1n, 30n],
      },
    ])
  })

  it('switching to Pool Participant passes POOL_PARTICIPANT_ROLE to grant, and says so', async () => {
    m.chainId = MEMBERSHIP
    openMembers()

    const [grantRoleSel] = await screen.findAllByLabelText(/^Membership role/)
    fireEvent.change(grantRoleSel, { target: { value: 'POOL_PARTICIPANT' } })
    fireEvent.change(screen.getByLabelText(/Recipient/), { target: { value: TARGET } })
    fireEvent.click(screen.getByRole('button', { name: 'Grant Membership' }))

    await waitFor(() => expect(m.runTx).toHaveBeenCalled())
    expect(m.contractCalls[0].method).toBe('grantMembership')
    expect(m.contractCalls[0].args[1]).toBe(POOL_HASH)
    expect(m.runTx.mock.calls[0][1]).toContain('Pool Participant')
  })

  it('revoke passes the selected role hash — a pool revocation never touches the wager role', async () => {
    m.chainId = MEMBERSHIP
    openMembers()

    const selectors = await screen.findAllByLabelText(/^Membership role/)
    fireEvent.change(selectors[1], { target: { value: 'POOL_PARTICIPANT' } })
    fireEvent.change(screen.getByLabelText(/^Account$/), { target: { value: TARGET } })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Membership' }))

    await waitFor(() => expect(m.runTx).toHaveBeenCalled())
    expect(m.contractCalls).toEqual([
      {
        address: ADDRS.membershipManager,
        method: 'revokeMembership',
        args: [TARGET, POOL_HASH],
      },
    ])
    expect(m.runTx.mock.calls[0][1]).toContain('Pool Participant')
  })

  it('the tier form configures the selected role and defaults to the wager ladder', async () => {
    m.chainId = MEMBERSHIP
    mount(MembershipRevenueApp, '/admin/membership-revenue?view=tiers')

    // Default: the heading and the write both speak Wager Participant.
    expect(await screen.findByRole('heading', { name: new RegExp(`Configure Tier: Wager Participant on ${membershipName}`) }))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save Tier Config' }))
    await waitFor(() => expect(m.runTx).toHaveBeenCalledTimes(1))
    expect(m.contractCalls[0].method).toBe('setTier')
    expect(m.contractCalls[0].args[0]).toBe(WAGER_HASH)

    // Switched: the same form drives the pool ladder.
    fireEvent.change(screen.getByLabelText(/^Membership role/), { target: { value: 'POOL_PARTICIPANT' } })
    expect(screen.getByRole('heading', { name: new RegExp(`Configure Tier: Pool Participant on ${membershipName}`) }))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save Tier Config' }))
    await waitFor(() => expect(m.runTx).toHaveBeenCalledTimes(2))
    expect(m.contractCalls[1].method).toBe('setTier')
    expect(m.contractCalls[1].args[0]).toBe(POOL_HASH)
  })

  it('the reference-chain pin is untouched: off the membership chain the write refuses in words', async () => {
    m.chainId = OTHER
    openMembers()

    fireEvent.change(await screen.findByLabelText(/Recipient/), { target: { value: TARGET } })
    // The button is disabled; the call-site guard is the same requireMembershipChain
    // the app always had, so assert the stated reason via the standing warning.
    expect(screen.getByRole('button', { name: 'Grant Membership' })).toBeDisabled()
    expect(
      screen.getAllByText(new RegExp(`Memberships live on ${membershipName}`, 'i')).length,
    ).toBeGreaterThan(0)
    expect(m.runTx).not.toHaveBeenCalled()
  })
})

// ── Finding 4: authority is READ FROM THE CONTRACT, in three states (FR-019) ──
//
// The defect: Grant/Revoke here, and grant/revoke/tier/withdraw next door, were
// offered on `useAdminAccess().flags` — estate-wide booleans, true when the role
// is held on ANY cohort chain — plus a wallet-chain match. Neither is authority
// over the contract the transaction goes to. An operator holding DEFAULT_ADMIN on
// one network was shown an enabled Grant Role on every other, and the only thing
// that ever said no was the revert.
//
// The three states are not interchangeable, and each is asserted separately:
//   held        → offered, exactly as before
//   not held    → WITHHELD, and it says who lacks what on which contract, on which chain
//   unconfirmed → still OFFERED (an RPC timeout is not a denial), and says so
describe('AccessControlApp: DEFAULT_ADMIN_ROLE is read from the role’s home contract (FR-019)', () => {
  const openRolesView = () => mount(AccessControlApp, '/admin/access-control?view=admin-roles')
  const grantBtn = () => screen.getByRole('button', { name: 'Grant Role' })
  const revokeBtn = () => screen.getByRole('button', { name: 'Revoke Role' })

  it('asks the SELECTED role’s home contract, on the chain that grant signs on', async () => {
    m.chainId = MEMBERSHIP
    openRolesView()

    // Default GUARDIAN: the WagerRegistry on the scoped chain.
    await waitFor(() => expect(m.authorityReads.length).toBeGreaterThan(0))
    expect(m.authorityReads.at(-1)).toMatchObject({
      address: ADDRS.wagerRegistry,
      account: '0xabc',
      roles: ['admin'],
    })

    // ROLE_MANAGER: the reference-chain MembershipManager, never the scoped chain's registry.
    fireEvent.change(screen.getByLabelText(/^Role/), { target: { value: 'ROLE_MANAGER' } })
    await waitFor(() =>
      expect(m.authorityReads.at(-1)).toMatchObject({
        address: ADDRS.membershipManager,
        roles: ['admin'],
      }),
    )
  })

  it('HELD ⇒ the controls are offered, with their labels unchanged', async () => {
    m.authorityFor = () => heldAuthority({ admin: true })
    m.chainId = OTHER
    openRolesView()

    await waitFor(() => expect(grantBtn()).toBeEnabled())
    expect(revokeBtn()).toBeEnabled()
    expect(screen.queryByText(/does not hold/i)).toBeNull()
    expect(screen.queryByText(/could not be confirmed/i)).toBeNull()
  })

  it('NOT HELD ⇒ withheld, naming the account, the role, the contract and the chain', async () => {
    m.authorityFor = () => heldAuthority({ admin: false })
    m.chainId = OTHER
    openRolesView()

    await waitFor(() => expect(grantBtn()).toBeDisabled())
    expect(revokeBtn()).toBeDisabled()

    const notice = screen.getByText(/does not hold DEFAULT_ADMIN_ROLE/)
    expect(notice).toHaveTextContent('0xabc') // who
    expect(notice).toHaveTextContent('DEFAULT_ADMIN_ROLE') // what
    expect(notice).toHaveTextContent('WagerRegistry') // on which contract
    expect(notice).toHaveTextContent(otherName) // on which chain
    expect(notice).toHaveTextContent(/withheld/i)
  })

  it('NOT HELD on the MembershipManager names THAT contract and the membership chain', async () => {
    m.authorityFor = () => heldAuthority({ admin: false })
    m.chainId = MEMBERSHIP
    openRolesView()

    fireEvent.change(await screen.findByLabelText(/^Role/), { target: { value: 'ROLE_MANAGER' } })
    await waitFor(() => expect(grantBtn()).toBeDisabled())

    const notice = screen.getByText(/does not hold DEFAULT_ADMIN_ROLE/)
    expect(notice).toHaveTextContent('MembershipManager')
    expect(notice).toHaveTextContent(membershipName)
    // The WagerRegistry is not what enforces a ROLE_MANAGER grant, so it is not named.
    expect(notice).not.toHaveTextContent('WagerRegistry')
  })

  it('UNCONFIRMED ⇒ still offered, and says the contract is the real gate', async () => {
    m.authorityFor = () => UNCONFIRMED
    m.chainId = OTHER
    openRolesView()

    await waitFor(() => expect(screen.getByText(/could not be confirmed/i)).toBeInTheDocument())
    // An RPC timeout is not a denial: the control stays available.
    expect(grantBtn()).toBeEnabled()
    expect(revokeBtn()).toBeEnabled()
    const notice = screen.getByText(/could not be confirmed/i)
    expect(notice).toHaveTextContent('WagerRegistry')
    expect(notice).toHaveTextContent(otherName)
    expect(notice).toHaveTextContent(/will refuse anything you do not hold/i)
    expect(screen.queryByText(/does not hold/i)).toBeNull()
  })

  it('an UNCONFIRMED read still signs — the contract, not the app, refuses', async () => {
    m.authorityFor = () => UNCONFIRMED
    m.chainId = OTHER
    openRolesView()

    fireEvent.change(await screen.findByLabelText(/Account \(address or ENS\)/), { target: { value: TARGET } })
    fireEvent.click(grantBtn())
    await waitFor(() => expect(m.runTx).toHaveBeenCalled())
    expect(m.contractCalls[0]).toMatchObject({ address: ADDRS.wagerRegistry, method: 'grantRole' })
  })

  it('re-checks authority at the call site, not only in the disabled button', async () => {
    const src = (await import('../../components/admin/apps/AccessControlApp.jsx?raw')).default
    const grantBody = src.slice(src.indexOf('const handleGrantAdminRole'), src.indexOf('const handleRevokeAdminRole'))
    const revokeBody = src.slice(src.indexOf('const handleRevokeAdminRole'), src.indexOf('// Dashboard:'))
    expect(grantBody).toMatch(/if \(!requireRoleAdminAuthority\(\)\) return false/)
    expect(revokeBody).toMatch(/if \(!requireRoleAdminAuthority\(\)\) return false/)
  })

  it('the chain guard is untouched: off the write chain the chain notice is the one shown', async () => {
    // Two reasons at once is two instructions; the actionable one is the network.
    m.authorityFor = () => heldAuthority({ admin: false })
    m.chainId = OTHER
    openRolesView()
    fireEvent.change(await screen.findByLabelText(/^Role/), { target: { value: 'ROLE_MANAGER' } })

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: new RegExp(`Switch to ${membershipName} to grant`) }),
      ).toBeDisabled(),
    )
    expect(screen.queryByText(/does not hold DEFAULT_ADMIN_ROLE/)).toBeNull()
  })
})

describe('MembershipRevenueApp: each write is gated on the role its function requires (FR-019)', () => {
  const openMembers = () => mount(MembershipRevenueApp, '/admin/membership-revenue?view=members')
  const openTiers = () => mount(MembershipRevenueApp, '/admin/membership-revenue?view=tiers')
  const grantBtn = () => screen.getByRole('button', { name: 'Grant Membership' })
  const revokeBtn = () => screen.getByRole('button', { name: 'Revoke Membership' })
  const tierBtn = () => screen.getByRole('button', { name: 'Save Tier Config' })

  it('asks the reference-chain MembershipManager for BOTH roles in one read', async () => {
    m.chainId = MEMBERSHIP
    openMembers()
    await waitFor(() => expect(m.authorityReads.length).toBeGreaterThan(0))
    expect(m.authorityReads[0]).toMatchObject({
      address: ADDRS.membershipManager,
      account: '0xabc',
      roles: ['admin', 'roleManager'],
    })
  })

  it('HELD ⇒ grant/revoke offered on ROLE_MANAGER_ROLE, tier offered on DEFAULT_ADMIN_ROLE', async () => {
    m.authorityFor = () => heldAuthority({ admin: true, roleManager: true })
    m.chainId = MEMBERSHIP
    openMembers()
    await waitFor(() => expect(grantBtn()).toBeEnabled())
    expect(revokeBtn()).toBeEnabled()
    expect(screen.queryByText(/does not hold/i)).toBeNull()
  })

  /*
   * The sharp case, and the reason these are two separate gates: OpenZeppelin
   * AccessControl has NO hierarchy. `grantMembership`/`revokeMembership` are
   * `onlyRole(ROLE_MANAGER_ROLE)` (MembershipManager.sol:223/:237), so holding
   * DEFAULT_ADMIN_ROLE does not satisfy them — a single "is an admin" gate would
   * offer a write the contract reverts.
   */
  it('DEFAULT_ADMIN alone does NOT unlock grant/revoke — but it does unlock the tier ladder', async () => {
    m.authorityFor = () => heldAuthority({ admin: true, roleManager: false })
    m.chainId = MEMBERSHIP
    openMembers()

    await waitFor(() => expect(grantBtn()).toBeDisabled())
    expect(revokeBtn()).toBeDisabled()
    const notice = screen.getAllByText(/does not hold ROLE_MANAGER_ROLE/)[0]
    expect(notice).toHaveTextContent('MembershipManager')
    expect(notice).toHaveTextContent(membershipName)

    // Same authority, different function, different answer.
    openTiers()
    await waitFor(() => expect(tierBtn()).toBeEnabled())
  })

  it('ROLE_MANAGER alone does NOT unlock setTier — it is onlyRole(DEFAULT_ADMIN_ROLE)', async () => {
    m.authorityFor = () => heldAuthority({ admin: false, roleManager: true })
    m.chainId = MEMBERSHIP
    openTiers()

    await waitFor(() => expect(tierBtn()).toBeDisabled())
    const notice = screen.getByText(/does not hold DEFAULT_ADMIN_ROLE/)
    expect(notice).toHaveTextContent('MembershipManager')
    expect(notice).toHaveTextContent(membershipName)
    expect(notice).toHaveTextContent(/withheld/i)
  })

  it('UNCONFIRMED ⇒ every membership write stays offered, and says why it is unsure', async () => {
    m.authorityFor = () => UNCONFIRMED
    m.chainId = MEMBERSHIP
    openMembers()

    await waitFor(() => expect(screen.getAllByText(/could not be confirmed/i).length).toBeGreaterThan(0))
    expect(grantBtn()).toBeEnabled()
    expect(revokeBtn()).toBeEnabled()
    expect(screen.queryByText(/does not hold/i)).toBeNull()
  })

  it('a definite NOT HELD refuses at the call site too, in the same words', async () => {
    m.authorityFor = () => heldAuthority({ admin: true, roleManager: false })
    m.chainId = MEMBERSHIP
    const src = (await import('../../components/admin/apps/MembershipRevenueApp.jsx?raw')).default
    expect(src).toMatch(/if \(!requireAuthority\(memberGate\)\) return false/)
    expect(src).toMatch(/if \(!requireAuthority\(tierGate\)\) return false/)
    expect(src).toMatch(/if \(!requireAuthority\(withdrawGate\)\) return false/)
  })

  it('the reference-chain pin still wins: off the membership chain, no authority verdict is shown', async () => {
    m.authorityFor = () => heldAuthority({ admin: false, roleManager: false })
    m.chainId = OTHER
    openMembers()
    await waitFor(() => expect(grantBtn()).toBeDisabled())
    expect(screen.queryByText(/does not hold/i)).toBeNull()
    expect(screen.getAllByText(new RegExp(`Memberships live on ${membershipName}`, 'i')).length)
      .toBeGreaterThan(0)
  })
})

describe('MembershipRevenueApp: a withdrawal is gated on the CHOSEN chain’s manager (FR-019)', () => {
  const USDC = { symbol: 'USDC', decimals: 6 }
  const openTreasury = () => mount(MembershipRevenueApp, '/admin/membership-revenue?view=treasury')
  const withdrawBtn = () => screen.getByRole('button', { name: new RegExp(`^Withdraw on ${membershipName}`) })

  const withAccrued = () => {
    m.feeEstate = {
      accrued: [readOk(MEMBERSHIP, 1_000_000n, USDC)],
      received: [],
      accruedTotals: null,
      receivedTotals: null,
      refresh: vi.fn(),
    }
  }

  it('reads DEFAULT_ADMIN_ROLE from the MembershipManager on the withdrawal chain', async () => {
    withAccrued()
    m.chainId = MEMBERSHIP
    openTreasury()
    await waitFor(() =>
      expect(m.authorityReads.some((r) => r.roles.length === 1 && r.roles[0] === 'admin')).toBe(true),
    )
    const read = m.authorityReads.find((r) => r.roles.length === 1)
    expect(read).toMatchObject({ address: ADDRS.membershipManager, account: '0xabc' })
  })

  it('HELD ⇒ the withdrawal is offered, with the label the e2e drives', async () => {
    withAccrued()
    m.authorityFor = () => heldAuthority({ admin: true, roleManager: true })
    m.chainId = MEMBERSHIP
    openTreasury()
    await waitFor(() => expect(withdrawBtn()).toBeEnabled())
  })

  it('NOT HELD ⇒ withheld, naming DEFAULT_ADMIN_ROLE on that chain’s MembershipManager', async () => {
    withAccrued()
    m.authorityFor = () => heldAuthority({ admin: false, roleManager: true })
    m.chainId = MEMBERSHIP
    openTreasury()

    await waitFor(() => expect(withdrawBtn()).toBeDisabled())
    const notice = screen.getByText(/does not hold DEFAULT_ADMIN_ROLE/)
    expect(notice).toHaveTextContent('MembershipManager')
    expect(notice).toHaveTextContent(membershipName)
  })

  it('UNCONFIRMED ⇒ the withdrawal stays offered rather than vanishing on a timeout', async () => {
    withAccrued()
    m.authorityFor = () => UNCONFIRMED
    m.chainId = MEMBERSHIP
    openTreasury()
    await waitFor(() => expect(withdrawBtn()).toBeEnabled())
    expect(screen.getByText(/could not be confirmed/i)).toHaveTextContent(membershipName)
  })
})
