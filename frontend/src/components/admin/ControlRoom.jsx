/**
 * ControlRoom (spec 093) — the operations launcher at /admin, replacing the
 * monolithic AdminPanel.
 *
 * Shows exactly the admin mini-apps the connected account's roles unlock
 * (buildAdminApps — the same single source the app shells and route guard
 * read), each tile carrying a headline status where one exists. An account
 * with no qualifying role gets the standard denied experience via
 * AdminAccessGate, and — because every data hook lives in the body component
 * mounted BEHIND the gate — a denied account fetches no admin data at all.
 *
 * Headline statuses obey the estate-read rules: a status renders a value only
 * in state 'read'; an unreachable source is said to be unreachable, never
 * rendered as a zero or a green light.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import NavIcon from '../nav/NavIcon'
import AdminAccessGate from './AdminAccessGate'
import { useAdminAccess, adminBadgeLabel } from './useAdminAccess'
import { buildAdminApps } from './adminApps'
import { ROLES } from '../../contexts/RoleContext'
import { useWeb3 } from '../../hooks/useWeb3'
import { useChainTokens } from '../../hooks/useChainTokens'
import { useFeeEstate } from '../../hooks/useFeeEstate'
import { useGatewayStatus } from '../../hooks/useGatewayStatus'
import { readContract } from '../../lib/chains/readContract'
import { getContractAddressForChain } from '../../config/contracts'
import { getProvider } from '../../utils/blockchainService'
import { networkName, readProviderFor, estateNetworks } from '../../lib/chains/estate'
import { fetchCatalog, REGISTRY_STATUS } from '../../lib/miniapps/registryClient'
import { isRead } from '../../lib/chains/chainReadResult'
import '../AdminPanel.css'
import './ControlRoom.css'

const PAUSED_ABI = ['function paused() view returns (bool)']

function shortAddr(address) {
  return address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : ''
}

/**
 * The registry's pause state across the ESTATE, summarized for a tile —
 * never just the wallet's chain (an incident elsewhere would render as calm).
 * Three-state per chain; the summary discloses unreadable chains rather than
 * counting them as active.
 */
function usePauseStatus() {
  const { provider, chainId } = useWeb3()
  const [status, setStatus] = useState({ state: 'none' })

  const refresh = useCallback(async () => {
    const targets = estateNetworks()
      .map((n) => ({ chainId: n.chainId, addr: getContractAddressForChain('wagerRegistry', n.chainId) }))
      .filter((t) => Boolean(t.addr))
    if (targets.length === 0) {
      setStatus({ state: 'not-deployed' })
      return
    }
    const reads = await Promise.all(
      targets.map(async (t) => {
        try {
          // The gate stays `readProviderFor` — it carries the cohort bound — while the read
          // itself names the chain it is about (spec 110), so an estate sweep can never report
          // one network's pause state under another's name.
          if (!readProviderFor(t.chainId, chainId, provider) && !getProvider(t.chainId)) {
            return { chainId: t.chainId, ok: false }
          }
          const paused = await readContract(t.chainId, {
            address: t.addr,
            abi: PAUSED_ABI,
            functionName: 'paused',
          })
          return { chainId: t.chainId, ok: true, paused: Boolean(paused) }
        } catch {
          return { chainId: t.chainId, ok: false }
        }
      }),
    )
    const readable = reads.filter((r) => r.ok)
    if (readable.length === 0) {
      setStatus({ state: 'unreadable' })
      return
    }
    const paused = readable.filter((r) => r.paused)
    setStatus({
      state: 'read',
      pausedChains: paused.map((r) => r.chainId),
      readableCount: readable.length,
      totalCount: reads.length,
    })
  }, [provider, chainId])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  return status
}

