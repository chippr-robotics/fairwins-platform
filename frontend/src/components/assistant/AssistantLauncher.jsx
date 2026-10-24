/**
 * AssistantLauncher (specs 095 + 104) — the floating button that opens the assistant.
 *
 * Mounted once in `App.jsx`'s `AppLayout`, beside `AppNavDrawer`: the only place that renders on
 * every in-app route and on no landing or legal page.
 *
 * IT RENDERS NOTHING UNLESS ALL OF THIS IS TRUE, in this order — cheapest first, and the order is
 * why the expensive one is last:
 *   1. the tenant enables the `assistant` feature,
 *   2. a wallet is connected,
 *   3. this account has opted in (default OFF),
 *   4. SOMETHING CAN ANSWER: a saved GutterToken key on the GutterToken preference, OR an active,
 *      READABLE membership (research § 4.4 — `key ∨ membership`, short-circuiting).
 * Membership is a chain read, so it is gated behind everything that can be decided from local
 * state: a member with a key on the GutterToken rail NEVER pays the RPC call, which is why the
 * membership hook lives in a child component that the key path does not mount at all. The
 * decision itself belongs to `resolveProvider`; this component only orders the two evaluations.
 *
 * THE THREE MEMBERSHIP STATES COLLAPSE TO "NOTHING" HERE, AND THAT IS DELIBERATE. Pending renders
 * nothing (a button that appears a second late is better than one that appears and then vanishes);
 * UNREADABLE also renders nothing — never a denial, never a toast. An entry point is not the place
 * to tell someone their RPC is slow.
 *
 * POSITIONING. `z-index: 1300` — above the fixed bottom nav (1200), below the drawer backdrop
 * (1400), so an open menu is never covered. The bottom offset is MEASURED
 * (`lib/assistant/useBottomNavOffset`) because the bottom nav is absent on several screens and its
 * height is not a token; the safe-area inset is added only when the nav is absent, because the nav's
 * own padding already contains it. Anchored right, so the desktop 64px nav gutter is irrelevant.
 *
 * BEHAVIOUR. It fades and slides down while the member scrolls DOWN through content, returns on any
 * upward scroll or after a short idle, and hides outright while the nav drawer or its own panel is
 * open. Every transition is ≤ 250ms and `prefers-reduced-motion: reduce` removes the movement
 * (opacity only) — see AssistantLauncher.css.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useWallet } from '../../hooks/useWalletManagement'
import { useNavDrawer } from '../../contexts/NavDrawerContext.js'
import useRoleDetails from '../../hooks/useRoleDetails'
import { isFeatureEnabled } from '../../config/tenant'
import NavIcon from '../nav/NavIcon'
import { isAssistantEnabled, subscribeAssistantPrefs } from '../../lib/assistant/assistantPrefs'
import { subscribeGutterTokenKey } from '../../lib/assistant/guttertokenKeyStore'
import { resolveProvider } from '../../lib/assistant/resolveProvider'
import { clearSession } from '../../lib/assistant/assistantClient'
import { useBottomNavOffset } from '../../lib/assistant/useBottomNavOffset'
import AssistantPanel from './AssistantPanel'
import './AssistantLauncher.css'

/** Scroll distance before the launcher reacts — below this, ordinary jitter would flicker it. */
const SCROLL_THRESHOLD_PX = 24
/** How long after the last scroll the launcher comes back on its own. */
const IDLE_RETURN_MS = 1200

