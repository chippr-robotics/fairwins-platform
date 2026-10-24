/**
 * usePredictTrade (spec 057) — orchestrates a buy/sell CLOB trade for one market outcome via the official
 * viem-native @polymarket/clob-client, CLIENT-DIRECT to clob.polymarket.com (CLOB V2 binds every order to
 * its signer, so a shared gateway key can't relay orders — each member trades with their OWN derived creds).
 *
 * Flow: check the region (Polymarket geoblock) → verify the account can sign → load the honest fee schedule
 * → enable trading (derive the member's CLOB creds, one gasless signature, cached per session; passkey
 * sessions first batch the exchange approvals through sendCalls — one ceremony, deploys the account) →
 * submit (the SDK builds/signs/posts the order and stacks FairWins' POLY_BUILDER_* attribution via the
 * gateway). EOAs sign with the walletClient (signatureType 0); passkey accounts sign ERC-1271
 * (signatureType 3, maker == signer == funder == the account) via lib/predict/passkeyClobSigner.
 *
 * Honest-state guarantees: restricted regions get an honest notice + a deep link OUT to Polymarket (we
 * respect Polymarket's regional policy, never bypass it, FR-019); signing is blocked when the fee schedule
 * can't be confirmed (FR-010) or the account can't sign (FR-019); the previewed builder fee is always a
 * visible line (FR-012); on any error the member still has the "trade on Polymarket" path (FR-017). All
 * external calls are injectable for tests.
 */
import { useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useWalletClient } from 'wagmi'
import { useWalletChainId } from './useWalletChainId'
import { WalletContext } from '../contexts/WalletContext.js'
import { readSession } from '../connectors/passkey'
import { computeCost as defaultComputeCost } from '../lib/predict/clobOrder'
import { resolveTradeSigner as defaultResolveTradeSigner } from '../lib/predict/tradeSigner'
import { fetchFeeRate as defaultFetchFeeRate, predictGatewayUrl } from '../lib/predict/predictClient'
import { checkGeoblock as defaultCheckGeoblock } from '../lib/predict/geoblock'
import { makePasskeyClobSigner as defaultMakePasskeySigner } from '../lib/predict/passkeyClobSigner'
import { missingPredictApprovals as defaultMissingApprovals } from '../lib/predict/passkeyApprovals'
import {
  ensureClobCreds as defaultEnsureCreds,
  makeClobClient as defaultMakeClient,
  makeBuilderConfig as defaultMakeBuilderConfig,
  submitOrder as defaultSubmitOrder,
  cancelOrder as defaultCancelOrder,
  loadCachedCreds as defaultLoadCachedCreds,
  SIG_TYPE_POLY_1271,
} from '../lib/predict/clobSession'

const POLYGON = 137
const isRegionError = (e) =>
  e?.raw?.status === 403 || e?.status === 403 || /geoblock|restricted in your region|region/i.test(String(e?.message ?? e?.raw?.error ?? ''))
const isPriceMove = (e) => /price|tick|marketable|not enough|match/i.test(String(e?.message ?? e?.raw?.error ?? ''))

