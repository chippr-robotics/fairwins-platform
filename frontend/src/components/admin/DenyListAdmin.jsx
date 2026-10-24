import { useState, useEffect, useCallback, useMemo } from 'react'
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { eventScanHandle } from '../../lib/chains/eventScan'
import { getAddress, isAddress as isAddressSeam } from '../../lib/evm/address'
import { getContractAddressForChain } from '../../config/contracts'
import { estateNetworks, networkName, readProviderFor } from '../../lib/chains/estate'
import { NetworkScopeCard } from './scopeControls'
import { useScopedChain } from './scopeGate'

/**
 * DenyListAdmin (Spec 007 — FR-020, SC-018)
 *
 * Admin UI for the SanctionsGuard discretionary deny-list: add/remove addresses with a
 * reason (calls setDenied, gated on-chain by SANCTIONS_ADMIN_ROLE), and render the
 * add/remove audit trail from the DenyListUpdated event (actor + reason + block).
 *
 * Tab contract matches the other admin tabs: { signer, account, contracts, chainId, runTx, pendingTx }.
 * The guard address comes from the synced contracts config (FR-055) — never hardcoded.
 *
 * Spec 071 US4 — a deny-list entry is per guard, and there is a guard per network. Reading only
 * the wallet's network made "not denied" ambiguous between *checked and clear* and *checked
 * somewhere else*, which on a sanctions surface is the difference between a compliance answer and
 * a guess. The network is now picked, reads follow the pick, and a write names the chain the entry
 * lands on — a denial on one network is not a denial on another, and the audit trail below is that
 * network's alone.
 */

// Minimal human-readable ABI (keeps the bundle small; full ABI lives in abis/SanctionsGuard.js)
const GUARD_ABI = [
  'function setDenied(address account, bool denied, string reason)',
  'function isDenied(address account) view returns (bool)',
  'function isAllowed(address account) view returns (bool)',
  'event DenyListUpdated(address indexed account, bool denied, address indexed actor, string reason)',
]

function isAddr(s) {
  try { return isAddressSeam((s || '').trim()) } catch { return false }
}
function shortAddr(a) {
  return a && isAddressSeam(a) ? a.slice(0, 6) + '…' + a.slice(-4) : (a || '—')
}

