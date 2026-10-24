import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import Footer from '../components/Footer'
import { LEGAL_LINKS } from '../constants/legalLinks'
import appSource from '../App.jsx?raw'

/**
 * Spec 010 (US2 — FR-005/006/007/008/009, SC-002/004/005).
 */
describe('Footer', () => {
  it('condensed variant: legal links in-app + current-year copyright, no marketing columns', () => {
    const { container } = render(<Footer variant="condensed" />)
    const footer = container.querySelector('footer')
    expect(footer).toBeTruthy()

    // every legal link present and pointing at an in-app route
    for (const { label, href } of LEGAL_LINKS) {
      const link = within(footer).getByRole('link', { name: new RegExp(label, 'i') })
      expect(link).toHaveAttribute('href', href)
      expect(href.startsWith('/')).toBe(true)
    }
    // Account Moderation deep-links into Terms
    expect(within(footer).getByRole('link', { name: /Account Moderation/i }))
      .toHaveAttribute('href', '/terms#account-moderation')

    // current, dynamic year — never the stale 2024
    const year = new Date().getFullYear()
    expect(footer.textContent).toContain(String(year))
    expect(footer.textContent).not.toContain('2024')

    // condensed omits the landing marketing columns
    expect(screen.queryByText('Polymarket')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Community/i })).not.toBeInTheDocument()
  })

  it('full variant: keeps marketing columns AND adds the legal links', () => {
    render(<Footer variant="full" />)
    expect(screen.getByText('Polymarket')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^Legal$/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Privacy Policy/i })).toHaveAttribute('href', '/privacy')
    const year = new Date().getFullYear()
    expect(screen.getByText(new RegExp(`${year}.*ChipprRobotics`))).toBeInTheDocument()
  })

  it('defaults to the full variant', () => {
    render(<Footer />)
    expect(screen.getByText('Polymarket')).toBeInTheDocument()
  })

  it('drawer variant: copyright only, no legal/policy links (issue #1025)', () => {
    const { container } = render(<Footer variant="drawer" />)
    const footer = container.querySelector('footer')
    expect(footer).toBeTruthy()
    expect(footer).toHaveClass('app-footer--drawer')

    for (const { label } of LEGAL_LINKS) {
      expect(within(footer).queryByRole('link', { name: new RegExp(label, 'i') })).not.toBeInTheDocument()
    }

    const year = new Date().getFullYear()
    expect(footer.textContent).toContain(String(year))
  })

  it('is wired into the in-app layout as the condensed variant (FR-005)', () => {
    expect(appSource).toContain('<Footer variant="condensed" />')
  })
})
