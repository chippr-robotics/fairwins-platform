import { useEffect, useMemo } from 'react'
import { isAddress } from 'viem'
import { useMembershipTreasuryStats, fmtUsdc } from '../../hooks/useMembershipTreasuryStats'
import './MembershipTreasuryOverview.css'

/**
 * MembershipTreasuryOverview — the app-wide membership statistics + treasury-growth panel that anchors
 * the Admin → Overview tab. Reads are aggregated client-side from a bounded MembershipManager event
 * scan (see useMembershipTreasuryStats) because the contract exposes no aggregate counters and there is
 * no backend/subgraph for it. The scan is explicit (Refresh), cache-backed, and honestly flags a
 * truncated window.
 *
 * Props:
 * Spec 071 (T046): memberships live on ONE chain, so this panel is pinned to the reference chain
 * rather than given a network picker — there is no second membership estate to look at. What that
 * requires of the caller is that `provider`, `chainId` and `address` all name the SAME chain: a
 * wallet provider paired with the reference chain's address reads one chain's contract at
 * another's address, and caches the answer under the wrong key.
 *
 * Props:
 *   provider   — ethers provider for the read scan, on `chainId`
 *   chainId    — the chain being read (drives the cache key); the membership reference chain
 *   address    — MembershipManager address on that chain ('' when undeployed)
 *   accruedFees — live undrawn balance (USDC string) already read by the parent AdminPanel
 *   accruedFeesReadable — whether that read SUCCEEDED. `false` renders as "could not be read",
 *     never as $0.00: an operator who reads a zero accrued balance concludes the fees were
 *     already withdrawn, and acts on it.
 */

