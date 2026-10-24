/**
 * The purchase modal must not OFFER a tier the contract refuses (incident 2026-08-26).
 *
 * Production had Bronze and Platinum inactive; the modal listed all four and defaulted the
 * selection to Bronze, so the member's very first click was a purchase that reverts
 * `TierInactive()` after their USDC approval had landed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const m = vi.hoisted(() => ({
  tier: { tier: 0, tierName: 'None', readable: true },
  // The live Polygon configuration: Bronze/Platinum off, Silver/Gold on.
  active: { BRONZE: false, SILVER: true, GOLD: true, PLATINUM: false },
  started: [],
}))

vi.mock('../hooks/useWeb3', () => ({
  useWeb3: () => ({
    account: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    isConnected: true, isCorrectNetwork: true, switchNetwork: vi.fn(),
    chainId: m.chainId, loginMethod: 'wallet', sendCalls: vi.fn(), provider: {},
  }),
}))
vi.mock('../hooks/useRoles', () => ({ useRoles: () => ({ grantRole: vi.fn(), loadRoles: vi.fn() }) }))
vi.mock('../hooks/useUI', () => ({ useNotification: () => ({ showNotification: vi.fn() }) }))
vi.mock('../hooks/useTierPrices', () => ({
  useTierPrices: () => ({
    getPrice: (_role, tier) => ({ BRONZE: 2, SILVER: 8, GOLD: 25, PLATINUM: 2 }[tier]),
    getLimits: () => ({ monthly: 15, concurrent: 5 }),
    usingFallbackPrices: false,
    isTierActive: (_role, tier) => m.active[tier],
  }),
}))
vi.mock('../hooks/useEncryption', () => ({
  useEncryption: () => ({ ensureInitialized: vi.fn(), isInitialized: true }),
}))
// Spec 098: the modal resolves the acting account's write rail through the spec-043/088 seam,
// which reads the wallet context. These tests mount the modal in isolation (no WalletProvider),
// so stub the seam in personal mode — every one of these cases acts as the connected wallet.
vi.mock('../hooks/useActiveAccount', () => {
  const hook = () => ({ submit: vi.fn(), resolveActingSigner: vi.fn() })
  return { useActiveAccount: hook, default: hook }
})
vi.mock('../utils/blockchainService', async (orig) => ({
  ...(await orig()),
  getUserTierOnChain: () => Promise.resolve(m.tier),
}))
vi.mock('../hooks/usePurchaseFlow', () => {
  const flow = () => ({
    steps: [], status: 'idle', total: 0, completedCount: 0, activeIndex: -1, activeStep: null,
    progressFraction: 0, keyRegOutcome: null, canContinueAnyway: false, purchaseReceipt: null,
    start: (params) => { m.started.push(params); return Promise.resolve() },
    retry: vi.fn(), continueAnyway: vi.fn(), reset: vi.fn(),
  })
  return { usePurchaseFlow: flow, default: flow }
})

import PremiumPurchaseModal from '../components/ui/PremiumPurchaseModal'
import { membershipChainId } from '../config/networks'

const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
const radio = (tier) => document.querySelector(`input[type="radio"][value="${tier}"]`)

beforeEach(() => {
  m.chainId = membershipChainId()
  m.tier = { tier: 0, tierName: 'None', readable: true }
  m.active = { BRONZE: false, SILVER: true, GOLD: true, PLATINUM: false }
  m.started = []
})

describe('PremiumPurchaseModal — inactive tiers are not on sale', () => {
  it('hides the tiers the contract has switched off and keeps the rest', async () => {
    render(<PremiumPurchaseModal />)
    await waitFor(() => expect(radio('SILVER')).toBeTruthy())
    expect(radio('BRONZE'), 'Bronze is inactive on chain — offering it strands the member').toBeNull()
    expect(radio('PLATINUM'), 'Platinum is inactive on chain').toBeNull()
    expect(radio('GOLD')).toBeTruthy()
  })

  it('moves the default selection off the hidden tier (the default IS Bronze)', async () => {
    render(<PremiumPurchaseModal />)
    await waitFor(() => expect(radio('SILVER')).toBeTruthy())
    /*
     * WAIT for the selection, don't sample it: the repair runs in an effect AFTER the render that
     * first offers the tiers, so there is a transient frame where the still-selected BRONZE is not
     * in the DOM and nothing is checked. Sampling once passed locally and failed in CI. This still
     * fails if the repair never happens (the waitFor times out) or picks a hidden tier.
     */
    const checked = await waitFor(() => {
      const el = document.querySelector('input[type="radio"]:checked')
      if (!el) throw new Error('no tier is selected yet')
      return el
    })
    expect(['SILVER', 'GOLD']).toContain(checked.value)
  })

  it('an UNREAD tier stays offered — an RPC blip must not empty the grid', async () => {
    m.active = { BRONZE: null, SILVER: null, GOLD: null, PLATINUM: null }
    render(<PremiumPurchaseModal />)
    await waitFor(() => expect(radio('BRONZE')).toBeTruthy())
    expect(radio('PLATINUM')).toBeTruthy()
  })

  it('says nothing is on sale when every tier is off, instead of rendering blank', async () => {
    m.active = { BRONZE: false, SILVER: false, GOLD: false, PLATINUM: false }
    render(<PremiumPurchaseModal />)
    await waitFor(() => expect(screen.getByText(/No memberships are on sale/i)).toBeTruthy())
    expect(document.querySelector('input[type="radio"]')).toBeNull()
  })
})
