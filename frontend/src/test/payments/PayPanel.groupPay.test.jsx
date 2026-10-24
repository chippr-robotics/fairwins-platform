/**
 * Home ▸ Pay — group pay.
 *
 * The first test in this file is the most important one: a member who never presses "Add another
 * recipient" must reach the SAME confirm screen and the SAME `send()` call as before. Group pay
 * is an addition to this surface, not a rewrite of it.
 *
 * The rest cover what a member is told before they sign — the total, who gets what, how it will
 * be submitted and who pays the fee — and what they are told afterwards, per recipient.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const SECOND = '0x4444444444444444444444444444444444444444'
const BOOK_ADDR = '0x3333333333333333333333333333333333333333'
const BTC_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

const walletHolder = { isConnected: true, openConnectModal: vi.fn() }
vi.mock('../../hooks', () => ({
  useWallet: () => ({
    isConnected: walletHolder.isConnected,
    address: '0xabc',
    chainId: 137,
    openConnectModal: walletHolder.openConnectModal,
  }),
}))

const transferHolder = {}
vi.mock('../../hooks/useTransfer', () => ({
  useTransfer: () => transferHolder,
  TRANSFER_KIND: { NATIVE: 'native', STABLE: 'stable' },
}))

const nativeOpt = { key: '137:native', chainId: 137, kind: 'native', address: null, symbol: 'POL', name: 'Polygon', decimals: 18, networkName: 'Polygon', balance: 2 }
const stableOpt = { key: `137:${USDC.toLowerCase()}`, chainId: 137, kind: 'erc20', address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, networkName: 'Polygon', balance: 100 }
const selectableHolder = { options: [], defaultKey: null, gasless: true }
vi.mock('../../hooks/useSelectableAssets', () => ({
  useSelectableAssets: () => ({
    options: selectableHolder.options,
    defaultKey: selectableHolder.defaultKey,
    isGasless: () => selectableHolder.gasless,
  }),
  default: () => ({
    options: selectableHolder.options,
    defaultKey: selectableHolder.defaultKey,
    isGasless: () => selectableHolder.gasless,
  }),
}))

vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ identity: { mode: 'personal' }, isVault: false, isLegacy: false }),
}))
const effectiveHolder = { address: '0xabc', isActingAccount: false, type: 'personal' }
vi.mock('../../hooks/useEffectiveAccount', () => ({ useEffectiveAccount: () => effectiveHolder }))

const btcHolder = { status: 'idle', networkId: null, balances: { spendableSats: 0 } }
vi.mock('../../hooks/useBitcoinWallet', () => ({ useBitcoinWallet: () => btcHolder }))
vi.mock('../../components/wallet/BitcoinSendPanel', () => ({
  default: () => <div data-testid="btc-send-panel">bitcoin send</div>,
}))

const screeningHolder = { byAddress: {}, fallback: 'clear' }
vi.mock('../../hooks/useAddressScreening', () => ({
  useAddressScreening: () => ({
    screenOne: vi.fn(async (addr) => screeningHolder.byAddress[String(addr).toLowerCase()] ?? screeningHolder.fallback),
  }),
}))

const groupHolder = {}
vi.mock('../../hooks/useGroupPay', () => ({
  useGroupPay: () => groupHolder,
  GROUP_OUTCOME: { SENT: 'sent', PENDING: 'pending', PROPOSED: 'proposed', FAILED: 'failed', SKIPPED: 'skipped' },
}))

const notifyHolder = { showNotification: vi.fn() }
vi.mock('../../hooks/useUI', () => ({ useNotification: () => notifyHolder }))

const switchHolder = { switchChainAsync: vi.fn(async () => {}), isPending: false }
vi.mock('wagmi', () => ({ useSwitchChain: () => switchHolder }))

vi.mock('../../components/ui/AddressInput', () => ({
  default: ({ id, value, onChange, onResolvedChange, disabled }) => (
    <input
      id={id}
      aria-label={id === 'pay-to' ? 'To' : undefined}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        onChange(e)
        onResolvedChange?.(/^0x[0-9a-fA-F]{40}$/.test(e.target.value) ? e.target.value : '')
      }}
    />
  ),
}))
vi.mock('../../components/ui/AddressBookButton', () => ({
  default: ({ onSelect, disabled }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect({ address: BOOK_ADDR })}>book pick</button>
  ),
}))
vi.mock('../../components/ui/QRScanner', () => ({ default: () => null }))

import PayPanel from '../../components/fairwins/PayPanel'
import { GROUP_RAIL } from '../../lib/payments/groupPay'

const typeAmount = (digits) => {
  for (const d of digits) fireEvent.click(screen.getByRole('button', { name: d === '.' ? 'Decimal point' : d }))
}
const setRecipient = (addr) => fireEvent.change(screen.getByLabelText('To'), { target: { value: addr } })
const addRecipient = () => fireEvent.click(screen.getByTestId('group-pay-add'))
const setRow = (n, addr, amount) => {
  fireEvent.change(screen.getByLabelText(`Recipient ${n} address`), { target: { value: addr } })
  fireEvent.change(screen.getByLabelText(`Recipient ${n} amount`), { target: { value: amount } })
}
const payButton = () => screen.getByRole('button', { name: /^pay( \d+ recipients)?$/i })

/** Drive the form to a two-recipient draft: 12.5 to RECIPIENT, 5 to SECOND. */
const twoRecipientDraft = async () => {
  render(<PayPanel />)
  typeAmount(['1', '2', '.', '5'])
  setRecipient(RECIPIENT)
  addRecipient()
  setRow(2, SECOND, '5')
  await waitFor(() => expect(payButton()).toBeEnabled())
}

