/**
 * Voucher buying must not offer — or submit — a tier the contract has switched off.
 *
 * `MembershipVoucher.mint` runs the same tier check the purchase does and reverts
 * `TierInactive()` (0x4ed1bf50) after the buyer's USDC approval, so an inactive tier is as much
 * a trap here as on the membership modal.
 *
 * The last case is the one review caught: hiding the tier radios is NOT enough on its own.
 * `selectedTier` keeps its BRONZE default when the offered list is empty, and the Buy button
 * lived outside the tier grid — so it stayed live and would have minted the very inactive tier
 * the filtering exists to avoid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const t = vi.hoisted(() => ({
  // Production's live config: Bronze/Platinum off, Silver/Gold on.
  active: { BRONZE: false, SILVER: true, GOLD: true, PLATINUM: false },
}))

vi.mock('../hooks/useWalletManagement', () => ({ useWallet: vi.fn() }))
vi.mock('../hooks/useVouchers', () => ({ useVouchers: vi.fn() }))
vi.mock('../hooks/useTierPrices', () => ({
  useTierPrices: () => ({
    getPrice: (_role, tier) => ({ BRONZE: 2, SILVER: 8, GOLD: 25, PLATINUM: 2 }[tier]),
    ROLE_HASHES: { WAGER_PARTICIPANT: '0xrole' },
    TIER_IDS: { BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 },
    isTierActive: (_role, tier) => t.active[tier],
  }),
}))

import { useWallet } from '../hooks/useWalletManagement'
import { useVouchers } from '../hooks/useVouchers'
import VouchersPage from '../pages/VouchersPage'

const mintVouchers = vi.fn()
const baseVouchers = {
  status: 'idle', error: null, lastTxHash: null,
  voucherAvailable: true, batchMintAvailable: true,
  mintVouchers,
  redeemVoucher: vi.fn(), transferVoucher: vi.fn(),
  listMyVouchers: vi.fn().mockResolvedValue([]), reset: vi.fn(),
}

const renderPage = () => render(<MemoryRouter><VouchersPage /></MemoryRouter>)
const buyButton = () => screen.getByRole('button', { name: /No tiers available|^Buy |^Gift /i })

beforeEach(() => {
  vi.clearAllMocks()
  t.active = { BRONZE: false, SILVER: true, GOLD: true, PLATINUM: false }
  useWallet.mockReturnValue({ account: '0x1111111111111111111111111111111111111111', isConnected: true })
  useVouchers.mockReturnValue(baseVouchers)
})

describe('VouchersPage — inactive tiers are not for sale', () => {
  it('lists only the tiers the contract has active', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Silver')).toBeInTheDocument())
    expect(screen.getByText('Gold')).toBeInTheDocument()
    expect(screen.queryByText('Bronze')).toBeNull()
    expect(screen.queryByText('Platinum')).toBeNull()
  })

  it('does not leave the hidden BRONZE default selected — it buys what is shown', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Silver')).toBeInTheDocument())
    // Same timing rule as the modal spec: the selection repair is an effect, so WAIT for the
    // label to name an offered tier rather than sampling it mid-transient.
    await waitFor(() => expect(buyButton().textContent).toMatch(/Silver/))
    expect(buyButton().textContent).not.toMatch(/Bronze/)
  })

  it('keeps UNREAD tiers listed — an RPC blip must not empty the shelf', async () => {
    t.active = { BRONZE: null, SILVER: null, GOLD: null, PLATINUM: null }
    renderPage()
    await waitFor(() => expect(screen.getByText('Bronze')).toBeInTheDocument())
    expect(screen.getByText('Platinum')).toBeInTheDocument()
  })

  it('BLOCKS the buy control when every tier is off — hiding the radios is not enough', async () => {
    t.active = { BRONZE: false, SILVER: false, GOLD: false, PLATINUM: false }
    renderPage()
    await waitFor(() => expect(screen.getByText(/No voucher tiers are on sale/i)).toBeInTheDocument())
    // The regression: the button sits OUTSIDE the tier grid, so an empty grid left it live with
    // selectedTier still BRONZE — one click from the TierInactive() revert this test guards.
    const btn = buyButton()
    expect(btn).toBeDisabled()
    // And it must not advertise a tier/price that is not on offer.
    expect(btn.textContent).toMatch(/No tiers available/i)
    expect(btn.textContent).not.toMatch(/Bronze/)
    expect(mintVouchers).not.toHaveBeenCalled()
  })
})
