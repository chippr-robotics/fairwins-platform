/**
 * Spec 098 — a membership purchase is threaded THROUGH the acting account, per rail.
 *
 * `MembershipManager.purchaseTier` credits `msg.sender` and takes NO beneficiary, so a membership
 * lands on the acting account if and only if the ACTING account signs — as msg.sender on a
 * self-submitted transaction, as the Safe that executes a proposal, or as the recovered signer of
 * a relayed intent. The spec-088-era blanket refusal ("switch back to your personal wallet") is
 * RETIRED (FR-017); what remains is per-kind routing:
 *
 *   vault on the membership chain  → ONE Safe proposal (FR-005), never sendCalls/signer rails
 *   recovered legacy / hardware    → acting-signer classic rail via the ceremony broker (FR-004)
 *   passkey acting as themselves   → the unchanged sendCalls batch (FR-006)
 *   derived (BTC/SOL/ZEC), vault on any other chain → refusal that NAMES the reason (FR-003)
 *
 * These tests drive the modal to confirm and assert what each acting kind starts — or that a
 * refused kind starts nothing and learns why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const CONNECTED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const VAULT = '0x1215000000000000000000000000000000008575'
const HARDWARE = '0x9962000000000000000000000000000000004242'
const LEGACY = '0x7333000000000000000000000000000000001111'
const DERIVED = 'bc1qexampleexampleexampleexample'
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const MM = '0x4444444444444444444444444444444444444444'

const m = vi.hoisted(() => ({
  tierByAddress: {},
  askedFor: [],
  effective: null,
  started: [],
  notified: [],
  flowStatus: 'idle',
  invalidated: [],
  sendCalls: null,
  submitAsActing: null,
  loginMethod: 'wallet',
  // Issue #1368 — the vault's own guard's answer about a MultiSend delegatecall, plus the
  // allowance pre-flight that decides whether there are two legs at all.
  batchSupport: { support: 'batch-ok', reason: null, detail: null, engine: 'none' },
  needsApprove: true,
  purchaseCalls: [],
}))

vi.mock('../lib/custody/batchPreflight', async (orig) => ({
  ...(await orig()),
  previewBatchSupport: vi.fn(async () => m.batchSupport),
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
    account: CONNECTED,
    isConnected: true, isCorrectNetwork: true, switchNetwork: vi.fn(),
    chainId: m.chainId, loginMethod: m.loginMethod, sendCalls: m.sendCalls, provider: {},
  }),
}))
vi.mock('../hooks/useRoles', () => ({ useRoles: () => ({ grantRole: vi.fn(), loadRoles: vi.fn() }) }))
vi.mock('../hooks/useUI', () => ({
  useNotification: () => ({ showNotification: (msg, kind) => m.notified.push({ msg, kind }) }),
}))
vi.mock('../hooks/useTierPrices', () => ({
  useTierPrices: () => ({
    getPrice: (_role, tier) => ({ BRONZE: 2, SILVER: 8, GOLD: 25, PLATINUM: 100 }[tier]),
    getLimits: () => ({ monthly: 15, concurrent: 5 }),
    usingFallbackPrices: false,
    isTierActive: () => true,
  }),
}))
vi.mock('../hooks/useEncryption', () => ({
  useEncryption: () => ({ ensureInitialized: vi.fn(), isInitialized: true }),
}))
vi.mock('../hooks/useEffectiveAccount', () => ({ useEffectiveAccount: () => m.effective }))
vi.mock('../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ submit: m.submitAsActing }),
  default: () => ({ submit: m.submitAsActing }),
}))
vi.mock('../utils/blockchainService', async (orig) => ({
  ...(await orig()),
  getUserTierOnChain: (addr) => {
    m.askedFor.push(String(addr))
    return Promise.resolve(m.tierByAddress[String(addr).toLowerCase()] || { tier: 0, readable: true })
  },
  buildMembershipPurchaseCalls: vi.fn(async () => ({ calls: m.purchaseCalls })),
  checkApprovalNeededForAddress: vi.fn(async () => m.needsApprove),
}))
vi.mock('../hooks/usePurchaseFlow', () => {
  const flow = () => ({
    steps: [], status: m.flowStatus, total: 0, completedCount: 0, activeIndex: -1, activeStep: null,
    progressFraction: 0, keyRegOutcome: null, canContinueAnyway: false, purchaseReceipt: null,
    start: (params) => { m.started.push(params); m.flowStatus = 'running'; return Promise.resolve() },
    retry: vi.fn(), continueAnyway: vi.fn(), reset: vi.fn(),
    invalidateIdentity: (reason) => { m.invalidated.push(reason) },
  })
  return { usePurchaseFlow: flow, default: flow }
})

import PremiumPurchaseModal from '../components/ui/PremiumPurchaseModal'
import { membershipChainId, NETWORKS } from '../config/networks'
import { networkName } from '../lib/chains/estate'

const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)
const radio = (tier) => document.querySelector(`input[type="radio"][value="${tier}"]`)

const REF = membershipChainId()
const REF_NAME = NETWORKS[REF].name

const personal = () => ({
  address: CONNECTED, isActingAccount: false, type: 'personal', label: null,
  connectedAddress: CONNECTED, chainId: null,
})
const actingAsVault = (chainId = REF) => ({
  address: VAULT, isActingAccount: true, type: 'vault', label: 'Ops vault',
  connectedAddress: CONNECTED, chainId,
})
const actingAsHardware = () => ({
  address: HARDWARE, isActingAccount: true, type: 'hardware', label: 'Cold key',
  connectedAddress: CONNECTED, chainId: null,
})
const actingAsLegacy = () => ({
  address: LEGACY, isActingAccount: true, type: 'legacy', label: 'Old wallet',
  connectedAddress: CONNECTED, chainId: null,
})
const actingAsDerived = () => ({
  address: DERIVED, isActingAccount: true, type: 'derived', label: 'Bitcoin account',
  connectedAddress: CONNECTED, chainId: null,
})

/** Walk to the confirm step with a tier selected. */
async function toConfirm(ui = <PremiumPurchaseModal />) {
  const r = render(ui)
  await waitFor(() => expect(radio('SILVER')).toBeTruthy())
  fireEvent.click(radio('SILVER'))
  fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }))
  screen.getAllByRole('checkbox').forEach((cb) => fireEvent.click(cb))
  return r
}

