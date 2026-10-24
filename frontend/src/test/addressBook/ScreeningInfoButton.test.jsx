import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import ScreeningInfoButton from '../../components/ui/ScreeningInfoButton'

describe('ScreeningInfoButton (iteration 2)', () => {
  it('toggles an explanation of how screening works', async () => {
    const user = userEvent.setup()
    render(<ScreeningInfoButton />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'How address screening works' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveTextContent(/Every list, every network/i)
    expect(dialog).toHaveTextContent(/Green means all of them answered clear/i)
    expect(dialog).toHaveTextContent(/Advisory only/i)
    expect(dialog).toHaveTextContent(/on-chain guard/i)
    expect(dialog).toHaveTextContent(/Fails closed/i)
  })

  it('links to the address-book guide', async () => {
    const user = userEvent.setup()
    render(<ScreeningInfoButton />)
    await user.click(screen.getByRole('button', { name: 'How address screening works' }))
    const link = screen.getByRole('link', { name: /Address Book.*screening guide/i })
    expect(link).toHaveAttribute('href', expect.stringContaining('address-book'))
  })

  it('has no accessibility violations when open', async () => {
    const user = userEvent.setup()
    const { container } = render(<ScreeningInfoButton />)
    await user.click(screen.getByRole('button', { name: 'How address screening works' }))
    expect(await axe(container)).toHaveNoViolations()
  })
})
