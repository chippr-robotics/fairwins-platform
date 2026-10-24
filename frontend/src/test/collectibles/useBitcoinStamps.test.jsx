/**
 * useBitcoinStamps (spec 061, T031) — data-source behavior: ledger-driven
 * address set, gateway stamps fetch, hidden soft-fail (no addresses / module
 * off), fail-safe degraded handling, testnet/mainnet scoping (FR-021).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { WalletContext } from '../../contexts'
import { useBitcoinStamps } from '../../hooks/useBitcoinStamps'

const ACCOUNT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

const makeStore = (byKey = {}) => ({
  get: (account, networkId) =>
    byKey[`${account.toLowerCase()}:${networkId}`] ?? { issued: [], preferredType: 'segwit' },
})

const issuedEntry = (address, networkId) => ({
  address,
  type: 'segwit',
  index: 0,
  network: networkId,
  firstShownAt: '2026-07-20T00:00:00Z',
})

let latest
function Probe({ gateway, store }) {
  latest = useBitcoinStamps({ gateway, store })
  return null
}

async function renderHook({ gateway, store, wallet } = {}) {
  await act(async () => {
    render(
      <WalletContext.Provider value={wallet ?? { address: ACCOUNT, isConnected: true }}>
        <Probe gateway={gateway} store={store} />
      </WalletContext.Provider>,
    )
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setWalletChain(137)
  latest = undefined
})

describe('useBitcoinStamps', () => {
  it('fetches stamps for the ledger addresses on the active bitcoin network', async () => {
    const getStamps = vi.fn().mockResolvedValue({
      ok: true,
      degraded: false,
      stamps: [{ stampId: 'S1', outpoint: { txid: 'aa'.repeat(32), vout: 0 } }],
    })
    const store = makeStore({
      [`${ACCOUNT.toLowerCase()}:bitcoin`]: {
        issued: [issuedEntry('bc1qone', 'bitcoin'), issuedEntry('bc1qtwo', 'bitcoin')],
        preferredType: 'segwit',
      },
    })
    await renderHook({ gateway: { getStamps }, store })
    await waitFor(() => expect(latest.status).toBe('ready'))

    expect(getStamps).toHaveBeenCalledWith('bitcoin', ['bc1qone', 'bc1qtwo'])
    expect(latest.stamps).toHaveLength(1)
    expect(latest.networkId).toBe('bitcoin')
  })

  it('scopes to bitcoin-testnet when the app is in testnet mode (FR-021)', async () => {
    setWalletChain(80002) // Polygon Amoy → testnet mode
    const getStamps = vi.fn().mockResolvedValue({ ok: true, degraded: false, stamps: [] })
    const store = makeStore({
      [`${ACCOUNT.toLowerCase()}:bitcoin-testnet`]: {
        issued: [issuedEntry('tb1qone', 'bitcoin-testnet')],
        preferredType: 'segwit',
      },
    })
    await renderHook({ gateway: { getStamps }, store })
    await waitFor(() => expect(latest.status).toBe('empty'))
    expect(getStamps).toHaveBeenCalledWith('bitcoin-testnet', ['tb1qone'])
  })

  it('stays hidden with NO gateway calls when the member has no bitcoin ledger', async () => {
    const getStamps = vi.fn()
    await renderHook({ gateway: { getStamps }, store: makeStore() })
    expect(latest.status).toBe('hidden')
    expect(getStamps).not.toHaveBeenCalled()
  })

  it('soft-fails to hidden on capability-off verdicts (module disabled)', async () => {
    const getStamps = vi.fn().mockResolvedValue({ ok: false, error: 'bitcoin_disabled', disabled: true })
    const store = makeStore({
      [`${ACCOUNT.toLowerCase()}:bitcoin`]: {
        issued: [issuedEntry('bc1qone', 'bitcoin')],
        preferredType: 'segwit',
      },
    })
    await renderHook({ gateway: { getStamps }, store })
    await waitFor(() => expect(getStamps).toHaveBeenCalled())
    await waitFor(() => expect(latest.status).toBe('hidden'))
  })

  it('reports degraded — never a confident partial list — when recognition degrades (FR-019)', async () => {
    const getStamps = vi.fn().mockResolvedValue({
      ok: true,
      degraded: true,
      stamps: [{ stampId: 'S1', outpoint: { txid: 'aa'.repeat(32), vout: 0 } }],
    })
    const store = makeStore({
      [`${ACCOUNT.toLowerCase()}:bitcoin`]: {
        issued: [issuedEntry('bc1qone', 'bitcoin')],
        preferredType: 'segwit',
      },
    })
    await renderHook({ gateway: { getStamps }, store })
    await waitFor(() => expect(latest.status).toBe('degraded'))
    expect(latest.degraded).toBe(true)
  })
})
