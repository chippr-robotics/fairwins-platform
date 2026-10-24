/**
 * SupplySheet and the account switcher (spec 088 FR-001/FR-002).
 *
 * Every read and write in this sheet belongs to the CONNECTED wallet: `useEarnSend.sendOnChain`
 * signs with whatever the wallet holds and switches networks on it directly — the same shape
 * BridgeView already refuses while acting (FR-061/T153: this sheet is deliberately NOT gated on
 * the wallet's active chain, and the switch happens at signing; the acting-account seam neither
 * switches networks nor binds to anything but the wallet's CURRENT chain at ceremony time). So
 * while the switcher shows a vault, a recovered, a hardware, or any other non-personal account,
 * the whole sheet is withheld with a reason naming the account and the way out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const walletState = { address: '0x1111111111111111111111111111111111111111', chainId: 137 }
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletState }))
vi.mock('../../hooks/usePortfolio', () => ({ default: () => ({ holdings: [], status: 'ready' }) }))
vi.mock('../../hooks/useActivity', () => ({ useActivityOptional: () => ({ refresh: vi.fn() }) }))
vi.mock('../../utils/rpcProvider', () => ({ makeReadProvider: () => ({}) }))

const sendOnChain = vi.fn()
let acting = { type: 'personal', address: null, label: null, isActingAccount: false }
vi.mock('../../hooks/useEarnSend', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useEarnSend: () => ({
      sendOnChain,
      canTransactOn: () => true,
      cannotTransactReason: () => 'nope',
      isPasskey: false,
      isActingAccount: acting.isActingAccount,
      actingAccount: acting,
    }),
  }
})

const fetchFeeQuote = vi.fn()
vi.mock('../../lib/fees/feeQuote', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchFeeQuote: (...args) => fetchFeeQuote(...args),
}))

import SupplySheet from '../../components/earn/SupplySheet'
import { POOL_KIND } from '../../lib/liquidity/liquidityRouter'

const TOKENS = {
  usdc137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  weth137: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
}

const opt = (chainId, address, symbol, name, decimals, networkName, balance = 100) => ({
  key: `${chainId}:${address.toLowerCase()}`,
  chainId,
  kind: 'erc20',
  address,
  symbol,
  name,
  decimals,
  networkName,
  balance,
})
const ASSET_OPTIONS = [
  opt(137, TOKENS.usdc137, 'USDC', 'USD Coin', 6, 'Polygon'),
  opt(137, TOKENS.weth137, 'WETH', 'Wrapped Ether', 18, 'Polygon'),
]

const tradingPool = (overrides = {}) => ({
  poolId: `0x${'11'.repeat(32)}`,
  kind: POOL_KIND.TRADING_LP,
  enabled: true,
  feeTier: 3000,
  token0: TOKENS.usdc137,
  token1: TOKENS.weth137,
  poolAddress: '0x00000000000000000000000000000000000000a1',
  maxDeposit0PerTx: 0n,
  maxDeposit1PerTx: 0n,
  chainId: 137,
  networkName: 'Polygon',
  token0Meta: { symbol: 'USDC', decimals: 6 },
  token1Meta: { symbol: 'WETH', decimals: 18 },
  routerAddress: '0x000000000000000000000000000000000000dEaD',
  positionManager: '0x0000000000000000000000000000000000000abc',
  ...overrides,
})

beforeEach(() => {
  acting = { type: 'personal', address: null, label: null, isActingAccount: false }
  sendOnChain.mockReset().mockResolvedValue({ txHash: '0xtx1' })
  fetchFeeQuote.mockReset().mockResolvedValue({ available: false, bps: 0, capBps: 0, routerAddress: null })
})

describe('SupplySheet while acting as a non-personal account (spec 088 FR-001/FR-002)', () => {
  const pool = tradingPool()
  const kinds = [
    ['hardware', 'hardware', 'Ledger Nano', /hardware account|Ledger Nano/i],
    ['legacy (recovered)', 'legacy', null, /recovered account/i],
    ['vault', 'vault', 'Ops vault', /Ops vault/i],
  ]

  it.each(kinds)('withholds the sheet and says why while acting as %s', async (_name, type, label, names) => {
    acting = { type, address: '0xACTING', label, isActingAccount: true }
    render(<SupplySheet pool={pool} pools={[pool]} assetOptions={ASSET_OPTIONS} positions={[]} onClose={vi.fn()} />)

    const refusal = await screen.findByTestId('earn-supply-acting-refusal')
    expect(refusal).toHaveTextContent(names)
    expect(refusal).toHaveTextContent(/switch back to acting as yourself/i)
    expect(refusal).toHaveTextContent(/nothing has been moved/i)

    expect(screen.queryByLabelText(/^Amount/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Review and confirm/i })).toBeNull()
  })

  it.each(kinds)('signs nothing while acting as %s', async (_name, type, label) => {
    acting = { type, address: '0xACTING', label, isActingAccount: true }
    render(<SupplySheet pool={pool} pools={[pool]} assetOptions={ASSET_OPTIONS} positions={[]} onClose={vi.fn()} />)
    await screen.findByTestId('earn-supply-acting-refusal')

    expect(sendOnChain).not.toHaveBeenCalled()
  })

  it('leaves the personal member’s sheet exactly as it was', async () => {
    acting = { type: 'personal', address: walletState.address, label: null, isActingAccount: false }
    render(<SupplySheet pool={pool} pools={[pool]} assetOptions={ASSET_OPTIONS} positions={[]} onClose={vi.fn()} />)

    expect(await screen.findByLabelText(/Amount \(USDC\)/i)).toBeInTheDocument()
    expect(screen.queryByTestId('earn-supply-acting-refusal')).toBeNull()
  })
})
