import { useState, useMemo } from 'react'
import { encodeFunctionData } from 'viem'
import { getContractAddressForChain } from '../../config/contracts'
import { estateNetworks, networkName } from '../../lib/chains/estate'
import { normalizeAbi } from '../../lib/chains/readContract'
import { NetworkScopeCard } from './scopeControls'
import { useScopedChain } from './scopeGate'

/**
 * MaintenanceTab — permissionless housekeeping calls on the wager registry
 * (they live on the intents facet, reached through the proxy).
 *
 * Anyone on-chain may call these; surfacing them here gives operators a
 * one-click way to demonstrate active platform stewardship: sweeping expired
 * open wagers (refunds creators, frees membership slots) and nudging
 * oracle-resolvable wagers to settlement.
 */
const MAINTENANCE_ABI = [
  'function batchExpireOpen(uint256[] wagerIds)',
  'function autoResolveFromPolymarket(uint256 wagerId)',
  'function autoResolveFromOracle(uint256 wagerId)',
]

function parseIdList(text) {
  return text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // BigInt would happily parse "-1", which then fails uint256 ABI encoding
      // downstream — reject anything but plain digits up front.
      if (!/^\d+$/.test(s)) throw new Error(`invalid id: ${s}`)
      return BigInt(s)
    })
}

function MaintenanceTab({ signer, chainId, runTx, pendingTx }) {
  // Spec 071 US4: these calls run on ONE registry on ONE chain. The tab used to take whichever
  // chain the wallet sat on, which meant an operator could not sweep Polygon's expired wagers
  // from a wallet pointed at Base — and nothing on screen said that was why.
  const networks = useMemo(() => estateNetworks(), [])
  const { scopeChainId, setScopeChainId } = useScopedChain(networks, chainId)
  const registryAddr = getContractAddressForChain('wagerRegistry', scopeChainId)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)
  // A permissionless call is still a WRITE: one named chain, wallet required there (FR-017/018).
  const canSubmit = Boolean(signer) && onScopeNetwork && Boolean(registryAddr) && !pendingTx
  const [expireIds, setExpireIds] = useState('')
  const [resolveForm, setResolveForm] = useState({ id: '', source: 'polymarket' })
  const [parseError, setParseError] = useState('')

  const write = (functionName, args) =>
    signer.sendTransaction({
      to: registryAddr,
      data: encodeFunctionData({ abi: normalizeAbi(MAINTENANCE_ABI), functionName, args }),
    })

  const handleBatchExpire = () => {
    let ids
    try {
      ids = parseIdList(expireIds)
      setParseError('')
    } catch {
      setParseError('Wager IDs must be integers (comma or space separated)')
      return
    }
    if (ids.length === 0) return
    runTx(
      () => write('batchExpireOpen', [ids]),
      `Expired ${ids.length} open wager${ids.length === 1 ? '' : 's'} on ${networkName(scopeChainId)} — creators refunded`
    )
  }

  const handleAutoResolve = () => {
    const raw = resolveForm.id.trim()
    if (!/^\d+$/.test(raw)) {
      setParseError('Wager ID must be a non-negative integer')
      return
    }
    setParseError('')
    const id = BigInt(raw)
    const fn = resolveForm.source === 'polymarket'
      ? () => write('autoResolveFromPolymarket', [id])
      : () => write('autoResolveFromOracle', [id])
    runTx(fn, `Auto-resolution triggered for wager #${resolveForm.id} on ${networkName(scopeChainId)}`)
  }

  return (
    <div className="admin-tab-content" role="tabpanel">
      <NetworkScopeCard
        title="Maintenance"
        description="Permissionless housekeeping on one network's wager registry. Reading any network works from anywhere; each call is signed on the network in scope."
        networks={networks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('wagerRegistry', id))}
        walletChainId={chainId}
        onRefresh={() => {}}
        lastReadAt={null}
        notDeployedLabel="no wager registry"
      />

      {!registryAddr && (
        <p className="card-info warning-text" role="status">
          No wager registry on {networkName(scopeChainId)} — nothing to maintain here.
        </p>
      )}
      {registryAddr && !onScopeNetwork && (
        <p className="card-info warning-text" role="status">
          These calls are signed on {networkName(scopeChainId)}. Your wallet is on{' '}
          {networkName(chainId)} — switch it there to run them.
        </p>
      )}

      <div className="admin-card">
        <h3>Expire Open Wagers</h3>
        <p>
          Sweeps Open wagers whose accept deadline has passed: refunds the creator's stake and
          releases their concurrent-market slot. The call is permissionless and skips wagers
          that are not actually expired, so a stale ID is harmless.
        </p>
        <div className="admin-form">
          <label>
            Wager IDs (comma or space separated)
            <input type="text" placeholder="e.g. 12, 15, 33" value={expireIds}
              onChange={(e) => setExpireIds(e.target.value)} />
            {parseError && <span className="hint">{parseError}</span>}
          </label>
          <button className="confirm-btn primary" onClick={handleBatchExpire}
            disabled={!canSubmit || !expireIds.trim()}>
            {pendingTx ? 'Sweeping...' : `Run Expiry Sweep on ${networkName(scopeChainId)}`}
          </button>
        </div>
      </div>

      <div className="admin-card">
        <h3>Trigger Auto-Resolution</h3>
        <p>
          Nudges an oracle-resolvable wager to settlement (Polymarket or a configured oracle
          adapter). Permissionless — the oracle outcome, not the caller, decides the winner.
        </p>
        <div className="admin-form">
          <label>
            Wager ID
            <input type="text" placeholder="e.g. 42" value={resolveForm.id}
              onChange={(e) => setResolveForm({ ...resolveForm, id: e.target.value })} />
          </label>
          <label>
            Resolution source
            <select value={resolveForm.source}
              onChange={(e) => setResolveForm({ ...resolveForm, source: e.target.value })}>
              <option value="polymarket">Polymarket</option>
              <option value="oracle">Oracle adapter (Chainlink / UMA)</option>
            </select>
          </label>
          <button className="confirm-btn primary" onClick={handleAutoResolve}
            disabled={!canSubmit || !resolveForm.id.trim()}>
            {pendingTx ? 'Processing...' : `Trigger Resolution on ${networkName(scopeChainId)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default MaintenanceTab
