/**
 * SubmitAppPanel (spec 073 T034/T035/T036, US3) — the vendor's side of the registry.
 *
 * The panel writes to a LIVE registry, so what is under test here is mostly "does it refuse
 * correctly, and does it explain what it refused". Five properties, each of which fails silently if
 * nobody checks it:
 *
 * 1. **The client-side checks are the contract's checks.** `MiniAppRegistry._checkMetadata` rejects a
 *    name that is blank after whitespace folding, one carrying a control byte, and one over 64 BYTES
 *    (not characters). Mirroring those badly is worse than not mirroring them: a vendor pays gas to
 *    discover a rule we could have told them about, or is blocked from a submission the chain would
 *    have accepted. The name cases below are the exact ones the Solidity suite covers.
 *
 * 2. **The manifest pre-check catches a hash that could never launch.** A CID whose manifest hashes to
 *    something other than the entered value produces a listing the host will refuse to run — the
 *    integrity check happens before any package code executes. The panel has to say so *before* the
 *    submission, with both hashes, and hold the submission until the vendor acknowledges it.
 *
 * 3. **Wrong network is blocked with direction, never silently.** The registry is single-chain
 *    (FR-025); a submission from another network reaches a different deployment or nothing at all.
 *
 * 4. **Reverts become guidance.** Every custom error the registry can throw has a sentence a developer
 *    can act on, and the membership requirement names the tier read FROM THE REGISTRY's gate rather
 *    than a hardcoded assumption.
 *
 * 5. **`status` is not `launchable`, and the vendor list must not blur them.** A Pending record CAN be
 *    live — that is a working app with an update in review (FR-003) — and a vendor who reads "In
 *    review" as "offline" will believe their app went down when it did not. The list has to carry both
 *    answers, and the update forms have to say plainly that submitting keeps the approved package
 *    serving and does NOT ship the new one.
 *
 * The registry client is mocked at the outcome boundary (as in `CatalogPanel.test.jsx`); `appSlug` and
 * the integrity/manifest modules stay REAL, because a second definition of a slug or of a hash would
 * let this file agree with itself while the chain and the loader disagreed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { axe } from 'vitest-axe'

const state = vi.hoisted(() => ({
  wallet: null,
  vendorApps: null,
  appByName: null,
  gate: null,
  fetchImpl: null,
}))

vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => state.wallet,
}))

// Only the registry READS/WRITES are replaced. `appSlug`, `REGISTRY_STATUS` and the rest stay real.
vi.mock('../../lib/miniapps/registryClient', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    registryLocation: () => ({ chainId: REGISTRY_CHAIN, registryAddress: REGISTRY_ADDRESS }),
    fetchVendorApps: (...args) => state.vendorApps(...args),
    fetchAppByName: (...args) => state.appByName(...args),
    clearCatalogCache: () => {},
  }
})

/**
 * The registry's gate-config read.
 *
 * Spec 110 T028 — this mocks the CHAIN SEAM, not `ethers.Contract`. The panel no longer constructs
 * one, so a `vi.mock('ethers')` would be a mock on a retired path: it would intercept nothing while
 * still looking like the thing keeping this test honest. Mocking the seam also lets the assertion
 * read the REQUEST — which chain, which function — instead of a method name on a fake object.
 *
 * `Interface` stays real below: this file decodes the calldata the panel produces, and after the
 * swap that is a live cross-library check on the viem encoder rather than a fake proving nothing.
 */
const gateReads = []
vi.mock('../../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: vi.fn(async (chainId, call) => {
      gateReads.push({ chainId, ...call })
      if (call.functionName === 'membershipManager') return state.gate.manager
      if (call.functionName === 'minTier') return state.gate.minTier
      throw new Error(`unstubbed registry read: ${call.functionName}`)
    }),
  }
})

import { Interface } from 'ethers'
import { AppCategory, AppStatus, APP_CATEGORY_LABELS, MINI_APP_REGISTRY_ABI } from '../../abis/miniAppRegistry'
import { keccak256Hex } from '../../lib/miniapps/integrity'
import { REGISTRY_STATUS } from '../../lib/miniapps/registryClient'
import SubmitAppPanel from '../../components/miniapps/SubmitAppPanel'
import {
  PRECHECK,
  checkCid,
  checkDescription,
  checkManifestHash,
  checkName,
  cidShapeWarning,
  describeRegistryError,
  nameSlugWarning,
  precheckManifest,
} from '../../components/miniapps/submitAppChecks.js'

const REGISTRY_CHAIN = 137
const REGISTRY_ADDRESS = '0x5a168Cc9FeFaf40e7BC536C8C61669e6d547A0A2'
const VENDOR = '0x1234567890abcdef1234567890abcdef12345678'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MEMBERSHIP_MANAGER = '0x00000000000000000000000000000000000000AA'
const ZERO_HASH = `0x${'0'.repeat(64)}`
const GOOD_CID = 'bafybeigdyrztktx5abcdefghijklmnopqrstuvwxyz234567abcdefghijklmno'