export default function AssistantLauncher() {
  const { address: account, isConnected } = useWallet()

  // The preference and the key live outside React state (wallet-scoped stores shared with the
  // Assistant tab), so subscribe rather than poll.
  const [, bump] = useState(0)
  useEffect(() => subscribeAssistantPrefs(() => bump((n) => n + 1)), [])
  useEffect(() => subscribeGutterTokenKey(() => bump((n) => n + 1)), [])

  // The session token is held in module memory; an account change must not leave the previous
  // account's credential loaded.
  useEffect(() => {
    clearSession()
    return () => clearSession()
  }, [account])

  if (!isFeatureEnabled('assistant')) return null
  if (!isConnected || !account) return null
  if (!isAssistantEnabled(account)) return null

  // The cheap half of the disjunction: resolved with membership UNKNOWN. If local state alone
  // already yields a rail (a saved key on the GutterToken preference), the membership read is
  // never mounted. Anything else — including "pending" — goes to the half that reads the chain.
  const local = resolveProvider({ account, membership: null })
  if (local.provider === 'guttertoken') return <Launcher />

  return <MemberLauncher />
}

/**
 * The half that costs a membership read. Split out so the hook only ever mounts for an account
 * that has opted in AND has no local rail — `useRoleDetails` resolves the ACTING account itself,
 * so this takes no props.
 */
function MemberLauncher() {
  const { address: account } = useWallet()
  const { getRoleDetails, refresh } = useRoleDetails()
  const membership = getRoleDetails('WAGER_PARTICIPANT')

  // Pending (null) and unreadable both render nothing. Unreadable is NOT a denial — it is simply not
  // an answer, and an entry point is the wrong place to say so. `resolveProvider` returns no
  // provider for either, so both fall through the same gate as "not a member, no key".
  const { provider } = resolveProvider({ account, membership })
  if (!provider) return null

  return <Launcher membership={membership} onRetryMembership={refresh} />
}

/** The button itself plus its panel. `membership` is `undefined` on the key path, and the panel
 *  reads it for itself when opened — the grant offer needs it; the entry point does not. */
function Launcher({ membership, onRetryMembership = null }) {
  const { isOpen: drawerOpen } = useNavDrawer()
  const { offset, navPresent } = useBottomNavOffset()

  const [panelOpen, setPanelOpen] = useState(false)
  const [scrolledAway, setScrolledAway] = useState(false)
  const lastY = useRef(typeof window === 'undefined' ? 0 : window.scrollY)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let idle = 0
    const onScroll = () => {
      const y = window.scrollY
      const delta = y - lastY.current
      if (Math.abs(delta) >= SCROLL_THRESHOLD_PX) {
        lastY.current = y
        setScrolledAway(delta > 0 && y > SCROLL_THRESHOLD_PX)
      }
      clearTimeout(idle)
      // Coming back on idle matters more than it sounds: a member who scrolls to the bottom of a
      // long screen and stops is exactly the person about to ask a question.
      idle = setTimeout(() => setScrolledAway(false), IDLE_RETURN_MS)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      clearTimeout(idle)
    }
  }, [])

  const close = useCallback(() => setPanelOpen(false), [])

  const hidden = drawerOpen || panelOpen || scrolledAway

  return (
    <>
      <button
        type="button"
        className={`assistant-launcher${hidden ? ' assistant-launcher--hidden' : ''}`}
        style={{
          // The nav's own padding already carries the safe-area inset, so adding it again while the
          // nav is present would double-count it on exactly the devices that have one.
          bottom: navPresent ? `${offset}px` : `calc(${offset}px + env(safe-area-inset-bottom, 0px))`,
        }}
        onClick={() => setPanelOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        aria-label="Open the FairWins assistant"
        data-testid="assistant-launcher"
        // Hidden means hidden: an off-screen control must not stay in the tab order.
        tabIndex={hidden ? -1 : 0}
        aria-hidden={hidden ? 'true' : undefined}
      >
        <NavIcon name="chat" size={22} />
      </button>
      <AssistantPanel
        open={panelOpen}
        onClose={close}
        surface={typeof window !== 'undefined' ? window.location.pathname : null}
        membership={membership}
        onRetryMembership={onRetryMembership}
      />
    </>
  )
}

Launcher.propTypes = {
  membership: PropTypes.shape({ isActive: PropTypes.bool, readable: PropTypes.bool }),
  onRetryMembership: PropTypes.func,
}
