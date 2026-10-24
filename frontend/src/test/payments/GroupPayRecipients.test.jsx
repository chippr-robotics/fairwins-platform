/**
 * GroupPayRecipients — the recipient-list editor shared by Home ▸ Pay and Transfer ▸ Send.
 *
 * The list is ADDITIVE by design: row 1 is the form's existing To/amount fields, and this
 * component owns rows 2..N. That is what keeps the single-recipient journey — the overwhelming
 * majority of payments — exactly as it was, with one new button under it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../../components/ui/AddressInput', () => ({
  default: ({ id, value, onChange, onResolvedChange, disabled, placeholder }) => (
    <input
      id={id}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e)
        onResolvedChange?.(/^0x[0-9a-fA-F]{40}$/.test(e.target.value) ? e.target.value : '')
      }}
    />
  ),
}))
vi.mock('../../components/ui/AddressBookButton', () => ({
  default: ({ onSelect, disabled }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect({ address: BOOK })}>book</button>
  ),
}))

import GroupPayRecipients from '../../components/wallet/GroupPayRecipients'
import { MAX_GROUP_RECIPIENTS, RECIPIENT_ISSUE, makeRecipient } from '../../lib/payments/groupPay'

const A = '0x1111111111111111111111111111111111111111'
const BOOK = '0x5555555555555555555555555555555555555555'

const setup = (overrides = {}) => {
  const onChange = vi.fn()
  const props = {
    recipients: [],
    onChange,
    issuesFor: () => [],
    chainId: 137,
    symbol: 'USDC',
    disabled: false,
    idPrefix: 'pay',
    ...overrides,
  }
  const view = render(<GroupPayRecipients {...props} />)
  return { onChange, view, props }
}

const addButton = () => screen.getByTestId('group-pay-add')

beforeEach(() => { vi.clearAllMocks() })

describe('adding and removing recipients', () => {
  it('shows only the add control when the list is empty — the single-recipient form is unchanged', () => {
    setup()
    expect(addButton()).toBeInTheDocument()
    expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0)
  })

  it('adds a blank row', () => {
    const { onChange } = setup()
    fireEvent.click(addButton())
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ address: '', amount: '' })
    expect(next[0].id).toBeTruthy()
  })

  it('numbers extra rows from 2 — row 1 is the form above it', () => {
    setup({ recipients: [makeRecipient(), makeRecipient()] })
    expect(screen.getAllByTestId('group-pay-row')).toHaveLength(2)
    expect(screen.getByLabelText('Recipient 2 address')).toBeInTheDocument()
    expect(screen.getByLabelText('Recipient 3 amount')).toBeInTheDocument()
  })

  it('removes the row the member asked to remove, not the last one', () => {
    const rows = [makeRecipient({ address: A }), makeRecipient({ address: BOOK })]
    const { onChange } = setup({ recipients: rows })
    fireEvent.click(screen.getByRole('button', { name: 'Remove recipient 2' }))
    expect(onChange).toHaveBeenCalledWith([rows[1]])
  })

  it('edits one row without touching the others', () => {
    const rows = [makeRecipient(), makeRecipient()]
    const { onChange } = setup({ recipients: rows })
    fireEvent.change(screen.getByLabelText('Recipient 3 amount'), { target: { value: '2.5' } })
    const next = onChange.mock.calls[0][0]
    expect(next[0].amount).toBe('')
    expect(next[1].amount).toBe('2.5')
  })

  it('carries the resolved address (address book > callsign > ENS) not the typed text', () => {
    const rows = [makeRecipient()]
    const { onChange } = setup({ recipients: rows })
    fireEvent.change(screen.getByLabelText('Recipient 2 address'), { target: { value: A } })
    expect(onChange.mock.calls[0][0][0]).toMatchObject({ raw: A, address: A })
  })

  it('fills a row from the address book', () => {
    const rows = [makeRecipient()]
    const { onChange } = setup({ recipients: rows })
    fireEvent.click(screen.getByRole('button', { name: 'book' }))
    expect(onChange.mock.calls[0][0][0]).toMatchObject({ address: BOOK })
  })

  it('stops adding at the cap and says why', () => {
    setup({ recipients: Array.from({ length: MAX_GROUP_RECIPIENTS - 1 }, () => makeRecipient()) })
    expect(addButton()).toBeDisabled()
    expect(screen.getByTestId('group-pay-cap')).toHaveTextContent(String(MAX_GROUP_RECIPIENTS))
  })

  it('disables every control while a payment is in flight', () => {
    setup({ recipients: [makeRecipient()], disabled: true })
    expect(addButton()).toBeDisabled()
    expect(screen.getByLabelText('Recipient 2 address')).toBeDisabled()
    expect(screen.getByLabelText('Recipient 2 amount')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove recipient 2' })).toBeDisabled()
  })
})

describe('per-row issues', () => {
  const rows = [makeRecipient({ address: A })]

  it('raises a blocking issue as an alert', () => {
    setup({
      recipients: rows,
      issuesFor: () => [{ code: RECIPIENT_ISSUE.NON_EVM, message: 'That is a Bitcoin address.', blocking: true }],
    })
    expect(screen.getByRole('alert')).toHaveTextContent('That is a Bitcoin address.')
  })

  it('shows a flag (duplicate, self-payment) as a note, never as an alert', () => {
    setup({
      recipients: rows,
      issuesFor: () => [{ code: RECIPIENT_ISSUE.DUPLICATE, message: 'This address appears more than once', blocking: false }],
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/appears more than once/)).toBeInTheDocument()
  })
})

/*
 * Issue #1441 — `available` withdraws the editor entirely. Two properties, and the second is the
 * one that matters: the control disappears, AND any list already drafted is emptied. Rows left in
 * the parent's state behind a control that is gone would still be submitted as a group payment
 * the member could no longer see or edit.
 */
describe('withdrawn (#1441)', () => {
  it('renders nothing at all when the affordance is unavailable', () => {
    setup({ available: false })
    expect(screen.queryByTestId('group-pay-add')).toBeNull()
    expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0)
  })

  it('empties a list that already exists, so nothing hidden can be submitted', () => {
    const { onChange } = setup({ available: false, recipients: [makeRecipient({ address: A })] })
    expect(onChange).toHaveBeenCalledWith([])
    expect(screen.queryAllByTestId('group-pay-row')).toHaveLength(0)
  })

  it('leaves an already-empty list alone rather than committing a redundant change', () => {
    const { onChange } = setup({ available: false })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders the list as before when it is available', () => {
    setup({ available: true, recipients: [makeRecipient({ address: A })] })
    expect(screen.getByTestId('group-pay-add')).toBeInTheDocument()
    expect(screen.getAllByTestId('group-pay-row')).toHaveLength(1)
  })
})
