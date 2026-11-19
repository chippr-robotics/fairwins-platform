/**
 * OpenPositionSheet (spec 083, T050 + T052) — how a member opens a leveraged position.
 *
 * US3 is the acceptance criteria, and SC-006 is the shape of the whole file: the sheet arrives
 * ALREADY CONFIGURED, and the member changes at most two fields (normally the amount and the
 * leverage) to submit a valid order. Five rules shape every line below.
 *
 * 1. **THE MEMBER IS ALWAYS `msg.sender`.** This component never touches an ownership field. It
 *    assembles a descriptor of what the member asked for and hands it to `usePerpsTrade`, which
 *    hands it to the venue builders — and those refuse an order FairWins would own. The only
 *    FairWins address that can leave here is `uiFeeReceiver`, which travels as its own named GMX
 *    parameter in `buildOpenDescriptor`, never near `receiver`. Gains gets no referrer at all.
 *
 * 2. **INCLUSION IS NEVER EXECUTION.** No status is derived here. `usePerpsTrade` publishes the
 *    machine (`lib/perps/orderState.js`) and this file renders `trade.statusText` verbatim, so
 *    "Sent to Gains" on inclusion and "Position opened." only on the venue's own execution event
 *    are properties of the machine. There is deliberately no local `done` flag, and the sheet never
 *    describes a position until the venue has made one.
 *
 * 3. **THIS IS THE ENTRY PATH — the one place a gate belongs.** Screening and the jurisdiction
 *    attestation are wired into the trade hook here, for the one action (`open`) the hook treats as
 *    an entry. Nothing on this sheet can reach a close, a reduce or a recovery, and no exit-path
 *    module may import it; `test/perps/safetyInvariants.test.js` classifies this file as ENTRY and
 *    fails the build if that changes.
 *
 * 4. **HONEST NUMBERS.** Every preview figure is an ESTIMATE from the venue's own published
 *    numbers and is labelled as one (FR-009): there is no fill price, no actual size and no venue
 *    liquidation price until the venue executes. A figure that cannot be derived renders '—', never
 *    0. The FairWins rate is read from the contract that enforces it, a zero rate renders no fee
 *    line at all, and an UNREADABLE rate blocks opening — the one asymmetry with the exit sheet,
 *    and it is deliberate (fee-rails.md rule 4).
 *
 * 5. **NEVER A DEAD CONTROL.** A venue that is close-only, paused, unreadable, unsupported on this
 *    build, or whose own handle for this pair we cannot resolve is NOT OFFERED — the sheet states
 *    the reason with the venue named as its source and links to the venue's own app. What is
 *    offered is what can actually work.
 *
 * TESTABILITY: every side effect is injectable through `deps` — the trade hook, the fee read, the
 * venue quote, the allowance read and the attestation — so the whole lifecycle runs with no network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import InfoTip from '../ui/InfoTip'
import PerpsAttestation from './PerpsAttestation'
import { NETWORKS } from '../../config/networks'
import { PERP_VENUES, perpsUiFeeReceiver } from '../../config/perps'
import { usePerpsTrade } from '../../hooks/usePerpsTrade'
import { hasAttested, subscribeAttestation } from '../../lib/perps/attestation'
import { defaultCollateral, defaultLeverage, defaultSlippage, pickVenue } from '../../lib/perps/defaults'
import { rateToPct } from '../../lib/perps/feeUnits'
import { bpsToPct, formatLeverage, formatPairPrice, formatUsd } from '../../lib/perps/format'
import { tradeLinkFor } from '../../lib/perps/linkouts'
import { ORDER_STATE } from '../../lib/perps/orderState'
import { PERPS_TIPS } from '../../lib/perps/perpsCopy'
import { validateOpen } from '../../lib/perps/validation'
import { defaultReadFeeBps, formatWeiAmount } from './positionSheetActions'
import {
  bigintOrNull,
  buildOpenDescriptor,
  collateralUsdPrice,
  defaultReadAllowance,
  defaultReadOpenQuote,
  defaultScreenAccount,
  normalizeVenueOptions,
  numberOrNull,
  openEligibility,
  previewOpen,
  toBaseUnits,
  toHumanAmount,
} from './openPositionActions'
import './OpenPositionSheet.css'

const DASH = '—'

/**
 * The leverages a member can pick in one tap. They stop well short of every venue maximum on
 * purpose — a preset is a suggestion, and 150× is not one FairWins is willing to make. Anything
 * above the top preset is still reachable by typing, bounded by the venue's own published maximum.
 */
// Module-local: see the note on CLOSE_PRESETS in PositionSheet.jsx — exporting a constant from a
// component file breaks Fast Refresh, and nothing outside this sheet reads it.
const LEVERAGE_PRESETS = Object.freeze([2, 3, 5, 10])

/* ------------------------------------------------------------------------------------------- *
 * The sheet
 * ------------------------------------------------------------------------------------------- */

