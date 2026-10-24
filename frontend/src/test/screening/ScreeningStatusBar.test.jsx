import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'vitest-axe'

vi.mock('../../lib/screening/sources', () => ({
  screeningChainIds: () => [137, 1],
  screeningSourcesFor: (id) => (id === 137 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }]),
}))

import ScreeningStatusBar from '../../components/ui/ScreeningStatusBar'

const reading = (id, status, flagged = false) => ({
  id, kind: 'k', label: `source ${id}`, chainId: 137, address: '0x1', status, flagged, reason: 'down',
})

describe('ScreeningStatusBar', () => {
  it('draws one segment per reading, in its answered state', () => {
    const result = {
      readings: [reading('a', 'read'), reading('b', 'read', true), reading('c', 'unreadable')],
    }
    const { container } = render(<ScreeningStatusBar result={result} label="summary" />)
    expect(container.querySelectorAll('.screen-bar-seg')).toHaveLength(3)
    expect(container.querySelectorAll('.screen-bar-seg-clear')).toHaveLength(1)
    expect(container.querySelectorAll('.screen-bar-seg-flagged')).toHaveLength(1)
    expect(container.querySelectorAll('.screen-bar-seg-unreadable')).toHaveLength(1)
  })

  it('shows the number of lists this build WILL ask while the sweep runs', () => {
    // Configuration is a fact available synchronously; the answers are not. The pending bar
    // reports the first without pretending to know the second.
    const { container } = render(<ScreeningStatusBar loading result={null} label="Screening…" />)
    expect(container.querySelectorAll('.screen-bar-seg-pending')).toHaveLength(3)
    expect(container.querySelectorAll('.screen-bar-seg-clear')).toHaveLength(0)
  })

  it('carries the summary as its accessible name rather than a run of empty spans', async () => {
    const result = { readings: [reading('a', 'read')] }
    const { container } = render(<ScreeningStatusBar result={result} label="All 1 list answered clear." />)
    const bar = container.querySelector('.screen-bar')
    expect(bar).toHaveAttribute('role', 'img')
    expect(bar).toHaveAttribute('aria-label', 'All 1 list answered clear.')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<ScreeningStatusBar result={{ readings: [] }} label="" />)
    expect(container).toBeEmptyDOMElement()
  })
})
