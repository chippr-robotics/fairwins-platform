import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useNavDrawer } from '../../contexts/NavDrawerContext.js'
import { useIsMobile } from '../../hooks/useMediaQuery'
import PortalNav from '../ui/PortalNav'
import NavIcon from './NavIcon'
import PinnedAppsStrip from './PinnedAppsStrip'
import Footer from '../Footer'
import {
  HOME_ITEM,
  PORTFOLIO_ITEM,
  WAGERS_VIEW,
  NAV_GROUPS,
  pathForNavItem,
  visibleNavGroups,
  isNavItemEnabledForTenant,
  TAB_ALIASES,
} from '../../config/appNav'
import { useChainTokens } from '../../hooks/useChainTokens'
import { collectiblesGatewayUrl } from '../../lib/collectibles/gatewayClient'
import { predictGatewayUrl } from '../../lib/predict/predictClient'
import { loadFavoriteApps, subscribeFavoriteApps } from '../../lib/miniapps/favorites'
import { adminAppIdFromFavoriteId, adminToolGlyph } from '../admin/adminToolCatalog'
import { filterNavGroups, filterNavItems } from '../../lib/nav/filterNav'
import {
  NAV_ITEM_TERMS,
  OFF_MENU_ITEMS,
  OFF_MENU_GROUP_LABEL,
  destinationsForNavItem,
  destinationById,
  pathForDestination,
} from '../../config/navSearchIndex'
import {
  sectionKey,
  isSectionExpanded,
  toggleSection,
  loadNavDensity,
  subscribeNavPreferences,
} from '../../lib/nav/navPreferences'
import './AppNavDrawer.css'

// Renamed tabs resolve through the shared `TAB_ALIASES` map (config/appNav.js), so the drawer
// highlights the right entry for a legacy deep link without keeping its own copy of the renames.
//
// Spec 073 (FR-009) — what the mini-app map below deliberately does NOT contain yet. The Apps group
// collapsed to the single mini-app catalog entry, so ClearPath and Token Mint no longer
// appear in this menu; their `?tab=clearpath` / `?tab=tokens` deep links keep resolving to
// the host-native panels WalletPage still renders, unchanged. They become aliases to the
// mini-app routes — `tokens` → `/apps/token-mint` (T027) and `clearpath` → `/apps/clearpath`
// (T029) — only in the conversion tasks that actually publish those packages, and not
// before: an alias pointing at a mini-app nobody has registered turns a working deep link
// into a dead end, and the catalog would be claiming a verified package that does not exist.
// Wagers is NOT in that map and never will be — it did not become a package (see WAGERS_VIEW in
// config/appNav.js); it moved into Finance ▸ Transfer, and `/wagers` redirects there from App.jsx.

/**
 * Tabs that have become mini-apps (spec 073 T027) — kept in parity with the same map in
 * `pages/WalletPage.jsx`, which performs the actual redirect. Here it only affects which nav item
 * reads as active, so a member arriving on `?tab=tokens` sees Apps highlighted rather than nothing.
 */
const TAB_TO_MINIAPP = { tokens: 'apps', clearpath: 'apps' }

