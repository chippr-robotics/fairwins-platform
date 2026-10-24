import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ethers } from 'ethers'

import CreateStandardDao from '../CreateStandardDao'
import {
  FEE_STATEMENT,
  FEE_GAS_ONLY,
  FEE_READ,
  FEE_UNAVAILABLE,
  describeFeeEstimate,
  formatGas,
  formatNative,
} from '../createDaoFee'
import { validateCreateForm, toParams } from '../createDaoForm'
import { STANDARD_DAO_FACTORY_ABI, parseCreatedDAO } from '../standardDaoFactoryAbi'
import { nativeDaoUnavailableReason } from '../config/nativeDaoChains'
import { hostRef, resetHost } from './_host'

vi.mock('@fairwins/miniapp-sdk', () => ({ useMiniAppHost: () => hostRef.current }))

/**
 * Spec 030 pillar A (US1) — launching a native standard DAO from the package.
 *
 * The two behaviours worth defending here are (a) the surface never presents a DAO the chain has not
 * confirmed, and (b) where the factory cannot exist it says WHY rather than offering a dead control.
 * The stub host deliberately has the factory on 137 and not on 63 (Mordor is pre-Cancun, issue #1268),
 * so both branches are reachable without inventing a fixture.
 */

const IFACE = new ethers.Interface(STANDARD_DAO_FACTORY_ABI)

const GOVERNOR = '0x408ED6354d4973f66138C91495F2f2FCbd8724C3'
const TIMELOCK = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
const TOKEN = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

/** A receipt carrying a real `StandardDAOCreated` log, as the chain would return it. */
function receiptWithCreation(over = {}) {
  const fragment = IFACE.getEvent('StandardDAOCreated')
  const encoded = IFACE.encodeEventLog(fragment, [
    over.id ?? 1n,
    over.creator ?? '0x00000000000000000000000000000000000000a1',
    over.governor ?? GOVERNOR,
    over.timelock ?? TIMELOCK,
    over.token ?? TOKEN,
    over.tokenDeployed ?? true,
    over.name ?? 'Test DAO',
  ])
  return {
    status: 1,
    logs: [{ address: '0x00000000000000000000000000000000000000da', ...encoded }],
  }
}

async function fillMinimum(user) {
  await user.clear(screen.getByLabelText(/^DAO name$/i))
  await user.type(screen.getByLabelText(/^DAO name$/i), 'Test DAO')
  await user.type(screen.getByLabelText(/token name/i), 'Test DAO Token')
  await user.type(screen.getByLabelText(/token symbol/i), 'TDAO')
}

