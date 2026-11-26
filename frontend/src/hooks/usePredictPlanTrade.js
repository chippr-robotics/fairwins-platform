/**
 * usePredictPlanTrade (spec 114 slice 5) — the plan-first trade flow behind the amount-first order ticket:
 * reading → plan → fees → REVIEW → sign. It COMPOSES `usePredictTrade` rather than copying it, so the region
 * check, the fee gate, the Polygon switch, the passkey approvals ceremony, the credential derivation, the
 * signer rail and the builder attribution are the one implementation they have always been; this hook adds
 * only the plan, the review and the last-moment re-plan, and chooses what `send` posts.
 *
 * States: idle · checking · geoblocked · blocked · waiting-price · planning · review · enabling · signing ·
 * submitting · done · error · moved.
 *  - `waiting-price`: the reading is not live. No figure exists (FR-013) and Review is unavailable.
 *  - `planning`: a live reading and an amount; `view` holds the figures or the plain reason there are none.
 *  - `review`: the figures are frozen and the limit the signature will carry is named; NOTHING has been signed.
 *  - `moved`: the member pressed Sign and the reviewed order could no longer be signed as reviewed (FR-021).
 *    Nothing was signed; the new figures are in `reviewed` and Sign needs another, deliberate press.
 *
 * Signing order on Sign: (1) re-plan against the CURRENT reading — not live ⇒ stop; reviewed limit no longer
 * reaches the depth ⇒ `moved`; (2) first-time setup if needed (one gasless signature; passkey: approvals);
 * (3) re-plan again right before the order is built — the ceremonies can take minutes; (4) sign with the
 * REVIEWED limit and amount, never a newer one. A marketable order is fill-and-kill at that limit; a price the
 * member named rests (GTC) on the tick it was reviewed on. `done` returns what the venue answered, and the
 * order is handed to the progress tracker (`lib/predict/orderProgress`, slice 6) — an answer that never arrived
 * is handed over as `unconfirmed`, with the id computed before the post.
 *
 * `unknown` (passed through from usePredictTrade): the order was sent and the venue's answer never arrived.
 * It is terminal for this ticket — there is no way back to Sign from it, because the same fill-and-kill order
 * sent twice can fill twice.
 *
 * Fees (spec 057 FR-012): an order that rests is a MAKER when it fills, so its quote uses the builder's maker
 * rate; one that crosses the book fills at once as a TAKER. The ceiling of a resting buy assumes whichever of
 * the two is larger, because the book can move between review and arrival — `ceiling.contingent` says the
 * ceiling's fee is not the one expected to apply.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { usePredictTrade } from './usePredictTrade'
import { WalletContext } from '../contexts/WalletContext.js'
import { trackSignedOrder as defaultTrackSignedOrder } from '../lib/predict/orderProgress'
import { computeCostForPlan } from '../lib/predict/clobOrder'
import { planForTicket, checkStillSignable } from '../lib/predict/ticketPlan'
import { reclassify } from '../lib/markets/priceReading'
import { submitMarketOrder as defaultSubmitMarketOrder, submitRestingOrder as defaultSubmitRestingOrder } from '../lib/predict/clobSession'

const PASS_THROUGH = new Set(['checking', 'geoblocked', 'blocked', 'enabling', 'signing', 'submitting', 'done', 'error', 'unknown'])

/** Does this plan fill as a maker? Only an order that rests WITHOUT crossing the book. */
const fillsAsMaker = (v) => v?.kind === 'resting' && v.crossesBook !== true

