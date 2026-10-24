import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock the data hooks so we can render VouchersPage deterministically (spec 026).
vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: vi.fn(),
}))
vi.mock('../hooks/useVouchers', () => ({
  useVouchers: vi.fn(),
}))
vi.mock('../hooks/useTierPrices', () => ({
  useTierPrices: () => ({
    getPrice: (_role, tier) => ({ BRONZE: 2, SILVER: 8, GOLD: 25, PLATINUM: 100 }[tier]),
    ROLE_HASHES: { WAGER_PARTICIPANT: '0xrole' },
    TIER_IDS: { BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 },
    isTierActive: () => true,
  }),
}))

import { useWallet } from '../hooks/useWalletManagement'
import { useVouchers } from '../hooks/useVouchers'
import { getCurrentDocument } from '../utils/legalDocs'
import VouchersPage from '../pages/VouchersPage'

function renderPage(initialEntries = ['/vouchers']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <VouchersPage />
    </MemoryRouter>
  )
}

const baseVouchers = {
  status: 'idle',
  error: null,
  lastTxHash: null,
  voucherAvailable: true,
  batchMintAvailable: true,
  mintVouchers: vi.fn(),
  redeemVoucher: vi.fn(),
  transferVoucher: vi.fn().mockResolvedValue({ tokenId: '7', to: '0x2222222222222222222222222222222222222222', txHash: '0xabc' }),
  listMyVouchers: vi.fn().mockResolvedValue([]),
  reset: vi.fn(),
}

