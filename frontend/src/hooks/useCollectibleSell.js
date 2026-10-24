/**
 * useCollectibleSell (spec 056) — orchestrates list / accept-offer / cancel for one owned
 * collectible: fetch live fees → verify network + account can sign → confirm (honest net) → sign
 * (EOA or passkey) → publish/submit. The state machine follows data-model.md.
 *
 * Honest-state guarantees: signing is BLOCKED when fees can't be confirmed (FR-009) or the account
 * type can't sign (FR-019, honest reason — never a dead button); the previewed net EQUALS the signed
 * order's seller receipt (FR-010, both from buildOrder); on any error the caller still has the
 * "View on OpenSea" path (never stranded, FR-017). All external calls are injectable for tests.
 */
import { useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { WalletContext } from '../contexts/WalletContext.js'
import { buildOrder as defaultBuildOrder } from '../lib/collectibles/seaportOrder'
import { resolveOrderSigner as defaultResolveOrderSigner } from '../lib/collectibles/orderSigner'
import {
  fetchRequiredFees as defaultFetchRequiredFees,
  publishListing as defaultPublishListing,
  cancelListing as defaultCancelListing,
  fetchOfferFulfillment as defaultFetchOfferFulfillment,
} from '../lib/collectibles/sellClient'

/** Default on-chain submit for accept-offer: an EOA sends the tx via its ethers signer. */
async function defaultSubmitTransaction({ wallet, tx }) {
  if (!wallet?.signer?.sendTransaction) throw new Error('no signer to submit the transaction')
  const sent = await wallet.signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? '0' })
  return { txHash: sent.hash ?? sent }
}