// The drawer list = a top "Quick Access" group (Payments, Accounts — HOME_ITEM and PORTFOLIO_ITEM,
// whose ids stay 'home'/'portfolio' because they are route identity) + the section groups. Built per
// render because item visibility is chain-aware (spec 055: Collectibles hides entirely on
// networks OpenSea doesn't serve or with no gateway configured).
//
// Favorited mini-apps used to be spliced into Quick Access here as full-width rows. Since spec
// 081 they render as a separate horizontal strip above this list instead — pins are unbounded,
// and the section meant to be the member's shortcut strip was the section pushing every other
// group off the bottom of a phone screen. Payments and Accounts stay as rows: they are destinations
// the product ships, not shortcuts the member chose.
//
// Wagers used to be spliced into the Apps group here, because it was an absolute `/wagers` route
// rather than a `/wallet?tab=` section and so was not carried by NAV_GROUPS' tenant filter. That
// splice is gone: Wagers is now a view inside Finance ▸ Transfer (spec 073), reached through the
// Transfer entry NAV_GROUPS already carries, and gated by PayTransferPanel on the same `wagers`
// tenant feature. One fewer place for the menu and the routes to disagree.
function buildDrawerGroups(visibility) {
  // The Apps catalog entry is the door to the whole mini-app platform, and sitting at the
  // bottom of Tools it read as an afterthought. The DRAWER hoists it into Quick Access;
  // NAV_GROUPS still carries it under Tools for every other consumer (sibling icon nav,
  // search index, WalletPage), so this is drawer presentation, not nav structure — and the
  // tenant filter has already run by the time we look for it, so a build without the
  // mini-app platform hoists nothing.
  let appsItem = null
  const sectionGroups = visibleNavGroups(visibility, NAV_GROUPS)
    .map((group) => {
      const items = group.items.filter((item) => {
        if (item.id === 'apps') {
          appsItem = item
          return false
        }
        return true
      })
      return { ...group, items }
    })
    .filter((group) => group.items.length > 0)
  return [
    { label: 'Quick Access', items: [HOME_ITEM, PORTFOLIO_ITEM, ...(appsItem ? [appsItem] : [])] },
    ...sectionGroups,
  ]
}

// `favorites.js` entries -> drawer items. `showIcon` opts into PortalNav's initial-letter fallback
// (the on-chain registry carries no app icon, so the first letter of its name stands in for one,
// same as any other icon-less drawer entry would in the collapsed rail) so a favorited app is
// recognisable at a glance in the EXPANDED menu too, not just the icon-only gutter.
// `slug` rides along so the pinned strip can look up the SAME curated store artwork the catalog
// card shows (spec 077 `artworkFor`) — a shortcut should look like the thing it launches.
//
// Pinned ADMIN TOOLS (spec 093 follow-up) ride the same strip: their id names the admin app, the
// destination is its /admin address, and the tile shows the tool's own NavIcon glyph rather than
// store artwork (there is no registry record to have artwork). Only an operator could ever have
// pinned one — the store's pin control derives from role flags — and if the role is later revoked
// the shortcut still lands on the /admin gate's honest denial, exactly like a typed URL.
function favoriteToNavItem(favorite) {
  const adminAppId = adminAppIdFromFavoriteId(favorite.id)
  if (adminAppId) {
    return {
      id: `favorite-${favorite.id}`,
      label: favorite.name,
      glyph: adminToolGlyph(favorite.id),
      to: `/admin/${adminAppId}`,
      showIcon: true,
    }
  }
  return {
    id: `favorite-${favorite.id}`,
    label: favorite.name,
    slug: favorite.slug,
    to: `/apps/${favorite.slug}`,
    showIcon: true,
  }
}

// Which drawer entry reflects the current route, so the open menu highlights it.
function resolveActiveId(location, favoriteItems) {
  const { pathname, search } = location
  if (pathname === '/wallet') {
    const requested = new URLSearchParams(search).get('tab')
    if (TAB_TO_MINIAPP[requested]) return TAB_TO_MINIAPP[requested]
    return TAB_ALIASES[requested] || requested
  }
  if (pathname === '/app' || pathname === '/main' || pathname === '/fairwins') {
    return HOME_ITEM.id
  }
  // `/wagers` redirects to the Transfer section (App.jsx). Resolved here anyway so the menu
  // highlights Transfer for the render that happens BEFORE the redirect commits, rather than
  // flashing nothing selected.
  if (pathname === '/wagers') {
    return WAGERS_VIEW.tab
  }
  // A mounted mini-app (`/apps/<slug>`, spec 073) IS the Apps section — the workspace is
  // where a catalog launch lands. A favorited app highlights its OWN Quick Access shortcut
  // instead, so the member sees exactly which shortcut brought them here; everything else
  // falls back to the catalog entry, so nothing is left unselected for the entire time an app
  // is open. The trailing slash is part of the match so a future top-level route that merely
  // starts with those letters cannot borrow the highlight.
  if (pathname === '/apps' || pathname.startsWith('/apps/')) {
    const slug = pathname === '/apps' ? '' : pathname.slice('/apps/'.length)
    const favoriteMatch = favoriteItems.find((item) => item.to === `/apps/${slug}`)
    return favoriteMatch ? favoriteMatch.id : 'apps'
  }
  // An open admin tool highlights its own pinned shortcut (spec 093 follow-up) — and only that:
  // the operations area is deliberately not a nav section, so with no matching pin nothing in
  // this menu claims it.
  if (pathname.startsWith('/admin')) {
    const favoriteMatch = favoriteItems.find((item) => item.to === pathname)
    return favoriteMatch ? favoriteMatch.id : null
  }
  return null
}

