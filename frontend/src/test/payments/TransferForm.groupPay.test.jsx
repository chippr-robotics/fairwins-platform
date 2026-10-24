/**
 * Transfer ▸ Send — group pay.
 *
 * Same feature, second surface. The single-recipient preview/send is asserted unchanged first,
 * because Transfer is where the largest payments are made and it is the path that must not move.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const ONE = '0xbbbb000000000000000000000000000000000002'
const TWO = '0xcccc000000000000000000000000000000000003'
const BTC_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

vi.mock('../../components/ui/AddressInput', () => ({
  default: ({ id, value, onChange, onResolvedChange, placeholder, disabled }) => (
    <input
      id={id}
      aria-label={id === 'pt-to' ? 'To' : undefined}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        onChange(e)
        onResolvedChange?.(/^0x[0-9a-fA-F]{40}$/.test(e.target.value) ? e.target.value : '')
      }}
    />
  ),
}))
vi.mock('../../components/ui/BlockiesAvatar', () => ({ default: () => <span data-testid="blockie" /> }))

const send = vi.fn()
const showNotification = vi.fn()
const screenOne = vi.fn()
const groupHolder = {}

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useAccount: () => ({ address: '0xAaAa000000000000000000000000000000000001', chainId: 137 }),
}))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => ({ address: '0xAaAa000000000000000000000000000000000001', chainId: 137 }),
}))
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({
    identity: { mode: 'personal' }, isVault: false,
    operateAsPersonal: vi.fn(), operateAsVault: vi.fn(), operateAsLegacy: vi.fn(), operateAsHardware: vi.fn(),
  }),
}))
vi.mock('../../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => ({ type: 'personal', address: null, isActingAccount: false, connectedAddress: null, chainId: null, label: null }),
}))
vi.mock('../../hooks/useHardwareAccounts', () => ({ useHardwareAccounts: () => [] }))
vi.mock('../../hooks/useLegacyAccounts', () => ({ useLegacyAccounts: () => [] }))
vi.mock('../../hooks/useCustodyVaults', () => ({ useCustodyVaults: () => ({ vaults: [] }) }))
vi.mock('../../hooks/useAccountAssets', () => ({ useAccountAssets: () => ({ holdings: [], refresh: vi.fn() }) }))
vi.mock('../../hooks/usePortfolio', () => ({ default: () => ({ holdings: [], status: 'ready', priceMap: new Map() }) }))
vi.mock('../../hooks/useAddressScreening', () => ({
  useAddressScreening: () => ({ screenOne, getStatus: () => 'clear', screen: vi.fn(), search: vi.fn() }),
}))
vi.mock('../../hooks/useUI', () => ({ useNotification: () => ({ showNotification }) }))
vi.mock('../../hooks/useBitcoinWallet', () => ({ useBitcoinWallet: () => ({ status: 'idle', networkId: null, balances: { spendableSats: 0 } }) }))
vi.mock('../../hooks/useGroupPay', () => ({
  useGroupPay: () => groupHolder,
  GROUP_OUTCOME: { SENT: 'sent', PENDING: 'pending', PROPOSED: 'proposed', FAILED: 'failed', SKIPPED: 'skipped' },
}))
vi.mock('../../hooks/useTransfer', async () => {
  const actual = await vi.importActual('../../hooks/useTransfer')
  return {
    ...actual,
    useTransfer: () => ({
      send,
      status: 'idle',
      error: null,
      quoteGaslessForAsset: (a) => Number(a?.chainId) === 137,
      balanceOf: (kind) => (kind === 'stable' ? '100' : '5'),
      refreshBalances: vi.fn(),
      tokens: {
        stable: 'USDC', stableName: 'USD Coin', stableDecimals: 6, stableAddress: '0xtoken',
        native: 'POL', nativeName: 'POL', nativeDecimals: 18,
        chainId: 137, networkName: 'Polygon',
      },
      isPasskey: true,
    }),
  }
})

import TransferForm from '../../components/wallet/TransferForm'
import { GROUP_RAIL } from '../../lib/payments/groupPay'

const setRow = (n, addr, amount) => {
  fireEvent.change(screen.getByLabelText(`Recipient ${n} address`), { target: { value: addr } })
  fireEvent.change(screen.getByLabelText(`Recipient ${n} amount`), { target: { value: amount } })
}

beforeEach(() => {
  send.mockReset().mockResolvedValue({ txHash: '0xhash', route: 'gasless', id: 't1' })
  showNotification.mockReset()
  screenOne.mockReset().mockResolvedValue('clear')
  Object.assign(groupHolder, {
    rail: GROUP_RAIL.BATCH_PASSKEY,
    railReason: null,
    // Issue #1441 withdrew the affordance behind this flag. The journeys below drive the list
    // itself, so they set it true; the withdrawal is asserted in its own describe at the end of
    // the file, and the DEFAULT (false) is proven at the hook and lib level.
    available: true,
    unavailableCode: null,
    unavailableReason: null,
    status: 'idle',
    outcomes: null,
    summary: null,
    error: null,
    submitGroup: vi.fn(async () => ({
      outcomes: [
        { id: 'primary', address: ONE, amount: '10', symbol: 'USDC', status: 'sent', txHash: '0xaa', reason: null },
        { id: 'r2', address: TWO, amount: '4', symbol: 'USDC', status: 'skipped', txHash: null, reason: 'Flagged by sanctions screening — this payment was not sent.' },
      ],
      summary: { rail: GROUP_RAIL.BATCH_PASSKEY, total: 2, sent: 1, failed: 0, skipped: 1, pending: 0, proposed: 0 },
    })),
    reset: vi.fn(),
  })
})

const draftOne = async (user) => {
  render(<TransferForm />)
  await user.type(screen.getByLabelText('To'), ONE)
  await user.type(screen.getByLabelText('Amount'), '10')
}

describe('the single-recipient send is unchanged', () => {
  it('previews and sends through the existing engine, never through group pay', async () => {
    const user = userEvent.setup()
    await draftOne(user)
    const preview = screen.getByRole('button', { name: 'Preview' })
    await waitFor(() => expect(preview).toBeEnabled())
    await user.click(preview)
    expect(screen.getByText('10 USDC')).toBeInTheDocument()
    expect(screen.queryByTestId('group-pay-confirm')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(groupHolder.submitGroup).not.toHaveBeenCalled()
  })
})

describe('group send', () => {
  /* See the twin in PayPanel.groupPay.test.jsx — the To field is recipient one, not the whole
     destination, and it says so exactly when there is more than one. */
  it('marks the To field as multi only once a second recipient exists', async () => {
    const user = userEvent.setup()
    await draftOne(user)
    expect(screen.queryByLabelText(/multiple recipients/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('group-pay-add'))
    setRow(2, TWO, '4')

    const marker = await screen.findByLabelText('Multiple recipients: 2')
    expect(marker).toHaveTextContent(/multi/i)
    expect(marker).toHaveTextContent('2')
  })

  it('previews the total, the breakdown and how it will be submitted', async () => {
    const user = userEvent.setup()
    await draftOne(user)
    fireEvent.click(screen.getByTestId('group-pay-add'))
    setRow(2, TWO, '4')

    const preview = screen.getByRole('button', { name: 'Preview' })
    await waitFor(() => expect(preview).toBeEnabled())
    await user.click(preview)

    expect(screen.getByTestId('group-pay-total')).toHaveTextContent('14 USDC')
    expect(within(screen.getByTestId('group-pay-breakdown')).getAllByTestId('group-pay-breakdown-row')).toHaveLength(2)
    expect(screen.getByTestId('group-pay-rail')).toHaveTextContent(/one transaction carrying all 2 payments/i)
  })

  it('submits every recipient in one call and reports each outcome', async () => {
    const user = userEvent.setup()
    await draftOne(user)
    fireEvent.click(screen.getByTestId('group-pay-add'))
    setRow(2, TWO, '4')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Preview$/ })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /^Preview$/ }))
    await user.click(screen.getByRole('button', { name: /send to 2 recipients/i }))

    await waitFor(() => expect(groupHolder.submitGroup).toHaveBeenCalledTimes(1))
    const [payload] = groupHolder.submitGroup.mock.calls[0]
    expect(payload.recipients.map((r) => r.address)).toEqual([ONE, TWO])
    expect(send).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByTestId('group-pay-outcomes')).toBeInTheDocument())
    const rows = screen.getAllByTestId('group-pay-outcome')
    expect(rows[0]).toHaveTextContent(/sent/i)
    expect(rows[1]).toHaveTextContent(/skipped/i)
    expect(rows[1]).toHaveTextContent(/sanctions screening/i)
  })

  it('refuses a Bitcoin recipient by name and keeps Preview disabled', async () => {
    const user = userEvent.setup()
    await draftOne(user)
    fireEvent.click(screen.getByTestId('group-pay-add'))
    setRow(2, BTC_ADDR, '1')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/bitcoin address/i))
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled()
  })
})

/* Issue #1441 — the same withdrawal on Transfer ▸ Send. */
describe('the group affordance is withdrawn (#1441)', () => {
  beforeEach(() => { groupHolder.available = false })

  it('renders no add control and no recipient rows', async () => {
    render(<TransferForm />)
    await waitFor(() => expect(screen.getByLabelText('To')).toBeInTheDocument())
    expect(screen.queryByTestId('group-pay-add')).toBeNull()
    expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0)
  })

  it('empties a list that was already drafted when the affordance goes away', async () => {
    groupHolder.available = true
    const user = userEvent.setup()
    const { rerender } = render(<TransferForm />)
    await user.type(screen.getByLabelText('To'), ONE)
    await user.type(screen.getByLabelText('Amount'), '10')
    fireEvent.click(screen.getByTestId('group-pay-add'))
    setRow(2, TWO, '2')
    await waitFor(() => expect(screen.getAllByTestId('group-pay-row')).toHaveLength(1))

    groupHolder.available = false
    rerender(<TransferForm />)

    await waitFor(() => expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0))
    expect(screen.queryByTestId('group-pay-add')).toBeNull()
  })
})
