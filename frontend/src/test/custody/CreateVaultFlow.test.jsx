// Spec 105 (US1, T-013) — the guided four-sheet flow. Asserted here: preset semantics (nobody
// types a bare threshold unless they chose Complex), the plain-language refusals, tile edits
// reflected in the live summary, network honesty (a rail's reason rendered BEFORE any attempt),
// and that Deploy hands the orchestrator the RESOLVED arrangement.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'

vi.mock('../../components/custody/CustodyAddressField', () => ({
  default: ({ id, value, onChange, label }) => (
    <input id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

let deploymentCtx
vi.mock('../../hooks/useVaultDeployment', () => ({ default: () => deploymentCtx }))
vi.mock('../../components/custody/createflow/createFlowModel', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, creationChainIds: () => [137, 8453, 61] }
})

import CreateVaultFlow from '../../components/custody/createflow/CreateVaultFlow'

const ME = '0x1111111111111111111111111111111111111111'
const CO = '0x2222222222222222222222222222222222222222'

beforeEach(() => {
  deploymentCtx = {
    byChain: {},
    predictedAddress: null,
    running: false,
    start: vi.fn().mockResolvedValue({ address: '0x9999999999999999999999999999999999999999' }),
    retryChain: vi.fn(),
    railFor: vi.fn(() => ({ available: true, rail: 'signer' })),
    refreshStatuses: vi.fn(),
    hasRecordFor: vi.fn(() => false),
    connectedChainId: 137,
  }
})

const typeSecondOwner = (addr) => {
  fireEvent.change(screen.getByLabelText(/owner 2 address/i), { target: { value: addr } })
}

const toRules = () => {
  typeSecondOwner(CO)
  fireEvent.click(screen.getByRole('button', { name: /next: set rules/i }))
}

const toNetworks = () => {
  toRules()
  fireEvent.click(screen.getByRole('button', { name: /next: pick networks/i }))
}

describe('CreateVaultFlow', () => {
  it('Joint is exactly two owners and one signature — no bare threshold control (FR-002)', () => {
    render(<CreateVaultFlow connectedAddress={ME} chainId={137} />)
    expect(screen.getByRole('radio', { name: /joint account/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByLabelText(/owner \d address/i)).toHaveLength(2)
    expect(screen.queryByLabelText(/approvals required/i)).not.toBeInTheDocument()
    // Leaving the second owner empty is refused with the plain-language sentence.
    fireEvent.click(screen.getByRole('button', { name: /next: set rules/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/exactly two owners/i)
  })

  it('Controlled tracks the owner count (n of n); Complex exposes the threshold', () => {
    render(<CreateVaultFlow connectedAddress={ME} chainId={137} />)
    fireEvent.click(screen.getByRole('radio', { name: /controlled/i }))
    typeSecondOwner(CO)
    expect(screen.getByText(/all 2 owners must sign every move/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /complex/i }))
    expect(screen.getByLabelText(/approvals required/i)).toBeInTheDocument()
  })

  it('tile edits update the live summary before anything is signed (FR-004)', () => {
    render(<CreateVaultFlow connectedAddress={ME} chainId={137} />)
    toRules()
    const summary = screen.getByTestId('rules-summary')
    expect(summary).toHaveTextContent(/up to 500 of everyday money/i)
    fireEvent.click(screen.getByTestId('rule-tile-cap'))
    fireEvent.change(screen.getByLabelText(/daily cap amount/i), { target: { value: '250' } })
    expect(summary).toHaveTextContent(/up to 250 of everyday money/i)
    expect(summary).toHaveTextContent(/sends over the daily cap need all 2 owners/i)
  })

  it('a network whose rail cannot act is offered with its reason, disabled, before any attempt (FR-008)', () => {
    deploymentCtx.railFor = vi.fn((id) =>
      id === 61 ? { available: false, reason: 'Connect a wallet that can sign on Ethereum Classic.' } : { available: true },
    )
    render(<CreateVaultFlow connectedAddress={ME} chainId={137} />)
    toNetworks()
    const chip = screen.getByTestId('network-chip-61')
    expect(chip).toBeDisabled()
    expect(screen.getByText(/connect a wallet that can sign on ethereum classic/i)).toBeInTheDocument()
    expect(deploymentCtx.start).not.toHaveBeenCalled()
  })

  it('Deploy hands the orchestrator the resolved arrangement and the selected networks', async () => {
    render(<CreateVaultFlow connectedAddress={ME} chainId={137} />)
    toNetworks()
    fireEvent.click(screen.getByTestId('network-chip-8453'))
    fireEvent.click(screen.getByTestId('deploy-button'))
    await waitFor(() => expect(deploymentCtx.start).toHaveBeenCalledTimes(1))
    const args = deploymentCtx.start.mock.calls[0][0]
    expect(args.owners).toEqual([ME, CO])
    expect(args.threshold).toBe(1) // Joint
    expect(args.chainIds).toEqual([137, 8453])
    expect(args.presetType).toBe('joint')
    expect(args.semanticRules).toMatchObject({ dailyCapAmount: '500' })
  })

  it('the 1-of-1-no-rules refusal survives, in plain language (FR-003)', () => {
    render(<CreateVaultFlow connectedAddress={ME} chainId={137} />)
    fireEvent.click(screen.getByRole('radio', { name: /complex/i }))
    // One owner (self), threshold 1, rules switched OFF.
    fireEvent.click(screen.getByRole('button', { name: /next: set rules/i }))
    fireEvent.click(screen.getByTestId('rule-tile-cap'))
    fireEvent.change(screen.getByLabelText(/daily cap amount/i), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('rule-tile-wait'))
    fireEvent.click(screen.getByRole('radio', { name: /no wait/i }))
    fireEvent.click(screen.getByTestId('rule-tile-allowed'))
    fireEvent.click(screen.getByRole('radio', { name: /everything — one set of rules/i }))
    fireEvent.click(screen.getByRole('button', { name: /next: pick networks/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/wallet wearing a vault badge/i)
  })

  it('the done sheet names everything still pending (FR-011)', () => {
    deploymentCtx.byChain = {
      137: { status: 'live', rulesStatus: 'active' },
      8453: { status: 'live', rulesStatus: 'awaiting-approval' },
    }
    deploymentCtx.predictedAddress = '0x9999999999999999999999999999999999999999'
    render(<CreateVaultFlow connectedAddress={ME} chainId={137} />)
    toNetworks()
    fireEvent.click(screen.getByTestId('network-chip-8453'))
    // Jump the controller to done via deploy + continue.
    fireEvent.click(screen.getByTestId('deploy-button'))
    return waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      const pending = screen.getByLabelText(/still pending/i)
      expect(pending).toHaveTextContent(/rules on base are queued/i)
      expect(within(screen.getByTestId('create-step-done')).getByText(/0x9999/i)).toBeInTheDocument()
    })
  })
})
