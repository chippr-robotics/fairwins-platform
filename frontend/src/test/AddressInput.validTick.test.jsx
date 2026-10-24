/**
 * #1431 — the "Valid address" tick must not wait on a cosmetic mainnet lookup.
 *
 * `useEnsReverseLookup` fires a live `useEnsName({ chainId: mainnet.id })` for ANY pasted address,
 * routed by wagmi.js at a third-party public RPC. It decides only whether to DECORATE the field
 * with a name — the address is already resolved, synchronously and with no network involved.
 *
 * Gating the tick on it made the field withhold confirmation of a fact it already had, for as long
 * as that RPC took to answer (indefinitely on a slow or blocked network), and made the on-chain e2e
 * tier flaky for a reason that had nothing to do with the code under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const ensState = { resolvedAddress: null, isLoading: false, error: null, isEns: false, isAddress: false }
const reverseState = { ensName: null, isLoading: false }
const callsignState = { isCallsign: false, address: null, status: null, verified: false, isLoading: false, message: null }

vi.mock('../hooks/useEnsResolution', () => ({
  useEnsResolution: () => ensState,
  useEnsReverseLookup: () => reverseState,
}))
vi.mock('../hooks/useCallsignResolution', () => ({
  useCallsignResolution: () => callsignState,
}))

import AddressInput from '../components/ui/AddressInput'

const ADDR = '0x1111111111111111111111111111111111111111'

beforeEach(() => {
  Object.assign(ensState, { resolvedAddress: null, isLoading: false, error: null, isEns: false, isAddress: false })
  Object.assign(reverseState, { ensName: null, isLoading: false })
  Object.assign(callsignState, { isCallsign: false, address: null, status: null, verified: false, isLoading: false, message: null })
})

describe('AddressInput — the valid-address tick (#1431)', () => {
  it('confirms a valid address WHILE the reverse ENS lookup is still in flight', () => {
    // THE REGRESSION. Before the fix this rendered the spinner instead, for as long as a
    // third-party mainnet RPC took to answer.
    Object.assign(ensState, { resolvedAddress: ADDR, isAddress: true })
    Object.assign(reverseState, { ensName: null, isLoading: true })

    render(<AddressInput id="t1" value={ADDR} onChange={() => {}} />)

    expect(screen.getByLabelText('Valid address')).toBeInTheDocument()
    expect(screen.queryByLabelText('Resolving...')).not.toBeInTheDocument()
  })

  it('still shows the spinner while RESOLUTION is busy — the work that decides if there is an address', () => {
    // The distinction the fix rests on: resolution is load-bearing, decoration is not.
    Object.assign(ensState, { resolvedAddress: null, isLoading: true, isEns: true })

    render(<AddressInput id="t2" value="someone.eth" onChange={() => {}} />)

    expect(screen.getByLabelText('Resolving...')).toBeInTheDocument()
    expect(screen.queryByLabelText('Valid address')).not.toBeInTheDocument()
  })

  it('waits for a callsign resolution, which genuinely decides the address', () => {
    Object.assign(callsignState, { isCallsign: true, isLoading: true })

    render(<AddressInput id="t3" value="%someone" onChange={() => {}} />)

    expect(screen.getByLabelText('Resolving...')).toBeInTheDocument()
  })

  it('shows the ENS name only once its own lookup lands, without ever holding the tick back', () => {
    Object.assign(ensState, { resolvedAddress: ADDR, isAddress: true })
    Object.assign(reverseState, { ensName: null, isLoading: true })
    const { rerender } = render(<AddressInput id="t4" value={ADDR} onChange={() => {}} />)
    expect(screen.getByLabelText('Valid address')).toBeInTheDocument()
    expect(screen.queryByText(/known as/i)).not.toBeInTheDocument()

    Object.assign(reverseState, { ensName: 'someone.eth', isLoading: false })
    rerender(<AddressInput id="t4" value={ADDR} onChange={() => {}} />)
    expect(screen.getByLabelText('Valid address')).toBeInTheDocument()
    expect(screen.getByText('someone.eth')).toBeInTheDocument()
  })
})
