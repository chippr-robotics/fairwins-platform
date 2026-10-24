// Spec 088 FR-002 (audit) — submit() has NO fall-through for an acting kind it does not handle.
//
// 'derived' is a real acting mode: `useEffectiveAccount` resolves it and WalletButton labels it
// "Recovered". It simply has no branch in `useActiveAccount.submit`. Before this guard it landed on
// the final `return submitAsActiveAccount(payload, { mode: 'personal', signer })` line and signed
// with the CONNECTED wallet while the account switcher named somebody else — the exact failure the
// seam exists to prevent, and one that would ship silently the day `operateAsDerived` is wired up.
//
// The identity is supplied straight through CustodyContext rather than through CustodyProvider,
// because the point of the guard is to hold for a mode NOTHING in the app can currently select:
// a test that could only reach it via an existing setter would be testing the setters instead.
//
// Two separate claims, both of which matter:
//   1. the send is REFUSED, with a reason a member can act on; and
//   2. the connected signer is never handed the payload — not "a different signer", NONE.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const PERSONAL_SIGNER = { id: 'personal' }

vi.mock('../../hooks', () => ({ useWallet: () => ({ address: '0xowner' }) }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => ({ chainId: 137, signer: PERSONAL_SIGNER, provider: {} }),
}))

const submitSpy = vi.fn(async () => ({ kind: 'sent', txHash: '0xabc' }))
vi.mock('../../lib/custody/submitAsActiveAccount', () => ({
  submitAsActiveAccount: (...args) => submitSpy(...args),
}))

import { CustodyContext } from '../../contexts/CustodyContext'
import { useActiveAccount } from '../../hooks/useActiveAccount'

const requestActingSigner = vi.fn(() => Promise.reject(new Error('ceremony should not run')))

function Probe() {
  const { submit } = useActiveAccount()
  return (
    <button
      onClick={() =>
        submit({ to: '0xdead', value: 1n })
          .then(() => { document.title = 'SENT' })
          .catch((e) => { document.title = e.message })
      }
    >
      submit
    </button>
  )
}

function renderAs(active) {
  return render(
    <CustodyContext.Provider
      value={{ active, legacySigner: null, hardwareSigner: null, requestActingSigner }}
    >
      <Probe />
    </CustodyContext.Provider>,
  )
}

beforeEach(() => {
  submitSpy.mockClear()
  requestActingSigner.mockClear()
  document.title = ''
})

describe('useActiveAccount — an acting kind with no submit() branch (spec 088 FR-002)', () => {
  it('refuses to send as a "derived" account rather than signing with the connected wallet', async () => {
    renderAs({ mode: 'derived', address: '0xDerived', label: 'Recovered BTC' })
    fireEvent.click(screen.getByText('submit'))

    await waitFor(() => expect(document.title).not.toBe(''))
    // Refused — and the refusal names the way out rather than reading as a breakage.
    expect(document.title).not.toBe('SENT')
    expect(document.title).toMatch(/nothing has been signed/i)
    expect(document.title).toMatch(/switch back to acting as yourself/i)
    // NOTHING was signed. Not "signed by another signer" — the send seam was never reached.
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('refuses any future unhandled acting kind, not only the one named today', async () => {
    renderAs({ mode: 'some-kind-invented-later', address: '0xWhatever' })
    fireEvent.click(screen.getByText('submit'))

    await waitFor(() => expect(document.title).toMatch(/nothing has been signed/i))
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('still sends normally as the personal wallet — the guard did not swallow the ordinary case', async () => {
    renderAs({ mode: 'personal' })
    fireEvent.click(screen.getByText('submit'))

    await waitFor(() => expect(submitSpy).toHaveBeenCalled())
    expect(submitSpy.mock.calls[0][1]).toMatchObject({ mode: 'personal', signer: PERSONAL_SIGNER })
  })
})
