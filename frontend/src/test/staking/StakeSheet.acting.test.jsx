/**
 * StakeSheet and the account switcher (spec 088 FR-001/FR-002).
 *
 * Every write here (stake/unstake/withdraw/claim) goes out through `useStakingActions` →
 * `useEarnSend.sendOnChain`, which signs with the CONNECTED wallet and switches networks on it
 * directly — the same shape BridgeView already refuses while acting, since a staking option's
 * chain may not be the one the wallet is currently on and the acting-account seam neither
 * switches networks nor binds to anything but the wallet's CURRENT chain at ceremony time. So
 * while the switcher shows a vault, a recovered, a hardware, or any other non-personal account,
 * the whole sheet is withheld with a reason naming the account and the way out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const stakeFn = vi.hoisted(() => vi.fn())
const mockActions = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useStakingActions', () => ({
  useStakingActions: () => mockActions.current,
  default: () => mockActions.current,
}))

import StakeSheet from '../../components/earn/StakeSheet'

const ETH = 10n ** 18n
const LIDO = {
  id: 'liquid:lido',
  chainId: 1,
  model: 'liquid',
  providerKind: 'lido',
  asset: { symbol: 'ETH', decimals: 18 },
  provider: { name: 'Lido', url: '#' },
  lstSymbol: 'wstETH',
  instantExit: false,
}

const personal = () => ({
  stake: stakeFn,
  requestUnstake: vi.fn(),
  withdraw: vi.fn(),
  claimRewards: vi.fn(),
  address: '0xabc',
  canTransactOn: () => true,
  cannotTransactReason: () => 'nope',
  isPasskey: false,
  isActingAccount: false,
  actingAccount: { type: 'personal', address: '0xabc', label: null, isActingAccount: false },
})
const actingAs = (type, label = null) => ({
  ...personal(),
  isActingAccount: true,
  actingAccount: { type, address: '0xACTING', label, isActingAccount: true },
})

beforeEach(() => {
  stakeFn.mockReset()
  mockActions.current = personal()
})

describe('StakeSheet while acting as a non-personal account (spec 088 FR-001/FR-002)', () => {
  const kinds = [
    ['hardware', 'hardware', 'Ledger Nano', /hardware account|Ledger Nano/i],
    ['legacy (recovered)', 'legacy', null, /recovered account/i],
    ['vault', 'vault', 'Ops vault', /Ops vault/i],
  ]

  it.each(kinds)('withholds the sheet and says why while acting as %s', async (_name, type, label, names) => {
    mockActions.current = actingAs(type, label)
    render(<StakeSheet option={LIDO} userState={{ walletBalanceRaw: ETH }} onClose={vi.fn()} />)

    const refusal = await screen.findByTestId('earn-stake-acting-refusal')
    expect(refusal).toHaveTextContent(names)
    expect(refusal).toHaveTextContent(/switch back to acting as yourself/i)
    expect(refusal).toHaveTextContent(/nothing has been moved/i)

    expect(screen.queryByLabelText(/^Amount/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Stake ETH/i })).toBeNull()
  })

  it.each(kinds)('signs nothing while acting as %s', async (_name, type, label) => {
    mockActions.current = actingAs(type, label)
    render(<StakeSheet option={LIDO} userState={{ walletBalanceRaw: ETH }} onClose={vi.fn()} />)
    await screen.findByTestId('earn-stake-acting-refusal')

    expect(stakeFn).not.toHaveBeenCalled()
  })

  it('leaves the personal member’s sheet exactly as it was', async () => {
    mockActions.current = personal()
    render(<StakeSheet option={LIDO} userState={{ walletBalanceRaw: ETH }} onClose={vi.fn()} />)

    expect(await screen.findByLabelText(/^Amount/)).toBeInTheDocument()
    expect(screen.queryByTestId('earn-stake-acting-refusal')).toBeNull()
    expect(screen.getByRole('button', { name: /Stake ETH/i })).toBeInTheDocument()
  })
})
