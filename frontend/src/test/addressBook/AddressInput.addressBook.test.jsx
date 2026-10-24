import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const A1 = '0x1111111111111111111111111111111111111111'
const RESTRICTED = '0x2222222222222222222222222222222222222222'

// Avoid wagmi ENS hooks entirely.
vi.mock('../../hooks/useEnsResolution', () => ({
  useEnsResolution: (value) => ({
    resolvedAddress: null,
    isLoading: false,
    error: null,
    isEns: false,
    isAddress: typeof value === 'string' && value.startsWith('0x') && value.length === 42,
  }),
  useEnsReverseLookup: () => ({ ensName: null, isLoading: false }),
}))

vi.mock('../../hooks/useAddressBook', () => ({
  useAddressBook: () => ({
    search: () => [{ contactId: 'c1', nickname: 'Alex', address: A1, chainId: 137 }],
  }),
}))

let statusMap = {}
vi.mock('../../hooks/useEstateScreening', async (importOriginal) => ({
  ...(await importOriginal()),
  useEstateScreeningMany: () => ({
    getVerdict: (addr) => statusMap[addr?.toLowerCase()] || 'screened',
    getVerdictOn: (addr) => statusMap[addr?.toLowerCase()] || 'screened',
    resultFor: () => null,
  }),
}))

import AddressInput from '../../components/ui/AddressInput'

function Controlled({ enableAddressBook = true, initial = '' }) {
  const [value, setValue] = useState(initial)
  return (
    <AddressInput
      id="addr"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      enableAddressBook={enableAddressBook}
      chainId={137}
    />
  )
}

describe('AddressInput — address book extension (US3)', () => {
  it('selecting a saved contact populates the field (FR-015, FR-016)', async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    await user.click(screen.getByRole('button', { name: 'Address book' }))
    await user.click(screen.getByText('Alex'))
    expect(screen.getByRole('textbox')).toHaveValue(A1)
  })

  it('surfaces a warning for a flagged resolved address (FR-016)', () => {
    statusMap = { [RESTRICTED.toLowerCase()]: 'flagged' }
    render(<Controlled initial={RESTRICTED} />)
    expect(screen.getByText('Flagged')).toBeInTheDocument()
  })

  it('is unchanged when the address book is disabled (regression guard)', async () => {
    statusMap = {}
    const user = userEvent.setup()
    render(<Controlled enableAddressBook={false} />)
    expect(screen.queryByRole('button', { name: 'Address book' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox'), '0xabc')
    expect(screen.getByRole('textbox')).toHaveValue('0xabc')
  })
})