function DenyListAdmin({ signer, contracts, chainId, runTx, pendingTx }) {
  const guardNetworks = useMemo(() => estateNetworks(), [])
  const { scopeChainId, setScopeChainId } = useScopedChain(guardNetworks, chainId)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)
  const guardAddress = useMemo(
    () =>
      getContractAddressForChain('sanctionsGuard', scopeChainId) ||
      (Number(scopeChainId) === Number(chainId) ? contracts?.sanctionsGuard : '') ||
      '',
    [scopeChainId, chainId, contracts],
  )
  // Reads come from the scoped chain; only writes use the wallet's signer.
  const readProvider = useMemo(
    () => readProviderFor(scopeChainId, chainId, signer?.provider || null),
    [scopeChainId, chainId, signer],
  )
  const [address, setAddress] = useState('')
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState(null) // { denied, allowed } | null
  const [history, setHistory] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')

  const writer = useCallback(() => {
    if (!isAddr(guardAddress) || !signer) return null
    return (functionName, args) =>
      signer.sendTransaction({
        to: guardAddress,
        data: encodeFunctionData({ abi: normalizeAbi(GUARD_ABI), functionName, args }),
      })
  }, [guardAddress, signer])

  const loadHistory = useCallback(async () => {
    if (!isAddr(guardAddress) || !readProvider) return
    setLoadingHistory(true)
    setError('')
    try {
      const handle = eventScanHandle(scopeChainId, { address: guardAddress, abi: GUARD_ABI })
      if (!handle) { setError(`Could not reach ${networkName(scopeChainId)}`); return }
      const topics = handle.filters.DenyListUpdated().getTopicFilter()
      const latest = Number(await handle.provider.getBlockNumber())
      // Page in bounded ranges: a single unbounded queryFilter scans the whole chain and
      // times out / hits provider log-range limits on Polygon mainnet. CHUNK keeps each
      // eth_getLogs call safe; MAX_SPAN bounds the total scan to recent history (older
      // entries are surfaced via the truncation note rather than silently dropped).
      const CHUNK = 45_000
      const MAX_SPAN = 3_000_000
      const floor = Math.max(0, latest - MAX_SPAN)
      const events = []
      let to = latest
      while (to >= floor) {
        const from = Math.max(floor, to - CHUNK + 1)
        const logs = await handle.provider.getLogs({
          address: guardAddress,
          topics,
          fromBlock: from,
          toBlock: to,
        })
        for (const log of logs) {
          events.push({ ...log, args: handle.interface.parseLog(log).args })
        }
        if (from === floor) break
        to = from - 1
      }
      const rows = events
        .map((e) => ({
          account: e.args.account,
          denied: e.args.denied,
          actor: e.args.actor,
          reason: e.args.reason,
          block: e.blockNumber,
        }))
        .sort((a, b) => b.block - a.block)
      setHistory(rows)
      setTruncated(floor > 0)
    } catch (err) {
      setError(`Could not load audit trail: ${err.message || err}`)
    } finally {
      setLoadingHistory(false)
    }
  }, [guardAddress, readProvider, scopeChainId])

  useEffect(() => { loadHistory() }, [loadHistory])

  const submit = (denied) => {
    setError('')
    if (!isAddr(address)) { setError('Enter a valid address'); return }
    if (!reason.trim()) { setError('A reason is required (recorded on-chain for the audit trail)'); return }
    // Re-checked here, not just at render: a wallet that switched networks between render and
    // click would otherwise deny on the network the operator was not looking at.
    if (!onScopeNetwork) {
      setError(`Switch your wallet to ${networkName(scopeChainId)} to change its deny-list.`)
      return
    }
    const c = writer()
    if (!c) { setError(`SanctionsGuard is not configured on ${networkName(scopeChainId)}`); return }
    runTx(
      // `getAddress` before encoding (spec 110 divergence 16) — `isAddr` reproduces ethers' rule
      // and accepts an all-uppercase address, which viem's encoder refuses. Denying the wrong
      // account is not a recoverable mistake.
      () => c('setDenied', [getAddress(address.trim()), Boolean(denied), reason.trim()]),
      `Deny-list ${denied ? 'add' : 'remove'} on ${networkName(scopeChainId)}: ${shortAddr(address)}`,
    )
  }

  const checkStatus = async () => {
    setError('')
    setStatus(null)
    if (!isAddr(address)) { setError('Enter a valid address'); return }
    if (!isAddr(guardAddress)) { setError(`SanctionsGuard is not configured on ${networkName(scopeChainId)}`); return }
    if (!readProvider) { setError(`Could not reach ${networkName(scopeChainId)} — status is unknown, not clear.`); return }
    try {
      const ask = (functionName) =>
        readContract(scopeChainId, {
          address: guardAddress,
          abi: GUARD_ABI,
          functionName,
          args: [getAddress(address.trim())],
        })
      const [denied, allowed] = await Promise.all([ask('isDenied'), ask('isAllowed')])
      setStatus({ denied, allowed })
    } catch (err) {
      setError(`Status read failed: ${err.message || err}`)
    }
  }

  // The picker renders in BOTH branches. An empty state that drops it strands the operator on the
  // one network with nothing to see, with no control left to leave it.
  if (!isAddr(guardAddress)) {
    return (
      <section aria-labelledby="denylist-heading">
        <h3 id="denylist-heading">Sanctions deny-list</h3>
      <NetworkScopeCard
        title="Deny-list network"
        description="Each network has its own SanctionsGuard. A denial on one network is not a denial on another, and the audit trail below is this network's alone."
        networks={guardNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('sanctionsGuard', id))}
        walletChainId={chainId}
        onRefresh={loadHistory}
        lastReadAt={null}
        notDeployedLabel="no SanctionsGuard"
      />
        <p role="status">
          SanctionsGuard is not deployed on {networkName(scopeChainId)}. Pick a network that has one.
        </p>
      </section>
    )
  }

  return (
    <section aria-labelledby="denylist-heading">
      <h3 id="denylist-heading">Sanctions deny-list</h3>
      <NetworkScopeCard
        title="Deny-list network"
        description="Each network has its own SanctionsGuard. A denial on one network is not a denial on another, and the audit trail below is this network's alone."
        networks={guardNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('sanctionsGuard', id))}
        walletChainId={chainId}
        onRefresh={loadHistory}
        lastReadAt={null}
        notDeployedLabel="no SanctionsGuard"
      />
      <p>
        Manage the discretionary on-chain deny-list on {networkName(scopeChainId)}. Requires{' '}
        <code>SANCTIONS_ADMIN_ROLE</code> on that network&apos;s guard.
        Guard: <span title={guardAddress}>{shortAddr(guardAddress)}</span>
      </p>
      {!onScopeNetwork && (
        <p role="status" className="denylist-note">
          You are reading {networkName(scopeChainId)} while your wallet is on {networkName(chainId)}.
          Checking status and the audit trail work from here; changing the deny-list needs your
          wallet on {networkName(scopeChainId)}.
        </p>
      )}

      <div className="denylist-form">
        <label htmlFor="denylist-address">Wallet address</label>
        <input
          id="denylist-address"
          type="text"
          inputMode="text"
          autoComplete="off"
          placeholder="0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />

        <label htmlFor="denylist-reason">Reason (recorded on-chain)</label>
        <input
          id="denylist-reason"
          type="text"
          placeholder="e.g. OFAC SDN match / illicit-finance association"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div className="denylist-actions">
          <button type="button" className="confirm-btn danger" onClick={() => submit(true)} disabled={pendingTx || !onScopeNetwork}>
            {pendingTx ? 'Processing…' : `Add to deny-list on ${networkName(scopeChainId)}`}
          </button>
          <button type="button" className="confirm-btn" onClick={() => submit(false)} disabled={pendingTx || !onScopeNetwork}>
            {pendingTx ? 'Processing…' : `Remove from deny-list on ${networkName(scopeChainId)}`}
          </button>
          <button type="button" className="confirm-btn" onClick={checkStatus} disabled={pendingTx}>
            Check status
          </button>
        </div>
      </div>

      {error && <p role="alert" className="denylist-error">{error}</p>}

      {status && (
        <p role="status">
          {shortAddr(address)} — denied: <strong>{String(status.denied)}</strong>, allowed (guard verdict):{' '}
          <strong>{String(status.allowed)}</strong>
        </p>
      )}

      <h4 id="denylist-audit-heading">Audit trail</h4>
      <button type="button" className="confirm-btn" onClick={loadHistory} disabled={loadingHistory}>
        {loadingHistory ? 'Loading…' : 'Refresh'}
      </button>
      {truncated && (
        <p role="note" className="denylist-note">
          Showing the most recent history only (older entries beyond the scanned block window
          are not loaded). Query the chain/subgraph directly for the full audit trail.
        </p>
      )}
      {history.length === 0 && !loadingHistory ? (
        <p role="status">No deny-list changes recorded.</p>
      ) : (
        <table aria-labelledby="denylist-audit-heading">
          <caption className="sr-only">Deny-list change history (newest first)</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Reason</th>
              <th scope="col">Block</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={`${h.account}-${h.block}-${i}`}>
                <td title={h.account}>{shortAddr(h.account)}</td>
                <td>{h.denied ? 'Added' : 'Removed'}</td>
                <td title={h.actor}>{shortAddr(h.actor)}</td>
                <td>{h.reason}</td>
                <td>{h.block}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export default DenyListAdmin
