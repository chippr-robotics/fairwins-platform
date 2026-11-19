/**
 * PositionSheet (spec 083, T034 + T040) — how a member exits a leveraged position.
 *
 * This is the surface US1 and US2 are the acceptance criteria for, and the one where a
 * well-meaning shortcut costs a member real money. Five rules shape every line below:
 *
 * 1. **THE MEMBER IS ALWAYS `msg.sender`.** This component never touches an ownership field. It
 *    assembles a descriptor of *what the member asked for* and hands it to `usePerpsTrade`, which
 *    hands it to the venue builders — and those refuse an order FairWins would own. The only
 *    FairWins address that can leave here is `uiFeeReceiver`, and it travels as its own named
 *    parameter into `buildClosePositionCalls`/`buildProtectionCalls`, never near `receiver`.
 *
 * 2. **INCLUSION IS NEVER EXECUTION.** No status is derived here. `usePerpsTrade` publishes the
 *    state machine (`lib/perps/orderState.js`) and this file renders `trade.statusText` verbatim,
 *    so "Sent to Gains" on inclusion and "Position closed." only on the venue's own execution event
 *    are properties of the machine, not of this sheet. There is deliberately no local `done` flag —
 *    that is exactly the shape (`VaultSheet.jsx`'s `txState.step === 'done'`) that turns a stalled
 *    submission into a claim of success. A Gains protection change settles inside the member's own
 *    transaction and emits no order event, so it is the one action with nothing to watch — and it
 *    is confirmed by RE-READING the venue (`confirmStoredProtection`), never by inclusion. That
 *    read is bounded, and when the bound is spent the machine is told the thread was lost.
 *
 * 3. **EXITS ARE NEVER GATED.** Nothing here imports the attestation, the management kill switch,
 *    or the venue's open-permission check — a sibling test greps this file for each of those names,
 *    so they cannot return even as a comment. `exitAvailability()` is the only venue-status call,
 *    and it is consulted purely to render the venue's own warning — its
 *    `offer` is structurally `true`. An unreadable fee rate, an unreadable venue and a session that
 *    cannot transact all produce an explanation plus the venue's own link; none of them removes the
 *    exit. A sibling test asserts the absence of those imports over this file's source.
 *
 * 4. **HONEST NUMBERS.** Every figure is the venue's, rendered '—' where the venue reported
 *    nothing (never 0), and every pre-execution figure is labelled *estimated*. The position's
 *    facts come from the venue read; the close preview is arithmetic over those facts and says so.
 *
 * 5. **SMART DEFAULTS, ONE TAP.** "Close all" is pre-selected, protection is pre-filled from
 *    `defaults.js#suggestProtection` (which guarantees a level `validateProtection` accepts), and
 *    the slippage default is the venue SDK's own. A member who agrees with all of it taps once.
 *
 * TESTABILITY. Every side effect is injectable through `deps` — the trade hook, the fee read and
 * the clock — so the whole lifecycle is exercised with no network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import InfoTip from '../ui/InfoTip'
import { NETWORKS } from '../../config/networks'
import { PERP_VENUES, perpsUiFeeReceiver } from '../../config/perps'
import { SETTLEMENT, settlementFor, usePerpsTrade } from '../../hooks/usePerpsTrade'
import { ORDER_STATE } from '../../lib/perps/orderState'
import { suggestProtection } from '../../lib/perps/defaults'
import { feeUsdFromNotional, rateToPct, venueFeeFromNotional } from '../../lib/perps/feeUnits'
import { bpsToPct, formatLeverage, formatPairPrice, formatSignedUsd, formatUsd } from '../../lib/perps/format'
import { GMX_DERIVED_FIELDS, isDerivedFigure } from '../../lib/perps/gmxDerived'
import { tradeLinkFor } from '../../lib/perps/linkouts'
import {
  PERPS_CALCULATED_LABEL,
  PERPS_GMX_NO_LIQUIDATION_PRICE,
  PERPS_TIPS,
} from '../../lib/perps/perpsCopy'
import { validateProtection } from '../../lib/perps/validation'
import { exitAvailability } from '../../lib/perps/venueStatus'
import {
  bigintOrNull,
  buildExitDescriptor,
  buildProtectDescriptor,
  confirmStoredProtection,
  defaultReadFeeBps,
  defaultReadVenueQuote,
  directionOf,
  formatWeiAmount,
  gainsTradeIndexOf,
  numberOrNull,
  positiveNumber,
  readStoredProtection,
} from './positionSheetActions'
import './PositionSheet.css'

const DASH = '—'

/**
 * The shares a member can close in one tap. 100 is the common case and the default, so the
 * ordinary exit is a single tap rather than a number to type (SC-001).
 */
// Module-local: nothing outside this sheet consumes it, and a component file that also exports
// a constant breaks React Fast Refresh (react-refresh/only-export-components).
const CLOSE_PRESETS = Object.freeze([25, 50, 75, 100])

/* ------------------------------------------------------------------------------------------- *
 * The sheet
 * ------------------------------------------------------------------------------------------- */