describe('CreateStandardDao (spec 030 pillar A / US1)', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('where the factory cannot exist', () => {
    it('names the pre-Cancun reason on Mordor instead of offering a dead button', () => {
      resetHost({ chainId: 63 })
      render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

      expect(screen.getByRole('status')).toHaveTextContent(/pre-Cancun EVM/i)
      expect(screen.getByRole('status')).toHaveTextContent(/not planned/i)
      // The registry pillar is explicitly still offered — the member is not told ClearPath is unavailable.
      expect(screen.getByRole('status')).toHaveTextContent(/Register \/ Track/i)
      expect(screen.queryByRole('button', { name: /launch dao/i })).not.toBeInTheDocument()
    })

    it('distinguishes "not deployed here" from "cannot exist here"', () => {
      // Chain 1 is a Cancun chain the stub simply has no deployment for.
      expect(nativeDaoUnavailableReason(1, 'Ethereum')).toMatch(/not deployed/i)
      expect(nativeDaoUnavailableReason(1, 'Ethereum')).not.toMatch(/pre-Cancun/i)
      expect(nativeDaoUnavailableReason(63, 'Mordor')).toMatch(/pre-Cancun/i)
    })

    it('shows the not-deployed wording on a Cancun chain with no factory recorded', () => {
      resetHost({ chainId: 1 })
      render(<CreateStandardDao hasRegistryFor={() => false} track={vi.fn()} />)
      expect(screen.getByRole('status')).toHaveTextContent(/not deployed/i)
      expect(screen.queryByRole('button', { name: /launch dao/i })).not.toBeInTheDocument()
    })
  })

  describe('creating', () => {
    it('submits ONE transaction to the factory with the parameters the member entered', async () => {
      resetHost({ chainId: 137, receipt: receiptWithCreation() })
      const user = userEvent.setup()
      render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

      await fillMinimum(user)
      await user.click(screen.getByRole('button', { name: /launch dao/i }))

      await waitFor(() => expect(hostRef.current.wallet.submit).toHaveBeenCalledTimes(1))
      const payload = hostRef.current.wallet.submit.mock.calls[0][0]
      expect(payload.to).toBe('0x00000000000000000000000000000000000000da')
      expect(payload.chainId).toBe(137)
      expect(payload.value).toBe(0n)

      const decoded = IFACE.decodeFunctionData('createDAO', payload.data)[0]
      expect(decoded.name).toBe('Test DAO')
      expect(decoded.votesToken).toBe(ethers.ZeroAddress)
      expect(decoded.tokenSymbol).toBe('TDAO')
      expect(decoded.quorumPercent).toBe(4n)
      expect(decoded.timelockDelay).toBe(48n * 3600n)
    })

    it('shows the deployed governor, treasury and token only after the receipt confirms them', async () => {
      resetHost({ chainId: 137, receipt: receiptWithCreation() })
      const user = userEvent.setup()
      render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

      await fillMinimum(user)
      await user.click(screen.getByRole('button', { name: /launch dao/i }))

      await waitFor(() => expect(screen.getByText(GOVERNOR)).toBeInTheDocument())
      expect(screen.getByText(TIMELOCK)).toBeInTheDocument()
      expect(screen.getByText(TOKEN)).toBeInTheDocument()
    })

    it('does NOT present a DAO when the transaction was only proposed to a vault', async () => {
      resetHost({ chainId: 137, proposed: true })
      const user = userEvent.setup()
      render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

      await fillMinimum(user)
      await user.click(screen.getByRole('button', { name: /launch dao/i }))

      await waitFor(() => expect(hostRef.current.wallet.submit).toHaveBeenCalled())
      expect(screen.queryByText(/is live/i)).not.toBeInTheDocument()
      expect(hostRef.current.toast.show).toHaveBeenCalledWith(
        expect.stringMatching(/proposed/i),
        'info',
      )
    })

    it('does NOT present a DAO when the receipt carries no creation event', async () => {
      resetHost({ chainId: 137, receipt: { status: 1, logs: [] } })
      const user = userEvent.setup()
      render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

      await fillMinimum(user)
      await user.click(screen.getByRole('button', { name: /launch dao/i }))

      await waitFor(() =>
        expect(hostRef.current.toast.show).toHaveBeenCalledWith(
          expect.stringMatching(/could not be read/i),
          'warning',
        ),
      )
      expect(screen.queryByText(/is live/i)).not.toBeInTheDocument()
    })

    it('offers registering the new DAO through the same track path the Register tab uses', async () => {
      resetHost({ chainId: 137, receipt: receiptWithCreation() })
      const track = vi.fn().mockResolvedValue({ added: true })
      const user = userEvent.setup()
      render(<CreateStandardDao hasRegistryFor={() => true} track={track} />)

      await fillMinimum(user)
      await user.click(screen.getByRole('button', { name: /launch dao/i }))
      await waitFor(() => expect(screen.getByText(GOVERNOR)).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: /register in the dao registry/i }))
      await waitFor(() =>
        expect(track).toHaveBeenCalledWith({
          address: GOVERNOR,
          framework: 0,
          label: 'Test DAO',
          chainId: 137,
        }),
      )
      expect(await screen.findByText(/Added to your DAOs/i)).toBeInTheDocument()
    })

    it('labels the follow-up honestly on a network with no on-chain registry', async () => {
      resetHost({ chainId: 137, receipt: receiptWithCreation() })
      const user = userEvent.setup()
      render(<CreateStandardDao hasRegistryFor={() => false} track={vi.fn()} />)

      await fillMinimum(user)
      await user.click(screen.getByRole('button', { name: /launch dao/i }))
      await waitFor(() => expect(screen.getByText(GOVERNOR)).toBeInTheDocument())

      expect(screen.getByRole('button', { name: /track this dao on this device/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /register in the dao registry/i })).not.toBeInTheDocument()
    })

    it('refuses to submit an invalid form and says which field is wrong', async () => {
      resetHost({ chainId: 137 })
      const user = userEvent.setup()
      render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

      await user.click(screen.getByRole('button', { name: /launch dao/i }))
      expect(await screen.findByRole('alert')).toHaveTextContent(/name/i)
      expect(hostRef.current.wallet.submit).not.toHaveBeenCalled()
    })
  })
})

