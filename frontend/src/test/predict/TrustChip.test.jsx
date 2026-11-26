import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import TrustChip from '../../components/predict/TrustChip'
import { classify, unknown } from '../../lib/markets/priceReading'
import { stamp } from '../../lib/markets/serverClock'

const S = stamp({ confirmedAt: '2026-11-26T02:10:00.000Z', serverNow: '2026-11-26T02:10:00.000Z' }, 0)
const at = (age) => classify({ price: '0.5', bids: [], asks: [], stamp: S }, age)

describe('TrustChip', () => {
  it('Live', () => {
    const { container } = render(<TrustChip reading={at(1000)} />)
    expect(screen.getByRole('status')).toHaveTextContent('Prices are live')
    expect(container.querySelector('[aria-hidden="true"]:not(.predict-trust-dot)').textContent).toBe('Live')
  })

  it('Delayed carries its age in an aria-hidden span; the name does not', () => {
    const { container } = render(<TrustChip state="delayed" ageMs={14000} />)
    expect(screen.getByRole('status').textContent).toContain('Delayed · 14 s')
    expect(container.querySelector('.predict-trust-dot')).toHaveAttribute('aria-hidden', 'true')
    const hidden = [...container.querySelectorAll('[aria-hidden="true"]')].map((e) => e.textContent)
    expect(hidden).toContain('Delayed · 14 s')
    expect(container.querySelector('.predict-trust-sr').textContent).toBe('Prices are delayed')
  })

  it('the stable name does not change with the age tick, only with the state', () => {
    const { container, rerender } = render(<TrustChip state="delayed" ageMs={7000} />)
    const sr = () => container.querySelector('.predict-trust-sr').textContent
    const first = sr()
    rerender(<TrustChip state="delayed" ageMs={20000} />)
    expect(sr()).toBe(first)
    rerender(<TrustChip state="last-known" ageMs={120000} />)
    expect(sr()).toBe('Showing the last known prices')
    expect(container.textContent).toContain('Last known · 2 min')
  })

  it('Unavailable for an unknown reading, with no age', () => {
    const { container } = render(<TrustChip reading={unknown('unreadable')} />)
    expect(container.textContent).toContain('Unavailable')
    expect(container.textContent).not.toMatch(/\d+ (s|min|h)/)
  })

  it('prints no age under a second: "Delayed · 0 s" would contradict itself (a demoted list price confirmed this second)', () => {
    const { container } = render(<TrustChip state="delayed" ageMs={300} />)
    expect(container.textContent).toContain('Delayed')
    expect(container.textContent).not.toMatch(/0 s/)
  })

  it('accepts state + ageMs directly', () => {
    const { container } = render(<TrustChip state="delayed" ageMs={48000} />)
    expect(container.textContent).toContain('Delayed · 48 s')
  })

  it('an unrecognised state reads as Unavailable, never live', () => {
    const { container } = render(<TrustChip state="bogus" />)
    expect(container.textContent).toContain('Unavailable')
  })

  it('has no axe violations in any state', async () => {
    for (const r of [at(1000), at(14000), at(120000), unknown('x')]) {
      const { container, unmount } = render(<TrustChip reading={r} />)
      expect((await axe(container)).violations).toEqual([])
      unmount()
    }
  })
})