const iface = new Interface(MINI_APP_REGISTRY_ABI)

/** A manifest the host would accept, and the keccak-256 the registry would have to hold for it. */
const MANIFEST_OBJECT = {
  schema: 'fairwins-miniapp-manifest/1',
  id: 'settle-desk',
  name: 'Settle Desk',
  version: '2.1.0',
  entry: 'entry.js',
  hostApi: 1,
  files: { 'entry.js': { sha256: 'ab'.repeat(32) } },
}
const MANIFEST_BYTES = new TextEncoder().encode(JSON.stringify(MANIFEST_OBJECT))
const MANIFEST_HASH = keccak256Hex(MANIFEST_BYTES)
const WRONG_HASH = `0x${'11'.repeat(32)}`

/** A gateway response carrying the manifest bytes above. */
function servesManifest() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => MANIFEST_BYTES.buffer.slice(0),
  }))
}

/** A gateway that has nothing for this CID — the "we could not check" path. */
function servesNothing() {
  return vi.fn(async () => ({ ok: false, status: 404 }))
}

function packageRef({ cid = '', manifestHash = ZERO_HASH, version = 0 } = {}) {
  const present = cid.length > 0 && manifestHash !== ZERO_HASH
  return Object.freeze({ cid, manifestHash, version, present })
}

/** A record shaped exactly like `normalizeApp` output. */
function appRecord({
  id,
  name,
  description = '',
  category = AppCategory.TRADE_SETTLEMENT,
  status = AppStatus.APPROVED,
  launchable = true,
  approved = null,
  proposed = null,
}) {
  return Object.freeze({
    id,
    vendor: VENDOR,
    name,
    description,
    category,
    status,
    approved: approved ?? packageRef(launchable ? { cid: GOOD_CID, manifestHash: MANIFEST_HASH, version: 2 } : {}),
    proposed: proposed ?? packageRef(),
    submittedAt: 1_700_000_000,
    approvedAt: 1_700_000_100,
    updatedAt: 1_700_000_200,
    launchable,
  })
}

function vendorOk(apps) {
  return {
    status: REGISTRY_STATUS.OK,
    apps,
    fetchedAt: Date.now(),
    chainId: REGISTRY_CHAIN,
    registryAddress: REGISTRY_ADDRESS,
  }
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <SubmitAppPanel fetchImpl={state.fetchImpl} />
    </MemoryRouter>,
  )
}

/** Render and wait for the vendor read to land, so no assertion races the first paint. */
async function renderSettled() {
  const result = renderPanel()
  await waitFor(() => expect(screen.queryByText('Loading your submissions…')).toBeNull(), { timeout: 3000 })
  return result
}

/** The form owning a given submit button — every form on this surface reuses the same field labels. */
function formFor(buttonName) {
  return screen.getByRole('button', { name: buttonName }).closest('form')
}

const NEW_LISTING = 'Submit listing for review'

/**
 * Set a field by its visible label.
 *
 * `fireEvent.change` rather than `userEvent.type`: a 64-character manifest hash typed one keystroke at
 * a time re-arms the 450 ms debounce on every character, so the pre-check would never settle inside a
 * test's patience. What is under test is the value, not the typing.
 */
function setField(scope, label, value) {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } })
}

/** Fill the new-listing form with a submission the chain would accept. */
function fillValidListing({ name = 'Settle Desk', cid = GOOD_CID, manifestHash = MANIFEST_HASH } = {}) {
  const form = formFor(NEW_LISTING)
  setField(form, 'Listing name', name)
  setField(form, 'Description', 'Matches and settles bilateral trades.')
  setField(form, 'Package CID', cid)
  setField(form, 'Manifest hash', manifestHash)
  return form
}

beforeEach(() => {
  state.wallet = {
    address: VENDOR,
    chainId: REGISTRY_CHAIN,
    isConnected: true,
    sendCalls: vi.fn(async () => ({ txHash: '0xdeadbeef' })),
  }
  state.vendorApps = vi.fn(async () => vendorOk([]))
  state.appByName = vi.fn(async () => ({
    status: REGISTRY_STATUS.NOT_FOUND,
    chainId: REGISTRY_CHAIN,
    registryAddress: REGISTRY_ADDRESS,
  }))
  gateReads.length = 0
  state.gate = { manager: ZERO_ADDRESS, minTier: 0 }
  state.fetchImpl = servesNothing()
})

// =============================================================================
// Pure pre-checks — the contract's own rules, mirrored.
// =============================================================================

