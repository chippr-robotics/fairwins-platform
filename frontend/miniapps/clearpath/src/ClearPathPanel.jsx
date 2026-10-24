import { useCallback, useEffect, useState } from 'react'
import { useMiniAppHost } from '@fairwins/miniapp-sdk'

/**
 * Resolve a declared deployment, or null. The host THROWS for a name outside this package's
 * manifest allowlist, which would be a packaging bug rather than a runtime condition — but a
 * throw here would take the panel down, so it is converted to the same absence every caller
 * already handles.
 */
function hostContract(host, name, chainId) {
  try {
    return host.contracts(name, chainId)
  } catch {
    return null
  }
}
import './clearpath.css'
import { DAO_FRAMEWORK_LABEL } from './externalDAORegistryAbi'
import { useClearPath } from './useClearPath'
import RegisterExternalDao from './RegisterExternalDao'
import CreateStandardDao from './CreateStandardDao'
import ExternalDaoView from './ExternalDaoView'

// Spec 030/042 + network-agnostic follow-up — ClearPath module (external-DAO pillar), embedded as the My
// Account "ClearPath" tab. Lists DAOs across EVERY clearpath-capable network at once (mirroring the Portfolio
// tab's cross-chain pattern) — registered in an on-chain ExternalDAORegistry where deployed, else tracked
// device-local, plus the curated known-DAO seed list. Each row is tagged with its network; opening one reads
// live over that network's own RPC regardless of which chain the wallet is connected to. Real on-chain only —
// acting on a DAO (register/vote/queue/execute) still requires the wallet to switch to that DAO's own network.

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

export default function ClearPathPanel() {
  const host = useMiniAppHost()
  const {
    isSupported,
    chainId,
    chainIds,
    hasRegistryFor,
    reader,
    readerFor,
    signer,
    account,
    listExternalDAOs,
    trackDAO,
    untrackDAO,
  } = useClearPath()
  const [tab, setTab] = useState('daos')
  const [loading, setLoading] = useState(true)
  const [daos, setDaos] = useState([])
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const net = host.network(chainId)

  // Loads every clearpath network's DAOs in parallel (network-agnostic). Does NOT setState synchronously (the
  // first statement is the async read) so it is safe to call from the effect; the Refresh button flips
  // `loading` itself.
  const load = useCallback(async () => {
    try {
      const list = await listExternalDAOs()
      setDaos(list)
      setError(null)
    } catch (e) {
      setError(e?.shortMessage || e?.message || 'Could not load DAOs.')
      setDaos([])
    } finally {
      setLoading(false)
    }
  }, [listExternalDAOs])

  useEffect(() => {
    load()
  }, [load])

  const refresh = () => {
    setLoading(true)
    load()
  }

  const openDao = (d) => setSelected(d)

  return (
    <div className="clearpath">
      {selected ? (
        <ExternalDaoView
          record={selected}
          reader={readerFor(selected.chainId)}
          signer={signer}
          account={account}
          chainId={selected.chainId}
          usdcAddress={hostContract(host, 'paymentToken', selected.chainId)}
          onBack={() => setSelected(null)}
        />
      ) : (
        <>
          <p className="cp-intro">
            ClearPath — track and manage DAOs across every supported network: an OpenZeppelin Governor (e.g. ENS,
            Olympia) or a Governor Bravo DAO (e.g. Uniswap). Every DAO is listed regardless of which network your
            wallet is currently on — you'll be asked to switch networks only when you act (register, vote, queue,
            execute).
          </p>
          {!isSupported && (
            <div className="cp-notice" role="status">
              Your wallet is on {net?.name || 'a network'}, which doesn't run ClearPath — you can still browse the
              DAOs below; switch to a supported network to register, track, or act on one.
            </div>
          )}

          <div className="cp-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'daos'} className={`cp-tab ${tab === 'daos' ? 'active' : ''}`} onClick={() => setTab('daos')}>
              DAOs
            </button>
            <button type="button" role="tab" aria-selected={tab === 'register'} className={`cp-tab ${tab === 'register' ? 'active' : ''}`} onClick={() => setTab('register')}>
              Register / Track
            </button>
            {/*
              Spec 030 pillar A. Always OFFERED, never a dead end: on a chain with no factory the panel
              itself explains why (pre-Cancun by decision, or simply not deployed), which is strictly more
              useful than hiding the tab and leaving the member to guess whether the feature exists.
            */}
            <button type="button" role="tab" aria-selected={tab === 'create'} className={`cp-tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}>
              Launch
            </button>
          </div>

          {tab === 'daos' && (
            <div role="tabpanel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                <span className="cp-row-sub">DAOs across every supported network</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <button type="button" className="cp-btn" onClick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
                </div>
              </div>
              {error && <div className="cp-error" role="alert">{error}</div>}
              {!loading && daos.length === 0 && !error && (
                <p className="cp-empty">No DAOs tracked yet. Use “Register / Track” to add one.</p>
              )}
              {daos.map((d) => (
                <div key={`${d.chainId}:${d.id}`} className="cp-row" role="button" tabIndex={0}
                  onClick={() => openDao(d)} onKeyDown={(e) => { if (e.key === 'Enter') openDao(d) }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="cp-row-name">{d.label || 'External DAO'}</div>
                    <div className="cp-row-sub">{short(d.dao)}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <span className="cp-badge" title={`Network: ${d.networkName}`}>{d.networkName}</span>
                    <span className="cp-badge cp-badge-ext">{DAO_FRAMEWORK_LABEL[d.framework] || 'Unknown'}</span>
                    {d.source === 'local' && (
                      <button
                        type="button"
                        className="cp-btn-link"
                        aria-label={`Untrack ${d.label || short(d.dao)}`}
                        onClick={(e) => { e.stopPropagation(); untrackDAO(d.dao, d.chainId); load() }}
                      >
                        Untrack
                      </button>
                    )}
                    <span aria-hidden="true" style={{ color: 'var(--cp-text-3)' }}>›</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'create' && (
            <div role="tabpanel">
              {/* The created DAO is registered/tracked through the SAME hook the Register tab uses, so a
                  native DAO lands in exactly one list alongside external ones (FR-009). */}
              <CreateStandardDao
                hasRegistryFor={hasRegistryFor}
                track={async (args) => { const r = await trackDAO(args); load(); return r }}
              />
            </div>
          )}

          {tab === 'register' && (
            <div role="tabpanel">
              <RegisterExternalDao
                connectedChainId={chainId}
                connectedReader={reader}
                chainIds={chainIds}
                hasRegistryFor={hasRegistryFor}
                readerFor={readerFor}
                track={trackDAO}
                onRegistered={() => { setTab('daos'); load() }}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
