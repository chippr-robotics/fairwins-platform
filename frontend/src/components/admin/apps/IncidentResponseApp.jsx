/**
 * Incident Response admin mini-app (spec 093) — the monolithic AdminPanel's
 * `emergency` and `moderation` views, extracted verbatim.
 *
 * Semantics deliberately unchanged (FR-005):
 *  - Incident controls are per chain: pause and freeze act on ONE
 *    WagerRegistry. Scoped, named at the write, and — deliberately — with NO
 *    control that acts on several chains at once (spec 071 FR-020): a
 *    killswitch that fans out is one an operator can fire without knowing
 *    what they hit.
 *  - The call site refuses off-chain writes as well as the disabled button,
 *    so a stale render cannot pause the wrong network (FR-018).
 *
 * The dashboard adds an honest estate view: the registry's pause state read
 * per cohort chain, three-state — an unreachable chain says so, never "Active".
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { encodeFunctionData } from 'viem'
import AdminAppShell from '../AdminAppShell'
import ServiceHealthCard from '../ServiceHealthCard'
import AdminStatTile from '../charts/AdminStatTile'
import { NetworkScopeCard, WriteScopeNotice } from '../scopeControls'
import { useScopedChain } from '../scopeGate'
import { adminAppById } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useWeb3 } from '../../../hooks/useWeb3'
import { useNotification } from '../../../hooks/useUI'
import { useEnsResolution } from '../../../hooks/useEnsResolution'
import { isValidEthereumAddress } from '../../../utils/validation'
import { ACCOUNT_MODERATION_PATH } from '../../../constants/legalLinks'
import { getContractAddressForChain } from '../../../config/contracts'
import { readContract, normalizeAbi } from '../../../lib/chains/readContract'
import { getAddress } from '../../../lib/evm/address'
import { networkName, readProviderFor, estateNetworks } from '../../../lib/chains/estate'
import { readOk, notDeployed, unreadable, isRead } from '../../../lib/chains/chainReadResult'

const APP = adminAppById('incident-response')

const WAGER_REGISTRY_INCIDENT_ABI = [
  'function paused() view returns (bool)',
  'function pause()',
  'function unpause()',
  'function freezeAccount(address user, string reason)',
  'function unfreezeAccount(address user)',
]

function shortAddr(address) {
  return address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : ''
}

/**
 * Pause state per cohort chain, three-state. Read via the per-chain read
 * providers — a chain that will not answer is `unreadable`, never a green
 * "Active" tile (constitution III).
 */