/**
 * THE NETWORK-FEE DISCLOSURE (issue #1408).
 *
 * Creating a DAO is ~6.3M gas of real deployment that the member pays, and this surface used to say
 * nothing about it — the most expensive action in the app was the only one with no fee line. What is
 * defended here is the ORDER of the two claims: the statement that a fee applies is unconditional,
 * and only the NUMBER depends on a read succeeding. A failed estimate must cost the member a figure,
 * never the disclosure, and must never be allowed to read as "no fee".
 */
describe('the network fee disclosure (issue #1408)', () => {
  const feeText = () => document.querySelector('.cp-fee').textContent

  it('states that the member pays, before anything is signed, with the estimate once the form is complete', async () => {
    resetHost({ chainId: 137, receipt: receiptWithCreation() })
    const user = userEvent.setup()
    render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

    // Present from the first render — before the form is even valid, so it cannot be missed by a
    // member who fills the form fast.
    expect(feeText()).toContain('You pay the network fee for this deployment.')

    await fillMinimum(user)

    // 6,340,000 gas at 30 gwei = 0.1902 POL, in the connected chain's own unit.
    await waitFor(() => expect(feeText()).toMatch(/Estimated 6,340,000 gas/), { timeout: 3000 })
    expect(feeText()).toContain('about 0.1902 POL at the current gas price')
    expect(feeText()).toContain('Your wallet shows the final amount before you sign.')
    // And it is still there when the member reaches the button.
    expect(screen.getByRole('button', { name: /launch dao/i })).toBeInTheDocument()
    expect(hostRef.current.wallet.submit).not.toHaveBeenCalled()
  })

  it('prices the SAME calldata it would submit — the estimate is of this transaction, not a similar one', async () => {
    resetHost({ chainId: 137, receipt: receiptWithCreation() })
    const user = userEvent.setup()
    render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

    await fillMinimum(user)
    const provider = hostRef.current.readProvider(137)
    await waitFor(() => expect(provider.estimateGas).toHaveBeenCalled(), { timeout: 3000 })
    const estimated = provider.estimateGas.mock.calls.at(-1)[0]

    await user.click(screen.getByRole('button', { name: /launch dao/i }))
    await waitFor(() => expect(hostRef.current.wallet.submit).toHaveBeenCalledTimes(1))
    const submitted = hostRef.current.wallet.submit.mock.calls[0][0]

    expect(estimated.data).toBe(submitted.data)
    expect(estimated.to).toBe(submitted.to)
    // Estimated AS the member: the factory's Silver check reads msg.sender, so an estimate from
    // nobody would price a call that reverts for everybody.
    expect(estimated.from).toBe(hostRef.current.wallet.address)
  })

  it('keeps the fee statement and says the estimate could not be confirmed when the read fails', async () => {
    resetHost({
      chainId: 137,
      estimateGas: async () => {
        throw new Error('execution reverted')
      },
    })
    const user = userEvent.setup()
    render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

    await fillMinimum(user)
    await waitFor(() => expect(feeText()).toMatch(/could not be confirmed/i), { timeout: 3000 })

    // The fee is still disclosed, and no number was invented to fill the gap.
    expect(feeText()).toContain('You pay the network fee for this deployment.')
    expect(feeText()).not.toMatch(/\d[\d,]*\s*gas/)
    expect(feeText()).not.toMatch(/free|no fee|no network fee/i)
  })

  it('states the gas it read and refuses to price it when the gas price is unreadable', async () => {
    resetHost({
      chainId: 137,
      getFeeData: async () => ({ maxFeePerGas: null, gasPrice: null }),
    })
    const user = userEvent.setup()
    render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

    await fillMinimum(user)
    await waitFor(() => expect(feeText()).toMatch(/Estimated 6,340,000 gas/), { timeout: 3000 })
    expect(feeText()).toMatch(/gas price could not be read here/i)
    expect(feeText()).toMatch(/cost in POL could not be confirmed/i)
    // A gas figure with no price must never become a POL amount.
    expect(feeText()).not.toMatch(/about [\d.]+ POL/)
  })

  it('never says the deployment is sponsored, gasless or free — the host tells a package no such thing', async () => {
    // `host.wallet` carries no rail or sponsorship field (spec 073 host-context.md), so the package
    // cannot confirm sponsorship and must not claim it. This is the assertion CD-01 makes on the
    // whole workspace, kept here where it fails fast.
    resetHost({ chainId: 137 })
    const user = userEvent.setup()
    render(<CreateStandardDao hasRegistryFor={() => true} track={vi.fn()} />)

    await fillMinimum(user)
    await waitFor(() => expect(feeText()).toMatch(/Estimated/), { timeout: 3000 })
    expect(document.body.textContent).not.toMatch(
      /gasless|no gas|free to (launch|create)|we (cover|pay) the gas|sponsored/i,
    )
  })
})

