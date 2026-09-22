/**
 * FeesTab (spec 060) — unified platform-fee management for the operations
 * control plane.
 *
 * One screen for every platform-fee system:
 *   - Wrapper services on the FeeRouter (earn.lend today) — live bps, hard cap,
 *     treasury destination; editable on-chain via the connected wallet
 *     (FEE_ADMIN_ROLE for rates, DEFAULT_ADMIN_ROLE for the treasury). The
 *     contract enforces caps and roles; the UI validates first for clear errors.
 *   - The Polymarket builder fee (spec 057) — its taker/maker entries live on
 *     the SAME FeeRouter (ConfigOnly kind); the relay-gateway reads them, so an
 *     edit here is live in Predict within the gateway cache TTL (~30 s).
 *   - The OpenSea referral (spec 056) — display-only: a no-cost attribution
 *     program with no rate to edit (beneficiary is deployment-managed).
 *
 * Change history renders from FeeBpsChanged events (actor / old → new), the
 * on-chain audit trail — bounded lookback with an explorer link for the rest.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { encodeFunctionData, keccak256, stringToBytes, zeroAddress } from 'viem'
import { getContractAddressForChain } from '../../config/contracts'
import { FEE_ROUTER_ABI } from '../../abis/FeeRouter'
import { gatewayBaseUrl } from '../../hooks/useGatewayStatus'
import { getBlockscoutUrl } from '../../config/blockExplorer'
import { estateNetworks, networkName, readProviderFor, readAuthority, authorityGate } from '../../lib/chains/estate'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { eventScanHandle } from '../../lib/chains/eventScan'
import { getLogsRange } from '../../lib/chains/logRange'
import { getPublicClient } from '../../lib/chains/publicClient'
import { getAddress, isAddress } from '../../lib/evm/address'
import { NetworkScopeCard } from './scopeControls'
import { useScopedChain } from './scopeGate'

/**
 * `keccak256(utf8(label))` — the FeeRouter's `bytes32 serviceId`.
 *
 * This replaced `ethers.id`, and the two were byte-compared before the swap over all nine labels
 * below plus empty, unicode and whitespace-padded fuzz: identical every time. They have to be.
 * These strings key `KNOWN_SERVICES`, so one wrong byte does not throw — it makes a live service
 * fall through to the `Service 0x1234abcd…` fallback label, which reads as an unknown service
 * somebody registered rather than as a bug in this file.
 */
const serviceId = (label) => keccak256(stringToBytes(label))

// Friendly names for known service ids (keccak256 of the registered label).
const KNOWN_SERVICES = {
  [serviceId('earn.lend')]: { label: 'Earn — vault lending (Morpho)', surface: 'Earn deposits' },
  [serviceId('polymarket.taker')]: { label: 'Predict — Polymarket builder fee (taker)', surface: 'Predict orders' },
  [serviceId('polymarket.maker')]: { label: 'Predict — Polymarket builder fee (maker)', surface: 'Predict orders' },
  [serviceId('stake.lido')]: { label: 'Stake — Lido', surface: 'Staking (future)' },
  [serviceId('stake.polygon')]: { label: 'Stake — Polygon liquid staking', surface: 'Staking (future)' },
  [serviceId('swap.uniswap')]: { label: 'Swap — Uniswap', surface: 'Swaps (future)' },
  [serviceId('bridge.transfer')]: { label: 'Bridge — Across transfer', surface: 'Bridge (Transfer)' },
  [serviceId('liquidity.deposit')]: { label: 'Supply — Uniswap liquidity', surface: 'Earn supplies' },
  [serviceId('perps.hyperliquid.builder')]: {
    label: 'Perps — Hyperliquid builder fee',
    surface: 'Perps link-outs (Trade)',
  },
}

const KIND_NAMES = { 1: 'Charged on-chain (wrapper)', 2: 'Read by the gateway (config-only)' }
const HISTORY_LOOKBACK_BLOCKS = 200_000
const HISTORY_LIMIT = 25

