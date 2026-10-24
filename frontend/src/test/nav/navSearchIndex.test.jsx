import { useEffect } from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import AppNavDrawer from '../../components/nav/AppNavDrawer'
import { NavDrawerProvider } from '../../contexts/NavDrawerContext.jsx'
import { useNavDrawer } from '../../contexts/NavDrawerContext.js'
import { __resetFavoriteAppsForTests } from '../../lib/miniapps/favorites'
import { __resetNavPreferencesForTests } from '../../lib/nav/navPreferences'
import { NAV_GROUPS, pathForNavItem } from '../../config/appNav'
import {
  NAV_DESTINATIONS,
  NAV_ITEM_TERMS,
  OFF_MENU_ITEMS,
  destinationsForNavItem,
  destinationById,
  pathForDestination,
  accordionSectionForHash,
} from '../../config/navSearchIndex'
import { queryTerms, scoreEntry, rankEntries } from '../../lib/nav/navSearch'
import { filterNavGroups, MATCH_LIMIT } from '../../lib/nav/filterNav'

/*
 * Cross-app nav search: the menu answers for what is INSIDE each section, not only for the words
 * printed on it. "morpho" is the case that motivated the whole thing — it is the protocol behind
 * Earn ▸ Lend and appears nowhere in the menu, so a label-only filter reported no matches for the
 * term a member is most likely to type.
 */

function OpenOnMount() {
  const { open } = useNavDrawer()
  useEffect(() => { open() }, [open])
  return null
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{location.pathname}{location.search}{location.hash}</div>
}

function renderDrawer(route = '/app') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <NavDrawerProvider>
        <OpenOnMount />
        <AppNavDrawer />
        <LocationProbe />
      </NavDrawerProvider>
    </MemoryRouter>
  )
}

const type = (value) => fireEvent.change(screen.getByLabelText('Filter menu'), { target: { value } })
const rows = () =>
  Array.from(document.querySelectorAll('.portal-nav-item-label')).map((el) => el.textContent)
const shortcuts = () =>
  Array.from(document.querySelectorAll('.portal-nav-subitem-label')).map((el) => el.textContent)

// Every tab WalletPage can render, so a destination cannot point at a section that does not exist.
const KNOWN_TABS = new Set([
  'home', 'portfolio', 'account', 'membership', 'network', 'settings', 'security', 'earn', 'trade',
  'collectibles', 'predict', 'paytransfer', 'custody', 'addressbook', 'reports', 'apps',
  // Spec 104 — Tools ▸ Assistant, the tab the `assistant-prefs` / `guttertoken-key` / `api-access`
  // cards moved onto out of Settings.
  'assistant',
])

describe('nav search index — integrity', () => {
  it('gives every destination a unique id', () => {
    const ids = NAV_DESTINATIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('points every destination and every synonym list at a section that exists', () => {
    for (const destination of NAV_DESTINATIONS) {
      expect(KNOWN_TABS.has(destination.navId), `${destination.id} → ${destination.navId}`).toBe(true)
    }
    for (const navId of Object.keys(NAV_ITEM_TERMS)) {
      expect(KNOWN_TABS.has(navId), navId).toBe(true)
    }
  })

  it('keeps every off-menu item out of the drawer groups it is spliced beside', () => {
    const menuIds = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id))
    for (const item of OFF_MENU_ITEMS) {
      expect(menuIds, item.id).not.toContain(item.id)
      expect(KNOWN_TABS.has(item.id)).toBe(true)
    }
  })

  it('builds a deep link that carries the focus marker, with the card hash last', () => {
    expect(pathForDestination('earn-lend')).toBe('/wallet?tab=earn&view=lend&focus=earn-lend')
    // A card: the hash is what makes it land OPEN, so it has to survive the query it follows.
    expect(pathForDestination('legacy-recovery')).toBe(
      '/wallet?tab=security&focus=legacy-recovery#legacy-recovery',
    )
    expect(pathForDestination('nope')).toBeNull()
  })

  it('resolves a card hash only for the tab that owns it', () => {
    expect(accordionSectionForHash('security', '#legacy-recovery')).toBe('legacy-recovery')
    expect(accordionSectionForHash('settings', '#privacy-prefs')).toBe('privacy-prefs')
    // The same hash on a different tab names nothing — a card is not global.
    expect(accordionSectionForHash('settings', '#legacy-recovery')).toBeNull()
    expect(accordionSectionForHash('security', '')).toBeNull()
  })

  it('never claims a card for a section-less destination', () => {
    for (const destination of NAV_DESTINATIONS) {
      if (destination.hash) expect(destination.section, destination.id).toBe(true)
      if (destination.section) expect(destination.hash, destination.id).toBeTruthy()
    }
  })
})

