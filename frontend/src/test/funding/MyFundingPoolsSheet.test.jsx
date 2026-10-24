import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { axe } from 'vitest-axe'

vi.mock('../../hooks/useMyFundingPools', () => ({ useMyFundingPools: vi.fn() }))
vi.mock('../../hooks/useFundingPools', () => ({ useFundingPools: vi.fn() }))

import { useMyFundingPools } from '../../hooks/useMyFundingPools'
import { useFundingPools } from '../../hooks/useFundingPools'
import MyFundingPoolsSheet from '../../components/funding/MyFundingPoolsSheet'

const P1 = '0x1111111111111111111111111111111111111111'
const P2 = '0x2222222222222222222222222222222222222222'
const row = (over = {}) => ({
  address: P1, purpose: "Dana's party", role: 'organizer', state: 0, stateLabel: 'Open', bucket: 'active',
  progressPct: 40, raisedFormatted: '48', goalFormatted: '120', tokenSymbol: 'USDC', nextAction: 'close',
  me: {}, readable: true, contributorCount: 2, contributeDeadline: 0, ...over,
})

function Probe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}
const renderSheet = (props = {}) =>
  render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="*" element={<><MyFundingPoolsSheet open onClose={() => {}} {...props} /><Probe /></>} />
      </Routes>
    </MemoryRouter>
  )

describe('MyFundingPoolsSheet (US6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFundingPools.mockReturnValue({ resolveRef: vi.fn() })
  })

  it('groups Active / Finished, shows role, progress and the next action, and opens the page', async () => {
    useMyFundingPools.mockReturnValue({
      items: [
        row(),
        row({ address: P2, purpose: 'Old trip', role: 'contributor', state: 1, stateLabel: 'Closed', bucket: 'finished', nextAction: null }),
      ],
      loading: false, refresh: vi.fn(),
    })
    const { container } = renderSheet()
    expect(screen.getByRole('region', { name: 'Active pools' })).toHaveTextContent("Dana's party")
    expect(screen.getByRole('region', { name: 'Finished pools' })).toHaveTextContent('Old trip')
    expect(screen.getByTestId('my-pools-action-close')).toHaveTextContent('Close & collect')
    expect(screen.getAllByTestId('my-pools-row')[0]).toHaveTextContent('Organizer')
    expect(await axe(container)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('button', { name: "Open Dana's party" }))
    expect(screen.getByTestId('loc')).toHaveTextContent(`/fund/${P1}`)
  })

  it('offers Collect refund directly on a refunding pool with an uncollected contribution', () => {
    useMyFundingPools.mockReturnValue({ items: [row({ state: 2, stateLabel: 'Refunding', nextAction: 'collect', role: 'contributor' })], loading: false, refresh: vi.fn() })
    renderSheet()
    expect(screen.getByTestId('my-pools-action-collect')).toHaveTextContent('Collect refund')
  })

  it('shows an unreadable row as unreadable with a retry, never as zeros', () => {
    const refresh = vi.fn()
    useMyFundingPools.mockReturnValue({ items: [{ address: P1, role: 'contributor', readable: false, bucket: 'active', nextAction: null }], loading: false, refresh })
    renderSheet()
    expect(screen.getByTestId('my-pools-row')).toHaveTextContent('Could not read')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refresh).toHaveBeenCalled()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('finds a pool by words or link, and reports a miss honestly', async () => {
    const resolveRef = vi.fn(async (ref) => (ref.words ? P2 : null))
    useFundingPools.mockReturnValue({ resolveRef })
    useMyFundingPools.mockReturnValue({ items: [], loading: false, refresh: vi.fn() })
    renderSheet()
    fireEvent.change(screen.getByTestId('my-pools-find'), { target: { value: 'not enough words' } })
    fireEvent.click(screen.getByTestId('my-pools-find-go'))
    expect(screen.getByTestId('my-pools-find-error')).toHaveTextContent(/four words/)
    fireEvent.change(screen.getByTestId('my-pools-find'), { target: { value: 'river amber tiger kite' } })
    fireEvent.click(screen.getByTestId('my-pools-find-go'))
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(`/fund/${P2}`))
    expect(resolveRef).toHaveBeenCalledWith({ words: ['river', 'amber', 'tiger', 'kite'] })
  })

  it('empty state points at starting a pool', () => {
    const onStartPool = vi.fn()
    useMyFundingPools.mockReturnValue({ items: [], loading: false, refresh: vi.fn() })
    renderSheet({ onStartPool })
    fireEvent.click(screen.getByRole('button', { name: 'Start a pool' }))
    expect(onStartPool).toHaveBeenCalled()
  })
})
