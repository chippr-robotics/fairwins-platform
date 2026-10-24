/**
 * TokenNewsCard (spec 109) — recent third-party news for ONE platform asset.
 *
 * Consumes exactly one FeedReading from the newsClient seam and invents nothing:
 *   read + items      → attributed, dated, TEXT-ONLY rows whose only interaction is the external
 *                       link-out (FR-005 — no vendor markup, images or icons ever render)
 *   read + []         → the honest empty state ("no recent items") — content, not failure
 *   not-covered       → "no news source covers this asset" (resolved locally, zero network)
 *   unreadable        → a sentence + Retry, visually and verbally DISTINCT from empty (FR-003)
 *   not-configured    → renders nothing at all (module/tenant off ⇒ the surface is absent)
 *
 * News is ADVISORY-ONLY (FR-006): nothing here gates, delays or alters any value path — the card
 * is presentation over a read, mounted beside actions it never touches. Mount sites gate on
 * isFeatureEnabled('news'); the card additionally goes quiet on not-configured so a gateway
 * without the module never shows a broken affordance.
 *
 * LAYOUT: THE FEED IS RANKED, NOT LISTED. A flat list of equally-weighted underlined titles made a
 * one-hour report and a three-month price-prediction piece look like the same claim, and gave the
 * reader nothing but the age string to tell them apart — on a sheet whose actual job is Trade and
 * Transfer. So:
 *
 *   - the NEWEST item is featured (larger, unadorned) and everything else is compact;
 *   - rows carry recency HEADINGS (Today / This week / Earlier) whenever the bucket changes, so the
 *     list visibly ends instead of running on;
 *   - first paint is capped at the featured item plus three, and the tail is behind one disclosure.
 *
 * Every one of those is presentation over the same reading: nothing is dropped, no item is
 * summarized or re-titled, and every row still carries its source and its age. Ordering is by
 * published date and nothing else — there is no ranking signal here that the vendor did not give
 * us, and none that we invented.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchTokenNews } from '../../lib/news/newsClient'
import { newsAgeLabel, newsBucket, NEWS_BUCKET_LABELS } from '../../lib/news/newsAge'
import { membershipChainId, MAINNET_CHAIN_ID } from '../../config/networks'
import './TokenNewsCard.css'

/** Compact rows shown beside the featured item before the reader has to ask for more. */
const VISIBLE_COMPACT = 3

/**
 * Split one reading's items into what paints and what waits, grouped by recency.
 *
 * A group's heading is emitted only when its bucket DIFFERS from what came before it — the featured
 * item seeds that — so a feed where everything landed today renders no headings at all rather than
 * one "Today" label over the whole card.
 */
function buildFeed(items, now) {
  const sorted = [...items].sort((a, b) => {
    const ta = Date.parse(a.publishedAt)
    const tb = Date.parse(b.publishedAt)
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
  })
  const [featured, ...rest] = sorted

  let previousBucket = newsBucket(featured.publishedAt, now)
  const group = (list) => {
    const groups = []
    for (const item of list) {
      const bucket = newsBucket(item.publishedAt, now)
      const last = groups[groups.length - 1]
      if (last && last.bucket === bucket) {
        last.items.push(item)
        continue
      }
      groups.push({ bucket, label: bucket === previousBucket ? null : NEWS_BUCKET_LABELS[bucket], items: [item] })
      previousBucket = bucket
    }
    return groups
  }

  const shown = group(rest.slice(0, VISIBLE_COMPACT))
  const hiddenItems = rest.slice(VISIBLE_COMPACT)
  const hidden = group(hiddenItems)

  return {
    featured,
    shown,
    hidden,
    hiddenCount: hiddenItems.length,
    // "Earlier" is only an honest name for the tail when the tail actually IS earlier than a week;
    // a feed of twenty items all filed today hides recent ones, and says so.
    hiddenLabel: hiddenItems.every((i) => newsBucket(i.publishedAt, now) === 'earlier')
      ? `Earlier · ${hiddenItems.length}`
      : `Show ${hiddenItems.length} older`,
  }
}

