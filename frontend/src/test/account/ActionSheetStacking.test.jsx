// Spec 111 SIG-03 found the deferred-signing ceremony (spec 088) rendering UNDER the sheet that
// asked for it. Two guarantees pin the fix: the ceremony tier is a distinct, higher layer, and only
// the TOP sheet answers the keyboard when two are open.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ActionSheet from '../../components/account/ActionSheet'

describe('ActionSheet stacking', () => {
  it('marks a ceremony sheet with the ceremony tier, and leaves ordinary sheets alone', () => {
    render(
      <>
        <ActionSheet open onClose={() => {}} title="Sign a message">body</ActionSheet>
        <ActionSheet open onClose={() => {}} title="Connect your device" tier="ceremony">ceremony</ActionSheet>
      </>,
    )
    const [sheet, ceremony] = screen.getAllByRole('dialog').map((d) => d.parentElement)
    expect(sheet).not.toHaveClass('action-sheet__backdrop--ceremony')
    expect(ceremony).toHaveClass('action-sheet__backdrop--ceremony')
  })

  it('Escape closes only the top sheet', () => {
    const closeLower = vi.fn()
    const closeTop = vi.fn()
    render(
      <>
        <ActionSheet open onClose={closeLower} title="Sign a message">body</ActionSheet>
        <ActionSheet open onClose={closeTop} title="Connect your device" tier="ceremony">ceremony</ActionSheet>
      </>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeTop).toHaveBeenCalledTimes(1)
    expect(closeLower).not.toHaveBeenCalled()
  })

  it('the lower sheet answers again once the top one closes', () => {
    const closeLower = vi.fn()
    const { rerender } = render(
      <>
        <ActionSheet open onClose={closeLower} title="Sign a message">body</ActionSheet>
        <ActionSheet open onClose={() => {}} title="Connect your device" tier="ceremony">ceremony</ActionSheet>
      </>,
    )
    rerender(
      <>
        <ActionSheet open onClose={closeLower} title="Sign a message">body</ActionSheet>
        <ActionSheet open={false} onClose={() => {}} title="Connect your device" tier="ceremony">ceremony</ActionSheet>
      </>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closeLower).toHaveBeenCalledTimes(1)
  })
})
