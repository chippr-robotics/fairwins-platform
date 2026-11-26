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
 * switch. Off Polygon / no gateway → {supported:false} and NO fetches (FR-018). Positions are off for a passkey
 * session (their gateway read needs no session, so that is the venue-side gate); OPEN ORDERS are read for passkey
 * sessions too (T036c), with the same read-only signer the order tracker uses.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { WalletContext } from '../contexts/WalletContext.js'
import { useVisiblePolling } from './useVisiblePolling'
import { predictAvailable, fetchPositions } from '../lib/predict/predictClient'
import {
  loadCachedCreds as defaultLoadCachedCreds,
  makeClobClient as defaultMakeClient,
  fetchOpenOrders as defaultFetchOpenOrders,
} from '../lib/predict/clobSession'
import { resolveTradeSigner as defaultResolveTradeSigner } from '../lib/predict/tradeSigner'
import { readOnlySigner, readClientOptions } from '../lib/predict/readClient'

const POLYGON = 137

// Self-refresh cadence (spec 114 slice 6, FR-025), visible tab only, backing off ×1.5 while nothing changes.
// Positions come through the gateway, whose Predict reads share ONE 60/min quota per client with the price feed
// (30/min while a ticket or event page is open): 30 s → at most 2/min, up to 120 s when quiet. Open orders are
// read from the venue directly with the member's session, so they cost the gateway nothing: 15 s → 60 s.
export const POSITIONS_POLL = { baseMs: 30_000, maxMs: 120_000 }
export const OPEN_ORDERS_POLL = { baseMs: 15_000, maxMs: 60_000 }

/** The connected wallet's outcome positions — public Data API via the gateway. */
export function usePredictPositions() {
  const wallet = useContext(WalletContext) || {}
  const { address, isConnected } = wallet
  const chainId = useWalletChainId()
  const supported = predictAvailable(chainId)

  const [positions, setPositions] = useState([])
  const [phase, setPhase] = useState('idle') // idle | loading | ready | degraded
  // A background refresh that failed leaves the last good read on screen, SAID to be old (`stale`), never
  // replaced by an empty list: "could not refresh" is not "you hold nothing".
  const [stale, setStale] = useState(false)
  const [readAt, setReadAt] = useState(null)
  const reqIdRef = useRef(0)
  const lastJson = useRef('')

  // `{ silent: true }` is the background refresh: no loading flash. Returns whether the list changed.
  const load = useCallback(async (opts) => {
    if (!supported || !isConnected || !address) return false
    const silent = opts?.silent === true
    const reqId = ++reqIdRef.current
    if (!silent) setPhase('loading')
    try {
      const res = await fetchPositions(chainId, address)
      if (reqId !== reqIdRef.current) return false
      const next = Array.isArray(res?.positions) ? res.positions : []
      const json = JSON.stringify(next)
      const changed = json !== lastJson.current
      lastJson.current = json
      if (changed) setPositions(next)
      setPhase('ready')
      setStale(false)
      setReadAt(Date.now())
      return changed
    } catch {
      if (reqId !== reqIdRef.current) return false
      if (silent && lastJson.current !== '') {
        setStale(true)
        return false
      }
      setPositions([])
      lastJson.current = ''
      setPhase('degraded')
      return false
    }
  }, [supported, isConnected, address, chainId])

  useEffect(() => {
    reqIdRef.current++
    setPositions([])
    setPhase('idle')
    setStale(false)
    lastJson.current = ''
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId, supported])

  useVisiblePolling(() => load({ silent: true }), {
    enabled: supported && Boolean(isConnected && address),
    ...POSITIONS_POLL,
    immediate: false, // the effect above has just loaded
    resetKey: `${address}|${chainId}`,
  })

  return useMemo(() => {
    let status = 'ready'
    if (!supported) status = 'unsupported'
    else if (!isConnected || !address) status = 'disconnected'
    else if (phase === 'idle' || phase === 'loading') status = 'loading'
    else if (phase === 'degraded') status = 'degraded'
    else if (positions.length === 0) status = 'empty'
    return { positions, supported, status, chainId, address, stale, readAt, refresh: load }
  }, [supported, isConnected, address, chainId, positions, phase, stale, readAt, load])
}