beforeEach(() => {
  localStorage.clear()
  Object.assign(transferHolder, {
    status: 'idle',
    error: null,
    send: vi.fn(async () => ({ txHash: '0xhash', route: 'gasless', id: 't1' })),
    refreshBalances: vi.fn(),
  })
  selectableHolder.options = [stableOpt, nativeOpt]
  selectableHolder.defaultKey = stableOpt.key
  selectableHolder.gasless = true
  walletHolder.isConnected = true
  screeningHolder.byAddress = {}
  screeningHolder.fallback = 'clear'
  notifyHolder.showNotification = vi.fn()
  Object.assign(effectiveHolder, { address: '0xabc', isActingAccount: false, type: 'personal' })
  Object.assign(btcHolder, { status: 'idle', networkId: null, balances: { spendableSats: 0 } })
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
    submitGroup: vi.fn(async () => ({ outcomes: [], summary: { sent: 2, failed: 0, skipped: 0, pending: 0, proposed: 0, total: 2 } })),
    reset: vi.fn(),
  })
})

describe('the single-recipient path is untouched', () => {
  it('confirms and sends through the existing engine, never through group pay', async () => {
    render(<PayPanel />)
    typeAmount(['1', '2', '.', '5'])
    setRecipient(RECIPIENT)
    await waitFor(() => expect(payButton()).toBeEnabled())
    fireEvent.click(payButton())

    expect(screen.getByTestId('pay-confirm')).toHaveTextContent('12.5 USDC')
    expect(screen.queryByTestId('group-pay-confirm')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => expect(transferHolder.send).toHaveBeenCalledWith(
      expect.objectContaining({ asset: expect.objectContaining({ symbol: 'USDC' }), to: RECIPIENT, amount: '12.5' }),
    ))
    expect(groupHolder.submitGroup).not.toHaveBeenCalled()
    expect(payButton()).toHaveTextContent(/^Pay$/)
  })

  it('offers the group affordance without changing anything else on the form', () => {
    render(<PayPanel />)
    expect(screen.getByTestId('group-pay-add')).toBeInTheDocument()
    expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0)
  })

  /*
   * The To field is recipient ONE of the group, not the destination. With no marker beside it the
   * form says "To: <one address>" while the money goes to several people — so the marker is
   * present exactly when there is more than one recipient, and absent when there is not.
   */
  it('marks the To field as multi only once a second recipient exists', async () => {
    render(<PayPanel />)
    expect(screen.queryByLabelText(/multiple recipients/i)).not.toBeInTheDocument()

    typeAmount(['1', '2', '.', '5'])
    setRecipient(RECIPIENT)
    addRecipient()
    setRow(2, SECOND, '5')

    const marker = await screen.findByLabelText('Multiple recipients: 2')
    expect(marker).toHaveTextContent(/multi/i)
    expect(marker).toHaveTextContent('2')
  })
})

