import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'
import EventCard from '../../components/predict/EventCard'
import { formatPercent, formatVolume, formatCents } from '../../lib/predict/format'
import { FED, RAIN, mkEvent, mkRow } from '../fixtures/predictEvents'

const renderCard = (event, props = {}) =>
  render(
    <ul>
      <EventCard event={event} onOpen={vi.fn()} {...props} />
    </ul>,
  )

describe('EventCard', () => {
  it('renders a multi-market event as ONE card with its rows and "+N more"', () => {
    const { container } = renderCard(FED)
    expect(container.querySelectorAll('.event-card')).toHaveLength(1)
    expect(screen.getAllByRole('listitem').filter((li) => li.classList.contains('event-card-row'))).toHaveLength(4)
    expect(screen.getByText('25 bps increase')).toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.getByText('Economy')).toBeInTheDocument()
  })

  it('shows whole percents, "<1%" below one, and "—" (never 0%) for a null displayPrice', () => {
    renderCard(FED)
    const rows = Array.from(document.querySelectorAll('.event-card-row'))
    const pct = (i) => rows[i].querySelector('.event-card-pct').textContent
    expect(pct(0)).toBe('94%')
    expect(pct(1)).toBe('5%')
    expect(pct(2)).toBe('<1%')
    expect(pct(3)).toBe('—')
    expect(document.body.textContent).not.toMatch(/\b0%/)
    expect(formatPercent(null)).toBe('—')
  })

  it('renders Yes/No prices in cents and disables a side whose price is null', () => {
    const ev = mkEvent({
      markets: [mkRow({ outcomes: [{ name: 'Yes', tokenId: '1', price: '0.94' }, { name: 'No', tokenId: '2', price: null }] })],
    })
    renderCard(ev)
    expect(screen.getByRole('button', { name: /^Yes 94¢/ })).toBeEnabled()
    const no = screen.getByRole('button', { name: /^No — \(price unavailable\)/ })
    expect(no).toBeDisabled()
    expect(no).toHaveTextContent('No —')
    expect(formatCents('0.002')).toBe('<1¢')
  })

  it('prints the volume compactly and the closing day; omits both when null', () => {
    const { unmount } = renderCard(FED)
    expect(screen.getByText('$61.6M traded')).toBeInTheDocument()
    expect(screen.getByText(/^closes Dec \d+$/)).toBeInTheDocument()
    unmount()
    renderCard(RAIN)
    expect(document.body.textContent).not.toMatch(/\$|traded|closes/)
    expect(formatVolume(null)).toBeNull()
    expect(formatVolume('1500')).toBe('$1.5K')
  })

  it('puts movement in accessible text as well as a hidden glyph', () => {
    renderCard(FED, { directions: { '0xf1': 'up', '0xf2': 'down' } })
    const first = document.querySelectorAll('.event-card-row')[0]
    expect(first.querySelector('.event-card-move')).toHaveAttribute('aria-hidden', 'true')
    expect(first).toHaveTextContent('up since the last update')
    expect(document.querySelectorAll('.event-card-row')[1]).toHaveTextContent('down since the last update')
    // No movement known => no glyph and no words.
    expect(document.querySelectorAll('.event-card-row')[2].querySelector('.event-card-move')).toBeNull()
  })

  it('labels a single-market event by its outcomes rather than repeating the title', () => {
    renderCard(RAIN)
    const row = document.querySelector('.event-card-row')
    expect(within(row).getByText('Yes / No')).toBeInTheDocument()
    expect(within(row).queryByText('Will it rain in London tomorrow?')).toBeNull()
  })

  it('never frames independent rows as a whole (no stacked bar, no total)', () => {
    const { container } = renderCard({ ...FED, mutuallyExclusive: false })
    expect(container.querySelector('[class*="bar"], progress, meter')).toBeNull()
    expect(container.textContent).not.toMatch(/100%/)
  })

  it('opens the first tradable row from the title and the chosen row from a side button', () => {
    const onOpen = vi.fn()
    renderCard(FED, { onOpen })
    fireEvent.click(screen.getByRole('button', { name: 'Fed Decision in December?' }))
    expect(onOpen).toHaveBeenLastCalledWith(FED, FED.markets[0])
    fireEvent.click(screen.getAllByRole('button', { name: /^No 7¢, No change/ })[0])
    expect(onOpen).toHaveBeenLastCalledWith(FED, FED.markets[1])
  })

  it('labels an event in play with the venue\'s own score and period, as plain text', () => {
    renderCard(mkEvent({ live: { score: '91-101', period: 'Q4', elapsed: '06:47' }, marketCount: 1 }))
    const label = document.querySelector('.event-card-live')
    expect(label).toHaveTextContent('In play · 91-101 · Q4')
    // Text only: nothing animated, no countdown (the elapsed clock is not shown).
    expect(label.children).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/06:47/)
  })

  it('says only "In play" when the venue gave no score or period, and nothing for an event that is not in play', () => {
    const { unmount } = renderCard(mkEvent({ live: { score: null, period: null, elapsed: null } }))
    expect(document.querySelector('.event-card-live')).toHaveTextContent(/^In play$/)
    unmount()
    renderCard(mkEvent({ live: null }))
    expect(document.querySelector('.event-card-live')).toBeNull()
    expect(document.body.textContent).not.toMatch(/In play/)
  })

  it('has no axe violations', async () => {
    const { container } = renderCard(FED, { directions: { '0xf1': 'up' } })
    expect(await axe(container)).toHaveNoViolations()
  })
})
