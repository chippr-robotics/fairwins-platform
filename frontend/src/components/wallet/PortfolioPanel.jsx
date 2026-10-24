import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import usePortfolio from '../../hooks/usePortfolio'
import { useEffectiveAccount } from '../../hooks/useEffectiveAccount'
import InfoTip from '../ui/InfoTip'
import AssetLogo from './AssetLogo'
import AssetDetailSheet from './AssetDetailSheet'
import { formatAssetAmount } from '../../lib/portfolio/aggregate'
import SensitiveValue from '../common/SensitiveValue'
import { useCollectiblesValuation } from '../../hooks/useCollectibles'
import { useIssuedAccessDisclosure } from '../../hooks/useIssuedAccessDisclosure'
import { computeCollectiblesValuation } from '../../lib/collectibles/valuation'
import './Portfolio.css'

// Full-precision USD for a compliance-flavored view — deliberately not the
// dashboard's compact "$1.2K" (a portfolio total wants exact figures).
function formatUsdFull(n) {
  return `$${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatAggregateBalance(aggregate) {
  return formatAssetAmount(aggregate.balance, aggregate.underlying, aggregate.kind)
}

/*
 * A word break for assistive tech only.
 *
 * These row buttons build their accessible name by concatenating adjacent <span>s that are
 * separated visually (flex gaps, line breaks) but not textually. Nothing in the DOM says where one
 * field ends and the next begins, so a name computed straight from the text runs them together:
 * "EthereumETH3 instances · 2 networks1.75 ETH$3,500.00" — which a screen reader reads as
 * "EthereumETH3", not "Ethereum, ETH, 3 instances".
 *
 * It surfaced as six failing tests when @testing-library/jest-dom went 6 -> 7 (jsdom 25 -> 30):
 * the newer accessible-name implementation stopped inserting a space at element boundaries that
 * the older one added for us. The DOM never changed — only whether the gap was implied or real.
 * Making it real is what keeps the name correct regardless of which library, browser, or version
 * computes it.
 *
 * Clip-based hiding on purpose (Portfolio.css): `display: none` would remove the text from the
 * accessibility tree entirely and put the words straight back together.
 *
 * A comma, not a space. A whitespace-only separator does not survive: the name algorithm trims and
 * normalises each node's contribution, so a <span> holding only " " contributes nothing and the
 * fields run together exactly as before (measured). The comma also reads better — assistive tech
 * pauses on it, so the name is announced as distinct fields rather than one run-on phrase.
 */
function Sep() {
  return <span className="portfolio-visually-hidden">, </span>
}

function AggregateRow({ aggregate, onOpen }) {
  const networks = new Set(aggregate.instances.map((h) => h.asset.chainId))
  const singleInstance = aggregate.instances.length === 1 ? aggregate.instances[0] : null
  return (
    <li className="portfolio-row">
      <button
        type="button"
        className="portfolio-row-button"
        onClick={() => onOpen(aggregate)}
        aria-haspopup="dialog"
      >
        <AssetLogo symbol={aggregate.underlying} size={32} />
        <span className="portfolio-row-asset">
          <span className="portfolio-row-name">{aggregate.name}</span>
          <Sep />
          <span className="portfolio-row-meta">
            {aggregate.underlying}
            <Sep />
            <span className="portfolio-row-network">
              {singleInstance
                ? singleInstance.network
                : `${aggregate.instances.length} instances · ${networks.size} network${networks.size === 1 ? '' : 's'}`}
            </span>
          </span>
        </span>
        <Sep />
        <span className="portfolio-row-values">
          <SensitiveValue className="portfolio-row-balance">{formatAggregateBalance(aggregate)}</SensitiveValue>
          <Sep />
          {aggregate.usd == null ? (
            <span className="portfolio-row-usd portfolio-row-usd-unavailable">
              <span aria-hidden="true">—</span>
              <span className="portfolio-visually-hidden">price unavailable</span>
            </span>
          ) : (
            <SensitiveValue className="portfolio-row-usd">{formatUsdFull(aggregate.usd)}</SensitiveValue>
          )}
        </span>
      </button>
    </li>
  )
}

function CategorySection({ group, collapsed, onToggle, onOpen, extra }) {
  const { category, aggregates, subtotalUsd } = group
  const regionId = `portfolio-category-${category.id}`
  const expanded = !collapsed
  return (
    <section className="portfolio-category">
      <div className="portfolio-category-heading-row">
        <h3 className="portfolio-category-heading">
          <button
            type="button"
            className="portfolio-category-toggle"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => onToggle(category.id)}
          >
            <span className="portfolio-category-chevron" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
            <span className="portfolio-category-label">{category.label}</span>
            <Sep />
            <SensitiveValue className="portfolio-category-subtotal">{formatUsdFull(subtotalUsd)}</SensitiveValue>
          </button>
        </h3>
        <InfoTip label={`About ${category.label}`} className="portfolio-category-info">
          {category.description}
        </InfoTip>
      </div>
      <div id={regionId} role="region" aria-label={category.label} hidden={!expanded}>
        {aggregates.length === 0 && !extra ? (
          <p className="portfolio-category-empty">No assets in this category.</p>
        ) : (
          <>
            {aggregates.length > 0 && (
              <ul className="portfolio-rows">
                {aggregates.map((aggregate) => (
                  <AggregateRow key={aggregate.id} aggregate={aggregate} onOpen={onOpen} />
                ))}
              </ul>
            )}
            {extra}
          </>
        )}
      </div>
    </section>
  )
}

/**
 * Collectibles estimate row (spec 055 US3 / FR-006) — rendered INSIDE the
 * "Digital Collectibles" taxonomy section, beside any registry-tracked NFT
 * holdings. Honest-state rules (research D8): the floor-price estimate is
 * NEVER merged into the verifiable totalUsd headline or the category
 * subtotal; unpriced items are counted, not silently valued; upstream outages
 * degrade this row without touching token rendering; absent entirely where
 * the feature is unavailable.
 */
function CollectiblesEstimateRow({ valuationState, priceMap }) {
  const navigate = useNavigate()
  const { status, items, statsBySlug, bounds, stale } = valuationState

  const valuation = computeCollectiblesValuation(
    items,
    statsBySlug,
    (symbol) => priceMap.get(symbol)?.usd ?? null,
    bounds,
  )

  return (
    <div className="portfolio-collectibles">
      <ul className="portfolio-rows">
        <li className="portfolio-row">
          <button
            type="button"
            className="portfolio-row-button"
            onClick={() => navigate('/wallet?tab=collectibles')}
            aria-label="Collectibles, floor-price estimate — open the Collectibles tab"
          >
            <span className="portfolio-row-asset">
              <span className="portfolio-row-name">Collectibles</span>
              <span className="portfolio-row-meta">
                {status === 'degraded'
                  ? 'temporarily unavailable'
                  : `floor-price estimate, priced items only (${valuation.pricedItems} priced` +
                    `${valuation.unpricedItems > 0 ? `, ${valuation.unpricedItems} unpriced` : ''})` +
                    `${valuation.truncated ? ' — partial' : ''}${stale || valuation.stale ? ' — cached data' : ''}`}
              </span>
            </span>
            <span className="portfolio-row-values">
              {status === 'degraded' || valuation.estimatedUsd == null ? (
                <span className="portfolio-row-usd portfolio-row-usd-unavailable">
                  <span aria-hidden="true">—</span>
                  <span className="portfolio-visually-hidden">
                    {status === 'degraded' ? 'collectibles data unavailable' : 'estimate unavailable'}
                  </span>
                </span>
              ) : (
                <SensitiveValue className="portfolio-row-usd">
                  {`≈ ${formatUsdFull(valuation.estimatedUsd)}`}
                </SensitiveValue>
              )}
            </span>
          </button>
        </li>
      </ul>
      <p className="portfolio-category-empty">
        Estimates use collection floor prices and are not included in the totals above.
      </p>
    </div>
  )
}

/**
 * Connected Account Portfolio (spec 044 v1.2) — the member's holdings across
 * every supported network, grouped by the SEC/CFTC asset taxonomy with
 * wrapped forms combined into their underlying asset. Tapping a row opens
 * the asset detail sheet (instances + actions). Category explainers live in
 * InfoTip bubbles; testnet and zero-balance visibility follow the
 * Preferences → Portfolio settings.
 *
 * Spec 074 follow-up: the panel can be handed an externally-owned `portfolio`
 * (MyAccountView mounts ONE usePortfolio so the account card's quick-access
 * total and this panel read the same snapshot — no duplicate scans). Without
 * the prop it self-loads exactly as before. Split into a self-loading wrapper
 * and a body so the hook is never called conditionally.
 */
export default function PortfolioPanel({ portfolio = null }) {
  if (portfolio) return <PortfolioBody portfolio={portfolio} />
  return <SelfLoadingPortfolioPanel />
}

/** Loading bones: real section/row geometry, shimmer placeholders. */
function PortfolioSkeleton() {
  return (
    <div className="portfolio-skeleton" aria-hidden="true">
      {[0, 1, 2].map((section) => (
        <section className="portfolio-category" key={section}>
          <span className="portfolio-skeleton-bar portfolio-skeleton-heading" />
          <ul className="portfolio-rows">
            {[0, 1, 2].map((row) => (
              <li className="portfolio-row portfolio-skeleton-row" key={row}>
                <span className="portfolio-skeleton-avatar" />
                <span className="portfolio-skeleton-lines">
                  <span className="portfolio-skeleton-bar portfolio-skeleton-line-wide" />
                  <span className="portfolio-skeleton-bar portfolio-skeleton-line-narrow" />
                </span>
                <span className="portfolio-skeleton-lines portfolio-skeleton-lines-end">
                  <span className="portfolio-skeleton-bar portfolio-skeleton-line-narrow" />
                  <span className="portfolio-skeleton-bar portfolio-skeleton-line-narrow" />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function SelfLoadingPortfolioPanel() {
  // Spec 063 (US1): the portfolio shows the account the member is acting as (a vault or recovered
  // account), not always the connected wallet. Personal mode passes its own address → unchanged.
  const { address: actingAddress, isActingAccount } = useEffectiveAccount()
  const portfolio = usePortfolio(isActingAccount ? { accountAddress: actingAddress } : undefined)
  return <PortfolioBody portfolio={portfolio} />
}

function PortfolioBody({ portfolio }) {
  // Issued-access disclosure (spec 107 FR-028, #1471): the ONE state worth a sentence is
  // `degraded` — keyed reads were tried for a chain and FAILED, so it is reading on public
  // capacity right now. Declined chains (ETC/Mordor — no keyed endpoint exists, by design) and
  // everything else render as silence: public capacity is their normal, and apologising for it
  // would be the false-degradation twin of the false zero.
  const issuedAccess = useIssuedAccessDisclosure(portfolio.chainIds)
  // Decided HERE (not inside the row) so the Digital Collectibles section keeps
  // its honest "No assets in this category." message when the row is absent.
  const collectiblesValuation = useCollectiblesValuation()
  const showCollectiblesRow =
    collectiblesValuation.supported &&
    !['disconnected', 'empty', 'loading'].includes(collectiblesValuation.status)
  const [collapsedIds, setCollapsedIds] = useState(() => new Set())
  const [openAggregateId, setOpenAggregateId] = useState(null)

  // Resolve from the live snapshot so a refresh keeps the sheet current.
  const openAggregate = portfolio.aggregates.find((a) => a.id === openAggregateId) || null

  const toggleCategory = (id) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (portfolio.status === 'disconnected') {
    return (
      <div className="portfolio-root">
        <p className="portfolio-state">Connect a wallet to see your portfolio.</p>
      </div>
    )
  }

  if (portfolio.status === 'error') {
    return (
      <div className="portfolio-root">
        <p className="portfolio-state portfolio-state-error" role="alert">
          {portfolio.error}
        </p>
        <button type="button" className="portfolio-refresh" onClick={() => portfolio.refresh()}>
          Retry
        </button>
      </div>
    )
  }

  if (portfolio.status === 'loading') {
    // Cold load (no session snapshot yet): show the BONES of the portfolio —
    // category sections with shimmering placeholder rows — so the member sees
    // the page shape immediately instead of a bare loading line.
    // Placeholders are aria-hidden; the status text carries the semantics.
    return (
      <div className="portfolio-root" aria-busy="true">
        <p className="portfolio-visually-hidden" role="status">
          Loading portfolio…
        </p>
        <PortfolioSkeleton />
      </div>
    )
  }

  return (
    <div className="portfolio-root">
      {issuedAccess.names.length > 0 && (
        <p className="portfolio-state portfolio-state-degraded" role="status" data-testid="issued-access-degraded">
          {`Faster keyed reads are temporarily unavailable for ${issuedAccess.names.join(', ')} — using public networks, which may be slower. Balances shown are still live reads.`}
        </p>
      )}
      {portfolio.categories.map((group) => (
        <CategorySection
          key={group.category.id}
          group={group}
          collapsed={collapsedIds.has(group.category.id)}
          onToggle={toggleCategory}
          onOpen={(aggregate) => setOpenAggregateId(aggregate.id)}
          extra={
            // OpenSea-tracked collectibles live in the Digital Collectibles
            // section beside registry-tracked NFT holdings (spec 055 US3).
            group.category.id === 'digital-collectibles' && showCollectiblesRow ? (
              <CollectiblesEstimateRow valuationState={collectiblesValuation} priceMap={portfolio.priceMap} />
            ) : null
          }
        />
      ))}

      <footer className="portfolio-disclosures">
        {!portfolio.showTestnetAssets && (
          <p>Testnet tokens are hidden — enable them under Preferences → Portfolio.</p>
        )}
        {!portfolio.showZeroBalances && (
          <p>Zero-balance assets are hidden — enable them under Preferences → Portfolio.</p>
        )}
        <p>
          Classifications are informational, not legal or investment advice. Only assets in the
          app&apos;s curated registry are scanned; prices come from on-chain sources (oracle
          feeds, DEX pools) and USD totals include only priced assets.
        </p>
      </footer>

      {openAggregate && (
        <AssetDetailSheet aggregate={openAggregate} onClose={() => setOpenAggregateId(null)} />
      )}
    </div>
  )
}
