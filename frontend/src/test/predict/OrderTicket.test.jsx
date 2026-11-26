/**
 * OrderTicket + OrderReview (spec 114 slice 5, User Story 4). The real plan hook and the real plan arithmetic
 * run here; only the layers beneath them are stubbed: the readings the feed would deliver, and the shared trade
 * hook (region/fee/signer gates), so the test can say what the gateway and the wallet would say.
 *
 * Book: asks 0.94×200, 0.95×1200, 0.96×12.5; bids 0.93×300, 0.92×5120; tick 0.01; minimum 5 shares.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { axe } from 'vitest-axe'
import OrderTicket from '../../components/predict/OrderTicket'
import { setBooksRouteMissing, __resetRouteSupportForTests } from '../../lib/markets/routeSupport'
import { readingKey } from '../../lib/predict/eventPage'
import { unknown } from '../../lib/markets/priceReading'
import { liquid, bookReading, TOKEN, NO_TOKEN } from './ticketFixtures'

const FEE = { feeRateBps: 100, builderTakerFeeBps: 50, builderMakerFeeBps: 0 }

const readings = { current: new Map() }
vi.mock('../../hooks/useMarketReadings', () => ({
  useMarketReadings: (keys) => new Map(keys.map((k) => [k, readings.current.get(k) ?? unknown('not-yet-read')])),
}))

const trade = { current: null }
vi.mock('../../hooks/usePredictTrade', () => ({ usePredictTrade: () => trade.current }))

const makeTrade = (over = {}) => ({
  status: 'ready',
  reason: null,
  geoInfo: null,
  fee: FEE,
  result: null,
  canTrade: true,
  signerKind: 'eoa',
  unsupportedReason: null,
  onWrongNetwork: false,
  tradingEnabled: true,
  loadFee: vi.fn(),
  preview: vi.fn(() => null),
  enableTrading: vi.fn().mockResolvedValue(true),
  signAndPost: vi.fn().mockResolvedValue({ orderId: '0x1' }),
  submit: vi.fn(),
  reset: vi.fn(),
  ...over,
})

const MARKET = { question: 'Will the Fed raise rates?', polymarketUrl: 'https://polymarket.com/event/fed', negRisk: false }
const OUTCOMES = [
  { name: 'Yes', tokenId: TOKEN, price: '0.94' },
  { name: 'No', tokenId: NO_TOKEN, price: '0.06' },
]

function setBook(reading, noReading = bookReading({ asks: [['0.07', '500']], bids: [['0.05', '500']], tokenId: NO_TOKEN, price: '0.06' })) {
  readings.current = new Map([
    [readingKey(TOKEN), reading],
    [readingKey(NO_TOKEN), noReading],
  ])
}

const renderTicket = (props = {}) =>
  render(
    <OrderTicket market={MARKET} outcomes={OUTCOMES} initialTokenId={TOKEN} mode="buy" tickSize="0.01" minOrderSize="5" onClose={() => {}} {...props} />,
  )

const type = (value, label = /amount to spend/i) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const dd = (testId) => screen.getByTestId(testId).textContent

beforeEach(() => {
  vi.clearAllMocks()
  __resetRouteSupportForTests()
  trade.current = makeTrade()
  setBook(liquid())
})
afterEach(() => __resetRouteSupportForTests())

describe('OrderTicket — the amount comes first', () => {
  it('starts EMPTY with no quick amount chosen and no figure (FR-028: no default that raises what is at risk)', () => {
    renderTicket()
    expect(screen.getByLabelText(/amount to spend/i)).toHaveValue('')
    for (const chip of within(screen.getByRole('group', { name: 'Quick amounts' })).getAllByRole('button')) {
      expect(chip).toHaveAttribute('aria-pressed', 'false')
    }
    expect(screen.queryByTestId('figure-average')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review order' })).toBeDisabled()
  })

  it('a real <label> names the input, which is a decimal text field', () => {
    renderTicket()
    const input = screen.getByLabelText(/amount to spend/i)
    expect(input).toHaveAttribute('inputmode', 'decimal')
    expect(input.tagName).toBe('INPUT')
  })

  it('typing an amount shows average price, shares, payout and the most you can lose, and they FOLLOW the amount', () => {
    renderTicket()
    type('50')
    expect(dd('figure-average')).toBe('94¢')
    expect(dd('figure-shares')).toMatch(/≈ 53\.19/)
    expect(dd('figure-payout')).toBe('$53.19')
    expect(dd('figure-max-loss')).toBe('$50.25')
    type('25')
    expect(dd('figure-shares')).toMatch(/≈ 26\.59/)
    expect(dd('figure-payout')).toBe('$26.59')
    expect(dd('figure-max-loss')).toBe('$25.13') // 25.00 + 0.125 builder fee, rounded UP to the cent
  })

  it('every fee is its own line; the builder fee is emphasised and the sentences are the ones TradeConfirm uses', () => {
    renderTicket()
    type('50')
    const fee = screen.getByText('FairWins builder fee')
    expect(fee.closest('div')).toHaveClass('order-ticket-fee-line')
    expect(fee.closest('div')).toHaveTextContent('+$0.25')
    expect(screen.getByText(/FairWins charges a 0\.50% builder fee on this trade, included above\. Polymarket also charges its own taker fee/)).toBeInTheDocument()
    expect(screen.getByText('Network fee: none — you sign, no gas')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/builder[^.]{0,40}\bfree\b/i)
  })

  it('a zero builder fee draws no fee line', () => {
    trade.current = makeTrade({ fee: { feeRateBps: 0, builderTakerFeeBps: 0, builderMakerFeeBps: 0 } })
    renderTicket()
    type('50')
    expect(screen.queryByText('FairWins builder fee')).toBeNull()
    expect(dd('figure-max-loss')).toBe('$50.00')
  })

  it('quick amounts fill the field; none is pre-selected; each press is deliberate', () => {
    renderTicket()
    fireEvent.click(screen.getByRole('button', { name: '$25' }))
    expect(screen.getByLabelText(/amount to spend/i)).toHaveValue('25')
    expect(screen.getByRole('button', { name: '$25' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '$50' })).toHaveAttribute('aria-pressed', 'false')
    expect(dd('figure-payout')).toBe('$26.59')
  })

  it('what is typed can only be what is signed: digits, one dot, two decimals', () => {
    renderTicket()
    type('1a2.3456.7')
    expect(screen.getByLabelText(/amount to spend/i)).toHaveValue('12.34')
  })
})

describe('OrderTicket — what an order would do to the book, said plainly (FR-028)', () => {
  it('near certainty (average price at or above 90¢): dollars at risk beside dollars to gain', () => {
    renderTicket()
    type('50')
    expect(screen.getByText('You put $50.25 at risk to gain $2.94.')).toBeInTheDocument()
  })

  it('no such sentence below 90¢', () => {
    setBook(bookReading({ asks: [['0.50', '5000']], bids: [['0.49', '5000']] }))
    renderTicket()
    type('50')
    expect(dd('figure-average')).toBe('50¢')
    expect(screen.queryByText(/at risk to gain/)).toBeNull()
  })

  it('the share of visible depth it takes, once that is 10% or more', () => {
    renderTicket()
    type('20')
    expect(screen.queryByText(/of what is on offer/)).toBeNull()
    type('150')
    expect(screen.getByText('This takes about 11% of what is on offer at these prices.')).toBeInTheDocument()
  })

  it('more than the visible depth: says how much CAN be filled', () => {
    renderTicket()
    type('2000')
    expect(screen.getByText('Only $1,340.00 of this can be filled at the prices shown.')).toBeInTheDocument()
  })

  it('refusals are sentences, never reason codes', () => {
    renderTicket()
    type('1')
    expect(screen.getByText('The smallest order here is 5 shares (about $4.70).')).toBeInTheDocument()
    type('0')
    expect(screen.getByText(/rounds to nothing/i)).toBeInTheDocument()
  })

  it('an empty side', () => {
    setBook(bookReading({ bids: [['0.4', '10']] }))
    renderTicket()
    type('50')
    expect(screen.getByText('Nothing is on offer on this side right now.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/no-depth|below-minimum|invalid-|price-not-live/)
    expect(screen.getByRole('button', { name: 'Review order' })).toBeDisabled()
  })

  it('nonsense typed in a way the field allows (a lone dot)', () => {
    renderTicket()
    type('.')
    expect(screen.getByText(/Enter an amount like 25/)).toBeInTheDocument()
  })
})

describe('OrderTicket — a price that is not live (FR-013)', () => {
  it.each([
    ['delayed', liquid({ age: 6000 })],
    ['last known', liquid({ age: 31000 })],
    ['unread', unknown('not-yet-read')],
  ])('%s: waiting for a current price, NO figure, Review disabled — even with an amount typed', (_n, reading) => {
    setBook(reading)
    renderTicket()
    type('50')
    expect(screen.getByText(/Waiting for a current price…/)).toBeInTheDocument()
    expect(screen.queryByTestId('figure-average')).toBeNull()
    expect(screen.queryByTestId('figure-shares')).toBeNull()
    expect(screen.queryByTestId('figure-payout')).toBeNull()
    expect(screen.queryByTestId('figure-max-loss')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review order' })).toBeDisabled()
  })

  it('never strands: while the price is not current the venue itself is one link away', () => {
    setBook(unknown('not-yet-read'))
    renderTicket()
    expect(screen.getByRole('link', { name: /trade on Polymarket instead/i })).toHaveAttribute('href', MARKET.polymarketUrl)
  })

  it('says how old the last price is', () => {
    setBook(liquid({ age: 6000 }))
    renderTicket()
    expect(screen.getByText(/The last one was confirmed \d+ s ago/)).toBeInTheDocument()
  })
})

describe('OrderTicket — outcome and side', () => {
  it('shows each side\'s price, Yes then No, and switching changes the order', () => {
    renderTicket()
    const group = screen.getByRole('group', { name: 'Outcome' })
    const [yes, no] = within(group).getAllByRole('button')
    expect(yes).toHaveTextContent('Yes 94¢')
    expect(no).toHaveTextContent('No 6¢')
    expect(yes).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(no)
    expect(no).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('dialog', { name: /Buy No — Will the Fed raise rates\?/ })).toBeInTheDocument()
  })

  it('sell (from a position): shares, a Max button from the position, proceeds not payout, no "most you can lose"', () => {
    renderTicket({ outcomes: [OUTCOMES[0]], mode: 'sell', position: { size: '100.456789' } })
    expect(screen.queryByRole('group', { name: 'Outcome' })).toBeNull()
    expect(screen.getByText(/You hold 100\.45 shares/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Max' }))
    expect(screen.getByLabelText(/shares to sell/i)).toHaveValue('100.45')
    expect(dd('figure-average')).toBe('93¢')
    expect(dd('figure-payout')).toBe('$92.95') // 100.45 × 93¢ = 93.41, less the 0.5% builder fee, rounded DOWN
    expect(screen.getByText(/You receive about/)).toBeInTheDocument()
    expect(screen.queryByText('The most you can lose')).toBeNull()
    expect(screen.queryByRole('button', { name: '$25' })).toBeNull()
  })
})

describe('OrderTicket — Set my own price (rests, FR-019)', () => {
  it('is collapsed and UNMOUNTED until opened', () => {
    renderTicket()
    expect(screen.queryByLabelText(/your price, in cents/i)).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Set my own price' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByLabelText(/your price, in cents/i)).toBeInTheDocument()
  })

  it('a price on the grid plans a resting order and says it rests and may never fill', () => {
    renderTicket()
    type('50')
    fireEvent.click(screen.getByRole('button', { name: 'Set my own price' }))
    fireEvent.change(screen.getByLabelText(/your price, in cents/i), { target: { value: '57' } })
    expect(dd('figure-average')).toBe('57¢')
    expect(dd('figure-shares')).toMatch(/87\.71/)
    expect(screen.getAllByText(/rests on Polymarket’s book until it is filled or you cancel it, and it may never fill/).length).toBeGreaterThan(0)
  })

  it('a price off the tick grid is refused in words, never silently changed', () => {
    renderTicket()
    type('50')
    fireEvent.click(screen.getByRole('button', { name: 'Set my own price' }))
    fireEvent.change(screen.getByLabelText(/your price, in cents/i), { target: { value: '57.5' } })
    expect(screen.getByText(/move in steps of 1¢/)).toBeInTheDocument()
    expect(screen.queryByTestId('figure-average')).toBeNull()
    expect(screen.getByLabelText(/your price, in cents/i)).toHaveValue('57.5')
  })
})

describe('OrderReview — the step before the signature', () => {
  const toReview = (amount = '50') => {
    renderTicket()
    type(amount)
    fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
  }

  it('Review is a separate step: nothing is signed, and the limit price is named with what it guarantees', () => {
    toReview()
    expect(screen.getByRole('heading', { name: 'Review your order' })).toBeInTheDocument()
    expect(screen.getByText('Nothing has been signed yet.')).toBeInTheDocument()
    expect(dd('review-pay')).toBe('$50.00')
    expect(dd('review-max-loss')).toBe('$50.25')
    expect(screen.getByText(/You get about/).nextSibling).toHaveTextContent('53.19 Yes shares')
    expect(screen.getByText('If you are right').nextSibling).toHaveTextContent('$53.19')
    expect(screen.getByText('If you are wrong').nextSibling).toHaveTextContent('$0.00')
    expect(screen.getByText(/Price limit: 95¢/)).toBeInTheDocument()
    expect(screen.getByText(/cannot fill above 95¢ a share\. Whatever is not filled is cancelled and not charged\./)).toBeInTheDocument()
    expect(screen.getByText('FairWins never holds your funds or your key. The order goes to Polymarket; the outcome is decided there.')).toBeInTheDocument()
    expect(screen.getByText('FairWins builder fee').closest('div')).toHaveTextContent('+$0.25')
    expect(trade.current.signAndPost).not.toHaveBeenCalled()
    expect(trade.current.enableTrading).not.toHaveBeenCalled()
  })

  it('the review cannot be skipped: there is no Sign on the ticket itself', () => {
    renderTicket()
    type('50')
    expect(screen.queryByRole('button', { name: /^Sign/ })).toBeNull()
  })

  it('Edit returns to the ticket with the amount kept; still nothing signed', () => {
    toReview()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText(/amount to spend/i)).toHaveValue('50')
    expect(trade.current.signAndPost).not.toHaveBeenCalled()
  })

  it('Sign asks the shared trade hook to sign — exactly once', async () => {
    toReview()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign buy (no gas)' }))
    })
    expect(trade.current.signAndPost).toHaveBeenCalledTimes(1)
  })

  it('MOVED at Sign: the new figures and a notice, nothing signed, and Sign needs another press (FR-021)', async () => {
    const { rerender } = render(
      <OrderTicket market={MARKET} outcomes={OUTCOMES} initialTokenId={TOKEN} mode="buy" tickSize="0.01" minOrderSize="5" onClose={() => {}} />,
    )
    type('50')
    fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
    expect(screen.getByText(/Price limit: 95¢/)).toBeInTheDocument()
    setBook(bookReading({ asks: [['0.97', '1000']], bids: [['0.96', '10']] }))
    rerender(<OrderTicket market={MARKET} outcomes={OUTCOMES} initialTokenId={TOKEN} mode="buy" tickSize="0.01" minOrderSize="5" onClose={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign buy (no gas)' }))
    })
    expect(trade.current.signAndPost).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/The price moved after you reviewed it, so nothing was signed/)
    expect(screen.getByText(/Price limit: 98¢/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign buy (no gas)' })).toBeEnabled()
  })

  it('a named price: the review says the order rests, may never fill, and is not charged until it does', () => {
    renderTicket()
    type('50')
    fireEvent.click(screen.getByRole('button', { name: 'Set my own price' }))
    fireEvent.change(screen.getByLabelText(/your price, in cents/i), { target: { value: '57' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
    expect(screen.getByText(/Your price: 57¢\./)).toBeInTheDocument()
    expect(screen.getByText(/rests on Polymarket’s book until it is filled or you cancel it, and it may never fill/)).toBeInTheDocument()
    expect(dd('review-pay')).toBe('$49.9947') // exactly what is signed: 87.71 shares at 57¢
    expect(screen.getByRole('button', { name: 'Sign and place order (no gas)' })).toBeInTheDocument()
  })

  it('a partial fill is signed for what can be filled and the review says the order is smaller than what was typed', () => {
    toReview('2000')
    expect(dd('review-pay')).toBe('$1,340.00')
    expect(screen.getByText(/This order is for \$1,340\.00/)).toBeInTheDocument()
  })

  it('a sell: shares and proceeds, and a limit BELOW which it cannot fill', () => {
    renderTicket({ outcomes: [OUTCOMES[0]], mode: 'sell', position: { size: '100' } })
    type('100', /shares to sell/i)
    fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
    expect(screen.getByText(/Price limit: 92¢/)).toBeInTheDocument()
    expect(screen.getByText(/cannot fill below 92¢/)).toBeInTheDocument()
    expect(dd('review-pay')).toMatch(/100 Yes shares/)
    expect(screen.getByRole('button', { name: 'Sign sell (no gas)' })).toBeInTheDocument()
  })

  it('first trade and wrong-network notes are the shared sentences', () => {
    trade.current = makeTrade({ tradingEnabled: false, onWrongNetwork: true, signerKind: 'passkey' })
    toReview()
    expect(screen.getByText(/First trade only: you’ll confirm one transaction/)).toBeInTheDocument()
    expect(screen.getByText("You'll be asked to switch your wallet to Polygon before signing.")).toBeInTheDocument()
  })
})

describe('OrderTicket — gates, as today', () => {
  it('fee not confirmed: blocked with the reason and a retry — no form, no figures', () => {
    trade.current = makeTrade({ status: 'blocked', reason: "Couldn't confirm the fees — try again before trading.", fee: null })
    renderTicket()
    expect(screen.getByRole('alert')).toHaveTextContent(/confirm the fees/i)
    expect(screen.queryByLabelText(/amount to spend/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('restricted region: the honest notice and the link out, before any fee', () => {
    trade.current = makeTrade({ status: 'geoblocked', geoInfo: { country: 'US' }, fee: null })
    renderTicket()
    expect(screen.getByRole('alert')).toHaveTextContent(/isn't available in your region \(US\)\. Polymarket sets this restriction/)
    expect(screen.getByRole('link', { name: /Trade on Polymarket/ })).toHaveAttribute('href', MARKET.polymarketUrl)
    expect(screen.queryByLabelText(/amount to spend/i)).toBeNull()
  })

  it('an error keeps the never-stranded path and a way back', () => {
    trade.current = makeTrade({ status: 'error', reason: 'The order could not be submitted.' })
    renderTicket()
    expect(screen.getByRole('alert')).toHaveTextContent('The order could not be submitted.')
    expect(screen.getByRole('link', { name: /Trade on Polymarket instead/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to the ticket' })).toBeInTheDocument()
  })

  it('done never says "bought" or "filled": it says what the venue answered and not to send it again', () => {
    trade.current = makeTrade({ status: 'done', result: { kind: 'submitted', orderId: '0x1', status: 'matched' } })
    renderTicket()
    expect(screen.getByRole('status')).toHaveTextContent(/Order sent to Polymarket — the venue answered “matched”\. Matching and settlement happen there/)
    expect(document.body.textContent).not.toMatch(/you bought|order filled|congrat/i)
  })

  it('no confetti, no countdown: nothing on the surface is time-boxed', () => {
    renderTicket()
    type('50')
    expect(document.body.textContent).not.toMatch(/hurry|expires in|only \d+ left|last chance|streak/i)
  })
})

describe('OrderTicket — never stranded (FR-029)', () => {
  it('a gateway with no books route: renders the fixed-price confirm for the same outcome', () => {
    setBooksRouteMissing(true)
    renderTicket({ initialTokenId: NO_TOKEN })
    expect(screen.getByLabelText(/Number of No shares to buy/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/amount to spend/i)).toBeNull()
  })

  it('a position sell falls back the same way, in SELL mode', () => {
    setBooksRouteMissing(true)
    renderTicket({ outcomes: [OUTCOMES[0]], mode: 'sell', position: { size: '10' } })
    expect(screen.getByLabelText(/Number of Yes shares to sell/i)).toBeInTheDocument()
  })
})

describe('OrderTicket — dialog and accessibility', () => {
  it('is a modal dialog named by its title, focused on open, closed by Escape and by the scrim', () => {
    const onClose = vi.fn()
    renderTicket({ onClose })
    const dialog = screen.getByRole('dialog', { name: /Buy Yes — Will the Fed raise rates\?/ })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('moves focus to the step heading when the review opens', () => {
    renderTicket()
    type('50')
    fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
    expect(screen.getByRole('heading', { name: 'Review your order' })).toHaveFocus()
  })

  it('has no axe violations: empty ticket, ticket with figures, waiting, and review', async () => {
    const empty = renderTicket()
    expect(await axe(empty.container)).toHaveNoViolations()
    type('50')
    expect(await axe(empty.container)).toHaveNoViolations()
    fireEvent.click(screen.getByRole('button', { name: 'Review order' }))
    expect(await axe(empty.container)).toHaveNoViolations()
    empty.unmount()
    setBook(liquid({ age: 6000 }))
    const waiting = renderTicket()
    type('50')
    expect(await axe(waiting.container)).toHaveNoViolations()
  })
})