describe('nav search matching', () => {
  const entry = { label: 'Lend', summary: 'Deposit into a Morpho vault.', keywords: ['morpho', 'apy'] }

  it('matches a keyword by token prefix, so no stems are written by hand', () => {
    expect(scoreEntry(entry, queryTerms('morph'))).toBeGreaterThan(0)
    expect(scoreEntry(entry, queryTerms('MORPHO'))).toBeGreaterThan(0)
    expect(scoreEntry(entry, queryTerms('orpho'))).toBe(0)
  })

  it('tokenizes the query the same way it tokenizes the index', () => {
    // Whitespace-splitting the query while the index splits on punctuation is a silent asymmetry:
    // the hyphenated spelling would arrive as one term no token could prefix.
    expect(queryTerms('bip-39')).toEqual(['bip', '39'])
    expect(queryTerms('  ERC-4626 ')).toEqual(['erc', '4626'])
    expect(queryTerms('---')).toEqual([])
  })

  it('finds a hyphenated keyword whichever way the member spells it', () => {
    const recovery = destinationById('legacy-recovery')
    for (const term of ['bip39', 'bip-39', 'BIP 39']) {
      expect(scoreEntry(recovery, queryTerms(term)), term).toBeGreaterThan(0)
    }
    const lend = destinationById('earn-lend')
    expect(scoreEntry(lend, queryTerms('erc-4626'))).toBeGreaterThan(0)
  })

  it('keeps mid-token label matching, which the menu filter always had', () => {
    expect(scoreEntry({ label: 'Recovery' }, queryTerms('cover'))).toBeGreaterThan(0)
  })

  it('ANDs the terms, so a second word narrows rather than widens', () => {
    expect(scoreEntry(entry, queryTerms('morpho apy'))).toBeGreaterThan(0)
    expect(scoreEntry(entry, queryTerms('morpho bridge'))).toBe(0)
  })

  it('ranks a name above a keyword above a sentence', () => {
    const byName = { label: 'Bridge' }
    const byKeyword = { label: 'Supply', keywords: ['bridge pool'] }
    const bySummary = { label: 'Send', summary: 'Not a bridge.' }
    expect(rankEntries([bySummary, byKeyword, byName], queryTerms('bridge'))).toEqual([
      byName,
      byKeyword,
      bySummary,
    ])
  })

  it('returns nothing for an empty query rather than everything', () => {
    expect(rankEntries([entry], queryTerms('   '))).toEqual([])
  })
})

