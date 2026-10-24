/**
 * Liquidity admin mini-app (spec 093) — re-hosts BridgeTab and SupplyTab
 * (spec 067) unchanged. Routes, curated pools, limits and pauses that move
 * member money; LIQUIDITY_ADMIN configures, GUARDIAN pauses, ADMIN enters.
 *
 * The dashboard reads both routers' deployment + pause state per cohort
 * chain, three-state — a paused router is named; an unreachable chain is
 * reported as unreachable, never as running. Pause semantics stay spec 067's:
 * a pause stops NEW bridges/supplies only and never traps value, and the
 * Supply pause is "new Uniswap supplies" only, never "pooling".
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AdminAppShell from '../AdminAppShell'
import BridgeTab from '../BridgeTab'
import SupplyTab from '../SupplyTab'
import AdminStatTile from '../charts/AdminStatTile'
import { adminAppById, adminViewPath } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useWeb3 } from '../../../hooks/useWeb3'
import { getContractAddressForChain } from '../../../config/contracts'
import { getProvider } from '../../../utils/blockchainService'
import { readContract } from '../../../lib/chains/readContract'
import { networkName, readProviderFor, estateNetworks } from '../../../lib/chains/estate'
import { readOk, notDeployed, unreadable, isRead } from '../../../lib/chains/chainReadResult'

const APP = adminAppById('liquidity')

const PAUSED_ABI = ['function paused() view returns (bool)']

const ROUTERS = [
  { key: 'bridgeRouter', label: 'BridgeRouter', pausedMeans: 'new bridges paused' },
  { key: 'liquidityRouter', label: 'LiquidityRouter', pausedMeans: 'new Uniswap supplies paused' },
]

function useRouterEstate() {
  const { provider, chainId } = useWeb3()
  const [results, setResults] = useState({ bridgeRouter: [], liquidityRouter: [] })

  const refresh = useCallback(async () => {
    const next = {}
    for (const router of ROUTERS) {
      next[router.key] = await Promise.all(
        estateNetworks().map(async (n) => {
          const addr = getContractAddressForChain(router.key, n.chainId)
          if (!addr) return notDeployed(n.chainId)
          try {
            // `readProviderFor` is the AVAILABILITY GATE and its null is a refusal, not a gap to
            // route around. The `|| getProvider(n.chainId)` this replaced hand-built a provider
            // from `NETWORKS[chainId].rpcUrl`, which spec 069 forbids: it ignores the member's
            // configured endpoint and its failover, and `getProvider` resolves through
            // `getNetwork`, which FALLS BACK to the default network for a chain it does not know —
            // so an unroutable chain could report the DEFAULT chain's pause state as its own, on a
            // dashboard whose entire job is saying which chains are paused.
            if (!readProviderFor(n.chainId, chainId, provider)) {
              return unreadable(n.chainId, `no read connection to ${n.name}`)
            }
            const paused = await readContract(n.chainId, {
              address: addr,
              abi: PAUSED_ABI,
              functionName: 'paused',
            })
            return readOk(n.chainId, Boolean(paused), null, Date.now())
          } catch (err) {
            return unreadable(n.chainId, err?.message)
          }
        }),
      )
    }
    setResults(next)
  }, [provider, chainId])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { results, refresh }
}

function LiquidityDashboard({ estate }) {
  return (
    <div className="overview-grid">
      {ROUTERS.map((router) => {
        const rows = estate.results[router.key] ?? []
        const deployedAnywhere = rows.some((r) => !r || r.status !== 'not-deployed')
        return (
          <div className="admin-card full-width" key={router.key}>
            <div className="admin-card-header">
              <h3>{router.label} across the estate</h3>
              <button type="button" className="confirm-btn" onClick={estate.refresh}>
                Refresh
              </button>
            </div>
            {rows.length === 0 ? (
              <p className="card-info" role="status">Reading…</p>
            ) : (
              <div className="admin-stat-tiles" role="group" aria-label={`${router.label} state per network`}>
                {rows.map((r) => (
                  <AdminStatTile
                    key={r.chainId}
                    label={networkName(r.chainId)}
                    result={r}
                    display={isRead(r) ? (r.value ? router.pausedMeans : 'Live') : undefined}
                    tone={isRead(r) ? (r.value ? 'alert' : 'accent') : undefined}
                  />
                ))}
              </div>
            )}
            {!deployedAnywhere && rows.length > 0 && (
              <p className="card-info">
                Not deployed on any cohort network yet — the views below stay honest about that
                per network.
              </p>
            )}
            <p className="card-info">
              A pause stops NEW {router.key === 'bridgeRouter' ? 'bridges' : 'Uniswap supplies'}{' '}
              only: in-flight bridges settle or refund via Across, and positions stay withdrawable
              because exits never routed through the router.
            </p>
          </div>
        )
      })}
    </div>
  )
}

export default function LiquidityApp() {
  const access = useAdminAccess()
  const { flags } = access
  const navigate = useNavigate()
  const { account, signer, provider, chainId } = useWeb3()
  const estate = useRouterEstate()
  const { runTx, pendingTx } = useAdminTx({ onSuccess: estate.refresh })

  // The Bridge/Supply fee cards link across to where a rate is actually
  // editable — but only for an operator who can open that view (same rule the
  // monolith applied): offering the link to someone the Fees view is closed
  // to would send them to a blank panel.
  const canOpenFees = flags.isAdmin || flags.isFeeAdmin
  const onOpenFees = canOpenFees ? () => navigate(adminViewPath('fees')) : null

  const renderView = (viewId) => {
    if (viewId === 'bridge') {
      return (
        <BridgeTab
          signer={signer}
          account={account}
          chainId={chainId}
          provider={provider || getProvider(chainId)}
          runTx={runTx}
          pendingTx={pendingTx}
          onOpenFees={onOpenFees}
        />
      )
    }
    if (viewId === 'supply') {
      return (
        <SupplyTab
          signer={signer}
          account={account}
          chainId={chainId}
          provider={provider || getProvider(chainId)}
          runTx={runTx}
          pendingTx={pendingTx}
          onOpenFees={onOpenFees}
        />
      )
    }
    return null
  }

  return <AdminAppShell app={APP} access={access} dashboard={<LiquidityDashboard estate={estate} />} renderView={renderView} />
}
