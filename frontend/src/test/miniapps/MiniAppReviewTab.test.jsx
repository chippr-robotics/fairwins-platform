/**
 * MiniAppReviewTab (spec 073 T038/T039, US4 · FR-004, FR-004a, FR-004b, FR-022).
 *
 * The queue rendering is the least interesting thing here. What these tests actually pin are the
 * four properties a security review established, each of which is a critical bug if it regresses:
 *
 * 1. **A decision names the bytes that were reviewed.** `approveApp`/`rejectProposal` must carry
 *    the `manifestHash` this UI DISPLAYED. A test that only checked "approve was called" would
 *    pass against a UI that sent the wrong tuple — and sending the wrong tuple is exactly how a
 *    vendor gets unreviewed code marked Approved, because the on-chain guard has nothing to catch.
 *    So every action assertion checks the ARGUMENT, not the call.
 *
 * 2. **`StaleProposal` is an outcome, not an error.** It means "the vendor replaced the package".
 *    The tab has to say so in those terms, re-read the record, and DROP the verification that was
 *    about the old bytes — a green "verified" badge surviving a substitution would be the whole
 *    attack, rendered as reassurance.
 *
 * 3. **Approval is gated on verification, and an integrity mismatch is not overridable.** A
 *    package that does not hash to the recorded hash could never launch; a package we merely could
 *    not REACH is a different (acknowledgeable) situation. Collapsing the two either blocks
 *    approvals during an outage or waves through a mismatch.
 *
 * 4. **Authority comes from the registry, and "could not ask" is not "no".** Three of the five
 *    authority states withhold controls, and they must not say the same thing: an operator told
 *    "you are not a curator" during an RPC outage goes hunting for a permissions problem that
 *    does not exist.
 *
 * Everything is mocked at an OUTCOME boundary — the registry read, the authority read, the
 * package verification, the contract — so this file tests how the tab presents and acts on those
 * answers, not how they are produced (`registryClient.test.js`, `loader.test.js` own that).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'

const state = vi.hoisted(() => ({
  /** Queue reads, consumed in order so a refresh can return a DIFFERENT registry state. */
  catalogOutcomes: [],
  authority: null,
  verification: null,
  /** Recorded contract calls: `{ method, args }`. */
  calls: [],
  /** Per-method error to throw instead of returning a transaction. */
  throwOn: {},
}))

vi.mock('../../lib/miniapps/registryClient', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    clearCatalogCache: vi.fn(),
    registryLocation: () => ({ chainId: 137, registryAddress: '0x5a168Cc9FeFaf40e7BC536C8C61669e6d547A0A2' }),
    fetchCatalog: vi.fn(async () =>
      state.catalogOutcomes.length > 1 ? state.catalogOutcomes.shift() : state.catalogOutcomes[0],
    ),
  }
})

vi.mock('../../lib/miniapps/registryAuthority', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, readCuratorAuthority: vi.fn(async () => state.authority) }
})

vi.mock('../../lib/miniapps/loader', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, verifyMiniAppPackage: vi.fn(async () => state.verification) }
})

vi.mock('../../data/ledger/sources/miniAppSource', () => ({
  captureMiniAppLog: vi.fn(() => 'entry-id'),
}))

import { ethers } from 'ethers'

import { AppCategory, AppStatus, MINI_APP_REGISTRY_ABI } from '../../abis/miniAppRegistry'
import { captureMiniAppLog } from '../../data/ledger/sources/miniAppSource'
import { VERIFICATION_FAILURE } from '../../lib/miniapps/loader'
import { CURATOR_AUTHORITY, UNVERIFIED_REASON } from '../../lib/miniapps/registryAuthority'
import { REGISTRY_STATUS, UNREACHABLE_REASON } from '../../lib/miniapps/registryClient'
import MiniAppReviewTab from '../../components/admin/MiniAppReviewTab'

const CHAIN = 137
const OTHER_CHAIN = 8453
const REGISTRY = '0x5a168Cc9FeFaf40e7BC536C8C61669e6d547A0A2'
const CURATOR = '0x1111111111111111111111111111111111111111'
const VENDOR = '0x1234567890abcdef1234567890abcdef12345678'
const ZERO_HASH = `0x${'0'.repeat(64)}`
const APPROVED_HASH = `0x${'aa'.repeat(32)}`
const PROPOSED_HASH = `0x${'bb'.repeat(32)}`
const SWAPPED_HASH = `0x${'cc'.repeat(32)}`

/**
 * The bytes an injected EIP-1193 wallet forwards for `StaleProposal(expected, actual)` — the
 * registry's own encoding, not a hand-written fixture, so the test cannot drift from the ABI.
 */
