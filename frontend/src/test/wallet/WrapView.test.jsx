/**
 * Transfer ▸ Wrap — the view.
 *
 * The hook is stubbed here: this file is about what the member is told, which is where wrapping can
 * mislead even when the transaction is correct. Specifically —
 *
 *   - an unread balance renders "—" and says so, never a "0" the member would read as their money;
 *   - the fee is stated on its own line, and "sponsored" is only ever claimed when it is true;
 *   - MAX offers the spendable amount (balance less the fee reserve when wrapping), never the whole
 *     balance, and discloses the hold-back;
 *   - a network with no wrapped coin offers no controls at all rather than a dead form;
 *   - acting as a vault says "Propose", because nothing moves until the signers approve.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { ethers } from 'ethers'

const showNotification = vi.fn()
vi.mock('../../hooks/useUI', () => ({ useNotification: () => ({ showNotification }) }))

const wrapper = vi.hoisted(() => ({ current: {} }))
const wrapNativeCalls = vi.hoisted(() => ({ current: [] }))
vi.mock('../../hooks/useWrapNative', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useWrapNative: (params) => {
      wrapNativeCalls.current.push(params)
      return wrapper.current
    },
  }
})

// The picker's option list (spec 108) — the read layer has its own suite
// (useWrapCoinOptions.test.jsx); the view gets a hand-built list so what is under test here
// is what the VIEW does with it.
const coinOptions = vi.hoisted(() => ({ current: { options: [], defaultKey: null } }))
vi.mock('../../hooks/useWrapCoinOptions', () => ({
  useWrapCoinOptions: () => ({ ...coinOptions.current, refresh: vi.fn() }),
}))
const acting = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useActiveAccount', () => ({ useActiveAccount: () => acting.current }))

import WrapView from '../../components/wallet/WrapView'

const ETC_OPTION = {
  key: 'native:61',
  chainId: 61,
  kind: 'native',
  symbol: 'ETC',
  name: 'Ethereum Classic',
  networkName: 'Ethereum Classic',
  decimals: 18,
  balance: '10.0',
  readState: 'read',
  wrapped: { chainId: 61, address: '0x1953cab0E5bFa6D4a9BaD6E05fD46C1CC6527a5a', symbol: 'WETC', name: 'Wrapped Ethereum Classic', decimals: 18 },
}
const POL_OPTION = {
  key: 'native:137',
  chainId: 137,
  kind: 'native',
  symbol: 'POL',
  name: 'POL',
  networkName: 'Polygon',
  decimals: 18,
  balance: '3.5',
  readState: 'read',
  wrapped: { chainId: 137, address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WPOL', name: 'Wrapped POL', decimals: 18 },
}

const wrap = vi.fn()
const unwrap = vi.fn()

const base = () => ({
  token: { address: '0x1953cab0E5bFa6D4a9BaD6E05fD46C1CC6527a5a', symbol: 'WETC', decimals: 18 },
  available: true,
  networkName: 'Ethereum Classic',
  chainId: 61,
  nativeSymbol: 'ETC',
  wrappedSymbol: 'WETC',
  decimals: 18,
  nativeBalance: ethers.parseEther('10'),
  wrappedBalance: ethers.parseEther('4'),
  maxWrappable: ethers.parseEther('9.9'),
  gasReserve: ethers.parseEther('0.1'),
  sponsored: false,
  isVault: false,
  status: 'idle',
  error: null,
  busy: false,
  needsSwitch: false,
  writeRail: { kind: 'signer-same-chain' },
  wrap,
  unwrap,
  refresh: vi.fn(),
  reset: vi.fn(),
})

beforeEach(() => {
  vi.clearAllMocks()
  wrapper.current = base()
  wrapNativeCalls.current = []
  coinOptions.current = { options: [ETC_OPTION, POL_OPTION], defaultKey: ETC_OPTION.key }
  acting.current = { isVault: false, isLegacy: false, isHardware: false }
  wrap.mockResolvedValue({ txHash: '0x' + 'a'.repeat(64), sponsored: false })
  unwrap.mockResolvedValue({ txHash: '0x' + 'b'.repeat(64), sponsored: false })
})

const amountBox = () => screen.getByLabelText('Amount')

describe('the wrap form', () => {
  it('offers both directions and starts on wrap', () => {
    render(<WrapView />)
    expect(screen.getByRole('radio', { name: /Wrap ETC → WETC/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Unwrap WETC → ETC/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('wraps the typed amount through the hook', async () => {
    render(<WrapView />)
    await userEvent.type(amountBox(), '1.5')
    await userEvent.click(screen.getByRole('button', { name: 'Wrap ETC' }))
    expect(wrap).toHaveBeenCalledWith('1.5')
    expect(unwrap).not.toHaveBeenCalled()
  })

  it('unwraps against the wrapped balance once the direction is flipped', async () => {
    render(<WrapView />)
    await userEvent.click(screen.getByRole('radio', { name: /Unwrap/ }))
    await userEvent.type(amountBox(), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Unwrap WETC' }))
    expect(unwrap).toHaveBeenCalledWith('2')
    expect(wrap).not.toHaveBeenCalled()
  })

  it('clears the amount when the direction changes, so a wrap amount is never re-submitted as an unwrap', async () => {
    render(<WrapView />)
    await userEvent.type(amountBox(), '9')
    await userEvent.click(screen.getByRole('radio', { name: /Unwrap/ }))
    expect(amountBox()).toHaveValue('')
  })

  it('will not submit an empty or over-balance amount', async () => {
    render(<WrapView />)
    const submit = screen.getByRole('button', { name: 'Wrap ETC' })
    expect(submit).toBeDisabled()
    await userEvent.type(amountBox(), '11')
    expect(submit).toBeDisabled()
    expect(screen.getByText(/exceeds your ETC/)).toBeInTheDocument()
  })

  it('separates “more than you hold” from “leaves nothing for the fee”', async () => {
    render(<WrapView />)
    await userEvent.type(amountBox(), '9.95') // held: 10, spendable: 9.9
    expect(screen.getByText(/leaves nothing for the network fee/)).toBeInTheDocument()
    expect(screen.queryByText(/exceeds your ETC/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Wrap ETC' })).toBeDisabled()
  })
})

describe('what the member is told', () => {
  it('MAX offers the spendable amount and discloses the fee hold-back', async () => {
    render(<WrapView />)
    await userEvent.click(screen.getByRole('button', { name: 'MAX' }))
    expect(amountBox()).toHaveValue('9.9')
    expect(screen.getByText(/holds back about 0\.1 ETC for the network fee/)).toBeInTheDocument()
  })

  it('MAX on an unwrap offers the whole wrapped balance — the fee is a different coin', async () => {
    render(<WrapView />)
    await userEvent.click(screen.getByRole('radio', { name: /Unwrap/ }))
    await userEvent.click(screen.getByRole('button', { name: 'MAX' }))
    expect(amountBox()).toHaveValue('4.0')
  })

  it('states the network fee, and does not claim sponsorship it does not have', () => {
    render(<WrapView />)
    expect(screen.getByText('You pay the ETC network fee')).toBeInTheDocument()
    expect(screen.queryByText(/Sponsored/)).toBeNull()
  })

  it('says sponsored only when the op actually is', () => {
    wrapper.current = { ...base(), sponsored: true }
    render(<WrapView />)
    expect(screen.getByText('Sponsored — no network fee')).toBeInTheDocument()
  })

  it('states the 1:1 rate rather than implying a price', async () => {
    render(<WrapView />)
    await userEvent.type(amountBox(), '3')
    expect(screen.getByText('1:1 — no price, no slippage')).toBeInTheDocument()
    expect(screen.getByText('3 WETC')).toBeInTheDocument() // received, same number
  })

  it('rounds balances for display only — MAX still fills the full-precision amount (spec 102)', async () => {
    const raw = 2006441459389172406n // 2.006441459389172406 ETC, the staging overflow
    wrapper.current = { ...base(), nativeBalance: raw, maxWrappable: raw }
    const { container } = render(<WrapView />)
    const tiles = container.querySelectorAll('.pt-wrap-balance-val')
    expect(tiles[0]).toHaveTextContent('2.0064')
    expect(screen.getByText(/^Balance:/, { selector: '#pt-wrap-amount-hint' })).toHaveTextContent('Balance: 2.0064 ETC')
    expect(document.body.textContent).not.toContain('2.006441459389172406')
    await userEvent.click(screen.getByRole('button', { name: 'MAX' }))
    expect(amountBox()).toHaveValue('2.006441459389172406')
  })

  it('renders an unread balance as “—” and never as zero', () => {
    wrapper.current = { ...base(), nativeBalance: null, maxWrappable: null }
    render(<WrapView />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText(/could not be read just now — it is not zero/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MAX' })).toBeDisabled()
  })

  it('offers nothing on a network with no wrapped coin, and says why', () => {
    wrapper.current = { ...base(), available: false, token: null }
    render(<WrapView />)
    expect(screen.getByRole('status')).toHaveTextContent(/no wrapped coin configured/)
    expect(screen.queryByRole('button', { name: /Wrap/ })).toBeNull()
    expect(screen.queryByLabelText('Amount')).toBeNull()
  })

  it('surfaces a failure in place instead of reporting success', async () => {
    wrap.mockRejectedValue(new Error('insufficient funds for gas'))
    render(<WrapView />)
    await userEvent.type(amountBox(), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Wrap ETC' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('insufficient funds for gas')
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('reports a pending submission as still confirming, not as done', async () => {
    wrap.mockResolvedValue({ txHash: null, pending: true, userOpHash: '0xuserop' })
    render(<WrapView />)
    await userEvent.type(amountBox(), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Wrap ETC' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/still confirming on-chain/)
    // A userOpHash is not a transaction hash, so nothing links out to an explorer for one.
    expect(screen.queryByRole('link', { name: 'View transaction' })).toBeNull()
  })

  it('links a confirmed wrap to the explorer', async () => {
    render(<WrapView />)
    await userEvent.type(amountBox(), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Wrap ETC' }))
    const link = await screen.findByRole('link', { name: 'View transaction' })
    expect(link).toHaveAttribute('href', expect.stringContaining('/tx/0xaaa'))
  })
})

describe('acting as a vault', () => {
  it('proposes rather than sends, and says so', async () => {
    wrapper.current = { ...base(), isVault: true }
    wrap.mockResolvedValue({ txHash: null, proposed: true, safeTxHash: '0xsafe' })
    render(<WrapView />)
    expect(screen.getByRole('button', { name: 'Propose' })).toBeInTheDocument()
    expect(screen.getByText('Vault proposal')).toBeInTheDocument()
    await userEvent.type(amountBox(), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Propose' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/signers must approve/)
  })
})

describe('accessibility', () => {
  it('has no detectable violations', async () => {
    const { container } = render(<WrapView />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('the coin picker (spec 108) — the asset is the entry point', () => {
  it('lists every offered coin with its network, and targets the hook at the selection', async () => {
    const user = userEvent.setup()
    render(<WrapView />)
    // The default selection (the connected chain's coin) is what the hook was asked for.
    expect(wrapNativeCalls.current.at(-1)).toEqual({ chainId: 61 })

    await user.click(screen.getByRole('button', { name: 'Coin to wrap' }))
    const polygonRow = screen.getByRole('option', { name: /POL.*Polygon/ })
    expect(polygonRow).toBeInTheDocument()
    await user.click(polygonRow)
    expect(wrapNativeCalls.current.at(-1)).toEqual({ chainId: 137 })
  })

  it('clears the amount when the coin changes — a MAX quoted on one chain never rides to another', async () => {
    const user = userEvent.setup()
    render(<WrapView />)
    await user.type(amountBox(), '2.5')
    expect(amountBox()).toHaveValue('2.5')
    await user.click(screen.getByRole('button', { name: 'Coin to wrap' }))
    await user.click(screen.getByRole('option', { name: /POL.*Polygon/ }))
    expect(amountBox()).toHaveValue('')
  })

  it('discloses the coming wallet switch exactly when the target is not the connected chain', async () => {
    wrapper.current = { ...base(), needsSwitch: true, writeRail: { kind: 'signer-switch' }, networkName: 'Polygon', nativeSymbol: 'POL' }
    render(<WrapView />)
    expect(screen.getByText(/your wallet will be asked to switch/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Wrap POL on Polygon/ })).toBeInTheDocument()
  })

  it('renders an unavailable rail’s reason in place of the submit control', () => {
    wrapper.current = {
      ...base(),
      writeRail: { kind: 'unavailable', reason: 'No bundler is configured for this network.' },
    }
    render(<WrapView />)
    expect(screen.getByTestId('wrap-rail-unavailable')).toHaveTextContent(/no bundler/i)
    expect(screen.queryByRole('button', { name: /^Wrap / })).not.toBeInTheDocument()
  })

  it('says an unreadable balance is unknown, not zero, and keeps the coin usable', async () => {
    coinOptions.current = {
      options: [{ ...ETC_OPTION, balance: null, readState: 'unreadable' }, POL_OPTION],
      defaultKey: ETC_OPTION.key,
    }
    render(<WrapView />)
    expect(screen.getByText(/unknown, not zero/i)).toBeInTheDocument()
    // An unknown balance is not a refusal: with an amount typed, the submit stays offered —
    // the chain itself is the arbiter of sufficiency, not a read that failed.
    await userEvent.type(amountBox(), '1')
    expect(screen.getByRole('button', { name: /^Wrap ETC/ })).toBeEnabled()
  })

  it('pins the picker to the acting account’s chain while operating as a vault', async () => {
    const user = userEvent.setup()
    acting.current = { isVault: true, isLegacy: false, isHardware: false }
    wrapper.current = { ...base(), isVault: true }
    render(<WrapView />)
    await user.click(screen.getByRole('button', { name: 'Coin to wrap' }))
    expect(screen.getByRole('option', { name: /ETC.*Ethereum Classic/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /POL.*Polygon/ })).not.toBeInTheDocument()
  })
})
