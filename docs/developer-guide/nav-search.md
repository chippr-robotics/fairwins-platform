# Nav search — finding protocols, services and preference cards

The drawer's filter field started as a label filter over the twelve words printed on the menu
(spec 081). That is not what members type. The word "Morpho" appears nowhere in the nav, so a
member who knows they lend on Morpho typed the one term the menu could not answer and was told
there were no matches — on an app that has a whole Earn ▸ Lend screen built on it. Same story for
`opensea`, `polymarket`, `bip39`, `rpc`.

The field now searches an index of what is actually **inside** each section, and a result links
straight to the sub-surface rather than to the section that contains it.

## The pieces

| File | Job |
|---|---|
| `frontend/src/config/navSearchIndex.js` | The data: synonyms per nav item, and the destinations inside each section. |
| `frontend/src/lib/nav/navSearch.js` | The matcher: term splitting, scoring, ranking. Pure. |
| `frontend/src/lib/nav/filterNav.js` | Applies the matcher to nav groups and attaches matched destinations to their item. |
| `frontend/src/components/ui/PortalNav.jsx` | Renders an item's `matches` as indented shortcut rows. |
| `frontend/src/lib/nav/attention.js` + `components/nav/AttentionFocus.jsx` | The arrival highlight on the surface a shortcut lands on. |

## Three kinds of index entry

```js
NAV_ITEM_TERMS  = { collectibles: ['nft', 'opensea', …] }   // a section with no sub-surfaces
NAV_DESTINATIONS = [{ id, navId, label, summary, path, keywords, section?, hash? }]
OFF_MENU_ITEMS  = [{ id: 'network', label: 'Network', icon: 'globe' }, …]
```

`navId` must be a real nav item / WalletPage tab id — `src/test/nav/navSearchIndex.test.jsx` checks
every one, so a renamed tab cannot leave a shortcut pointing at nothing.

## Matching

Every term the member typed must be found somewhere in an entry's label, summary or keywords —
terms are **ANDed**, so "earn stake" narrows. Each term matches as a **token prefix** ("morph" →
"morpho", "multi" → "multisig"), so nobody hand-writes stems into the index. Labels additionally
match mid-token ("cover" → "Recovery"), which is what the label-only filter did and what members
already have muscle memory for.

Scores only **order** results — a term either matched or it did not. Name beats keyword beats
summary.

## What a query is allowed to reach

- **Resting**, the drawer is exactly the menu. Nothing below changes its height (spec 081).
- **While filtering**, results also span Settings / Network / Membership / My Account under a
  `Settings & Account` heading. Those live on the account button by design, but typing "rpc" is a
  question rather than browsing, and answering "no matches" while the app plainly has that screen
  is the search failing at its one job. They leave again when the filter clears.
- A section hidden by the tenant or the active chain contributes **nothing**. The drawer filters
  its items first and the index is consulted per surviving item, so an index entry can never
  resurrect a surface the app has decided not to offer.
- At most `MATCH_LIMIT` (4) shortcuts per section, and the remainder is **stated** ("+2 more in
  Earn") rather than silently dropped.

## The arrival flash

A shortcut navigates to `…&focus=<destination id>`. `AttentionFocus` (mounted once in `App.jsx`)
finds `[data-attention="<id>"]` and highlights it for ~1.8s.

```jsx
<div className="earn-lend" data-attention="earn-lend">   // a surface opts in with one attribute
```

- It **waits** for its target (the surface usually mounts a beat after the route changes) and then
  gives up in silence. A destination whose surface carries no marker still navigates correctly.
- It **never moves focus** — the member is reading, not tabbing.
- `prefers-reduced-motion` gets a steady ring instead of a pulse: it is the pulsing that is
  dropped, not the pointing.
- The parameter is stripped once consumed (`replace`), so it does not re-fire on back-navigation
  or ride along in a copied link. The `#card` hash is **not** stripped — that is addressable state.

`AccordionSection` sets `data-attention` from its own section id, so every Settings and Recovery
card is a valid target with no per-panel wiring.

## Deep-linking a preference card

A card destination carries `section: true` and a `hash`. `accordionSectionForHash(tab, hash)` maps
`#privacy-prefs` on the Settings tab to the accordion id that must be **open** on arrival — the
mechanism Settings already had, now derived from the index so Recovery gets it too and neither can
drift from the other. `SETTINGS_HASH_ALIASES` in `WalletPage.jsx` holds only the cases where the
hash does not name its card.

**The Assistant tab (spec 104).** The `assistant-prefs` and `api-access` cards moved from Settings
to a tab of their own, `assistant`, which is an item in the **Tools** nav group
(`/wallet?tab=assistant`). Their index entries therefore carry `navId: 'assistant'` and
`path: '/wallet?tab=assistant'` — the `id`s (which are the card ids, and so the `data-attention`
markers) are unchanged, and `accordionSectionForHash` resolves the new tab through the same one
map. The old `?tab=settings#assistant-prefs` / `#api-access` links redirect. Two consequences for
the index: the Assistant card's keywords gain the names members will actually type for the new
provider — `guttertoken`, `byok`, `api key`, `credits`, `provider` — so "guttertoken" in the drawer
lands on the card; and because the tab is a real nav item rather than an account-button surface, it
matches at rest like any other Tools item and no longer joins results only under the
`Settings & Account` heading. The same index is what the assistant's `find_in_app` tool searches,
which is one more reason it stays descriptive, never authoritative: a hidden surface does not
resurrect because a model asked for it.

## Adding a surface to the index

1. Add the entry to `NAV_DESTINATIONS` (or extend `NAV_ITEM_TERMS` for a section with no
   sub-surfaces). Keywords are lowercase, may be multi-word, and should be the names members use —
   the protocol, the venue, the thing they call it.
2. Put `data-attention="<id>"` on that surface's own root element. Prefer an element that already
   exists over a new wrapper.
3. If it is an accordion card, give it `section: true` and `hash: '#<accordion id>'`.

## See also

- `docs/developer-guide/nav-drawer.md` — the drawer itself, folds, density, pinned apps
- `frontend/src/test/nav/` — index integrity, matching, drawer behaviour, and the flash
