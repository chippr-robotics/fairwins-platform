/**
 * PerpsFeesPanel (spec 083 US5, contracts/fee-rails.md) — the two perps fee rails, each read from
 * the contract that ACTUALLY ENFORCES it.
 *
 * ── WHY THIS IS NOT A SECTION OF THE FEES TAB ──────────────────────────────────────────────────
 * The Fees tab (spec 060) is one screen over one FeeRouter per network, and that is exactly right
 * for every fee FairWins itself charges. Perps has one rail that does NOT live there and cannot be
 * made to:
 *
 *   GMX v2       the rate is a factor in GMX's OWN DataStore on Arbitrum, set by
 *                `ExchangeRouter.setUiFeeFactor`. There is deliberately no `perps.gmx.uifee`
 *                FeeRouter service (fee-rails.md): a service entry would be a second config store
 *                for a rate FairWins cannot enforce, and its admin control would silently do
 *                nothing — the failure mode `lib/fees/feeQuote.js` already documents.
 *   Hyperliquid  the rate IS a FeeRouter service (`perps.hyperliquid.builder`, cap 10 bps), so it
 *                is read here and EDITED IN THE FEES TAB. This panel links there rather than
 *                growing a second control for the same rate — two controls over one value is how
 *                an operator ends up believing the one they used is the one in force.
 *   Gains        a venue-paid rebate with no FairWins-settable rate at all. It is displayed as
 *                such and gets NO field, because a settable-looking control over a rate we cannot
 *                enforce is worse than no control.
 *
 * ── THE DANGEROUS CONTROL ──────────────────────────────────────────────────────────────────────
 * `setUiFeeFactor(uint256)` is `msg.sender`-keyed: GMX stores the factor under the SENDER's key,
 * and `claimUiFees` is `msg.sender`-keyed too. So a well-meaning administrator signing this from
 * their own wallet does not change the rate FairWins orders carry — FairWins orders name
 * `PERPS_UI_FEE_RECEIVER` as `uiFeeReceiver`, and GMX charges THAT key's factor — while any fees
 * that did accrue under the signer's key could only ever be claimed by the signer. The control
 * therefore REFUSES when the connected wallet is not the configured receiver, and says why, rather
 * than presenting a form whose effect is not the one the operator intends.
 *
 * ── HONEST STATES (spec 071) ───────────────────────────────────────────────────────────────────
 * Every read renders one of three things — read / not-deployed / unreadable — via
 * `lib/chains/chainReadResult.js`, and an unreachable chain NEVER renders as a zero: on a fee
 * schedule, a silent 0 is read as "we charge nothing", which is a statement of fact this panel is
 * not entitled to make. Providers come from `readProviderFor`, never hand-built from
 * `NETWORKS[chainId].rpcUrl` (spec 069).
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { encodeFunctionData } from 'viem'
import { normalizeAbi } from '../../lib/chains/readContract'
import { getContractAddressForChain } from '../../config/contracts'
import { GMX_EXCHANGE_ROUTER_ABI } from '../../abis/perps/gmxExchangeRouter'
import {
  gmxAddressesFor,
  perpsCohortSupported,
  perpsManageFeatureEnabled,
  perpsUiFeeReceiver,
} from '../../config/perps'
import { GMX_MAX_UI_FEE_BPS, HL_MAX_BUILDER_BPS, bpsToGmxUiFeeFactor } from '../../lib/perps/feeUnits'
import { isRead, isNotDeployed, isUnreadable } from '../../lib/chains/chainReadResult'
import { networkName, readProviderFor } from '../../lib/chains/estate'
import { getBlockscoutUrl } from '../../config/blockExplorer'
import {
  GMX_CHAIN_ID,
  HL_FEE_CHAIN_ID,
  bpsPct,
  readGmxUiFeeRail,
  readHyperliquidRail,
  shortAddr,
  uiFeeReceiverGuard,
} from './perpsFeeRails'
import './PerpsFeesPanel.css'

/**
 * One read rendered honestly. `undefined` is still loading — never 0, never '—', because "we have
 * not asked yet" is a fourth thing and saying it plainly costs nothing.
 */
