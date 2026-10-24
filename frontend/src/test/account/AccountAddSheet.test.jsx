/**
 * Account "+" chooser (release 1.14.0 task 5) — the add control on the account
 * cards carousel opens a bottom sheet with the three ways an account can join
 * this list, each deep-linking to the surface that actually performs it:
 *
 *   - add a vault            → Protect ▸ On chain   (accordion card `custody-onchain`)
 *   - add a hardware account → Protect ▸ Off chain  (accordion card `custody-offchain`)
 *   - recover a legacy account → Recovery ▸ Legacy account recovery (`legacy-recovery`)
 *
 * The chooser NAVIGATES — it never re-implements any of those flows. Targets are
 * asserted against `pathForDestination` from the nav search index rather than
 * literals, so the sheet, the drawer search and the accordion deep-link machinery
 * (focus flash + open-card hash) can only agree or fail together.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { pathForDestination } from '../../config/navSearchIndex'

const mockNavigate = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => mockNavigate }
})

const PERSONAL = {
  id: 'personal', kind: 'personal',
  address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', label: 'Personal wallet',
}

let switcherState

vi.mock('../../hooks/useAccountSwitcher', () => {
  const useAccountSwitcher = () => switcherState
  return {
    useAccountSwitcher,
    default: useAccountSwitcher,
    ACCOUNT_KIND_TAG: { vault: 'Multisig', legacy: 'Recovered' },
    shortAccountAddr: (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''),
  }
})
vi.mock('../../components/ui/BlockiesAvatar', () => ({ default: () => <div data-testid="avatar" /> }))

const { default: AccountCardsCarousel } = await import('../../components/account/AccountCardsCarousel')

function renderCarousel() {
  return render(
    <MemoryRouter>
      <AccountCardsCarousel />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  switcherState = {
    accounts: [PERSONAL],
    currentId: 'personal',
    choose: vi.fn(),
    hasChoices: false,
  }
})

describe('the account "+" chooser', () => {
  it('renders an add control on the carousel, outside the listbox', () => {
    renderCarousel()
    const add = screen.getByTestId('account-add-open')
    expect(add).toHaveAccessibleName(/add an account/i)
    // The listbox is a row of options; an option may contain no interactive children
    // (the same axe rule the "⋯" overlay already honours).
    expect(screen.getByRole('listbox').contains(add)).toBe(false)
    // Closed by default — no chooser dialog mounted.
    expect(screen.queryByRole('dialog', { name: /add an account/i })).not.toBeInTheDocument()
  })

  it('opens the chooser with the three ways to add an account', () => {
    renderCarousel()
    fireEvent.click(screen.getByTestId('account-add-open'))
    expect(screen.getByRole('dialog', { name: /add an account/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add a vault/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add a hardware account/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /recover a legacy account/i })).toBeInTheDocument()
  })

  it.each([
    ['add a vault', 'custody-onchain'],
    ['add a hardware account', 'custody-offchain'],
    ['recover a legacy account', 'legacy-recovery'],
  ])('"%s" deep-links to the %s destination and closes the sheet', (label, destinationId) => {
    renderCarousel()
    fireEvent.click(screen.getByTestId('account-add-open'))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }))
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith(pathForDestination(destinationId))
    expect(screen.queryByRole('dialog', { name: /add an account/i })).not.toBeInTheDocument()
  })

  it('sanity: the destinations carry the tab and open-card hash the surfaces expect', () => {
    // Belt and braces over the lockstep assertion above: if the index entries
    // themselves moved, the chooser would follow them — but a wrong TAB would
    // strand the member on the wrong surface, so pin the load-bearing parts.
    expect(pathForDestination('custody-onchain')).toContain('tab=custody')
    expect(pathForDestination('custody-onchain')).toContain('#custody-onchain')
    expect(pathForDestination('custody-offchain')).toContain('tab=custody')
    expect(pathForDestination('custody-offchain')).toContain('#custody-offchain')
    expect(pathForDestination('legacy-recovery')).toContain('tab=security')
    expect(pathForDestination('legacy-recovery')).toContain('#legacy-recovery')
  })

  it('closes on Escape without navigating', () => {
    renderCarousel()
    fireEvent.click(screen.getByTestId('account-add-open'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /add an account/i })).not.toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