beforeEach(() => {
  m.chainId = REF
  m.effective = personal()
  m.tierByAddress = {}
  m.askedFor = []
  m.started = []
  m.notified = []
  m.flowStatus = 'idle'
  m.invalidated = []
  m.loginMethod = 'wallet'
  m.sendCalls = vi.fn()
  m.submitAsActing = vi.fn(async () => ({ kind: 'proposed', safeTxHash: '0xsafe' }))
})

describe('the tier quoted is the ACTING account’s (FR-002)', () => {
  it('reads the acting account, not the connected wallet', async () => {
    m.effective = actingAsVault()
    render(<PremiumPurchaseModal />)
    await waitFor(() => expect(m.askedFor.length).toBeGreaterThan(0))
    expect(m.askedFor.map((a) => a.toLowerCase())).toContain(VAULT.toLowerCase())
    expect(m.askedFor.map((a) => a.toLowerCase())).not.toContain(CONNECTED.toLowerCase())
  })

  it('reads the connected wallet while acting as yourself', async () => {
    render(<PremiumPurchaseModal />)
    await waitFor(() => expect(m.askedFor.length).toBeGreaterThan(0))
    expect(m.askedFor.map((a) => a.toLowerCase())).toContain(CONNECTED.toLowerCase())
  })
})

describe('ineligible acting kinds are refused with the SPECIFIC reason (FR-003, US4)', () => {
  it('a derived non-EVM account: names the account and its missing sending identity — not the blanket copy', async () => {
    m.effective = actingAsDerived()
    await toConfirm()
    // The spec-088-era blanket copy is retired (FR-017).
    expect(screen.queryByText(/Switch back to your personal wallet to buy/i)).toBeNull()
    // The refusal names the account and the reason.
    expect(screen.getAllByText(/Bitcoin account/).length).toBeGreaterThan(0)
    expect(screen.getByText(new RegExp(`no sending identity on ${REF_NAME}`, 'i'))).toBeTruthy()

    const confirm = screen.getByRole('button', { name: /^Confirm Purchase/i })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(m.started.length).toBe(0))
  })

  it('a vault on another chain: names both networks, offers no proposal', async () => {
    const otherChain = Object.keys(NETWORKS).map(Number).find((id) => id !== Number(REF))
    m.effective = actingAsVault(otherChain)
    await toConfirm()
    expect(screen.getByText(new RegExp(`exists only on ${networkName(otherChain)}`, 'i'))).toBeTruthy()

    const confirm = screen.getByRole('button', { name: /^Confirm Purchase/i })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(m.started.length).toBe(0))
    expect(m.submitAsActing).not.toHaveBeenCalled()
  })
})