/** Records with a proposed tuple awaiting a curator decision. */
function useReviewQueueCount(enabled) {
  const [count, setCount] = useState(null)
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    fetchCatalog()
      .then((result) => {
        if (cancelled) return
        if (result.status === REGISTRY_STATUS.OK) {
          setCount(result.allApps.filter((a) => a.proposed?.present).length)
        } else {
          setCount(null)
        }
      })
      .catch(() => {
        if (!cancelled) setCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return count
}

function tileStatusFor(appId, { pause, feeEstate, gateway, reviewCount }) {
  switch (appId) {
    case 'incident-response': {
      if (pause.state === 'read') {
        const partial = pause.readableCount < pause.totalCount
        if (pause.pausedChains.length > 0) {
          return {
            state: 'read',
            summary: `Paused on ${pause.pausedChains.map(networkName).join(', ')}`,
            tone: 'alert',
          }
        }
        return {
          state: 'read',
          summary: `Active on ${pause.readableCount} network${pause.readableCount === 1 ? '' : 's'}${partial ? ' (some unreadable)' : ''}`,
          tone: partial ? 'warn' : 'ok',
        }
      }
      if (pause.state === 'unreadable') return { state: 'unreadable' }
      return { state: 'none' }
    }
    case 'compliance': {
      if (reviewCount == null) return { state: 'none' }
      return {
        state: 'read',
        summary:
          reviewCount === 0
            ? 'Review queue empty'
            : `${reviewCount} package${reviewCount === 1 ? '' : 's'} awaiting review`,
        tone: reviewCount === 0 ? 'ok' : 'warn',
      }
    }
    case 'membership-revenue': {
      const readable = feeEstate.accrued.filter(isRead)
      if (readable.length === 0) {
        return feeEstate.accrued.length > 0 ? { state: 'unreadable' } : { state: 'none' }
      }
      const partial = readable.length < feeEstate.accrued.length
      return {
        state: 'read',
        summary: `Accrued fees readable on ${readable.length} network${readable.length === 1 ? '' : 's'}${partial ? ' (partial)' : ''}`,
        tone: partial ? 'warn' : 'ok',
      }
    }
    case 'infrastructure': {
      if (!gateway.configured) return { state: 'none' }
      if (!gateway.status) return { state: 'unreadable' }
      if (gateway.status.killSwitch) return { state: 'read', summary: 'Gateway killswitch ON', tone: 'alert' }
      return gateway.status.ok
        ? { state: 'read', summary: 'Gateway healthy', tone: 'ok' }
        : { state: 'read', summary: 'Gateway degraded', tone: 'warn' }
    }
    default:
      return { state: 'none' }
  }
}

function TileStatus({ status }) {
  if (status.state === 'none') return null
  if (status.state === 'read') {
    return <span className={`control-room-tile__status control-room-tile__status--${status.tone}`}>{status.summary}</span>
  }
  return (
    <span className="control-room-tile__status control-room-tile__status--unknown">
      {status.state === 'not-deployed' ? 'Not deployed here' : 'Status could not be read'}
    </span>
  )
}

function ControlRoomBody({ access }) {
  const { flags, estateRead, chainsForRole } = access
  const { account, provider, chainId } = useWeb3()
  const { native: nativeSymbol } = useChainTokens()

  const apps = useMemo(() => buildAdminApps(flags), [flags])
  const complianceEntitled = apps.some((a) => a.id === 'compliance')

  const pause = usePauseStatus()
  const feeEstate = useFeeEstate({ walletChainId: chainId, walletProvider: provider })
  const gateway = useGatewayStatus()
  const reviewCount = useReviewQueueCount(complianceEntitled)

  const statusInputs = { pause, feeEstate, gateway, reviewCount }

  // Every role that can open this area gets a row, each naming where it was
  // found (spec 071 FR-010) — carried over from the monolith's Overview.
  const roleRows = [
    { role: ROLES.ADMIN, held: flags.isAdmin, label: 'Administrator (tier config, treasury, grant admin roles)' },
    { role: ROLES.GUARDIAN, held: flags.isGuardian, label: 'Guardian (pause / unpause WagerRegistry)' },
    { role: ROLES.ACCOUNT_MODERATOR, held: flags.isAccountModerator, label: 'Account Moderator (freeze / unfreeze accounts)' },
    { role: ROLES.ROLE_MANAGER, held: flags.isRoleManager, label: 'Role Manager (grant / revoke memberships)' },
    { role: ROLES.SANCTIONS_ADMIN, held: flags.isSanctionsAdmin, label: 'Compliance Officer (deny-list on SanctionsGuard)' },
    { role: ROLES.FEE_ADMIN, held: flags.isFeeAdmin, label: 'Fee Administrator (platform fee rates on the FeeRouter)' },
    { role: ROLES.STAKING_ADMIN, held: flags.isStakingAdmin, label: 'Staking Administrator (provider addresses + validator allowlist)' },
    { role: ROLES.LIQUIDITY_ADMIN, held: flags.isLiquidityAdmin, label: 'Liquidity Administrator (bridge routes + curated pools, per router)' },
  ]

  return (
    <div className="admin-panel">
      <header className="admin-panel-header">
        <div className="admin-panel-header-content">
          <div className="admin-panel-title-section">
            <h1>Operations</h1>
            <span className="admin-badge">{adminBadgeLabel(flags)}</span>
          </div>
          <p className="admin-panel-subtitle">
            Control Room — each area of the control plane is its own app, and this screen lists
            exactly the ones your on-chain roles unlock.
          </p>
        </div>
        <div className="admin-panel-status">
          <div className="control-room-identity">
            <span className="control-room-identity__label">Connected as</span>
            <span className="control-room-identity__value">
              {shortAddr(account)} ({nativeSymbol})
            </span>
          </div>
        </div>
      </header>

      <nav className="control-room-grid" aria-label="Admin apps">
        {apps.map((app) => (
          <Link
            key={app.id}
            to={`/admin/${app.id}`}
            className={`control-room-tile${app.permissionless ? ' control-room-tile--plain' : ''}`}
          >
            <span className="control-room-tile__icon" aria-hidden="true">
              <NavIcon name={app.icon} size={26} />
            </span>
            <span className="control-room-tile__name">{app.name}</span>
            <span className="control-room-tile__blurb">{app.blurb}</span>
            <TileStatus status={tileStatusFor(app.id, statusInputs)} />
          </Link>
        ))}
      </nav>

      <div className="admin-card control-room-permissions">
        <div className="admin-card-header"><h3>Your Permissions</h3></div>
        <div className="permissions-list">
          {roleRows.map(({ role, label, held }) => {
            const on = chainsForRole?.(role) ?? []
            return (
              <div key={role} className={`permission-item ${held ? 'enabled' : 'disabled'}`}>
                <span className="permission-icon">{held ? '✓' : '×'}</span>
                <span className="permission-name">
                  {label}
                  {held && on.length > 0 && (
                    <span className="permission-networks"> — {on.map(networkName).join(', ')}</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        <p className="card-info">
          Read across {estateRead?.read?.length ?? 0} network
          {(estateRead?.read?.length ?? 0) === 1 ? '' : 's'}.
          {estateRead?.notDeployed?.length > 0 && (
            <>
              {' '}
              {`${estateRead.notDeployed.map(networkName).join(', ')} ${
                estateRead.notDeployed.length === 1 ? 'carries' : 'carry'
              } no operator contracts, so there is nothing to hold a role on there.`}
            </>
          )}
          {estateRead?.unreadable?.length > 0 && (
            <> {estateRead.unreadable.map(networkName).join(', ')} could not be read, so nothing
            above rules out a role held there.</>
          )}{' '}
          Roles are per-contract and per-network, so each app re-checks the specific contract for
          the network you select — what it offers there is the authoritative answer.
        </p>
      </div>
    </div>
  )
}

export default function ControlRoom() {
  const access = useAdminAccess()
  return (
    <AdminAccessGate access={access}>
      <ControlRoomBody access={access} />
    </AdminAccessGate>
  )
}