const STALE_REVERT_DATA = new ethers.Interface(MINI_APP_REGISTRY_ABI).encodeErrorResult('StaleProposal', [
  PROPOSED_HASH,
  SWAPPED_HASH,
])

function tuple({ cid = '', manifestHash = ZERO_HASH, version = 0 } = {}) {
  return Object.freeze({ cid, manifestHash, version, present: cid !== '' && manifestHash !== ZERO_HASH })
}

/** A record shaped exactly like `normalizeApp` output — frozen, like the real client's. */
function appRecord({
  id,
  name,
  description = 'An operational mini-app.',
  category = AppCategory.TRADE_SETTLEMENT,
  status = AppStatus.PENDING,
  launchable = false,
  approved = tuple(),
  proposed = tuple(),
}) {
  return Object.freeze({
    id,
    vendor: VENDOR,
    name,
    description,
    category,
    status,
    approved,
    proposed,
    submittedAt: 1_700_000_000,
    approvedAt: launchable ? 1_700_000_100 : 0,
    updatedAt: 1_700_000_200,
    launchable,
  })
}

/** A live app whose vendor has an update in review: Pending AND launchable (FR-003). */
const liveWithUpdate = appRecord({
  id: 1,
  name: 'Token Mint',
  status: AppStatus.PENDING,
  launchable: true,
  approved: tuple({ cid: 'bafyapprovedaaaaaaaaaa', manifestHash: APPROVED_HASH, version: 1 }),
  proposed: tuple({ cid: 'bafyproposedbbbbbbbbbb', manifestHash: PROPOSED_HASH, version: 2 }),
})

/** Live, nothing awaiting: suspend/retire are the only decisions available. */
const liveNoUpdate = appRecord({
  id: 2,
  name: 'Ledger Sync',
  category: AppCategory.RECONCILIATION,
  status: AppStatus.APPROVED,
  launchable: true,
  approved: tuple({ cid: 'bafyledgersyncaaaaaaa', manifestHash: APPROVED_HASH, version: 3 }),
})

function okOutcome(allApps) {
  return {
    status: REGISTRY_STATUS.OK,
    apps: Object.freeze(allApps.filter((app) => app.launchable)),
    allApps: Object.freeze(allApps),
    fetchedAt: Date.now(),
    ageMs: 0,
    cached: false,
    chainId: CHAIN,
    registryAddress: REGISTRY,
  }
}

const heldAuthority = {
  status: CURATOR_AUTHORITY.HELD,
  held: true,
  verified: true,
  account: CURATOR,
  chainId: CHAIN,
  registryAddress: REGISTRY,
  role: '0xc242262718134333007a37a2e61483e7143f44e0144fb041a7006aa0eb456392',
  roleAdmin: '0xc242262718134333007a37a2e61483e7143f44e0144fb041a7006aa0eb456392',
  selfAdministering: true,
  reason: null,
  error: null,
}

function authorityOutcome(status, extra = {}) {
  return {
    ...heldAuthority,
    status,
    held: status === CURATOR_AUTHORITY.HELD,
    verified: status === CURATOR_AUTHORITY.HELD || status === CURATOR_AUTHORITY.NOT_HELD,
    roleAdmin: null,
    selfAdministering: null,
    ...extra,
  }
}

const verifiedOk = {
  ok: true,
  gateway: 'https://gateway.example',
  cid: 'bafyproposedbbbbbbbbbb',
  manifestHash: PROPOSED_HASH,
  manifest: {
    id: 'token-mint',
    name: 'Token Mint',
    version: '2.0.0',
    hostApi: 1,
    permissions: ['wallet:submit', 'store'],
    storeKeys: ['drafts'],
  },
  files: [
    { path: 'entry.js', sha256: 'a'.repeat(64), role: 'entry' },
    { path: 'style.css', sha256: 'b'.repeat(64), role: 'style' },
  ],
}

function verificationFailure(code, extra = {}) {
  return {
    ok: false,
    code,
    reason: 'manifest_hash_mismatch',
    path: 'manifest.json',
    expected: PROPOSED_HASH,
    actual: SWAPPED_HASH,
    message: 'mismatch',
    userMessage: 'This app package does not match the version approved on-chain.',
    error: new Error('mismatch'),
    cid: 'bafyproposedbbbbbbbbbb',
    manifestHash: PROPOSED_HASH,
    ...extra,
  }
}

/** Mirrors AdminPanel's `runTx`: resolves true on success, false on any failure, never rejects. */
function makeRunTx() {
  return vi.fn(async (fn) => {
    try {
      const tx = await fn()
      await tx.wait()
      return true
    } catch {
      return false
    }
  })
}