export function usePredictPlanTrade({
  tokenId,
  reading,
  side = 'buy',
  typed = '',
  ownPrice = '',
  toleranceTicks = 1,
  tickSize,
  minOrderSize,
  // true | false when the listing states it; anything else and the SDK asks the venue (never a guessed false).
  negRisk,
  // A public description of the order for the progress tracker ("Yes — Will X happen?"). Optional.
  label = null,
  walletClient,
  deps,
} = {}) {
  const trade = usePredictTrade({ deps, walletClient })
  const account = useContext(WalletContext)?.address ?? null
  const trackOrder = deps?.trackSignedOrder ?? defaultTrackSignedOrder
  const sendMarket = deps?.submitMarketOrder ?? defaultSubmitMarketOrder
  const sendResting = deps?.submitRestingOrder ?? defaultSubmitRestingOrder

  const [phase, setPhase] = useState('editing') // editing | review
  const [reviewed, setReviewed] = useState(null)
  const [notice, setNotice] = useState(null) // { code: 'moved' | 'not-live' | 'venue', reason? }
  const [confirming, setConfirming] = useState(false)
  // A ref as well as the state: two presses delivered in one render both read `confirming === false`.
  const confirmingRef = useRef(false)

  // The latest inputs, read at SIGN time: a closure captured when Review was pressed would re-plan against a
  // reading that has since aged, which is the very thing FR-021 exists to prevent.
  const latest = useRef({})
  useEffect(() => {
    latest.current = { reading, side, typed, ownPrice, toleranceTicks, tickSize, minOrderSize }
  })

  const view = useMemo(
    () => planForTicket({ reading, side, typed, ownPrice, toleranceTicks, tickSize, minOrderSize }),
    [reading, side, typed, ownPrice, toleranceTicks, tickSize, minOrderSize]
  )
  const quoteOf = useCallback(
    (v) => (v?.status === 'ok' && trade.fee ? computeCostForPlan(v.feePlan, side, trade.fee, { isMaker: fillsAsMaker(v) }) : null),
    [trade.fee, side]
  )
  const ceilingOf = useCallback(
    (v) => {
      if (v?.status !== 'ok' || !trade.fee) return null
      if (v.kind === 'resting') {
        const asMaker = computeCostForPlan(v.feePlan, side, trade.fee, { isMaker: true })
        const asTaker = computeCostForPlan(v.feePlan, side, trade.fee, { isMaker: false })
        if (!asMaker || !asTaker) return null
        const worst = asTaker.builderFeeUnits >= asMaker.builderFeeUnits ? asTaker : asMaker
        const expected = fillsAsMaker(v) ? asMaker : asTaker
        return { ...worst, contingent: worst.builderFeeUnits !== expected.builderFeeUnits }
      }
      return v.ceilingPlan ? computeCostForPlan(v.ceilingPlan, side, trade.fee) : null
    },
    [trade.fee, side]
  )
  const quote = useMemo(() => quoteOf(view), [quoteOf, view])
  const ceiling = useMemo(() => ceilingOf(view), [ceilingOf, view])

  // Region + fee, once per ticket (the builder rate does not depend on which outcome is selected).
  const firstToken = useRef(tokenId)
  const { loadFee } = trade
  useEffect(() => {
    if (firstToken.current) loadFee(firstToken.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A different outcome or side is a different order: any review is void. (State adjusted while rendering —
  // the documented pattern for "reset when a prop changes" — so a stale review is never painted.)
  const orderKey = `${tokenId}|${side}`
  const [seenKey, setSeenKey] = useState(orderKey)
  if (seenKey !== orderKey) {
    setSeenKey(orderKey)
    setPhase('editing')
    setReviewed(null)
    setNotice(null)
  }

  // A review whose price is no longer live must not keep showing figures drawn from it (FR-013).
  const liveNow = Boolean(reading) && reclassify(reading)?.plannable === true
  if (phase === 'review' && !confirming && !liveNow) {
    setPhase('editing')
    setReviewed(null)
    setNotice({ code: 'not-live' })
  }

  const review = useCallback(() => {
    if (view.status !== 'ok' || !trade.fee || !liveNow) return false
    if (trade.status !== 'ready' && trade.status !== 'idle') return false
    setReviewed(view)
    setNotice(null)
    setPhase('review')
    return true
  }, [view, trade.fee, trade.status, liveNow])

  const edit = useCallback(() => {
    setPhase('editing')
    setReviewed(null)
    setNotice(null)
    if (trade.status === 'error' || trade.status === 'done') trade.reset()
  }, [trade])

  const send = useCallback(
    (client, r) =>
      r.kind === 'resting'
        ? sendResting(client, { tokenId, side: r.signed.side, price: r.signed.limitPrice, size: r.signed.size, negRisk, tickSize: r.signed.tickSize })
        : sendMarket(client, {
            tokenId,
            side: r.signed.side,
            amount: r.signed.amount,
            limitPrice: r.signed.limitPrice,
            negRisk,
            tickSize: r.signed.tickSize,
          }),
    [sendMarket, sendResting, tokenId, negRisk]
  )

  const confirm = useCallback(async () => {
    if (phase !== 'review' || !reviewed || confirming || confirmingRef.current) return null
    confirmingRef.current = true
    setConfirming(true)
    const recheck = () => checkStillSignable({ reviewed, ...latest.current, reading: reclassify(latest.current.reading) })
    const moveTo = (check) => {
      const next = check.next
      if (check.reason === 'not-live' || next?.status === 'not-live') {
        setReviewed(null)
        setPhase('editing')
        setNotice({ code: 'not-live' })
      } else if (next?.status === 'ok') {
        setReviewed(next)
        setPhase('review')
        setNotice({ code: 'moved', reason: check.reason })
      } else {
        setReviewed(null)
        setPhase('editing')
        setNotice({ code: 'moved', reason: check.reason })
      }
    }
    try {
      const first = recheck()
      if (!first.ok) {
        moveTo(first)
        return { moved: true }
      }
      if (!trade.tradingEnabled) {
        const enabled = await trade.enableTrading()
        if (!enabled) return null
      }
      let late = null
      const res = await trade.signAndPost((client) => send(client, reviewed), {
        beforeSign: async () => {
          const check = recheck()
          if (check.ok) return true
          late = check
          return false
        },
      })
      if (late) {
        moveTo(late)
        return { moved: true }
      }
      // Hand the order to the tracker (slice 6). Only an order that was actually posted: an answer, or an answer
      // that never arrived (`outcomeUnknown` — tracked as unconfirmed and looked up, never re-sent).
      if (res?.outcomeUnknown || (res && !res.aborted && !res.priceChanged && (res.orderId || res.orderHash))) {
        const r = reviewed
        trackOrder(
          account,
          {
            tokenId,
            side: r.signed.side,
            kind: r.kind,
            size: r.kind === 'resting' ? r.signed.size : r.signed.amount,
            sizeUnit: r.kind === 'resting' || r.signed.side === 'SELL' ? 'shares' : 'USDC',
            limitPrice: r.signed.limitPrice,
            label,
          },
          res.outcomeUnknown
            ? { unconfirmed: true, reason: res.reason ?? null, posted: { computedId: res.orderHash ?? null } }
            : { posted: { orderId: res.orderId ?? null, status: res.status ?? null, computedId: res.orderHash ?? null } },
        )
      }
      if (res?.priceChanged) {
        // The venue could not match at the reviewed limit: the market moved. Back to a fresh review.
        trade.reset()
        moveTo({ reason: 'venue', next: planForTicket({ ...latest.current, reading: reclassify(latest.current.reading) }) })
        return { moved: true }
      }
      return res
    } finally {
      confirmingRef.current = false
      setConfirming(false)
    }
  }, [phase, reviewed, confirming, trade, send, trackOrder, account, tokenId, label])

  const reset = useCallback(() => {
    setPhase('editing')
    setReviewed(null)
    setNotice(null)
    trade.reset()
  }, [trade])

  const base = trade.status
  let state
  if (PASS_THROUGH.has(base)) state = base
  else if (confirming) state = 'signing'
  else if (phase === 'review') state = notice?.code === 'moved' ? 'moved' : 'review'
  else if (!trade.fee) state = 'idle'
  else if (!liveNow) state = 'waiting-price'
  else if (view.status === 'empty') state = 'idle'
  else state = 'planning'

  return {
    state,
    reason: trade.reason,
    geoInfo: trade.geoInfo,
    fee: trade.fee,
    result: trade.result,
    canTrade: trade.canTrade,
    signerKind: trade.signerKind,
    onWrongNetwork: trade.onWrongNetwork,
    tradingEnabled: trade.tradingEnabled,
    view,
    quote,
    ceiling,
    reviewed,
    reviewedQuote: quoteOf(reviewed),
    reviewedCeiling: ceilingOf(reviewed),
    notice,
    retryFee: () => (firstToken.current ? trade.loadFee(firstToken.current) : null),
    review,
    edit,
    confirm,
    reset,
  }
}

export default usePredictPlanTrade