describe('SubmitAppPanel — name rules mirror MiniAppRegistry._checkMetadata', () => {
  it('accepts an ordinary name', () => {
    expect(checkName('Settle Desk')).toBeNull()
  })

  it('rejects a name that is blank after whitespace folding', () => {
    // The contract's reason: "   " folds to the empty name key, which every later blank name would
    // then collide with. It reverts EmptyName, so the panel must too.
    expect(checkName('   ')).toMatchObject({ code: 'EmptyName' })
    expect(checkName('')).toMatchObject({ code: 'EmptyName' })
  })

  it('rejects control bytes anywhere in the name', () => {
    expect(checkName('Settle\tDesk')).toMatchObject({ code: 'InvalidName' })
    expect(checkName('Settle\nDesk')).toMatchObject({ code: 'InvalidName' })
    expect(checkName('SettleDesk')).toMatchObject({ code: 'InvalidName' })
  })

  it('measures the 64-byte bound in BYTES, not characters', () => {
    // 64 ASCII characters is 64 bytes — the boundary, and legal.
    expect(checkName('a'.repeat(64))).toBeNull()
    expect(checkName('a'.repeat(65))).toMatchObject({ code: 'StringTooLong' })
    // 33 two-byte characters is 66 bytes: legal by String.length, rejected on-chain. Getting this
    // wrong is the whole reason the check encodes before measuring.
    expect('é'.repeat(33).length).toBe(33)
    expect(checkName('é'.repeat(33))).toMatchObject({ code: 'StringTooLong' })
  })

  it('bounds the description and allows a blank one', () => {
    expect(checkDescription('')).toBeNull()
    expect(checkDescription('x'.repeat(512))).toBeNull()
    expect(checkDescription('x'.repeat(513))).toMatchObject({ code: 'StringTooLong' })
  })
})

describe('SubmitAppPanel — package field rules', () => {
  it('refuses an empty CID and one over the on-chain bound', () => {
    expect(checkCid('')).toMatchObject({ code: 'EmptyCid' })
    expect(checkCid('   ')).toMatchObject({ code: 'EmptyCid' })
    expect(checkCid(GOOD_CID)).toBeNull()
    expect(checkCid('b'.repeat(257))).toMatchObject({ code: 'StringTooLong' })
  })

  it('refuses a manifest hash that is absent, malformed, or all zero', () => {
    expect(checkManifestHash('')).toMatchObject({ code: 'EmptyManifestHash' })
    expect(checkManifestHash('0xnot-hex')).toMatchObject({ code: 'InvalidManifestHash' })
    expect(checkManifestHash(ZERO_HASH)).toMatchObject({ code: 'EmptyManifestHash' })
    expect(checkManifestHash(MANIFEST_HASH)).toBeNull()
  })

  it('warns — but does not block — on a CID shape no gateway could resolve', () => {
    expect(cidShapeWarning(GOOD_CID)).toBeNull()
    expect(cidShapeWarning('not-a-cid')).toMatch(/does not look like an IPFS CID/)
    // The chain accepts it, so the panel's own field check must stay silent about it.
    expect(checkCid('not-a-cid')).toBeNull()
  })

  it('warns when a name could never become the app’s web address', () => {
    expect(nameSlugWarning('Settle Desk')).toBeNull()
    // A hyphen in the folded name costs the listing its slug (two listings would share one URL).
    expect(nameSlugWarning('Settle-Desk')).toMatch(/will not be able to open this listing/)
    expect(nameSlugWarning('2Fast')).toMatch(/will not be able to open this listing/)
  })
})

// =============================================================================
// Manifest pre-check.
// =============================================================================

describe('SubmitAppPanel — manifest pre-check', () => {
  it('reports a match and reads the package’s declared identity and display version', async () => {
    const result = await precheckManifest({
      cid: GOOD_CID,
      manifestHash: MANIFEST_HASH,
      expectedAppId: 'settle-desk',
      gateways: ['https://gateway.example'],
      fetchImpl: servesManifest(),
    })
    expect(result.state).toBe(PRECHECK.MATCH)
    expect(result.manifest.version).toBe('2.1.0')
    expect(result.idMismatch).toBeNull()
  })

  it('reports a mismatch with both hashes, and never confuses it with a fetch failure', async () => {
    const result = await precheckManifest({
      cid: GOOD_CID,
      manifestHash: WRONG_HASH,
      gateways: ['https://gateway.example'],
      fetchImpl: servesManifest(),
    })
    expect(result.state).toBe(PRECHECK.MISMATCH)
    expect(result.expected).toBe(WRONG_HASH)
    expect(result.actual).toBe(MANIFEST_HASH)
  })

  it('reports "could not check" when no gateway serves the manifest', async () => {
    const result = await precheckManifest({
      cid: GOOD_CID,
      manifestHash: MANIFEST_HASH,
      gateways: ['https://gateway.example'],
      fetchImpl: servesNothing(),
    })
    // Deliberately NOT a mismatch: a package pinned to a private gateway is unreadable from here, and
    // reporting that as "wrong" would block a correct submission.
    expect(result.state).toBe(PRECHECK.UNREACHABLE)
  })

  it('flags a package that identifies itself as a different app', async () => {
    const result = await precheckManifest({
      cid: GOOD_CID,
      manifestHash: MANIFEST_HASH,
      expectedAppId: 'ledger-match',
      gateways: ['https://gateway.example'],
      fetchImpl: servesManifest(),
    })
    expect(result.state).toBe(PRECHECK.MATCH)
    expect(result.idMismatch).toEqual({ declared: 'settle-desk', expected: 'ledger-match' })
  })
})

