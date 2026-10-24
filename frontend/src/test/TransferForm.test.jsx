import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Mock the standard address input to a plain field that resolves whatever is typed — keeps the test off
// the ENS network path while still exercising the resolved-address wiring.
vi.mock('../components/ui/AddressInput', () => ({
  default: ({ id, value, onChange, onResolvedChange, placeholder, disabled }) => (
    <input
      id={id}
      aria-label="To"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => { onChange(e); onResolvedChange(e.target.value) }}
    />
  ),
}))
vi.mock('../components/ui/BlockiesAvatar', () => ({ default: () => <span data-testid="blockie" /> }))

const send = vi.fn().mockResolvedValue({ txHash: '0xhash', route: 'gasless', id: 't1' })
const showNotification = vi.fn()
const screenOne = vi.fn().mockResolvedValue('clear')
const switchChainAsync = vi.fn().mockResolvedValue({})

// A per-asset gasless quote keyed on the network config: gasless on Polygon (137), not on Ethereum (1).
const quoteGaslessForAsset = (asset) => Number(asset?.chainId) === 137

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync, isPending: false }),
  useAccount: () => ({ address: '0xAaAa000000000000000000000000000000000001', chainId: 137 }),
}))
vi.mock('../hooks/useWalletManagement', () => ({
  useWallet: () => ({ address: '0xAaAa000000000000000000000000000000000001', chainId: 137 }),
}))
const VAULT_ADDR = '0xVaULt000000000000000000000000000000dEaD'
let isVaultMode = false
let vaultList = []
let vaultHoldings = []
const operateAsVault = vi.fn()
const operateAsPersonal = vi.fn()
vi.mock('../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({
    identity: isVaultMode ? { mode: 'vault', vaultAddress: VAULT_ADDR, chainId: 137 } : { mode: 'personal' },
    isVault: isVaultMode,
    operateAsPersonal,
    operateAsVault,
  }),
}))
// Spec 088 — the form binds balances through the shared effective-account seam.
vi.mock('../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => (
    isVaultMode
      ? { type: 'vault', address: VAULT_ADDR, isActingAccount: true, connectedAddress: null, chainId: 137, label: null }
      : { type: 'personal', address: null, isActingAccount: false, connectedAddress: null, chainId: null, label: null }
  ),
}))
vi.mock('../hooks/useHardwareAccounts', () => ({ useHardwareAccounts: () => [] }))
vi.mock('../hooks/useLegacyAccounts', () => ({ useLegacyAccounts: () => [] }))
vi.mock('../hooks/useCustodyVaults', () => ({ useCustodyVaults: () => ({ vaults: vaultList }) }))
vi.mock('../hooks/useAccountAssets', () => ({ useAccountAssets: () => ({ holdings: vaultHoldings, refresh: vi.fn() }) }))
let holdings = []
vi.mock('../hooks/usePortfolio', () => ({ default: () => ({ holdings, status: 'ready' }) }))
vi.mock('../hooks/useAddressScreening', () => ({
  useAddressScreening: () => ({ screenOne, getStatus: () => 'clear', screen: vi.fn(), search: vi.fn() }),
}))
vi.mock('../hooks/useUI', () => ({ useNotification: () => ({ showNotification }) }))