/**
 * The curator's signer, recording what would actually go on chain.
 *
 * Spec 110 T028 — this replaces a `vi.mock('ethers')` that faked `new ethers.Contract(...)`. The
 * component no longer constructs one, so that mock had become a mock on a retired path: it would
 * have gone on looking like protection while intercepting nothing. It fails loudly here only
 * because the assertions read the calls it recorded.
 *
 * What replaces it is stronger than what it replaced. The fake decodes the CALLDATA the component
 * built — with an ethers `Interface`, against the registry's real ABI, so it is also a live
 * cross-library check on the viem encoder — and yields the same `{ method, args }` the assertions
 * already used. A method name can be faked; these are the bytes.
 */
const registryIface = new ethers.Interface(MINI_APP_REGISTRY_ABI)
function recordingSigner() {
  return {
    address: CURATOR,
    async sendTransaction({ to, data }) {
      const parsed = registryIface.parseTransaction({ data })
      const method = parsed.name
      state.calls.push({ method, args: parsed.args.map((a) => (typeof a === 'bigint' ? Number(a) : a)), to })
      const error = state.throwOn[method]
      if (error) throw error
      return { hash: `0xtx${method}`, wait: async () => ({ status: 1 }) }
    },
  }
}

function renderTab(props = {}) {
  return render(
    <MiniAppReviewTab
      signer={recordingSigner()}
      account={CURATOR}
      chainId={CHAIN}
      runTx={makeRunTx()}
      pendingTx={false}
      {...props}
    />,
  )
}

/**
 * The `<li>` for one record, so assertions cannot accidentally match a sibling's control.
 * Async because the queue arrives from a read — awaiting the heading is also what makes every
 * test below start from a settled render rather than the loading state.
 */
async function recordCard(name) {
  const heading = await screen.findByRole('heading', { name, level: 5 })
  return heading.closest('li')
}

