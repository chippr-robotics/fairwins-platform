# The navigation drawer

The global left navigation ("us") — `frontend/src/components/nav/AppNavDrawer.jsx`, opened by the
clover logo on mobile and permanently docked as a 64px icon gutter from 769px up.

Spec 073 gave it a Quick Access group that pinned mini-apps append to. Pins are unbounded, so that
group grew until it pushed every other section off a phone screen. **Spec 081** reshapes the
expanded panel so its height is bounded by design rather than by how restrained the member has been
with pinning.

## The two states

| State | What renders |
|---|---|
| **Expanded panel** (mobile overlay, or desktop opened) | Header, sticky filter field, pinned-apps strip, accordion sections, footer. |
| **Collapsed gutter** (desktop, 769px+, closed) | Glyph-only rail. **No** filter, **no** strip, **no** accordion — 64px has no room for a heading control, and folding it would strand sections behind a control that does not exist there. Every section's glyph stays reachable with its accessible name. |

Everything below applies to the expanded panel only.

## Sections are accordions

`components/ui/PortalNav.jsx` is shared by the Admin Panel and the My Account portal as well as
this drawer. Collapse is therefore **opt-in**, via `collapsibleGroups`:

```jsx
<PortalNav
  groups={drawerGroups}
  collapsibleGroups={{ expanded, keyFor, onToggle }}  // absent ⇒ today's exact render path
  emptyMessage="No menu entries match “…”"
/>
```

**Without the prop, `PortalNav` renders exactly what it always did** — a presentational
`<span class="portal-nav-group-label">` followed by bare items. `src/test/PortalNav.test.jsx`
asserts that, so a change here cannot fold the Admin rail as a side effect.

With it, the heading becomes
`<button class="portal-nav-group-toggle" aria-expanded aria-controls>` and the items live in a
`<div role="group">` that is **unmounted** when collapsed — not `display: none`. A heading claiming
`aria-expanded="false"` over rows still in the DOM and the tab order is claiming something untrue.
The practical consequence for tests: `queryByRole('button', { name: 'Recovery' })` is `null` while
Tools is folded, so a test asserting on a folded section's item must open it first.

The heading's accessible name is **`"<label> section"`**, not the bare label. A group and one of its
items can legitimately share a name (Tools holds an item called "Apps"), and two adjacent buttons
both announced as "Apps" are ambiguous by ear and to a by-name query. The visible text is a
substring of the accessible name, so WCAG 2.5.3 Label in Name still holds.

### Expansion precedence

Computed per render in `AppNavDrawer`, and **never written back**:

```
filter active  →  true
active section →  true
otherwise      →  stored[key] ?? DEFAULT_EXPANDED_SECTIONS[key] ?? false
```

A filter is a statement about the result set, so a match must not be hidden inside a fold. The item
marked as the current page must never be invisible. But both are *display* overrides: folding Tools
while sitting on Recovery is still remembered for when the member leaves it.

## Pinned apps: one capped strip

`components/nav/PinnedAppsStrip.jsx`. Pins render as a horizontal row of tiles, **one row tall
whatever the pin count** — the height with 5 pins and with 50 pins is identical. That bound is the
whole point; do not reintroduce pins as full-width rows.

- Cap: `VISIBLE_PINNED_CAP = 5`. A constant, not a setting.
- Overflow: a **"Show all N (+K)"** control **below** the row, in the drawer's vertical flow. It is
  deliberately not the last item inside the horizontally scrolling row — there it was the first
  thing scrolled out of view, i.e. the element whose job is to disclose hidden pins was itself
  hidden. A sticky variant floated over the tiles it described and was also rejected.
- Artwork: each tile shows `artworkFor(slug)` — the **same curated store illustration the catalog
  card shows** (spec 077), decorative, resolved by the same slug the launch route uses. It is total,
  so an uncurated app gets the generic illustration, never a broken image or another app's identity.
- The visible label is clamped to two lines and is `aria-hidden`; the **full** app name is the
  button's accessible name and `title`.
- Zero pins ⇒ the strip does not render at all.
- Payments and Accounts stay as labelled rows under Quick Access. They are destinations the product
  ships, not shortcuts the member chose.

## Filter

`lib/nav/filterNav.js` — `filterNavGroups` / `filterNavItems`, pure, case-insensitive, trimmed.
A group left with no matches is dropped **with its heading**. Filter state lives in the drawer (it
must reset on every open) and is never persisted. No matches renders an explicit message via
`emptyMessage`, not a blank panel.

The helpers live in their own module rather than in `AppNavDrawer.jsx` because react-refresh
requires a component module to export only components.