/** The connected wallet's open (unfilled) orders — client-direct via the SDK, only when creds are cached. */
export function usePredictOpenOrders(options = {}) {
  const wallet = useContext(WalletContext) || {}
  const { address, isConnected, loginMethod } = wallet
  const chainId = useWalletChainId()
  const deps = useMemo(
    () => ({
      loadCachedCreds: defaultLoadCachedCreds,
      makeClient: defaultMakeClient,
      fetchOpenOrders: defaultFetchOpenOrders,
      resolveTradeSigner: defaultResolveTradeSigner,
      ...options.deps,
    }),
    [options.deps]
  )
  // Open orders are READ with the member's cached CLOB session and a signer that can only name the address (see
  // `lib/predict/readClient`), exactly as the order tracker reads. So a passkey session reads them too — it never
  // derives credentials and never prompts: no cached session means `locked`, not a ceremony.
  const supported = predictAvailable(chainId) && Number(chainId) === POLYGON

  const [orders, setOrders] = useState([])
  const [phase, setPhase] = useState('idle') // idle | loading | ready | degraded | locked
  const [stale, setStale] = useState(false) // a background refresh failed; the last good read is still shown
  const reqIdRef = useRef(0)
  const lastJson = useRef('')

  // `{ silent: true }` is the background refresh: no loading flash, and a failure keeps the last good read
  // (marked `stale`) instead of emptying the list. Returns whether the list changed.
  const load = useCallback(async (opts) => {
    if (!supported || !isConnected || !address) return false
    const silent = opts?.silent === true
    const creds = deps.loadCachedCreds(address)
    if (!creds) {
      setOrders([])
      lastJson.current = ''
      setPhase('locked') // creds not derived yet — don't prompt just to read the portfolio
      return false
    }
    const reqId = ++reqIdRef.current
    if (!silent) setPhase('loading')
    try {
      const client = deps.makeClient(readOnlySigner(address), creds, readClientOptions({ loginMethod, address, resolve: deps.resolveTradeSigner }))
      const list = await deps.fetchOpenOrders(client, {})
      if (reqId !== reqIdRef.current) return false
      const next = Array.isArray(list) ? list : []
      const json = JSON.stringify(next)
      const changed = json !== lastJson.current
      lastJson.current = json
      if (changed) setOrders(next)
      setPhase('ready')
      setStale(false)
      return changed
    } catch {
      if (reqId !== reqIdRef.current) return false
      if (silent && lastJson.current !== '') {
        setStale(true)
        return false
      }
      setOrders([])
      lastJson.current = ''
      setPhase('degraded')
      return false
    }
  }, [supported, isConnected, address, loginMethod, deps])

  useEffect(() => {
    reqIdRef.current++
    setOrders([])
    setPhase('idle')
    setStale(false)
    lastJson.current = ''
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId, supported])

  useVisiblePolling(() => load({ silent: true }), {
    enabled: supported && Boolean(isConnected && address),
    ...OPEN_ORDERS_POLL,
    immediate: false,
    resetKey: `${address}|${chainId}`,
  })

  return useMemo(() => {
    let status = 'ready'
    if (!supported) status = 'unsupported'
    else if (!isConnected || !address) status = 'disconnected'
    else if (phase === 'locked') status = 'locked'
    else if (phase === 'idle' || phase === 'loading') status = 'loading'
    else if (phase === 'degraded') status = 'degraded'
    else if (orders.length === 0) status = 'empty'
    return { orders, supported, status, chainId, address, stale, refresh: load }
  }, [supported, isConnected, address, chainId, orders, phase, stale, load])
}