function shortAddr(a) {
  return a && a !== zeroAddress ? `${a.substring(0, 6)}...${a.substring(a.length - 4)}` : ''
}

function bpsPct(bps) {
  return `${(Number(bps) / 100).toFixed(2)}%`
}

export default function FeesTab({ signer, account, chainId, provider, runTx, pendingTx, isAdmin, isFeeAdmin }) {
  // Spec 071 US4: fee rates are genuinely per network — each chain's FeeRouter carries its own
  // services and its own bps. Showing the wallet's chain alone presented ONE network's rates as
  // if they were the platform's, which for a fee schedule is a materially wrong statement.
  const feeNetworks = useMemo(() => estateNetworks(), [])
  const { scopeChainId, setScopeChainId } = useScopedChain(feeNetworks, chainId)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)
  const routerAddr = getContractAddressForChain('feeRouter', scopeChainId)
  const readProvider = useMemo(
    () => readProviderFor(scopeChainId, chainId, provider),
    [scopeChainId, chainId, provider],
  )
  // Authority is read from the FeeRouter that will ENFORCE it, on the scoped chain — never from
  // the app-wide flags. `isFeeAdmin` means "holds FEE_ADMIN_ROLE somewhere in the estate", which
  // on a per-chain fee schedule is the wrong question: it would offer an enabled Set-fee button on
  // a network whose router will revert. The flags are kept only as the pre-read assumption, so an
  // operator who does hold the role is not made to wait on a round-trip to see the form.
  const [authority, setAuthority] = useState(null)
  useEffect(() => {
    let cancelled = false
    readAuthority({
      chainId: scopeChainId,
      provider: readProvider,
      address: routerAddr,
      account,
      roles: ['admin', 'feeAdmin'],
    }).then((a) => {
      if (!cancelled) setAuthority(a)
    })
    return () => { cancelled = true }
  }, [readProvider, routerAddr, account, scopeChainId])

  const feeGate = authorityGate(authority, ['admin', 'feeAdmin'])
  const treasuryGate = authorityGate(authority, ['admin'])
  // Pending (first read in flight) falls back to the app-wide flag rather than blanking the form.
  const canEditFees = feeGate.pending ? Boolean(isAdmin || isFeeAdmin) : feeGate.allowed
  const canEditTreasury = treasuryGate.pending ? Boolean(isAdmin) : treasuryGate.allowed

  const [services, setServices] = useState(null) // null = loading; [] = none
  const [treasury, setTreasury] = useState(undefined)
  const [maxWrappedCap, setMaxWrappedCap] = useState(null)
  const [readError, setReadError] = useState(null)
  const [history, setHistory] = useState({ entries: null, truncated: false, error: null })
  const [gatewayFees, setGatewayFees] = useState(null) // /status fees block, null until loaded
  const [feeForm, setFeeForm] = useState({ serviceId: '', bps: '' })
  const [treasuryForm, setTreasuryForm] = useState('')
  const [formError, setFormError] = useState(null)

  /**
   * Reads come from the SCOPED chain, so the address and the chain cannot disagree.
   *
   * `readProvider` stays in the condition as the AVAILABILITY GATE it always was: `readProviderFor`
   * is cohort-bounded (spec 071), and a null from it means this build may not read that chain at
   * all — a different answer from a read that was attempted and failed. The chain itself is now an
   * argument rather than something baked into a provider, which is what makes the history scan
   * below able to be on the right one.
   */
  const readRouter = useMemo(() => {
    if (!routerAddr || !readProvider) return null
    return (functionName, args = []) =>
      readContract(scopeChainId, { address: routerAddr, abi: FEE_ROUTER_ABI, functionName, args })
  }, [routerAddr, readProvider, scopeChainId])

  const fetchServices = useCallback(async () => {
    if (!readRouter) return
    try {
      setReadError(null)
      const [count, treasuryAddr, maxCap] = await Promise.all([
        readRouter('serviceCount'),
        readRouter('treasury'),
        readRouter('MAX_WRAPPED_FEE_BPS'),
      ])
      const ids = await Promise.all(
        Array.from({ length: Number(count) }, (_, i) => readRouter('serviceAt', [BigInt(i)]))
      )
      const entries = await Promise.all(
        ids.map(async (id) => {
          const svc = await readRouter('getService', [id])
          return {
            serviceId: id,
            label: KNOWN_SERVICES[id]?.label || `Service ${id.substring(0, 10)}…`,
            surface: KNOWN_SERVICES[id]?.surface || '—',
            feeBps: Number(svc.feeBps),
            capBps: Number(svc.capBps),
            kind: Number(svc.kind),
          }
        })
      )
      setServices(entries)
      setTreasury(treasuryAddr)
      setMaxWrappedCap(Number(maxCap))
    } catch (e) {
      setReadError(`Could not read the FeeRouter: ${e?.message || e}`)
    }
  }, [readRouter])

  /**
   * Rate-change history for the SCOPED chain's FeeRouter.
   *
   * ── THIS SCAN WAS READING TWO CHAINS AT ONCE (found converting it, spec 110 T028) ──
   * It took `latest` from `provider.getBlockNumber()` and each entry's timestamp from
   * `provider.getBlock(...)` — the WALLET's provider — while the logs themselves came from the
   * scoped chain's router. The whole point of this tab is that a fee schedule is per-chain and you
   * read one chain while your wallet sits on another (the banner above says exactly that), so the
   * mismatch was not an edge case: reading Polygon's fees from a wallet on Ethereum computed the
   * 200k-block window from ETHEREUM's height and then dated every Polygon change by whatever
   * Ethereum block happened to share its number. Chains do not advance together, so the window
   * could miss every change or ask for blocks that do not exist yet, and the dates shown were
   * simply another chain's — rendered as fact, with nothing failing. Every read here is now on
   * `scopeChainId`.
   *
   * The scan also bisects on refusal (`getLogsRange`) instead of asking for 200,000 blocks in one
   * request. Public RPCs cap log ranges at ~10k, so the old single `queryFilter` threw on them and
   * the catch below rendered "no history" — which is what an operator reading a busy chain would
   * have seen every time.
   */
  const fetchHistory = useCallback(async () => {
    if (!routerAddr || !readProvider) return
    try {
      const handle = eventScanHandle(scopeChainId, { address: routerAddr, abi: FEE_ROUTER_ABI })
      const client = getPublicClient(scopeChainId)
      if (!handle || !client) return
      const latest = await handle.provider.getBlockNumber()
      const fromBlock = Math.max(0, Number(latest) - HISTORY_LOOKBACK_BLOCKS)
      const logs = await getLogsRange(
        handle.provider,
        routerAddr,
        fromBlock,
        Number(latest),
        2000,
        handle.filters.FeeBpsChanged().getTopicFilter(),
      )
      const recent = logs.slice(-HISTORY_LIMIT).reverse()
      const entries = await Promise.all(
        recent.map(async (log) => {
          const { args } = handle.interface.parseLog(log)
          const block = await client
            .getBlock({ blockNumber: BigInt(log.blockNumber) })
            .catch(() => null)
          return {
            serviceId: args.serviceId,
            label: KNOWN_SERVICES[args.serviceId]?.label || `${args.serviceId.substring(0, 10)}…`,
            oldBps: Number(args.oldBps),
            newBps: Number(args.newBps),
            actor: args.actor,
            at: block ? new Date(Number(block.timestamp) * 1000) : null,
            txHash: log.transactionHash,
          }
        })
      )
      setHistory({ entries, truncated: fromBlock > 0, error: null })
    } catch (e) {
      // Some RPCs bound log ranges below what bisecting can reach — the full history stays
      // available on the explorer.
      setHistory({ entries: [], truncated: true, error: e?.message || String(e) })
    }
  }, [routerAddr, readProvider, scopeChainId])

  useEffect(() => {
    fetchServices()
    fetchHistory()
  }, [fetchServices, fetchHistory])

  // Gateway-enforced fee systems (read-only telemetry): Polymarket bps source + OpenSea referral.
  useEffect(() => {
    const base = gatewayBaseUrl()
    if (!base) return
    let cancelled = false
    fetch(`${base}/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setGatewayFees(data?.fees ?? null)
      })
      .catch(() => {
        if (!cancelled) setGatewayFees(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = () => {
    fetchServices()
    fetchHistory()
  }

  const selectedService = services?.find((s) => s.serviceId === feeForm.serviceId) || null

  const handleSetFeeBps = () => {
    setFormError(null)
    if (!selectedService) {
      setFormError('Pick a service first.')
      return
    }
    const bps = Number.parseInt(feeForm.bps, 10)
    if (!Number.isInteger(bps) || bps < 0) {
      setFormError('Enter the new rate in basis points (whole number, 0 or more).')
      return
    }
    if (bps > selectedService.capBps) {
      setFormError(
        `${bps} bps is above this service's hard cap of ${selectedService.capBps} bps — the contract will refuse it.`
      )
      return
    }
    runTx(
      () =>
        signer.sendTransaction({
          to: routerAddr,
          data: encodeFunctionData({
            abi: normalizeAbi(FEE_ROUTER_ABI),
            functionName: 'setFeeBps',
            args: [feeForm.serviceId, bps],
          }),
        }),
      `${selectedService.label} fee set to ${bps} bps (${bpsPct(bps)})`
    ).then(refresh)
  }

  const handleSetTreasury = () => {
    setFormError(null)
    const value = treasuryForm.trim()
    if (!isAddress(value) || value === zeroAddress) {
      setFormError('Enter a valid, nonzero treasury address — fees would otherwise be skipped or lost.')
      return
    }
    /**
     * Normalised before encoding, and that is load-bearing (spec 110 divergence 16).
     *
     * `isAddress` here reproduces ethers' rule, which ACCEPTS an all-uppercase address: the casing
     * carries no checksum, so there is nothing to verify and it is a perfectly valid address.
     * viem's `encodeFunctionData` disagrees — it REFUSES one outright. So a member pasting
     * `0X…`-cased hex from a tool that emits upper case would pass validation and then have the
     * encode throw underneath, on the control that decides where every platform fee lands.
     * `getAddress` first produces calldata byte-identical to what ethers built (measured).
     */
    const treasuryAddress = getAddress(value)
    runTx(
      () =>
        signer.sendTransaction({
          to: routerAddr,
          data: encodeFunctionData({
            abi: normalizeAbi(FEE_ROUTER_ABI),
            functionName: 'setTreasury',
            args: [treasuryAddress],
          }),
        }),
      `Fee treasury set to ${shortAddr(value)}`
    ).then(refresh)
  }

  if (!routerAddr) {
    return (
      <div className="admin-tab-content" role="tabpanel">
      <NetworkScopeCard
        title="Platform Fees"
        description="Fee services and rates for one network's FeeRouter. Each chain carries its own services and its own bps — there is no single platform-wide rate."
        networks={feeNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('feeRouter', id))}
        walletChainId={chainId}
        onRefresh={refresh}
        lastReadAt={null}
        notDeployedLabel="no FeeRouter"
      />
        <div className="admin-card">
          <h3>Platform Fees</h3>
          <p className="card-info">
            No FeeRouter is deployed on {networkName(scopeChainId)}, so no platform fees are active
            there — member flows behave exactly as if the fee system did not exist. Pick another
            network above, or deploy it with{' '}
            <code>scripts/deploy/deploy-fee-router.js</code> (see the fee operations runbook).
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-tab-content" role="tabpanel">
      <NetworkScopeCard
        title="Platform Fees"
        description="Fee services and rates for one network's FeeRouter. Each chain carries its own services and its own bps — there is no single platform-wide rate."
        networks={feeNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('feeRouter', id))}
        walletChainId={chainId}
        onRefresh={refresh}
        lastReadAt={null}
        notDeployedLabel="no FeeRouter"
      />
      {!onScopeNetwork && (
        <p className="card-info warning-text" role="status">
          You are reading {networkName(scopeChainId)} while your wallet is on {networkName(chainId)}.
          Rate changes are signed on {networkName(scopeChainId)} — switch your wallet to make one.
        </p>
      )}
      <div className="admin-card">
        <div className="admin-card-header">
          <h3>Platform Fees on {networkName(scopeChainId)}</h3>
          <button type="button" className="refresh-btn" onClick={refresh} aria-label="Refresh fees">↻</button>
        </div>
        {readError && <p className="card-info error">{readError}</p>}
        <div className="status-details">
          <div className="status-row">
            <span className="status-label">FeeRouter</span>
            <span className="status-value"><code title={routerAddr}>{shortAddr(routerAddr)}</code></span>
          </div>
          <div className="status-row">
            <span className="status-label">Fee treasury (this network)</span>
            <span className="status-value">
              {treasury === undefined ? '…'
                : treasury && treasury !== zeroAddress
                  ? <code title={treasury}>{shortAddr(treasury)}</code>
                  : <span className="status-value paused">unset — fees are skipped, not charged</span>}
            </span>
          </div>
          {maxWrappedCap != null && (
            <div className="status-row">
              <span className="status-label">Wrapper-fee hard cap</span>
              <span className="status-value">{maxWrappedCap} bps ({bpsPct(maxWrappedCap)})</span>
            </div>
          )}
        </div>

        {services == null && !readError ? (
          <p className="card-info">Loading fee services…</p>
        ) : services?.length === 0 ? (
          <p className="card-info">No fee services are registered on this network yet.</p>
        ) : services?.length > 0 ? (
          /* Scrolled, not clipped. The Enforcement column is what says whether a service COSTS a
             member money (charged on-chain) or is only read off-chain, and at phone width it was
             cut off mid-word with no way to reach it — an operator could read a rate without being
             able to read what enforces it. `.admin-table-scroll` is the wrapper the other admin
             tables already use. */
          <div className="admin-table-scroll">
          <table className="admin-table" aria-label="Registered fee services">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Live rate</th>
                <th scope="col">Hard cap</th>
                <th scope="col">Enforcement</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.serviceId}>
                  <td>{s.label}<div className="hint">{s.surface}</div></td>
                  <td>{s.feeBps} bps ({bpsPct(s.feeBps)})</td>
                  <td>{s.capBps} bps</td>
                  <td>{KIND_NAMES[s.kind] || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : null}
        <p className="card-info">
          Rates are read live by member surfaces — the confirm step always shows the rate in force,
          and a member is never charged more than the rate they were shown. A rate of 0 shows no
          fee line at all.
        </p>
      </div>

      <div className="admin-card">
        <h3>Other fee programs</h3>
        <div className="status-details">
          <div className="status-row">
            <span className="status-label">Polymarket builder fee — gateway source</span>
            <span className="status-value">
              {gatewayFees?.polymarket
                ? `${gatewayFees.polymarket.takerBps} bps taker / ${gatewayFees.polymarket.makerBps} bps maker · ${
                    gatewayFees.polymarket.source === 'chain'
                      ? 'live from the FeeRouter'
                      : 'env fallback (router not read)'
                  }`
                : 'gateway unreachable — showing nothing rather than a stale rate'}
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">OpenSea referral (Collect)</span>
            <span className="status-value">
              {gatewayFees?.opensea
                ? gatewayFees.opensea.referralConfigured
                  ? `configured${gatewayFees.opensea.beneficiary ? ` · ${shortAddr(gatewayFees.opensea.beneficiary)}` : ''} · no member cost`
                  : 'not configured · no member cost either way'
                : 'gateway unreachable'}
            </span>
          </div>
        </div>
        <p className="card-info">
          The Polymarket taker/maker rates are edited below like any other service (they live on the
          FeeRouter; the gateway re-reads them within ~30 s). The OpenSea referral has no rate to
          edit — it never costs the member anything, and its beneficiary is deployment-managed.
        </p>
      </div>

      {canEditFees && (
        <div className="admin-card">
          <h3>Change a fee rate</h3>
          <p>
            Takes effect for all subsequent member actions (in-flight actions are protected by the
            rate they were quoted). The contract refuses rates above a service's hard cap.
          </p>
          <div className="admin-form">
            <label>
              Service
              <select
                value={feeForm.serviceId}
                onChange={(e) => setFeeForm((f) => ({ ...f, serviceId: e.target.value }))}
              >
                <option value="">Choose a service…</option>
                {(services || []).map((s) => (
                  <option key={s.serviceId} value={s.serviceId}>
                    {s.label} (now {s.feeBps} bps, cap {s.capBps})
                  </option>
                ))}
              </select>
            </label>
            <label>
              New rate (bps)
              <input
                type="number"
                min="0"
                max={selectedService?.capBps ?? undefined}
                value={feeForm.bps}
                onChange={(e) => setFeeForm((f) => ({ ...f, bps: e.target.value }))}
                placeholder={selectedService ? `0 – ${selectedService.capBps}` : 'bps'}
              />
            </label>
            {selectedService && (
              <span className="hint">
                {feeForm.bps !== '' && Number.isInteger(Number(feeForm.bps))
                  ? `${feeForm.bps} bps = ${bpsPct(Number(feeForm.bps))} of each amount`
                  : `Cap: ${selectedService.capBps} bps (${bpsPct(selectedService.capBps)})`}
              </span>
            )}
            {formError && <p className="card-info error" role="alert">{formError}</p>}
            <button
              type="button"
              className="confirm-btn primary"
              onClick={handleSetFeeBps}
              disabled={!onScopeNetwork || pendingTx || !signer}
            >
              Set fee rate
            </button>
            {feeGate.unconfirmed && (
              <p className="card-info warning-text" role="status">
                Authority could not be confirmed on {networkName(scopeChainId)} — the control stays
                available because the router itself is the real gate, and it will refuse anything
                you do not hold.
              </p>
            )}
          </div>
        </div>
      )}

      {canEditTreasury && (
        <div className="admin-card">
          <h3>Change the fee treasury</h3>
          <p>
            Where wrapper fees on this network are sent. Must be a FairWins-controlled address; the
            contract refuses the zero address.
          </p>
          <div className="admin-form">
            <label>
              Treasury address
              <input
                type="text"
                value={treasuryForm}
                onChange={(e) => setTreasuryForm(e.target.value)}
                placeholder="0x…"
              />
            </label>
            <button
              type="button"
              className="confirm-btn danger"
              onClick={handleSetTreasury}
              disabled={!onScopeNetwork || pendingTx || !signer}
            >
              Set treasury
            </button>
            {treasuryGate.unconfirmed && (
              <p className="card-info warning-text" role="status">
                Authority could not be confirmed on {networkName(scopeChainId)} — the router will
                still refuse this unless you hold the admin role there.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="admin-card">
        <h3>Change history</h3>
        {history.entries == null ? (
          <p className="card-info">Loading history…</p>
        ) : history.entries.length === 0 ? (
          <p className="card-info">
            {history.error
              ? 'This RPC bounds event lookups — view the full history on the block explorer.'
              : 'No fee changes recorded in the recent lookback window.'}
          </p>
        ) : (
          <div className="admin-table-scroll">
          <table className="admin-table" aria-label="Fee change history">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Service</th>
                <th scope="col">Change</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {history.entries.map((h) => (
                <tr key={h.txHash + h.serviceId}>
                  <td>{h.at ? h.at.toLocaleString() : '—'}</td>
                  <td>{h.label}</td>
                  <td>{h.oldBps} → {h.newBps} bps</td>
                  <td><code title={h.actor}>{shortAddr(h.actor)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <p className="card-info">
          Every change is an on-chain event (who, when, old → new).{' '}
          {getBlockscoutUrl(scopeChainId, routerAddr, 'address') && (
            <a href={getBlockscoutUrl(scopeChainId, routerAddr, 'address')} target="_blank" rel="noopener noreferrer">
              Full history on the block explorer ↗
            </a>
          )}
        </p>
      </div>
    </div>
  )
}
