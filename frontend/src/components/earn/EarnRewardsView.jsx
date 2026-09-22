/**
 * EarnRewardsView (spec 050, US2) — bonus reward tokens the member's lending
 * has earned (Merkl program), across every earn-enabled network at once
 * (network-transparent, like the portfolio). Rewards are grouped per network
 * with the shared badge artwork; each group claims in one action, and the
 * app switches to that network automatically as part of the confirmation —
 * the member never manages networks by hand.
 *
 * Honest states: an unreachable rewards service is an explicit "temporarily
 * unavailable" (never a fabricated zero); a partially unreachable one names
 * the networks that couldn't be checked; figures carry their refresh cadence
 * ("updates every few hours"); a claim button never prompts the wallet when
 * nothing is claimable. Claim success is reported from the tx outcome.
 */
import { useMemo } from 'react'
import { formatUnits } from '../../lib/evm/units'
import { useEarnRewards } from '../../hooks/useEarnRewards'
import { NETWORKS } from '../../config/networks'
import InfoTip from '../ui/InfoTip'
import AssetLogo from '../wallet/AssetLogo'
import SensitiveValue from '../common/SensitiveValue'
import { EARN_TIPS } from '../../lib/earn/earnCopy'

function fmtToken(amountBig, token) {
  const value = Number(formatUnits(amountBig, token.decimals))
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${token.symbol}`
}

export default function EarnRewardsView() {
  const {
    rewards,
    failedNetworks,
    status,
    fetchedAt,
    claim,
    claimState,
    canTransactOn,
    cannotTransactReason,
    legacyRewardsUrl,
    refresh,
  } = useEarnRewards()

  // Group rewards per network so each group can claim on its own chain.
  const groups = useMemo(() => {
    const byChain = new Map()
    for (const reward of rewards) {
      const list = byChain.get(reward.chainId) || []
      list.push(reward)
      byChain.set(reward.chainId, list)
    }
    return [...byChain.entries()].map(([chainId, list]) => ({
      chainId,
      network: NETWORKS[chainId]?.name || String(chainId),
      rewards: list,
      claimableCount: list.filter((r) => r.claimable > 0n).length,
    }))
  }, [rewards])

  return (
    <div className="earn-rewards" data-attention="earn-rewards">
      <div className="earn-lend-header">
        <h3>
          Rewards
          <InfoTip label="About rewards" className="earn-info">
            {EARN_TIPS.rewards}
          </InfoTip>
        </h3>
        {fetchedAt && (
          <span className="earn-freshness">
            Updates every few hours
            <InfoTip label="Why not real-time?" className="earn-info">
              {EARN_TIPS.rewardsFreshness}
            </InfoTip>
          </span>
        )}
      </div>

      {status === 'loading' && <p className="earn-state">Checking your rewards…</p>}

      {status === 'unavailable' && (
        <div className="earn-unavailable" role="alert">
          <p>
            Reward information is temporarily unavailable. Any rewards you have earned are safe —
            check back shortly.
          </p>
          <button type="button" className="earn-btn secondary" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {status === 'ready' && failedNetworks.length > 0 && (
        <p className="earn-state" role="note">
          Couldn&rsquo;t check {failedNetworks.join(' and ')} right now — rewards there are safe
          and will show once the service responds.
        </p>
      )}

      {status === 'ready' && rewards.length === 0 && (
        <p className="earn-state">
          Nothing to claim yet. Rewards build up over time while you have money lent out in a vault
          that runs a reward program — they will appear here.
        </p>
      )}

      {status === 'ready' &&
        groups.map((group) => {
          const groupClaimState = claimState.chainId === group.chainId ? claimState : null
          const transactable = canTransactOn(group.chainId)
          return (
            <section key={group.chainId} className="earn-rewards-group" aria-label={`Rewards on ${group.network}`}>
              <h4 className="earn-rewards-network">On {group.network}</h4>
              <ul className="earn-rewards-list">
                {group.rewards.map((reward) => (
                  <li key={`${group.chainId}:${reward.token.address}`} className="earn-reward-row">
                    <AssetLogo symbol={reward.token.symbol} chainId={group.chainId} showBadge size={28} />
                    <span className="earn-reward-token">{reward.token.symbol}</span>
                    <span className="earn-reward-values">
                      <SensitiveValue className="earn-reward-claimable">
                        {reward.claimable > 0n
                          ? `${fmtToken(reward.claimable, reward.token)} ready to claim`
                          : 'Nothing ready yet'}
                      </SensitiveValue>
                      {reward.pending > 0n && (
                        <SensitiveValue className="earn-reward-pending">
                          {`${fmtToken(reward.pending, reward.token)} building up`}
                        </SensitiveValue>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {groupClaimState?.status === 'confirmed' ? (
                <div className="earn-tx-done" role="status">
                  <p>Rewards claimed — they are in your wallet.</p>
                  {groupClaimState.txUrl && (
                    <a href={groupClaimState.txUrl} target="_blank" rel="noopener noreferrer">
                      View transaction ↗
                    </a>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="earn-btn primary"
                  onClick={() => claim(group.chainId)}
                  disabled={
                    group.claimableCount === 0 || groupClaimState?.status === 'pending' || !transactable
                  }
                  title={
                    !transactable
                      ? cannotTransactReason(group.chainId)
                      : group.claimableCount === 0
                        ? 'Nothing is ready to claim yet'
                        : undefined
                  }
                >
                  {groupClaimState?.status === 'pending'
                    ? 'Waiting for confirmation…'
                    : `Claim on ${group.network}`}
                </button>
              )}
              {!transactable && (
                <p className="earn-state" role="note">
                  {cannotTransactReason(group.chainId)}
                </p>
              )}
              {groupClaimState?.status === 'error' && (
                <p className="earn-input-error" role="alert">
                  {groupClaimState.error}
                </p>
              )}
            </section>
          )
        })}

      {legacyRewardsUrl && (
        <p className="earn-legacy-note">
          Lent through Morpho before mid-2025?{' '}
          <a href={legacyRewardsUrl} target="_blank" rel="noopener noreferrer">
            Check Morpho&rsquo;s legacy rewards page ↗
          </a>
        </p>
      )}
    </div>
  )
}
