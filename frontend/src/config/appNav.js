/**
 * Shared app-navigation model for the redesigned nav shell.
 *
 * One source of truth consumed by three surfaces:
 *   - AppNavDrawer      — the global left drawer opened by the clover logo ("us")
 *   - SectionIconNav    — the mobile bottom icon bar for quick sub-section switching
 *   - WalletPage        — hosts the section panels, keyed by the same tab ids
 *
 * Every section item routes to `/wallet?tab=<id>` (the panels render there); the
 * Home entry is the dashboard. Account / Membership / Network / Settings
 * intentionally live on the account button (top right), NOT in this menu, so they
 * are absent from the groups below.
 */

// Quick-access entry pinned to the top of the drawer list. `icon` is a NavIcon
// name (see components/nav/NavIcon.jsx) — flat line glyphs, not emoji.
//
// The LABEL is "Payments" and the id stays 'home': the dashboard is where a member pays and gets
// paid, and the menu should say what the destination does rather than where it sits in the route
// table. Renaming the id would break `/app`, the landing-view preference, saved deep links and
// every `pathForNavItem('home')` caller for a wording change, so ids here are route identity and
// labels are member-facing copy — they are deliberately allowed to differ. `navSearchIndex.js`
// keeps 'home' as a search term so the old name still finds it.
export const HOME_ITEM = { id: 'home', label: 'Payments', icon: 'home', to: '/app' }

// Accounts — pinned into Quick Access alongside Payments (not a Finance section
// item). It is now a VIEW inside the unified My Account experience rather than
// its own `?tab=` (the account carousel + bottom view nav host it), so the item
// keeps its 'portfolio' id but routes to `/wallet?tab=account&view=portfolio`
// via pathForNavItem; the old `?tab=portfolio` deep link redirects there
// (WalletPage TAB_REDIRECTS). Same id/label split as HOME_ITEM above: the drawer
// says "Accounts" (what the member finds there — their accounts and what they
// hold), the route keeps saying `portfolio`.
export const PORTFOLIO_ITEM = { id: 'portfolio', label: 'Accounts', icon: 'trending' }

/*
 * My Account views — the unified account experience (account card carousel on
 * top, one of these views below, switched by a bottom nav on mobile and a tab
 * strip on desktop). Lives on the Account tab as `?view=` so
 * `/wallet?tab=account&view=portfolio` is a direct link and back/forward keep
 * working (the PayTransferPanel idiom). Defined here — not in the panel — so
 * WalletPage's bottom icon bar and MyAccountView can never disagree on the ids.
 * `icon` is a NavIcon name.
 */