beforeEach(() => {
  state.catalogOutcomes = [okOutcome([liveWithUpdate, liveNoUpdate])]
  state.authority = heldAuthority
  state.verification = verifiedOk
  state.calls = []
  state.throwOn = {}
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the review queue', () => {
  it('separates records awaiting a decision from the rest', async () => {
    renderTab()
    expect(await screen.findByRole('heading', { name: /Awaiting a decision \(1\)/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Listed apps \(1\)/ })).toBeInTheDocument()
  })

  it('shows both tuples, so a reviewer sees what is live versus what is being asked for', async () => {
    renderTab()
    const card = await recordCard('Token Mint')

    const proposed = within(card).getByRole('heading', { name: /Proposed/ }).parentElement
    expect(within(proposed).getByText('v2')).toBeInTheDocument()
    expect(within(proposed).getByTitle(PROPOSED_HASH)).toBeInTheDocument()
    expect(within(proposed).getByTitle('bafyproposedbbbbbbbbbb')).toBeInTheDocument()

    const approved = within(card).getByRole('heading', { name: /Approved/ }).parentElement
    expect(within(approved).getByText('v1')).toBeInTheDocument()
    expect(within(approved).getByTitle(APPROVED_HASH)).toBeInTheDocument()
  })

  it('shows vendor, category, description and the three timestamps', async () => {
    renderTab()
    const card = await recordCard('Token Mint')
    expect(within(card).getByTitle(VENDOR)).toBeInTheDocument()
    expect(within(card).getByText('Trade Settlement')).toBeInTheDocument()
    expect(within(card).getByText('An operational mini-app.')).toBeInTheDocument()
    expect(within(card).getByText('Submitted')).toBeInTheDocument()
    expect(within(card).getByText('Last approved')).toBeInTheDocument()
    expect(within(card).getByText('Last changed')).toBeInTheDocument()
  })

  it('reports launchability SEPARATELY from review status (FR-003)', async () => {
    // The record under test is Pending AND launchable — a live app with an update in review.
    // A tab that derived "is it serving?" from `status` would call this one offline, and a
    // curator would suspend it believing nobody was using it.
    renderTab()
    const card = await recordCard('Token Mint')
    expect(within(card).getByText('Pending review')).toBeInTheDocument()
    expect(within(card).getByText('Serving members now')).toBeInTheDocument()
  })

  it('says the registry could not be read rather than showing an empty queue', async () => {
    state.catalogOutcomes = [
      {
        status: REGISTRY_STATUS.UNREACHABLE,
        chainId: CHAIN,
        registryAddress: REGISTRY,
        reason: UNREACHABLE_REASON.READ_FAILED,
        error: new Error('rpc down'),
        stale: null,
      },
    ]
    renderTab()
    expect(await screen.findByText(/did not answer, so the review queue could not be read/i)).toBeInTheDocument()
    expect(screen.getByText(/not evidence that nothing is waiting/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Awaiting a decision/ })).toBeNull()
  })

  it('distinguishes a build with no registry from an outage', async () => {
    state.catalogOutcomes = [{ status: REGISTRY_STATUS.NOT_DEPLOYED, chainId: CHAIN, registryAddress: null }]
    renderTab()
    expect(await screen.findByText(/deployment gap rather than an outage/i)).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = renderTab()
    await screen.findByRole('heading', { name: /Awaiting a decision/ })
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('package verification before approval (FR-022)', () => {
  it('will not approve a package that has not been verified', async () => {
    renderTab()
    const card = await recordCard('Token Mint')
    expect(within(card).getByRole('button', { name: /^Approve v2/ })).toBeDisabled()
    expect(within(card).getByText(/Verify the package before approving it/i)).toBeInTheDocument()
  })

  it('verifies the PROPOSED tuple and enables approval when it passes', async () => {
    const user = userEvent.setup()
    const { verifyMiniAppPackage } = await import('../../lib/miniapps/loader')
    renderTab()
    const card = await recordCard('Token Mint')

    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))

    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
    expect(verifyMiniAppPackage).toHaveBeenCalledWith(
      { cid: 'bafyproposedbbbbbbbbbb', manifestHash: PROPOSED_HASH },
      { expectedAppId: 'token-mint' },
    )
    // The reviewer is shown WHAT was checked, not just a verdict.
    expect(within(card).getByText(/Files checked \(2\)/)).toBeInTheDocument()
    expect(within(card).getByText('entry.js')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: /^Approve v2/ })).toBeEnabled()
  })

  it('BLOCKS approval outright when the package does not hash to the recorded hash', async () => {
    const user = userEvent.setup()
    state.verification = verificationFailure(VERIFICATION_FAILURE.INTEGRITY)
    renderTab()
    const card = await recordCard('Token Mint')

    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() =>
      expect(within(card).getByText(/does NOT match the recorded hash/i)).toBeInTheDocument(),
    )

    // No override exists: nothing could ever launch from this tuple.
    expect(within(card).queryByRole('checkbox')).toBeNull()
    expect(within(card).getByRole('button', { name: /^Approve v2/ })).toBeDisabled()
    expect(within(card).getByText(/cannot be approved/i)).toBeInTheDocument()
  })

  it('lets a curator approve an UNREACHABLE package only after an explicit acknowledgement', async () => {
    const user = userEvent.setup()
    state.verification = verificationFailure(VERIFICATION_FAILURE.GATEWAY, {
      reason: 'all_gateways_failed',
      expected: null,
      actual: null,
      userMessage: 'The app package could not be downloaded.',
    })
    renderTab()
    const card = await recordCard('Token Mint')

    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() =>
      expect(within(card).getByText('Package could not be verified.')).toBeInTheDocument(),
    )

    // Silence is not consent: still disabled until the box is ticked.
    expect(within(card).getByRole('button', { name: /^Approve v2/ })).toBeDisabled()
    await user.click(within(card).getByRole('checkbox'))
    expect(within(card).getByRole('button', { name: /^Approve v2/ })).toBeEnabled()
  })
})

