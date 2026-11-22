/**
 * Infrastructure admin mini-app (spec 093) — the monolithic AdminPanel's
 * `services` view, extracted verbatim: gateway health telemetry
 * (ServiceHealthCard), paymaster operations (PaymasterOpsCard), and the
 * runbook-operated off-chain controls disclosure.
 *
 * The dashboard renders the relay gateway's per-chain status as tiles — the
 * gateway is read-only telemetry with no web admin API by design (it can
 * censor, never steal), so the dashboard states, it does not control.
 */
import AdminAppShell from '../AdminAppShell'
import ServiceHealthCard from '../ServiceHealthCard'
import PaymasterOpsCard from '../PaymasterOpsCard'
import AdminStatTile from '../charts/AdminStatTile'
import { adminAppById } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useAdminWeb3 } from '../adminActing/useAdminWeb3'
import { useChainTokens } from '../../../hooks/useChainTokens'
import { useGatewayStatus } from '../../../hooks/useGatewayStatus'
import { getProvider } from '../../../utils/blockchainService'
import { networkName } from '../../../lib/chains/estate'

const APP = adminAppById('infrastructure')

function InfrastructureDashboard() {
  const gateway = useGatewayStatus()

  return (
    <div className="overview-grid">
      <div className="admin-card full-width">
        <div className="admin-card-header"><h3>Relay gateway</h3></div>
        {!gateway.configured ? (
          <p className="card-info" role="status">
            No relay gateway is configured for this build — gasless rails are optional
            infrastructure, and every flow keeps a self-submit fallback.
          </p>
        ) : !gateway.status ? (
          <p className="card-info" role="status">
            The gateway status endpoint could not be read — that is a telemetry outage, not
            proof the gateway is down.
          </p>
        ) : (
          <>
            <div className="admin-stat-tiles" role="group" aria-label="Gateway status summary">
              <AdminStatTile
                label="Gateway"
                value={gateway.status.ok ? 'Healthy' : 'Degraded'}
                tone={gateway.status.ok ? 'accent' : 'alert'}
              />
              <AdminStatTile
                label="Killswitch"
                value={gateway.status.killSwitch ? 'ENGAGED' : 'Off'}
                tone={gateway.status.killSwitch ? 'alert' : undefined}
              />
              {gateway.status.chains.map((c) => (
                <AdminStatTile
                  key={c.chainId}
                  label={`${networkName(c.chainId)} RPC`}
                  value={c.rpc === 'up' ? 'Up' : 'Down'}
                  tone={c.rpc === 'up' ? undefined : 'alert'}
                />
              ))}
            </div>
            {gateway.status.hasOperatorTelemetry && (
              <>
                <h4 className="admin-dashboard-subhead">Runway (operator telemetry)</h4>
                <div className="admin-stat-tiles" role="group" aria-label="Gas and paymaster runway per chain">
                  {gateway.status.chains
                    .filter((c) => c.gasWalletRunwayHrs != null || c.paymasterDepositRunwayHrs != null)
                    .map((c) => (
                      <AdminStatTile
                        key={c.chainId}
                        label={`${networkName(c.chainId)} runway`}
                        value={[
                          c.gasWalletRunwayHrs != null ? `gas ${Math.round(c.gasWalletRunwayHrs)}h` : null,
                          c.paymasterDepositRunwayHrs != null ? `paymaster ${Math.round(c.paymasterDepositRunwayHrs)}h` : null,
                        ].filter(Boolean).join(' · ')}
                      />
                    ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <ServiceHealthCard />
    </div>
  )
}

export default function InfrastructureApp() {
  const access = useAdminAccess()
  const { account, signer, provider, chainId } = useAdminWeb3()
  const { native: nativeSymbol } = useChainTokens()
  const { runTx, pendingTx } = useAdminTx()

  const renderView = (viewId) => {
    if (viewId !== 'services') return null
    return (
      <div className="admin-tab-content" role="tabpanel">
        <div className="overview-grid">
          <ServiceHealthCard />
          <PaymasterOpsCard
            signer={signer}
            account={account}
            provider={provider || getProvider(chainId)}
            chainId={chainId}
            nativeSymbol={nativeSymbol}
            runTx={runTx}
            pendingTx={pendingTx}
          />
        </div>
        <div className="admin-card">
          <h3>Off-chain Controls (runbook-operated)</h3>
          <p>
            The relay gateway deliberately has no web admin API — it can censor, never steal,
            and its worst failure mode is refusing gas. These controls are operated via
            deploy config and signals, documented in the runbooks:
          </p>
          <ul>
            <li><strong>Gateway killswitch</strong> — <code>KILL_SWITCH</code> env or <code>SIGUSR2</code>; halts relaying, sponsorship, and the OpenSea/Polymarket proxies (docs/runbooks/relayer-operations.md).</li>
            <li><strong>Relayer per-chain pause / gas caps / receiver allowlist</strong> — <code>services/oz-relayer/config/config.json</code>.</li>
            <li><strong>Quotas, spend caps, paymaster ceilings</strong> — gateway env (<code>SIGNER_QUOTA_PER_MIN</code>, <code>GAS_SPEND_CAP_WEI_*</code>, <code>PM_*</code>).</li>
            <li><strong>Polymarket builder fee</strong> — gateway env, hard-capped at boot; changes rate-limited by Polymarket (docs/developer-guide/predict-polymarket.md).</li>
          </ul>
        </div>
      </div>
    )
  }

  return <AdminAppShell app={APP} access={access} dashboard={<InfrastructureDashboard />} renderView={renderView} />
}
