/**
 * Expired-member renewal is not a dead-end.
 *
 * RoleDetailsCard's "Renew" / "Renew Access" CTA renders off the raw STORED tier (which
 * persists past expiry) and opens PremiumPurchaseModal with action='extend'. The modal,
 * however, reads the ACTIVE tier (`getActiveTier`), which returns 0 for an expired
 * membership — and the same-tier filter (`tier.id >= userCurrentTier && userCurrentTier > 0`)
 * then offered NOTHING: no tier cards, no explanatory card, Continue disabled. The member the
 * Renew button exists for could not proceed, even though on-chain `purchaseTier` succeeds for
 * an expired member at any tier (AlreadyActive guards only an UNexpired membership).
 *
 * These assert the fix: an 'extend' entry at active tier 0 falls back to the purchase-mode
 * offering (all tiers, Continue enabled, an honest "expired" explainer) and routes the confirm
 * through 'purchase' — the one action that succeeds on-chain for an expired member. Unexpired
 * extend behaviour must be untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const m = vi.hoisted(() => ({
  tier: { tier: 0, tierName: 'None', readable: true },
  started: [],
}))

// The Review step now mounts the FR-021 device-loss warning (issue #1405), which reads the
// session through usePasskeyAccount → useWallet. These suites are about purchase ROUTING, so the
// session here is a classic wallet and the warning renders nothing; its own three-moment coverage
// lives in src/test/passkey/deviceLossWarning.test.jsx.
vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: () => ({
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    chainId: 137,
    loginMethod: 'wallet',
    isConnected: true,
    provider: null,
  }),
}))
vi.mock('../hooks/useWeb3', () => ({
  useWeb3: () => ({
    account: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    isConnected: true,
    isCorrectNetwork: true,
    switchNetwork: vi.fn(),
    chainId: m.chainId,
    loginMethod: 'wallet',
    sendCalls: vi.fn(),
    provider: {},
  }),
}))
vi.mock('../hooks/useRoles', () => ({
  useRoles: () => ({ grantRole: vi.fn(), loadRoles: vi.fn() }),
}))
vi.mock('../hooks/useUI', () => ({ useNotification: () => ({ showNotification: vi.fn() }) }))
vi.mock('../hooks/useTierPrices', () => ({
  useTierPrices: () => ({
    getPrice: () => 2,
    getLimits: () => ({ monthly: 15, concurrent: 5 }),
    usingFallbackPrices: false,
    // Every tier active — these specs are about the expiry path, not tier availability.
    isTierActive: () => true,
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

// Capture what the flow is asked to do — the seam that picks the contract function
// (usePurchaseFlow: purchaseTier / upgradeTier / extendMembership).
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

/** The tier picker renders radios inside labels, one per offered tier. */
async function tierRadio(tierName) {
  // The list is populated from an async on-chain read of the member's current (active) tier.
  return waitFor(() => {
    const radio = document.querySelector(`input[type="radio"][value="${tierName.toUpperCase()}"]`)
    if (!radio) throw new Error(`tier ${tierName} is not offered`)
    return radio
  })
}

/** Walk the modal: pick `tierName`, acknowledge, confirm. Returns the action the flow got. */
async function purchaseAs(tierName, props = {}) {
  render(<PremiumPurchaseModal {...props} />)
  fireEvent.click(await tierRadio(tierName))
  fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }))
  screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb))
  const confirm = screen.getByRole('button', { name: /^Confirm Purchase/i })
  expect(confirm).not.toBeDisabled()
  fireEvent.click(confirm)
  await waitFor(() => expect(m.started.length).toBeGreaterThan(0))
  return m.started[m.started.length - 1].action
}

beforeEach(() => {
  m.chainId = membershipChainId()
  // Expired membership as the MODAL sees it: getActiveTier answers 0 (the stored tier — say,
  // Silver — persists on-chain, but this modal never reads it; the Renew CTA did).
  m.tier = { tier: 0, tierName: 'None', readable: true }
  m.started = []
})

describe("the expired-member Renew entry (action='extend', active tier 0)", () => {
  it('offers every tier instead of a dead-end', async () => {
    render(<PremiumPurchaseModal action="extend" />)
    expect(await tierRadio('Bronze')).toBeTruthy()
    expect(await tierRadio('Silver')).toBeTruthy()
    expect(await tierRadio('Gold')).toBeTruthy()
    expect(await tierRadio('Platinum')).toBeTruthy()
  })

  it('enables Continue once the tiers are offered', async () => {
    render(<PremiumPurchaseModal action="extend" />)
    await tierRadio('Bronze')
    expect(screen.getByRole('button', { name: /^Continue$/i })).not.toBeDisabled()
  })

  it('explains the expired state instead of showing four unexplained tier cards', async () => {
    render(<PremiumPurchaseModal action="extend" />)
    await tierRadio('Bronze')
    expect(screen.getAllByText(/Your membership has expired/i).length).toBeGreaterThan(0)
  })

  it("routes the confirm through 'purchase' — the call that succeeds on-chain when expired", async () => {
    // purchaseTier reverts AlreadyActive only while UNexpired; upgradeTier reverts
    // NoActiveMembership once expired. 'purchase' is the only correct routing here.
    expect(await purchaseAs('Gold', { action: 'extend' })).toBe('purchase')
  })
})

describe('unexpired extend behaviour is unchanged', () => {
  it('still offers only the current tier and up', async () => {
    m.tier = { tier: 2, tierName: 'Silver', readable: true }
    render(<PremiumPurchaseModal action="extend" />)
    expect(await tierRadio('Silver')).toBeTruthy()
    expect(await tierRadio('Gold')).toBeTruthy()
    expect(document.querySelector('input[type="radio"][value="BRONZE"]')).toBeNull()
  })

  it("still routes a same-tier selection through 'extend'", async () => {
    m.tier = { tier: 2, tierName: 'Silver', readable: true }
    expect(await purchaseAs('Silver', { action: 'extend' })).toBe('extend')
  })

  it('does not show the expired explainer to an active member', async () => {
    m.tier = { tier: 2, tierName: 'Silver', readable: true }
    render(<PremiumPurchaseModal action="extend" />)
    await tierRadio('Silver')
    expect(screen.queryByText(/Your membership has expired/i)).toBeNull()
  })
})

describe('an unreadable tier is still not treated as expired (FR-004/FR-005)', () => {
  it('offers a retry, not the renewal fallback', async () => {
    m.tier = { tier: 0, tierName: 'Unknown', readable: false, reason: 'rpc down' }
    render(<PremiumPurchaseModal action="extend" />)
    await waitFor(() => {
      expect(screen.getByText(/could not be read/i)).toBeTruthy()
    })
    // Unknown is not "no membership": no expired copy, no purchase-mode tier grid.
    expect(screen.queryByText(/Your membership has expired/i)).toBeNull()
    expect(document.querySelector('input[type="radio"]')).toBeNull()
  })
})