export default function OpenPositionSheet({
  /** The pair row the member tapped, straight off the venue feed. */
  pair,
  /**
   * One entry per venue that lists this pair, each with everything needed to ACT there:
   * `{ venue, chainId, status, pair, venueRef, collaterals, limits, minNotional, venueFeeUsd }`.
   * Absent means "just this pair's own venue", and the sheet then refuses wherever the venue's own
   * handle is missing rather than guessing one.
   */
  venueOptions = null,
  /** What the member actually holds: `[{ symbol, address, balance, decimals, usdValue }]`. */
  holdings = null,
  /** Public venue attribution, for the link-out. */
  attribution = null,
  onClose,
  onActionComplete,
  deps,
}) {
  const sheetRef = useRef(null)
  const restoreFocusRef = useRef(null)

  /* ----------------------------------------------------------------------------------------- *
   * What may be offered at all
   * ----------------------------------------------------------------------------------------- */

  const options = useMemo(() => normalizeVenueOptions(pair, venueOptions), [pair, venueOptions])
  const eligibility = useMemo(
    () => options.map((option) => ({ option, verdict: openEligibility(option) })),
    [options],
  )
  const openable = useMemo(() => eligibility.filter((e) => e.verdict.ok).map((e) => e.option), [eligibility])
  /* Why each venue that is NOT offered is not offered, in the VENUE's name (FR-016/FR-017). The
   * sheet shows these instead of a control that cannot work. */
  const blocked = useMemo(
    () => eligibility.filter((e) => !e.verdict.ok).map((e) => ({ label: e.option.label, reason: e.verdict.reason })),
    [eligibility],
  )

  const [chosenVenue, setChosenVenue] = useState(null)
  const [isLong, setIsLong] = useState(true)
  const [chosenCollateral, setChosenCollateral] = useState(null)
  const [amountText, setAmountText] = useState('')
  const [leverageText, setLeverageText] = useState('')
  const [refusal, setRefusal] = useState(null)

  /* SMART DEFAULT — the venue, with the REASON stated beside it (US3 acceptance 1). `pickVenue`
   * ranks on the venues' own live terms and never invents a difference it cannot explain. */
  const venueChoice = useMemo(
    () =>
      pickVenue(pair?.symbol, openable.map((option) => ({ venue: option.venue, canOpen: true, pairs: [option.pair] })), {
        isLong,
      }),
    [pair?.symbol, openable, isLong],
  )
  /* The member's choice wins, but only while it is still one of the offered venues: a venue that
   * goes close-only mid-flow must not stay selected because it was selected before. */
  const active =
    openable.find((option) => option.venue === chosenVenue) ??
    openable.find((option) => option.venue === venueChoice.venue) ??
    openable[0] ??
    null

  const venue = active?.venue ?? null
  const chainId = active?.chainId ?? null
  const venueMeta = venue ? PERP_VENUES[venue] : null
  const venueLabel = active?.label ?? 'the venue'
  const handle = active ? (eligibility.find((e) => e.option === active)?.verdict.handle ?? null) : null

  /* ----------------------------------------------------------------------------------------- *
   * The write path — and the two gates that belong ONLY on it
   * ----------------------------------------------------------------------------------------- */

  const useTrade = deps?.useTrade ?? usePerpsTrade
  const attest = deps?.hasAttested ?? hasAttested
  const subscribe = deps?.subscribeAttestation ?? subscribeAttestation
  const screen = deps?.screenAccount ?? defaultScreenAccount
  const tradeDeps = useMemo(
    () => ({ hasAttested: attest, screenAccount: screen, ...(deps?.trade ?? {}) }),
    [attest, screen, deps?.trade],
  )
  const trade = useTrade({
    deps: tradeDeps,
    identity: {
      venue,
      chainId,
      venueLabel,
      venueUrl: venueMeta?.homepage ?? null,
    },
  })

  /* Whether this browser has acknowledged the CURRENT wording. It is state rather than a call
   * during render because the acknowledgement can be given inside this very sheet, and the store
   * broadcasts it. The hook checks it again at submit time regardless — this only decides what the
   * sheet shows. */
  const [attested, setAttested] = useState(() => safeAttested(attest))
  useEffect(() => {
    setAttested(safeAttested(attest))
    const unsubscribe = subscribe(() => setAttested(safeAttested(attest)))
    return typeof unsubscribe === 'function' ? unsubscribe : undefined
    // Caller-owned dependencies; this exists to follow the STORE, not a re-rendered deps object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ----------------------------------------------------------------------------------------- *
   * Sheet shell — focus save/restore, Escape, and the body scroll lock with its cleanup
   *
   * Both of the corrections `PositionSheet` carries apply here for the same reasons: the lock is
   * GUARDED on there being something to show (a lock with no visible sheet leaves the page
   * unscrollable with no way out), and `onClose` rides a REF rather than being a dependency — this
   * sheet re-renders on the parent's market poll, and an effect keyed on an inline `onClose` would
   * re-run on every one of them, yanking a member out of the amount field they are typing in.
   * ----------------------------------------------------------------------------------------- */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  const hasPair = Boolean(pair)
  useEffect(() => {
    if (!hasPair) return undefined
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
  }, [hasPair])

  /* ----------------------------------------------------------------------------------------- *
   * The venue's own numbers — read here, because the venue is the authority for them
   * ----------------------------------------------------------------------------------------- */

  const [fee, setFee] = useState(null) // null = still reading
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
    // `readFee` is caller-owned; re-reading on a new venue/chain is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, chainId])

  /* The keeper fee GMX will not execute an order without. Read once per venue/chain, not polled:
   * the buffer in GMX's own estimate exists precisely so a quote does not go stale between reading
   * it and signing. A failure means we cannot assemble valid calldata — disclosed, with GMX's own
   * app named, never presented as a restriction. */
  const [quote, setQuote] = useState(null)
  const readQuote = deps?.readQuote ?? defaultReadOpenQuote
  useEffect(() => {
    if (!venue) return undefined
    let alive = true
    setQuote(null)
    Promise.resolve()
      .then(() => readQuote({ venue, chainId }))
      .then((result) => {
        if (alive) setQuote(result ?? null)
      })
      .catch(() => {
        if (alive) setQuote({ failed: true })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, chainId])

  /* ----------------------------------------------------------------------------------------- *
   * Smart defaults — collateral and leverage
   * ----------------------------------------------------------------------------------------- */

  /* The collateral is chosen from what the member ACTUALLY HOLDS, intersected with what the venue
   * accepts. A default they do not hold is not a default — it is a dead form that fails validation
   * the moment they type an amount. */
  const suggestedCollateral = useMemo(
    () => defaultCollateral(holdings, active?.collaterals),
    [holdings, active?.collaterals],
  )
  const collateralChoices = useMemo(() => {
    const held = new Map()
    for (const holding of Array.isArray(holdings) ? holdings : []) {
      const address = typeof holding?.address === 'string' ? holding.address.trim().toLowerCase() : null
      if (address) held.set(address, holding)
    }
    return (active?.collaterals ?? [])
      .map((collateral) => {
        const address = typeof collateral?.address === 'string' ? collateral.address.trim().toLowerCase() : null
        const holding = address ? held.get(address) : null
        if (!holding) return null
        return {
          ...collateral,
          balance: holding.balance,
          decimals: collateral.decimals ?? holding.decimals ?? null,
          usdValue: holding.usdValue ?? null,
        }
      })
      .filter(Boolean)
  }, [holdings, active?.collaterals])

  const collateral =
    collateralChoices.find((c) => sameAddress(c.address, chosenCollateral)) ??
    collateralChoices.find((c) => sameAddress(c.address, suggestedCollateral?.address)) ??
    suggestedCollateral ??
    collateralChoices[0] ??
    null

  const venueLimits = active?.limits ?? {}
  const maxLeverage = numberOrNull(venueLimits.maxLeverage) ?? numberOrNull(active?.pair?.maxLeverage)
  const minLeverage = numberOrNull(venueLimits.minLeverage)
  const suggestedLeverage = useMemo(
    () => defaultLeverage(maxLeverage, { minLeverage }),
    [maxLeverage, minLeverage],
  )

  /* The default is written into the FIELD (rather than only used as a fallback) so the member sees
   * the number they are about to trade at, and can change it. Once they type, it is theirs. */
  const leverageEditedRef = useRef(false)
  useEffect(() => {
    if (leverageEditedRef.current) return
    setLeverageText(suggestedLeverage === null ? '' : String(suggestedLeverage))
  }, [suggestedLeverage])

  /* Switching venue re-derives everything that belongs to a venue. Keeping the member's amount is
   * deliberate — it is theirs and means the same thing everywhere — but a collateral or a leverage
   * from another venue does not. */
  useEffect(() => {
    setChosenCollateral(null)
    leverageEditedRef.current = false
    setRefusal(null)
  }, [venue])

  /* ----------------------------------------------------------------------------------------- *
   * The order the member is about to place
   * ----------------------------------------------------------------------------------------- */

  const decimals = numberOrNull(collateral?.decimals)
  const collateralAmount = toBaseUnits(amountText, decimals)
  const balance = bigintOrNull(collateral?.balance)
  const leverage = positiveOrNull(leverageText)
  const entryPrice = positiveOrNull(active?.pair?.price)
  const usdPrice = collateralUsdPrice(collateral)

  const feeBps = fee && !fee.failed ? numberOrNull(fee.bps) : null
  const preview = useMemo(
    () =>
      previewOpen({
        collateralAmount,
        collateralDecimals: decimals,
        collateralUsdPrice: usdPrice,
        leverage,
        entryPrice,
        isLong,
        feeBps,
        venueFee: active?.venueFee ?? null,
      }),
    [collateralAmount, decimals, usdPrice, leverage, entryPrice, isLong, feeBps, active?.venueFee],
  )

  /* VALIDATION BEFORE ANY WALLET PROMPT (FR-022 / US3 acceptance 3). It runs on every keystroke and
   * drives both the disabled state and the sentence under the amount, so a member learns why before
   * they reach for their wallet rather than after they have paid gas to find out. */
  const check = useMemo(
    () =>
      validateOpen({
        collateralAmount,
        balance,
        leverage,
        venueLimits: active?.limits ?? null,
        notional: preview.notionalUsd,
        minNotional: active?.minNotional ?? null,
        // The venue's own floor on what a position may be worth, checked BEFORE the wallet prompt.
        // Gains answers this one with `InsufficientCollateral`, which costs gas to read and names
        // nothing a member can act on.
        collateralUsd: preview.collateralUsd,
        minCollateralUsd: active?.minCollateralUsd ?? null,
      }),
    [
      collateralAmount,
      balance,
      leverage,
      active?.limits,
      active?.minNotional,
      active?.minCollateralUsd,
      preview.notionalUsd,
      preview.collateralUsd,
    ],
  )

  /* The allowance the venue's own collateral puller already holds. `null` is "we could not ask",
   * and the descriptor then includes an approval leg — redundant at worst, where assuming zero
   * would be a claim about the member's wallet and assuming enough would build an order that
   * reverts. */
  const [allowance, setAllowance] = useState(null)
  const readAllowance = deps?.readAllowance ?? defaultReadAllowance
  const account = trade.account ?? null
  const collateralAddress = collateral?.address ?? null
  useEffect(() => {
    if (!venue || !collateralAddress || !account) return undefined
    let alive = true
    setAllowance(null)
    Promise.resolve()
      .then(() => readAllowance({ venue, chainId, token: collateralAddress, owner: account }))
      .then((result) => {
        if (alive) setAllowance(bigintOrNull(result))
      })
      .catch(() => {
        if (alive) setAllowance(null)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, chainId, collateralAddress, account])

  /* "An order of ours is in flight", asked of the MACHINE rather than answered here. Enumerating
   * the pre-submission state names would be a copy of the machine's state list, and a copy does not
   * grow when the machine does. */
  const busy = trade.status !== ORDER_STATE.IDLE && !trade.terminal
  const executed = trade.status === ORDER_STATE.EXECUTED
  const settledWithoutExecution = trade.terminal && !executed

  /* The venue's execution is the ONLY thing that reports a position. */
  const reportedRef = useRef(null)
  useEffect(() => {
    if (trade.status !== ORDER_STATE.EXECUTED) return
    if (reportedRef.current === trade.order) return
    reportedRef.current = trade.order
    onActionComplete?.(trade.order)
  }, [trade.status, trade.order, onActionComplete])

  const feeUnreadable = Boolean(fee?.failed)
  const feeApplies = preview.feeApplies
  /* THE ONE ASYMMETRY WITH THE EXIT SHEET (fee-rails.md rule 4). An unreadable rate blocks OPENING,
   * because proceeding would mean a member signing an order whose cost we could not state. The same
   * failure never blocks a close — nothing about an exit depends on that rate. */
  const feeUndisclosable = feeApplies && preview.feeUsd === null
  const quoteUnreadable = Boolean(quote?.failed)

  const canSubmit =
    Boolean(active) && check.ok && attested && !busy && !feeUnreadable && !feeUndisclosable && !quoteUnreadable

  const submit = useCallback(async () => {
    if (!active) return
    const built = buildOpenDescriptor({
      venue,
      chainId,
      handle,
      isLong,
      collateral,
      collateralAmount,
      leverage,
      entryPrice,
      notionalUsd: preview.notionalUsd,
      collateralUsd: preview.collateralUsd,
      minNotional: active.minNotional ?? null,
      minCollateralUsd: active.minCollateralUsd ?? null,
      venueLimits: active.limits ?? null,
      slippagePct: defaultSlippage(),
      quote,
      uiFeeReceiver: perpsUiFeeReceiver(),
      allowance,
    })
    if (!built.ok) {
      setRefusal(built.reason)
      return
    }
    setRefusal(null)
    // A session with no rail on this chain is not a restriction — it is the absence of a way to
    // send. Saying so, with the venue's own surface named, is more useful than a signature prompt
    // that cannot land.
    if (trade.canTransactOn && !trade.canTransactOn(built.descriptor.chainId)) {
      setRefusal(
        `${trade.cannotTransactReason?.(built.descriptor.chainId) ?? 'This session cannot send transactions on that network.'} You can open this position on ${venueLabel} instead.`,
      )
      return
    }
    await trade.submit(built.descriptor)
  }, [
    active,
    venue,
    chainId,
    handle,
    isLong,
    collateral,
    collateralAmount,
    leverage,
    entryPrice,
    preview.notionalUsd,
    preview.collateralUsd,
    quote,
    allowance,
    trade,
    venueLabel,
  ])

  if (!pair) return null

  const titleId = 'perps-open-sheet-title'
  const networkName = NETWORKS[chainId]?.name ?? null
  const venueUrl = tradeLinkFor(active?.pair ?? pair, attribution ?? {})
  /* The footer names a venue even when NOTHING is offered — that is the case where the member most
   * needs it. Falling back to the tapped pair's own venue keeps "you can always trade there
   * directly" a real sentence instead of "you can trade at the venue". */
  const linkMeta = PERP_VENUES[venue ?? pair.venue] ?? null
  const linkLabel = linkMeta?.shortLabel ?? linkMeta?.label ?? venueLabel
  const linkFullName = linkMeta?.label ?? linkLabel
  const statusText = trade.statusText
  const keeperFeeText = quote?.executionFee == null ? null : formatWeiAmount(quote.executionFee)
  const nativeSymbol = NETWORKS[chainId]?.nativeCurrency?.symbol ?? null
  const humanBalance = toHumanAmount(collateral?.balance, decimals)

  return (
    <div className="asset-sheet-backdrop">
      <button
        type="button"
        className="asset-sheet-scrim"
        aria-label="Dismiss this trade panel"
        onClick={onClose}
      />
      <div
        className="asset-sheet perps-open-sheet"
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
              Open {isLong ? 'a long' : 'a short'} on {pair.symbol || 'this market'}
              {active?.pair?.variant ? <span className="pos-variant"> {active.pair.variant}</span> : null}
            </h3>
            <p className="pos-venue">
              {active ? `On ${venueMeta?.label ?? venueLabel}` : 'No venue available'}
              {networkName ? ` · ${networkName}` : ''}
            </p>
          </div>
          <button type="button" className="asset-sheet-close" onClick={onClose}>
            Dismiss
          </button>
        </div>

        {/* WHY EACH UNAVAILABLE VENUE IS UNAVAILABLE, with the venue named as the source. This is
            what replaces a disabled control: the member is told what is true rather than shown a
            button that cannot work. */}
        {blocked.length > 0 && (
          <ul className="pos-blocked">
            {blocked.map((entry) => (
              <li key={entry.label}>{entry.reason}</li>
            ))}
          </ul>
        )}

        {!active ? (
          <p className="pos-note">
            No venue is taking new positions on {pair.symbol || 'this market'} through FairWins right
            now. Nothing you already hold is affected, and you can still manage every position you
            have.
          </p>
        ) : (
          <>
            {statusText && (
              <p
                className={`pos-status ${executed ? 'pos-status-done' : trade.terminal ? 'pos-status-attention' : 'pos-status-pending'}`}
                role="status"
              >
                {statusText}
              </p>
            )}
            {refusal && (
              <p className="pos-error" role="alert">
                {refusal}
              </p>
            )}
            {/* A venue that cancelled the order took no FairWins fee, because the venue computes it
                at EXECUTION — an order that never executed was never charged (US3 acceptance 5). */}
            {settledWithoutExecution && (
              <p className="pos-note" role="note">
                Your collateral was returned by {venueLabel}, and no FairWins fee was charged — the
                fee is taken by {venueLabel} when an order executes, and this one did not.
              </p>
            )}

            {/* Venue ------------------------------------------------------------------------- */}
            <section className="pos-section" aria-labelledby="pos-venue-heading">
              <h4 id="pos-venue-heading" className="pos-section-title">
                Where this trades
              </h4>
              {openable.length > 1 ? (
                <fieldset className="pos-choice-fieldset">
                  <legend>Venue</legend>
                  <div className="pos-choices">
                    {openable.map((option) => (
                      <label
                        key={option.venue}
                        className={`pos-choice ${option.venue === venue ? 'selected' : ''}`}
                        htmlFor={`pos-venue-${option.venue}`}
                      >
                        <input
                          id={`pos-venue-${option.venue}`}
                          type="radio"
                          name="pos-venue"
                          value={option.venue}
                          checked={option.venue === venue}
                          disabled={busy}
                          onChange={() => {
                            setChosenVenue(option.venue)
                            setRefusal(null)
                          }}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : (
                <p className="pos-note">{venueLabel} is the only venue trading this pair here.</p>
              )}
              {/* THE REASON THE CHOICE WAS MADE FOR THEM (US3 acceptance 1). */}
              {venueChoice.venue === venue && venueChoice.reason && (
                <p className="pos-reason">
                  {venueLabel} is chosen for you: {lowerFirst(venueChoice.reason)}.
                </p>
              )}
            </section>

            {/* Direction --------------------------------------------------------------------- */}
            <section className="pos-section" aria-labelledby="pos-direction-heading">
              <h4 id="pos-direction-heading" className="pos-section-title">
                Which way
              </h4>
              <fieldset className="pos-choice-fieldset">
                <legend>Direction</legend>
                <div className="pos-choices">
                  {[
                    { value: true, label: 'Long — you gain if the price rises' },
                    { value: false, label: 'Short — you gain if the price falls' },
                  ].map((choice) => (
                    <label
                      key={String(choice.value)}
                      className={`pos-choice ${isLong === choice.value ? 'selected' : ''}`}
                      htmlFor={`pos-direction-${choice.value}`}
                    >
                      <input
                        id={`pos-direction-${choice.value}`}
                        type="radio"
                        name="pos-direction"
                        checked={isLong === choice.value}
                        disabled={busy}
                        onChange={() => {
                          setIsLong(choice.value)
                          setRefusal(null)
                        }}
                      />
                      <span>{choice.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="pos-reason">Long is chosen for you: it is the ordinary starting point.</p>
            </section>

            {/* Amount + collateral ----------------------------------------------------------- */}
            <section className="pos-section" aria-labelledby="pos-amount-heading">
              <h4 id="pos-amount-heading" className="pos-section-title">
                How much to put in
              </h4>

              {collateralChoices.length > 1 ? (
                <div className="pos-field">
                  <label htmlFor="pos-collateral">Pay with</label>
                  <select
                    id="pos-collateral"
                    value={collateral?.address ?? ''}
                    disabled={busy}
                    onChange={(e) => {
                      setChosenCollateral(e.target.value)
                      setRefusal(null)
                    }}
                  >
                    {collateralChoices.map((choice) => (
                      <option key={choice.address} value={choice.address}>
                        {choice.symbol}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {collateral ? (
                <>
                  {collateralChoices.length > 1 && suggestedCollateral?.symbol && (
                    <p className="pos-reason">
                      {suggestedCollateral.symbol} is chosen for you: it is the steadiest thing you
                      hold that {venueLabel} accepts here.
                    </p>
                  )}
                  <div className="pos-field">
                    <label htmlFor="pos-amount">Amount ({collateral.symbol})</label>
                    <input
                      id="pos-amount"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0.00"
                      value={amountText}
                      disabled={busy}
                      aria-describedby="pos-amount-help"
                      onChange={(e) => {
                        setAmountText(e.target.value)
                        setRefusal(null)
                      }}
                    />
                    <p id="pos-amount-help" className="pos-impact">
                      You hold {humanBalance === null ? DASH : trimNumber(humanBalance)} {collateral.symbol}
                      {preview.collateralUsd === null ? '' : ` · about ${formatUsd(preview.collateralUsd)} in`}
                    </p>
                  </div>
                </>
              ) : (
                <p className="pos-note">
                  You do not hold any of the collateral {venueLabel} accepts for this market, so a
                  position cannot be opened here yet.
                </p>
              )}
            </section>

            {/* Leverage ---------------------------------------------------------------------- */}
            <section className="pos-section" aria-labelledby="pos-leverage-heading">
              <h4 id="pos-leverage-heading" className="pos-section-title">
                Leverage
                <InfoTip label="About leverage" className="pos-info">
                  {PERPS_TIPS.maxLeverage}
                </InfoTip>
              </h4>
              <div className="pos-choices">
                {LEVERAGE_PRESETS.filter((preset) => maxLeverage === null || preset <= maxLeverage).map((preset) => (
                  <label
                    key={preset}
                    className={`pos-choice ${leverage === preset ? 'selected' : ''}`}
                    htmlFor={`pos-leverage-${preset}`}
                  >
                    <input
                      id={`pos-leverage-${preset}`}
                      type="radio"
                      name="pos-leverage"
                      checked={leverage === preset}
                      disabled={busy}
                      onChange={() => {
                        leverageEditedRef.current = true
                        setLeverageText(String(preset))
                        setRefusal(null)
                      }}
                    />
                    <span>{formatLeverage(preset)}</span>
                  </label>
                ))}
              </div>
              <div className="pos-field">
                <label htmlFor="pos-leverage">Or type a multiplier</label>
                <input
                  id="pos-leverage"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={DASH}
                  value={leverageText}
                  disabled={busy}
                  onChange={(e) => {
                    leverageEditedRef.current = true
                    setLeverageText(e.target.value)
                    setRefusal(null)
                  }}
                />
              </div>
              {suggestedLeverage !== null && (
                <p className="pos-reason">
                  {formatLeverage(suggestedLeverage)} is chosen for you: at that multiplier the price
                  has to move about {Math.round(100 / suggestedLeverage)}% against you before{' '}
                  {venueLabel} would liquidate the position. {venueLabel} allows up to{' '}
                  {formatLeverage(maxLeverage)} here.
                </p>
              )}
              <p className="pos-note">
                Leverage multiplies losses as well as gains. A move against you of enough size
                liquidates the position and the amount you put in is gone.
              </p>
            </section>

            {/* The position they are about to hold ------------------------------------------- */}
            <section className="pos-section" aria-labelledby="pos-preview-heading">
              <h4 id="pos-preview-heading" className="pos-section-title">
                What you would be holding
              </h4>
              <dl className="pos-breakdown">
                <div>
                  <dt>Position size (estimated)</dt>
                  <dd>{preview.notionalUsd === null ? DASH : formatUsd(preview.notionalUsd)}</dd>
                </div>
                <div>
                  <dt>Estimated entry price</dt>
                  <dd>{formatPairPrice(preview.entryPrice)}</dd>
                </div>
                <div>
                  <dt>
                    Estimated liquidation price
                    <InfoTip label="About liquidation" className="pos-info">
                      {PERPS_TIPS.liquidation}
                    </InfoTip>
                  </dt>
                  <dd>{formatPairPrice(preview.liquidationPrice)}</dd>
                </div>
                {/* THE VENUE'S OWN FEE, in money, from the rate the venue publishes. The rate is in
                    the label so the estimate can be checked rather than taken on trust, and the
                    word "estimated" is load-bearing: this is a published rate applied to the size
                    on screen, not a quote the venue gave for this order. */}
                <div>
                  <dt>
                    {venueLabel}’s own fee
                    {preview.venueFeeRate === null ? '' : ` (${rateToPct(preview.venueFeeRate)} of size)`}
                    {preview.venueFeeUsd === null ? '' : ', estimated'}
                  </dt>
                  <dd>{preview.venueFeeUsd === null ? DASH : formatUsd(preview.venueFeeUsd)}</dd>
                </div>
                {/* A ZERO RATE SHOWS NO FEE LINE AT ALL (FR-012) — not "$0.00", which reads as a
                    fee that happens to round down. */}
                {feeApplies && (
                  <div>
                    <dt>FairWins fee ({bpsToPct(preview.feeBps)} of size)</dt>
                    <dd>{preview.feeUsd === null ? DASH : formatUsd(preview.feeUsd)}</dd>
                  </div>
                )}
                {keeperFeeText !== null && (
                  <div>
                    <dt>{venueLabel} keeper fee (estimated)</dt>
                    <dd>
                      {keeperFeeText}
                      {nativeSymbol ? ` ${nativeSymbol}` : ''}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Total cost</dt>
                  <dd>{preview.totalCostUsd === null ? DASH : formatUsd(preview.totalCostUsd)}</dd>
                </div>
              </dl>

              {/* WHAT KIND OF NUMBER THE VENUE'S FEE IS. A published rate applied to the size on
                  screen — not a quote, and not the whole of what the venue charges. Saying which
                  costs are still outside it is the difference between an estimate and a claim. */}
              {preview.venueFeeUsd !== null && (
                <p className="pos-note">
                  {venueLabel}’s fee is worked out from the rate {venueLabel} publishes for this
                  market, not from a quote for this order. It does not include {venueLabel}’s spread
                  or the price impact of your order, or the borrowing and funding {venueLabel}{' '}
                  charges while the position is open.
                </p>
              )}
              {/* THE FLOOR, WHICH IS THE ONE CASE WHERE THE HEADLINE RATE IS MISLEADING. Under the
                  venue's minimum-fee size, the rate stops being what the member pays: a $50 BTC
                  position is charged as a $285.72 one, an effective 0.2% against a headline 0.035%.
                  Stating the rate alone there would understate the cost nearly six times over. */}
              {preview.venueFeeAtFloor && (
                <p className="pos-note" role="note">
                  This position is below {venueLabel}’s smallest fee size, so {venueLabel} charges
                  its fee as though the position were{' '}
                  {formatUsd(preview.venueFeeChargedOnUsd)} rather than{' '}
                  {preview.notionalUsd === null ? DASH : formatUsd(preview.notionalUsd)}. A larger
                  position pays the same fee.
                </p>
              )}
              {/* An absent rate is disclosed rather than left as a bare dash beside a FairWins fee
                  in money — which would read as though our fee were the cost of trading. */}
              {preview.venueFeeUsd === null && (
                <p className="pos-note" role="note">
                  {venueLabel} does not publish its own trading fee to this app, so it shows “{DASH}”
                  and the total above does not include it. {venueLabel} takes it when this executes.
                </p>
              )}
              {/* THE FEE'S BASE, STATED HONESTLY (FR-013). Perps fees are charged on the position's
                  SIZE, which at 10× is ten times the amount the member put in — a member who reads
                  "5 bps" as 5 bps of their stake has been misled by omission. */}
              {feeApplies && (
                <p className="pos-note">
                  The FairWins fee is charged on the position’s size (
                  {preview.notionalUsd === null ? DASH : formatUsd(preview.notionalUsd)}), not on the{' '}
                  {preview.collateralUsd === null ? 'amount' : formatUsd(preview.collateralUsd)} you
                  put in, and {venueLabel} takes it when this executes.
                </p>
              )}
              {keeperFeeText !== null && (
                <p className="pos-note">
                  {venueLabel} pays a keeper to execute this order, and this deposit is what pays
                  them. It is set a little above the current estimate so the order cannot stall if
                  gas moves before you sign — {venueLabel} returns whatever the keeper does not
                  spend. It is paid in {nativeSymbol ?? 'the network’s own coin'} and is not included
                  in the total above.
                </p>
              )}
              <p className="pos-note">
                These are estimates from {venueLabel}’s last reported figures, before {venueLabel}’s
                own fees and funding. Nothing here is a position yet — the size, the entry price and
                the liquidation price that count are the ones {venueLabel} records when it executes
                this. Your price tolerance is {defaultSlippage()}%.
              </p>
              {feeUnreadable && (
                <p className="pos-note" role="note">
                  The FairWins fee rate could not be confirmed just now, so a position cannot be
                  opened here until it can be — we will not ask you to sign for a cost we cannot
                  state. Everything you already hold is unaffected and can still be closed.
                </p>
              )}
              {quoteUnreadable && (
                <p className="pos-note" role="note">
                  {venueLabel}’s keeper fee could not be read just now, so an order cannot be
                  prepared here. You can open a position on {venueLabel} directly.
                </p>
              )}
            </section>

            {/* PASSKEY DISCLOSURE (T052 / FR-020). On this rail the SMART ACCOUNT is `msg.sender`,
                so the smart account — not the passkey — owns the resulting position. It is said
                plainly at the confirm step rather than excluding those members. */}
            {trade.isPasskey && (
              <p className="pos-disclosure" role="note">
                You are signed in with a passkey, so this order is sent by your smart account
                {account ? ` (${shortAddress(account)})` : ''} — and your smart account will own the
                position, not the passkey you sign with. You can close it from here, and it belongs
                to that account on {venueLabel} too.
              </p>
            )}

            {/* THE ATTESTATION — opening only. It renders here, immediately above the control it
                gates, so the member can see what is being asked and give it in place. */}
            {!attested && (
              <PerpsAttestation
                venueLabel={venueLabel}
                onAcknowledged={() => setAttested(true)}
                deps={deps?.attestation}
              />
            )}

            {/* The refusal, in plain words, BEFORE any wallet prompt. */}
            {!check.ok && (
              <p className="pos-error" role="alert">
                {check.reason}
              </p>
            )}
            {check.ok && feeUndisclosable && (
              <p className="pos-error" role="alert">
                This position’s size in dollars could not be worked out, so the FairWins fee could
                not be shown — and we will not ask you to sign for a cost we cannot state.
              </p>
            )}

            <button type="button" className="pos-primary" onClick={submit} disabled={!canSubmit}>
              {isLong ? 'Open this long' : 'Open this short'}
            </button>
            {!attested && (
              <p className="pos-note">
                Confirm the statements above to open a position. They are not needed to close,
                reduce or recover anything you already hold.
              </p>
            )}
            <p className="pos-note">
              A stop-loss and a take-profit can be set on the position once {venueLabel} has opened
              it.
            </p>
          </>
        )}

        <p className="pos-footer">
          FairWins never holds this position — it would be yours at {linkFullName}, and you can
          always trade there directly.{' '}
          {venueUrl && (
            <a
              className="pos-venue-link"
              href={venueUrl}
              target="_blank"
              rel="noopener noreferrer"
              // WCAG 2.5.3: the accessible name starts with the visible text (see PerpsPositions).
              aria-label={`Trade on ${linkLabel}: ${pair.symbol || 'this market'} on ${linkFullName} (opens in a new tab)`}
            >
              Trade on {linkLabel} ↗
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

/** The store is total, but `deps.hasAttested` is caller-supplied; unreadable is NOT attested. */
function safeAttested(read) {
  try {
    return read() === true
  } catch {
    return false
  }
}

function positiveOrNull(value) {
  const n = numberOrNull(value)
  return n !== null && n > 0 ? n : null
}

function sameAddress(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Enough precision for a token balance without printing float noise at a member. */
function trimNumber(value) {
  const n = numberOrNull(value)
  if (n === null) return DASH
  return String(Number(n.toFixed(6)))
}

function shortAddress(address) {
  const s = String(address ?? '')
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s
}

/** `pickVenue`'s reasons are sentences of their own; this puts one inside another one. */
function lowerFirst(text) {
  const s = String(text ?? '')
  return s === '' ? s : s[0].toLowerCase() + s.slice(1)
}