export const ACCOUNT_VIEWS = [
  // Portfolio first — the default view (post-launch feedback on spec 074):
  // what a member owns is the first thing they look for under their cards.
  { id: 'portfolio', label: 'Portfolio', icon: 'trending' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
  { id: 'stats', label: 'Stats', icon: 'reports' },
]

export const ACCOUNT_DEFAULT_VIEW = 'portfolio'

/** Resolve a raw `?view=` param to a known account view (unknown/missing → default). */
export function accountViewFromParam(param) {
  return ACCOUNT_VIEWS.some((v) => v.id === param) ? param : ACCOUNT_DEFAULT_VIEW
}

/** The canonical location of the Portfolio view — the one place that URL is spelled out. */
export const PORTFOLIO_PATH = '/wallet?tab=account&view=portfolio'

/*
 * Wagers — a VIEW inside Finance ▸ Transfer, not a nav item of its own.
 *
 * It was an absolute `/wagers` route spliced into the drawer's Apps group (spec 053), and spec 073
 * planned to convert it into a mini-app package (T030–T033). Both are now superseded: creating a
 * wager is moving money to a counterparty under conditions, which is the same family of action as
 * a same-chain send and a cross-network bridge — so it belongs BESIDE them, as a third view of the
 * Transfer section, rather than as a separate destination members have to know to go looking for.
 *
 * It is deliberately NOT re-added to `RAW_NAV_GROUPS`: a nav ITEM is a section, and a section owns
 * a `?tab=`. Wagers owns a `?view=` within one. `groupForTab('wagers')` therefore stays null (no
 * mobile bottom bar claims it as a sibling), and the only thing this constant governs is where
 * `pathForNavItem('wagers')` and the legacy `/wagers` redirect point.
 *
 * `tab` is the section that hosts it; `view` is PayTransferPanel's own `?view=` id. Both live here
 * so the route helper, the redirect, and the panel cannot drift into disagreeing about the URL.
 */
export const WAGERS_VIEW = { id: 'wagers', label: 'Wagers', tab: 'paytransfer', view: 'wagers' }

/*
 * Legacy deep-link aliases → canonical tab ids.
 *
 * A tab that gets RENAMED keeps answering to its old id, so saved links and bookmarks keep
 * resolving: the Swap tab is now "Trade", the standalone Backup tab folded into "Recovery", and
 * Preferences is now "Settings" (the app's global settings surface, which it already was).
 *
 * This lived as two private copies — one in `pages/WalletPage.jsx`, which resolves the tab, and one
 * in `components/nav/AppNavDrawer.jsx`, which highlights the matching drawer entry — each carrying
 * a comment asking the other to be kept in parity. They drifted the first time an id was renamed.
 * A comment is not a mechanism; one exported map is.
 */
export const TAB_ALIASES = { swap: 'trade', backup: 'security', preferences: 'settings' }

/** The canonical location of the Wagers view — the one place that URL is spelled out. */
export const WAGERS_PATH = `/wallet?tab=${WAGERS_VIEW.tab}&view=${WAGERS_VIEW.view}`

/**
 * The canonical location of the Wrap view (release 1.14.0): Wrap moved from the Transfer section
 * into Trade, beside Swap — wrapping changes the FORM of the coin you hold, not where the money
 * is, and it is what a member needs immediately before a DEX. The old
 * `?tab=paytransfer&view=wrap` deep link redirects here (PayTransferPanel owns that redirect, the
 * same way App.jsx's `/wagers` route redirects into Transfer), and both point at THIS constant so
 * the redirect and the Trade section cannot drift into disagreeing about the URL.
 */
export const TRADE_WRAP_PATH = '/wallet?tab=trade&view=wrap'

import { isFeatureEnabled } from './tenant'

// Tenant feature gating (spec 072 T019/FR-002): nav item id -> manifest feature id.
// Items not listed are core platform surfaces every tenant gets (transfer,
// address book, reporting). A feature the tenant does not enable is ABSENT from
// nav and groups — never present-but-broken. The default tenant enables every
// feature, so its nav is unchanged.
const NAV_FEATURE_IDS = {
  // Still listed although Wagers is no longer a nav item: the id → feature mapping stays in one
  // place, and PayTransferPanel asks `isNavItemEnabledForTenant('wagers')` before offering the
  // view — so a tenant without wagers gets no Wagers tab and `?view=wagers` falls back to Transfer.
  wagers: 'wagers',
  earn: 'earn',
  trade: 'swap',
  collectibles: 'collect',
  predict: 'predict',
  custody: 'protect',
  security: 'recovery',
  // Apps (spec 073) — the mini-app catalog as a whole. A tenant that has not enabled
  // 'miniapps' gets no Apps group, no `?tab=apps` panel, and no catalog: the platform
  // is optional infrastructure, not a surface every tenant inherits.
  apps: 'miniapps',
  // ClearPath and Token Mint are no longer nav items (spec 073 FR-009 collapsed the Apps
  // group to the catalog entry above), but their tab ids still resolve as deep links and
  // their per-app feature ids still govern their first-party catalog entries once they are
  // published as packages (research R9). Kept here so the id → feature mapping stays in
  // one place rather than being re-derived at each conversion.
  clearpath: 'clearpath',
  tokens: 'token-mint',
  // Assistant (spec 104) — the agent controls tab. Same feature id the launcher already gates on,
  // so a tenant without the assistant has no tab, no launcher and no `?tab=assistant` panel.
  assistant: 'assistant',
}

export function isNavItemEnabledForTenant(id) {
  const featureId = NAV_FEATURE_IDS[id]
  return featureId ? isFeatureEnabled(featureId) : true
}

// Grouped section rail. `id` matches the WalletPage tab id; `icon` drives both
// the drawer and the mobile bottom nav. Defined raw, then filtered to the
// active tenant's feature set below.
const RAW_NAV_GROUPS = [
  {
    label: 'Finance',
    items: [
      // Earn — lending & rewards (spec 050). Always present; the panel
      // self-discloses per-network availability.
      { id: 'earn', label: 'Earn', icon: 'sprout' },
      { id: 'trade', label: 'Trade', icon: 'trade' },
      // Collectibles (spec 055) — read-only NFT display. Unlike Earn, this item HIDES
      // entirely on networks without the capability (FR-007); consumers filter via
      // visibleNavGroups with { collectibles: collectiblesAvailable(chainId) }.
      { id: 'collectibles', label: 'Collect', icon: 'gem' },
      // Predict (spec 057) — Polymarket prediction-market trading. Like Collect, it HIDES entirely on
      // networks without the capability (Polygon-only, FR-018); consumers filter via visibleNavGroups
      // with { predict: capabilities.predict && predictGatewayUrl() !== '' }.
      { id: 'predict', label: 'Predict', icon: 'predict' },
      // 'paytransfer' tab id preserved (deep links / saved routes keep resolving,
      // spec 067 FR-002); surfaced to users as "Transfer".
      { id: 'paytransfer', label: 'Transfer', icon: 'transfer' },
    ],
  },
  {
    label: 'Tools',
    items: [
      // 'custody' tab id preserved; surfaced to users as "Protect". Lives in
      // Tools (not Finance) — it is an account-security tool, not a spending
      // surface (spec 068 FR-024).
      { id: 'custody', label: 'Protect', icon: 'shield' },
      { id: 'addressbook', label: 'Address Book', icon: 'addressbook' },
      // Recovery — data backup, account controllers, legacy key/word-list
      // recovery, and encryption keys, combined into one panel (tab id
      // 'security', kept stable). The old 'backup' tab id is a deep-link alias
      // (see TAB_ALIASES above).
      { id: 'security', label: 'Recovery', icon: 'lock' },
      { id: 'reports', label: 'Reporting', icon: 'reports' },
      // Apps (spec 073 FR-009) — ONE entry for the whole mini-app catalog, replacing the
      // hardcoded per-app items the nav used to carry (ClearPath, Token Mint). The section
      // is no longer a fixed list the host ships: which apps exist is decided by the on-chain
      // registry, so the nav can only name the door, not the rooms behind it. `?tab=apps`
      // renders CatalogPanel (what the registry says is launchable); launching mounts the
      // verified package at the absolute route `/apps/<slug>` (MiniAppWorkspace).
      //
      // It sits in TOOLS rather than owning a group (spec 081). Since 073 collapsed the Apps
      // group to this single entry, a group of its own bought a heading, a rule and — once
      // sections became accordions — a whole fold, all to hold one row. A heading whose group
      // can never gain a second member is chrome, not structure. The `apps` tab id and the
      // `/apps/<slug>` routes are unchanged, so every deep link keeps resolving.
      //
      // ClearPath and Token Mint keep their `?tab=clearpath` / `?tab=tokens` panels and deep
      // links exactly as they are today — they are simply no longer surfaced here. They become
      // aliases to `/apps/<slug>` only in the conversion tasks that actually publish those
      // packages (T027 token-mint, T029 clearpath; Wagers last, T033). Pointing the nav at a
      // mini-app that has not been registered would make the catalog claim a verified package
      // exists when none does — the one thing this surface must never do.
      { id: 'apps', label: 'Apps', icon: 'grid' },
      // Assistant (spec 104) — the AGENT controls: which rail answers (FairWins membership or the
      // member's own GutterToken credits), the GutterToken key, and API access for the member's
      // own tools. These used to be two cards in Settings; they are not "how this app looks",
      // they are things that act on the member's behalf, which is what Tools holds. The card ids
      // (`assistant-prefs`, `api-access`) are unchanged, so the old Settings deep links redirect
      // here (WalletPage) rather than dying.
      { id: 'assistant', label: 'Assistant', icon: 'chat' },
      // 'network' deliberately absent (spec 069): network settings moved to the account
      // button beside Settings. The app reads every supported network at once, so the
      // active chain is a per-transaction detail rather than a tool you go to — and the
      // panel is now mostly endpoint configuration, which belongs with settings. The
      // tab id stays 'network' so saved links keep resolving (WalletPage hosts it).
    ],
  },
]

// The tenant-scoped nav model every consumer reads. Chain-based visibility
// still applies at render time via visibleNavGroups(visibility).
export const NAV_GROUPS = RAW_NAV_GROUPS
  .map((group) => ({ ...group, items: group.items.filter((item) => isNavItemEnabledForTenant(item.id)) }))
  .filter((group) => group.items.length > 0)

// Path a section item navigates to. Home keeps its absolute route; Wagers resolves to its view
// inside the Transfer section, so anything that still builds a link from the `wagers` id (saved
// routes, notification deep links) lands where the surface actually lives now.
export function pathForNavItem(id) {
  if (id === HOME_ITEM.id) return HOME_ITEM.to
  if (id === WAGERS_VIEW.id) return WAGERS_PATH
  if (id === PORTFOLIO_ITEM.id) return PORTFOLIO_PATH
  return `/wallet?tab=${id}`
}

// The group a given tab id belongs to (used by SectionIconNav to show siblings).
// Returns null for tabs that are not part of the menu (account/membership/etc.).
export function groupForTab(tabId) {
  return NAV_GROUPS.find((group) => group.items.some((item) => item.id === tabId)) || null
}

// Chain-aware menu: drop items whose feature is absent on the active network
// (spec 055 FR-007 — a dead tab must not render anywhere, drawer or bottom bar).
// `visibility` maps item id -> boolean; ids not listed stay visible. Groups that
// end up empty disappear with their label.
export function visibleNavGroups(visibility = {}, groups = NAV_GROUPS) {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => visibility[item.id] !== false) }))
    .filter((group) => group.items.length > 0)
}
