import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AssetLogo from './AssetLogo'
import { NETWORKS } from '../../config/networks'
import { priceSourceLabel } from '../../lib/portfolio/prices'
import { isHomeInstance, instanceFormLabel, formatAssetAmount } from '../../lib/portfolio/aggregate'
import SensitiveValue from '../common/SensitiveValue'
import TokenNewsCard from '../news/TokenNewsCard'
import { isFeatureEnabled } from '../../config/tenant'
import './AssetDetailSheet.css'

// Member-facing names for the classification provenance (FR-006).
const SOURCE_LABELS = {
  'sec-baseline': 'SEC baseline',
  'curated-registry': 'Curated registry',
  'app-config': 'App configuration',
}

function formatUsdFull(n) {
  return `$${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatAmount(holding) {
  return formatAssetAmount(holding.balance, holding.asset.symbol, holding.asset.kind)
}

/**
 * Bitcoin instance disclosures (spec 061, FR-009/FR-018): pending value is
 * never presented as final, and Stamps-protected value explains why
 * total ≠ spendable. Only rendered for holdings carrying `holding.bitcoin`
 * (native BTC from the bitcoin balance source) — EVM instances are untouched.
 */
function bitcoinInstanceNotes(holding) {
  const btc = holding.bitcoin
  if (!btc) return []
  const notes = []
  if (btc.pendingSats) {
    const sign = btc.pendingSats > 0 ? '+' : '−'
    notes.push(`${sign}${formatAssetAmount(Math.abs(btc.pendingSats) / 1e8, 'BTC')} pending`)
  }
  if (btc.protectedSats > 0) {
    notes.push(
      `${formatAssetAmount(btc.protectedSats / 1e8, 'BTC')} protected (${
        btc.stampsDegraded ? 'Stamps check degraded — treated as protected' : 'Bitcoin Stamps'
      })`,
    )
  }
  return notes
}

// The FairWins membership voucher (spec 026) — the one NFT with a first-party send flow.
// Matched on the app-config identity the taxonomy stamps on it (assetTaxonomy.js registers
// FWMV with source 'app-config'), never on symbol alone: a third-party token calling itself
// FWMV must not be handed a deep link into the voucher transfer flow.
function isMembershipVoucher(asset) {
  return asset.kind === 'nft' && asset.symbol === 'FWMV' && asset.source === 'app-config'
}

// Action eligibility per instance — actions the app cannot perform render
// disabled with a reason, never as dead buttons (constitution III).
function actionsFor(instance) {
  if (!instance) return []
  const { asset } = instance
  const net = NETWORKS[asset.chainId]
  return [
    // Send / Gift (release 1.14.0 task 9): vouchers are transferable BY DESIGN (gifted or
    // resold — spec 026), so the sheet must not present one as four disabled actions. The
    // action only NAVIGATES into the existing VouchersPage transfer flow (`#vch-transfer`
    // scrolls to it and preselects the first held voucher) — no transfer logic lives here.
    ...(isMembershipVoucher(asset)
      ? [
          {
            id: 'send-voucher',
            label: 'Send / Gift',
            enabled: true,
            to: '/vouchers#vch-transfer',
          },
        ]
      : []),
    {
      id: 'trade',
      label: 'Trade',
      // `capabilities.dex`, NOT the raw `net.dex` block. The raw block is only "this network has
      // DEX addresses configured"; the capability additionally requires the network to be in
      // SWAP_CHAIN_IDS, which is the FR-016a allow-list deciding where in-app swapping is actually
      // offered. Reading the raw block bypasses that allow-list, so a network whose addresses are
      // configured but which is deliberately not allow-listed would show an enabled Trade action
      // leading to a surface that will not serve it.
      enabled: asset.kind !== 'nft' && Boolean(net?.capabilities?.dex),
      reason: asset.kind === 'nft' ? 'Collectibles cannot be traded here' : 'No in-app trading on this network',
      to: `/wallet?tab=trade&chain=${asset.chainId}&token=${encodeURIComponent(asset.symbol)}`,
    },
    {
      id: 'transfer',
      label: 'Transfer',
      enabled: asset.kind === 'native' || asset.categoryId === 'payment-stablecoins',
      reason: 'Transfer supports native and stablecoin sends',
      to: `/wallet?tab=paytransfer&chain=${asset.chainId}&token=${encodeURIComponent(asset.symbol)}`,
    },
    {
      // Earn (spec 050): lend this asset through the Earn section. Enabled
      // when the instance's network supports earn and the asset is fungible;
      // the lend view prefilters to vaults accepting this asset.
      id: 'earn',
      label: 'Earn',
      enabled: asset.kind !== 'nft' && Boolean(net?.earn),
      reason:
        asset.kind === 'nft'
          ? 'Collectibles cannot be lent'
          : 'Earning is not available on this network',
      to: `/wallet?tab=earn&view=lend&chain=${asset.chainId}&token=${encodeURIComponent(asset.symbol)}`,
    },
    {
      // Stake (spec 065): stake this asset through the Earn → Stake area.
      // Enabled when the instance's network supports staking and the asset is
      // stakeable there (ETH via Lido; POL via sPOL + Polygon delegation).
      id: 'stake',
      label: 'Stake',
      enabled:
        asset.kind !== 'nft' &&
        Boolean(net?.staking) &&
        ['ETH', 'POL'].includes((asset.symbol || '').toUpperCase()),
      reason:
        asset.kind === 'nft'
          ? 'Collectibles cannot be staked'
          : net?.staking
            ? 'This asset cannot be staked yet'
            : 'Staking is not available on this network',
      to: `/wallet?tab=earn&view=stake&chain=${asset.chainId}&token=${encodeURIComponent(asset.symbol)}`,
    },
  ]
}

