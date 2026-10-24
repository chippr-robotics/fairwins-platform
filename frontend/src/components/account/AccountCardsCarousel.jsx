import { useCallback, useEffect, useRef, useState } from 'react'
import AccountCard from './AccountCard'
import AccountCustomizeSheet from './AccountCustomizeSheet'
import AccountAddSheet from './AccountAddSheet'
import SensitiveValue from '../common/SensitiveValue'
import { useAccountSwitcher, ACCOUNT_KIND_TAG, shortAccountAddr } from '../../hooks/useAccountSwitcher'
import { NETWORKS } from '../../config/networks'
import './AccountCardsCarousel.css'

/**
 * AccountCardsCarousel — the top half of the unified My Account view: one card
 * per account the member can act as (personal wallet, multisig vaults,
 * recovered legacy accounts), swipeable left/right. Selecting a card makes that
 * account the ACTIVE account app-wide — it drives the same CustodyContext seam
 * as the header dropdown's switcher (useAccountSwitcher.choose), so the two
 * surfaces can never disagree about which account is active.
 *
 * Spec 088: selecting ANY card switches instantly, address-only — no unlock, no
 * device ceremony. Signing ceremonies are deferred to send time (the global
 * SignerRequestHost renders them when a transaction actually needs a signature).
 *
 * Scrolling is native horizontal scroll with CSS scroll-snap; the arrows and
 * dots are conveniences layered on top (and the arrows are the keyboard/desktop
 * affordance). No swipe library — cards are plain snap targets.
 */

// Chain identity for vault cards. Strict lookup — an unknown id renders as
// "Chain <id>" rather than mislabeling the vault with the default network.
function chainLabel(chainId) {
  if (chainId == null) return null
  return NETWORKS[chainId]?.name || `Chain ${chainId}`
}