export default function PositionSheet({
  position,
  /** The current price, when the caller has one the venue reported. */
  markPrice: markPriceProp = null,
  /** Protection AS THE VENUE STORES IT — `{ stopLoss, takeProfit }`. Never the requested values. */
  protection = null,
  /** The venue's operational state, for its own warning. It can never withhold the exit. */
  venueStatus = null,
  /** The venue's own fee for this exit, where the caller knows it. Absent renders '—', never 0. */
  venueFeeUsd = null,
  /**
   * The venue's own PUBLISHED closing rate — `PerpPair.venueFee` off the pairs feed.
   *
   * A rate rather than an amount, because the fee scales with the share being closed and this sheet
   * is where that share is chosen: a fixed dollar figure passed in would be right for 100% and wrong
   * for every preset beside it. `venueFeeUsd` above still wins when a caller has a real number.
   */
  venueFee = null,
  /**
   * GMX only: `{ executionFee, acceptablePrice? }` — the keeper fee the member pays.
   *
   * OPTIONAL, and normally absent: the sheet reads it itself (`deps.readQuote`, defaulting to
   * `defaultReadVenueQuote`) so no caller has to know that GMX charges one. A caller that already
   * holds a quote may still supply it, and it wins over the read.
   */
  venueQuote = null,
  /** Public venue attribution, for the link-out. */
  attribution = null,
  onClose,
  onActionComplete,
  deps,
}) {
  const sheetRef = useRef(null)
  const restoreFocusRef = useRef(null)

  // The trade hook is injectable for tests. `deps` must be stable across renders — it selects which
  // hook is called, so a changing identity would reorder hooks.
  const useTrade = deps?.useTrade ?? usePerpsTrade
  const venueMeta = PERP_VENUES[position?.venue] ?? null
  const venueLabel = venueMeta?.shortLabel ?? venueMeta?.label ?? position?.venue ?? 'the venue'
  const trade = useTrade({
    deps: deps?.trade,
    identity: {
      venue: position?.venue ?? null,
      chainId: position?.chainId ?? null,
      venueLabel,
      venueUrl: venueMeta?.homepage ?? null,
    },
  })

  const [percent, setPercent] = useState(100)
  const [refusal, setRefusal] = useState(null)
  const [fee, setFee] = useState(null) // null = still reading
  const [readQuoteResult, setReadQuoteResult] = useState(null) // null = still reading, or none needed
  /** The venue's OWN stored protection, as re-read from it. null = never read, not "none set". */
  const [venueProtection, setVenueProtection] = useState(null)
  /** What the venue did with the last protection write, in its own words. */
  const [protectionNote, setProtectionNote] = useState(null)
  const [stopText, setStopText] = useState('')
  const [takeText, setTakeText] = useState('')
  const editedRef = useRef(false)

  /** False once the sheet is gone, so a bounded re-read abandons instead of publishing into it. */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /* Sheet shell: focus save/restore, Escape, and the body scroll lock with its cleanup.
   *
   * TWO THINGS HERE ARE DELIBERATE, and both are defects if you write the obvious version.
   *
   * 1. **It is guarded on `position`.** This component renders NOTHING without one (see the
   *    `if (!position) return null` below), and locking `body { overflow: hidden }` while nothing
   *    is on screen leaves the page unscrollable with no visible sheet to dismiss — a leaked lock
   *    with no way out. `AssetDetailSheet` guards on `aggregate` for the same reason.
   *
   * 2. **`onClose` rides a ref instead of being a dependency.** This sheet lives inside a view
   *    that re-renders on a 30s market poll and a 60s position poll, so a caller passing an inline
   *    `onClose` would re-run the effect on each one: the cleanup restores focus, the effect then
   *    records THAT as the element to restore to and pulls focus back to the sheet — a member
   *    typing a stop-loss price would be yanked to the top of the sheet every poll, and the real
   *    return target would be lost. Keyed on the sheet's own identity, the shell runs exactly once
   *    per open, which is what "save and restore focus" means.
   */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  const hasPosition = Boolean(position)
  useEffect(() => {
    if (!hasPosition) return undefined
    restoreFocusRef.current = document.activeElement
    sheetRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current?.()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus?.()
    }
  }, [hasPosition])

  const venue = position?.venue ?? null
  const chainId = position?.chainId ?? null

  /* The live rate, from the contract that enforces it. A failure is disclosed and changes nothing
   * about whether the member may close (fee-rails.md rule 4). */
  const readFee = deps?.readFee ?? defaultReadFeeBps
  useEffect(() => {
    if (!venue) return undefined
    let alive = true
    setFee(null)
    Promise.resolve()
      .then(() => readFee({ venue, chainId }))
      .then((result) => {
        if (alive) setFee(result ?? { failed: true })
      })
      .catch(() => {
        if (alive) setFee({ failed: true })
      })
    return () => {
      alive = false
    }
    // `readFee` is a dependency the caller owns; re-reading on a new venue/chain is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, chainId])

  /* THE VENUE'S OWN QUOTE — on GMX, the keeper fee without which `createOrder` reverts.
   *
   * Read HERE rather than passed in, for the same reason the rate above is: the venue is the
   * authority for it, it changes with GMX's configuration and the live gas price, and a member
   * must not have to hold a position on a particular screen for their exit to be buildable. It is
   * read ONCE per open (venue + chain), not polled: the buffer in the estimate exists precisely so
   * a quote does not go stale between reading it and signing.
   *
   * A failure is NOT a gate. It means this app cannot assemble valid calldata for GMX right now,
   * which is disclosed below with GMX's own app named — the exit itself is never withheld. */
  const readQuote = deps?.readQuote ?? defaultReadVenueQuote
  useEffect(() => {
    if (!venue) return undefined
    let alive = true
    setReadQuoteResult(null)
    Promise.resolve()
      .then(() => readQuote({ venue, chainId }))
      .then((result) => {
        if (alive) setReadQuoteResult(result ?? null)
      })
      .catch(() => {
        if (alive) setReadQuoteResult({ failed: true })
      })
    return () => {
      alive = false
    }
    // Same ownership as `readFee` above: re-reading on a new venue/chain is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, chainId])

  /* A quote the CALLER supplied wins; otherwise the sheet's own read. Both may legitimately be
   * absent — a Gains exit has no keeper fee at all, and rendering a fee line there would invent
   * a cost the member does not pay. */
  const quote = venueQuote ?? readQuoteResult

  /* THE VENUE'S STORED PROTECTION — read from the venue, because that is the only thing US2
   * acceptance 3 accepts as "what is saved".
   *
   * It matters TWICE. Before a write it is what the fields are pre-filled from, so a member sees
   * their real stop rather than a suggestion. After a write it is the BASELINE the confirmation
   * proves a change against: an endpoint a block behind still answers the old levels, and without
   * something to compare to, that stale answer would be reported as the new one.
   *
   * Only for a venue that settles protection DIRECTLY (Gains). GMX keeps protection as separate
   * trigger orders, which are read — and cancelled — as orders, never from the position. */
  const readProtection = deps?.readProtection ?? readStoredProtection
  const memberAddress = trade.account ?? null
  const gainsIndexValue = numberOrNull(position?.venueRef?.tradeIndex?.value ?? position?.venueRef?.tradeIndex)
  useEffect(() => {
    if (settlementFor(venue, 'protect') !== SETTLEMENT.DIRECT) return undefined
    const index = gainsTradeIndexOf(position)
    if (!index || !memberAddress) return undefined
    let alive = true
    Promise.resolve()
      .then(() => readProtection({ venue, chainId, account: memberAddress, tradeIndex: index }))
      .then((result) => {
        // A FAILED read leaves the previous answer alone. "We could not ask" is not "there is
        // none", and blanking a stop the member can see would be a fabricated fact.
        if (alive && result?.ok) setVenueProtection(result.stored)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // Keyed on the position's own identity, not on the object: the parent re-creates positions on
    // every poll, and re-reading the venue on each one would be a request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, chainId, gainsIndexValue, memberAddress])

  const isLong = directionOf(position)
  const markPrice = positiveNumber(markPriceProp) ?? positiveNumber(position?.markPrice) ?? positiveNumber(position?.currentPrice) ?? positiveNumber(position?.price)
  const sizeUsd = positiveNumber(position?.sizeUsd) ?? positiveNumber(position?.sizeInUsdDisplay)
  const liquidationPrice = positiveNumber(position?.liquidationPrice)

  /* SMART DEFAULT for protection: the venue's stored levels where it has any, otherwise a
   * suggestion derived from the position's own risk — and `suggestProtection` only ever returns
   * levels `validateProtection` accepts, so the pre-filled value is never one the app then refuses. */
  const suggested = useMemo(
    () =>
      suggestProtection({
        entry: position?.entryPrice ?? null,
        mark: markPrice,
        leverage: position?.leverage ?? null,
        isLong,
        liquidationPrice,
      }),
    [position?.entryPrice, position?.leverage, markPrice, isLong, liquidationPrice],
  )
  /* A caller that already holds the venue's levels wins; otherwise the sheet's own read of them.
   * `null` on this object means "the venue has no level", and the object being absent altogether
   * means "nobody has asked the venue yet" — two different things the confirmation depends on. */
  const storedLevels = protection ?? venueProtection
  const storedStop = positiveNumber(storedLevels?.stopLoss)
  const storedTake = positiveNumber(storedLevels?.takeProfit)

  useEffect(() => {
    // Never overwrite what the member has typed. Once they edit, the fields are theirs.
    if (editedRef.current) return
    // A level the VENUE stores is shown exactly as the venue stores it; only OUR suggestion is
    // rounded to something a member would type (and only when the rounding stays valid).
    const levelOpts = { isLong, entryPrice: position?.entryPrice ?? null, markPrice, liquidationPrice }
    setStopText(
      storedStop !== null
        ? numberToText(storedStop)
        : suggestionToText(suggested.stopLoss, { ...levelOpts, kind: 'stop' }),
    )
    setTakeText(
      storedTake !== null
        ? numberToText(storedTake)
        : suggestionToText(suggested.takeProfit, { ...levelOpts, kind: 'take' }),
    )
  }, [storedStop, storedTake, suggested.stopLoss, suggested.takeProfit])

  const stopLoss = textToLevel(stopText)
  const takeProfit = textToLevel(takeText)

  const protectionCheck = useMemo(
    () =>
      validateProtection({
        position: { markPrice, entryPrice: position?.entryPrice ?? null, isLong, liquidationPrice },
        stopLoss: stopLoss === 'invalid' ? -1 : stopLoss,
        takeProfit: takeProfit === 'invalid' ? -1 : takeProfit,
        liquidationPrice,
        isLong,
      }),
    [markPrice, position?.entryPrice, isLong, liquidationPrice, stopLoss, takeProfit],
  )

  /* "An order of ours is in flight", asked of the machine rather than answered here.
   *
   * The obvious version enumerates the pre-submission state names — and that is a state list
   * copied into a component, which is the shape rule 2 exists to prevent: the machine grows a
   * state, this list does not, and the sheet quietly stops disabling its controls mid-ceremony.
   * `idle` is "nothing sent" and a terminal state is "the venue has finished with it" (including
   * `frozen` / `timed_out`, which need the member to act); everything between the two is in
   * flight, by the machine's own definition of those two words. */
  const busy = trade.status !== ORDER_STATE.IDLE && !trade.terminal
  // A status nobody supplied is not a status we may characterise: `exitAvailability(null)` reports
  // "this venue may refuse it", which would be a claim about the venue built out of our own silence.
  // The exit is offered either way — `offer` is structurally true — so only the NOTE is withheld.
  const exit = venueStatus == null ? { offer: true, venueWillAccept: true, note: null } : exitAvailability(venueStatus)
  const venueUrl = tradeLinkFor(position, attribution ?? {})
  const networkName = NETWORKS[chainId]?.name ?? null

  /* The venue's execution is the ONLY thing that reports a change. `trade.status` is the machine's,
   * never re-derived, and the parent is told to re-read only once per resolved order. */
  const reportedRef = useRef(null)
  useEffect(() => {
    if (trade.status !== ORDER_STATE.EXECUTED) return
    if (reportedRef.current === trade.order) return
    reportedRef.current = trade.order
    onActionComplete?.(trade.order)
  }, [trade.status, trade.order, onActionComplete])

  const send = useCallback(
    async (built) => {
      if (!built.ok) {
        setRefusal(built.reason)
        return null
      }
      setRefusal(null)
      // A session with no rail on this chain is not a restriction — it is the absence of a way to
      // send. Saying so, with the venue's own surface named, keeps the exit available without
      // asking for a signature that cannot land.
      if (trade.canTransactOn && !trade.canTransactOn(built.descriptor.chainId)) {
        setRefusal(
          `${trade.cannotTransactReason?.(built.descriptor.chainId) ?? 'This session cannot send transactions on that network.'} You can still close this position on ${venueLabel}.`,
        )
        return null
      }
      return trade.submit(built.descriptor)
    },
    [trade, venueLabel],
  )

  /**
   * CONFIRM A DIRECT SETTLEMENT (US2 acceptance 3).
   *
   * `updateSl` / `updateTp` change the diamond's own state inside the member's transaction and
   * announce it with no order event, so there is nothing for the machine's watcher to see: without
   * this the sheet would rest at "Sent to Gains" for good. The confirmation is the venue's own
   * `getTrade`, re-read until it proves the change, and what it returns is what the sheet shows —
   * the requested level never becomes the displayed one.
   *
   * It is BOUNDED. On exhaustion the machine is told the read was lost, which reports "we can't
   * confirm this — check on the venue" and leaves the venue's own surface a tap away. That is the
   * honest end of a read we could not complete; a spinner and a claim of success are both lies.
   */
  const confirmProtection = deps?.confirmProtection ?? confirmStoredProtection
  const confirmDirectSettlement = useCallback(
    async (descriptor, previous) => {
      const params = descriptor?.params ?? {}
      // Only the legs that were actually written. An untouched leg proves nothing either way.
      const requested = {}
      if ('sl' in params) requested.sl = params.sl
      if ('tp' in params) requested.tp = params.tp

      const outcome = await confirmProtection({
        venue: descriptor.venue,
        chainId: descriptor.chainId,
        account: memberAddress,
        tradeIndex: params.tradeIndex,
        requested,
        previous,
        deps: { readStored: readProtection, sleep: deps?.sleep, alive: () => aliveRef.current },
      })
      if (!aliveRef.current) return

      if (!outcome?.ok) {
        trade.reportUnconfirmed?.(`${venueLabel} did not report these levels back in time.`)
        setProtectionNote(
          `We could not confirm what ${venueLabel} stored. The levels above are the last ones ${venueLabel} reported — check them on ${venueLabel}.`,
        )
        return
      }

      // What the venue HOLDS, everywhere: the fields, the note, and the machine's payload.
      //
      // The fields are written DIRECTLY rather than left to the pre-fill effect, because a member
      // who typed a level has `editedRef` set and that effect deliberately never overrules them —
      // which is right while they are editing and wrong the moment the venue has answered. The
      // flag stays set so nothing else overwrites the venue's own numbers afterwards.
      setVenueProtection(outcome.stored)
      editedRef.current = true
      setStopText(numberToText(outcome.stored.stopLoss))
      setTakeText(numberToText(outcome.stored.takeProfit))
      setProtectionNote(storedProtectionNote(outcome, requested, venueLabel))
      trade.confirmFromVenue?.(outcome.stored)
    },
    [confirmProtection, readProtection, deps?.sleep, memberAddress, trade, venueLabel],
  )

  const onExit = useCallback(() => {
    send(
      buildExitDescriptor({
        position,
        percent,
        markPrice,
        quote,
        uiFeeReceiver: perpsUiFeeReceiver(),
      }),
    )
  }, [send, position, percent, markPrice, quote])

  const onProtect = useCallback(async () => {
    if (!protectionCheck.ok) {
      // The refusal is already on screen beside the field; repeating it here keeps a member who
      // reached the button by keyboard from being met with silence.
      setRefusal(protectionCheck.reason)
      return
    }
    const built = buildProtectDescriptor({
      position,
      stopLoss: stopLoss === 'invalid' ? null : stopLoss,
      takeProfit: takeProfit === 'invalid' ? null : takeProfit,
      stored: { stopLoss: storedStop, takeProfit: storedTake },
      markPrice,
      quote,
      uiFeeReceiver: perpsUiFeeReceiver(),
    })
    // The baseline the confirmation proves a change against, captured BEFORE the write. An absent
    // object says the venue was never read — a distinction the confirmation depends on, so it is
    // not flattened into a pair of nulls.
    const previous = storedLevels
      ? { stopLoss: storedLevels.stopLoss ?? null, takeProfit: storedLevels.takeProfit ?? null }
      : null
    setProtectionNote(null)

    const outcome = await send(built)
    // `ok` here is the SUBMISSION, never the venue — the whole point of what follows.
    if (!outcome?.ok) return
    if (settlementFor(built.descriptor.venue, built.descriptor.action) !== SETTLEMENT.DIRECT) return
    await confirmDirectSettlement(built.descriptor, previous)
  }, [
    send,
    confirmDirectSettlement,
    position,
    stopLoss,
    takeProfit,
    storedStop,
    storedTake,
    storedLevels,
    markPrice,
    quote,
    protectionCheck,
  ])

  if (!position) return null

  const titleId = 'perps-position-sheet-title'
  const fraction = percent / 100
  const closingNotional = sizeUsd === null ? null : sizeUsd * fraction
  const feeBps = fee && !fee.failed ? Number(fee.bps) : null
  const feeApplies = feeBps !== null && feeBps > 0
  const feeUsd = feeApplies && closingNotional !== null ? feeUsdFromNotional(closingNotional, feeBps) : null
  /* THE VENUE'S OWN FEE FOR THIS EXIT, for the share actually selected. An explicit `venueFeeUsd`
   * from the caller wins — it would be a real number rather than one derived from a rate. This
   * NEVER gates the close: an absent rate changes a line in a breakdown and nothing else, which is
   * the same rule the FairWins rate follows on this sheet (fee-rails.md rule 4). */
  const venueFeeEstimate =
    closingNotional === null ? null : venueFeeFromNotional(closingNotional, venueFee, 'close')
  const venueFeeShown = venueFeeUsd == null ? (venueFeeEstimate?.usd ?? null) : Number(venueFeeUsd)
  const venueFeeEstimated = venueFeeUsd == null && venueFeeEstimate !== null
  /* WHICH FIGURES ARE OURS. The composition point (`PerpsView`) fills a GMX position's derivable
   * figures from the venue's raw units and names exactly which ones it filled; this sheet only ever
   * READS that answer. Re-deriving the question here — "is this a GMX row, so it must be
   * calculated" — would mislabel the day a venue starts reporting one of them. */
  const derivedEntry = isDerivedFigure(position, 'entryPrice')
  const derivedPnl = isDerivedFigure(position, 'unrealizedPnlUsd')
  const hasDerived = GMX_DERIVED_FIELDS.some((field) => isDerivedFigure(position, field))
  const pnlShare = numberOrNull(position?.unrealizedPnlUsd)
  const collateralUsd = numberOrNull(position?.collateralUsd)
  const proceeds =
    collateralUsd === null || pnlShare === null ? null : (collateralUsd + pnlShare) * fraction
  const statusText = trade.statusText
  const executed = trade.status === ORDER_STATE.EXECUTED

  /* The keeper fee, and the two things a member must be told about it: it is an ESTIMATE bid a
   * little high on purpose, and the unspent part comes back. Rendered only where the venue
   * actually charges one — an absent quote is Gains having no such fee, not a missing number. */
  const keeperFeeWei = bigintOrNull(quote?.executionFee)
  const keeperFeeText = keeperFeeWei === null ? null : formatWeiAmount(keeperFeeWei)
  const nativeSymbol = NETWORKS[chainId]?.nativeCurrency?.symbol ?? null
  const keeperFeeUnreadable = Boolean(quote?.failed)

  return (
    <div className="asset-sheet-backdrop">
      <button
        type="button"
        className="asset-sheet-scrim"
        aria-label="Dismiss this position panel"
        onClick={onClose}
      />
      <div
        className="asset-sheet perps-position-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={sheetRef}
      >
        <div className="asset-sheet-grabber" aria-hidden="true" />

        <div className="asset-sheet-header">
          <div className="asset-sheet-heading">
            <h3 id={titleId}>
              {isLong === null ? '' : isLong ? 'Long ' : 'Short '}
              {position.symbol || 'this position'}
              {/* The venue's market variant, where it has one (GMX runs several markets on one
                  base pair). It is inside the title so the sheet a member is about to act in
                  names exactly which market that is — and so the dialog's accessible name does. */}
              {position.variant ? <span className="pps-variant"> {position.variant}</span> : null}
            </h3>
            <p className="pps-venue">
              On {venueMeta?.label ?? venueLabel}
              {networkName ? ` · ${networkName}` : ''}
            </p>
          </div>
          {/* "Dismiss", not "Close": the primary action on this sheet closes a POSITION, and two
              controls a tap apart called "Close" is the kind of ambiguity that costs money. */}
          <button type="button" className="asset-sheet-close" onClick={onClose}>
            Dismiss
          </button>
        </div>

        <dl className="pps-facts">
          <Fact label="Size" value={formatUsd(position.sizeUsd)} />
          <Fact
            label="Entry price"
            value={formatPairPrice(position.entryPrice)}
            derived={derivedEntry}
          />
          <Fact label="Current price" value={formatPairPrice(markPrice)} />
          <Fact
            label="Leverage"
            value={formatLeverage(position.leverage)}
            derived={isDerivedFigure(position, 'leverage')}
          />
          <Fact
            label="Liquidation price"
            value={formatPairPrice(position.liquidationPrice)}
            tip={PERPS_TIPS.liquidation}
            tipLabel="About liquidation"
          />
          <Fact
            label="Unrealized P&L"
            value={formatSignedUsd(position.unrealizedPnlUsd)}
            valueClass={pnlClass(position.unrealizedPnlUsd)}
            tip={derivedPnl ? PERPS_TIPS.pnlCalculated : PERPS_TIPS.pnl}
            tipLabel="About P&L"
            derived={derivedPnl}
          />
        </dl>
        {/* THE ATTRIBUTION SENTENCE, AND WHY IT HAS TWO FORMS.
            It used to say "every figure above is as the venue reports it" unconditionally. That is
            true only while every figure IS the venue's — the moment FairWins works one out (GMX
            returns raw position units and no entry, leverage or P&L at all), the same sentence
            turns our arithmetic into the venue's own claim. So the derived figures are tagged
            beside the number and this paragraph says what the tag means, including the one thing a
            member could otherwise be misled by: the calculated P&L is not the venue's settlement
            figure. */}
        <p className="pps-attrib">
          {hasDerived ? (
            <>
              Figures marked “{PERPS_CALCULATED_LABEL}” are not reported by {venueLabel} — FairWins
              works them out from the position {venueLabel} did report. A calculated profit or loss
              leaves out {venueLabel}’s borrowing and funding charges and the price impact of
              closing, so it is not what {venueLabel} will settle at. Everything else above is as{' '}
              {venueLabel} reports it, and “{DASH}” means the value could not be established — it is
              not zero.
            </>
          ) : (
            <>
              Every figure above is as {venueLabel} reports it. “{DASH}” means {venueLabel} did not
              report that value — it is not zero.
            </>
          )}
        </p>
        {/* The number a member expects most, and the one place a bare dash reads as "there isn't
            one". GMX genuinely stores no liquidation price, so this names the reason rather than
            leaving the gap to be guessed at. */}
        {venue === 'gmx' && liquidationPrice === null && (
          <p className="pps-note" role="note">
            {PERPS_GMX_NO_LIQUIDATION_PRICE}
          </p>
        )}

        {statusText && (
          <p
            className={`pps-status ${executed ? 'pps-status-done' : trade.terminal ? 'pps-status-attention' : 'pps-status-pending'}`}
            role="status"
          >
            {statusText}
          </p>
        )}
        {refusal && (
          <p className="pps-error" role="alert">
            {refusal}
          </p>
        )}

        <section className="pps-section" aria-labelledby="pps-close-heading">
          <h4 id="pps-close-heading" className="pps-section-title">
            Close this position
          </h4>

          <fieldset className="pps-presets-fieldset">
            <legend>How much to close</legend>
            <div className="pps-presets">
              {CLOSE_PRESETS.map((option) => (
                <label
                  key={option}
                  className={`pps-preset ${percent === option ? 'selected' : ''}`}
                  htmlFor={`pps-percent-${option}`}
                >
                  <input
                    id={`pps-percent-${option}`}
                    type="radio"
                    name="pps-percent"
                    value={option}
                    checked={percent === option}
                    disabled={busy}
                    onChange={() => {
                      setPercent(option)
                      setRefusal(null)
                    }}
                  />
                  <span>{option === 100 ? 'All of it' : `${option}%`}</span>
                </label>
              ))}
            </div>
            <p className="pps-note">
              Closing all of it is chosen for you — pick a share to take part of it off instead.
            </p>
          </fieldset>

          {percent < 100 && venue === 'gains' && !hasRawCollateral(position) && (
            <p className="pps-note">
              Gains reduces this by lowering the position’s size. Your collateral stays in the
              position and the leverage comes down with the size.
            </p>
          )}

          <dl className="pps-breakdown">
            <div>
              <dt>Estimated proceeds</dt>
              <dd>{proceeds === null ? DASH : formatUsd(proceeds)}</dd>
            </div>
            <div>
              <dt>
                {venueLabel}’s own fee
                {venueFeeEstimate === null ? '' : ` (${rateToPct(venueFeeEstimate.rate)} of size)`}
                {venueFeeEstimated ? ', estimated' : ''}
              </dt>
              <dd>{venueFeeShown === null ? DASH : formatUsd(venueFeeShown)}</dd>
            </div>
            {/* A ZERO RATE SHOWS NO FEE LINE AT ALL (FR-012) — not "$0.00", which reads as a fee
                that happens to round down. The line exists only when a rate above zero applies. */}
            {feeApplies && (
              <div>
                <dt>FairWins fee ({bpsToPct(feeBps)} of size)</dt>
                <dd>{feeUsd === null ? DASH : formatUsd(feeUsd)}</dd>
              </div>
            )}
            {/* GMX settles orders through keepers the member pays. It is a real cost, in the
                network's own coin rather than USD, so it gets its own line — never folded into
                "the venue's own fees", which is the trading fee. */}
            {keeperFeeText !== null && (
              <div>
                <dt>{venueLabel} keeper fee (estimated)</dt>
                <dd>
                  {keeperFeeText}
                  {nativeSymbol ? ` ${nativeSymbol}` : ''}
                </dd>
              </div>
            )}
          </dl>
          {/* The dash on the venue's own fee, explained — and with it the one thing it changes
              about the line above it. A member reading "estimated proceeds" reasonably assumes the
              venue's fee is already out of it; here it is not, because the venue does not publish
              the figure to this app before the order is placed. */}
          {/* The venue's fee is an ESTIMATE from a published rate, and the one thing it changes
              about the line above it has to be said either way: a member reading "estimated
              proceeds" reasonably assumes the venue's fee is already out of it, and it is not. */}
          {venueFeeShown !== null && (
            <p className="pps-note">
              {venueLabel}’s fee is worked out from the rate {venueLabel} publishes for this market,
              not from a quote for this order, and it does not include {venueLabel}’s spread, the
              price impact of closing, or the borrowing and funding charged while the position was
              open. The estimated proceeds above do not have it taken out — {venueLabel} deducts it
              from what you receive when the order executes.
            </p>
          )}
          {venueFeeEstimate?.atFloor && (
            <p className="pps-note" role="note">
              This is below {venueLabel}’s smallest fee size, so {venueLabel} charges its fee as
              though you were closing {formatUsd(venueFeeEstimate.chargedOnUsd)} rather than{' '}
              {formatUsd(closingNotional)}. Closing a larger share pays the same fee.
            </p>
          )}
          {venueFeeShown === null && (
            <p className="pps-note" role="note">
              {venueLabel}’s own fee for this exit is not published to this app before the order is
              placed, so it shows “{DASH}” and the estimated proceeds above do not have it taken
              out. {venueLabel} deducts it from what you receive when the order executes.
            </p>
          )}
          {keeperFeeText !== null && (
            <p className="pps-note">
              {venueLabel} pays a keeper to execute this order, and this deposit is what pays them.
              It is set a little above the current estimate so the order cannot stall if gas moves
              before you sign — {venueLabel} returns whatever the keeper does not spend to your
              wallet.
            </p>
          )}
          {keeperFeeUnreadable && (
            <p className="pps-note" role="note">
              {venueLabel}’s keeper fee could not be read just now, so an order cannot be prepared
              here until it can be. Your position is unaffected and you can close it on {venueLabel}.
            </p>
          )}
          {feeApplies && (
            <p className="pps-note">
              The FairWins fee is charged on the position’s size ({formatUsd(closingNotional)}), not
              on the amount you put in, and {venueLabel} takes it when this executes.
            </p>
          )}
          {fee?.failed && (
            <p className="pps-note" role="note">
              The FairWins fee rate could not be confirmed just now, so it is not shown. Closing is
              not affected — nothing about your exit depends on that rate.
            </p>
          )}
          <p className="pps-note">
            These are estimates from {venueLabel}’s last reported figures. The amounts that count
            are the ones {venueLabel} settles at.
          </p>

          {!exit.venueWillAccept && exit.note && (
            <p className="pps-note" role="note">
              {exit.note}
            </p>
          )}

          <button type="button" className="pps-primary" onClick={onExit} disabled={busy}>
            {percent === 100 ? 'Close this position' : `Close ${percent}% of this position`}
          </button>
        </section>

        <section className="pps-section" aria-labelledby="pps-protect-heading">
          <h4 id="pps-protect-heading" className="pps-section-title">
            Protect this position
          </h4>
          <p className="pps-note">
            A stop-loss closes the position if the price moves against you; a take-profit closes it
            once you are ahead. Both are stored by {venueLabel}.
          </p>

          <div className="pps-protect-grid">
            <div className="pps-field">
              <label htmlFor="pps-stop">Stop-loss price</label>
              <input
                id="pps-stop"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={DASH}
                value={stopText}
                disabled={busy}
                aria-describedby="pps-stop-impact"
                onChange={(e) => {
                  editedRef.current = true
                  setStopText(e.target.value)
                  setRefusal(null)
                }}
              />
              <p id="pps-stop-impact" className="pps-impact">
                {impactText({ level: stopLoss, sizeUsd, entryPrice: position.entryPrice, isLong, venueLabel })}
              </p>
              <button
                type="button"
                className="pps-secondary"
                disabled={busy || stopText.trim() === ''}
                onClick={() => {
                  editedRef.current = true
                  setStopText('')
                  setRefusal(null)
                }}
              >
                Remove stop-loss
              </button>
            </div>

            <div className="pps-field">
              <label htmlFor="pps-take">Take-profit price</label>
              <input
                id="pps-take"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={DASH}
                value={takeText}
                disabled={busy}
                aria-describedby="pps-take-impact"
                onChange={(e) => {
                  editedRef.current = true
                  setTakeText(e.target.value)
                  setRefusal(null)
                }}
              />
              <p id="pps-take-impact" className="pps-impact">
                {impactText({ level: takeProfit, sizeUsd, entryPrice: position.entryPrice, isLong, venueLabel })}
              </p>
              <button
                type="button"
                className="pps-secondary"
                disabled={busy || takeText.trim() === ''}
                onClick={() => {
                  editedRef.current = true
                  setTakeText('')
                  setRefusal(null)
                }}
              >
                Remove take-profit
              </button>
            </div>
          </div>

          {storedStop === null && storedTake === null && (suggested.stopLoss !== null || suggested.takeProfit !== null) && (
            <p className="pps-note">
              {/* Name the basis actually used. `suggestProtection` works from the liquidation price
                  when the venue reports one and falls back to the position's leverage when it does
                  not — and this sheet renders a "could not be read" line directly below in exactly
                  that second case, so claiming the liquidation price unconditionally contradicted
                  the very next sentence. */}
              {liquidationPrice !== null
                ? 'These are suggestions worked out from this position’s own liquidation price — change them to whatever you want, or clear them.'
                : 'These are suggestions worked out from this position’s leverage, because the venue did not report a liquidation price — change them to whatever you want, or clear them.'}
            </p>
          )}

          {/* THE LIQUIDATION BOUND, refused BEFORE any wallet prompt: a stop at or beyond it never
              fires, because the venue liquidates the position first (US2 acceptance 2). */}
          {!protectionCheck.ok && (
            <p className="pps-error" role="alert">
              {protectionCheck.reason}
            </p>
          )}
          {protectionCheck.ok && protectionCheck.warning && (
            <p className="pps-note" role="note">
              {protectionCheck.warning}
            </p>
          )}

          <button
            type="button"
            className="pps-primary pps-primary-secondary"
            onClick={onProtect}
            disabled={busy || !protectionCheck.ok}
          >
            Save protection
          </button>
          {/* WHAT THE VENUE STORED — read back from it, not echoed from the request. It is the
              only thing on this sheet allowed to describe a saved level, and it says so plainly
              when the venue kept something other than what was asked for. */}
          {/* `role="note"`, not `status`: the machine's own line above is this sheet's ONE live
              region, and a second one would announce the same event twice. */}
          {protectionNote && (
            <p className="pps-note pps-stored-note" role="note">
              {protectionNote}
            </p>
          )}
          <p className="pps-note">
            Saved levels are shown as {venueLabel} stores them, once {venueLabel} has recorded them.
          </p>
        </section>

        <p className="pps-footer">
          FairWins never holds this position — it is yours at {venueMeta?.label ?? venueLabel}, and
          you can always manage it there.{' '}
          {venueUrl && (
            <a
              className="pps-venue-link"
              href={venueUrl}
              target="_blank"
              rel="noopener noreferrer"
              // WCAG 2.5.3: the accessible name starts with the visible text (see PerpsPositions).
              aria-label={`Manage on ${venueLabel}: this position on ${venueMeta?.label ?? venueLabel} (opens in a new tab)`}
            >
              Manage on {venueLabel} ↗
            </a>
          )}
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------- *
 * Rendering helpers
 * ------------------------------------------------------------------------------------------- */

/**
 * One figure, with the source of the number attached to the number itself.
 *
 * `derived` marks a value FairWins worked out rather than read from the venue. The tag sits in the
 * VALUE cell rather than the label because that is what it qualifies — the label names the concept,
 * which is the venue's either way — and it is never rendered on a '—': there is nothing to
 * attribute when there is no number.
 */
function Fact({ label, value, valueClass, tip, tipLabel, derived = false }) {
  return (
    <div className="pps-fact">
      <dt>
        {label}
        {tip && (
          <InfoTip label={tipLabel ?? label} className="pps-info">
            {tip}
          </InfoTip>
        )}
      </dt>
      <dd className={valueClass ?? undefined}>
        {value}
        {derived && value !== DASH && <span className="pps-derived"> {PERPS_CALCULATED_LABEL}</span>}
      </dd>
    </div>
  )
}

function pnlClass(pnl) {
  const n = numberOrNull(pnl)
  if (n === null || n === 0) return undefined
  return n > 0 ? 'pps-pnl-up' : 'pps-pnl-down'
}

/**
 * What a protection level is worth in money, ESTIMATED from the venue's own size and entry. It is
 * labelled as an estimate and rendered '—' whenever any input is missing, because a level's impact
 * computed from a guessed entry price would be a fabricated promise.
 */
function impactText({ level, sizeUsd, entryPrice, isLong, venueLabel }) {
  if (level === null || level === 'invalid') return 'Leave this blank to have none.'
  const entry = positiveNumber(entryPrice)
  if (entry === null || sizeUsd === null || isLong === null) {
    return `At ${formatPairPrice(level)}. ${DASH} — ${venueLabel} did not report enough to estimate what that is worth.`
  }
  const move = ((level - entry) / entry) * (isLong ? 1 : -1)
  return `At ${formatPairPrice(level)}, about ${formatSignedUsd(sizeUsd * move)} — estimated, before ${venueLabel}’s fees.`
}

/**
 * What the venue stored, said in the venue's own numbers.
 *
 * The clamped case is the one this exists for: a venue may round to its price grid or pull a level
 * inside its own limits, and a sheet that kept showing the requested number would be telling the
 * member they hold protection they do not have. Both levels are named as the VENUE's.
 */
function storedProtectionNote(outcome, requested, venueLabel) {
  const stored = outcome?.stored ?? null
  if (!stored) return null
  const legs = [
    { key: 'sl', label: 'stop-loss', value: stored.stopLoss },
    { key: 'tp', label: 'take-profit', value: stored.takeProfit },
  ].filter((leg) => leg.key in (requested ?? {}))
  if (legs.length === 0) return null

  const said = legs
    .map((leg) => (leg.value === null ? `no ${leg.label}` : `a ${leg.label} of ${formatPairPrice(leg.value)}`))
    .join(' and ')
  if (outcome.matchesRequest) return `${venueLabel} has stored ${said}.`

  const asked = legs
    .map((leg) => {
      const level = positiveNumber(requested?.[leg.key])
      return level === null ? `no ${leg.label}` : `${formatPairPrice(level)}`
    })
    .join(' and ')
  return `${venueLabel} stored ${said} — not the ${asked} you asked for. Venues round levels to their own price steps and limits, and the levels above are the ones ${venueLabel} holds.`
}

function hasRawCollateral(position) {
  const raw = bigintOrNull(position?.venueRef?.collateralAmount ?? position?.collateralAmount)
  return raw !== null && raw > 0n
}

/** '' → null ("remove it"), junk → 'invalid', otherwise a positive number. */
function textToLevel(text) {
  const s = String(text ?? '').trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return 'invalid'
  return n
}

/**
 * Decimals a member would actually type for a price of this magnitude. A flat precision cannot
 * serve both ETH at 4,011 and EUR/USD at 1.0841: eight decimals on the former prints float noise
 * into the field (`4011.69153226`) and reads as broken, while one decimal on the latter erases the
 * quote. Mirrors the bands in lib/perps/format.js, one step finer because this is an input a
 * member edits rather than a figure they read.
 */
function inputDecimalsFor(n) {
  if (n >= 1000) return 2
  if (n >= 100) return 3
  if (n >= 1) return 4
  return 6
}

function numberToText(value) {
  const n = positiveNumber(value)
  if (n === null) return ''
  return String(Number(n.toFixed(inputDecimalsFor(n))))
}

/**
 * Round a SUGGESTED protection level for display in the input, without breaking the guarantee that
 * `suggestProtection` only returns levels `validateProtection` accepts.
 *
 * Rounding a stop-loss can move it TOWARD the liquidation price, which is the one direction that
 * turns a valid pre-fill into one the app then refuses — so the rounded value is re-checked and the
 * exact value is kept when the rounded one would not survive. The member sees a tidy number
 * whenever a tidy number is safe, and never a pre-filled level the sheet immediately rejects.
 */
function suggestionToText(value, { isLong, kind, entryPrice, markPrice, liquidationPrice }) {
  const n = positiveNumber(value)
  if (n === null) return ''
  const rounded = Number(n.toFixed(inputDecimalsFor(n)))
  if (!(rounded > 0) || rounded === n) return numberToText(n)
  const check = validateProtection({
    position: { markPrice, entryPrice, isLong, liquidationPrice },
    stopLoss: kind === 'stop' ? rounded : null,
    takeProfit: kind === 'take' ? rounded : null,
    liquidationPrice,
    isLong,
  })
  return check?.ok === false ? String(n) : String(rounded)
}
