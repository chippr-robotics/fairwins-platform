import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { VERDICTS } from '../../lib/screening/verdict'

const A1 = '0x1111111111111111111111111111111111111111'

let estate = { status: 'idle', result: null }
vi.mock('../../hooks/useEstateScreening', () => ({
  useEstateScreening: () => estate,
}))

import AddressScreenNotice from '../../components/ui/AddressScreenNotice'

const reading = (chainId, label, flagged) => ({
  id: `${label}:${chainId}`, kind: 'k', label, chainId, address: '0x1', status: 'read', flagged, detail: flagged ? 'listed' : null,
})
const done = (verdict, readings, uncovered = []) => ({
  status: 'done',
  result: { address: A1, chainIds: [137, 1], readings, uncovered, verdict, readAt: 1 },
})

describe('AddressScreenNotice (issue #1458 — estate-wide)', () => {
  beforeEach(() => {
    estate = { status: 'idle', result: null }
  })

  it('renders nothing for an empty/invalid address', () => {
    const { container } = render(<AddressScreenNotice address="" chainId={137} />)
    expect(container).toBeEmptyDOMElement()
    const { container: c2 } = render(<AddressScreenNotice address="0x1234" chainId={137} />)
    expect(c2).toBeEmptyDOMElement()
  })

  it('shows a loading pill while the sweep runs — never a stale verdict', () => {
    estate = { status: 'loading', result: null }
    render(<AddressScreenNotice address={A1} chainId={137} />)
    expect(screen.getByText('Screening…')).toBeInTheDocument()
    expect(screen.queryByText('Screened clear')).toBeNull()
  })

  it('renders a GREEN pill for a clear address — and says what that rests on', () => {
    estate = done(VERDICTS.SCREENED, [reading(137, 'FairWins sanctions guard', false), reading(1, 'Chainalysis sanctions oracle', false)])
    render(<AddressScreenNotice address={A1} chainId={137} />)
    expect(screen.getByRole('button', { name: 'Screened clear' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('All 2 lists on 2 networks answered clear.')
  })

  it('alerts when any list flags the address, naming the list and network', () => {
    estate = done(VERDICTS.FLAGGED, [reading(137, 'FairWins sanctions guard', false), reading(1, 'Circle USDC freeze list', true)])
    render(<AddressScreenNotice address={A1} chainId={137} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('flagged by sanctions screening')
    expect(alert).toHaveTextContent('Circle USDC freeze list on Ethereum')
    expect(alert).toHaveAttribute('data-screen-verdict', 'flagged')
  })

  it('is amber, not green, when a source could not be read', () => {
    estate = done(VERDICTS.PARTIAL, [
      reading(137, 'FairWins sanctions guard', false),
      { id: 'o:1', kind: 'k', label: 'Chainalysis sanctions oracle', chainId: 1, address: '0x1', status: 'unreadable', reason: 'timed out' },
    ])
    render(<AddressScreenNotice address={A1} chainId={137} />)
    expect(screen.getByRole('button', { name: 'Partly screened' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 lists answered clear; 1 could not be read — not a clean bill.')
    // The names of the missing sources are NOT in the summary any more (issue #1458 QA round);
    // they live in the pill's expansion, which is where someone who asks will look.
    expect(screen.getByRole('status')).not.toHaveTextContent('Chainalysis sanctions oracle')
  })

  it('says Unscreened when nothing could be asked', () => {
    estate = done(VERDICTS.UNSCREENED, [], [61])
    render(<AddressScreenNotice address={A1} chainId={61} />)
    expect(screen.getByRole('button', { name: 'Unscreened' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No screening source covers Ethereum Classic')
  })

  it('draws one bar segment per source asked, coloured by its answer', () => {
    estate = done(VERDICTS.PARTIAL, [
      reading(137, 'FairWins sanctions guard', false),
      reading(1, 'Chainalysis sanctions oracle', true),
      { id: 'u:1', kind: 'k', label: 'Circle USDC freeze list', chainId: 1, address: '0x1', status: 'unreadable', reason: 'timed out' },
    ])
    const { container } = render(<AddressScreenNotice address={A1} chainId={137} />)
    expect(container.querySelectorAll('.screen-bar-seg')).toHaveLength(3)
    expect(container.querySelectorAll('.screen-bar-seg-clear')).toHaveLength(1)
    expect(container.querySelectorAll('.screen-bar-seg-flagged')).toHaveLength(1)
    expect(container.querySelectorAll('.screen-bar-seg-unreadable')).toHaveLength(1)
    // The bar is never the only carrier of the fact (WCAG 1.4.1): it is one labelled image.
    expect(container.querySelector('.screen-bar')).toHaveAttribute('role', 'img')
  })

  it('does not put the explainer tooltip inside the notice', () => {
    // It opened a bubble taller than a phone, clipped by the scrolling modal it sat in (QA round).
    // The address book header keeps the ⓘ; an address field does not need one.
    estate = done(VERDICTS.SCREENED, [reading(137, 'FairWins sanctions guard', false)])
    render(<AddressScreenNotice address={A1} chainId={137} />)
    expect(screen.queryByRole('button', { name: 'How address screening works' })).toBeNull()
  })

  it('has no accessibility violations', async () => {
    estate = done(VERDICTS.FLAGGED, [reading(1, 'Chainalysis sanctions oracle', true)])
    const { container } = render(<AddressScreenNotice address={A1} chainId={137} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
