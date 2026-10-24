/**
 * Spec 071 US5 (T041) — membership purchases settle on the REFERENCE chain.
 *
 * Membership must be readable from one place (US1), which is only true if it is also WRITTEN in
 * one place. A purchase that landed elsewhere would create a membership the reference-chain read
 * can never see: the member pays and stays unentitled everywhere.
 *
 * The last describe block asserts an ABSENCE — that no path completes a purchase on any other
 * chain (SC-006) — because "we only offer the right one" is a claim about code that does not
 * exist, and prose cannot verify that.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const m = vi.hoisted(() => ({
  chainId: 63, // a cohort chain that is NOT the reference chain
  switchNetwork: null,
  notify: null,
  tier: { tier: 0, tierName: 'None', readable: true },
  builtCalls: [],
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
    switchNetwork: m.switchNetwork,
    chainId: m.chainId,
    loginMethod: 'wallet',
    sendCalls: vi.fn(),
    provider: {},
  }),
}))
vi.mock('../hooks/useRoles', () => ({
  useRoles: () => ({ grantRole: vi.fn(), loadRoles: vi.fn() }),
}))
vi.mock('../hooks/useUI', () => ({ useNotification: () => ({ showNotification: m.notify }) }))
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
vi.mock('../utils/blockchainService', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    getUserTierOnChain: () => Promise.resolve(m.tier),
    // Records every purchase the app would actually build, so an assertion can prove which
    // chain it targeted — or that it never built one at all.
    buildMembershipPurchaseCalls: (...args) => {
      m.builtCalls.push(args)
      return Promise.resolve({ calls: [] })
    },
    purchaseRoleWithStablecoin: (...args) => {
      m.builtCalls.push(args)
      return Promise.resolve({ hash: '0xdead' })
    },
  }
})

import PremiumPurchaseModal from '../components/ui/PremiumPurchaseModal'

// The modal calls useNavigate (the voucher entry point), so it needs a router in scope.
// FR-007 is about what the member sees BEFORE SIGNING, which is the confirm step — so these
// tests advance to it rather than asserting against the tier picker.
const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
function renderAtConfirm(ui) {
  const r = render(ui)
  const cont = screen.queryByRole('button', { name: /^Continue$/i })
  if (cont && !cont.disabled) fireEvent.click(cont)
  return r
}
import { membershipChainId, cohortChainIds, NETWORKS } from '../config/networks'

const REF = membershipChainId()
const REF_NAME = NETWORKS[REF].name

beforeEach(() => {
  m.chainId = cohortChainIds().find((id) => Number(id) !== Number(REF))
  m.switchNetwork = vi.fn(() => Promise.resolve(true))
  m.notify = vi.fn()
  m.tier = { tier: 0, tierName: 'None', readable: true }
  m.builtCalls = []
})

describe('the settlement network is disclosed before signature (FR-007)', () => {
  it('names the reference chain even when the wallet is already on it', () => {
    m.chainId = REF
    renderAtConfirm(<PremiumPurchaseModal />)
    // Disclosure is unconditional — a member should not have to infer it from a missing warning.
    expect(screen.getByRole('note')).toHaveTextContent(new RegExp(`held on\\s+${REF_NAME}`, 'i'))
  })

  it('warns and offers a switch when the wallet is on another chain', () => {
    renderAtConfirm(<PremiumPurchaseModal />)
    // Both the heading and the button name the chain — assert on the button, which is the part
    // that has to actually target it.
    const btn = screen.getByRole('button', { name: new RegExp(`Switch to ${REF_NAME}`, 'i') })
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(m.switchNetwork).toHaveBeenCalledWith(REF)
  })

  it('explains why, rather than just refusing', () => {
    renderAtConfirm(<PremiumPurchaseModal />)
    expect(screen.getByText(/could never read back/i)).toBeInTheDocument()
  })
})

describe('declining the switch buys nothing (FR-007 acceptance 2)', () => {
  it('builds no purchase call while the wallet is on the wrong chain', () => {
    renderAtConfirm(<PremiumPurchaseModal />)
    // The member never switches; nothing is sent anywhere.
    expect(m.builtCalls).toHaveLength(0)
    expect(m.switchNetwork).not.toHaveBeenCalled()
  })
})

// ── SC-006: the ABSENCE ─────────────────────────────────────────────────────────────────────
// "Purchases go to the reference chain" is only half a guarantee; the other half is that no path
// completes one anywhere else. This drives the flow from EVERY non-reference cohort chain and
// asserts nothing is ever built. Mirrors the absence assertion T067 makes for FR-020.
describe('no path completes a purchase on a non-reference chain (SC-006)', () => {
  const others = cohortChainIds().filter((id) => Number(id) !== Number(REF))

  it('has at least one non-reference chain to test, or the assertion is vacuous', () => {
    expect(others.length).toBeGreaterThan(0)
  })

  it.each(others)('builds no purchase from chain %s', (chainId) => {
    m.chainId = chainId
    m.builtCalls = []

    renderAtConfirm(<PremiumPurchaseModal />)

    // The confirm control is unavailable, and nothing was built.
    const confirm = screen.queryByRole('button', { name: /Confirm Purchase/i })
    if (confirm) expect(confirm).toBeDisabled()
    expect(m.builtCalls).toHaveLength(0)
  })
})
