/**
 * Identity admin mini-app (spec 093) — re-hosts CallsignRegistryAdmin
 * (spec 054) unchanged.
 *
 * The dashboard renders registry-wide metrics from the existing bounded
 * event scan (useCallsignRegistryMetrics): registrations over the scanned
 * block window as a sparkline and lifecycle counts as a distribution. The
 * scan is explicit (Refresh) and honestly flags a truncated window; before
 * the first scan the dashboard says "not scanned yet" rather than zero.
 */
import { useMemo } from 'react'
import AdminAppShell from '../AdminAppShell'
import CallsignRegistryAdmin from '../CallsignRegistryAdmin'
import AdminSparkline from '../charts/AdminSparkline'
import AdminBarList from '../charts/AdminBarList'
import { NetworkScopeCard } from '../scopeControls'
import { useScopedChain } from '../scopeGate'
import { adminAppById } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useWeb3 } from '../../../hooks/useWeb3'
import { useAdminWeb3 } from '../adminActing/useAdminWeb3'
import { useCallsignRegistryMetrics } from '../../../hooks/useCallsignRegistryMetrics'
import { DEPLOYED_CONTRACTS, getContractAddressForChain } from '../../../config/contracts'
import { getProvider } from '../../../utils/blockchainService'
import { networkName, readProviderFor, estateNetworks } from '../../../lib/chains/estate'

const APP = adminAppById('identity')

function IdentityDashboard() {
  const { provider, chainId } = useWeb3()
  // Scoped like every operator view (spec 071 FR-016): the registry is read on
  // a NAMED network, seeded once from the wallet, never re-derived from it.
  const registryNetworks = useMemo(
    () => estateNetworks().filter((n) => getContractAddressForChain('callsignRegistry', n.chainId)),
    [],
  )
  const { scopeChainId, setScopeChainId } = useScopedChain(registryNetworks, chainId)
  const registryAddr = scopeChainId ? getContractAddressForChain('callsignRegistry', scopeChainId) : null
  const readProvider = scopeChainId
    ? readProviderFor(scopeChainId, chainId, provider) || getProvider(scopeChainId)
    : null
  const metrics = useCallsignRegistryMetrics({
    provider: readProvider,
    chainId: scopeChainId,
    address: registryAddr,
  })

  const data = metrics.data
  const registrationSeries = useMemo(() => {
    if (!data?.recent?.length) return []
    // Cumulative registrations over the recent-events window, on the block
    // clock the logs carry (oldest → newest). `recent` is capped, so this is
    // honestly "recent registrations", not all-time — the caption says so.
    const registrations = [...data.recent]
      .filter((e) => e.type === 'CallsignRegistered')
      .sort((a, b) => a.block - b.block)
    return registrations.map((e, i) => ({ x: e.block, y: i + 1 }))
  }, [data])

  if (!registryAddr) {
    return (
      <div className="overview-grid">
        <div className="admin-card full-width">
          <div className="admin-card-header"><h3>Callsign registry</h3></div>
          <p className="card-info" role="status">
            No cohort network carries a CallsignRegistry — nothing to moderate anywhere yet.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="overview-grid">
      <NetworkScopeCard
        title="Callsign registry metrics"
        description="Metrics are read from ONE network's registry — pick which. Reads never require the wallet to move."
        networks={registryNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('callsignRegistry', id))}
        walletChainId={chainId}
        onRefresh={() => metrics.refresh?.({ force: true })}
        lastReadAt={null}
        notDeployedLabel="no callsign registry"
      />
      <div className="admin-card full-width">
        <div className="admin-card-header">
          <h3>Registry activity on {networkName(scopeChainId)}</h3>
          <button
            type="button"
            className="confirm-btn"
            onClick={() => metrics.refresh?.({ force: true })}
            disabled={metrics.loading}
          >
            {metrics.loading ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
        {metrics.error && <p role="alert" className="card-info">Scan failed: {metrics.error}</p>}
        {!data && !metrics.loading && !metrics.error && (
          <p className="card-info" role="status">
            Not scanned yet — metrics come from an explicit, bounded event scan.
          </p>
        )}
        {data && (
          <>
            <AdminSparkline
              points={registrationSeries}
              ariaLabel={`Cumulative recent callsign registrations reaching ${registrationSeries.length} over the scanned block window`}
              caption="Recent registrations (cumulative) →"
              latestLabel={String(registrationSeries.length)}
              hint="recent events, over scanned blocks"
              emptyLabel="No registrations in the scanned window."
            />
            <h4 className="admin-dashboard-subhead">
              Lifecycle activity {data.truncated ? '(scanned window)' : ''}
            </h4>
            <AdminBarList
              ariaLabel="Callsign lifecycle event counts"
              items={[
                { label: 'Registered', value: data.counts.registered, display: String(data.counts.registered) },
                { label: 'Changed', value: data.counts.changed, display: String(data.counts.changed) },
                { label: 'Released', value: data.counts.released, display: String(data.counts.released) },
                { label: 'Reclaimed', value: data.counts.reclaimed, display: String(data.counts.reclaimed) },
              ]}
            />
            {data.truncated && (
              <p role="note" className="card-info">
                Showing the most recent block window only — tallies are for the scanned range, not
                all-time.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function IdentityApp() {
  const access = useAdminAccess()
  const { account, signer, chainId } = useAdminWeb3()
  const { runTx, pendingTx } = useAdminTx()

  const renderView = (viewId) => {
    if (viewId !== 'callsigns') return null
    return (
      <CallsignRegistryAdmin
        signer={signer}
        account={account}
        contracts={DEPLOYED_CONTRACTS}
        chainId={chainId}
        runTx={runTx}
        pendingTx={pendingTx}
      />
    )
  }

  return <AdminAppShell app={APP} access={access} dashboard={<IdentityDashboard />} renderView={renderView} />
}