// =============================================================================
// Revert decoding.
// =============================================================================

describe('SubmitAppPanel — revert decoding', () => {
  function revert(name, args = []) {
    return Object.assign(new Error('execution reverted'), { revert: { name, args } })
  }

  it('names the tier the registry’s own gate requires', () => {
    const text = describeRegistryError(revert('InsufficientMembershipTier'), iface, {
      enabled: true,
      minTier: 3,
      chainId: REGISTRY_CHAIN,
    })
    expect(text).toMatch(/Gold membership or above/)
  })

  it('declines to name a tier it could not read, without pretending nothing is required', () => {
    const text = describeRegistryError(revert('InsufficientMembershipTier'), iface, null)
    expect(text).toMatch(/requires a membership tier this account does not hold/)
    expect(text).not.toMatch(/Gold|Silver|Bronze|Platinum/)
  })

  it('explains every vendor-facing refusal in terms of what to do next', () => {
    expect(describeRegistryError(revert('DuplicateName'), iface)).toMatch(/already uses this name/)
    expect(describeRegistryError(revert('InvalidName'), iface)).toMatch(/control character/)
    expect(describeRegistryError(revert('EmptyName'), iface)).toMatch(/blank/)
    expect(describeRegistryError(revert('StringTooLong'), iface)).toMatch(/64 bytes of name/)
    expect(describeRegistryError(revert('EmptyCid'), iface)).toMatch(/empty content identifier/)
    expect(describeRegistryError(revert('EmptyManifestHash'), iface)).toMatch(/all-zero manifest hash/)
    expect(describeRegistryError(revert('SanctionedAccount'), iface)).toMatch(/sanctions screening/)
    expect(describeRegistryError(revert('NotVendor'), iface)).toMatch(/wallet that first submitted/)
    expect(describeRegistryError(revert('InvalidStatus'), iface)).toMatch(/suspended/)
    expect(describeRegistryError(revert('AppDeprecatedError'), iface)).toMatch(/retired permanently/)
  })

  it('treats StaleProposal as "the package changed — re-review", not a generic failure', () => {
    const text = describeRegistryError(revert('StaleProposal', [MANIFEST_HASH, WRONG_HASH]), iface)
    expect(text).toMatch(/changed after the action was prepared/)
    expect(text).toMatch(/exact package that was reviewed/)
  })

  it('reads a revert out of raw selector bytes when ethers did not decode it', () => {
    const data = iface.encodeErrorResult('DuplicateName', [])
    const text = describeRegistryError({ info: { error: { data } } }, iface)
    expect(text).toMatch(/already uses this name/)
  })

  it('calls a cancelled signature what it is', () => {
    expect(describeRegistryError({ code: 'ACTION_REJECTED' }, iface)).toMatch(/You cancelled/)
  })
})

// =============================================================================
// The form, end to end.
// =============================================================================