function usePauseEstate() {
  const { provider, chainId } = useWeb3()
  const [results, setResults] = useState([])
  const [readAt, setReadAt] = useState(null)

  const refresh = useCallback(async () => {
    const all = await Promise.all(
      estateNetworks().map(async (n) => {
        const addr = getContractAddressForChain('wagerRegistry', n.chainId)
        if (!addr) return notDeployed(n.chainId)
        try {
          // `readProviderFor`'s null is the availability gate REFUSING, not a gap to route
          // around: the `|| getProvider(n.chainId)` this replaced hand-built a provider from
          // `NETWORKS[chainId].rpcUrl` (spec 069 forbids it — it ignores the member's configured
          // endpoint and its failover) through `getNetwork`, which FALLS BACK to the default
          // network for a chain it does not know. On a pause dashboard that means one chain's
          // paused state rendered under another chain's name.
          if (!readProviderFor(n.chainId, chainId, provider)) {
            return unreadable(n.chainId, `no read connection to ${n.name}`)
          }
          const paused = await readContract(n.chainId, {
            address: addr,
            abi: WAGER_REGISTRY_INCIDENT_ABI,
            functionName: 'paused',
          })
          return readOk(n.chainId, Boolean(paused), null, Date.now())
        } catch (err) {
          return unreadable(n.chainId, err?.message)
        }
      }),
    )
    setResults(all)
    // NetworkScopeCard renders this via toLocaleTimeString — it is a Date, not epoch ms.
    setReadAt(new Date())
  }, [provider, chainId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { results, readAt, refresh }
}

function IncidentDashboard({ pauseEstate }) {
  const anyPaused = pauseEstate.results.some((r) => isRead(r) && r.value === true)
  return (
    <div className="overview-grid">
      <div className="admin-card full-width">
        <div className="admin-card-header">
          <h3>Registry pause state across the estate</h3>
          <button type="button" className="confirm-btn" onClick={pauseEstate.refresh}>
            Refresh
          </button>
        </div>
        <div className="admin-stat-tiles" role="group" aria-label="Registry pause state per network">
          {pauseEstate.results.map((r) => (
            <AdminStatTile
              key={r.chainId}
              label={networkName(r.chainId)}
              result={r}
              display={isRead(r) ? (r.value ? 'Paused' : 'Active') : undefined}
              tone={isRead(r) ? (r.value ? 'alert' : 'accent') : undefined}
            />
          ))}
        </div>
        <p className="card-info">
          {anyPaused
            ? 'At least one registry is paused. The Emergency view acts on one named network at a time.'
            : 'Each tile is that network’s own answer — an unreadable network is reported as unreadable, never as active.'}
        </p>
      </div>
      <ServiceHealthCard />
    </div>
  )
}

export default function IncidentResponseApp() {
  const access = useAdminAccess()
  const { signer, chainId } = useWeb3()
  const { showNotification } = useNotification()

  const registryNetworks = useMemo(
    () => estateNetworks().filter((n) => getContractAddressForChain('wagerRegistry', n.chainId)),
    [],
  )
  const { scopeChainId: incidentChainId, setScopeChainId: setIncidentChainId } =
    useScopedChain(registryNetworks, chainId)
  const incidentRegistryAddr = getContractAddressForChain('wagerRegistry', incidentChainId)
  const onIncidentChain = Number(incidentChainId) === Number(chainId)

  const pauseEstate = usePauseEstate()
  const scopePause = pauseEstate.results.find((r) => Number(r.chainId) === Number(incidentChainId))
  const scopeIsPaused = scopePause && isRead(scopePause) ? scopePause.value : false

  const { runTx, pendingTx } = useAdminTx({ onSuccess: pauseEstate.refresh })

  const incidentWrite = (functionName, args = []) =>
    signer.sendTransaction({
      to: incidentRegistryAddr,
      data: encodeFunctionData({
        abi: normalizeAbi(WAGER_REGISTRY_INCIDENT_ABI),
        functionName,
        args,
      }),
    })

  const requireIncidentChain = () => {
    if (onIncidentChain) return true
    showNotification(
      `This acts on ${networkName(incidentChainId)}. Switch your wallet there first.`,
      'error',
    )
    return false
  }

  const [freezeForm, setFreezeForm] = useState({ address: '', reason: '' })
  const freezeEns = useEnsResolution(freezeForm.address || '')

  const handlePause = () => requireIncidentChain() && runTx(
    () => incidentWrite('pause'),
    `WagerRegistry paused on ${networkName(incidentChainId)}`
  )

  const handleUnpause = () => requireIncidentChain() && runTx(
    () => incidentWrite('unpause'),
    `WagerRegistry unpaused on ${networkName(incidentChainId)}`
  )

  const handleFreeze = () => {
    const target = freezeEns.resolvedAddress || freezeForm.address
    if (!isValidEthereumAddress(target)) return showNotification('Invalid address', 'error')
    if (!freezeForm.reason.trim())
      return showNotification('Reason is required (recorded on-chain)', 'error')
    if (!requireIncidentChain()) return false
    return runTx(
      () => incidentWrite('freezeAccount', [getAddress(target.trim()), freezeForm.reason.trim()]),
      `Account ${shortAddr(target)} frozen on ${networkName(incidentChainId)}`,
    )
  }

  const handleUnfreeze = () => {
    const target = freezeEns.resolvedAddress || freezeForm.address
    if (!isValidEthereumAddress(target)) return showNotification('Invalid address', 'error')
    if (!requireIncidentChain()) return false
    return runTx(
      () => incidentWrite('unfreezeAccount', [getAddress(target.trim())]),
      `Account ${shortAddr(target)} unfrozen on ${networkName(incidentChainId)}`,
    )
  }

  const renderView = (viewId) => {
    if (viewId === 'emergency') {
      return (
        <div className="admin-tab-content" role="tabpanel">
          <NetworkScopeCard
            title="Emergency Pause"
            description={
              'The pause acts on ONE network’s WagerRegistry. There is deliberately no control that pauses several at once — a killswitch that fans out is one an operator can fire without knowing what they hit.'
            }
            networks={registryNetworks}
            scopeChainId={incidentChainId}
            onScopeChange={setIncidentChainId}
            isDeployed={(id) => Boolean(getContractAddressForChain('wagerRegistry', id))}
            walletChainId={chainId}
            onRefresh={pauseEstate.refresh}
            lastReadAt={pauseEstate.readAt}
            notDeployedLabel="no wager registry"
          />

          {/*
            FR-018: a wrong-network write is refused in WORDS, before signing. The buttons below
            disable themselves off the scoped chain, and a dead control with no explanation is
            indistinguishable from a bug — least of all here, where the operator is mid-incident
            and the thing that will not press is the killswitch.
          */}
          <WriteScopeNotice
            scopeChainId={incidentChainId}
            walletChainId={chainId}
            signer={signer}
            canWrite
          />

          <div className="admin-card">
            <h3>Emergency Pause on {networkName(incidentChainId)}</h3>
            <p>
              Pausing halts wager creation, acceptance, and settlement protocol-wide. Use only in
              response to a security incident. Unpausing restores normal operation.
            </p>
            {scopePause && !isRead(scopePause) && (
              <p className="card-info warning-text" role="status">
                The pause state on {networkName(incidentChainId)} could not be read — the buttons
                below act on the contract&apos;s real state, whatever it is.
              </p>
            )}
            <div className="emergency-actions">
              {!scopeIsPaused ? (
                <button
                  className="confirm-btn danger"
                  onClick={handlePause}
                  disabled={pendingTx || !onIncidentChain}
                >
                  {pendingTx ? 'Processing...' : `Pause on ${networkName(incidentChainId)}`}
                </button>
              ) : (
                <button
                  className="confirm-btn primary"
                  onClick={handleUnpause}
                  disabled={pendingTx || !onIncidentChain}
                >
                  {pendingTx ? 'Processing...' : `Unpause on ${networkName(incidentChainId)}`}
                </button>
              )}
            </div>
          </div>
          {/* Incident commanders get the gasless-infra picture on the same screen: the
              on-chain pause and the gateway killswitch are the two halves of a full stop. */}
          <ServiceHealthCard />
        </div>
      )
    }

    if (viewId === 'moderation') {
      return (
        <div className="admin-tab-content" role="tabpanel">
          <NetworkScopeCard
            title="Account Moderation"
            description={
              'A freeze applies to ONE network’s WagerRegistry. Freezing an account on one network does not freeze it on another, so each is done explicitly.'
            }
            networks={registryNetworks}
            scopeChainId={incidentChainId}
            onScopeChange={setIncidentChainId}
            isDeployed={(id) => Boolean(getContractAddressForChain('wagerRegistry', id))}
            walletChainId={chainId}
            onRefresh={pauseEstate.refresh}
            lastReadAt={pauseEstate.readAt}
            notDeployedLabel="no wager registry"
          />

          <WriteScopeNotice
            scopeChainId={incidentChainId}
            walletChainId={chainId}
            signer={signer}
            canWrite
          />

          <div className="admin-card">
            <h3>Freeze / Unfreeze Account on {networkName(incidentChainId)}</h3>
            <p>
              A frozen account cannot create wagers, accept wagers, cancel, declare a winner, claim
              payouts, or claim refunds on WagerRegistry. Polymarket auto-resolution is
              permissionless and continues to work — but the winner still cannot claim while
              frozen. See{' '}
              <a href={ACCOUNT_MODERATION_PATH} target="_blank" rel="noopener noreferrer">
                policy
              </a>
              .
            </p>
            <div className="admin-form">
              <label>
                Account (address or ENS)
                <input
                  type="text"
                  value={freezeForm.address}
                  placeholder="0x… or name.eth"
                  onChange={(e) => setFreezeForm({ ...freezeForm, address: e.target.value })}
                />
                {freezeEns.resolvedAddress && freezeEns.isEns && (
                  <span className="hint">→ {shortAddr(freezeEns.resolvedAddress)}</span>
                )}
              </label>
              <label>
                Reason (recorded on-chain in the AccountFrozen event)
                <input
                  type="text"
                  value={freezeForm.reason}
                  placeholder="e.g. fraud investigation, court order, TOS violation"
                  onChange={(e) => setFreezeForm({ ...freezeForm, reason: e.target.value })}
                />
              </label>
              <div className="emergency-actions">
                <button
                  className="confirm-btn danger"
                  onClick={handleFreeze}
                  disabled={pendingTx || !onIncidentChain}
                >
                  {pendingTx ? 'Processing...' : `Freeze on ${networkName(incidentChainId)}`}
                </button>
                <button
                  className="confirm-btn secondary"
                  onClick={handleUnfreeze}
                  disabled={pendingTx || !onIncidentChain}
                >
                  {pendingTx ? 'Processing...' : `Unfreeze on ${networkName(incidentChainId)}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )
    }

    return null
  }

  return (
    <AdminAppShell
      app={APP}
      access={access}
      dashboard={<IncidentDashboard pauseEstate={pauseEstate} />}
      renderView={renderView}
    />
  )
}