/**
 * AppNavDrawer — the global left navigation ("us"). On mobile it's a slide-over
 * drawer opened by the clover logo, exactly as before. On larger screens it's
 * always visible as a persistent icon-only gutter (no page content renders
 * under it — see the `.app-shell` padding in this file's CSS) that expands in
 * place to the full labelled panel; it never fully hides on desktop, so a
 * section is always one click away. Selecting an entry routes to the section
 * and returns to the gutter; the copyright footer only fits once expanded (the
 * legal/policy links that used to sit here moved to Settings → App, issue #1025).
 *
 * Spec 081 shapes the EXPANDED panel so its height is bounded by design: sections fold, pinned
 * apps are one capped strip rather than unbounded rows, a sticky field filters across the whole
 * menu, and a device preference tightens the rows. The collapsed desktop gutter is untouched by
 * all of it — 64px has no room for a heading, a field, or a strip, and every section's glyph
 * must stay reachable there.
 *
 * That field searches the APP, not the twelve words printed on the menu. It reads the nav search
 * index (config/navSearchIndex.js), which tags every section with the protocols and services it
 * holds and names the sub-surfaces inside it — so "morpho" finds Earn and offers Earn ▸ Lend,
 * "rpc" reaches Network even though Network is not in this menu, and "bip39" reaches the Legacy
 * account recovery card inside Recovery. Selecting one of those shortcuts navigates to its own
 * deep link carrying `focus=<id>`, and the surface it lands on flashes itself into view
 * (components/nav/AttentionFocus.jsx) so the member can see which thing they were looking for.
 */
