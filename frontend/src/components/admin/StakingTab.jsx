/**
 * StakingTab (spec 066) — operator control surface for the staking service.
 *
 * One screen to manage the on-chain StakingRouter for a network:
 *   - Provider addresses (Lido, sPOL, Polygon delegation, the FeeRouter reference)
 *     — STAKING_ADMIN_ROLE, validated before the wallet prompt.
 *   - The curated validator allowlist for delegated staking — STAKING_ADMIN_ROLE.
 *   - Emergency pause / resume of new staking on this network — GUARDIAN_ROLE.
 *   - The per-provider LIQUID staking fee rates — READ-ONLY here (edited in the Fees
 *     tab by FEE_ADMIN, the single fee source of truth; spec 060).
 *   - On-chain change history (setter + pause events) — the audit trail.
 *
 * When no StakingRouter is deployed on the network the tab shows an honest
 * "not deployed" state and the member app keeps the spec-065 fee-free direct staking.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { encodeFunctionData, zeroAddress } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { eventScanHandle } from '../../lib/chains/eventScan'
import { getLogsRange } from '../../lib/chains/logRange'
import { getPublicClient } from '../../lib/chains/publicClient'
import { getAddress, isAddress } from '../../lib/evm/address'
import { getContractAddressForChain } from '../../config/contracts'
import { estateNetworks, networkName, readProviderFor, readAuthority, authorityGate } from '../../lib/chains/estate'
import { NetworkScopeCard } from './scopeControls'
import { useScopedChain } from './scopeGate'
import { STAKING_ROUTER_ABI } from '../../abis/StakingRouter'
import { FEE_SERVICES, fetchFeeQuote, bpsToPercent } from '../../lib/fees/feeQuote'
import { getBlockscoutUrl } from '../../config/blockExplorer'

const HISTORY_LOOKBACK_BLOCKS = 200_000
const HISTORY_LIMIT = 25
const SETTER_EVENTS = [
  'FeeRouterUpdated',
  'LidoContractsUpdated',
  'SpolContractsUpdated',
  'PolygonContractsUpdated',
  'ValidatorAdded',
  'ValidatorRemoved',
  'Paused',
  'Unpaused',
]

function shortAddr(a) {
  return a && a !== zeroAddress ? `${a.substring(0, 6)}...${a.substring(a.length - 4)}` : ''
}

/**
 * `isAddress` from the address SEAM, not viem's own (spec 110 divergence d): viem's defaults to
 * `strict: true` and refuses an ALL-UPPERCASE address, which carries no checksum and is valid.
 * Its other half is `getAddress` at the encoders below — divergence 16.
 */
const isValidAddr = (a) => isAddress(a) && a !== zeroAddress