describe('describeFeeEstimate', () => {
  it('states a cost only when gas AND a price were read', () => {
    expect(
      describeFeeEstimate({ state: FEE_READ, gas: 6_340_000n, feeWei: 190_200_000_000_000_000n }, { symbol: 'POL' }),
    ).toContain('Estimated 6,340,000 gas — about 0.1902 POL at the current gas price.')
  })

  it('states gas alone as gas alone, naming the unit it could not price', () => {
    const line = describeFeeEstimate({ state: FEE_GAS_ONLY, gas: 6_340_000n }, { symbol: 'POL' })
    expect(line).toContain('Estimated 6,340,000 gas.')
    expect(line).toMatch(/cost in POL could not be confirmed/)
    expect(line).not.toMatch(/POL at the current/)
  })

  it('says the estimate could not be confirmed rather than implying no fee', () => {
    const line = describeFeeEstimate({ state: FEE_UNAVAILABLE }, { symbol: 'POL' })
    expect(line).toMatch(/could not be confirmed/i)
    expect(line).not.toMatch(/free|no fee|0 POL/i)
  })

  it('renders a sentence for an unknown state instead of nothing at all', () => {
    // A fee line that renders empty while something is wrong is indistinguishable from a surface
    // with no fee line, which is the bug this whole module exists to fix.
    expect(describeFeeEstimate(undefined).length).toBeGreaterThan(0)
    expect(describeFeeEstimate({ state: 'something-new' }).length).toBeGreaterThan(0)
  })

  it('never claims a number a malformed read did not supply', () => {
    expect(describeFeeEstimate({ state: FEE_READ, gas: null, feeWei: null })).toMatch(/could not be confirmed/i)
    expect(describeFeeEstimate({ state: FEE_GAS_ONLY, gas: undefined })).toMatch(/could not be confirmed/i)
  })

  it('always carries the unconditional statement separately from the estimate', () => {
    expect(FEE_STATEMENT).toMatch(/^You pay the network fee for this deployment\./)
  })
})