export default function AppNavDrawer() {
  const { isOpen, close, toggle } = useNavDrawer()
  const navigate = useNavigate()
  const location = useLocation()
  const { capabilities } = useChainTokens()
  const isMobile = useIsMobile()
  const drawerRef = useRef(null)

  // Favorited mini-apps (App Store quick-access). REGISTRY pins are gated on the `apps` tenant
  // feature so a build that has disabled the mini-app platform never surfaces a shortcut into it,
  // even if a favorite was saved on this device before the tenant config changed. ADMIN TOOL pins
  // (spec 093 follow-up) are deliberately NOT behind that feature: the operations console exists
  // on every tenant, and only an operator's own pinning ever created one.
  const [favorites, setFavorites] = useState(() => loadFavoriteApps())
  useEffect(() => subscribeFavoriteApps(() => setFavorites(loadFavoriteApps())), [])
  const favoriteItems = useMemo(() => {
    const registryEnabled = isNavItemEnabledForTenant('apps')
    return favorites
      .filter((fav) => registryEnabled || adminAppIdFromFavoriteId(fav.id))
      .map(favoriteToNavItem)
  }, [favorites])

  // Section folds and row density are device-scoped preferences that can also be changed from
  // the Preferences panel, so the drawer re-reads them on every store commit rather than owning
  // the state itself (same subscribe idiom as favorites, above).
  const [prefsRevision, bumpPrefs] = useState(0)
  useEffect(() => subscribeNavPreferences(() => bumpPrefs((n) => n + 1)), [])
  const density = loadNavDensity()

  // A filter is per-open, never persisted: a member who typed "rec" last week did not ask for a
  // narrowed menu today. Cleared whenever the drawer opens.
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (isOpen) setQuery('')
  }, [isOpen])

  const activeId = resolveActiveId(location, favoriteItems)
  const allGroups = useMemo(
    () =>
      buildDrawerGroups({
        collectibles: Boolean(capabilities?.collectibles) && collectiblesGatewayUrl() !== '',
        predict: Boolean(capabilities?.predict) && predictGatewayUrl() !== '',
      }),
    [capabilities],
  )

  const filtering = query.trim() !== ''

  /*
   * What a query is allowed to reach.
   *
   * Resting, the menu is exactly the menu: the groups above, nothing else. While a filter is
   * active it also spans the sections that live on the account button — Settings, Network,
   * Membership, My Account (config/appNav.js keeps them out of this menu on purpose). Typing
   * "rpc" or "notifications" is a question, not browsing, and answering it with "no matches"
   * while the app plainly has that screen is the search failing at its one job. They leave again
   * with the filter, so the resting drawer's height is unchanged (spec 081).
   */
  const searchableGroups = useMemo(
    () => (filtering ? [...allGroups, { label: OFF_MENU_GROUP_LABEL, items: OFF_MENU_ITEMS }] : allGroups),
    [allGroups, filtering],
  )

  // Cross-surface indexing: an item answers to its own synonyms, and to everything inside it. The
  // index is looked up per item rather than searched globally, so a section hidden by the tenant
  // or the active chain can never contribute a shortcut — it was already filtered out above.
  const searchOptions = useMemo(
    () => ({
      termsFor: (item) => NAV_ITEM_TERMS[item.id],
      destinationsFor: (item) => destinationsForNavItem(item.id),
    }),
    [],
  )

  const drawerGroups = useMemo(
    () => filterNavGroups(searchableGroups, query, searchOptions),
    [searchableGroups, query, searchOptions],
  )
  const visibleFavorites = useMemo(() => filterNavItems(favoriteItems, query), [favoriteItems, query])

  // Desktop never fully closes: `collapsed` is the icon gutter, `isOpen` is the
  // expanded panel. Mobile keeps the original fully-hidden/fully-open pair.
  const collapsed = !isMobile && !isOpen

  // The section that owns the highlighted item, so it can be force-expanded below.
  const activeGroupKey = useMemo(() => {
    const owner = allGroups.find((group) => group.items.some((item) => item.id === activeId))
    return owner ? sectionKey(owner.label) : null
  }, [allGroups, activeId])

  /*
   * Effective expansion, computed per render and NEVER written back:
   *   filter active  > the section owning the current page > the member's stored choice.
   *
   * A filter is a statement about the RESULT SET — a match hidden inside a fold would make the
   * drawer report fewer hits than it found. And the item marked as the current page must never be
   * invisible. Both are overrides of what to DISPLAY; folding Tools while sitting on Recovery is
   * still remembered for when the member leaves it.
   */
  const expandedSections = useMemo(() => {
    const out = {}
    for (const group of drawerGroups) {
      const key = sectionKey(group.label)
      out[key] = filtering || key === activeGroupKey || isSectionExpanded(key)
    }
    return out
    // `prefsRevision` is the store's change signal — `isSectionExpanded` reads a module-level
    // snapshot the linter cannot see, so the revision is what makes this memo re-run on a toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerGroups, filtering, activeGroupKey, prefsRevision])

  const collapsibleGroups = useMemo(
    () => ({
      expanded: expandedSections,
      keyFor: (group) => sectionKey(group.label),
      onToggle: (key) => toggleSection(key),
    }),
    [expandedSections],
  )

  // Close on Escape while open.
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, close])

  // Desktop's expanded panel has no modal backdrop (the gutter beside it stays
  // usable), so a click outside it collapses back to the gutter instead.
  useEffect(() => {
    if (!isOpen || isMobile) return
    const onPointerDown = (event) => {
      if (drawerRef.current && !drawerRef.current.contains(event.target)) {
        close()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [isOpen, isMobile, close])

  const handleSelect = useCallback(
    (id) => {
      const favorite = favoriteItems.find((item) => item.id === id)
      // A search shortcut carries its own deep link (and the `focus=` marker that makes the
      // surface it lands on flash), so it is resolved before the section-id route helper — which
      // would otherwise turn `earn-lend` into a `?tab=earn-lend` that resolves to nothing.
      const destination = destinationById(id)
      const to = favorite ? favorite.to : destination ? pathForDestination(destination) : pathForNavItem(id)
      navigate(to)
      setQuery('')
      close()
    },
    [favoriteItems, navigate, close],
  )

  // Mobile: always fully closes. Desktop: flips between gutter and expanded.
  const handleToggleClick = () => {
    if (isMobile) close()
    else toggle()
  }

  return (
    <>
      {isOpen && isMobile && (
        <button
          type="button"
          className="app-nav-backdrop"
          aria-label="Close menu"
          onClick={close}
        />
      )}
      <aside
        ref={drawerRef}
        id="app-nav-drawer"
        className={`app-nav-drawer ${isOpen ? 'open' : ''} ${collapsed ? 'collapsed' : ''} ${
          density === 'compact' ? 'app-nav-drawer--compact' : ''
        }`}
        // `inert`, NOT `aria-hidden`. The closed mobile drawer is translated off-canvas but
        // its buttons stay in the DOM and in the tab order, so `aria-hidden` claimed the
        // subtree was hidden from assistive technology while a real, focusable control sat
        // inside it — and the browser refuses that combination outright ("Blocked aria-hidden
        // on an element because its descendant retained focus"), leaving the region exposed
        // after all. `inert` states the same intent and actually enforces it: the subtree is
        // removed from the accessibility tree AND from focus, so a keyboard user cannot tab
        // into a panel they cannot see. React 19 renders it as a real boolean attribute.
        inert={isMobile && !isOpen}
        aria-label="Site navigation"
      >
        <div className="app-nav-drawer-header">
          {!collapsed && <span className="app-nav-drawer-title">Menu</span>}
          <button
            type="button"
            className="app-nav-drawer-toggle"
            aria-label={collapsed ? 'Expand menu' : 'Close menu'}
            onClick={handleToggleClick}
          >
            {collapsed ? <NavIcon name="menu" /> : <span aria-hidden="true">✕</span>}
          </button>
        </div>

        {!collapsed && (
          <div className="app-nav-search">
            <label className="app-nav-search-label" htmlFor="app-nav-search-input">
              Filter menu
            </label>
            <div className="app-nav-search-field">
              <input
                id="app-nav-search-input"
                type="search"
                className="app-nav-search-input"
                placeholder="Search the app — try “morpho”"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {filtering && (
                <button
                  type="button"
                  className="app-nav-search-clear"
                  aria-label="Clear menu filter"
                  onClick={() => setQuery('')}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              )}
            </div>
          </div>
        )}

        {!collapsed && (
          <PinnedAppsStrip items={visibleFavorites} activeId={activeId} onSelect={handleSelect} />
        )}

        <PortalNav
          variant="nav"
          groups={drawerGroups}
          activeId={activeId}
          onSelect={handleSelect}
          ariaLabel="Site sections"
          collapsed={collapsed}
          collapsibleGroups={collapsibleGroups}
          emptyMessage={
            filtering && visibleFavorites.length === 0 ? `No menu entries match “${query.trim()}”` : undefined
          }
        />

        {!collapsed && <Footer variant="drawer" />}
      </aside>
    </>
  )
}
