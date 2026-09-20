/**
 * useBitcoinStamps (spec 061, T031 — FR-017/FR-019/FR-021) — the member's
 * Bitcoin Stamps for the collectibles surface.
 *
 * Data source: the bitcoin gateway's stamps endpoint, queried with the
 * ISSUED-ADDRESS CACHE (ledgerStore) — never key material, no PRF ceremony.
 * The active bitcoin network follows the app's testnet/mainnet mode via the
 * BITCOIN_TESTNET_MAINNET_PAIR (FR-021), keyed off the active EVM chain's
 * testnet flag.
 *
 * Honest-state statuses (never a spinner forever — the gateway client always
 * settles with a typed result):
 *  - 'hidden'   — no account, no issued bitcoin addresses, or the bitcoin
 *                 module is off/unconfigured (soft-fail, spec-054 pattern);
 *  - 'loading'  — first fetch in flight;
 *  - 'empty'    — recognition healthy, zero stamps (section stays hidden);
 *  - 'ready'    — stamps to show (possibly alongside degraded=true);
 *  - 'degraded' — recognition unavailable/uncertain: no stamp list can be
 *                 trusted, protected-value handling has already failed safe.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { WalletContext } from '../contexts/WalletContext.js'
import { getNetwork } from '../config/networks'
import { getActiveBitcoinNetworkId } from '../config/bitcoinNetworks'
import { createBitcoinGatewayClient, bitcoinGatewayUrl } from '../lib/bitcoin/gatewayClient'
import { ledgerStore } from '../lib/bitcoin/wallet'

export function useBitcoinStamps({ gateway, store } = {}) {
  // Tolerant context read (useCollectibles convention): this hook must
  // soft-fail wherever no wallet context exists, never take the page down.
  const wallet = useContext(WalletContext) || {}
  const { address: account, isConnected } = wallet
  const chainId = useWalletChainId()
  const testnetMode = Boolean(getNetwork(chainId)?.isTestnet)
  const networkId = getActiveBitcoinNetworkId(testnetMode)

  const addresses = useMemo(() => {
    if (!account) return []
    try {
      const s = store ?? ledgerStore()
      return s.get(account, networkId).issued.map((a) => a.address)
    } catch {
      return [] // no storage ⇒ no bitcoin ledger ⇒ nothing to show
    }
  }, [account, networkId, store])

  const enabled = Boolean(isConnected && account && addresses.length > 0 && (gateway || bitcoinGatewayUrl()))

  const [state, setState] = useState({ phase: 'idle', stamps: [], degraded: false })
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!enabled) return
    const reqId = ++reqIdRef.current
    setState((prev) => (prev.phase === 'idle' ? { ...prev, phase: 'loading' } : prev))
    const client = gateway ?? createBitcoinGatewayClient({ baseUrl: bitcoinGatewayUrl() })
    let res
    try {
      res = await client.getStamps(networkId, addresses)
    } catch {
      res = { ok: false, error: 'network_error' }
    }
    if (reqId !== reqIdRef.current) return
    if (!res.ok) {
      // Capability-off ⇒ hide; anything else ⇒ honest degraded state.
      setState({ phase: res.disabled ? 'disabled' : 'degraded', stamps: [], degraded: true })
      return
    }
    setState({
      // Fail-safe (FR-019): a degraded merge means the list cannot be trusted
      // as complete — surface degraded, not a confident partial gallery.
      phase: res.degraded ? 'degraded' : 'ready',
      stamps: res.stamps ?? [],
      degraded: Boolean(res.degraded),
    })
  }, [enabled, gateway, networkId, addresses])

  // Full reset before refetch on account/network change (FR-021: testnet
  // stamps never survive into a mainnet render).
  useEffect(() => {
    reqIdRef.current++
    setState({ phase: 'idle', stamps: [], degraded: false })
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, networkId, enabled])

  return useMemo(() => {
    let status
    if (!enabled || state.phase === 'disabled') status = 'hidden'
    else if (state.phase === 'idle' || state.phase === 'loading') status = 'loading'
    else if (state.phase === 'degraded') status = 'degraded'
    else if (state.stamps.length === 0) status = 'empty'
    else status = 'ready'
    return {
      status,
      networkId,
      stamps: state.stamps,
      degraded: state.degraded,
      refresh: load,
    }
  }, [enabled, state, networkId, load])
}

export default useBitcoinStamps
