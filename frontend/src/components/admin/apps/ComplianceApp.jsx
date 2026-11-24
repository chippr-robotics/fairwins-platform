/**
 * Compliance admin mini-app (spec 093) — re-hosts DenyListAdmin (spec 060
 * lineage) and MiniAppReviewTab (spec 073 FR-022) unchanged.
 *
 * The decision made here is "may members run this vendor's code" / "may this
 * address transact" — review judgements, not protocol wiring. ADMIN enters
 * the review view read-only; lifecycle controls are offered only to accounts
 * the REGISTRY reports as curators (the view itself keeps disclosing which of
 * "not a curator" vs "could not verify" applies).
 *
 * Dashboard: the mini-app catalog by review status (real registry data via
 * the memoized catalog read) and the review queue headline. Registry
 * unreachable ⇒ said in words — never an empty chart pretending to be a
 * clean queue.
 */
import { useCallback, useEffect, useState } from 'react'
import AdminAppShell from '../AdminAppShell'
import DenyListAdmin from '../DenyListAdmin'
import MiniAppReviewTab from '../MiniAppReviewTab'
import AdminBarList from '../charts/AdminBarList'
import AdminStatTile from '../charts/AdminStatTile'
import { adminAppById } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useAdminWeb3 } from '../adminActing/useAdminWeb3'
import { DEPLOYED_CONTRACTS } from '../../../config/contracts'
import { fetchCatalog, REGISTRY_STATUS, registryLocation } from '../../../lib/miniapps/registryClient'
import { AppStatus } from '../../../abis/miniAppRegistry'
import { networkName } from '../../../lib/chains/estate'

const APP = adminAppById('compliance')

const STATUS_LABELS = {
  [AppStatus.PENDING]: 'Pending',
  [AppStatus.APPROVED]: 'Approved',
  [AppStatus.SUSPENDED]: 'Suspended',
  [AppStatus.DEPRECATED]: 'Deprecated',
}

function useCatalogSnapshot() {
  const [snapshot, setSnapshot] = useState({ state: 'loading' })

  const refresh = useCallback(async (force = false) => {
    try {
      const result = await fetchCatalog({ force })
      if (result.status === REGISTRY_STATUS.OK) {
        setSnapshot({ state: 'read', allApps: result.allApps, ageMs: result.ageMs })
      } else if (result.status === REGISTRY_STATUS.NOT_DEPLOYED) {
        setSnapshot({ state: 'not-deployed' })
      } else {
        setSnapshot({ state: 'unreadable' })
      }
    } catch {
      setSnapshot({ state: 'unreadable' })
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { snapshot, refresh }
}

function ComplianceDashboard() {
  const { snapshot, refresh } = useCatalogSnapshot()
  const { chainId: registryChainId } = registryLocation()

  const body = (() => {
    if (snapshot.state === 'loading') {
      return <p className="card-info" role="status">Reading the registry…</p>
    }
    if (snapshot.state === 'not-deployed') {
      return (
        <p className="card-info" role="status">
          No mini-app registry is configured for this build&apos;s cohort — there is no catalog to
          review.
        </p>
      )
    }
    if (snapshot.state === 'unreadable') {
      return (
        <p className="card-info" role="status">
          The registry on {networkName(registryChainId)} could not be read, so the review queue is
          unknown — not empty.
        </p>
      )
    }

    const { allApps } = snapshot
    const queue = allApps.filter((a) => a.proposed?.present)
    const byStatus = Object.entries(STATUS_LABELS).map(([status, label]) => ({
      label,
      value: allApps.filter((a) => a.status === Number(status)).length,
      display: String(allApps.filter((a) => a.status === Number(status)).length),
    }))

    return (
      <>
        <div className="admin-stat-tiles" role="group" aria-label="Review queue summary">
          <AdminStatTile
            label="Packages awaiting review"
            value={queue.length}
            tone={queue.length > 0 ? 'accent' : undefined}
          />
          <AdminStatTile label="Records on the registry" value={allApps.length} />
          <AdminStatTile
            label="Live (launchable) apps"
            value={allApps.filter((a) => a.launchable).length}
          />
        </div>
        <h4 className="admin-dashboard-subhead">Catalog by review status</h4>
        <AdminBarList
          ariaLabel="Mini-app catalog records by review status"
          items={byStatus}
          emptyLabel="The registry holds no records yet."
        />
      </>
    )
  })()

  return (
    <div className="overview-grid">
      <div className="admin-card full-width">
        <div className="admin-card-header">
          <h3>Mini-app curation on {networkName(registryChainId)}</h3>
          <button type="button" className="confirm-btn" onClick={() => refresh(true)}>
            Refresh
          </button>
        </div>
        {body}
        <p className="card-info">
          A Pending record with a prior approval is a LIVE app whose update is in review — the
          serving decision is <code>launchable</code>, never the review status alone.
        </p>
      </div>
    </div>
  )
}

export default function ComplianceApp() {
  const access = useAdminAccess()
  const { account, signer, chainId } = useAdminWeb3()
  const { runTx, pendingTx } = useAdminTx()

  const renderView = (viewId) => {
    if (viewId === 'deny-list') {
      return (
        <DenyListAdmin
          signer={signer}
          account={account}
          contracts={DEPLOYED_CONTRACTS}
          chainId={chainId}
          runTx={runTx}
          pendingTx={pendingTx}
        />
      )
    }
    if (viewId === 'miniapp-review') {
      return (
        <MiniAppReviewTab
          signer={signer}
          account={account}
          chainId={chainId}
          runTx={runTx}
          pendingTx={pendingTx}
        />
      )
    }
    return null
  }

  return <AdminAppShell app={APP} access={access} dashboard={<ComplianceDashboard />} renderView={renderView} />
}