const TIER_NAMES = { 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Platinum' }
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function usd(v) {
  const n = typeof v === 'bigint' ? Number(fmtUsdc(v)) : Number(v || 0)
  return USD.format(Number.isFinite(n) ? n : 0)
}

const shortAddr = (a) => (a && isAddress(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '—')

/**
 * Compact single-series cumulative-revenue sparkline (magnitude over the sequence of revenue events).
 * One hue (brand), thin line + soft area fill, recessive baseline, latest value direct-labelled. Block
 * numbers are the x clock the logs carry — labelled as such, never claimed to be calendar time.
 */
function RevenueSparkline({ series }) {
  const points = useMemo(
    () => series.map((p) => ({ x: p.block, y: Number(fmtUsdc(p.cumulative)) })),
    [series],
  )
  if (points.length < 2) return null

  const W = 320
  const H = 64
  const PAD = 4
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1
  const spanY = maxY || 1

  const sx = (x) => PAD + ((x - minX) / spanX) * (W - PAD * 2)
  const sy = (y) => H - PAD - (y / spanY) * (H - PAD * 2)

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')
  const area = `${line} L${sx(maxX).toFixed(1)},${(H - PAD).toFixed(1)} L${sx(minX).toFixed(1)},${(H - PAD).toFixed(1)} Z`
  const last = points[points.length - 1]

  return (
    <figure className="mto-spark" aria-label={`Cumulative membership revenue reaching ${usd(last.y)} over the scanned block window`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none" className="mto-spark__svg">
        <path d={area} className="mto-spark__area" />
        <path d={line} className="mto-spark__line" />
        <circle cx={sx(last.x)} cy={sy(last.y)} r="3" className="mto-spark__dot" />
      </svg>
      <figcaption className="mto-spark__caption">
        Cumulative membership revenue → <strong>{usd(last.y)}</strong>
        <span className="mto-spark__hint"> (over scanned blocks)</span>
      </figcaption>
    </figure>
  )
}

function Tile({ label, value, tone }) {
  return (
    <div className={`mto-tile${tone ? ` mto-tile--${tone}` : ''}`}>
      <span className="mto-tile__value">{value}</span>
      <span className="mto-tile__label">{label}</span>
    </div>
  )
}

export default function MembershipTreasuryOverview({ provider, chainId, address, accruedFees, accruedFeesReadable = true }) {
  const configured = Boolean(address && isAddress(address))
  const stats = useMembershipTreasuryStats({ provider, chainId, address })

  // Initial (cache-backed) scan when the panel mounts on a configured network.
  useEffect(() => {
    if (configured && provider) stats.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, provider, chainId, address])

  if (!configured) {
    return (
      <div className="admin-card full-width">
        <div className="admin-card-header"><h3>Membership &amp; Treasury</h3></div>
        <p role="status" className="mto-muted">
          MembershipManager is not deployed / configured on the membership network — no app-wide
          statistics to show.
        </p>
      </div>
    )
  }

  const d = stats.data

  return (
    <>
      {/* -------------------- Membership statistics -------------------- */}
      <div className="admin-card full-width">
        <div className="admin-card-header">
          <h3>Membership Statistics</h3>
          <button
            type="button"
            className="confirm-btn"
            onClick={() => stats.refresh({ force: true })}
            disabled={stats.loading}
          >
            {stats.loading ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
        <p className="mto-muted">
          App-wide across all members, aggregated from the MembershipManager event log
          (<code title={address}>{shortAddr(address)}</code>).
        </p>
        {stats.error && <p role="alert" className="mto-error">Scan failed: {stats.error}</p>}
        {!d && !stats.loading && !stats.error && <p role="status" className="mto-muted">No statistics loaded yet.</p>}
        {d && (
          <>
            <div className="mto-tiles" aria-label="Active membership summary">
              <Tile label={d.truncated ? 'Active members (window)' : 'Active members'} value={d.members.active} tone="accent" />
              {[1, 2, 3, 4].map((t) => (
                <Tile key={t} label={`${TIER_NAMES[t]} active`} value={d.members.byTier[t]} />
              ))}
              <Tile label="Unique members (ever)" value={d.members.everMembers} />
            </div>

            <h4 className="mto-subhead">Lifetime activity {d.truncated ? '(scanned window)' : ''}</h4>
            <div className="mto-tiles mto-tiles--dense" aria-label="Lifetime membership events">
              <Tile label="Purchases" value={d.counts.purchased} />
              <Tile label="Admin grants" value={d.counts.granted} />
              <Tile label="Voucher redemptions" value={d.counts.redeemed} />
              <Tile label="Extensions" value={d.counts.extended} />
              <Tile label="Upgrades" value={d.counts.upgraded} />
              <Tile label="Revocations" value={d.counts.revoked} />
            </div>
          </>
        )}
      </div>

      {/* -------------------- Treasury growth -------------------- */}
      <div className="admin-card full-width">
        <div className="admin-card-header"><h3>Treasury Growth</h3></div>
        <p className="mto-muted">
          Two streams fund the treasury: paid <strong>membership</strong> revenue (purchases, extensions,
          upgrades) and the <strong>fees</strong> withdrawn from the MembershipManager to the treasury
          address. Admin grants and voucher redemptions are free at this contract and add nothing here.
        </p>
        {d && (
          <>
            <div className="mto-tiles" aria-label="Treasury growth summary">
              <Tile label={d.truncated ? 'Membership revenue (window)' : 'Membership revenue'} value={usd(d.revenue.total)} tone="accent" />
              <Tile label="Withdrawn to treasury" value={usd(d.revenue.withdrawn)} />
              <Tile
                label="Accrued (undrawn, live)"
                value={accruedFeesReadable === false ? 'Could not be read' : usd(accruedFees)}
              />
            </div>

            <RevenueSparkline series={d.series} />

            <h4 className="mto-subhead">Revenue by stream</h4>
            <div className="mto-bars" aria-label="Membership revenue by stream">
              {[
                { key: 'purchases', label: 'Purchases' },
                { key: 'extensions', label: 'Extensions' },
                { key: 'upgrades', label: 'Upgrades' },
              ].map(({ key, label }) => {
                const val = Number(fmtUsdc(d.revenue[key]))
                const total = Number(fmtUsdc(d.revenue.total)) || 1
                const pct = Math.max(0, Math.min(100, (val / total) * 100))
                return (
                  <div className="mto-bar-row" key={key}>
                    <span className="mto-bar-label">{label}</span>
                    <span className="mto-bar-track"><span className="mto-bar-fill" style={{ width: `${pct}%` }} /></span>
                    <span className="mto-bar-value">{usd(d.revenue[key])}</span>
                  </div>
                )
              })}
            </div>

            <h4 className="mto-subhead">Membership revenue by tier</h4>
            <div className="mto-bars" aria-label="Membership revenue by tier">
              {[1, 2, 3, 4].map((t) => {
                const val = Number(fmtUsdc(d.revenueByTier[t]))
                const total = Number(fmtUsdc(d.revenue.total)) || 1
                const pct = Math.max(0, Math.min(100, (val / total) * 100))
                return (
                  <div className="mto-bar-row" key={t}>
                    <span className="mto-bar-label">{TIER_NAMES[t]}</span>
                    <span className="mto-bar-track"><span className="mto-bar-fill" style={{ width: `${pct}%` }} /></span>
                    <span className="mto-bar-value">{usd(d.revenueByTier[t])}</span>
                  </div>
                )
              })}
            </div>

            {d.truncated && (
              <p role="note" className="mto-note">
                Showing the most recent block window only — lifetime tallies and revenue are for the
                scanned range, not all-time. The live accrued balance above is exact; query the chain
                directly (or a future subgraph) for full history.
              </p>
            )}
          </>
        )}
      </div>
    </>
  )
}
