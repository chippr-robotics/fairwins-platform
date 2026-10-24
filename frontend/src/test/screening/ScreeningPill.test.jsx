import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'
import ScreeningPill from '../../components/ui/ScreeningPill'
import { VERDICTS } from '../../lib/screening/verdict'

const reading = (chainId, label, status, extra = {}) => ({
  id: `${label}:${chainId}`, kind: 'k', label, chainId, address: '0x1', status, ...extra,
})
const result = (verdict, readings, chainIds, uncovered = []) => ({
  address: '0x098B716B8Aaf21512996dC57EB0615e2383E2f96', chainIds, readings, uncovered, verdict, readAt: 1,
})

describe('ScreeningPill', () => {
  it('renders a loading state that is a status, not a button', () => {
    render(<ScreeningPill result={null} loading />)
    expect(screen.getByRole('status')).toHaveTextContent('Screening…')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says the verdict in words for every state', () => {
    const cases = [
      [VERDICTS.SCREENED, 'Screened clear'],
      [VERDICTS.FLAGGED, 'Flagged'],
      [VERDICTS.PARTIAL, 'Partly screened'],
      [VERDICTS.UNSCREENED, 'Unscreened'],
    ]
    for (const [v, label] of cases) {
      const { unmount } = render(<ScreeningPill result={result(v, [], [])} />)
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('data-verdict', v)
      unmount()
    }
  })

  it('expands to name every source per network with its answer, the reason it gave none, and the networks with no source', () => {
    const r = result(
      VERDICTS.FLAGGED,
      [
        reading(137, 'FairWins sanctions guard', 'read', { flagged: false, detail: null }),
        reading(137, 'Circle USDC freeze list', 'read', { flagged: true, detail: 'frozen by Circle' }),
        reading(1, 'Chainalysis sanctions oracle', 'unreadable', { reason: 'no answer within 8s' }),
      ],
      [137, 1, 61],
      [61],
    )
    render(<ScreeningPill result={r} chainId={137} />)
    const btn = screen.getByRole('button', { name: 'Flagged' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('list')
    expect(list).toHaveTextContent('Polygon (this network)')
    expect(list).toHaveTextContent('FairWins sanctions guard')
    expect(list).toHaveTextContent('Clear')
    expect(list).toHaveTextContent('Flagged — frozen by Circle')
    expect(list).toHaveTextContent('Could not read — no answer within 8s')
    expect(list).toHaveTextContent('Ethereum Classic')
    expect(list).toHaveTextContent('No screening source on this network')
  })

  it('has no accessibility violations open or closed', async () => {
    const r = result(VERDICTS.PARTIAL, [reading(1, 'x', 'unreadable', { reason: 'down' })], [1])
    const { container } = render(<ScreeningPill result={r} />)
    expect(await axe(container)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('button'))
    expect(await axe(container)).toHaveNoViolations()
  })
})
