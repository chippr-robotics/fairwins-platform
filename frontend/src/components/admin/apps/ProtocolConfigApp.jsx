/**
 * Protocol Config admin mini-app (spec 093) — re-hosts StakingTab (spec 066),
 * ProtocolConfigTab (registry wiring & tokens) and OracleAdaptersTab
 * unchanged.
 *
 * The dashboard shows the estate's deployment matrix for the protocol
 * contracts these views configure. Deployment comes from the address book
 * (config — exact, no hedging); it is presence, not health: each view still
 * reads the specific contract for the network it acts on.
 */
import AdminAppShell from '../AdminAppShell'
import StakingTab from '../StakingTab'
import ProtocolConfigTab from '../ProtocolConfigTab'
import OracleAdaptersTab from '../OracleAdaptersTab'
import AdminBarList from '../charts/AdminBarList'
import { adminAppById } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useAdminWeb3 } from '../adminActing/useAdminWeb3'
import { DEPLOYED_CONTRACTS, NETWORK_CONFIG, getContractAddressForChain } from '../../../config/contracts'
import { getProvider } from '../../../utils/blockchainService'
import { networkName, estateNetworks } from '../../../lib/chains/estate'

const APP = adminAppById('protocol-config')

const PROTOCOL_CONTRACTS = [
  { key: 'wagerRegistry', label: 'WagerRegistry' },
  { key: 'membershipManager', label: 'MembershipManager' },
  { key: 'stakingRouter', label: 'StakingRouter' },
  { key: 'feeRouter', label: 'FeeRouter' },
  { key: 'sanctionsGuard', label: 'SanctionsGuard' },
  { key: 'polymarketAdapter', label: 'Polymarket adapter' },
]

function shortAddr(address) {
  return address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : ''
}

function ProtocolDashboard() {
  const networks = estateNetworks()
  const coverage = PROTOCOL_CONTRACTS.map((c) => {
    const count = networks.filter((n) => Boolean(getContractAddressForChain(c.key, n.chainId))).length
    return { label: c.label, value: count, display: `${count} / ${networks.length} networks` }
  })

  return (
    <div className="overview-grid">
      <div className="admin-card full-width">
        <div className="admin-card-header"><h3>Deployment coverage across the estate</h3></div>
        <AdminBarList
          ariaLabel="Protocol contract deployment coverage across cohort networks"
          items={coverage}
        />
        <p className="card-info">
          Coverage is the recorded address book ({networks.map((n) => networkName(n.chainId)).join(', ')}) —
          presence, not health. Each view reads the specific contract for the network you select.
        </p>
      </div>

      <div className="admin-card full-width">
        <div className="admin-card-header"><h3>Contract Addresses ({NETWORK_CONFIG.name})</h3></div>
        <div className="contract-addresses">
          {Object.entries(DEPLOYED_CONTRACTS).filter(([, v]) => v).map(([name, address]) => (
            <div key={name} className="contract-row">
              <span className="contract-name">{name}</span>
              <code className="contract-address" title={address}>{shortAddr(address)}</code>
              <a href={`${NETWORK_CONFIG.blockExplorer}/address/${address}`}
                target="_blank" rel="noopener noreferrer" className="contract-link">↗</a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function ProtocolConfigApp() {
  const access = useAdminAccess()
  const { flags } = access
  const { account, signer, provider, chainId } = useAdminWeb3()
  const { runTx, pendingTx } = useAdminTx()

  const renderView = (viewId) => {
    if (viewId === 'staking') {
      return (
        <StakingTab
          signer={signer}
          account={account}
          chainId={chainId}
          provider={provider || getProvider(chainId)}
          runTx={runTx}
          pendingTx={pendingTx}
          isAdmin={flags.isAdmin}
          isStakingAdmin={flags.isStakingAdmin}
          isGuardian={flags.isGuardian}
        />
      )
    }
    if (viewId === 'protocol-config') {
      return (
        <ProtocolConfigTab
          signer={signer}
          chainId={chainId}
          provider={provider || getProvider(chainId)}
          runTx={runTx}
          pendingTx={pendingTx}
        />
      )
    }
    if (viewId === 'oracle-adapters') {
      return (
        <OracleAdaptersTab
          signer={signer}
          account={account}
          contracts={DEPLOYED_CONTRACTS}
          chainId={chainId}
          runTx={runTx}
          pendingTx={pendingTx}
        />
      )
    }
    return null
  }

  return <AdminAppShell app={APP} access={access} dashboard={<ProtocolDashboard />} renderView={renderView} />
}
