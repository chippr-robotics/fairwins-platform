import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Same environment mocks as TransferForm.test.jsx — the EVM stack is inert
// here; these tests exercise ONLY the parallel Bitcoin path (spec 061 US3).
vi.mock('../components/ui/AddressInput', () => ({
  default: ({ id, value, onChange, onResolvedChange, placeholder, disabled, bitcoinNetworkId }) => (
    <input
      id={id}
      aria-label="To"
      data-bitcoin-network={bitcoinNetworkId || ''}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => { onChange(e); onResolvedChange(e.target.value) }}
    />
  ),
}))
vi.mock('../components/ui/BlockiesAvatar', () => ({ default: () => <span data-testid="blockie" /> }))

const showNotification = vi.fn()
const screenOne = vi.fn().mockResolvedValue('clear')
const switchChainAsync = vi.fn().mockResolvedValue({})

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync, isPending: false }),
  useAccount: () => ({ address: '0xAaAa000000000000000000000000000000000001', chainId: 137 }),
}))
vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: () => ({ address: '0xAaAa000000000000000000000000000000000001', chainId: 137 }),
}))
vi.mock('../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({
    identity: { mode: 'personal' },
    isVault: false,
    operateAsPersonal: vi.fn(),
    operateAsVault: vi.fn(),
  }),
}))
vi.mock('../hooks/useCustodyVaults', () => ({ useCustodyVaults: () => ({ vaults: [] }) }))
vi.mock('../hooks/useAccountAssets', () => ({ useAccountAssets: () => ({ holdings: [], refresh: vi.fn() }) }))
vi.mock('../hooks/usePortfolio', () => ({
  default: () => ({
    holdings: [],
    status: 'ready',
    priceMap: new Map([['BTC', { usd: 100000, source: 'chainlink', chainId: 137 }]]),
  }),
}))
vi.mock('../hooks/useAddressScreening', () => ({
  useAddressScreening: () => ({ screenOne, getStatus: () => 'clear', screen: vi.fn(), search: vi.fn() }),
}))
vi.mock('../hooks/useUI', () => ({ useNotification: () => ({ showNotification }) }))
vi.mock('../hooks/useTransfer', async () => {
  const actual = await vi.importActual('../hooks/useTransfer')
  return {
    ...actual,
    useTransfer: () => ({
      send: vi.fn(),
      status: 'idle',
      error: null,
      quoteGaslessForAsset: () => true, // EVM assets gasless — BTC must still say fee
      balanceOf: () => '5',
      refreshBalances: vi.fn(),
      tokens: {
        stable: 'USDC', stableName: 'USD Coin', stableDecimals: 6, stableAddress: '0xtoken',
        native: 'MATIC', nativeName: 'MATIC', nativeDecimals: 18,
        chainId: 137, networkName: 'Polygon',
      },
      isPasskey: true,
    }),
  }
})

// The Bitcoin wallet hook — fully controlled per test.
const getFeeQuote = vi.fn()
const prepare = vi.fn()
const confirmAndSend = vi.fn()
let btcState
vi.mock('../hooks/useBitcoinWallet', () => ({
  useBitcoinWallet: () => btcState,
}))

import TransferForm from '../components/wallet/TransferForm'

const PLAN = {
  destination: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  destinationType: 'p2wpkh',
  amountSats: 50_000_000, // 0.5 BTC
  feeSats: 1_000,
  vsize: 110,
  feeRate: 5,
  inputs: [],
  changeSats: 0,
  changeAddress: null,
  networkId: 'bitcoin',
  isMax: false,
}

const freshQuote = () => ({ rates: { fast: 10, normal: 5, slow: 1 }, tipHeight: 1, fetchedAt: Date.now() })

async function selectBitcoinAsset(user) {
  await user.click(screen.getByLabelText('Asset to send'))
  const btcOption = await screen.findByRole('option', { name: /Bitcoin/ })
  await user.click(btcOption)
}

beforeEach(() => {
  vi.clearAllMocks()
  getFeeQuote.mockResolvedValue({ ok: true, quote: freshQuote() })
  prepare.mockReturnValue({ ok: true, plan: PLAN })
  confirmAndSend.mockResolvedValue({ ok: true, txid: 'deadbeef', feeSats: 1_000 })
  btcState = {
    status: 'ready',
    reason: null,
    networkId: 'bitcoin',
    balances: { confirmedSats: 60_000_000, pendingSats: 0, protectedSats: 3_000_000, spendableSats: 57_000_000 },
    stampsDegraded: false,
    coins: [],
    activity: [],
    receive: { current: null, uri: null, preferredType: 'segwit', setPreferredType: vi.fn(), nextReceiveAddress: vi.fn(), select: vi.fn() },
    send: { feeQuote: null, getFeeQuote, prepare, confirmAndSend },
    unlock: vi.fn(),
    refresh: vi.fn(),
  }
})

