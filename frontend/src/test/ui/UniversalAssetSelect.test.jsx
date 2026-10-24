/**
 * UniversalAssetSelect — balance display (spec 102, FR-018).
 *
 * Option balances arrive as the full-precision decimal strings the balance hooks produce
 * (`useSwapBalances`, `useSelectableAssets`). The picker shapes them for display only: the
 * option object handed back through `onChange` — which callers use for MAX and validation —
 * carries the balance exactly as it came in.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import UniversalAssetSelect from '../../components/ui/UniversalAssetSelect'

const RAW = '2.006441459389172406'

const options = [
  { key: '61:native', chainId: 61, kind: 'native', address: null, symbol: 'ETC', name: 'Ethereum Classic', decimals: 18, networkName: 'Ethereum Classic', balance: RAW },
  { key: '61:usdc', chainId: 61, kind: 'erc20', address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6, networkName: 'Ethereum Classic', balance: '1234.567891' },
  { key: '61:dust', chainId: 61, kind: 'erc20', address: '0x0000000000000000000000000000000000000001', symbol: 'DUST', name: 'Dust', decimals: 18, networkName: 'Ethereum Classic', balance: '0.0000000001' },
  { key: '61:pending', chainId: 61, kind: 'erc20', address: '0x0000000000000000000000000000000000000002', symbol: 'PEND', name: 'Pending', decimals: 18, networkName: 'Ethereum Classic', balance: null },
]

describe('UniversalAssetSelect — balances are formatted at render only', () => {
  it('shows an 18-decimal balance as 2.0064 on the trigger and in the list, never the raw string', async () => {
    const onChange = vi.fn()
    render(<UniversalAssetSelect options={options} value="61:native" onChange={onChange} />)

    const trigger = screen.getByRole('button', { name: 'Asset' })
    expect(trigger).toHaveTextContent('Balance: 2.0064')
    expect(screen.queryByText(new RegExp(RAW))).toBeNull()

    await userEvent.click(trigger)
    const list = screen.getByRole('listbox')
    const etc = within(list).getByRole('option', { name: /ETC/ })
    expect(etc).toHaveTextContent('Balance: 2.0064')
    expect(within(list).getByRole('option', { name: /USDC/ })).toHaveTextContent('Balance: 1,234.5679')
    expect(within(list).getByRole('option', { name: /DUST/ })).toHaveTextContent('Balance: < 0.000001')
    expect(document.body.textContent).not.toContain(RAW)

    // The option handed back is the caller's own object — full precision intact for MAX/validation.
    await userEvent.click(etc)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ key: '61:native', balance: RAW }))
    expect(onChange.mock.calls[0][0]).toBe(options[0])
  })

  it('keeps the pending mark for an unread balance rather than rendering zero', async () => {
    render(<UniversalAssetSelect options={options} value="61:pending" />)
    const trigger = screen.getByRole('button', { name: 'Asset' })
    expect(within(trigger).getByLabelText('balance loading')).toHaveTextContent('…')
    expect(trigger).not.toHaveTextContent('Balance: 0')
  })
})
