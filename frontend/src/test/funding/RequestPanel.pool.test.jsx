import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The Request view gains a kind switch (spec 103, FR-001); the one-time flow must be untouched.
vi.mock('../../hooks', () => ({ useWallet: () => ({ isConnected: true, address: '0x5555555555555555555555555555555555555555', openConnectModal: vi.fn() }) }))
vi.mock('../../hooks/useEffectiveAccount', () => ({ useEffectiveAccount: () => ({ address: '0x5555555555555555555555555555555555555555', isActingAccount: false }) }))
vi.mock('../../hooks/useSelectableAssets', () => ({ useSelectableAssets: () => ({ options: [], defaultKey: null }) }))
vi.mock('../../hooks/useBitcoinWallet', () => ({ useBitcoinWallet: () => ({ status: 'idle' }) }))
vi.mock('../../hooks/useFundingPools', () => ({ useFundingPools: () => ({ status: 'idle', error: null, available: () => true, createPool: vi.fn(), resolveRef: vi.fn(), getSummary: vi.fn() }) }))
vi.mock('../../hooks/useMyFundingPools', () => ({ useMyFundingPools: () => ({ items: [], loading: false, refresh: vi.fn() }) }))
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => <svg data-testid="qr" /> }))

import RequestPanel from '../../components/fairwins/RequestPanel'

describe('RequestPanel — Direct | Pool kind switch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('starts on the one-time request and switches to the pool form without losing the switch', () => {
    render(<MemoryRouter><RequestPanel /></MemoryRouter>)
    expect(screen.getByTestId('request-kind')).toHaveAttribute('data-kind', 'once')
    expect(screen.getByLabelText('Amount to request')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Pool' }))
    expect(screen.getByTestId('request-kind')).toHaveAttribute('data-kind', 'pool')
    expect(screen.getByTestId('funding-create-form')).toBeInTheDocument()
    expect(screen.getByLabelText('Goal amount')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Direct' }))
    expect(screen.getByTestId('request-kind')).toHaveAttribute('data-kind', 'once')
  })

  it('opens on the pool kind when asked (deep link), and re-applies it when the nonce bumps', () => {
    const { rerender } = render(<MemoryRouter><RequestPanel initialKind="pool" /></MemoryRouter>)
    expect(screen.getByTestId('request-kind')).toHaveAttribute('data-kind', 'pool')
    fireEvent.click(screen.getByRole('radio', { name: 'Direct' }))
    expect(screen.getByTestId('request-kind')).toHaveAttribute('data-kind', 'once')
    rerender(<MemoryRouter><RequestPanel initialKind="pool" kindNonce={1} /></MemoryRouter>)
    expect(screen.getByTestId('request-kind')).toHaveAttribute('data-kind', 'pool')
  })

  it('My Pools opens the sheet with its honest empty state', () => {
    render(<MemoryRouter><RequestPanel initialKind="pool" /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('my-pools-open'))
    expect(screen.getByRole('dialog', { name: 'My Pools' })).toBeInTheDocument()
    expect(screen.getByTestId('my-pools-empty')).toHaveTextContent(/haven’t organized or contributed/)
  })
})