The field searches the **app**, not the twelve words printed on the menu: it reads the nav search
index, so "morpho" reaches Earn ▸ Lend and "rpc" reaches Network. See
[`nav-search.md`](./nav-search.md).

## Density

A single class on the drawer root, `app-nav-drawer--compact`, driven by the `nav_density`
preference and set from *Settings ▸ Menu density* (one collapsed card among the other
preference panels).

**Every compact rule is scoped under that class inside `AppNavDrawer.css`.** They must never move
into `PortalNav.css`: that file is also the Admin Panel's and My Account's rail, and a nav-drawer
density preference has no business tightening either of them.

The floor is **36×36 CSS px** per interactive target — above WCAG 2.2 AA Target Size (Minimum)
(24×24), and about a third more rows per screen than the ~48px comfortable row.
`AppNavDrawer.density.test.jsx` asserts it by reading the shipped CSS, because jsdom computes no
layout.

> **Scoping trap.** `src/index.css` carries a global `button { padding: 0.6em 1.2em }`. Any new
> button class in this drawer must be written as `.app-nav-drawer .<class>` — the existing
> `.app-nav-drawer .portal-nav-item` override is there for the same reason. A bare class rule
> silently loses and the control's content box collapses.

## Preferences

`frontend/src/lib/nav/navPreferences.js` — device-scoped, in the `fw_global_prefs` blob, shaped
like `lib/miniapps/favorites.js` (lazy snapshot + revision counter + `subscribe`).

| Key | Shape | Default |
|---|---|---|
| `nav_sections` | `{ [sectionKey]: boolean }` | `{ 'quick-access': true, finance: true }`, everything else folded |
| `nav_density` | `'comfortable' \| 'compact'` | `'comfortable'` |

Section keys are **derived** from the group label (`sectionKey('Quick Access') === 'quick-access'`),
so a renamed or tenant-hidden group needs no migration — its stored entry simply goes unread.

Both are **deliberately absent from `lib/backup/syncedObjects.js`**, and a test asserts that. Two
reasons: the drawer must render its correct shape on first paint before any wallet resolves (which
rules out wallet-scoped storage), and how one device's menu is folded is not account data. Same call
already made for `miniapp_favorites` (spec 073) and `network_endpoints` (spec 069).

## Groups

`frontend/src/config/appNav.js` remains the one source of truth. Since spec 081 there are three:
**Quick Access** (Payments, Accounts), **Finance**, **Tools**.

Those two items' **ids are `home` and `portfolio`** — route identity, not copy. The labels were
renamed to "Payments" and "Accounts"; the ids stayed so `/app`, `?tab=account&view=portfolio`, the
landing-view preference and every saved deep link keep resolving. `navSearchIndex.js` carries the
former names as search terms, so a member who types "home" or "portfolio" still lands on them.

**Tools gained an `assistant` item in spec 104** (`/wallet?tab=assistant`), which hosts the
assistant's preferences — including the provider choice between the FairWins rail and the member's
own GutterToken credits — and the API access console, both moved there from Settings. It is an
ordinary Tools row: it obeys the tenant filter (`assistant` feature; the GutterToken option inside it
is additionally gated by `assistant-byok`), it folds with the section, and it adds nothing to the
drawer's resting height beyond one row. The `settings` tab keeps every other card, and the
`?tab=settings#assistant-prefs` / `#api-access` deep links redirect to the new tab so saved links
keep resolving.

The mini-app catalog entry lives **inside Tools**. Spec 073 had already collapsed the Apps group to
that single entry — which apps exist is decided by the on-chain registry, so the nav can only name
the door — and a group that can never hold a second row does not earn a heading, a rule and a fold.
The `apps` tab id and the `/apps/<slug>` routes are unchanged, so every deep link keeps resolving;
`groupForTab('apps')` now answers Tools, which only changes the siblings the mobile bottom bar shows.

## Visual validation

`scripts/ui/capture-nav-drawer.mjs` drives the pre-installed Chromium against the dev server and
writes one screenshot per state to `specs/081-nav-drawer-density/screenshots/`. Playwright is
resolved from a scratch directory via `NODE_PATH`, **never** added to a workspace manifest — spec
075 documents that a lockfile re-resolve here can silently drop an optional platform binary and
break every Vite build, including the mini-app release path whose output bytes are keccak-committed
on-chain. See `specs/081-nav-drawer-density/quickstart.md` for the exact commands.

## See also

- `specs/081-nav-drawer-density/` — spec, plan, research decisions, tasks
- `docs/developer-guide/miniapps.md` — the catalog, favorites, and the store artwork rules
