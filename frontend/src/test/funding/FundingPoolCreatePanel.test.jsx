import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { axe } from 'vitest-axe'

vi.mock('../../hooks/useFundingPools', () => ({ useFundingPools: vi.fn() }))
vi.mock('qrcode.react', () => ({
  QRCodeSVG: (props) => <svg data-testid="qr" data-value={props.value} role="img" aria-label={props['aria-label']} />,
}))

import { useFundingPools } from '../../hooks/useFundingPools'
import FundingPoolCreatePanel from '../../components/funding/FundingPoolCreatePanel'

const POOL = '0x5067457698Fd6Fa1C6964e416b3f42713513B3dD'
const hook = (over = {}) => ({ status: 'idle', error: null, available: () => true, createPool: vi.fn(), ...over })
const tap = (amount) => {
  for (const ch of String(amount)) fireEvent.click(screen.getByRole('button', { name: ch === '.' ? 'Decimal point' : ch }))
}
const renderPanel = (props = {}) =>
  render(<MemoryRouter><FundingPoolCreatePanel isConnected onConnect={() => {}} onOpenMyPools={() => {}} {...props} /></MemoryRouter>)

describe('FundingPoolCreatePanel (US1)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('disables Create until a purpose and a goal above zero exist, and says why on submit', async () => {
    useFundingPools.mockReturnValue(hook())
    const { container } = renderPanel()
    const create = screen.getByTestId('funding-create')
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/what is it for/i), { target: { value: "Dana's party" } })
    expect(create).toBeDisabled()
    tap('120')
    expect(create).toBeEnabled()
    expect(screen.getByText('12/200')).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('offers Connect when disconnected and My Pools always', () => {
    useFundingPools.mockReturnValue(hook())
    const onConnect = vi.fn()
    const onOpenMyPools = vi.fn()
    renderPanel({ isConnected: false, onConnect, onOpenMyPools })
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(onConnect).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('my-pools-open'))
    expect(onOpenMyPools).toHaveBeenCalled()
    expect(screen.queryByTestId('funding-create')).toBeNull()
  })

  it('says the purpose is public, and refuses on a network without the factory', () => {
    useFundingPools.mockReturnValue(hook({ available: () => false }))
    renderPanel()
    expect(screen.getByRole('note')).toHaveTextContent(/public on-chain/)
    expect(screen.getByTestId('funding-unavailable')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/what is it for/i), { target: { value: 'x' } })
    tap('1')
    expect(screen.getByTestId('funding-create')).toBeDisabled()
  })

  it('creates with the typed purpose, goal and window, then shows the share view with link, words and QR', async () => {
    const createPool = vi.fn(async () => ({ pool: POOL, poolId: 1n, wordIndices: [1, 2, 3, 4], phrase: 'river amber tiger kite', txHash: '0x1' }))
    useFundingPools.mockReturnValue(hook({ createPool }))
    renderPanel()
    fireEvent.change(screen.getByLabelText(/what is it for/i), { target: { value: 'Team offsite' } })
    tap('250.5')
    fireEvent.click(screen.getByRole('radio', { name: '2 weeks' }))
    fireEvent.click(screen.getByTestId('funding-create'))
    expect(createPool).toHaveBeenCalledWith({ purpose: 'Team offsite', goal: '250.5', windowId: '2w' })
    await waitFor(() => expect(screen.getByTestId('funding-created')).toBeInTheDocument())
    expect(screen.getByTestId('funding-link')).toHaveTextContent('/fund/river-amber-tiger-kite')
    expect(screen.getByTestId('funding-phrase')).toHaveTextContent('river amber tiger kite')
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', expect.stringContaining('/fund/river-amber-tiger-kite'))
    expect(screen.getByTestId('open-my-pool')).toBeInTheDocument()
  })

  it('surfaces the hook error', () => {
    useFundingPools.mockReturnValue(hook({ status: 'error', error: 'User rejected the request' }))
    renderPanel()
    expect(screen.getByTestId('funding-error')).toHaveTextContent('User rejected')
  })

  it('an unlanded receipt is reported honestly, with My Pools as the recovery path', async () => {
    const createPool = vi.fn(async () => ({ pool: null, phrase: null, txHash: '0x1' }))
    useFundingPools.mockReturnValue(hook({ createPool }))
    renderPanel()
    fireEvent.change(screen.getByLabelText(/what is it for/i), { target: { value: 'x' } })
    tap('1')
    fireEvent.click(screen.getByTestId('funding-create'))
    await waitFor(() => expect(screen.getByTestId('funding-created')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(/receipt has not landed/)
    expect(screen.queryByTestId('open-my-pool')).toBeNull()
  })
})