describe('formatGas / formatNative', () => {
  it('groups gas exactly, from a bigint', () => {
    expect(formatGas(6_340_000n)).toBe('6,340,000')
    expect(formatGas('6340000')).toBe('6,340,000')
    expect(formatGas('not a number')).toBeNull()
  })

  it('renders four significant digits and never rounds a real cost to zero', () => {
    expect(formatNative(190_200_000_000_000_000n, 18)).toBe('0.1902')
    expect(formatNative(0n, 18)).toBe('0')
    expect(formatNative(1n, 18)).toBe('< 0.0001')
    expect(formatNative(-1n, 18)).toBeNull()
  })

  it('honours a chain whose native unit is not 18 decimals', () => {
    expect(formatNative(190_200_000n, 9)).toBe('0.1902')
  })
})

describe('validateCreateForm', () => {
  const base = {
    name: 'DAO',
    purpose: '',
    tokenMode: 'new',
    tokenName: 'Tok',
    tokenSymbol: 'TOK',
    initialSupply: '1000',
    votesToken: '',
    votingDelay: '1',
    votingPeriod: '100',
    proposalThreshold: '0',
    quorumPercent: '4',
    timelockHours: '48',
  }

  it('accepts a complete new-token form', () => {
    expect(validateCreateForm(base)).toBeNull()
  })

  it('rejects a zero voting period, a quorum outside 1..100 and an over-long timelock', () => {
    expect(validateCreateForm({ ...base, votingPeriod: '0' })).toMatch(/voting period/i)
    expect(validateCreateForm({ ...base, quorumPercent: '0' })).toMatch(/quorum/i)
    expect(validateCreateForm({ ...base, quorumPercent: '101' })).toMatch(/quorum/i)
    expect(validateCreateForm({ ...base, timelockHours: '721' })).toMatch(/timelock/i)
  })

  it('requires a real address in existing-token mode', () => {
    expect(validateCreateForm({ ...base, tokenMode: 'existing', votesToken: 'nope' })).toMatch(/address/i)
    expect(
      validateCreateForm({ ...base, tokenMode: 'existing', votesToken: GOVERNOR }),
    ).toBeNull()
  })
})

describe('toParams', () => {
  const base = {
    name: ' DAO ',
    purpose: ' why ',
    tokenMode: 'new',
    tokenName: 'Tok',
    tokenSymbol: 'TOK',
    initialSupply: '1000',
    votesToken: '',
    votingDelay: '7',
    votingPeriod: '100',
    proposalThreshold: '0',
    quorumPercent: '9',
    timelockHours: '2',
  }

  it('scales the supply to 18 decimals and the timelock to seconds', () => {
    const p = toParams(base)
    expect(p.initialSupply).toBe(ethers.parseUnits('1000', 18))
    expect(p.timelockDelay).toBe(7200n)
    expect(p.votesToken).toBe(ethers.ZeroAddress)
    expect(p.name).toBe('DAO')
  })

  it('sends no token metadata in existing-token mode', () => {
    const p = toParams({ ...base, tokenMode: 'existing', votesToken: GOVERNOR })
    expect(p.votesToken).toBe(GOVERNOR)
    expect(p.tokenName).toBe('')
    expect(p.tokenSymbol).toBe('')
    expect(p.initialSupply).toBe(0n)
  })
})

describe('parseCreatedDAO', () => {
  it('reads the created DAO out of the receipt log', () => {
    const dao = parseCreatedDAO(IFACE, receiptWithCreation())
    expect(dao).toMatchObject({ governor: GOVERNOR, timelock: TIMELOCK, token: TOKEN, name: 'Test DAO' })
  })

  it('returns null — never a partial DAO — when the log is absent or foreign', () => {
    expect(parseCreatedDAO(IFACE, { status: 1, logs: [] })).toBeNull()
    expect(
      parseCreatedDAO(IFACE, { status: 1, logs: [{ address: GOVERNOR, topics: ['0x' + '11'.repeat(32)], data: '0x' }] }),
    ).toBeNull()
  })
})
