/**
 * EarnPositionsList (spec 050, FR-005) — the member's active lending
 * positions on the active network: current value (on-chain truth) with USD
 * value and earned-so-far shown only when the data service can price them
 * ("—" otherwise — honest degradation, never a fabricated number).
 */
import { formatUnits } from '../../lib/evm/units'
import InfoTip from '../ui/InfoTip'
import AssetLogo from '../wallet/AssetLogo'
import SensitiveValue from '../common/SensitiveValue'
import { NETWORKS } from '../../config/networks'
import { EARN_TIPS } from '../../lib/earn/earnCopy'

function formatUsd(n) {
  if (n == null) return null
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatAssets(position) {
  const value = Number(formatUnits(position.assets, position.vault.asset.decimals))
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${position.vault.asset.symbol}`
}

export default function EarnPositionsList({ positions, status, onSelect }) {
  if (status !== 'ready' || !positions?.length) return null
  return (
    <div className="earn-positions">
      <h3>
        Your positions
        <InfoTip label="About your positions" className="earn-info">
          {EARN_TIPS.positions}
        </InfoTip>
      </h3>
      <ul className="earn-positions-list">
        {positions.map((position) => (
          <li key={`${position.vault.chainId}:${position.vault.address}`}>
            <button
              type="button"
              className="earn-position-row"
              onClick={() => onSelect?.(position)}
            >
              <AssetLogo
                symbol={position.vault.asset.symbol}
                chainId={position.vault.chainId}
                showBadge
                size={28}
              />
              <span className="earn-position-name">
                {position.vault.name}
                <span className="earn-position-network">
                  on {NETWORKS[position.vault.chainId]?.name || 'unknown network'}
                </span>
              </span>
              <span className="earn-position-values">
                <SensitiveValue className="earn-position-assets">
                  {formatAssets(position)}
                </SensitiveValue>
                {formatUsd(position.assetsUsd) ? (
                  <SensitiveValue className="earn-position-usd">
                    {formatUsd(position.assetsUsd)}
                  </SensitiveValue>
                ) : (
                  <span className="earn-position-usd" aria-label="USD value unavailable">
                    —
                  </span>
                )}
                {position.pnlUsd != null && (
                  <SensitiveValue className={`earn-position-pnl ${position.pnlUsd >= 0 ? 'up' : 'down'}`}>
                    {`${position.pnlUsd >= 0 ? '+' : ''}${formatUsd(position.pnlUsd)} so far`}
                  </SensitiveValue>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