export function usePredictTrade(options = {}) {
  const optionDeps = options.deps
  const deps = useMemo(
    () => ({
      checkGeoblock: defaultCheckGeoblock,
      fetchFeeRate: defaultFetchFeeRate,
      ensureCreds: defaultEnsureCreds,
      makeClient: defaultMakeClient,
      makeBuilderConfig: defaultMakeBuilderConfig,
      submitOrder: defaultSubmitOrder,
      cancelOrder: defaultCancelOrder,
      computeCost: defaultComputeCost,
      resolveTradeSigner: defaultResolveTradeSigner,
      loadCachedCreds: defaultLoadCachedCreds,
      makePasskeySigner: defaultMakePasskeySigner,
      missingApprovals: defaultMissingApprovals,
      readSession,
      gatewayUrl: predictGatewayUrl,
      ...optionDeps,
    }),
    [optionDeps]
  )
  const walletCtx = useContext(WalletContext)
  const wallet = useMemo(() => walletCtx || {}, [walletCtx])
  const { data: hookWalletClient } = useWalletClient()
  const walletClient = options.walletClient ?? hookWalletClient
  const activeChainId = useWalletChainId()

  const [status, setStatus] = useState('idle') // idle|checking|geoblocked|blocked|ready|enabling|signing|submitting|done|error
  const [reason, setReason] = useState(null)
  const [geoInfo, setGeoInfo] = useState(null)
  const [fee, setFee] = useState(null)
  const [result, setResult] = useState(null)
  const reqRef = useRef(0)

  const onWrongNetwork = Number(activeChainId) !== POLYGON

  // Read fresh every render (a cheap storage read): the session credential can change WITHOUT the
  // address changing (re-sign-in with a different controller of the same account), and a memo keyed
  // on the address would keep signing ceremonies pinned to the stale credential.
  const sessionCredentialId = wallet.loginMethod === 'passkey' ? (deps.readSession()?.credentialId ?? null) : null

  const signer = useMemo(
    () =>
      deps.resolveTradeSigner({
        loginMethod: wallet.loginMethod,
        walletClient,
        address: wallet.address,
        credentialId: sessionCredentialId,
      }),
    [wallet.loginMethod, wallet.address, walletClient, sessionCredentialId, deps]
  )

  const tradingEnabled = useMemo(
    () => Boolean(wallet.address && deps.loadCachedCreds(wallet.address)),
    [wallet.address, deps]
  )

  /** Ensure the wallet is on Polygon before an order bound to it is signed (FR-021). */
  const ensureNetwork = useCallback(async () => {
    if (!onWrongNetwork) return true
    try {
      if (wallet.switchChain) await wallet.switchChain({ chainId: POLYGON })
      else if (wallet.switchNetwork) await wallet.switchNetwork(POLYGON)
      else return false
      return true
    } catch {
      return false
    }
  }, [onWrongNetwork, wallet])

  /** Region check + live fee schedule. Restricted region -> 'geoblocked' (link out); fee failure -> blocked. */
  const loadFee = useCallback(
    async (tokenId) => {
      if (!signer.canSign) {
        setStatus('blocked')
        setReason(signer.reason)
        return null
      }
      const req = ++reqRef.current
      setStatus('checking')
      setReason(null)
      setGeoInfo(null)
      try {
        const geo = await deps.checkGeoblock()
        if (req !== reqRef.current) return null
        if (geo?.blocked) {
          setGeoInfo({ country: geo.country, region: geo.region })
          setStatus('geoblocked')
          return null
        }
        const f = await deps.fetchFeeRate(POLYGON, tokenId)
        if (req !== reqRef.current) return null
        setFee(f)
        setStatus('ready')
        return f
      } catch {
        if (req !== reqRef.current) return null
        setStatus('blocked')
        setReason("Couldn't confirm the fees — try again before trading.")
        return null
      }
    },
    [signer, deps]
  )

  /** Pure preview of the honest total/net (incl. the additive builder fee) — nothing signed. */
  const preview = useCallback((params) => (fee ? deps.computeCost(params, fee) : null), [fee, deps])

  /**
   * The signer object handed to the SDK: the viem walletClient for EOAs, or the ERC-1271 shim for
   * passkey sessions (signatureType 3 — maker == signer == funder == the account).
   */
  const buildSdkSigner = useCallback(async () => {
    if (signer.kind !== 'passkey') return walletClient
    return deps.makePasskeySigner({ chainId: POLYGON, address: wallet.address, credentialId: signer.credentialId })
  }, [signer, walletClient, wallet.address, deps])

  /**
   * Passkey first-trade prerequisite: the CLOB settles on-chain against the MAKER, so the account
   * must have approved the exchange contracts. One batched ceremony via sendCalls covers every
   * missing approval (and deploys a counterfactual account, spec 041 FR-007); an already-approved
   * account skips straight through with reads only. EOAs manage allowances on Polymarket itself.
   */
  const ensureApprovals = useCallback(async () => {
    if (signer.kind !== 'passkey') return
    const missing = await deps.missingApprovals({ address: wallet.address, chainId: POLYGON })
    if (!missing.length) return
    // Pinned to Polygon by parameter, not by session state: these approvals are only correct on the
    // chain the CLOB settles on, and a just-completed ensureNetwork() switch is React state a
    // running closure cannot yet see. sendCalls resolves at an honest terminal state (FR-017).
    await wallet.sendCalls(
      missing.map(({ target, data }) => ({ target, data })),
      { chainId: POLYGON }
    )
  }, [signer, wallet, deps])

  /** Derive (or reuse) the member's own CLOB creds — one gasless signature, cached per session. */
  const ensureCreds = useCallback(async () => {
    const sdkSigner = await buildSdkSigner()
    return deps.ensureCreds(sdkSigner, { address: wallet.address })
  }, [deps, buildSdkSigner, wallet.address])

  /** Explicit "enable trading" step (approvals + creds up front). Optional — submit() does it lazily too. */
  const enableTrading = useCallback(async () => {
    if (!signer.canSign) {
      setStatus('blocked')
      setReason(signer.reason)
      return false
    }
    // Same Polygon gate as submit() (FR-021): the wallet ends up where the trade will be signed,
    // and the approvals ceremony is never offered from the wrong chain's context.
    if (!(await ensureNetwork())) {
      setStatus('error')
      setReason('Switch your wallet to Polygon to trade on Polymarket.')
      return false
    }
    setStatus('enabling')
    setReason(null)
    try {
      await ensureApprovals()
      await ensureCreds()
      setStatus('ready')
      return true
    } catch (e) {
      setStatus('error')
      setReason(e?.message || 'Could not enable trading. You can still trade on Polymarket directly.')
      return false
    }
  }, [signer, ensureNetwork, ensureApprovals, ensureCreds])

  /** Build + sign + submit an order (the SDK does all three; attribution rides on the builder config). */
  const submit = useCallback(
    async (params, { negRisk = false } = {}) => {
      if (!fee || !signer.canSign) {
        setStatus('blocked')
        setReason(signer.reason || "Couldn't confirm the fees.")
        return null
      }
      if (!(await ensureNetwork())) {
        setStatus('error')
        setReason('Switch your wallet to Polygon to trade on Polymarket.')
        return null
      }
      const req = ++reqRef.current
      setStatus('signing')
      setReason(null)
      try {
        await ensureApprovals()
        const creds = await ensureCreds()
        if (req !== reqRef.current) return null
        const builderConfig = deps.makeBuilderConfig(deps.gatewayUrl(), POLYGON)
        const sdkSigner = await buildSdkSigner()
        const client = deps.makeClient(sdkSigner, creds, {
          builderConfig,
          ...(signer.kind === 'passkey'
            ? { signatureType: SIG_TYPE_POLY_1271, funderAddress: wallet.address }
            : {}),
        })
        setStatus('submitting')
        const submitted = await deps.submitOrder(client, {
          tokenId: params.tokenId,
          side: params.side,
          price: params.price,
          size: params.size,
          negRisk,
        })
        if (req !== reqRef.current) return null
        if (isRegionError(submitted)) {
          setGeoInfo(null)
          setStatus('geoblocked')
          return null
        }
        setResult({ kind: 'submitted', ...submitted })
        setStatus('done')
        return submitted
      } catch (e) {
        if (req !== reqRef.current) return null
        if (isRegionError(e)) {
          setStatus('geoblocked')
          return null
        }
        if (isPriceMove(e)) {
          setStatus('error')
          setReason('The market moved — review the current price before trading.')
          return { priceChanged: true }
        }
        setStatus('error')
        setReason(e?.message || 'The order could not be submitted. You can still trade on Polymarket directly.')
        return null
      }
    },
    [fee, signer, ensureNetwork, ensureApprovals, ensureCreds, buildSdkSigner, wallet.address, deps]
  )

  /** Cancel an open order (gas-free CLOB cancel) with the member's own creds. */
  const cancel = useCallback(
    async (order) => {
      if (!signer.canSign) {
        setStatus('blocked')
        setReason(signer.reason)
        return null
      }
      const req = ++reqRef.current
      setStatus('submitting')
      setReason(null)
      try {
        // Cancels need creds only — no approvals (nothing settles on-chain for a cancel).
        const creds = await ensureCreds()
        const sdkSigner = await buildSdkSigner()
        const client = deps.makeClient(sdkSigner, creds, {
          ...(signer.kind === 'passkey'
            ? { signatureType: SIG_TYPE_POLY_1271, funderAddress: wallet.address }
            : {}),
        })
        const res = await deps.cancelOrder(client, order.orderId ?? order.id)
        if (req !== reqRef.current) return null
        setResult({ kind: 'cancelled', ...res })
        setStatus('done')
        return res
      } catch (e) {
        if (req !== reqRef.current) return null
        setStatus('error')
        setReason(e?.message || 'The order could not be cancelled. You can still cancel it on Polymarket.')
        return null
      }
    },
    [signer, ensureCreds, buildSdkSigner, wallet.address, deps]
  )

  const reset = useCallback(() => {
    reqRef.current++
    setStatus('idle')
    setReason(null)
    setResult(null)
    setGeoInfo(null)
  }, [])

  return {
    status,
    reason,
    geoInfo,
    fee,
    result,
    canTrade: signer.canSign,
    signerKind: signer.kind,
    unsupportedReason: signer.canSign ? null : signer.reason,
    onWrongNetwork,
    tradingEnabled,
    loadFee,
    preview,
    enableTrading,
    submit,
    cancel,
    reset,
  }
}

export default usePredictTrade