describe('TransferForm Bitcoin path (spec 061 US3 — FR-011/012/013/015)', () => {
  it('offers Bitcoin with an honest fee badge (never gasless) and spendable balance', async () => {
    const user = userEvent.setup()
    render(<TransferForm />)
    await selectBitcoinAsset(user)
    expect(screen.getByLabelText('Asset to send')).toHaveTextContent('BTC')
    expect(screen.getByText(/network fee applies/i)).toBeInTheDocument()
    // No AFFIRMATIVE gasless claim anywhere ("never gasless" disclosure is fine)
    expect(screen.queryByText(/⚡ Gasless/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no network fee/i)).not.toBeInTheDocument()
    expect(screen.getByText(/never gasless/i)).toBeInTheDocument()
    expect(screen.getByText(/Spendable:/)).toBeInTheDocument()
    // protected value is explained (total ≠ spendable, FR-018)
    expect(screen.getByText(/0\.03 BTC is protected/)).toBeInTheDocument()
    // the destination input runs in bitcoin validation mode
    expect(screen.getByLabelText('To').dataset.bitcoinNetwork).toBe('bitcoin')
  })

  it('hides Bitcoin entirely when the wallet is not ready (honest capability)', async () => {
    btcState = { ...btcState, status: 'locked' }
    const user = userEvent.setup()
    render(<TransferForm />)
    await user.click(screen.getByLabelText('Asset to send'))
    expect(screen.queryByRole('option', { name: /Bitcoin/ })).not.toBeInTheDocument()
  })

  it('preview quotes fees fresh, shows fee + total debit lines, and sends on confirm', async () => {
    const user = userEvent.setup()
    render(<TransferForm />)
    await selectBitcoinAsset(user)

    await user.type(screen.getByLabelText('To'), PLAN.destination)
    await user.type(screen.getByLabelText('Amount'), '0.5')
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    await waitFor(() => expect(getFeeQuote).toHaveBeenCalledTimes(1))
    expect(prepare).toHaveBeenCalledWith({
      destination: PLAN.destination,
      amountSats: 50_000_000,
      feeRate: 5, // normal tier from the quote
    })
    // Confirm screen: amount, recognized type, fee as its own line (BTC + USD), total debit
    expect(screen.getByText('0.5 BTC')).toBeInTheDocument()
    expect(screen.getByText('P2WPKH')).toBeInTheDocument()
    expect(screen.getByText(/0\.00001 BTC \(~\$1\.00\) — you pay this fee/)).toBeInTheDocument()
    expect(screen.getByText(/Total debit/)).toBeInTheDocument()
    expect(screen.getByText(/0\.50001 BTC/)).toBeInTheDocument()
    expect(screen.queryByText(/⚡ Gasless/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no network fee/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Send Bitcoin' }))
    await waitFor(() => expect(confirmAndSend).toHaveBeenCalledWith(PLAN))
    await waitFor(() => expect(showNotification).toHaveBeenCalledWith(
      expect.stringMatching(/pending until the Bitcoin network confirms/),
      'info',
    ))
  })

  it('surfaces destination rejection reasons from prepare (FR-011)', async () => {
    prepare.mockReturnValue({
      ok: false,
      error: 'invalid_destination',
      reason: 'wrong_network',
      message: 'This is a Bitcoin Testnet4 address — you are sending on Bitcoin.',
    })
    const user = userEvent.setup()
    render(<TransferForm />)
    await selectBitcoinAsset(user)
    await user.type(screen.getByLabelText('To'), 'tb1qsomewhere')
    await user.type(screen.getByLabelText('Amount'), '0.1')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Testnet4 address/)
  })

  it('explains shortfalls with the missing amount (FR-013)', async () => {
    prepare.mockReturnValue({ ok: false, error: 'insufficient_funds', shortfallSats: 2_500_000, spendableSats: 57_000_000 })
    const user = userEvent.setup()
    render(<TransferForm />)
    await selectBitcoinAsset(user)
    await user.type(screen.getByLabelText('To'), PLAN.destination)
    await user.type(screen.getByLabelText('Amount'), '0.6')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/0\.025 BTC short, network fee included/)
  })

  it('MAX prepares an everything-minus-fee send (FR-013)', async () => {
    prepare.mockReturnValue({ ok: true, plan: { ...PLAN, isMax: true, amountSats: 56_999_000 } })
    const user = userEvent.setup()
    render(<TransferForm />)
    await selectBitcoinAsset(user)
    await user.type(screen.getByLabelText('To'), PLAN.destination)
    await user.click(screen.getByRole('button', { name: 'MAX' }))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ amountSats: 'max' })))
  })

  it('a stale quote at confirm forces re-preview, never a silent send (FR-012)', async () => {
    getFeeQuote.mockResolvedValue({ ok: true, quote: { ...freshQuote(), fetchedAt: Date.now() - 120_000 } })
    const user = userEvent.setup()
    render(<TransferForm />)
    await selectBitcoinAsset(user)
    await user.type(screen.getByLabelText('To'), PLAN.destination)
    await user.type(screen.getByLabelText('Amount'), '0.5')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByRole('button', { name: 'Send Bitcoin' })
    await user.click(screen.getByRole('button', { name: 'Send Bitcoin' }))
    expect(confirmAndSend).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/fee quote expired/)
    // back on the edit step
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
  })

  it('degraded stamps recognition is disclosed on the send surface (FR-019)', async () => {
    btcState = { ...btcState, stampsDegraded: true }
    const user = userEvent.setup()
    render(<TransferForm />)
    await selectBitcoinAsset(user)
    expect(screen.getByText(/Stamps recognition is degraded/)).toBeInTheDocument()
  })
})