/**
 * AssetDetailSheet (spec 044 v1.2, FR-024/FR-027) — bottom sheet with the
 * aggregate position, the per-instance balances (native + wrapped forms per
 * network, shown separately), and instance-scoped actions. Self-contained
 * isOpen/onClose modal per repo convention (Escape + backdrop close, focus
 * managed, modal-tier overlay).
 */
export default function AssetDetailSheet({ aggregate, onClose }) {
  const navigate = useNavigate()
  const sheetRef = useRef(null)
  const restoreFocusRef = useRef(null)
  const [selectedId, setSelectedId] = useState(null)

  const instances = useMemo(() => aggregate?.instances || [], [aggregate])
  const selected = useMemo(() => {
    const found = instances.find((h) => `${h.asset.chainId}:${h.asset.id}` === selectedId)
    return found || instances.find((h) => h.balance > 0) || instances[0] || null
  }, [instances, selectedId])

  useEffect(() => {
    if (!aggregate) return undefined
    restoreFocusRef.current = document.activeElement
    sheetRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus?.()
    }
  }, [aggregate, onClose])

  if (!aggregate) return null

  const priceLabel = priceSourceLabel(aggregate.priceEntry)
  const titleId = 'asset-sheet-title'

  const runAction = (action) => {
    if (!action.enabled || !action.to) return
    onClose()
    navigate(action.to)
  }

  return (
    <div className="asset-sheet-backdrop">
      <button type="button" className="asset-sheet-scrim" aria-label="Close asset details" onClick={onClose} />
      <div
        className="asset-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={sheetRef}
      >
        <div className="asset-sheet-grabber" aria-hidden="true" />
        <div className="asset-sheet-header">
          <AssetLogo symbol={aggregate.underlying} size={40} />
          <div className="asset-sheet-heading">
            <h3 id={titleId}>{aggregate.name} details</h3>
            <p className="asset-sheet-position">
              <SensitiveValue>{formatAssetAmount(aggregate.balance, aggregate.underlying, aggregate.kind)}</SensitiveValue>
              {aggregate.usd != null && <span className="asset-sheet-usd"> · <SensitiveValue>{formatUsdFull(aggregate.usd)}</SensitiveValue></span>}
            </p>
            {aggregate.unitPriceUsd != null && (
              <p className="asset-sheet-price">
                {formatUsdFull(aggregate.unitPriceUsd)} per {aggregate.underlying}
                {priceLabel && <span className="asset-sheet-price-source"> · {priceLabel}</span>}
                {aggregate.categoryId === 'payment-stablecoins' && (
                  <span className="asset-sheet-price-source"> · valued at par</span>
                )}
              </p>
            )}
          </div>
          <button type="button" className="asset-sheet-close" onClick={onClose}>
            Close
          </button>
        </div>

        <fieldset className="asset-sheet-instances">
          <legend>Select an instance</legend>
          {instances.map((holding) => {
            const id = `${holding.asset.chainId}:${holding.asset.id}`
            const isSelected = selected && `${selected.asset.chainId}:${selected.asset.id}` === id
            return (
              <label key={id} className={`asset-sheet-instance ${isSelected ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="asset-instance"
                  value={id}
                  checked={Boolean(isSelected)}
                  onChange={() => setSelectedId(id)}
                />
                <AssetLogo
                  symbol={aggregate.underlying}
                  chainId={holding.asset.chainId}
                  showBadge={!isHomeInstance(holding.asset)}
                  size={28}
                />
                <span className="asset-sheet-instance-text">
                  <span className="asset-sheet-instance-form">{instanceFormLabel(holding.asset)}</span>
                  <span className="asset-sheet-instance-meta">
                    {holding.network} · {SOURCE_LABELS[holding.asset.source] || holding.asset.source}
                  </span>
                  {bitcoinInstanceNotes(holding).map((note) => (
                    <span key={note} className="asset-sheet-instance-meta asset-sheet-instance-bitcoin">
                      {note}
                    </span>
                  ))}
                </span>
                <span className="asset-sheet-instance-values">
                  <SensitiveValue className="asset-sheet-instance-balance">{formatAmount(holding)}</SensitiveValue>
                  {holding.usd == null ? (
                    <span className="asset-sheet-instance-usd">
                      <span aria-hidden="true">—</span>
                      <span className="portfolio-visually-hidden">price unavailable</span>
                    </span>
                  ) : (
                    <SensitiveValue className="asset-sheet-instance-usd">{formatUsdFull(holding.usd)}</SensitiveValue>
                  )}
                </span>
              </label>
            )
          })}
        </fieldset>

        <div className="asset-sheet-actions">
          {actionsFor(selected).map((action) => (
            <button
              key={action.id}
              type="button"
              className={`asset-sheet-action ${['trade', 'send-voucher'].includes(action.id) ? 'primary' : ''}`}
              disabled={!action.enabled}
              title={action.enabled ? undefined : action.reason}
              onClick={() => runAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
        {selected && actionsFor(selected).some((a) => !a.enabled) && (
          <p className="asset-sheet-actions-note">
            {actionsFor(selected)
              .filter((a) => !a.enabled)
              .map((a) => `${a.label}: ${a.reason}`)
              .join('. ')}
            .
          </p>
        )}

        {/* Token news (spec 109) — advisory only, mounted AFTER the actions it never gates.
            Tenant-flagged; NFTs are out of scope (news identity is a fungible-asset fact). */}
        {isFeatureEnabled('news') && selected && selected.asset.kind !== 'nft' && (
          <TokenNewsCard
            chainId={selected.asset.chainId}
            address={selected.asset.kind === 'native' ? null : selected.asset.address}
            assetLabel={selected.asset.symbol}
          />
        )}
      </div>
    </div>
  )
}
