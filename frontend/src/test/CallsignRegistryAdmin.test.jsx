import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'

const seam = vi.hoisted(() => ({ reads: [], answer: () => undefined }))

// Mock the address resolver + the metrics hook so we render the tab without a live registry.
vi.mock('../config/contracts', () => ({ getContractAddressForChain: vi.fn() }))
/**
 * Registry reads through the ONE chain seam, recording the chain and the address.
 *
 * The suite below this deliberately renders with a NULL provider so `reader` is null and nothing
 * is ever read — which made the tab testable synchronously, and also meant the read path had no
 * coverage at all.
 */
vi.mock('../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      seam.reads.push({ chainId, address, functionName, args })
      return seam.answer(functionName, args)
    },
  }
})

vi.mock('../hooks/useCallsignRegistryMetrics', () => ({
  useCallsignRegistryMetrics: vi.fn(),
  CallsignStatus: { NONE: 0, ACTIVE: 1, REPOINTING: 2, QUARANTINED: 3, SUSPENDED: 4, LAPSED_RECLAIMABLE: 5 },
}))

import { cohortChainIds } from '../config/networks'
import { getContractAddressForChain } from '../config/contracts'
import { useCallsignRegistryMetrics } from '../hooks/useCallsignRegistryMetrics'
import CallsignRegistryAdmin from '../components/admin/CallsignRegistryAdmin'

const REGISTRY = '0x1111111111111111111111111111111111111111'
const OWNER = '0x' + 'a'.repeat(40)

const METRICS = {
  loading: false,
  error: null,
  truncated: false,
  refresh: vi.fn(),
  data: {
    counts: { registered: 5, changed: 1, released: 2, reclaimed: 0, repointRequested: 0, repointFinalized: 1, repointCancelled: 0, committed: 7 },
    netRegistrations: 3,
    suspended: [{ callsignHash: '0x' + '2'.repeat(64), callsign: 'baddie' }],
    verified: [{ callsignHash: '0x' + '3'.repeat(64), callsign: 'chipprbots' }],
    reserved: [],
    recent: [{ type: 'CallsignRegistered', callsignHash: '0x' + '1'.repeat(64), callsign: 'alpha', owner: OWNER, block: 100 }],
    truncated: false,
    totalEvents: 8,
  },
}

// Null provider → `reader` is null → loadConfig is a no-op (roles stay false), so the render is fully
// synchronous with no dangling contract-read promise. That models the "connected admin who holds no
// callsign-registry operator role" render without leaving async work that would fire after teardown.
const signer = { provider: null }
const baseProps = { signer, account: OWNER, contracts: {}, chainId: 137, runTx: vi.fn(), pendingTx: false }

describe('CallsignRegistryAdmin (spec 054 operator screen)', () => {
  beforeEach(() => {
    getContractAddressForChain.mockReset()
    useCallsignRegistryMetrics.mockReset()
    useCallsignRegistryMetrics.mockReturnValue(METRICS)
  })

  it('shows a not-configured notice when the registry has no address on this network', () => {
    getContractAddressForChain.mockReturnValue('')
    render(<CallsignRegistryAdmin {...baseProps} />)
    expect(screen.getByText(/not deployed \/ configured on this network/i)).toBeInTheDocument()
    // metrics/moderation cards are not rendered without an address
    expect(screen.queryByText(/Metrics/)).not.toBeInTheDocument()
  })

  it('renders metrics + moderation and gates operator actions when the wallet holds no role', async () => {
    getContractAddressForChain.mockReturnValue(REGISTRY)
    render(<CallsignRegistryAdmin {...baseProps} />)

    // Registry address + no-role disclosure
    expect(screen.getByText(/hold no operator role on this registry/i)).toBeInTheDocument()

    // Metric tiles from the mocked scan
    expect(screen.getByText('Active callsigns')).toBeInTheDocument()
    expect(screen.getByText('Registrations')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument() // netRegistrations
    expect(screen.getByText(/Currently suspended \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('%chipprbots')).toBeInTheDocument() // verified chip label

    // Moderation section present with a Refresh + Look up affordance
    expect(screen.getByRole('button', { name: /look up/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^refresh$/i })).toBeInTheDocument()

    // No policy/roles cards without the admin role
    expect(screen.queryByText(/Policy parameters/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Operator roles/)).not.toBeInTheDocument()
  })

  it('has no axe violations in the configured view', async () => {
    getContractAddressForChain.mockReturnValue(REGISTRY)
    const { container } = render(<CallsignRegistryAdmin {...baseProps} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})


/**
 * The read path (spec 110 T028), and the one value in this file that must never drift.
 *
 * `CALLSIGN_HASH` is FROZEN — computed with the ORIGINAL `ethers.id` before the swap. Asserting
 * against a freshly computed `keccak256(stringToBytes(canonical))` would use the very function
 * under test and prove only that it equals itself. A wrong hash does not throw: it looks up
 * nothing, and the panel reports a registered callsign as unregistered.
 */
describe('CallsignRegistryAdmin — the callsign hash reaches the right contract (spec 110)', () => {
  const CALLSIGN = 'chipprbots'
  // keccak256(utf8("chipprbots")), from ethers.id. Never regenerate this with the code it guards.
  const CALLSIGN_HASH = '0x793fc296286bec8eae7ed7a084580114362d926cb14f9c99a252b702b7194536'

  beforeEach(() => {
    getContractAddressForChain.mockReset()
    getContractAddressForChain.mockReturnValue(REGISTRY)
    useCallsignRegistryMetrics.mockReset()
    useCallsignRegistryMetrics.mockReturnValue(METRICS)
    seam.reads = []
    // Config reads answer with shapes the tab can render; the lookup answers as unregistered.
    seam.answer = (fn) => {
      if (fn === 'hasRole') return false
      if (fn === 'getCallsignInfoByHash') return { owner: '0x' + '0'.repeat(40), status: 0, verified: false }
      if (fn === 'reserved') return false
      if (fn.endsWith('ROLE') || fn === 'membershipRole') return '0x' + 'bb'.repeat(32)
      if (fn === 'membershipManager' || fn === 'sanctionsGuard') return '0x' + '0'.repeat(40)
      return 0n
    }
  })

  it('looks a callsign up by the FROZEN hash, at the registry address, on the scoped chain', async () => {
    // A chain this build's cohort actually contains: the scope seeds from the wallet's chain, and
    // off-cohort it seeds elsewhere, which disables every control (`onScopeNetwork`). That is
    // correct behaviour and is why the suite above never interacts with the form.
    const CHAIN = cohortChainIds()[0]
    render(<CallsignRegistryAdmin {...baseProps} chainId={CHAIN} signer={{ provider: {} }} />)

    fireEvent.change(document.getElementById('callsignadmin-callsign'), { target: { value: CALLSIGN } })
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))

    await waitFor(() =>
      expect(seam.reads.some((r) => r.functionName === 'getCallsignInfoByHash')).toBe(true),
    )
    const lookup = seam.reads.find((r) => r.functionName === 'getCallsignInfoByHash')
    expect(lookup.args[0]).toBe(CALLSIGN_HASH)
    expect(lookup.address).toBe(REGISTRY)
    // Every read names the SCOPED chain — the ethers Contract this replaced carried it inside a
    // provider, so a read against the wrong network's endpoint was invisible here.
    expect(seam.reads.every((r) => Number(r.chainId) === Number(CHAIN))).toBe(true)
  })
})
