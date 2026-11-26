/**
 * OrderProgress (spec 114 slice 6) — states in words, the current step marked in TEXT, the right live-region
 * role per state, and — the point of FR-024 — an unconfirmed order is never a failure and never offers to be
 * sent again. "Matched" is the venue's word; "settled" is claimed only for a settled record.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'
import OrderProgress from '../../components/predict/OrderProgress'
import { stateSentence } from '../../lib/predict/orderWords'
import { newRecord } from '../../lib/predict/orderProgress'

const rec = (state, over = {}) => ({ ...newRecord({ tokenId: '1', side: 'BUY', kind: 'resting', size: '10', sizeUnit: 'shares', limitPrice: '0.4', label: 'Buy Yes — Will it rain?', orderId: `0x${state}` }), state, ...over })

describe('OrderProgress', () => {
  it('renders nothing with no orders', () => {
    const { container } = render(<OrderProgress orders={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('marks the current step in text and with aria-current, earlier steps done, later ones unmarked', () => {
    render(<OrderProgress orders={[rec('partial', { filledSize: '4' })]} />)
    const steps = screen.getAllByRole('listitem').filter((li) => li.className.includes('order-progress-step'))
    const current = steps.filter((li) => li.getAttribute('aria-current') === 'step')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('Partly matched (current step)')
    expect(steps[0]).toHaveTextContent('Sent to Polymarket (done)')
    expect(steps[4]).toHaveTextContent(/^Settled on chain$/)
    expect(screen.getByText(/Partly matched: 4 shares so far/)).toBeInTheDocument()
  })

  it('matched stops at matched and says settlement happens on chain — it does not claim settled', () => {
    render(<OrderProgress orders={[rec('matched', { filledSize: '10' })]} />)
    expect(screen.getByText(/Matched by Polymarket: 10 shares\. Settlement happens on the blockchain/)).toBeInTheDocument()
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('Matched by Polymarket (current step)')
    expect(document.body).not.toHaveTextContent(/Settled on chain \((current|done)/)
  })

  it('every sentence: no "filled/bought/settled" claim unless the state says so', () => {
    for (const s of ['signed', 'sent', 'resting', 'unconfirmed']) {
      expect(stateSentence(rec(s))).not.toMatch(/\b(filled|bought|sold|settled|complete)\b/i)
    }
    expect(stateSentence(rec('settled'))).toBe('Settled on chain.')
  })

  it('UNCONFIRMED: a polite status, not an alert; never "failed"; no send-again control; says not to resend', () => {
    render(<OrderProgress orders={[rec('unconfirmed')]} />)
    expect(screen.getByText(/Do not send it again/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/Not confirmed yet/).closest('[role="status"]')).not.toBeNull()
    expect(screen.queryByText(/fail|error|rejected/i)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull() // not even Dismiss
    for (const word of [/send again/i, /resubmit/i, /retry/i, /try again/i, /place again/i]) {
      expect(screen.queryByRole('button', { name: word })).toBeNull()
      expect(screen.queryByRole('link', { name: word })).toBeNull()
    }
    expect(screen.getByRole('link', { name: /Check on Polymarket/ })).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('an unconfirmed order with no way to look it up says so, and still offers nothing to resend', () => {
    render(<OrderProgress orders={[rec('unconfirmed', { idKnown: false })]} />)
    expect(screen.getByText(/could not work out how to look it up/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('endings that need attention are alerts; ordinary endings are polite status', () => {
    for (const s of ['rejected', 'not-delivered', 'failed']) {
      const { unmount } = render(<OrderProgress orders={[rec(s, { reason: 'because' })]} />)
      expect(screen.getByRole('alert')).toBeInTheDocument()
      unmount()
    }
    for (const s of ['cancelled', 'expired', 'resting', 'sent']) {
      const { unmount } = render(<OrderProgress orders={[rec(s)]} />)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
      unmount()
    }
  })

  it('cancelled keeps what matched; the ending is named', () => {
    render(<OrderProgress orders={[rec('cancelled', { filledSize: '3' })]} />)
    expect(screen.getByText('Cancelled', { selector: 'p.order-progress-ending' })).toBeInTheDocument()
    expect(screen.getByText(/3 shares had matched before it ended and still settle/)).toBeInTheDocument()
  })

  it('Dismiss exists for endings only, and calls back with the id', () => {
    const onDismiss = vi.fn()
    render(<OrderProgress orders={[rec('cancelled'), rec('resting', { orderId: '0xr' })]} onDismiss={onDismiss} />)
    const buttons = screen.getAllByRole('button', { name: 'Dismiss' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(onDismiss).toHaveBeenCalledWith('0xcancelled')
  })

  it('locked: asks the member to sign in to trading, and does not itself ask for a signature', () => {
    render(<OrderProgress orders={[rec('resting')]} locked />)
    expect(screen.getByText(/Sign in to trading to see where your orders are/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign|enable/i })).toBeNull()
  })

  it('unreadable: says the last report is what is shown', () => {
    render(<OrderProgress orders={[rec('resting')]} unreadable />)
    expect(screen.getByText(/Couldn.t reach Polymarket just now/)).toBeInTheDocument()
  })

  it('has no axe violations across every state', async () => {
    const all = ['signed', 'sent', 'resting', 'partial', 'matched', 'settled', 'cancelled', 'expired', 'rejected', 'unconfirmed', 'not-delivered', 'failed'].map((s) => rec(s))
    const { container } = render(<OrderProgress orders={all} onDismiss={() => {}} />)
    expect((await axe(container)).violations).toEqual([])
  })
})