describe('SubmitAppPanel — new listing (FR-021)', () => {
  it('submits submitApp with exactly the fields entered, and no version', async () => {
    await renderSettled()
    const form = fillValidListing()
    fireEvent.change(within(form).getByLabelText('Operational category'), {
      target: { value: String(AppCategory.RECONCILIATION) },
    })

    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))

    await waitFor(() => expect(state.wallet.sendCalls).toHaveBeenCalledTimes(1))
    const [[calls]] = state.wallet.sendCalls.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe(REGISTRY_ADDRESS)

    const parsed = iface.parseTransaction({ data: calls[0].data })
    expect(parsed.name).toBe('submitApp')
    expect(parsed.args[0]).toBe('Settle Desk')
    expect(parsed.args[2]).toBe(BigInt(AppCategory.RECONCILIATION))
    expect(parsed.args[3]).toBe(GOOD_CID)
    expect(parsed.args[4]).toBe(MANIFEST_HASH)
    // The registry issues the version; there is no field for one and none is sent.
    expect(parsed.args).toHaveLength(5)
  })

  it('never lets the vendor choose a version, and says who does', async () => {
    await renderSettled()
    const form = formFor(NEW_LISTING)
    expect(within(form).queryByLabelText(/version/i)).toBeNull()
    expect(
      within(form).getByText(/registry issues one and never reuses it, including for versions that were rejected/i),
    ).toBeInTheDocument()
  })

  it('blocks a name that is blank after folding, and says why, without sending anything', async () => {
    await renderSettled()
    const form = fillValidListing({ name: '   ' })
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))

    expect(await within(form).findByText(/folds spaces away before storing it/i)).toBeInTheDocument()
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('blocks a name carrying a control character', async () => {
    await renderSettled()
    const form = fillValidListing({ name: 'Settle\tDesk' })
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))

    expect(await within(form).findByText(/contains a control character/i)).toBeInTheDocument()
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('blocks a manifest hash that is not 32 bytes of hex', async () => {
    await renderSettled()
    const form = fillValidListing({ manifestHash: '0x1234' })
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))

    expect(await within(form).findByText(/32 bytes of hex/i)).toBeInTheDocument()
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('blocks a name the registry already holds, naming the listing that holds it', async () => {
    state.appByName = vi.fn(async () => ({
      status: REGISTRY_STATUS.OK,
      app: appRecord({ id: 4, name: 'Settle Desk' }),
      chainId: REGISTRY_CHAIN,
      registryAddress: REGISTRY_ADDRESS,
    }))
    await renderSettled()
    const form = fillValidListing()

    expect(await within(form).findByText(/is already registered \(listing #4\)/i, undefined, { timeout: 3000 })).toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()
  })
})

describe('SubmitAppPanel — manifest hash pre-check in the form', () => {
  it('shows the mismatch with both hashes and holds the submission until it is acknowledged', async () => {
    state.fetchImpl = servesManifest()
    await renderSettled()
    const form = fillValidListing({ manifestHash: WRONG_HASH })

    const alert = await within(form).findByRole('alert', undefined, { timeout: 3000 })
    expect(alert).toHaveTextContent(/does not hash to what you entered/i)
    // Both values are on screen, shortened but with the full string available.
    expect(within(alert).getByTitle(MANIFEST_HASH)).toBeInTheDocument()
    expect(within(alert).getByTitle(WRONG_HASH)).toBeInTheDocument()

    // Held: clicking submit does nothing until the consequence is acknowledged.
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()

    // …and the vendor can still proceed over it, because our check can be wrong and the chain is
    // authoritative. Acknowledging names the consequence rather than hiding it.
    fireEvent.click(within(form).getByRole('checkbox', { name: /refuse to launch this package/i }))
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))
    await waitFor(() => expect(state.wallet.sendCalls).toHaveBeenCalledTimes(1))
  })

  it('confirms a matching hash and shows the package’s declared display version', async () => {
    state.fetchImpl = servesManifest()
    await renderSettled()
    const form = fillValidListing()

    expect(
      await within(form).findByText(/hashes to the value you entered/i, undefined, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(within(form).getByText('2.1.0')).toBeInTheDocument()
    expect(within(form).queryByRole('checkbox')).toBeNull()
  })

  it('says it could not check, rather than implying anything is wrong, when no gateway answers', async () => {
    await renderSettled()
    const form = fillValidListing()

    expect(
      await within(form).findByText(/We could not check this package from here/i, undefined, { timeout: 3000 }),
    ).toBeInTheDocument()
    // Non-blocking: the submission still goes through.
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))
    await waitFor(() => expect(state.wallet.sendCalls).toHaveBeenCalledTimes(1))
  })
})

describe('SubmitAppPanel — network and connection guards (FR-024/FR-025)', () => {
  it('blocks a submission from the wrong network with direction, and sends nothing', async () => {
    state.wallet.chainId = 1
    await renderSettled()

    expect(screen.getByText('Your wallet is on the wrong network.')).toBeInTheDocument()

    const form = fillValidListing()
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))

    // Not a silent no-op: the refusal is spoken, and it says which way to go.
    const notice = await screen.findByText(/Switch networks and submit again/i)
    expect(notice).toHaveTextContent(/nothing was sent/i)
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('offers no form at all until a wallet is connected, and says why', async () => {
    state.wallet = { address: null, chainId: REGISTRY_CHAIN, isConnected: false, sendCalls: vi.fn() }
    await renderSettled()

    expect(screen.getByText('Connect a wallet to submit.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: NEW_LISTING })).toBeNull()
  })

  it('states the registry’s membership requirement up front, read from the registry', async () => {
    state.gate = { manager: MEMBERSHIP_MANAGER, minTier: 3 }
    await renderSettled()
    expect(
      await screen.findByText(/requires Gold membership or above/i),
    ).toBeInTheDocument()
    // The gate is read from the REGISTRY'S OWN chain, not the wallet's — spec 073 pins the registry
    // to one chain per cohort, and reading the wallet's would state another deployment's gate as
    // this one's. The retired `new Contract(addr, abi, provider)` fake could show neither the chain
    // nor the address it was handed.
    expect(gateReads.length).toBeGreaterThan(0)
    for (const read of gateReads) {
      expect(read).toMatchObject({ chainId: REGISTRY_CHAIN, address: REGISTRY_ADDRESS })
    }
  })

  it('surfaces a decoded revert as guidance', async () => {
    state.wallet.sendCalls = vi.fn(async () => {
      throw Object.assign(new Error('call failed'), { revert: { name: 'DuplicateName', args: [] } })
    })
    await renderSettled()
    const form = fillValidListing()
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))

    expect(await screen.findByText(/Another listing already uses this name/i)).toBeInTheDocument()
  })
})