describe('building the recipient list', () => {
  it('adds a row and renames the action to name the number of people being paid', async () => {
    await twoRecipientDraft()
    expect(screen.getAllByTestId('group-pay-row')).toHaveLength(1)
    expect(payButton()).toHaveTextContent(/2 recipients/i)
  })

  it('keeps the button disabled while a row is incomplete', () => {
    render(<PayPanel />)
    typeAmount(['5'])
    setRecipient(RECIPIENT)
    addRecipient()
    expect(payButton()).toBeDisabled()
  })

  it('refuses a Bitcoin recipient by name rather than calling it invalid', async () => {
    render(<PayPanel />)
    typeAmount(['5'])
    setRecipient(RECIPIENT)
    addRecipient()
    setRow(2, BTC_ADDR, '1')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/bitcoin address/i))
    expect(payButton()).toBeDisabled()
  })

  it('flags a duplicate without blocking the payment', async () => {
    render(<PayPanel />)
    typeAmount(['5'])
    setRecipient(RECIPIENT)
    addRecipient()
    setRow(2, RECIPIENT, '1')
    await waitFor(() => expect(screen.getAllByText(/appears more than once/i).length).toBeGreaterThan(0))
    expect(payButton()).toBeEnabled()
  })

  it('blocks on the TOTAL exceeding the balance, naming the batch not a row', async () => {
    render(<PayPanel />)
    typeAmount(['6', '0'])
    setRecipient(RECIPIENT)
    addRecipient()
    setRow(2, SECOND, '60')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/more USDC than you have/i))
    expect(payButton()).toBeDisabled()
  })

  it('removing the last extra row returns to the single-recipient confirm', async () => {
    await twoRecipientDraft()
    fireEvent.click(screen.getByRole('button', { name: 'Remove recipient 2' }))
    await waitFor(() => expect(payButton()).toHaveTextContent(/^Pay$/))
    fireEvent.click(payButton())
    expect(screen.getByTestId('pay-confirm')).toBeInTheDocument()
  })
})

describe('the group confirm discloses the whole payment', () => {
  it('shows the total, the per-recipient breakdown, and how it will be submitted', async () => {
    await twoRecipientDraft()
    fireEvent.click(payButton())

    const confirm = screen.getByTestId('group-pay-confirm')
    expect(screen.getByTestId('group-pay-total')).toHaveTextContent('17.5 USDC')
    const rows = within(screen.getByTestId('group-pay-breakdown')).getAllByTestId('group-pay-breakdown-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('12.5')
    expect(rows[1]).toHaveTextContent('5')
    // A passkey batch is one transaction and says so, and a sponsored one says it is gasless.
    const rail = screen.getByTestId('group-pay-rail')
    expect(rail).toHaveTextContent(/one transaction carrying all 2 payments/i)
    expect(rail).toHaveTextContent(/no network fee/i)
    expect(confirm).toHaveTextContent('Polygon')
  })

  it('never claims gasless when the batch is not sponsored', async () => {
    selectableHolder.gasless = false
    await twoRecipientDraft()
    fireEvent.click(payButton())
    const rail = screen.getByTestId('group-pay-rail')
    expect(rail).toHaveTextContent(/you pay/i)
    expect(rail).not.toHaveTextContent(/gasless/i)
  })

  it('says a sequential run is N transactions that continue past a failure', async () => {
    groupHolder.rail = GROUP_RAIL.SEQUENTIAL
    selectableHolder.gasless = false
    await twoRecipientDraft()
    fireEvent.click(payButton())
    const rail = screen.getByTestId('group-pay-rail')
    expect(rail).toHaveTextContent(/2 separate transactions/i)
    expect(rail).toHaveTextContent(/rest still go through/i)
  })

  it('says a vault batch is one proposal its signers must approve', async () => {
    groupHolder.rail = GROUP_RAIL.VAULT_PROPOSAL
    await twoRecipientDraft()
    fireEvent.click(payButton())
    expect(screen.getByTestId('group-pay-rail')).toHaveTextContent(/one proposal/i)
  })

  it('submits every recipient, in order, in one call', async () => {
    await twoRecipientDraft()
    fireEvent.click(payButton())
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))
    await waitFor(() => expect(groupHolder.submitGroup).toHaveBeenCalledTimes(1))
    const [payload] = groupHolder.submitGroup.mock.calls[0]
    expect(payload.asset.symbol).toBe('USDC')
    expect(payload.recipients.map((r) => r.address)).toEqual([RECIPIENT, SECOND])
    expect(payload.recipients.map((r) => r.amount)).toEqual(['12.5', '5'])
    expect(transferHolder.send).not.toHaveBeenCalled()
  })
})