describe('lifecycle actions carry the hash the reviewer saw (FR-004a)', () => {
  async function verifyThen(name = 'Token Mint') {
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard(name)
    await user.click(within(card).getByRole('button', { name: /Verify (proposed|approved) package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
    return { user, card }
  }

  it('approve names the PROPOSED hash — the package under review', async () => {
    const { user, card } = await verifyThen()
    await user.click(within(card).getByRole('button', { name: /^Approve v2/ }))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    expect(state.calls[0]).toMatchObject({ method: 'approveApp', args: [1, PROPOSED_HASH] })
    // The registry address was invisible to the retired `new ethers.Contract(...)` fake, which
    // ignored its first argument entirely. A curator write going to the wrong contract would have
    // passed every assertion in this file.
    expect(state.calls[0].to).toBe(REGISTRY)
  })

  it('reject names the PROPOSED hash and says the live version keeps serving (FR-004b)', async () => {
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Token Mint')
    // Deliberately NOT verified first: refusing a package nobody could verify is exactly the
    // right move, so rejection must never be gated on a successful verification.
    await user.click(within(card).getByRole('button', { name: /Reject proposed v2/ }))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    expect(state.calls[0]).toMatchObject({ method: 'rejectProposal', args: [1, PROPOSED_HASH] })
    expect(within(card).getByText(/Any previously approved version keeps\s+serving/i)).toBeInTheDocument()
  })

  it('approve on a suspended record names the APPROVED hash it is reinstating', async () => {
    const suspended = appRecord({
      id: 7,
      name: 'Paused App',
      status: AppStatus.SUSPENDED,
      launchable: false,
      approved: tuple({ cid: 'bafypausedappaaaaaaaa', manifestHash: APPROVED_HASH, version: 4 }),
    })
    state.catalogOutcomes = [okOutcome([suspended])]
    // Reinstatement re-checks the tuple that will be served, which is the approved one.
    state.verification = { ...verifiedOk, manifestHash: APPROVED_HASH, cid: 'bafypausedappaaaaaaaa' }

    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Paused App')
    await user.click(within(card).getByRole('button', { name: /Verify approved package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())

    await user.click(within(card).getByRole('button', { name: /^Reinstate on/ }))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    expect(state.calls[0]).toMatchObject({ method: 'approveApp', args: [7, APPROVED_HASH] })
  })

  it('suspend explains that it takes a live app offline immediately', async () => {
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Ledger Sync')
    expect(within(card).getByText(/takes this app offline immediately/i)).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Suspend' }))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    expect(state.calls[0]).toMatchObject({ method: 'suspendApp', args: [2] })
  })

  it('records an audit entry naming the decision, the package and the transaction', async () => {
    const { user, card } = await verifyThen()
    await user.click(within(card).getByRole('button', { name: /^Approve v2/ }))
    await waitFor(() => expect(captureMiniAppLog).toHaveBeenCalled())
    const [account, chainId, info] = captureMiniAppLog.mock.calls[0]
    expect(account).toBe(CURATOR)
    expect(chainId).toBe(CHAIN)
    expect(info.kind).toBe('host:curator_approved')
    // Attribution uses the IMMUTABLE registry id, never the editable display name.
    expect(info.appId).toBe(`app-${CHAIN}-1`)
    expect(info.refs.manifestHash).toBe(PROPOSED_HASH)
    expect(info.dedupeKey).toBe('0xtxapproveApp')
  })
})

describe('deprecation is terminal, so it takes two deliberate steps', () => {
  it('does not send anything on the first click', async () => {
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Ledger Sync')
    await user.click(within(card).getByRole('button', { name: /Retire permanently…/ }))
    expect(state.calls).toHaveLength(0)
  })

  it('says the word permanent, offers a way out, and only then sends', async () => {
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Ledger Sync')
    await user.click(within(card).getByRole('button', { name: /Retire permanently…/ }))

    expect(within(card).getByText(/Retiring Ledger Sync is permanent\./)).toBeInTheDocument()
    expect(within(card).getByText(/no way to undo it/i)).toBeInTheDocument()
    expect(within(card).getByText(/suspend it instead/i)).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Cancel' }))
    expect(state.calls).toHaveLength(0)

    await user.click(within(card).getByRole('button', { name: /Retire permanently…/ }))
    await user.click(within(card).getByRole('button', { name: /Yes, retire Ledger Sync permanently/ }))
    await waitFor(() => expect(state.calls).toHaveLength(1))
    expect(state.calls[0]).toMatchObject({ method: 'deprecateApp', args: [2] })
  })

  it('carries focus into the warning and back out to the trigger (T047)', async () => {
    // The trigger REPLACES itself with the confirmation, so the element holding focus is
    // destroyed by the press that opened it — untouched, focus falls to <body> and a keyboard
    // curator is thrown to the top of the admin page, with the permanence warning now somewhere
    // below them. Cancel does the same in reverse. Focus has to follow the disclosure both ways.
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Ledger Sync')

    const trigger = within(card).getByRole('button', { name: /Retire permanently…/ })
    trigger.focus()
    await user.keyboard('{Enter}')

    // The warning itself, not the destructive button: the second step exists so it is READ.
    const confirm = within(card).getByRole('alert')
    expect(document.activeElement).toBe(confirm)
    expect(confirm).toHaveTextContent(/Retiring Ledger Sync is permanent\./)
    // And it is a focus target, never a Tab stop reachable from elsewhere.
    expect(confirm).toHaveAttribute('tabindex', '-1')

    await user.click(within(card).getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(
      within(card).getByRole('button', { name: /Retire permanently…/ }),
    )
    expect(state.calls).toHaveLength(0)
  })

  it('does not steal focus on first render just because a card can be retired', async () => {
    // The effect that moves focus into the confirmation must not fire on mount, or every card in
    // the queue would fight for focus the moment the tab loads.
    renderTab()
    await recordCard('Ledger Sync')
    expect(document.activeElement).toBe(document.body)
  })

  it('offers no lifecycle control at all on an already-retired record', async () => {
    const retired = appRecord({
      id: 9,
      name: 'Old App',
      status: AppStatus.DEPRECATED,
      approved: tuple({ cid: 'bafyoldappaaaaaaaaaaa', manifestHash: APPROVED_HASH, version: 1 }),
    })
    state.catalogOutcomes = [okOutcome([retired])]
    renderTab()
    const card = await recordCard('Old App')
    expect(within(card).queryByRole('button', { name: /Approve|Reinstate|Reject|Suspend|Retire/ })).toBeNull()
    // …and says so, rather than leaving a blank space that reads as a rendering bug.
    expect(within(card).getByText(/permanently retired/i)).toBeInTheDocument()
  })
})

describe('StaleProposal means the vendor changed the package (FR-004a)', () => {
  /** The record as it looks AFTER the vendor's substitution — what the refresh re-reads. */
  const swapped = appRecord({
    id: 1,
    name: 'Token Mint',
    status: AppStatus.PENDING,
    launchable: true,
    approved: tuple({ cid: 'bafyapprovedaaaaaaaaaa', manifestHash: APPROVED_HASH, version: 1 }),
    proposed: tuple({ cid: 'bafyswappedcccccccccc', manifestHash: SWAPPED_HASH, version: 3 }),
  })

  beforeEach(() => {
    state.catalogOutcomes = [okOutcome([liveWithUpdate, liveNoUpdate]), okOutcome([swapped, liveNoUpdate])]
    state.throwOn.approveApp = Object.assign(new Error('execution reverted'), {
      revert: { name: 'StaleProposal', args: [PROPOSED_HASH, SWAPPED_HASH] },
    })
  })

  it('says the vendor replaced the package, and that nothing changed', async () => {
    const user = userEvent.setup()
    renderTab()
    let card = await recordCard('Token Mint')
    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
    await user.click(within(card).getByRole('button', { name: /^Approve v2/ }))

    await waitFor(() => expect(screen.getByText(/The vendor replaced this package\./)).toBeInTheDocument())
    card = await recordCard('Token Mint')
    // Read off `textContent`: the sentence is deliberately interleaved with `<code>` digests, so
    // an element-scoped matcher would fail for a formatting reason rather than a wording one.
    expect(card.textContent).toContain('The decision was refused on-chain and nothing changed')
    expect(card.textContent).toContain('review the new package before deciding again')
  })

  it('re-reads the record and requires a fresh review before the control returns', async () => {
    const user = userEvent.setup()
    renderTab()
    let card = await recordCard('Token Mint')
    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
    await user.click(within(card).getByRole('button', { name: /^Approve v2/ }))

    // The refreshed record carries the vendor's NEW tuple (v3, the swapped hash)…
    await waitFor(() => expect(screen.getByRole('button', { name: /^Approve v3/ })).toBeInTheDocument())
    card = await recordCard('Token Mint')
    const proposed = within(card).getByRole('heading', { name: /Proposed/ }).parentElement
    expect(within(proposed).getByTitle(SWAPPED_HASH)).toBeInTheDocument()
    // …and the verification that was about the OLD bytes is gone, so approval is blocked again.
    // A surviving "verified" badge here would be the substitution rendered as reassurance.
    expect(within(card).queryByText(/Package verified\./)).toBeNull()
    expect(within(card).getByRole('button', { name: /^Approve v3/ })).toBeDisabled()
    expect(within(card).getByText(/Verify the package before approving it/i)).toBeInTheDocument()
  })

  it('reads the substitution off a raw `error.data` the wallet never decoded (#1267)', async () => {
    // The shape the WRITE path actually produces. ethers only lifts a revert onto `.revert` when
    // it held the ABI where the call failed — true of a `staticCall`, not of a transaction sent
    // through an injected wallet, which forwards the node's `{code, message, data}` verbatim. The
    // curator consequently got "execution reverted (unknown custom error)" for an error this very
    // ABI names, which is the one message that tells them to re-review rather than retry.
    state.throwOn.approveApp = Object.assign(new Error('execution reverted (unknown custom error)'), {
      code: 'CALL_EXCEPTION',
      shortMessage: 'execution reverted (unknown custom error)',
      data: STALE_REVERT_DATA,
    })

    const user = userEvent.setup()
    renderTab()
    let card = await recordCard('Token Mint')
    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
    await user.click(within(card).getByRole('button', { name: /^Approve v2/ }))

    await waitFor(() => expect(screen.getByText(/The vendor replaced this package\./)).toBeInTheDocument())
    card = await recordCard('Token Mint')
    const notice = within(card).getByText(/The vendor replaced this package\./).closest('[role="alert"]')
    expect(notice.textContent).toContain('The decision was refused on-chain and nothing changed')
    // Both hashes came out of the raw bytes, so the notice names WHICH package is there now and
    // which one the curator reviewed — the part a generic "execution reverted" cannot carry.
    expect(within(notice).getByTitle(SWAPPED_HASH)).toBeInTheDocument()
    expect(within(notice).getByTitle(PROPOSED_HASH)).toBeInTheDocument()
    // …and the verification of the old bytes is gone, exactly as on the pre-decoded path.
    expect(within(card).queryByText(/Package verified\./)).toBeNull()
  })

  it('does not mistake an ordinary revert for a package substitution', async () => {
    state.throwOn.approveApp = new Error('insufficient funds for intrinsic transaction cost')
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Token Mint')
    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
    await user.click(within(card).getByRole('button', { name: /^Approve v2/ }))

    await waitFor(() => expect(state.calls).toHaveLength(1))
    expect(screen.queryByText(/The vendor replaced this package\./)).toBeNull()
  })

  it('does not mistake raw revert bytes from another ABI for a package substitution', async () => {
    // Decoding raw data widens what the tab will read; it must not widen what the tab will
    // CLAIM. A selector this ABI does not carry is not a stale proposal, and saying it is would
    // send a curator to re-review a package the vendor never touched.
    state.throwOn.approveApp = Object.assign(new Error('execution reverted (unknown custom error)'), {
      code: 'CALL_EXCEPTION',
      data: '0xdeadbeef',
    })
    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Token Mint')
    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
    await user.click(within(card).getByRole('button', { name: /^Approve v2/ }))

    await waitFor(() => expect(state.calls).toHaveLength(1))
    expect(screen.queryByText(/The vendor replaced this package\./)).toBeNull()
  })
})

describe('authority is read from the registry, and its three refusals differ', () => {
  it('a definite non-curator gets a read-only queue and no controls', async () => {
    state.authority = authorityOutcome(CURATOR_AUTHORITY.NOT_HELD)
    renderTab()
    await screen.findByRole('heading', { name: /Awaiting a decision/ })

    expect(screen.getByText(/does not hold/i)).toBeInTheDocument()
    expect(screen.getByText(/cannot be granted by a platform administrator/i)).toBeInTheDocument()
    const card = await recordCard('Token Mint')
    // Transparency, not a locked door: the record and its verify control are still there…
    expect(within(card).getByRole('button', { name: /Verify proposed package/ })).toBeInTheDocument()
    // …but no lifecycle control is rendered at all — never a disabled button that would revert.
    expect(within(card).queryByRole('button', { name: /Approve|Reject|Suspend|Retire/ })).toBeNull()
    expect(within(card).getByText(/this view is read-only/i)).toBeInTheDocument()
  })

  it('an UNREADABLE registry never renders as "you are not a curator"', async () => {
    state.authority = authorityOutcome(CURATOR_AUTHORITY.UNVERIFIED, {
      reason: UNVERIFIED_REASON.READ_FAILED,
      error: new Error('rpc down'),
    })
    renderTab()
    await screen.findByRole('heading', { name: /Awaiting a decision/ })

    expect(screen.getByText(/Curator role could not be verified\./)).toBeInTheDocument()
    expect(screen.getByText(/not a statement that you lack the role/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Check again/ })).toBeInTheDocument()
    // The definite-denial copy must NOT appear — that is the whole distinction.
    expect(screen.queryByText(/does not hold/i)).toBeNull()
    const card = await recordCard('Token Mint')
    expect(within(card).queryByRole('button', { name: /Approve|Reject|Suspend|Retire/ })).toBeNull()
  })

  it('names the missing connection when there is no route to the registry chain', async () => {
    state.authority = authorityOutcome(CURATOR_AUTHORITY.UNVERIFIED, { reason: UNVERIFIED_REASON.NO_ROUTE })
    renderTab()
    expect(await screen.findByText(/no connection to/i)).toBeInTheDocument()
  })

  it('an unconnected wallet is a fact about the session, not about anyone’s grant', async () => {
    state.authority = authorityOutcome(CURATOR_AUTHORITY.NO_ACCOUNT, { account: null })
    renderTab({ account: null, signer: null })
    expect(await screen.findByText(/No account is connected/i)).toBeInTheDocument()
    expect(screen.queryByText(/does not hold/i)).toBeNull()
  })

  it('states that curation administers itself when the chain confirms it', async () => {
    renderTab()
    expect(await screen.findByText(/administers itself on-chain/i)).toBeInTheDocument()
  })

  it('warns loudly if a deployment ever came up WITHOUT that separation', async () => {
    state.authority = { ...heldAuthority, selfAdministering: false, roleAdmin: ZERO_HASH }
    renderTab()
    expect(await screen.findByText(/NOT self-administering/i)).toBeInTheDocument()
  })
})

describe('a decision has to be signed on the registry chain', () => {
  it('withholds every write while the wallet is on another network, and says why', async () => {
    const user = userEvent.setup()
    renderTab({ chainId: OTHER_CHAIN })
    const card = await recordCard('Token Mint')

    expect(screen.getByText(/recording a decision needs your wallet on/i)).toBeInTheDocument()
    // Verification still works from anywhere — it is a read.
    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())

    expect(within(card).getByRole('button', { name: /^Approve v2/ })).toBeDisabled()
    expect(within(card).getByRole('button', { name: /Reject proposed v2/ })).toBeDisabled()
    const settledCard = await recordCard('Ledger Sync')
    expect(within(settledCard).getByRole('button', { name: 'Suspend' })).toBeDisabled()
    expect(state.calls).toHaveLength(0)
  })

  it('every withheld control NAMES the reason it is withheld (T047)', async () => {
    // A sentence sitting above the queue explains a disabled button only to someone who can see
    // both at once. `aria-describedby` is what makes the explanation the button's own.
    const user = userEvent.setup()
    renderTab({ chainId: OTHER_CHAIN })
    const card = await recordCard('Token Mint')

    const note = screen.getByText(/recording a decision needs your wallet on/i)
    expect(note.id).toBeTruthy()

    const describes = (button) => (button.getAttribute('aria-describedby') || '').split(/\s+/)
    expect(describes(within(card).getByRole('button', { name: /Reject proposed v2/ }))).toContain(note.id)
    const settledCard = await recordCard('Ledger Sync')
    expect(describes(within(settledCard).getByRole('button', { name: 'Suspend' }))).toContain(note.id)
    expect(describes(within(settledCard).getByRole('button', { name: /Retire permanently…/ }))).toContain(note.id)

    // Approve is refused for two independent reasons here, and points at BOTH: the wrong network
    // and the unverified package. Naming only one would send a curator to fix half a problem.
    const approve = within(card).getByRole('button', { name: /^Approve v2/ })
    const gateNote = within(card).getByText(/Verify the package before approving it/i)
    expect(describes(approve)).toEqual(expect.arrayContaining([gateNote.id, note.id]))

    // Verification is a read, so it works from any network — and the button that is genuinely
    // inoperable (no package on the record) names that instead.
    await user.click(within(card).getByRole('button', { name: /Verify proposed package/ }))
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
  })

  it('names the "no package to check" sentence from the Verify control it disables', async () => {
    const empty = appRecord({ id: 4, name: 'Empty Record', status: AppStatus.PENDING })
    state.catalogOutcomes = [okOutcome([empty])]
    renderTab()
    const card = await recordCard('Empty Record')

    const verify = within(card).getByRole('button', { name: /Verify (proposed|approved) package/ })
    // Durable inoperability: `disabled` is right here, but the reason has to be reachable.
    expect(verify).toBeDisabled()
    const note = within(card).getByText(/holds no package to check/i)
    expect(verify).toHaveAttribute('aria-describedby', note.id)
  })

  it('keeps focus on Verify while it runs, rather than dropping it to the body', async () => {
    // The fetch-and-hash of a whole package is the longest wait on this surface. Disabling the
    // control for its duration removes it from the tab order and loses the curator's place in a
    // queue that can be long; `aria-disabled` + `aria-busy` reports the wait where they stand.
    let releaseVerify
    const { verifyMiniAppPackage } = await import('../../lib/miniapps/loader')
    verifyMiniAppPackage.mockImplementationOnce(
      () => new Promise((resolve) => { releaseVerify = () => resolve(verifiedOk) }),
    )

    const user = userEvent.setup()
    renderTab()
    const card = await recordCard('Token Mint')

    const verify = within(card).getByRole('button', { name: /Verify proposed package/ })
    verify.focus()
    await user.keyboard('{Enter}')

    const busy = within(card).getByRole('button', { name: 'Verifying…' })
    expect(document.activeElement).toBe(busy)
    expect(busy).toHaveAttribute('aria-busy', 'true')
    // Focusable is not operable: a second press must not start a second verification.
    await user.keyboard('{Enter}')
    expect(verifyMiniAppPackage).toHaveBeenCalledTimes(1)

    releaseVerify()
    await waitFor(() => expect(within(card).getByText(/Package verified\./)).toBeInTheDocument())
  })
})