// Full-precision USD, matching the Portfolio view's own total formatting.
function formatUsdFull(n) {
  return `$${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * @param {number|null} activeTotalUsd — the ACTIVE account's portfolio total,
 * shown on its card for quick access. Null hides the line (still loading /
 * unavailable) — a card must never show a fabricated $0 while data loads.
 */
function AccountCardsCarousel({ activeTotalUsd = null }) {
  const { accounts, currentId, choose } = useAccountSwitcher()
  const trackRef = useRef(null)
  const [scrollIndex, setScrollIndex] = useState(0)
  // Spec 086 — the Customize sheet, opened from the "⋯" ON the centered card. It edits the card
  // the member is LOOKING AT (the snap-centered one), which need not be the active account —
  // browsing to a card and dressing it must not require switching to it. The target is captured
  // at open time so scrolling underneath an open sheet cannot retarget it.
  const [customizeTarget, setCustomizeTarget] = useState(null)
  // Release 1.14.0 — the "+" chooser: the three ways an account joins this list (vault /
  // hardware / legacy recovery), each a deep link to its existing surface.
  const [addOpen, setAddOpen] = useState(false)
  // The "⋯" overlay is pinned to the MEASURED corner of the centered card — CSS center math
  // cannot place it, because the first/last cards clamp against the track edge instead of
  // centering. Recomputed with the scroll index and on resize.
  const [menuPos, setMenuPos] = useState(null)

  // The card whose center is nearest the viewport center — drives the dots and
  // the arrows' disabled states. Recomputed on scroll (rAF-throttled).
  const measureScrollIndex = useCallback(() => {
    const track = trackRef.current
    if (!track) return
    const center = track.scrollLeft + track.clientWidth / 2
    let nearest = 0
    let nearestDist = Infinity
    Array.from(track.children).forEach((child, i) => {
      const childCenter = child.offsetLeft + child.offsetWidth / 2
      const dist = Math.abs(childCenter - center)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = i
      }
    })
    setScrollIndex(nearest)
    const card = track.children[nearest]
    // Coordinates are relative to the overlay's positioned ancestor — the viewport wrapper,
    // not the (unpositioned, scrolling) track.
    const host = track.parentElement
    if (card && host) {
      const hostRect = host.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      setMenuPos({
        left: cardRect.right - hostRect.left - 38,
        top: cardRect.bottom - hostRect.top - 38,
      })
    }
  }, [])

  // Place the overlay on first paint and keep it placed across viewport changes.
  useEffect(() => {
    measureScrollIndex()
    window.addEventListener('resize', measureScrollIndex)
    return () => window.removeEventListener('resize', measureScrollIndex)
  }, [measureScrollIndex, accounts.length])

  const rafRef = useRef(0)
  const handleScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(measureScrollIndex)
  }, [measureScrollIndex])
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const scrollToIndex = useCallback((index) => {
    const track = trackRef.current
    const child = track?.children?.[index]
    if (!track || !child) return
    const left = Math.max(0, child.offsetLeft - (track.clientWidth - child.offsetWidth) / 2)
    setScrollIndex(index)
    if (Math.abs(track.scrollLeft - left) < 1) return // already in position
    if (typeof track.scrollTo === 'function') track.scrollTo({ left, behavior: 'smooth' })
    else track.scrollLeft = left
  }, [])

  // Bring the active account's card into view when the selection changes
  // (including a switch made from the header dropdown).
  const activeIndex = accounts.findIndex((acc) => acc.id === currentId)
  useEffect(() => {
    if (activeIndex >= 0) scrollToIndex(activeIndex)
    // scroll only on selection change, not on every list identity change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  const handleSelect = (acc, index) => {
    scrollToIndex(index)
    if (acc.id !== currentId) choose(acc)
  }

  const showControls = accounts.length > 1
  const centeredAccount = accounts[Math.min(scrollIndex, accounts.length - 1)] || null

  return (
    <section className="account-cards" aria-label="Your accounts">
      <div className="account-cards-viewport">
        {/* The card button IS the option — no interactive wrapper, so the
            listbox has no nested-interactive elements (axe gate X1). */}
        <div
          className="account-cards-track"
          role="listbox"
          aria-label="Select the active account"
          aria-orientation="horizontal"
          ref={trackRef}
          onScroll={handleScroll}
        >
          {accounts.map((acc, index) => {
            const isActive = acc.id === currentId
            return (
              <AccountCard
                key={acc.id}
                account={acc}
                active={isActive}
                network={acc.kind === 'vault' ? chainLabel(acc.chainId) : null}
                balance={
                  isActive && activeTotalUsd != null ? (
                    <span className="account-card-balance">
                      <span className="account-card-balance-label">Total balance</span>
                      <SensitiveValue className="account-card-balance-value">
                        {formatUsdFull(activeTotalUsd)}
                      </SensitiveValue>
                    </span>
                  ) : null
                }
                onSelect={() => handleSelect(acc, index)}
              />
            )
          })}
        </div>

        {/* Spec 086 — "⋯" rendered ON the centered card's corner. DOM-wise it lives outside the
            listbox (an option may contain no interactive children), positioned over the snap
            target with the same min() math the card's own width uses. */}
        {centeredAccount && (
          <button
            type="button"
            className="account-card-menu"
            style={menuPos ? { left: menuPos.left, top: menuPos.top } : undefined}
            onClick={() => setCustomizeTarget(centeredAccount)}
            aria-label={`Customize ${centeredAccount.label || shortAccountAddr(centeredAccount.address)} card`}
            data-testid="account-customize-open"
          >
            ⋯
          </button>
        )}

        {/* Release 1.14.0 — the "+" add-account control. Like the "⋯" it lives OUTSIDE the
            listbox (an option may contain no interactive children, and the control is about the
            LIST, not any one card). */}
        <button
          type="button"
          className="account-cards-add"
          onClick={() => setAddOpen(true)}
          aria-label="Add an account"
          data-testid="account-add-open"
        >
          +
        </button>

        {showControls && (
          <>
            <button
              type="button"
              className="account-cards-arrow account-cards-arrow--prev"
              onClick={() => scrollToIndex(Math.max(0, scrollIndex - 1))}
              disabled={scrollIndex <= 0}
              aria-label="Previous account"
            >
              ‹
            </button>
            <button
              type="button"
              className="account-cards-arrow account-cards-arrow--next"
              onClick={() => scrollToIndex(Math.min(accounts.length - 1, scrollIndex + 1))}
              disabled={scrollIndex >= accounts.length - 1}
              aria-label="Next account"
            >
              ›
            </button>
          </>
        )}
      </div>

      {showControls && (
        <div className="account-cards-dots">
          {accounts.map((acc, index) => (
            <button
              key={acc.id}
              type="button"
              className={`account-cards-dot ${index === scrollIndex ? 'is-current' : ''}`}
              aria-label={`Go to ${acc.label || shortAccountAddr(acc.address)}${ACCOUNT_KIND_TAG[acc.kind] ? ` (${ACCOUNT_KIND_TAG[acc.kind]})` : ''}`}
              aria-current={index === scrollIndex ? 'true' : undefined}
              onClick={() => scrollToIndex(index)}
            />
          ))}
        </div>
      )}

      <AccountCustomizeSheet
        open={Boolean(customizeTarget)}
        onClose={() => setCustomizeTarget(null)}
        account={customizeTarget}
      />

      {/* Mounted only while open: the sheet navigates (useNavigate), and the carousel itself
          must keep rendering outside a router context (its unit tests do exactly that). */}
      {addOpen && <AccountAddSheet open onClose={() => setAddOpen(false)} />}

      {/* Spec 088: switching is instant and address-only — ceremonies render from the
          global SignerRequestHost at send time. */}
    </section>
  )
}

export default AccountCardsCarousel