vi.mock('../hooks/useTransfer', async () => {
  const actual = await vi.importActual('../hooks/useTransfer')
  return {
    ...actual,
    useTransfer: () => ({
      send,
      status: 'idle',
      error: null,
      quoteGaslessForAsset,
      balanceOf: (kind) => (kind === 'stable' ? '100' : '5'),
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

import TransferForm from '../components/wallet/TransferForm'

describe('TransferForm', () => {
  beforeEach(() => {
    send.mockClear(); showNotification.mockClear(); screenOne.mockClear(); switchChainAsync.mockClear()
    operateAsVault.mockClear(); operateAsPersonal.mockClear()
    holdings = []; isVaultMode = false; vaultList = []; vaultHoldings = []
  })

  it('defaults to the network stablecoin, shows a gasless badge, then previews + sends the asset descriptor', async () => {
    const user = userEvent.setup()
    render(<TransferForm />)

    // USDC selected by default (connected-chain stablecoin) with a gasless badge.
    expect(screen.getByLabelText('Asset to send')).toHaveTextContent('USDC')
    expect(screen.getByText(/gasless/i)).toBeInTheDocument()

    await user.type(screen.getByLabelText('To'), '0xBbBb000000000000000000000000000000000002')
    await waitFor(() => expect(screenOne).toHaveBeenCalledWith('0xBbBb000000000000000000000000000000000002', 137))
    await user.type(screen.getByLabelText('Amount'), '10')

    const preview = screen.getByRole('button', { name: 'Preview' })
    await waitFor(() => expect(preview).toBeEnabled())
    await user.click(preview)

    expect(screen.getByText('10 USDC')).toBeInTheDocument()
    expect(screen.getByText(/no network fee/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith({
      asset: expect.objectContaining({ symbol: 'USDC', address: '0xtoken', chainId: 137, kind: 'erc20' }),
      to: '0xBbBb000000000000000000000000000000000002',
      amount: '10',
    })
    await waitFor(() => expect(showNotification).toHaveBeenCalled())
  })

  it('lists portfolio assets across networks and gates a foreign-chain asset behind a network switch', async () => {
    holdings = [
      {
        asset: { id: 'native', chainId: 1, kind: 'native', symbol: 'ETH', name: 'Ethereum', decimals: 18, address: null },
        balance: 2, network: 'Ethereum',
      },
    ]
    const user = userEvent.setup()
    render(<TransferForm />)

    await user.click(screen.getByLabelText('Asset to send'))
    // The cross-network ETH holding is offered in the dropdown.
    const ethOption = await screen.findByRole('option', { name: /ETH/ })
    await user.click(ethOption)

    // ETH is on Ethereum, not the connected Polygon — Preview is replaced by a switch action, and the
    // gasless badge is gone because that network isn't configured for it.
    const switchBtn = await screen.findByRole('button', { name: /switch to ethereum to send/i })
    expect(switchBtn).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
    expect(screen.getByText(/network fee applies/i)).toBeInTheDocument()

    await user.click(switchBtn)
    await waitFor(() => expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 1 }))
  })

  it('shows an 18-decimal balance rounded for display while MAX keeps full precision (spec 102)', async () => {
    holdings = [
      {
        asset: { id: 'native', chainId: 1, kind: 'native', symbol: 'ETH', name: 'Ethereum', decimals: 18, address: null },
        balance: 2.006441459389172406, network: 'Ethereum',
      },
    ]
    const user = userEvent.setup()
    render(<TransferForm />)
    await user.click(screen.getByLabelText('Asset to send'))
    await user.click(await screen.findByRole('option', { name: /ETH/ }))

    expect(screen.getByText(/Balance:/, { selector: '#pt-amount-hint' })).toHaveTextContent('Balance: 2.0064 ETH')
    expect(document.body.textContent).not.toContain('2.00644145938917')

    // MAX is not a display: it fills the amount the form actually holds, untouched.
    await user.click(screen.getByRole('button', { name: 'MAX' }))
    expect(screen.getByLabelText('Amount')).toHaveValue(String(2.006441459389172406))
  })

  it('renders each asset option with the nested asset logo (spec 064 US4)', async () => {
    holdings = [
      {
        asset: { id: 'native', chainId: 1, kind: 'native', symbol: 'ETH', name: 'Ethereum', decimals: 18, address: null },
        balance: 2, network: 'Ethereum',
      },
    ]
    const user = userEvent.setup()
    const { container } = render(<TransferForm />)
    await user.click(screen.getByLabelText('Asset to send'))
    const list = await screen.findByRole('listbox')
    // Every option carries a nested AssetLogo (the Earn-page artwork), so same-symbol
    // assets on different networks are distinguishable at a glance.
    const options = within(list).getAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    for (const opt of options) {
      expect(opt.querySelector('.asset-logo')).not.toBeNull()
    }
    expect(container.querySelector('.uas-select')).not.toBeNull()
  })

  it('funds from a Protect vault: shows the vault balance, gates on it, and sends a proposal', async () => {
    isVaultMode = true
    vaultList = [{ address: VAULT_ADDR, chainId: 137, label: 'Ops Vault', isSafe: true }]
    // The vault holds 50 USDC (vs the personal wallet's 100 balanceOf) — the form must use the vault's.
    vaultHoldings = [
      {
        asset: { id: '0xtoken', chainId: 137, kind: 'erc20', symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0xtoken' },
        balance: 50,
        network: 'Polygon',
      },
    ]
    send.mockResolvedValueOnce({ proposed: true, safeTxHash: '0xsafe', route: 'vault', id: null })
    const user = userEvent.setup()
    render(<TransferForm />)

    // The From dropdown surfaces the vault and it is the active identity.
    expect(screen.getByLabelText('Sending account')).toHaveTextContent('Ops Vault')
    // Balance reflects the vault's holdings (50), not the connected wallet's (100 from balanceOf).
    expect(screen.getByText(/Balance:/, { selector: '#pt-amount-hint' })).toHaveTextContent('50')

    // Over-balance gating is live against the vault balance (50), so 60 is blocked.
    await user.type(screen.getByLabelText('To'), '0xBbBb000000000000000000000000000000000002')
    await user.type(screen.getByLabelText('Amount'), '60')
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled()
    expect(screen.getByText(/exceeds balance/i)).toBeInTheDocument()

    // Within balance: preview → propose.
    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '20')
    const preview = screen.getByRole('button', { name: 'Preview' })
    await waitFor(() => expect(preview).toBeEnabled())
    await user.click(preview)
    expect(screen.getByText('Vault proposal')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Propose' }))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith({
      asset: expect.objectContaining({ symbol: 'USDC', chainId: 137 }),
      to: '0xBbBb000000000000000000000000000000000002',
      amount: '20',
    })
    const [message, type] = showNotification.mock.calls.at(-1)
    expect(type).toBe('info')
    expect(message).toMatch(/proposed sending/i)
  })

  it('reports a stalled (pending) passkey transfer honestly — info notice, not a "success"', async () => {
    send.mockResolvedValueOnce({ txHash: null, userOpHash: '0xuop', route: 'gasless', id: 't1', pending: true })
    const user = userEvent.setup()
    render(<TransferForm />)

    await user.type(screen.getByLabelText('To'), '0xBbBb000000000000000000000000000000000002')
    await user.type(screen.getByLabelText('Amount'), '10')
    const preview = screen.getByRole('button', { name: 'Preview' })
    await waitFor(() => expect(preview).toBeEnabled())
    await user.click(preview)
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(showNotification).toHaveBeenCalled())
    const [message, type] = showNotification.mock.calls.at(-1)
    expect(type).toBe('info')
    expect(message).toMatch(/still confirming on-chain/i)
    expect(message).not.toMatch(/^Sent /)
  })

  it('blocks Preview when the amount exceeds the balance', async () => {
    const user = userEvent.setup()
    render(<TransferForm />)
    await user.type(screen.getByLabelText('To'), '0xBbBb000000000000000000000000000000000002')
    await user.type(screen.getByLabelText('Amount'), '999') // balance is 100
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled()
    expect(screen.getByText(/exceeds balance/i)).toBeInTheDocument()
  })
})
