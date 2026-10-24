// Spec 043 (US1) — load form: surfaces the classified error for a non-Safe and confirms a loaded vault.
// Spec 102 (US2) — a vault found on several networks is ADDED on all of them and the copy names every
// one; unreachable networks are named with a "Check again" action; there is no "pick another" prompt.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'
// Spec 068 — these surfaces now use the shared CustodyAddressField; the platform inputs are stubbed
// so each suite stays a unit test (the field itself is covered by CustodyAddressField.test.jsx).
vi.mock('../../components/ui/AddressInput', () => ({
  default: ({ id, value, onChange, placeholder, disabled }) => (
    <input id={id} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
  ),
}))
vi.mock('../../components/ui/AddressBookButton', () => ({ default: () => <button type="button">Address book</button> }))
vi.mock('../../components/ui/QRScanner', () => ({ default: () => null }))

import LoadVaultForm from '../../components/custody/LoadVaultForm'

const VAULT = '0x1111111111111111111111111111111111111111'

function load(onLoad, onDone) {
  render(<LoadVaultForm onLoad={onLoad} onDone={onDone} />)
  fireEvent.change(screen.getByLabelText(/vault address/i), { target: { value: VAULT } })
  fireEvent.click(screen.getByTestId('load-vault-submit'))
}

describe('LoadVaultForm', () => {
  it('shows an error when the address is not a Safe', async () => {
    const onLoad = vi.fn().mockRejectedValue(Object.assign(new Error('Not a Safe vault.'), { classification: 'not-a-safe' }))
    render(<LoadVaultForm onLoad={onLoad} />)
    fireEvent.change(screen.getByLabelText(/vault address/i), { target: { value: VAULT } })
    fireEvent.click(screen.getByRole('button', { name: /load vault/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not a safe/i))
    expect(screen.queryByTestId('load-vault-check-again')).toBeNull()
  })

  it('confirms a loaded view-only vault on one network and closes (byte-identical single-network path)', async () => {
    const onLoad = vi.fn().mockResolvedValue({ isSafe: true, owner: false, owners: [VAULT, VAULT], threshold: 2, chainId: 137, added: [137], unreachable: [] })
    const onDone = vi.fn()
    load(onLoad, onDone)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/found on polygon: a view-only vault/i))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('names EVERY network the vault was added on and closes — no "pick another" prompt', async () => {
    const onLoad = vi.fn().mockResolvedValue({
      isSafe: true,
      owner: true,
      owners: [VAULT, VAULT, VAULT],
      threshold: 2,
      chainId: 137,
      matches: [{ chainId: 137 }, { chainId: 8453 }, { chainId: 10 }],
      added: [137, 8453, 10],
      unreachable: [],
    })
    const onDone = vi.fn()
    load(onLoad, onDone)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/found on polygon, base and optimism: a vault you co-own/i))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /^use /i })).toBeNull()
    expect(screen.queryByText(/pick another/i)).toBeNull()
  })

  it('names unreachable networks with a "Check again" action that re-runs the probe', async () => {
    const onLoad = vi
      .fn()
      .mockResolvedValueOnce({ isSafe: true, owner: true, owners: [VAULT], threshold: 1, chainId: 137, added: [137], unreachable: [{ chainId: 8453, error: 'down' }, { chainId: 10, error: 'down' }] })
      .mockResolvedValueOnce({ isSafe: true, owner: true, owners: [VAULT], threshold: 1, chainId: 137, added: [137, 8453, 10], unreachable: [] })
    const onDone = vi.fn()
    load(onLoad, onDone)
    await waitFor(() => expect(screen.getByText(/not checked on base, optimism — those networks could not be reached/i)).toBeInTheDocument())
    expect(onDone).toHaveBeenCalledTimes(1) // something was added, so the form is done

    fireEvent.click(screen.getByTestId('load-vault-check-again'))
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('load-vault-check-again')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent(/found on polygon, base and optimism/i)
  })

  it('stays open with "Check again" when nothing was added because every network was unreachable', async () => {
    const err = Object.assign(new Error('No Safe vault found … Base could not be reached, so it may exist there — try again shortly.'), {
      classification: 'not-found-anywhere',
      unreachable: [{ chainId: 8453, error: 'down' }],
    })
    const onLoad = vi.fn().mockRejectedValue(err)
    const onDone = vi.fn()
    load(onLoad, onDone)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be reached/i))
    expect(screen.getByRole('status')).toHaveTextContent(/not checked on base/i)
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('load-vault-check-again'))
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2))
  })

  it('disables load until an address is entered and has no axe violations', async () => {
    const { container } = render(<LoadVaultForm onLoad={vi.fn()} />)
    expect(screen.getByRole('button', { name: /load vault/i })).toBeDisabled()
    expect(await axe(container)).toHaveNoViolations()
  })
})

