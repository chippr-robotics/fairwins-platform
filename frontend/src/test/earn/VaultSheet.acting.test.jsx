/**
 * VaultSheet and the account switcher (spec 088 FR-001/FR-002).
 *
 * Every read and write in this sheet belongs to the CONNECTED wallet: `useEarnSend.sendOnChain`
 * signs with whatever the wallet holds and switches networks on it directly, exactly the shape
 * BridgeView already refuses for the same reason (a deposit/withdrawal target may be on a chain
 * the wallet is not currently on, and the acting-account seam neither switches networks nor binds
 * to anything but the wallet's CURRENT chain at ceremony time). So while the switcher shows a
 * vault, a recovered, a hardware, or any other non-personal account, the whole sheet is withheld
 * with a reason naming the account and the way out — never left up with the connected wallet's
 * balances shown under the acting account's name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mockWallet = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => mockWallet.current,
}))

const mockSend = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useEarnSend', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useEarnSend: () => mockSend.current, default: () => mockSend.current }
})

const mockBuilders = vi.hoisted(() => ({ deposit: vi.fn(), withdraw: vi.fn() }))
vi.mock('../../lib/earn/vaultActions', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    buildDepositCalls: (...args) => mockBuilders.deposit(...args),
    buildWithdrawCalls: (...args) => mockBuilders.withdraw(...args),
  }
})
vi.mock('../../utils/rpcProvider', () => ({ makeReadProvider: () => ({}) }))

const mockFee = vi.hoisted(() => ({ impl: null }))
vi.mock('../../lib/fees/feeQuote', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchFeeQuote: (...args) => mockFee.impl(...args) }
})

import VaultSheet from '../../components/earn/VaultSheet'

const VAULT = {
  address: '0x00000000000000000000000000000000000000a1',
  chainId: 137,
  name: 'Prime USDC Vault',
  asset: { address: '0xusdc', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  netApy: 0.043,
  curator: 'Prime Curation',
}
const USER_STATE = {
  shares: 10_000_000n,
  assets: 10_000_000n,
  maxWithdrawAssets: 8_000_000n,
  walletBalance: 25_000_000n,
  maxDepositAssets: 0n,
}

const sendOnChain = vi.fn()

const personal = () => ({
  sendOnChain,
  canTransactOn: () => true,
  cannotTransactReason: () => 'nope',
  isPasskey: false,
  isActingAccount: false,
  actingAccount: { type: 'personal', address: '0xac', label: null, isActingAccount: false },
})
const actingAs = (type, label = null) => ({
  sendOnChain,
  canTransactOn: () => true,
  cannotTransactReason: () => 'nope',
  isPasskey: false,
  isActingAccount: true,
  actingAccount: { type, address: '0xACTING', label, isActingAccount: true },
})

beforeEach(() => {
  mockWallet.current = { address: '0xac', chainId: 137 }
  mockSend.current = personal()
  sendOnChain.mockReset().mockResolvedValue({ route: 'direct', txHash: '0xtx1' })
  mockBuilders.deposit.mockReset().mockResolvedValue({
    calls: [{ target: '0xusdc', data: '0xapprove', value: 0n }, { target: VAULT.address, data: '0xdeposit', value: 0n }],
    requiresApproval: true,
  })
  mockBuilders.withdraw.mockReset().mockResolvedValue({ calls: [{ target: VAULT.address, data: '0xwithdraw', value: 0n }] })
  mockFee.impl = vi.fn().mockResolvedValue({ available: false, bps: 0, capBps: 0, routerAddress: null })
})

describe('VaultSheet while acting as a non-personal account (spec 088 FR-001/FR-002)', () => {
  const kinds = [
    ['hardware', 'hardware', 'Ledger Nano', /hardware account|Ledger Nano/i],
    ['legacy (recovered)', 'legacy', null, /recovered account/i],
    ['vault', 'vault', 'Ops vault', /Ops vault/i],
  ]

  it.each(kinds)('withholds the sheet and says why while acting as %s', async (_name, type, label, names) => {
    mockSend.current = actingAs(type, label)
    render(<VaultSheet vault={VAULT} userState={USER_STATE} onClose={vi.fn()} />)

    const refusal = await screen.findByTestId('earn-vault-acting-refusal')
    expect(refusal).toHaveTextContent(names)
    expect(refusal).toHaveTextContent(/switch back to acting as yourself/i)
    expect(refusal).toHaveTextContent(/nothing has been moved/i)

    // The FR-001 half: no form, so no connected-wallet balance can be shown under this label.
    expect(screen.queryByLabelText(/^Amount/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Deposit USDC/i })).toBeNull()
  })

  it.each(kinds)('signs nothing while acting as %s', async (_name, type, label) => {
    mockSend.current = actingAs(type, label)
    render(<VaultSheet vault={VAULT} userState={USER_STATE} onClose={vi.fn()} />)
    await screen.findByTestId('earn-vault-acting-refusal')

    expect(sendOnChain).not.toHaveBeenCalled()
    expect(mockBuilders.deposit).not.toHaveBeenCalled()
    expect(mockBuilders.withdraw).not.toHaveBeenCalled()
  })

  it('leaves the personal member’s sheet exactly as it was', async () => {
    mockSend.current = personal()
    render(<VaultSheet vault={VAULT} userState={USER_STATE} onClose={vi.fn()} />)

    expect(await screen.findByLabelText(/^Amount/)).toBeInTheDocument()
    expect(screen.queryByTestId('earn-vault-acting-refusal')).toBeNull()
    expect(screen.getByRole('button', { name: /Deposit USDC/i })).toBeInTheDocument()
  })
})