// =============================================================================
// T035 — the vendor's own submissions.
// =============================================================================

describe('SubmitAppPanel — vendor submissions list (FR-023)', () => {
  const liveWithUpdate = appRecord({
    id: 7,
    name: 'Settle Desk',
    status: AppStatus.PENDING,
    launchable: true,
    approved: packageRef({ cid: GOOD_CID, manifestHash: MANIFEST_HASH, version: 2 }),
    proposed: packageRef({ cid: 'bafyproposedcid234567', manifestHash: WRONG_HASH, version: 5 }),
  })

  it('shows review state and serving state as two different answers', async () => {
    state.vendorApps = vi.fn(async () => vendorOk([liveWithUpdate]))
    await renderSettled()

    const card = screen.getByRole('heading', { level: 5, name: 'Settle Desk' }).closest('li')
    expect(within(card).getByText('Review state')).toBeInTheDocument()
    expect(within(card).getByText('In review')).toBeInTheDocument()
    expect(within(card).getByText('Serving to members')).toBeInTheDocument()
    expect(within(card).getByText('Yes — v2')).toBeInTheDocument()
    // …and the apparent contradiction is explained rather than left to be misread as "we are offline".
    expect(within(card).getByText(/members are running the approved v2 package right now/i)).toHaveTextContent(
      /your v5 submission waits for a curator\. Your app is not offline\./i,
    )
  })

  it('shows the approved tuple and the proposed tuple separately, with their versions', async () => {
    state.vendorApps = vi.fn(async () => vendorOk([liveWithUpdate]))
    await renderSettled()

    const card = screen.getByRole('heading', { level: 5, name: 'Settle Desk' }).closest('li')
    const approved = within(card).getByText(/Approved package \(the only one ever served\)/i).closest('div')
    expect(within(approved).getByText('v2')).toBeInTheDocument()
    expect(within(approved).getByTitle(GOOD_CID)).toBeInTheDocument()

    const proposed = within(card).getByText(/Proposed package \(waiting for review\)/i).closest('div')
    expect(within(proposed).getByText('v5')).toBeInTheDocument()
    expect(within(proposed).getByTitle('bafyproposedcid234567')).toBeInTheDocument()
  })

  it('does not claim a never-approved listing is serving anything', async () => {
    state.vendorApps = vi.fn(async () =>
      vendorOk([
        appRecord({
          id: 9,
          name: 'Fresh Submission',
          status: AppStatus.PENDING,
          launchable: false,
          proposed: packageRef({ cid: GOOD_CID, manifestHash: MANIFEST_HASH, version: 1 }),
        }),
      ]),
    )
    await renderSettled()

    const card = screen.getByRole('heading', { level: 5, name: 'Fresh Submission' }).closest('li')
    expect(within(card).getByText('No')).toBeInTheDocument()
    expect(
      within(card).getByText(/has never been approved, so it is not in the catalog and cannot be launched yet/i),
    ).toBeInTheDocument()
    expect(within(card).getByText(/None — this listing has never been approved\./i)).toBeInTheDocument()
  })

  it('offers no update controls on a suspended or retired listing, and says why', async () => {
    state.vendorApps = vi.fn(async () =>
      vendorOk([
        appRecord({ id: 3, name: 'Rogue Reporter', status: AppStatus.SUSPENDED, launchable: false }),
        appRecord({ id: 4, name: 'Retired Tool', status: AppStatus.DEPRECATED, launchable: false }),
      ]),
    )
    await renderSettled()

    const suspended = screen.getByRole('heading', { level: 5, name: 'Rogue Reporter' }).closest('li')
    expect(within(suspended).getByText(/frozen for you too/i)).toBeInTheDocument()
    expect(within(suspended).queryByRole('button', { name: /Submit a package update/i })).toBeNull()

    const retired = screen.getByRole('heading', { level: 5, name: 'Retired Tool' }).closest('li')
    expect(within(retired).getByText(/Retirement is terminal on-chain/i)).toBeInTheDocument()
    expect(within(retired).queryByRole('button', { name: /Edit listing details/i })).toBeNull()
  })

  it('refuses to show a partial list when the registry could not be read', async () => {
    state.vendorApps = vi.fn(async () => ({
      status: REGISTRY_STATUS.UNREACHABLE,
      chainId: REGISTRY_CHAIN,
      registryAddress: REGISTRY_ADDRESS,
      reason: 'read-failed',
      error: new Error('rpc down'),
      stale: null,
    }))
    await renderSettled()

    expect(screen.getByText('Your submissions could not be read.')).toBeInTheDocument()
    expect(screen.getByText(/Nothing is wrong with your submissions/i)).toBeInTheDocument()
  })

  it('shows an honest empty state when the registry answered and this wallet has listed nothing', async () => {
    await renderSettled()
    expect(screen.getByText('You haven’t submitted anything yet')).toBeInTheDocument()
  })
})