describe('filterNavGroups with the index', () => {
  const GROUPS = [{ label: 'Finance', items: [{ id: 'earn', label: 'Earn' }, { id: 'trade', label: 'Trade' }] }]
  const options = {
    termsFor: (item) => NAV_ITEM_TERMS[item.id],
    destinationsFor: (item) => destinationsForNavItem(item.id),
  }

  it('surfaces the section that holds a protocol, with the shortcut attached', () => {
    const [finance] = filterNavGroups(GROUPS, 'morpho', options)
    expect(finance.items.map((i) => i.id)).toEqual(['earn'])
    expect(finance.items[0].matches.map((m) => m.id)).toEqual(['earn-lend'])
  })

  it('leaves an item untouched when only its own label matched', () => {
    const [finance] = filterNavGroups(GROUPS, 'trade', options)
    expect(finance.items.map((i) => i.id)).toEqual(['trade'])
    expect(finance.items[0]).not.toHaveProperty('matches')
  })

  it('finds each venue and service under the section that actually holds it', () => {
    const cases = [
      ['opensea', 'collectibles'],
      ['polymarket', 'predict'],
      ['multisig', 'custody'],
      ['lido', 'earn'],
      ['hyperliquid', 'trade'],
      ['uniswap', 'trade'],
      ['merkl', 'earn'],
      ['across', 'paytransfer'],
      ['gnosis safe', 'custody'],
      ['seed phrase', 'security'],
    ]
    for (const [term, navId] of cases) {
      const hits = filterNavGroups(NAV_GROUPS, term, options).flatMap((g) => g.items.map((i) => i.id))
      expect(hits, `${term} → ${navId}`).toContain(navId)
    }
  })

  it('contributes nothing from a section the app has hidden', () => {
    // Collect hides entirely off the chains OpenSea serves (spec 055 FR-007). The drawer filters
    // items BEFORE the index is consulted, so a hidden section cannot be resurrected by a term
    // only its contents answer to.
    const withoutCollect = NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.id !== 'collectibles'),
    }))
    expect(filterNavGroups(withoutCollect, 'opensea', options)).toEqual([])
  })

  it('caps the shortcuts per section and reports what it left out', () => {
    // 'e' prefixes several of Earn's terms at once; whatever the total, the cap and the count of
    // the remainder must agree — a truncated list that reads as complete is the failure here.
    const withDestinations = { label: 'X', items: [{ id: 'earn', label: 'Earn' }] }
    const [group] = filterNavGroups([withDestinations], 'e', options)
    const item = group.items[0]
    const total = rankEntries(destinationsForNavItem('earn'), queryTerms('e')).length
    expect(item.matches.length).toBe(Math.min(total, MATCH_LIMIT))
    expect(item.matchOverflow).toBe(Math.max(0, total - MATCH_LIMIT))
  })

  it('still returns the same array reference for an empty query', () => {
    expect(filterNavGroups(GROUPS, '', options)).toBe(GROUPS)
  })
})

describe('AppNavDrawer — searching protocols and services', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetFavoriteAppsForTests()
    __resetNavPreferencesForTests()
  })

  it('answers "morpho" with Earn and a direct shortcut to Lend', () => {
    renderDrawer()
    type('morpho')

    expect(rows()).toEqual(['Earn'])
    expect(shortcuts()).toEqual(['Lend'])
  })

  it('takes the member to the lend view, marked for the attention flash', () => {
    renderDrawer()
    type('morpho')
    fireEvent.click(screen.getByRole('button', { name: /^Lend/ }))

    expect(screen.getByTestId('loc')).toHaveTextContent('/wallet?tab=earn&view=lend&focus=earn-lend')
  })

  it('reaches a section that is not in this menu at all, and only while filtering', () => {
    renderDrawer()
    // Network lives on the account button (config/appNav.js), so it is absent at rest...
    expect(rows()).not.toContain('Network')

    type('rpc')
    expect(rows()).toEqual(['Network'])

    fireEvent.change(screen.getByLabelText('Filter menu'), { target: { value: '' } })
    expect(rows()).not.toContain('Network')
  })

  it('reaches a preference card inside a section and lands on it open', () => {
    renderDrawer()
    type('bip39')

    const drawer = document.getElementById('app-nav-drawer')
    expect(within(drawer).getByRole('button', { name: /^Recovery$/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Legacy account recovery/ }))

    expect(screen.getByTestId('loc')).toHaveTextContent(
      '/wallet?tab=security&focus=legacy-recovery#legacy-recovery',
    )
  })

  it('finds venues and services by the name members know them by', () => {
    // Collect and Predict are chain-gated and absent from this render, which is exactly right —
    // their terms are covered against the full menu in the filterNavGroups suite above.
    const cases = [
      ['multisig', 'Protect'],
      ['lido', 'Earn'],
      ['hyperliquid', 'Trade'],
      ['uniswap', 'Trade'],
      ['tax', 'Reporting'],
    ]
    for (const [term, section] of cases) {
      const { unmount } = renderDrawer()
      type(term)
      expect(rows(), `${term} → ${section}`).toContain(section)
      unmount()
    }
  })

  it('still says so out loud when a term matches nothing anywhere', () => {
    renderDrawer()
    type('zzzzz')
    expect(rows()).toEqual([])
    expect(screen.getByRole('status')).toHaveTextContent('No menu entries match')
  })

  it('routes a plain section row by its tab, not as if it were a destination', () => {
    renderDrawer()
    type('earn')
    fireEvent.click(screen.getByRole('button', { name: /^Earn$/ }))
    expect(screen.getByTestId('loc')).toHaveTextContent(pathForNavItem('earn'))
    expect(destinationById('earn')).toBeNull()
  })
})
