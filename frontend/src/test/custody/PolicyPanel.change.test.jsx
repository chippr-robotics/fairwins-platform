// Spec 049 (US3, FR-007/FR-009) — owner management flows. Uses the REAL policy lib for
// encoding/validation (chain 1337 carries the synced guard addresses) with only the network reads
// mocked, so the asserted payloads are byte-real: the change flow targets the guard with encoded
// configureRules, and the attach flow queues configureRules BEFORE setGuard (ordered nonces).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { getAddress } from 'ethers'

vi.mock('../../lib/custody/policy', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getPolicyStatus: vi.fn(),
    readPolicy: vi.fn(),
  }
})

import PolicyPanel from '../../components/custody/PolicyPanel'
import { Interface } from 'ethers'
import { getPolicyStatus, readPolicy, NATIVE_ASSET } from '../../lib/custody/policy'
import { SAFE_POLICY_GUARD_ABI } from '../../abis/SafePolicyGuard'

// Decoded with ethers against calldata the panel builds with viem — a cross-library byte check,
// the same reasoning as policy.test.js and the router suites (spec 110).
const guardIface = new Interface(SAFE_POLICY_GUARD_ABI)
import { getContractAddressForChain } from '../../config/contracts'

const CHAIN = 1337
const GUARD = getAddress(getContractAddressForChain('safePolicyGuard', CHAIN))
const VAULT = getAddress('0x2222222222222222222222222222222222222222')
const ONE = 10n ** 18n

const ownerVault = {
  isSafe: true,
  address: VAULT,
  chainId: CHAIN,
  owners: [VAULT],
  threshold: 2,
  owner: true,
}

const currentPolicy = {
  hasRules: true,
  allowlistEnabled: false,
  allowlistCount: 0,
  cooldown: 0,
  nextAllowedAt: 0,
  allowlist: [],
  assetRules: [
    { asset: NATIVE_ASSET, perTxLimit: ONE, windowLimit: 0n, spentInWindow: 0n, windowStart: 0, remainingInWindow: 0n },
  ],
}

beforeEach(() => {
  getPolicyStatus.mockReset()
  readPolicy.mockReset()
})

describe('PolicyPanel — owner change flow (managed vault)', () => {
  it('shows current vs proposed side by side, then submits an encoded configureRules tx to the guard', async () => {
    getPolicyStatus.mockResolvedValue('managed')
    readPolicy.mockResolvedValue(currentPolicy)
    const onPropose = vi.fn().mockResolvedValue({ safeTxHash: '0x1', nonce: 4 })
    render(<PolicyPanel vault={ownerVault} onPropose={onPropose} />)

    fireEvent.click(await screen.findByRole('button', { name: /propose change/i }))

    // Prefilled from the current on-chain rule, then raised 1 → 2.
    const perTx = screen.getByLabelText(/^per-transaction limit \(blank for none\)/i)
    expect(perTx.value).toBe('1.0')
    fireEvent.change(perTx, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /review change/i }))

    // Current vs proposed side by side (US3-AS1), rendered by the real describeRules.
    expect(screen.getByText(/current policy/i)).toBeInTheDocument()
    expect(screen.getByText(/proposed policy/i)).toBeInTheDocument()
    expect(screen.getByText(/max 1\.0 etc per transaction/i)).toBeInTheDocument()
    expect(screen.getByText(/max 2\.0 etc per transaction/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /propose this change/i }))
    await waitFor(() => expect(onPropose).toHaveBeenCalledTimes(1))

    const tx = onPropose.mock.calls[0][0]
    expect(getAddress(tx.to)).toBe(GUARD)
    expect(tx.value).toBe(0n)
    const parsed = guardIface.parseTransaction({ data: tx.data })
    expect(parsed.name).toBe('configureRules')
    const [limits] = parsed.args
    expect(getAddress(limits[0].asset)).toBe(getAddress(NATIVE_ASSET))
    expect(BigInt(limits[0].perTxLimit)).toBe(2n * ONE)
  })

  it('rejects an invalid configuration at review time (FR-015) without proposing', async () => {
    getPolicyStatus.mockResolvedValue('managed')
    readPolicy.mockResolvedValue(currentPolicy)
    const onPropose = vi.fn()
    render(<PolicyPanel vault={ownerVault} onPropose={onPropose} />)

    fireEvent.click(await screen.findByRole('button', { name: /propose change/i }))
    // per-tx 2 above a window of 1 can never be reached — must be caught client-side.
    fireEvent.change(screen.getByLabelText(/^per-transaction limit \(blank for none\)/i), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(/^24-hour window limit \(blank for none\)/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /review change/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/never be reached/i)
    expect(onPropose).not.toHaveBeenCalled()
  })
})

describe('PolicyPanel — owner attach flow (vault without a policy)', () => {
  it('queues configureRules FIRST and setGuard SECOND, pinned to consecutive nonces', async () => {
    getPolicyStatus.mockResolvedValue('none')
    const onPropose = vi
      .fn()
      .mockResolvedValueOnce({ safeTxHash: '0xaaa', nonce: 7 })
      .mockResolvedValueOnce({ safeTxHash: '0xbbb', nonce: 8 })
    render(<PolicyPanel vault={ownerVault} onPropose={onPropose} />)

    fireEvent.click(await screen.findByRole('button', { name: /attach a policy/i }))
    fireEvent.change(screen.getByLabelText(/minimum time between transactions/i), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(/^unit$/i), { target: { value: 'hours' } })
    fireEvent.click(screen.getByRole('button', { name: /review policy/i }))

    // The two-transaction explanation (rules only activate with the second).
    expect(screen.getByText(/rules only take effect once the second transaction executes/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /queue both transactions/i }))
    await waitFor(() => expect(onPropose).toHaveBeenCalledTimes(2))

    // (1) configureRules to the guard.
    const first = onPropose.mock.calls[0][0]
    expect(getAddress(first.to)).toBe(GUARD)
    const parsedFirst = guardIface.parseTransaction({ data: first.data })
    expect(parsedFirst.name).toBe('configureRules')
    expect(Number(parsedFirst.args[1])).toBe(2 * 3600)

    // (2) setGuard on the vault itself, pinned to the following nonce so the chain enforces order.
    const second = onPropose.mock.calls[1][0]
    expect(getAddress(second.to)).toBe(VAULT)
    expect(second.data.startsWith('0xe19a9dd9')).toBe(true) // setGuard(address)
    expect(second.data.toLowerCase()).toContain(GUARD.slice(2).toLowerCase())
    expect(second.nonce).toBe(8)

    // Confirmation explains the co-owner approval requirement.
    expect(await screen.findByRole('status')).toHaveTextContent(/both need co-owner approval/i)
  })
})