// =============================================================================
// FR-003 — the update-keeps-serving promise.
// =============================================================================

describe('SubmitAppPanel — updates do not take an app offline and do not ship (FR-003)', () => {
  const live = appRecord({
    id: 7,
    name: 'Settle Desk',
    status: AppStatus.APPROVED,
    launchable: true,
    approved: packageRef({ cid: GOOD_CID, manifestHash: MANIFEST_HASH, version: 2 }),
  })

  async function openPackageUpdate() {
    state.vendorApps = vi.fn(async () => vendorOk([live]))
    await renderSettled()
    fireEvent.click(screen.getByRole('button', { name: 'Submit a package update' }))
    return formFor('Submit package for review')
  }

  it('states both halves of the promise on the package-update form', async () => {
    const form = await openPackageUpdate()

    expect(within(form).getByText('Your app stays live while this is reviewed')).toBeInTheDocument()
    const disclosure = within(form).getByText('Your app stays live while this is reviewed').closest('div')
    expect(disclosure).toHaveTextContent(/does not take your app offline/i)
    expect(disclosure).toHaveTextContent(/it does not ship/i)
    expect(disclosure).toHaveTextContent(/members keep running the package a curator already approved/i)
    // The vendor-side consequence of content-committed approval (FR-004a).
    expect(disclosure).toHaveTextContent(/cancels that review/i)
  })

  it('does not promise a serving package to a listing that has none', async () => {
    state.vendorApps = vi.fn(async () =>
      vendorOk([
        appRecord({
          id: 9,
          name: 'Fresh Submission',
          status: AppStatus.PENDING,
          launchable: false,
          proposed: packageRef({ cid: GOOD_CID, manifestHash: MANIFEST_HASH, version: 1 }),
        }),
      ]),
    )
    await renderSettled()
    fireEvent.click(screen.getByRole('button', { name: 'Submit a package update' }))
    const form = formFor('Submit package for review')

    expect(within(form).getByText('Nothing is serving yet')).toBeInTheDocument()
    expect(within(form).queryByText(/does not take your app offline/i)).toBeNull()
  })

  it('never predicts the version number the registry will issue', async () => {
    const form = await openPackageUpdate()
    expect(within(form).getByText(/never reuses one/i)).toHaveTextContent(
      /cannot tell you which number in advance without guessing/i,
    )
    expect(within(form).queryByLabelText(/version/i)).toBeNull()
  })

  it('sends submitUpdate for the listing being updated', async () => {
    const form = await openPackageUpdate()
    setField(form, 'Package CID', 'bafynewpackagecid234567')
    setField(form, 'Manifest hash', WRONG_HASH)
    fireEvent.click(within(form).getByRole('button', { name: 'Submit package for review' }))

    await waitFor(() => expect(state.wallet.sendCalls).toHaveBeenCalledTimes(1))
    const parsed = iface.parseTransaction({ data: state.wallet.sendCalls.mock.calls[0][0][0].data })
    expect(parsed.name).toBe('submitUpdate')
    expect(parsed.args[0]).toBe(7n)
    expect(parsed.args[1]).toBe('bafynewpackagecid234567')
    expect(parsed.args[2]).toBe(WRONG_HASH)
  })

  it('says that a metadata edit is also a re-review, and sends updateMetadata', async () => {
    state.vendorApps = vi.fn(async () => vendorOk([live]))
    await renderSettled()
    fireEvent.click(screen.getByRole('button', { name: 'Edit listing details' }))
    const form = formFor('Submit details for review')

    expect(within(form).getByText(/reviewed fields, so editing them sends the listing back to review/i)).toBeInTheDocument()
    expect(within(form).getByText('Your app stays live while this is reviewed')).toBeInTheDocument()

    setField(form, 'Listing name', 'Settle Desk Pro')
    fireEvent.change(within(form).getByLabelText('Operational category'), {
      target: { value: String(AppCategory.REPORTING_AUDIT) },
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Submit details for review' }))

    await waitFor(() => expect(state.wallet.sendCalls).toHaveBeenCalledTimes(1))
    const parsed = iface.parseTransaction({ data: state.wallet.sendCalls.mock.calls[0][0][0].data })
    expect(parsed.name).toBe('updateMetadata')
    expect(parsed.args[0]).toBe(7n)
    expect(parsed.args[1]).toBe('Settle Desk Pro')
    expect(parsed.args[3]).toBe(BigInt(AppCategory.REPORTING_AUDIT))
  })

  it('confirms the outcome without implying the update shipped', async () => {
    const form = await openPackageUpdate()
    setField(form, 'Package CID', 'bafynewpackagecid234567')
    setField(form, 'Manifest hash', WRONG_HASH)
    fireEvent.click(within(form).getByRole('button', { name: 'Submit package for review' }))

    const notice = await screen.findByText(/The new package is queued for review/i)
    expect(notice).toHaveTextContent(/Your app is not offline/i)
    expect(notice).toHaveTextContent(/until a curator approves this one/i)
  })
})

// =============================================================================
// Accessibility.
// =============================================================================

describe('SubmitAppPanel — accessibility (WCAG 2.1 AA)', () => {
  it('has no violations with a populated submissions list and the new-listing form', async () => {
    state.vendorApps = vi.fn(async () =>
      vendorOk([
        appRecord({
          id: 7,
          name: 'Settle Desk',
          description: 'Matches and settles bilateral trades.',
          status: AppStatus.PENDING,
          launchable: true,
          proposed: packageRef({ cid: 'bafyproposedcid234567', manifestHash: WRONG_HASH, version: 5 }),
        }),
      ]),
    )
    const { container } = await renderSettled()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no violations in the wrong-network state', async () => {
    state.wallet.chainId = 1
    const { container } = await renderSettled()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('sends focus to the first refused field when a submission is blocked (T047)', async () => {
    // A refused submit is otherwise completely silent: the button does nothing a screen reader
    // can perceive, the page does not navigate, and the errors appear beside fields nobody was
    // told to go and look at. Landing on the first refused control both announces the failure
    // (its label, its error and its invalid state are read on arrival) and puts the vendor on
    // the thing they have to change.
    await renderSettled()
    const form = formFor(NEW_LISTING)
    // Description filled, name and package left empty: the FIRST refusal in DOM order is name.
    setField(form, 'Description', 'Matches and settles bilateral trades.')
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))

    const name = within(form).getByLabelText('Listing name')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(name).toHaveAttribute('aria-invalid', 'true')
    // The error is the field's own description, not a message elsewhere on the page.
    const describedBy = (name.getAttribute('aria-describedby') || '').split(/\s+/)
    const errorId = describedBy.find((id) => document.getElementById(id)?.textContent?.includes('Enter a name'))
    expect(errorId).toBeTruthy()
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('re-announces a second identical refusal rather than going quiet', async () => {
    // Nothing in the DOM changes between two identical failed presses, so without the attempt
    // counter behind the focus move the second press would produce no perceivable response at
    // all — the classic "I pressed it and nothing happened" for a non-sighted vendor.
    await renderSettled()
    const form = formFor(NEW_LISTING)
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))
    const name = within(form).getByLabelText('Listing name')
    await waitFor(() => expect(document.activeElement).toBe(name))

    // Move away, press again: focus must come back.
    within(form).getByLabelText('Description').focus()
    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))
    await waitFor(() => expect(document.activeElement).toBe(name))
  })

  it('sends focus to the acknowledgement when a hash mismatch is the only thing blocking', async () => {
    // The one refusal with no invalid FIELD behind it: every value is acceptable to the chain,
    // and what the submission is waiting on is the vendor's consent.
    state.fetchImpl = servesManifest()
    await renderSettled()
    const form = fillValidListing({ manifestHash: WRONG_HASH })
    await within(form).findByText(/does not hash to what you entered/i, undefined, { timeout: 3000 })

    fireEvent.click(within(form).getByRole('button', { name: NEW_LISTING }))
    const ack = within(form).getByRole('checkbox')
    await waitFor(() => expect(document.activeElement).toBe(ack))
    expect(state.wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('names the form each disclosure button opens', async () => {
    // `aria-expanded` alone says a control reveals SOMETHING; `aria-controls` is what lets a
    // screen-reader user jump to the form instead of hunting for it below the card.
    state.vendorApps = vi.fn(async () => vendorOk([appRecord({ id: 7, name: 'Settle Desk' })]))
    await renderSettled()

    const toggle = screen.getByRole('button', { name: 'Submit a package update' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)

    const expanded = screen.getByRole('button', { name: 'Cancel package update' })
    expect(expanded).toHaveAttribute('aria-expanded', 'true')
    const controlled = expanded.getAttribute('aria-controls')
    expect(controlled).toBeTruthy()
    expect(document.getElementById(controlled)).toBe(formFor('Submit package for review'))
  })

  it('labels every category option with its on-chain enum order', async () => {
    await renderSettled()
    const options = within(formFor(NEW_LISTING))
      .getByLabelText('Operational category')
      .querySelectorAll('option')
    expect(Array.from(options, (option) => option.textContent)).toEqual(
      Object.entries(APP_CATEGORY_LABELS)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, label]) => label),
    )
  })
})
