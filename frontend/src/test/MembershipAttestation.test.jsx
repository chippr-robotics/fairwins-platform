import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MembershipAttestation from '../components/compliance/MembershipAttestation'
import { ATTESTATIONS } from '../components/compliance/attestations'

describe('MembershipAttestation (T043)', () => {
  it('renders all required attestations un-ticked by default', () => {
    render(<MembershipAttestation onChange={() => {}} />)
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(ATTESTATIONS.length)
    boxes.forEach((b) => expect(b).not.toBeChecked())
  })

  it('reports allTicked=false until every box is ticked, then true', () => {
    const onChange = vi.fn()
    render(<MembershipAttestation onChange={onChange} />)
    expect(onChange).toHaveBeenLastCalledWith(false) // initial

    const boxes = screen.getAllByRole('checkbox')
    boxes.slice(0, -1).forEach((b) => fireEvent.click(b))
    expect(onChange).toHaveBeenLastCalledWith(false) // one still unticked

    fireEvent.click(boxes[boxes.length - 1])
    expect(onChange).toHaveBeenLastCalledWith(true) // all ticked
  })

  it('flips back to false if a box is un-ticked', () => {
    const onChange = vi.fn()
    render(<MembershipAttestation onChange={onChange} />)
    const boxes = screen.getAllByRole('checkbox')
    boxes.forEach((b) => fireEvent.click(b))
    expect(onChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(boxes[0])
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('states the membership-is-a-fee-only / non-refundable copy (FR-038)', () => {
    render(<MembershipAttestation onChange={() => {}} />)
    expect(screen.getByText(/fee for\s*access only/i)).toBeInTheDocument()
    expect(screen.getByText(/non-refundable/i)).toBeInTheDocument()
    expect(screen.getByText(/no claim on any pool of funds/i)).toBeInTheDocument()
  })

  it('covers the required eligibility/risk attestations (FR-037)', () => {
    render(<MembershipAttestation onChange={() => {}} />)
    expect(screen.getByText(/at least 21 years/i)).toBeInTheDocument()
    expect(screen.getByText(/not located, resident, or established in any Restricted Jurisdiction/i)).toBeInTheDocument()
    expect(screen.getByText(/OFAC SDN/i)).toBeInTheDocument()
    expect(screen.getByText(/no regulator or authority/i)).toBeInTheDocument()
    expect(screen.getByText(/VPN, proxy/i)).toBeInTheDocument()
  })

  it('links the Terms & Conditions and Risk Disclosure for review (Spec 010 — FR-001)', () => {
    render(<MembershipAttestation onChange={() => {}} />)
    expect(screen.getByRole('link', { name: /Terms & Conditions/i })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: /Risk Disclosure/i })).toHaveAttribute('href', '/risk')
  })
})