function RailValue({ result, notDeployedLabel, children }) {
  if (result === undefined) return <span className="status-value">reading…</span>
  if (isNotDeployed(result)) {
    return <span className="status-value paused">{notDeployedLabel}</span>
  }
  if (isUnreadable(result)) {
    return (
      <span className="status-value paused perps-fees__unreadable">
        — could not be read ({result.reason}). This is not a rate of zero.
      </span>
    )
  }
  return children(result.value)
}

export default function PerpsFeesPanel({
  signer,
  account,
  chainId,
  provider,
  runTx,
  pendingTx,
  onOpenFees,
}) {
  const cohortOk = perpsCohortSupported()
  const manageEnabled = perpsManageFeatureEnabled()
  const receiver = perpsUiFeeReceiver()
  const gmxAddrs = useMemo(() => gmxAddressesFor(GMX_CHAIN_ID), [])
  const hlRouterAddr = useMemo(() => getContractAddressForChain('feeRouter', HL_FEE_CHAIN_ID), [])

  const gmxProvider = useMemo(
    () => readProviderFor(GMX_CHAIN_ID, chainId, provider),
    [chainId, provider],
  )
  const hlProvider = useMemo(
    () => readProviderFor(HL_FEE_CHAIN_ID, chainId, provider),
    [chainId, provider],
  )

  const [gmxRail, setGmxRail] = useState(undefined)
  const [hlRail, setHlRail] = useState(undefined)
  const [bpsForm, setBpsForm] = useState('')
  const [formError, setFormError] = useState(null)

  const refresh = useCallback(() => {
    if (!cohortOk) return
    let cancelled = false
    setGmxRail(undefined)
    setHlRail(undefined)
    readGmxUiFeeRail({ provider: gmxProvider, dataStore: gmxAddrs?.dataStore, receiver }).then((r) => {
      if (!cancelled) setGmxRail(r)
    })
    readHyperliquidRail({ provider: hlProvider, routerAddr: hlRouterAddr }).then((r) => {
      if (!cancelled) setHlRail(r)
    })
    return () => {
      cancelled = true
    }
  }, [cohortOk, gmxProvider, hlProvider, gmxAddrs, hlRouterAddr, receiver])

  useEffect(() => refresh(), [refresh])

  const guard = uiFeeReceiverGuard({ account, receiver })
  const onGmxChain = Number(chainId) === Number(GMX_CHAIN_ID)
  // The ceiling GMX itself reports, when it could be read. Never substituted by the module
  // constant for DISPLAY — an assumed ceiling shown as a read one is a fabricated fact. The
  // constant is used only as a client-side backstop in validation, and says so.
  const liveMaxBps = isRead(gmxRail) ? gmxRail.value.maxBps : null

  const handleSetUiFeeFactor = () => {
    setFormError(null)
    const gate = uiFeeReceiverGuard({ account, receiver })
    if (!gate.allowed) {
      setFormError(gate.reason)
      return
    }
    if (!gmxAddrs?.exchangeRouter) {
      setFormError('No GMX ExchangeRouter is configured for this chain, so there is nothing to send.')
      return
    }
    const raw = String(bpsForm).trim()
    if (raw === '') {
      setFormError('Enter the new UI fee in basis points of notional.')
      return
    }
    const bps = Number(raw)
    if (!Number.isFinite(bps) || bps < 0) {
      setFormError('Enter the new UI fee in basis points of notional (0 or more).')
      return
    }
    if (liveMaxBps != null && bps > liveMaxBps) {
      setFormError(
        `${bps} bps is above GMX's live MAX_UI_FEE_FACTOR of ${liveMaxBps} bps — GMX itself would ` +
          'refuse the transaction.',
      )
      return
    }
    const converted = bpsToGmxUiFeeFactor(bps)
    if (!converted) {
      setFormError('That rate could not be converted to a GMX uiFeeFactor.')
      return
    }
    if (converted.clamped) {
      // Never silently clamp: the operator asked for a rate, and being charged a different one
      // than the one typed is the whole class of defect feeUnits.js exists to prevent.
      setFormError(
        `${bps} bps is above GMX's documented ceiling of ${GMX_MAX_UI_FEE_BPS} bps. The rate is ` +
          'not lowered for you — enter a rate at or below the ceiling.',
      )
      return
    }
    runTx(
      () =>
        signer.sendTransaction({
          to: gmxAddrs.exchangeRouter,
          data: encodeFunctionData({
            abi: normalizeAbi(GMX_EXCHANGE_ROUTER_ABI),
            functionName: 'setUiFeeFactor',
            args: [converted.factor],
          }),
        }),
      `GMX UI fee set to ${converted.bps} bps of notional (uiFeeFactor ${converted.factor.toString()}) for ${shortAddr(receiver)}`,
    ).then(refresh)
  }

  if (!cohortOk) {
    return (
      <div className="admin-tab-content perps-fees" role="tabpanel">
        <div className="admin-card">
          <h3>Perps fees</h3>
          <p className="card-info">
            Every perps venue FairWins integrates is a mainnet venue, and this build runs against
            test networks. There is no perps fee rail to administer here — nothing is broken, and
            no test funds are involved.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-tab-content perps-fees" role="tabpanel">
      <div className="admin-card">
        <div className="admin-card-header">
          <h3>Perps fees</h3>
          <button type="button" className="refresh-btn" onClick={refresh} aria-label="Refresh perps fees">
            ↻
          </button>
        </div>
        <p className="card-info">
          Perps has two fee rails and they live in different places. Each rate below is read from
          the contract that will actually enforce it — never from FairWins config, and never
          mirrored into a second store. Perps fees are charged on <strong>notional</strong>
          {' '}(margin × leverage), not on the amount a member puts in.
        </p>
        {!manageEnabled && (
          <p className="card-info warning-text" role="status">
            <strong>Configured, and charged to nobody.</strong> In-app perps trading is behind{' '}
            <code>VITE_PERPS_MANAGE_ENABLED</code>, which is off in this build, so no order FairWins
            sends carries either rail today. The rates below are real and live on-chain; they simply
            ride nothing until the flag is on.
          </p>
        )}
      </div>

      {/* ── Rail 1: GMX, whose authority is GMX's own DataStore ─────────────────────────────── */}
      <div className="admin-card">
        <h3>GMX v2 UI fee — {networkName(GMX_CHAIN_ID)}</h3>
        <div className="status-details">
          <div className="status-row">
            <span className="status-label">Authority</span>
            <span className="status-value">
              GMX&apos;s own <code>DataStore</code>
              {gmxAddrs?.dataStore ? (
                <>
                  {' '}
                  <code title={gmxAddrs.dataStore}>{shortAddr(gmxAddrs.dataStore)}</code>
                </>
              ) : null}{' '}
              on {networkName(GMX_CHAIN_ID)} — not the FairWins FeeRouter, which has no service for
              this rate on purpose.
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">FairWins UI-fee receiver</span>
            <span className="status-value">
              {receiver ? (
                <code title={receiver}>{shortAddr(receiver)}</code>
              ) : (
                <span className="status-value paused">
                  none configured — GMX charges a zero UI fee when the receiver is the zero address
                </span>
              )}
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">Live rate (uiFeeFactor)</span>
            <RailValue
              result={gmxRail}
              notDeployedLabel={
                receiver
                  ? 'GMX is not deployed on a chain this build reads — no rate to show'
                  : 'no receiver configured — structurally fee-free, and nothing to read'
              }
            >
              {(v) =>
                v.bps == null ? (
                  <span className="status-value paused">
                    — the factor could not be converted to a rate
                  </span>
                ) : (
                  <span className="status-value">
                    {v.bps} bps ({bpsPct(v.bps)}) of notional
                    <span className="hint perps-fees__factor">
                      uiFeeFactor {v.factor.toString()}
                    </span>
                  </span>
                )
              }
            </RailValue>
          </div>
          <div className="status-row">
            <span className="status-label">Venue ceiling (MAX_UI_FEE_FACTOR)</span>
            <RailValue result={gmxRail} notDeployedLabel="—">
              {(v) =>
                v.maxBps == null ? (
                  <span className="status-value paused">—</span>
                ) : (
                  <span className="status-value">
                    {v.maxBps} bps ({bpsPct(v.maxBps)}) — read live from GMX, not assumed
                  </span>
                )
              }
            </RailValue>
          </div>
          <div className="status-row">
            <span className="status-label">Charged on</span>
            <span className="status-value">
              both sides — GMX applies the UI fee on increase <em>and</em> decrease, so a close
              carries it too.
            </span>
          </div>
        </div>
        {isRead(gmxRail) && gmxRail.value.bps === 0 && (
          <p className="card-info">
            The rate is zero, so members see no fee line anywhere and the integration behaves
            exactly as a fee-free one.
          </p>
        )}
        {gmxAddrs?.dataStore && getBlockscoutUrl(GMX_CHAIN_ID, gmxAddrs.dataStore, 'address') && (
          <p className="card-info">
            <a
              href={getBlockscoutUrl(GMX_CHAIN_ID, gmxAddrs.dataStore, 'address')}
              target="_blank"
              rel="noopener noreferrer"
            >
              GMX DataStore on the block explorer ↗
            </a>
          </p>
        )}
      </div>

      {/* ── The one control, and the one wallet allowed to use it ───────────────────────────── */}
      <div className="admin-card">
        <h3>Change the GMX UI fee</h3>
        <p className="card-info">
          Sent as <code>ExchangeRouter.setUiFeeFactor(uint256)</code> on {networkName(GMX_CHAIN_ID)}.
          GMX stores the factor under <code>msg.sender</code>, so the signing wallet <em>is</em> the
          receiver it configures — which is why only the recorded FairWins receiver may send it from
          here.
        </p>
        {!guard.allowed ? (
          <p className="card-info error perps-fees__refusal" role="alert">
            <strong>This wallet cannot change the GMX UI fee.</strong> {guard.reason}
          </p>
        ) : (
          <div className="admin-form">
            <label>
              New UI fee (bps of notional)
              <input
                type="number"
                min="0"
                step="0.1"
                max={liveMaxBps ?? GMX_MAX_UI_FEE_BPS}
                value={bpsForm}
                onChange={(e) => setBpsForm(e.target.value)}
                placeholder={`0 – ${liveMaxBps ?? GMX_MAX_UI_FEE_BPS}`}
              />
            </label>
            <span className="hint">
              {liveMaxBps == null
                ? `GMX's live ceiling could not be read, so this form checks against the documented ${GMX_MAX_UI_FEE_BPS} bps — GMX itself is the real gate and will refuse anything above its own.`
                : `Ceiling ${liveMaxBps} bps, read from GMX. A rate above it is refused here and by GMX; it is never quietly lowered.`}
            </span>
            {formError && (
              <p className="card-info error" role="alert">
                {formError}
              </p>
            )}
            <button
              type="button"
              className="confirm-btn primary"
              onClick={handleSetUiFeeFactor}
              disabled={!onGmxChain || pendingTx || !signer || !gmxAddrs?.exchangeRouter}
            >
              Set GMX UI fee
            </button>
            {!signer && (
              <p className="card-info warning-text" role="status">
                Connect the receiver wallet to sign. Everything above is readable without one.
              </p>
            )}
            {signer && !onGmxChain && (
              <p className="card-info warning-text" role="status">
                Your wallet is on {networkName(chainId)}. This transaction is signed on{' '}
                {networkName(GMX_CHAIN_ID)} — switch to it to send one. Reading is unaffected.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Rail 2: Hyperliquid, whose authority is the FeeRouter ───────────────────────────── */}
      <div className="admin-card">
        <h3>Hyperliquid builder fee — {networkName(HL_FEE_CHAIN_ID)}</h3>
        <div className="status-details">
          <div className="status-row">
            <span className="status-label">Authority</span>
            <span className="status-value">
              FairWins <code>FeeRouter</code> service <code>perps.hyperliquid.builder</code>
              {hlRouterAddr ? (
                <>
                  {' '}
                  at <code title={hlRouterAddr}>{shortAddr(hlRouterAddr)}</code>
                </>
              ) : null}{' '}
              on {networkName(HL_FEE_CHAIN_ID)}.
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">Live rate</span>
            <RailValue
              result={hlRail}
              notDeployedLabel={`no FeeRouter is deployed on ${networkName(HL_FEE_CHAIN_ID)} — no rate exists to charge`}
            >
              {(v) =>
                v.kind === 0 ? (
                  <span className="status-value paused">
                    not registered on this FeeRouter — nothing is charged
                  </span>
                ) : (
                  <span className="status-value">
                    {v.feeBps} bps ({bpsPct(v.feeBps)}) of order notional
                  </span>
                )
              }
            </RailValue>
          </div>
          <div className="status-row">
            <span className="status-label">Service cap</span>
            <RailValue result={hlRail} notDeployedLabel="—">
              {(v) =>
                v.kind === 0 ? (
                  <span className="status-value paused">—</span>
                ) : (
                  <span className="status-value">
                    {v.capBps} bps — the venue&apos;s own ceiling is {HL_MAX_BUILDER_BPS} bps
                    (builder <code>f ≤ 100</code>, tenths of a bp)
                  </span>
                )
              }
            </RailValue>
          </div>
          <div className="status-row">
            <span className="status-label">Trading status</span>
            <span className="status-value">
              read-only this release — Hyperliquid&apos;s L1 actions need an agent key even to close
              a position, so FairWins sends it no orders and this rate rides nothing.
            </span>
          </div>
        </div>
        {isRead(hlRail) && hlRail.value.kind !== 0 && hlRail.value.feeBps === 0 && (
          <p className="card-info">
            The rate is zero, so members would see no fee line at all.
          </p>
        )}
        <p className="card-info">
          This rate is edited where every other FeeRouter rate is edited —{' '}
          {onOpenFees ? (
            <button type="button" className="link-button" onClick={onOpenFees}>
              in the Fees tab
            </button>
          ) : (
            'in the Fees tab'
          )}
          . There is deliberately no second control for it here: one value with two controls is how
          an operator ends up trusting the wrong one.
        </p>
      </div>

      {/* ── Rail 3: Gains, which FairWins does not price ────────────────────────────────────── */}
      <div className="admin-card">
        <h3>Gains Network — no FairWins-settable rate</h3>
        <div className="status-details">
          <div className="status-row">
            <span className="status-label">Authority</span>
            <span className="status-value">
              the venue. Gains pays a referral rebate out of its own fee; there is no FairWins rate,
              no FeeRouter service, and nothing for an administrator to set.
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">Member cost</span>
            <span className="status-value">
              none added by FairWins — the member pays the venue&apos;s own fee and no more.
            </span>
          </div>
        </div>
        <p className="card-info">
          No field is offered here on purpose. A settable-looking control over a rate FairWins
          cannot enforce would silently do nothing, which is worse than having no control at all.
          The rebate itself earns nothing until Gains whitelists FairWins, and no revenue is claimed
          from it until that is confirmed on-chain.
        </p>
      </div>
    </div>
  )
}
