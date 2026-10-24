// Spec 102 (US4, FR-009) — the Style view mounts the spec-086 customize body against the vault
// ADDRESS, so one profile applies on every network.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'

vi.mock('../../components/ui/BlockiesAvatar', () => ({
  default: () => <div data-testid="blockies" />,
}))

import VaultStyleView from '../../components/custody/VaultStyleView'
import { getAccountProfile, clearAccountProfile } from '../../lib/account/accountProfilesStore'

const A = '0xAaAa000000000000000000000000000000000001'
const group = { key: A.toLowerCase(), address: A, label: 'Treasury', chainIds: [137, 8453] }

beforeEach(() => {
  localStorage.clear()
  clearAccountProfile(A)
})

describe('VaultStyleView', () => {
  it('renders the intro line and both radiogroups', () => {
    render(<VaultStyleView group={group} />)
    expect(screen.getByTestId('vault-style-intro')).toHaveTextContent('This look applies to Treasury on every network (2).')
    expect(screen.getByRole('radiogroup', { name: /shade/i })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /pattern/i })).toBeInTheDocument()
    expect(screen.getByTestId('account-customize')).toBeInTheDocument()
  })

  it('writes the profile under the vault address (one look for every network)', () => {
    render(<VaultStyleView group={group} />)
    fireEvent.click(screen.getByRole('radio', { name: /sky shade/i }))
    expect(getAccountProfile(A)).toMatchObject({ tint: 'sky' })
    expect(getAccountProfile(A.toLowerCase())).toMatchObject({ tint: 'sky' })
  })

  it('has no axe violations', async () => {
    const { container } = render(<VaultStyleView group={group} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