export function useCollectibleSell(item, options = {}) {
  const optionDeps = options.deps
  const deps = useMemo(
    () => ({
      fetchRequiredFees: defaultFetchRequiredFees,
      publishListing: defaultPublishListing,
      cancelListing: defaultCancelListing,
      fetchOfferFulfillment: defaultFetchOfferFulfillment,
      buildOrder: defaultBuildOrder,
      resolveOrderSigner: defaultResolveOrderSigner,
      submitTransaction: defaultSubmitTransaction,
      readCounter: async () => 0, // Seaport getCounter(offerer); 0 is the common case, injectable for real reads
      ...optionDeps,
    }),
    [optionDeps]
  )
  const walletCtx = useContext(WalletContext)
  const wallet = useMemo(() => walletCtx || {}, [walletCtx])
  const activeChainId = useWalletChainId()

  const [status, setStatus] = useState('idle') // idle|checking|ready|blocked|signing|submitting|done|error
  const [reason, setReason] = useState(null)
  const [fees, setFees] = useState(null)
  const [result, setResult] = useState(null)
  const reqRef = useRef(0)

  const itemChainId = item?.chainId
  const onWrongNetwork = Boolean(item) && Number(activeChainId) !== Number(itemChainId)

  const signer = useMemo(
    () =>
      deps.resolveOrderSigner({
        loginMethod: wallet.loginMethod,
        signer: wallet.signer,
        address: wallet.address,
        chainId: itemChainId,
        passkey: options.passkey,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet.loginMethod, wallet.signer, wallet.address, itemChainId, options.passkey]
  )

  /** Ensure the wallet is on the item's network before signing an order bound to it (FR-021). */
  const ensureNetwork = useCallback(async () => {
    if (!onWrongNetwork) return true
    try {
      if (wallet.switchChain) await wallet.switchChain({ chainId: itemChainId })
      else if (wallet.switchNetwork) await wallet.switchNetwork(itemChainId)
      else return false
      return true
    } catch {
      return false
    }
  }, [onWrongNetwork, wallet, itemChainId])

  /** Load the live fee basis for the confirm step. Fee failure BLOCKS signing (FR-009). */
  const loadFees = useCallback(async () => {
    if (!item?.collectionSlug) {
      setStatus('blocked')
      setReason('This item is not part of a known collection.')
      return null
    }
    if (!signer.canSign) {
      setStatus('blocked')
      setReason(signer.reason)
      return null
    }
    const req = ++reqRef.current
    setStatus('checking')
    setReason(null)
    try {
      const f = await deps.fetchRequiredFees(itemChainId, item.collectionSlug)
      if (req !== reqRef.current) return null
      setFees(f)
      setStatus('ready')
      return f
    } catch {
      if (req !== reqRef.current) return null
      setStatus('blocked')
      setReason("Couldn't confirm the marketplace fees — try again before listing.")
      return null
    }
  }, [item, signer, itemChainId, deps])

  /** Pure preview of net proceeds for a price, using the loaded fees (nothing signed). */
  const preview = useCallback(
    (price) => {
      if (!fees) return null
      const built = deps.buildOrder(item, price, fees, { offerer: wallet.address, counter: 0 })
      return { net: built.net, feeLines: built.feeLines, belowFloor: built.belowFloor, currency: built.currency }
    },
    [fees, item, wallet.address, deps]
  )

  /** Build + sign + publish a listing. */
  const submitListing = useCallback(
    async (price, { expirySeconds } = {}) => {
      if (!fees || !signer.canSign) {
        setStatus('blocked')
        setReason(signer.reason || "Couldn't confirm the marketplace fees.")
        return null
      }
      if (!(await ensureNetwork())) {
        setStatus('error')
        setReason(`Switch your wallet to ${item.chainId === 1 ? 'Ethereum' : 'Polygon'} to list this item.`)
        return null
      }
      const req = ++reqRef.current
      setStatus('signing')
      setReason(null)
      try {
        const counter = await deps.readCounter({ wallet, chainId: itemChainId, offerer: wallet.address })
        const built = deps.buildOrder(item, price, fees, { offerer: wallet.address, counter, expirySeconds })
        if (built.belowFloor) {
          setStatus('blocked')
          setReason('That price would leave you nothing after fees — raise it above the fee total.')
          return null
        }
        const signature = await signer.sign(built.domain, built.types, built.message)
        if (req !== reqRef.current) return null
        setStatus('submitting')
        const published = await deps.publishListing(itemChainId, {
          order: built.message,
          signature,
          protocolAddress: fees.protocolAddress,
        })
        if (req !== reqRef.current) return null
        setResult({ kind: 'listed', ...published })
        setStatus('done')
        return published
      } catch (e) {
        if (req !== reqRef.current) return null
        setStatus('error')
        setReason(e?.message || 'The listing could not be published. You can still list on OpenSea directly.')
        return null
      }
    },
    [fees, signer, ensureNetwork, item, wallet, itemChainId, deps]
  )

  /** Accept the best offer: fetch fulfillment data, submit the transaction (seller pays gas). */
  const acceptOffer = useCallback(
    async (bestOffer) => {
      if (!signer.canSign) {
        setStatus('blocked')
        setReason(signer.reason)
        return null
      }
      if (!(await ensureNetwork())) {
        setStatus('error')
        setReason(`Switch your wallet to ${item.chainId === 1 ? 'Ethereum' : 'Polygon'} to accept this offer.`)
        return null
      }
      const req = ++reqRef.current
      setStatus('submitting')
      setReason(null)
      try {
        const fulfillment = await deps.fetchOfferFulfillment(itemChainId, {
          orderHash: bestOffer.orderHash,
          fulfiller: wallet.address,
        })
        if (req !== reqRef.current) return null
        const submitted = await deps.submitTransaction({ wallet, tx: fulfillment })
        if (req !== reqRef.current) return null
        setResult({ kind: 'accepted', ...submitted })
        setStatus('done')
        return submitted
      } catch (e) {
        if (req !== reqRef.current) return null
        // A changed/withdrawn offer isn't a failure — ask the seller to review the current one (FR-007).
        if (e?.code === 'offer_changed') {
          setStatus('error')
          setReason('This offer changed — review the current best offer before accepting.')
          return { offerChanged: true }
        }
        setStatus('error')
        setReason(e?.message || 'The offer could not be accepted. You can still accept it on OpenSea.')
        return null
      }
    },
    [signer, ensureNetwork, item, wallet, itemChainId, deps]
  )

  /** Cancel a listing — free off-chain when possible; on-chain (gas) surfaced honestly (FR-008). */
  const cancel = useCallback(
    async (listing) => {
      if (!signer.canSign) {
        setStatus('blocked')
        setReason(signer.reason)
        return null
      }
      const req = ++reqRef.current
      setStatus('submitting')
      setReason(null)
      try {
        let signature
        try {
          // Authorize the off-chain cancel with a lightweight signature when the wallet supports it.
          signature = wallet.signer?.signMessage ? await wallet.signer.signMessage(`cancel:${listing.orderHash}`) : undefined
        } catch {
          signature = undefined
        }
        const res = await deps.cancelListing(itemChainId, { orderHash: listing.orderHash, offerer: wallet.address, signature })
        if (req !== reqRef.current) return null
        if (res.method === 'onchain') {
          // Rare: only an on-chain cancel is possible — disclose and hand off to OpenSea (gas there).
          setStatus('error')
          setReason('This listing can only be cancelled on-chain (costs gas). Cancel it on OpenSea.')
          return res
        }
        setResult({ kind: 'cancelled', ...res })
        setStatus('done')
        return res
      } catch (e) {
        if (req !== reqRef.current) return null
        setStatus('error')
        setReason(e?.message || 'The listing could not be cancelled. You can still cancel it on OpenSea.')
        return null
      }
    },
    [signer, wallet, itemChainId, deps]
  )

  const reset = useCallback(() => {
    reqRef.current++
    setStatus('idle')
    setReason(null)
    setResult(null)
  }, [])

  return {
    status,
    reason,
    fees,
    result,
    canSell: signer.canSign,
    unsupportedReason: signer.canSign ? null : signer.reason,
    onWrongNetwork,
    loadFees,
    preview,
    submitListing,
    acceptOffer,
    cancel,
    reset,
  }
}

export default useCollectibleSell