describe('a vault on the membership chain gets a PROPOSAL rail (FR-005)', () => {
  it('discloses credited account, paying account, settlement chain and proposal semantics (FR-010)', async () => {
    m.effective = actingAsVault()
    await toConfirm()
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent(/Ops vault/)
    expect(note).toHaveTextContent(new RegExp(REF_NAME, 'i'))
    expect(note).toHaveTextContent(/paid from/i)
    expect(note).toHaveTextContent(/proposal/i)
    expect(note).toHaveTextContent(/threshold/i)
  })

  it('confirm starts the flow with a vault binding and a proposePurchase closure — never batchPurchase', async () => {
    m.effective = actingAsVault()
    await toConfirm()
    const confirm = screen.getByRole('button', { name: /^Confirm Purchase/i })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(m.started.length).toBe(1))

    const params = m.started[0]
    expect(params.acting).toMatchObject({ kind: 'vault', address: VAULT, chainId: REF })
    expect(typeof params.proposePurchase).toBe('function')
    expect(params.batchPurchase).toBeUndefined()
    expect(params.getActingSigner).toBeUndefined()
    expect(params.account.toLowerCase()).toBe(VAULT.toLowerCase())
  })
})

describe('recovered / hardware accounts get the acting-signer classic rail (FR-004)', () => {
  it.each([
    ['legacy', actingAsLegacy, LEGACY],
    ['hardware', actingAsHardware, HARDWARE],
  ])('%s: confirm starts the flow bound to the acting address with a deferred ceremony', async (kind, make, addr) => {
    m.effective = make()
    await toConfirm()
    const confirm = screen.getByRole('button', { name: /^Confirm Purchase/i })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(m.started.length).toBe(1))

    const params = m.started[0]
    expect(params.acting).toMatchObject({ kind, address: addr })
    expect(typeof params.getActingSigner).toBe('function')
    expect(params.batchPurchase).toBeUndefined()
    expect(params.proposePurchase).toBeUndefined()
    expect(params.account.toLowerCase()).toBe(addr.toLowerCase())
    // The ceremony is deferred to the flow (confirm time), never run at modal-open.
    expect(m.notified.some((n) => n.kind === 'error')).toBe(false)
  })
})

describe('the passkey batch rail is personal-only (FR-006)', () => {
  it('a passkey member acting as a hardware account routes to the acting rail — sendCalls is never used', async () => {
    m.loginMethod = 'passkey'
    m.effective = actingAsHardware()
    await toConfirm()
    fireEvent.click(screen.getByRole('button', { name: /^Confirm Purchase/i }))
    await waitFor(() => expect(m.started.length).toBe(1))

    const params = m.started[0]
    expect(params.batchPurchase).toBeUndefined()
    expect(typeof params.getActingSigner).toBe('function')
    expect(m.sendCalls).not.toHaveBeenCalled()
  })

  it('a passkey member acting as themself keeps the batch rail', async () => {
    m.loginMethod = 'passkey'
    await toConfirm()
    fireEvent.click(screen.getByRole('button', { name: /^Confirm Purchase/i }))
    await waitFor(() => expect(m.started.length).toBe(1))
    expect(typeof m.started[0].batchPurchase).toBe('function')
    expect(m.started[0].acting).toBeUndefined()
  })
})

describe('the personal path is unchanged (FR-016)', () => {
  it('acting as yourself: no refusal, flow starts with a signer and no acting binding', async () => {
    await toConfirm()
    expect(screen.queryByText(/Switch back to your personal wallet to buy/i)).toBeNull()
    const confirm = screen.getByRole('button', { name: /^Confirm Purchase/i })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(m.started.length).toBe(1))
    expect(m.started[0].acting).toBeUndefined()
    expect(m.started[0].proposePurchase).toBeUndefined()
    expect(m.started[0].getActingSigner).toBeUndefined()
  })
})

describe('a mid-flow acting switch cancels the bound run (FR-013)', () => {
  it('changing the acting selection while the flow runs invalidates the bound identity', async () => {
    m.effective = actingAsLegacy()
    const { rerender } = await toConfirm()
    fireEvent.click(screen.getByRole('button', { name: /^Confirm Purchase/i }))
    await waitFor(() => expect(m.started.length).toBe(1))

    // The member switches back to personal while the purchase is in flight.
    m.effective = personal()
    rerender(<MemoryRouter><PremiumPurchaseModal /></MemoryRouter>)

    await waitFor(() => expect(m.invalidated.length).toBeGreaterThan(0))
    // The failure names the account the flow was BOUND to, not the new selection.
    expect(m.invalidated[0]).toMatch(/Old wallet/)
  })
})

