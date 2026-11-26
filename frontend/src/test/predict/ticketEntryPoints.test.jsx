/**
 * The ways INTO the order ticket (spec 114 slice 5): a card row and an event-page row hand the OUTCOME that was
 * pressed to `onOpenTicket` when the caller has the ticket, and fall back to `onOpen`/`onOpenRow` (the
 * fixed-price sheet) when it does not. The event page stands its readings down while `paused`.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import EventCard from '../../components/predict/EventCard'
import { FED } from '../fixtures/predictEvents'

describe('EventCard', () => {
  it('hands the PRESSED outcome to onOpenTicket and never to onOpen', () => {
    const onOpen = vi.fn()
    const onOpenTicket = vi.fn()
    render(<ul><EventCard event={FED} onOpen={onOpen} onOpenTicket={onOpenTicket} /></ul>)
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 94¢/ })[0])
    expect(onOpenTicket).toHaveBeenLastCalledWith(FED, FED.markets[0], FED.markets[0].outcomes[0])
    fireEvent.click(screen.getAllByRole('button', { name: /^No / })[0])
    expect(onOpenTicket).toHaveBeenLastCalledWith(FED, FED.markets[0], FED.markets[0].outcomes[1])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('without onOpenTicket (a legacy gateway) the row opens the sheet exactly as before', () => {
    const onOpen = vi.fn()
    render(<ul><EventCard event={FED} onOpen={onOpen} /></ul>)
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 94¢/ })[0])
    expect(onOpen).toHaveBeenCalledWith(FED, FED.markets[0])
  })
})