export default function StakingTab({ signer, account, chainId, provider, runTx, pendingTx, isAdmin, isStakingAdmin, isGuardian }) {
  // Spec 071 US4: provider addresses and the validator allowlist are per network — a router on
  // one chain knows nothing about another's. Scoped so an operator sees the network they mean.
  const stakingNetworks = useMemo(() => estateNetworks(), [])
  const { scopeChainId, setScopeChainId } = useScopedChain(stakingNetworks, chainId)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)
  const routerAddr = getContractAddressForChain('stakingRouter', scopeChainId)
  const readProvider = useMemo(
    () => readProviderFor(scopeChainId, chainId, provider),
    [scopeChainId, chainId, provider],
  )
  // Authority comes from the router that will ENFORCE it, on the scoped chain. The app-wide
  // flags answer "holds this role somewhere in the estate", which would offer an enabled pause
  // on a network whose router reverts — and a pause an operator believes they hold is worse than
  // one they know they do not. An UNCONFIRMED read keeps the control offered and says so
  // (FR-044): hiding a killswitch because an RPC timed out is its own kind of lie.
  const [authority, setAuthority] = useState(null)
  useEffect(() => {
    let cancelled = false
    readAuthority({
      chainId: scopeChainId,
      provider: readProvider,
      address: routerAddr,
      account,
      roles: ['admin', 'stakingAdmin', 'guardian'],
    }).then((a) => {
      if (!cancelled) setAuthority(a)
    })
    return () => { cancelled = true }
  }, [readProvider, routerAddr, account, scopeChainId])

  const configGate = authorityGate(authority, ['admin', 'stakingAdmin'])
  const pauseGate = authorityGate(authority, ['admin', 'guardian'])
  // While the first read is in flight the app-wide flag stands in, so an operator who does hold
  // the role is not shown an empty tab for a round-trip.
  const canConfig = configGate.pending ? Boolean(isAdmin || isStakingAdmin) : configGate.allowed
  const canPause = pauseGate.pending ? Boolean(isAdmin || isGuardian) : pauseGate.allowed

  const [state, setState] = useState(null) // null = loading
  const [readError, setReadError] = useState(null)
  const [fees, setFees] = useState({ lido: null, polygon: null })
  const [history, setHistory] = useState({ entries: null, error: null })
  const [forms, setForms] = useState({ lido: '', wsteth: '', spolC: '', spolT: '', polToken: '', stakeMgr: '', feeRouter: '', addVal: '', rmVal: '' })
  const [formError, setFormError] = useState(null)

  const routerRead = useMemo(
    () =>
      routerAddr && readProvider
        ? (functionName, args = []) =>
            readContract(scopeChainId, { address: routerAddr, abi: STAKING_ROUTER_ABI, functionName, args })
        : null,
    [routerAddr, readProvider, scopeChainId]
  )
  const write = useCallback(
    (functionName, args = []) =>
      signer.sendTransaction({
        to: routerAddr,
        data: encodeFunctionData({ abi: normalizeAbi(STAKING_ROUTER_ABI), functionName, args }),
      }),
    [routerAddr, signer]
  )

  const fetchState = useCallback(async () => {
    if (!routerRead) return
    try {
      setReadError(null)
      const safe = (p) => p.then((v) => v).catch(() => undefined)
      const [feeRouter, lidoSteth, lidoWsteth, spolController, spolToken, polToken, polygonStakeManager, paused, count] =
        await Promise.all([
          safe(routerRead('feeRouter')),
          safe(routerRead('lidoSteth')),
          safe(routerRead('lidoWsteth')),
          safe(routerRead('spolController')),
          safe(routerRead('spolToken')),
          safe(routerRead('polToken')),
          safe(routerRead('polygonStakeManager')),
          safe(routerRead('paused')),
          safe(routerRead('validatorCount')),
        ])
      const validators = []
      if (count !== undefined) {
        const entries = await Promise.all(
          Array.from({ length: Number(count) }, (_, i) => safe(routerRead('validatorAt', [BigInt(i)])))
        )
        for (const v of entries) if (v) validators.push(v)
      }
      setState({ feeRouter, lidoSteth, lidoWsteth, spolController, spolToken, polToken, polygonStakeManager, paused: Boolean(paused), validators })
    } catch (e) {
      setReadError(`Could not read the StakingRouter: ${e?.message || e}`)
    }
  }, [routerRead])

  const fetchFees = useCallback(async () => {
    // Guard on the SCOPED provider, which is what the body actually uses — guarding on the
    // wallet's provider here would skip the fetch when the two differ.
    if (!readProvider || !routerAddr) return
    const load = (serviceId) =>
      fetchFeeQuote({ serviceId, chainId: scopeChainId, provider: readProvider }).catch(() => ({ available: false, bps: 0 }))
    const [lido, polygon] = await Promise.all([load(FEE_SERVICES.STAKE_LIDO), load(FEE_SERVICES.STAKE_POLYGON)])
    setFees({ lido, polygon })
  }, [readProvider, routerAddr, scopeChainId])

  const fetchHistory = useCallback(async () => {
    if (!routerAddr || !readProvider) return
    try {
      const handle = eventScanHandle(scopeChainId, { address: routerAddr, abi: STAKING_ROUTER_ABI })
      const client = getPublicClient(scopeChainId)
      if (!handle || !client) return
      const latest = Number(await handle.provider.getBlockNumber())
      const fromBlock = Math.max(0, latest - HISTORY_LOOKBACK_BLOCKS)
      const all = []
      for (const name of SETTER_EVENTS) {
        // Bisects on refusal rather than asking for the whole window in one `eth_getLogs`: a
        // range-capping RPC used to land in the catch below, which renders "this RPC bounds event
        // lookups" — honest, but it meant no history ever showed on such a chain.
        const logs = await getLogsRange(
          handle.provider,
          routerAddr,
          fromBlock,
          latest,
          2000,
          handle.filters[name]().getTopicFilter(),
        ).catch(() => [])
        for (const log of logs) all.push({ name, ev: { ...log, args: handle.interface.parseLog(log).args } })
      }
      all.sort((a, b) => b.ev.blockNumber - a.ev.blockNumber || b.ev.index - a.ev.index)
      const recent = all.slice(0, HISTORY_LIMIT)
      const entries = await Promise.all(
        recent.map(async ({ name, ev }) => {
          const block = await client
            .getBlock({ blockNumber: BigInt(ev.blockNumber) })
            .catch(() => null)
          const actor = ev.args?.actor || ev.args?.account
          return {
            name,
            actor,
            at: block ? new Date(Number(block.timestamp) * 1000) : null,
            txHash: ev.transactionHash,
            key: `${ev.transactionHash}-${ev.index}`,
          }
        })
      )
      setHistory({ entries, error: null })
    } catch (e) {
      setHistory({ entries: [], error: e?.message || String(e) })
    }
  }, [routerAddr, readProvider, scopeChainId])

  useEffect(() => {
    fetchState()
    fetchFees()
    fetchHistory()
  }, [fetchState, fetchFees, fetchHistory])

  const refresh = () => {
    fetchState()
    fetchFees()
    fetchHistory()
  }

  const setPair = (fn, a, b, label) => {
    setFormError(null)
    if (!isValidAddr(a) || (b !== undefined && !isValidAddr(b))) {
      setFormError('Enter valid, non-zero address(es) — the contract rejects malformed or zero input.')
      return
    }
    const args = b !== undefined ? [a, b] : [a]
    runTx(() => write()[fn](...args), `${label} updated`).then(refresh)
  }

  const addValidator = () => {
    setFormError(null)
    if (!isValidAddr(forms.addVal)) {
      setFormError('Enter a valid, non-zero validator share address.')
      return
    }
    runTx(() => write('addValidator', [getAddress(forms.addVal.trim())]), `Validator ${shortAddr(forms.addVal)} added`).then(refresh)
  }
  const removeValidator = (addr) => {
    runTx(() => write('removeValidator', [getAddress(addr)]), `Validator ${shortAddr(addr)} removed`).then(refresh)
  }
  const togglePause = () => {
    const fn = state?.paused ? 'unpause' : 'pause'
    runTx(() => write()[fn](), state?.paused ? 'Staking resumed' : 'Staking paused').then(refresh)
  }

  if (!routerAddr) {
    return (
      <div className="admin-tab-content" role="tabpanel">
      <NetworkScopeCard
        title="Staking Controls"
        description="Provider addresses and the validator allowlist for one network's StakingRouter."
        networks={stakingNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('stakingRouter', id))}
        walletChainId={chainId}
        onRefresh={refresh}
        lastReadAt={null}
        notDeployedLabel="no StakingRouter"
      />
        <div className="admin-card">
          <h3>Staking Controls</h3>
          <p className="card-info">
            No StakingRouter is deployed on {networkName(scopeChainId)}, so staking controls are not available there —
            member staking behaves exactly as spec 065 (fee-free, direct staking, availability as
            configured). Deploy it with <code>scripts/deploy/deploy-staking-router.js</code> (see the
            staking operations runbook).
          </p>
        </div>
      </div>
    )
  }

  const feeLine = (f) =>
    f == null ? '…' : f.available ? `${f.bps} bps (${bpsToPercent(f.bps)}), cap ${f.capBps} bps` : 'no fee (rate 0 / unset)'

  return (
    <div className="admin-tab-content" role="tabpanel">
      <NetworkScopeCard
        title="Staking Controls"
        description="Provider addresses and the validator allowlist for one network's StakingRouter."
        networks={stakingNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('stakingRouter', id))}
        walletChainId={chainId}
        onRefresh={refresh}
        lastReadAt={null}
        notDeployedLabel="no StakingRouter"
      />
      {!onScopeNetwork && (
        <p className="card-info warning-text" role="status">
          Reading {networkName(scopeChainId)}; your wallet is on {networkName(chainId)}. Changes are
          signed on {networkName(scopeChainId)} — switch your wallet to make one.
        </p>
      )}
      <div className="admin-card">
        <div className="admin-card-header">
          <h3>Staking Controls on {networkName(scopeChainId)}</h3>
          <button type="button" className="refresh-btn" onClick={refresh} aria-label="Refresh staking controls">↻</button>
        </div>
        {readError && <p className="card-info error">{readError}</p>}
        <div className="status-details">
          <div className="status-row">
            <span className="status-label">StakingRouter</span>
            <span className="status-value"><code title={routerAddr}>{shortAddr(routerAddr)}</code></span>
          </div>
          <div className="status-row">
            <span className="status-label">New staking</span>
            <span className="status-value">
              {state == null ? '…' : state.paused
                ? <span className="status-value paused">PAUSED — new stakes stopped (exits still work)</span>
                : 'active'}
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">Lido fee (stake.lido)</span>
            <span className="status-value">{feeLine(fees.lido)}</span>
          </div>
          <div className="status-row">
            <span className="status-label">sPOL fee (stake.polygon)</span>
            <span className="status-value">{feeLine(fees.polygon)}</span>
          </div>
        </div>
        <p className="card-info">
          Fee rates are read-only here — they live on the FeeRouter and are edited in the{' '}
          <strong>Fees</strong> tab by a Fee Administrator (the single fee source of truth). Delegated
          staking is fee-free.
        </p>
      </div>

      {canPause && (
        <div className="admin-card">
          <h3>Emergency pause</h3>
          {pauseGate.unconfirmed && (
            <p className="card-info warning-text" role="status">
              Authority could not be confirmed on {networkName(scopeChainId)} — the control stays
              available because the router itself is the real gate, and it will refuse anything you
              do not hold.
            </p>
          )}
          <p>
            Pausing stops <strong>new</strong> stakes on this network immediately (no redeploy). Members
            can always still unstake, withdraw, and claim — exits never route through the router.
          </p>
          <button
            type="button"
            className={`confirm-btn ${state?.paused ? 'primary' : 'danger'}`}
            onClick={togglePause}
            disabled={!onScopeNetwork || pendingTx || !signer || state == null}
          >
            {state?.paused ? 'Resume staking' : 'Pause staking'}
          </button>
        </div>
      )}

      {canConfig && (
        <div className="admin-card">
          <h3>Provider addresses</h3>
          {configGate.unconfirmed && (
            <p className="card-info warning-text" role="status">
              Authority could not be confirmed on {networkName(scopeChainId)} — the control stays
              available because the router itself is the real gate, and it will refuse anything you
              do not hold.
            </p>
          )}
          <p>Current values shown below each field. Invalid or zero addresses are rejected before the wallet prompt.</p>
          <div className="admin-form">
            <label>
              Lido stETH / wstETH
              <input type="text" placeholder="stETH 0x…" value={forms.lido}
                onChange={(e) => setForms((f) => ({ ...f, lido: e.target.value }))} />
              <input type="text" placeholder="wstETH 0x…" value={forms.wsteth}
                onChange={(e) => setForms((f) => ({ ...f, wsteth: e.target.value }))} />
              <span className="hint">now: {shortAddr(state?.lidoSteth) || '—'} / {shortAddr(state?.lidoWsteth) || '—'}</span>
            </label>
            <button type="button" className="confirm-btn primary" disabled={!onScopeNetwork || pendingTx || !signer}
              onClick={() => setPair('setLidoContracts', forms.lido, forms.wsteth, 'Lido contracts')}>Set Lido</button>

            <label>
              sPOL controller / token
              <input type="text" placeholder="controller 0x…" value={forms.spolC}
                onChange={(e) => setForms((f) => ({ ...f, spolC: e.target.value }))} />
              <input type="text" placeholder="sPOL 0x…" value={forms.spolT}
                onChange={(e) => setForms((f) => ({ ...f, spolT: e.target.value }))} />
              <span className="hint">now: {shortAddr(state?.spolController) || '—'} / {shortAddr(state?.spolToken) || '—'}</span>
            </label>
            <button type="button" className="confirm-btn primary" disabled={!onScopeNetwork || pendingTx || !signer}
              onClick={() => setPair('setSpolContracts', forms.spolC, forms.spolT, 'sPOL contracts')}>Set sPOL</button>

            <label>
              POL token / Stake Manager (delegation)
              <input type="text" placeholder="POL 0x…" value={forms.polToken}
                onChange={(e) => setForms((f) => ({ ...f, polToken: e.target.value }))} />
              <input type="text" placeholder="StakeManager 0x…" value={forms.stakeMgr}
                onChange={(e) => setForms((f) => ({ ...f, stakeMgr: e.target.value }))} />
              <span className="hint">now: {shortAddr(state?.polToken) || '—'} / {shortAddr(state?.polygonStakeManager) || '—'}</span>
            </label>
            <button type="button" className="confirm-btn primary" disabled={!onScopeNetwork || pendingTx || !signer}
              onClick={() => setPair('setPolygonContracts', forms.polToken, forms.stakeMgr, 'Polygon contracts')}>Set Polygon</button>

            <label>
              FeeRouter reference
              <input type="text" placeholder="FeeRouter 0x…" value={forms.feeRouter}
                onChange={(e) => setForms((f) => ({ ...f, feeRouter: e.target.value }))} />
              <span className="hint">now: {shortAddr(state?.feeRouter) || '—'}</span>
            </label>
            <button type="button" className="confirm-btn primary" disabled={!onScopeNetwork || pendingTx || !signer}
              onClick={() => setPair('setFeeRouter', forms.feeRouter, undefined, 'FeeRouter reference')}>Set FeeRouter</button>
            {formError && <p className="card-info error" role="alert">{formError}</p>}
          </div>
        </div>
      )}

      {canConfig && (
        <div className="admin-card">
          <h3>Validator allowlist</h3>
          <p>Curated delegation targets. Removing one stops it being offered for new delegations; existing positions can still exit.</p>
          {state?.validators?.length ? (
            <table className="admin-table" aria-label="Curated validators">
              <thead><tr><th scope="col">Validator share</th><th scope="col"></th></tr></thead>
              <tbody>
                {state.validators.map((v) => (
                  <tr key={v}>
                    <td><code title={v}>{shortAddr(v)}</code></td>
                    <td>
                      <button type="button" className="confirm-btn danger" disabled={!onScopeNetwork || pendingTx || !signer}
                        onClick={() => removeValidator(v)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="card-info">{state == null ? 'Loading…' : 'No validators in the on-chain allowlist yet.'}</p>
          )}
          <div className="admin-form">
            <label>
              Add validator share
              <input type="text" placeholder="0x…" value={forms.addVal}
                onChange={(e) => setForms((f) => ({ ...f, addVal: e.target.value }))} />
            </label>
            <button type="button" className="confirm-btn primary" disabled={!onScopeNetwork || pendingTx || !signer} onClick={addValidator}>
              Add validator
            </button>
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
              : 'No staking control actions recorded in the recent lookback window.'}
          </p>
        ) : (
          <table className="admin-table" aria-label="Staking control history">
            <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">By</th></tr></thead>
            <tbody>
              {history.entries.map((h) => (
                <tr key={h.key}>
                  <td>{h.at ? h.at.toLocaleString() : '—'}</td>
                  <td>{h.name}</td>
                  <td>{h.actor ? <code title={h.actor}>{shortAddr(h.actor)}</code> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="card-info">
          Every control action is an on-chain event (what, who, when). Fee-rate changes are in the Fees
          tab's history.{' '}
          {getBlockscoutUrl(chainId, routerAddr, 'address') && (
            <a href={getBlockscoutUrl(chainId, routerAddr, 'address')} target="_blank" rel="noopener noreferrer">
              Full history on the block explorer ↗
            </a>
          )}
        </p>
      </div>
    </div>
  )
}