/*
 * ── Issue #1368 — a policy-guarded vault never gets a proposal its guard will revert ──────────
 *
 * The vault purchase batches [approve(exact), purchase] through MultiSendCallOnly, which executes
 * by DELEGATECALL. `SafePolicyGuardV2._preCheck` (and v1's `_checkPolicy`) deny operation != 0 for
 * any vault with an active policy, so that proposal is approved by the vault's signers and then
 * reverts. The shape is therefore decided from the vault's OWN guard, and disclosed before signing.
 */
describe('vault purchase — the proposal shape follows the vault’s policy (#1368)', () => {
  beforeEach(() => {
    m.effective = actingAsVault()
    m.batchSupport = { support: 'batch-ok', reason: null, detail: null, engine: 'none' }
    m.needsApprove = true
    m.purchaseCalls = [
      { target: USDC, value: 0n, data: '0xapprove' },
      { target: MM, value: 0n, data: '0xpurchase' },
    ]
    m.submitAsActing = vi.fn(async (p) => ({ kind: 'proposed', safeTxHash: '0xsafe', nonce: p.nonce ?? 5 }))
  })

  const proposeFrom = async () => {
    await toConfirm()
    fireEvent.click(screen.getByRole('button', { name: /^Confirm Purchase/i }))
    await waitFor(() => expect(m.started.length).toBe(1))
    return m.started[0].proposePurchase()
  }

  it('an unguarded vault still gets ONE batched proposal — unchanged', async () => {
    await proposeFrom()
    expect(m.submitAsActing).toHaveBeenCalledTimes(1)
    const [payload] = m.submitAsActing.mock.calls[0]
    expect(payload.batch).toHaveLength(2)
  })

  it('a guarded vault gets TWO proposals at consecutive nonces — approve first, purchase second', async () => {
    m.batchSupport = { support: 'batch-denied', reason: 'nope', detail: null, engine: 'v2' }
    const res = await proposeFrom()
    expect(m.submitAsActing).toHaveBeenCalledTimes(2)
    const [first] = m.submitAsActing.mock.calls[0]
    const [second] = m.submitAsActing.mock.calls[1]
    expect(first.batch).toBeUndefined()
    expect(first.data).toBe('0xapprove')
    expect(second.data).toBe('0xpurchase')
    // Consecutive nonces: the purchase CANNOT execute before the approval it depends on, and no
    // other queued vault transaction can take the slot between them.
    expect(second.nonce).toBe(6)
    expect(res.shape).toBe('split')
    expect(res.proposals).toHaveLength(2)
  })

  it('a guard that could not be read splits too — an unconfirmed policy is not permission', async () => {
    m.batchSupport = { support: 'unknown', reason: 'could not confirm', detail: null, engine: 'foreign' }
    await proposeFrom()
    expect(m.submitAsActing).toHaveBeenCalledTimes(2)
  })

  it('an allowance that already covers the price needs NO split — one plain-call proposal', async () => {
    m.needsApprove = false
    m.batchSupport = { support: 'batch-denied', reason: 'nope', detail: null, engine: 'v2' }
    await proposeFrom()
    expect(m.submitAsActing).toHaveBeenCalledTimes(1)
    const [payload] = m.submitAsActing.mock.calls[0]
    // A one-leg batch is emitted as that leg's plain CALL by the submit seam, so no delegatecall
    // is involved and the guard evaluates it as an ordinary transaction.
    expect(payload.batch).toHaveLength(1)
    expect(payload.batch[0].data).toBe('0xpurchase')
  })

  it('discloses the SPLIT shape and why, before anything is signed', async () => {
    m.batchSupport = { support: 'batch-denied', reason: 'nope', detail: null, engine: 'v2' }
    await toConfirm()
    await waitFor(() => {
      expect(screen.getByRole('note')).toHaveTextContent(/two separate proposals/i)
    })
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent(/does not allow batched transactions/i)
    expect(note).toHaveTextContent(/in order/i)
    // The exact-amount allowance and its window are stated, not left to be discovered.
    expect(note).toHaveTextContent(/exact/i)
  })

  it('names “could not confirm” rather than claiming the policy denies it', async () => {
    m.batchSupport = { support: 'unknown', reason: 'could not confirm', detail: null, engine: 'foreign' }
    await toConfirm()
    await waitFor(() => {
      expect(screen.getByRole('note')).toHaveTextContent(/could not confirm/i)
    })
    expect(screen.getByRole('note')).not.toHaveTextContent(/does not allow batched transactions/i)
  })

  it('an unguarded vault says one proposal, and says nothing about splitting', async () => {
    await toConfirm()
    const note = screen.getByRole('note')
    await waitFor(() => expect(note).toHaveTextContent(/one\b.*proposal/i))
    expect(note).not.toHaveTextContent(/two separate proposals/i)
  })
})
