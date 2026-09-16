/**
 * StakingPositionsList (spec 065, US1 + US2) — the member's active staking
 * positions. Shows staked amount + (US2) unbonding/ready status. Selecting a
 * position opens its StakeSheet. On-chain amounts; USD degrades to "—".
 */
import { formatUnits } from '../../lib/evm/units'
import { NETWORKS } from '../../config/networks'
import AssetLogo from '../wallet/AssetLogo'

function fmt(raw, decimals, symbol) {
  if (raw == null) return '—'
  const value = Number(formatUnits(raw, decimals))
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${symbol}`
}

export default function StakingPositionsList({ positions, status, onSelect }) {
  if (status === 'loading') return <p className="earn-state">Loading your staking…</p>
  if (!positions || positions.length === 0) return null

  return (
    <div className="earn-positions">
      <h3>Your staking</h3>
      <ul className="earn-vault-list">
        {positions.map((position) => {
          const { option } = position
          const label = option.model === 'delegated' ? option.validatorName : option.provider.name
          return (
            <li key={option.id}>
              <button type="button" className="earn-vault-row" onClick={() => onSelect(position)}>
                <AssetLogo symbol={option.asset.symbol} chainId={option.chainId} showBadge size={32} />
                <span className="earn-vault-main">
                  <span className="earn-vault-name">{label}</span>
                  <span className="earn-vault-asset">
                    {option.model === 'delegated' ? 'Delegated' : 'Liquid'} · {option.asset.symbol} · on{' '}
                    {NETWORKS[option.chainId]?.name || 'unknown network'}
                  </span>
                  {position.hasReadyWithdrawal && (
                    <span className="staking-ready-flag">Ready to withdraw</span>
                  )}
                  {!position.hasReadyWithdrawal && position.pendingUnbonds.length > 0 && (
                    <span className="staking-unbonding-flag">Unbonding…</span>
                  )}
                </span>
                <span className="earn-vault-numbers">
                  <span className="earn-vault-apy">
                    {fmt(position.stakedRaw, option.asset.decimals, option.asset.symbol)}
                  </span>
                  {position.rewardsClaimableRaw != null && position.rewardsClaimableRaw > 0n && (
                    <span className="earn-vault-tvl">
                      +{fmt(position.rewardsClaimableRaw, option.asset.decimals, option.asset.symbol)} rewards
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
