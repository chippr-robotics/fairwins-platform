import { useState } from 'react'
import { TIER_NAMES } from '../../hooks/useRoleDetails'
import { ACCOUNT_MODERATION_PATH } from '../../constants/legalLinks'
import './RoleDetailsCard.css'

const ROLE_DISPLAY_NAMES = {
  WAGER_PARTICIPANT: 'Wager Participant'
}

const ROLE_DESCRIPTIONS = {
  WAGER_PARTICIPANT: 'Create and accept peer-to-peer wagers in USDC or WPOL'
}

function formatDate(date) {
  if (!date) return 'N/A'
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

/**
 * RoleDetailsCard — Displays detailed information about a user's role.
 *
 * Also surfaces a "frozen" state when an `ACCOUNT_MODERATOR_ROLE` holder has
 * frozen this account on WagerRegistry. The card receives `isFrozen` and
 * `freezeReason` from the wallet page; we don't fetch them here.
 */
export function RoleDetailsCard({ role, onUpgrade, onExtend, compact = false, isFrozen = false, freezeReason = '' }) {
  const [isExpanded, setIsExpanded] = useState(false)

  if (!role) return null

  const {
    roleName,
    tier,
    tierName,
    tierColor,
    isExpired,
    daysRemaining,
    expirationDate,
    wagersCreated,
    wagerLimit,
    canCreateWager,
    activeWagers = 0,
    concurrentLimit = 0,
  } = role

  const displayName = ROLE_DISPLAY_NAMES[roleName] || roleName
  const description = ROLE_DESCRIPTIONS[roleName] || ''

  const isMonthlyLimit = wagerLimit > 0 && wagersCreated >= wagerLimit
  const isConcurrentLimit = concurrentLimit > 0 && activeWagers >= concurrentLimit
  const isAtLimit = (wagerLimit > 0 || concurrentLimit > 0) && !canCreateWager
  const isExpiringSoon = daysRemaining !== null && daysRemaining <= 7 && daysRemaining > 0
  const needsAttention = isFrozen || isExpired || isAtLimit || isExpiringSoon

  if (compact) {
    return (
      <div
        className={`role-card-compact ${needsAttention ? 'needs-attention' : ''} ${isFrozen ? 'frozen' : ''}`}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="role-card-header">
          <div className="role-tier-badge" style={{ backgroundColor: tierColor }}>
            {tierName}
          </div>
          <span className="role-name">{displayName}</span>
          {isFrozen && <span className="role-status frozen">Frozen</span>}
          {isExpired && !isFrozen && <span className="role-status expired">Expired</span>}
          {isAtLimit && !isExpired && !isFrozen && <span className="role-status at-limit">At Limit</span>}
          {isExpiringSoon && !isExpired && !isAtLimit && !isFrozen && (
            <span className="role-status expiring-soon">{daysRemaining}d left</span>
          )}
          <span className={`expand-icon ${isExpanded ? 'expanded' : ''}`}>&#9660;</span>
        </div>

        {isExpanded && (
          <div className="role-card-details">
            {expirationDate && (
              <div className="detail-row">
                <span className="detail-label">Expires:</span>
                <span className={`detail-value ${isExpired ? 'expired' : ''}`}>
                  {formatDate(expirationDate)}
                  {daysRemaining !== null && daysRemaining > 0 && ` (${daysRemaining} days)`}
                </span>
              </div>
            )}
            {wagerLimit > 0 && (
              <div className="detail-row">
                <span className="detail-label">Wagers:</span>
                <span className={`detail-value ${isMonthlyLimit ? 'at-limit' : ''}`}>
                  {wagersCreated} / {wagerLimit} this month
                </span>
              </div>
            )}
            {concurrentLimit > 0 && (
              <div className="detail-row">
                <span className="detail-label">Active:</span>
                <span className={`detail-value ${isConcurrentLimit ? 'at-limit' : ''}`}>
                  {activeWagers} / {concurrentLimit} concurrent
                </span>
              </div>
            )}
            <div className="role-card-actions">
              {tier < 4 && onUpgrade && !isFrozen && (
                <button
                  className="role-action-btn upgrade"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpgrade(roleName)
                  }}
                >
                  Upgrade
                </button>
              )}
              {(isExpiringSoon || isExpired) && onExtend && !isFrozen && (
                <button
                  className="role-action-btn extend"
                  onClick={(e) => {
                    e.stopPropagation()
                    onExtend(roleName)
                  }}
                >
                  {isExpired ? 'Renew' : 'Extend'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`role-card ${needsAttention ? 'needs-attention' : ''} ${isFrozen ? 'frozen' : ''}`}>
      <div className="role-card-header">
        <div className="role-tier-badge" style={{ backgroundColor: tierColor }}>
          {tierName}
        </div>
        <div className="role-info">
          <h4 className="role-name">{displayName}</h4>
          <p className="role-description">{description}</p>
        </div>
      </div>

      <div className="role-card-body">
        {isFrozen && (
          <div className="role-alert frozen">
            <strong>This account is currently frozen by a platform moderator.</strong>
            <div>You cannot create or accept wagers, or claim payouts or refunds, until unfrozen.</div>
            {freezeReason && <div>Reason: {freezeReason}</div>}
            <a href={ACCOUNT_MODERATION_PATH} target="_blank" rel="noopener noreferrer">
              Account moderation policy
            </a>
          </div>
        )}
        {expirationDate && (
          <div className="role-stat">
            <span className="stat-label">Expires</span>
            <span className={`stat-value ${isExpired ? 'expired' : isExpiringSoon ? 'warning' : ''}`}>
              {isExpired ? 'Expired' : formatDate(expirationDate)}
            </span>
            {!isExpired && daysRemaining !== null && (
              <span className={`stat-sublabel ${isExpiringSoon ? 'warning' : ''}`}>
                {daysRemaining} days remaining
              </span>
            )}
          </div>
        )}

        {wagerLimit > 0 && (
          <div className="role-stat">
            <span className="stat-label">Wagers This Month</span>
            <div className="usage-bar-container">
              <div
                className={`usage-bar ${isMonthlyLimit ? 'at-limit' : ''}`}
                style={{ width: `${Math.min(100, (wagersCreated / wagerLimit) * 100)}%` }}
              />
            </div>
            <span className={`stat-value ${isMonthlyLimit ? 'at-limit' : ''}`}>
              {wagersCreated} / {wagerLimit}
            </span>
          </div>
        )}

        {concurrentLimit > 0 && (
          <div className="role-stat">
            <span className="stat-label">Active Wagers</span>
            <div className="usage-bar-container">
              <div
                className={`usage-bar ${isConcurrentLimit ? 'at-limit' : ''}`}
                style={{ width: `${Math.min(100, (activeWagers / concurrentLimit) * 100)}%` }}
              />
            </div>
            <span className={`stat-value ${isConcurrentLimit ? 'at-limit' : ''}`}>
              {activeWagers} / {concurrentLimit}
            </span>
          </div>
        )}

        {isExpired && !isFrozen && (
          <div className="role-alert expired">
            Your {displayName} access has expired. Renew to continue creating wagers.
          </div>
        )}
        {isConcurrentLimit && !isMonthlyLimit && !isExpired && !isFrozen && (
          <div className="role-alert at-limit">
            Concurrent wager limit reached. Close or refund expired wagers to free up slots, or upgrade your tier.
          </div>
        )}
        {isMonthlyLimit && !isExpired && !isFrozen && (
          <div className="role-alert at-limit">
            Monthly wager limit reached. Upgrade your tier for higher limits.
          </div>
        )}
        {isExpiringSoon && !isExpired && !isAtLimit && !isFrozen && (
          <div className="role-alert expiring-soon">
            Your access expires in {daysRemaining} days. Extend now to avoid interruption.
          </div>
        )}
      </div>

      <div className="role-card-actions">
        {tier < 4 && onUpgrade && !isFrozen && (
          <button
            className="role-action-btn upgrade"
            onClick={() => onUpgrade(roleName)}
          >
            Upgrade to {TIER_NAMES[tier + 1]}
          </button>
        )}
        {(isExpiringSoon || isExpired) && onExtend && !isFrozen && (
          <button
            className="role-action-btn extend"
            onClick={() => onExtend(roleName)}
          >
            {isExpired ? 'Renew Access' : 'Extend Membership'}
          </button>
        )}
      </div>
    </div>
  )
}

export function RoleDetailsSection({
  roleDetails,
  loading,
  onUpgrade,
  onExtend,
  onPurchase,
  onRefresh,
  isFrozen = false,
  freezeReason = '',
}) {
  const activeRoles = Object.values(roleDetails || {}).filter(r => r.hasRole)
  const hasNoRoles = activeRoles.length === 0

  if (loading) {
    return (
      <div className="roles-loading">
        <span className="loading-spinner" />
        Loading roles...
      </div>
    )
  }

  if (hasNoRoles) {
    return (
      <div className="roles-empty">
        <p>No active membership</p>
        <button className="purchase-roles-btn" onClick={onPurchase}>
          Get Wager Access
        </button>
      </div>
    )
  }

  return (
    <div className="role-details-section">
      <div className="roles-header">
        <span className="section-title">Your Membership</span>
        {onRefresh && (
          <button
            className="refresh-btn"
            onClick={onRefresh}
            title="Refresh from blockchain"
          >
            &#8635;
          </button>
        )}
      </div>
      <div className="roles-list">
        {activeRoles.map((role) => (
          <RoleDetailsCard
            key={role.roleName}
            role={role}
            onUpgrade={onUpgrade}
            onExtend={onExtend}
            isFrozen={isFrozen}
            freezeReason={freezeReason}
            compact
          />
        ))}
      </div>
    </div>
  )
}

export default RoleDetailsCard
