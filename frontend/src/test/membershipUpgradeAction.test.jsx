/**
 * #1226 — the contract call is decided by the member's membership, not by how the modal opened.
 *
 * MembershipManager refuses `purchaseTier` for anyone already active (AlreadyActive, L279).
 * The Membership tab's "Renew / Upgrade" opened PremiumPurchaseModal with no `action`, which
 * defaulted to 'purchase' — so the one control shown ONLY to active members always sent them
 * down the one path that could not succeed, after their USDC approval had already landed.
 *
 * These assert the routing decision at its narrowest point: the `action` handed to
 * usePurchaseFlow, which selects between purchaseTier / upgradeTier / extendTier.
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

// Capture what the flow is asked to do. This is the seam that picks the contract function
// (usePurchaseFlow: `action === 'upgrade' ? upgradeTx : action === 'extend' ? extendTx : purchaseTx`).
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
  // The list is populated from an async on-chain read of the member's current tier.
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
  // The review step gates the confirm on EVERY attestation, not one acknowledgement.
  screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb))
  const confirm = screen.getByRole('button', { name: /^Confirm Purchase/i })
  expect(confirm).not.toBeDisabled()
  fireEvent.click(confirm)
  await waitFor(() => expect(m.started.length).toBeGreaterThan(0))
  return m.started[m.started.length - 1].action
}

beforeEach(() => {
  m.chainId = membershipChainId()
  m.tier = { tier: 0, tierName: 'None', readable: true }
  m.started = []
})

describe('#1226 — an active member is never routed through purchaseTier', () => {
  it('upgrades when the member holds a lower tier and picks a higher one', async () => {
    m.tier = { tier: 1, tierName: 'Bronze', readable: true }
    // No `action` prop: this is the Membership tab's combined "Renew / Upgrade" entry.
    expect(await purchaseAs('Silver')).toBe('upgrade')
  })

  it('extends when the member picks the tier they already hold', async () => {
    m.tier = { tier: 1, tierName: 'Bronze', readable: true }
    expect(await purchaseAs('Bronze')).toBe('extend')
  })

  it('purchases when there is no membership to preserve', async () => {
    m.tier = { tier: 0, tierName: 'None', readable: true }
    expect(await purchaseAs('Bronze')).toBe('purchase')
  })

  it('still honours an explicit action from a caller that knows which it wants', async () => {
    // WalletButton's role card opens 'upgrade'/'extend' deliberately; deriving must not
    // second-guess a caller that already decided.
    m.tier = { tier: 1, tierName: 'Bronze', readable: true }
    expect(await purchaseAs('Silver', { action: 'upgrade' })).toBe('upgrade')
  })
})

describe('the combined entry offers both renew and upgrade', () => {
  it('lists the current tier alongside the higher ones', async () => {
    m.tier = { tier: 1, tierName: 'Bronze', readable: true }
    render(<PremiumPurchaseModal />)
    // Renewing at the same tier has to be reachable, or the button's own label is a lie.
    expect(await tierRadio('Bronze')).toBeTruthy()
    expect(await tierRadio('Silver')).toBeTruthy()
  })

  it('offers only higher tiers to a caller that asked for an upgrade', async () => {
    m.tier = { tier: 1, tierName: 'Bronze', readable: true }
    render(<PremiumPurchaseModal action="upgrade" />)
    expect(await tierRadio('Silver')).toBeTruthy()
    expect(document.querySelector('input[type="radio"][value="BRONZE"]')).toBeNull()
  })
})