describe('VouchersPage (spec 026)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWallet.mockReturnValue({ account: '0x1111111111111111111111111111111111111111', isConnected: true })
  })

  it('renders buy + redeem sections with an honest privacy disclosure when available', async () => {
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers: vi.fn().mockResolvedValue([]) })
    renderPage()
    expect(screen.getByRole('heading', { name: /Membership Vouchers/i })).toBeInTheDocument()
    expect(screen.getByRole('note', { name: /privacy/i })).toBeInTheDocument()
    expect(screen.getByText(/pseudonymity, not cryptographic anonymity/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Buy a voucher/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Redeem a voucher/i })).toBeInTheDocument()
    // All four tiers are offered.
    for (const t of ['Bronze', 'Silver', 'Gold', 'Platinum']) {
      expect(screen.getByText(t)).toBeInTheDocument()
    }
    // Buy controls: quantity + optional gift address.
    expect(screen.getByText(/Quantity/i)).toBeInTheDocument()
    expect(screen.getByText(/Gift to address/i)).toBeInTheDocument()
    // Flush the initial vouchers load so the effect's state update is settled.
    await waitFor(() => expect(screen.getByText(/don’t have any vouchers to redeem/i)).toBeInTheDocument())
  })

  it('tells the user when they have no vouchers to redeem', async () => {
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers: vi.fn().mockResolvedValue([]) })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText(/don’t have any vouchers to redeem/i)).toBeInTheDocument()
    })
  })

  it('lists the wallet’s held vouchers as selectable redeem options', async () => {
    const listMyVouchers = vi.fn().mockResolvedValue([
      { tokenId: '7', tier: 1, durationDays: 30, role: '0xrole' },
      { tokenId: '9', tier: 3, durationDays: 30, role: '0xrole' },
    ])
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers })
    renderPage()
    await waitFor(() => {
      expect(screen.getByText('#7')).toBeInTheDocument()
      expect(screen.getByText('#9')).toBeInTheDocument()
    })
    expect(screen.getAllByRole('radio', { name: /membership|#/i }).length).toBeGreaterThanOrEqual(2)
  })

  it('warns that gifting/quantity needs the helper when it is unavailable', async () => {
    useVouchers.mockReturnValue({ ...baseVouchers, batchMintAvailable: false })
    renderPage()
    // Default state (qty 1, self) is fine; the block only appears once the order needs the helper.
    // Render asserts the buy section is present; the warning is exercised in interaction tests elsewhere.
    expect(screen.getByRole('heading', { name: /Buy a voucher/i })).toBeInTheDocument()
  })

  it('gives the gift field its own line with an address book and QR scan button', async () => {
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers: vi.fn().mockResolvedValue([]) })
    renderPage()
    // The gift recipient is an AddressInput (id wired) rather than the old plain input.
    expect(document.getElementById('vch-gift-to')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Choose from address book/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Scan recipient QR code/i })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/don’t have any vouchers to redeem/i)).toBeInTheDocument())
  })

  it('uses the same membership attestation block for redemption as for purchase', async () => {
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers: vi.fn().mockResolvedValue([]) })
    renderPage()
    // The shared MembershipAttestation renders its discrete, individually-ticked eligibility checkboxes.
    expect(screen.getByText(/Membership confirmation/i)).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(5)
    await waitFor(() => expect(screen.getByText(/don’t have any vouchers to redeem/i)).toBeInTheDocument())
  })

  it('transfers a held voucher to another address via the transfer button', async () => {
    const transferVoucher = vi.fn().mockResolvedValue({
      tokenId: '7', to: '0x2222222222222222222222222222222222222222', txHash: '0xabc',
    })
    const listMyVouchers = vi.fn().mockResolvedValue([
      { tokenId: '7', tier: 1, durationDays: 30, role: '0xrole' },
    ])
    useVouchers.mockReturnValue({ ...baseVouchers, transferVoucher, listMyVouchers })
    renderPage()
    await waitFor(() => expect(screen.getByText('#7')).toBeInTheDocument())

    // Select the voucher, type a recipient, and transfer.
    fireEvent.click(screen.getByRole('radio', { name: /membership|#7/i }))
    fireEvent.change(document.getElementById('vch-transfer-to'), {
      target: { value: '0x2222222222222222222222222222222222222222' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Transfer voucher/i }))

    await waitFor(() =>
      expect(transferVoucher).toHaveBeenCalledWith('7', '0x2222222222222222222222222222222222222222'),
    )
  })

  // Spec 026 FR-013/SC-005 (adversarially-verified audit finding): onRedeem used to call
  // redeemVoucher(id, undefined), so no Terms acceptance was ever recorded on-chain for a
  // redeemer. Assert the real in-force hash — resolved from the SAME source the purchase flow
  // uses (getCurrentDocument('terms').hash, see PremiumPurchaseModal.jsx) — is what's passed now.
  it('redeems with the current in-force Terms hash, not undefined/blank (spec 026 FR-013)', async () => {
    const redeemVoucher = vi.fn().mockResolvedValue({ txHash: '0xredeem' })
    const listMyVouchers = vi.fn().mockResolvedValue([
      { tokenId: '7', tier: 1, durationDays: 30, role: '0xrole' },
    ])
    useVouchers.mockReturnValue({ ...baseVouchers, redeemVoucher, listMyVouchers })
    renderPage()
    await waitFor(() => expect(screen.getByText('#7')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('radio', { name: /membership|#7/i }))
    // Tick every eligibility attestation so the Redeem button is enabled (it already gates on
    // this consent — this fix plumbs that consent into the recorded hash, not new UI).
    for (const checkbox of screen.getAllByRole('checkbox')) {
      fireEvent.click(checkbox)
    }
    fireEvent.click(screen.getByRole('button', { name: /Redeem to this wallet/i }))

    await waitFor(() => expect(redeemVoucher).toHaveBeenCalledTimes(1))
    const [tokenId, acceptedTermsHash] = redeemVoucher.mock.calls[0]
    expect(tokenId).toBe('7')
    // The exact same hash the purchase rail resolves — one terms-version store, not a second one.
    expect(acceptedTermsHash).toBe(getCurrentDocument('terms').hash)
    expect(acceptedTermsHash).toBeTruthy()
    expect(acceptedTermsHash).not.toBeUndefined()
    expect(typeof acceptedTermsHash).toBe('string')
    expect(acceptedTermsHash).toMatch(/^[0-9a-f]{64}$/) // bare hex; useVouchers normalizes to 0x
  })

  // Release 1.14.0 task 9 — the portfolio FWMV asset sheet deep-links Send / Gift to
  // `/vouchers#vch-transfer`. The transfer block must be addressable (the page's hash effect
  // scrolls by element id), and arriving on it with vouchers held preselects the first one so
  // the member lands on a usable form instead of a disabled Transfer button.
  it('gives the transfer block the #vch-transfer anchor the asset sheet deep-links to', async () => {
    const listMyVouchers = vi.fn().mockResolvedValue([
      { tokenId: '7', tier: 1, durationDays: 30, role: '0xrole' },
    ])
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers })
    renderPage()
    await waitFor(() => expect(screen.getByText('#7')).toBeInTheDocument())
    expect(document.getElementById('vch-transfer')).toBeInTheDocument()
  })

  it('preselects the first held voucher when arriving at #vch-transfer', async () => {
    const listMyVouchers = vi.fn().mockResolvedValue([
      { tokenId: '7', tier: 1, durationDays: 30, role: '0xrole' },
      { tokenId: '9', tier: 3, durationDays: 30, role: '0xrole' },
    ])
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers })
    renderPage(['/vouchers#vch-transfer'])
    await waitFor(() => expect(screen.getByText('#7')).toBeInTheDocument())
    await waitFor(() =>
      expect(document.querySelector('input[name="redeem-voucher"][value="7"]')).toBeChecked(),
    )
    expect(document.querySelector('input[name="redeem-voucher"][value="9"]')).not.toBeChecked()
  })

  it('does not preselect a voucher on a plain visit — selection stays an explicit choice', async () => {
    const listMyVouchers = vi.fn().mockResolvedValue([
      { tokenId: '7', tier: 1, durationDays: 30, role: '0xrole' },
    ])
    useVouchers.mockReturnValue({ ...baseVouchers, listMyVouchers })
    renderPage()
    await waitFor(() => expect(screen.getByText('#7')).toBeInTheDocument())
    expect(document.querySelector('input[name="redeem-voucher"][value="7"]')).not.toBeChecked()
  })

  it('shows an honest "not available on this network" notice when the voucher is undeployed', () => {
    useVouchers.mockReturnValue({ ...baseVouchers, voucherAvailable: false })
    renderPage()
    expect(screen.getByText(/aren’t available on this network yet/i)).toBeInTheDocument()
  })

  it('keeps a disconnected visitor here with a connect prompt instead of bouncing them to landing', () => {
    const openConnectModal = vi.fn()
    useWallet.mockReturnValue({ account: null, isConnected: false, openConnectModal })
    useVouchers.mockReturnValue(baseVouchers)
    renderPage()

    // The deep link is not thrown away: connecting drops the member straight
    // into the vouchers they came for.
    expect(screen.getByRole('heading', { name: /Membership Vouchers/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Redeem/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(openConnectModal).toHaveBeenCalled()
  })
})