function NewsRow({ item, now }) {
  return (
    <li className="token-news-item">
      {/* The link is the ONLY interaction: external, attributed, plain text. */}
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="token-news-link">
        {item.title}
      </a>
      <span className="token-news-meta">
        {item.source?.name || 'Unknown source'} · {newsAgeLabel(item.publishedAt, now)}
      </span>
    </li>
  )
}

function NewsGroups({ groups, now }) {
  return groups.map((g, i) => (
    <div className="token-news-group" key={`${g.bucket}-${i}`}>
      {g.label && <h4 className="token-news-bucket">{g.label}</h4>}
      <ul className="token-news-list">
        {g.items.map((item) => (
          <NewsRow key={item.id || item.url} item={item} now={now} />
        ))}
      </ul>
    </div>
  ))
}

export default function TokenNewsCard({ chainId, address = null, assetLabel = 'this asset' }) {
  const [reading, setReading] = useState(null) // null = loading
  // The instant the feed landed. Ages and buckets are both measured from it rather than from a
  // Date.now() inside render — one clock for the card, and a pure one (react-hooks/purity).
  const [readAt, setReadAt] = useState(0)
  const [revision, setRevision] = useState(0)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReading(null)
    setExpanded(false)
    fetchTokenNews({ chainId, address }).then((r) => {
      if (cancelled) return
      setReadAt(Date.now())
      setReading(r)
    })
    return () => {
      cancelled = true
    }
  }, [chainId, address, revision])

  const retry = useCallback(() => setRevision((r) => r + 1), [])

  const items = reading?.state === 'read' ? reading.items : null
  const feed = useMemo(() => (items?.length ? buildFeed(items, readAt) : null), [items, readAt])

  if (reading?.state === 'not-configured') return null

  // A testnet build shows mainnet-asset news (the one honest option — spec edge case; the perps
  // testnet-notice precedent). Said in words, once, above the rows.
  const crossCohort = membershipChainId() !== MAINNET_CHAIN_ID

  return (
    <section className="token-news-card" aria-label={`News for ${assetLabel}`}>
      <div className="token-news-head">
        <h3 className="token-news-title">News</h3>
        {feed && <span className="token-news-latest">Latest</span>}
      </div>
      {crossCohort && reading?.state === 'read' && (
        <p className="token-news-cohort-note">News describes the mainnet asset, not testnet balances.</p>
      )}

      {reading === null && (
        <p className="token-news-quiet" role="status">
          Loading news…
        </p>
      )}

      {reading?.state === 'not-covered' && <p className="token-news-quiet">No news source covers {assetLabel}.</p>}

      {reading?.state === 'unreadable' && (
        <div className="token-news-unreadable" role="status">
          <p>The news feed could not be read right now.</p>
          <button type="button" className="token-news-retry" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {reading?.state === 'read' && reading.items.length === 0 && (
        <p className="token-news-quiet">No recent items for {assetLabel}.</p>
      )}

      {feed && (
        <>
          <div className="token-news-featured">
            <a
              href={feed.featured.url}
              target="_blank"
              rel="noopener noreferrer"
              className="token-news-featured-link"
            >
              {feed.featured.title}
            </a>
            <span className="token-news-meta">
              {feed.featured.source?.name || 'Unknown source'} · {newsAgeLabel(feed.featured.publishedAt, readAt)}
            </span>
          </div>

          <NewsGroups groups={feed.shown} now={readAt} />

          {feed.hiddenCount > 0 && (
            <>
              <button
                type="button"
                className="token-news-more"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
              >
                <span>{feed.hiddenLabel}</span>
                <span className="token-news-chevron" aria-hidden="true" />
              </button>
              {/* Collapsed means UNMOUNTED, not hidden: a control claiming aria-expanded="false"
                  over rows still in the DOM and the tab order is claiming something untrue
                  (the spec-081 drawer lesson). */}
              {expanded && <NewsGroups groups={feed.hidden} now={readAt} />}
            </>
          )}
        </>
      )}
    </section>
  )
}