describe('refusals reach the member before they sign', () => {
  it('states the reason and disables Pay when the acting account has no rail', async () => {
    groupHolder.rail = GROUP_RAIL.REFUSED
    groupHolder.railReason = 'This account cannot send payments here yet, so nothing has been signed.'
    render(<PayPanel />)
    typeAmount(['5'])
    setRecipient(RECIPIENT)
    addRecipient()
    setRow(2, SECOND, '1')
    await waitFor(() => expect(screen.getByText(/cannot send payments here yet/i)).toBeInTheDocument())
    expect(payButton()).toBeDisabled()
  })

  it('blocks a screening-restricted recipient in the list', async () => {
    screeningHolder.byAddress[SECOND.toLowerCase()] = 'restricted'
    render(<PayPanel />)
    typeAmount(['5'])
    setRecipient(RECIPIENT)
    addRecipient()
    setRow(2, SECOND, '1')
    await waitFor(() => expect(screen.getAllByRole('alert').some((n) => /sanctions/i.test(n.textContent))).toBe(true))
    expect(payButton()).toBeDisabled()
  })
})

describe('per-recipient outcomes', () => {
  it('reports what happened to each recipient, including the ones that did not go through', async () => {
    groupHolder.rail = GROUP_RAIL.SEQUENTIAL
    groupHolder.submitGroup = vi.fn(async () => {
      const outcomes = [
        { id: 'primary', address: RECIPIENT, amount: '12.5', symbol: 'USDC', status: 'sent', txHash: '0xaa', reason: null },
        { id: 'r2', address: SECOND, amount: '5', symbol: 'USDC', status: 'failed', txHash: null, reason: 'nonce too low' },
      ]
      const summary = { rail: GROUP_RAIL.SEQUENTIAL, total: 2, sent: 1, failed: 1, skipped: 0, pending: 0, proposed: 0 }
      Object.assign(groupHolder, { outcomes, summary, status: 'done' })
      return { outcomes, summary }
    })
    await twoRecipientDraft()
    fireEvent.click(payButton())
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => expect(screen.getByTestId('group-pay-outcomes')).toBeInTheDocument())
    const rows = screen.getAllByTestId('group-pay-outcome')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent(/sent/i)
    expect(rows[1]).toHaveTextContent(/failed/i)
    expect(rows[1]).toHaveTextContent('nonce too low')
    expect(screen.getByTestId('group-pay-summary')).toHaveTextContent(/1 sent/i)
    expect(screen.getByTestId('group-pay-summary')).toHaveTextContent(/1 failed/i)
  })

  it('surfaces a refusal that stopped the whole batch and keeps the draft', async () => {
    groupHolder.submitGroup = vi.fn(async () => { throw new Error('Sanctions screening flags 0x4444…') })
    await twoRecipientDraft()
    fireEvent.click(payButton())
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/sanctions screening flags/i))
    expect(screen.getByTestId('group-pay-confirm')).toBeInTheDocument()
  })
})

/*
 * Issue #1441 — the multi-recipient affordance is withdrawn from this surface. The single
 * -recipient journey must be exactly what it always was, which is the test above; these are about
 * what is NOT on the screen, and about the one way hiding a control can be worse than showing it.
 */
describe('the group affordance is withdrawn (#1441)', () => {
  beforeEach(() => { groupHolder.available = false })

  it('renders no add control and no recipient rows on Home ▸ Pay', () => {
    render(<PayPanel />)
    expect(screen.queryByTestId('group-pay-add')).toBeNull()
    expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0)
  })

  it('still pays one recipient through the ordinary engine', async () => {
    render(<PayPanel />)
    typeAmount(['1', '2', '.', '5'])
    setRecipient(RECIPIENT)
    await waitFor(() => expect(payButton()).toBeEnabled())
    fireEvent.click(payButton())
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => expect(transferHolder.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: RECIPIENT, amount: '12.5' }),
    ))
    expect(groupHolder.submitGroup).not.toHaveBeenCalled()
  })

  /*
   * The hook's answer can change under a draft — a different asset, a different acting account —
   * and rows left in the form's state while the control is gone would be SUBMITTED as a group
   * payment the member can no longer see. Withdrawal empties the list.
   */
  it('empties a list that was already drafted when the affordance goes away', async () => {
    groupHolder.available = true
    const { rerender } = render(<PayPanel />)
    typeAmount(['1', '2', '.', '5'])
    setRecipient(RECIPIENT)
    addRecipient()
    setRow(2, SECOND, '5')
    await waitFor(() => expect(payButton()).toHaveTextContent(/2 recipients/i))

    groupHolder.available = false
    rerender(<PayPanel />)

    await waitFor(() => expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0))
    expect(screen.queryByTestId('group-pay-add')).toBeNull()
    // Back to a single-recipient payment — the button no longer offers to pay several people.
    expect(payButton()).toHaveTextContent(/^Pay$/)
  })
})
