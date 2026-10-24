/**
 * usePredictPositions / usePredictOpenOrders (spec 057) — the connected wallet's Polymarket positions and
 * open (unfilled) orders on the ACTIVE network.
 *
 * Positions are PUBLIC (Data API via the relay-gateway proxy). Open orders are per-user and require the
 * member's OWN CLOB creds, so they are read CLIENT-DIRECT via @polymarket/clob-client — and ONLY when creds
 * are already derived (cached this session), so viewing the portfolio never triggers a wallet prompt. Until
 * the member enables trading, open orders report status 'locked' (an honest "enable trading to see these").
 *
 * Mirror useCollectibles: tolerant WalletContext read, race-safe request ids, full reset on account/chain
 * switch. Off Polygon / no gateway / passkey session → {supported:false} and NO fetches (FR-018).
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletClient } from 'wagmi'
import { useWalletChainId } from './useWalletChainId'
import { WalletContext } from '../contexts/WalletContext.js'
import { predictAvailable, fetchPositions } from '../lib/predict/predictClient'
import {
  loadCachedCreds as defaultLoadCachedCreds,
  makeClobClient as defaultMakeClient,
  fetchOpenOrders as defaultFetchOpenOrders,
} from '../lib/predict/clobSession'

const POLYGON = 137

/** The connected wallet's outcome positions — public Data API via the gateway. */
export function usePredictPositions() {
  const wallet = useContext(WalletContext) || {}
  const { address, isConnected } = wallet
  const chainId = useWalletChainId()
  const supported = predictAvailable(chainId)

  const [positions, setPositions] = useState([])
  const [phase, setPhase] = useState('idle') // idle | loading | ready | degraded
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!supported || !isConnected || !address) return
    const reqId = ++reqIdRef.current
    setPhase('loading')
    try {
      const res = await fetchPositions(chainId, address)
      if (reqId !== reqIdRef.current) return
      setPositions(Array.isArray(res?.positions) ? res.positions : [])
      setPhase('ready')
    } catch {
      if (reqId !== reqIdRef.current) return
      setPositions([])
      setPhase('degraded')
    }
  }, [supported, isConnected, address, chainId])

  useEffect(() => {
    reqIdRef.current++
    setPositions([])
    setPhase('idle')
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId, supported])

  return useMemo(() => {
    let status = 'ready'
    if (!supported) status = 'unsupported'
    else if (!isConnected || !address) status = 'disconnected'
    else if (phase === 'idle' || phase === 'loading') status = 'loading'
    else if (phase === 'degraded') status = 'degraded'
    else if (positions.length === 0) status = 'empty'
    return { positions, supported, status, chainId, address, refresh: load }
  }, [supported, isConnected, address, chainId, positions, phase, load])
}

/** The connected wallet's open (unfilled) orders — client-direct via the SDK, only when creds are cached. */
export function usePredictOpenOrders(options = {}) {
  const wallet = useContext(WalletContext) || {}
  const { address, isConnected, loginMethod } = wallet
  const chainId = useWalletChainId()
  const { data: hookWalletClient } = useWalletClient()
  const walletClient = options.walletClient ?? hookWalletClient
  const deps = useMemo(
    () => ({
      loadCachedCreds: defaultLoadCachedCreds,
      makeClient: defaultMakeClient,
      fetchOpenOrders: defaultFetchOpenOrders,
      ...options.deps,
    }),
    [options.deps]
  )
  // Open orders need per-user creds + an EOA wallet client; passkey trading is deferred.
  const supported = predictAvailable(chainId) && Number(chainId) === POLYGON && loginMethod !== 'passkey'

  const [orders, setOrders] = useState([])
  const [phase, setPhase] = useState('idle') // idle | loading | ready | degraded | locked
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!supported || !isConnected || !address || !walletClient) return
    const creds = deps.loadCachedCreds(address)
    if (!creds) {
      setOrders([])
      setPhase('locked') // creds not derived yet — don't prompt just to read the portfolio
      return
    }
    const reqId = ++reqIdRef.current
    setPhase('loading')
    try {
      const client = deps.makeClient(walletClient, creds, {})
      const list = await deps.fetchOpenOrders(client, {})
      if (reqId !== reqIdRef.current) return
      setOrders(Array.isArray(list) ? list : [])
      setPhase('ready')
    } catch {
      if (reqId !== reqIdRef.current) return
      setOrders([])
      setPhase('degraded')
    }
  }, [supported, isConnected, address, walletClient, deps])

  useEffect(() => {
    reqIdRef.current++
    setOrders([])
    setPhase('idle')
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId, supported, walletClient])

  return useMemo(() => {
    let status = 'ready'
    if (!supported) status = 'unsupported'
    else if (!isConnected || !address) status = 'disconnected'
    else if (phase === 'locked') status = 'locked'
    else if (phase === 'idle' || phase === 'loading') status = 'loading'
    else if (phase === 'degraded') status = 'degraded'
    else if (orders.length === 0) status = 'empty'
    return { orders, supported, status, chainId, address, refresh: load }
  }, [supported, isConnected, address, chainId, orders, phase, load])
}
