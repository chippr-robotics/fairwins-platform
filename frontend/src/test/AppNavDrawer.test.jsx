import { useEffect } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import AppNavDrawer from '../components/nav/AppNavDrawer'
import { NavDrawerProvider } from '../contexts/NavDrawerContext.jsx'
import { useNavDrawer } from '../contexts/NavDrawerContext.js'
import { addFavoriteApp, __resetFavoriteAppsForTests } from '../lib/miniapps/favorites'
import { __resetNavPreferencesForTests } from '../lib/nav/navPreferences'
import { TAB_ALIASES } from '../config/appNav'

// Spec 081: sections are accordions and Tools defaults to collapsed, so its items are UNMOUNTED
// until the member opens it (see research R2 — a heading claiming aria-expanded="false" over rows
// that are still in the DOM and the tab order is claiming something untrue). Tests that assert on
// a Tools item open its section first.
function expandSection(name) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name} section$`, 'i') }))
}

// useIsMobile() reads window.matchMedia('(max-width: 768px)'). setup.js mocks
// matches: false for every query, i.e. desktop — which these tests rely on
// unless a block below opts into the mobile matcher instead.
function mockViewport({ mobile }) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: mobile && /max-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

// The drawer is inert while closed (off-screen), so open it on mount to
// exercise its contents — mirrors the clover-logo trigger.
function OpenOnMount() {
  const { open } = useNavDrawer()
  useEffect(() => { open() }, [open])
  return null
}

// App navigation redesign — the global left drawer ("us"). It lists Home plus
// the Finance/Tools/Apps sections, routes each entry, highlights the active one
// from the URL, and carries a copyright-only footer. Personal-account entries
// (Account/Membership/Preferences) intentionally live on the account button, not
// here. The legal/policy links that used to live in this footer moved to
// Settings → App (issue #1025).

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{location.pathname}{location.search}</div>
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

describe('AppNavDrawer (global nav drawer)', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetFavoriteAppsForTests()
    __resetNavPreferencesForTests()
  })

  it('lists Payments plus the Finance and Tools sections', () => {
    const { container } = renderDrawer()

    // Drawer entries navigate between routes, so they use navigation (button)
    // semantics with aria-current — not tablist/tab.
    expect(screen.getByRole('button', { name: 'Payments' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trade' })).toBeInTheDocument()
    // Custody is surfaced as "Protect"; the Backup & Security section is now "Recovery".
    // Both live in Tools, which defaults to collapsed since spec 081.
    expandSection('Tools')
    expect(screen.getByRole('button', { name: 'Protect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recovery' })).toBeInTheDocument()
    // Not a tablist.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()

    // Group headings are matched as headings rather than by bare text: since spec 073 the Apps
    // group holds a single entry that is also labelled "Apps" (the mini-app catalog), so the
    // string appears twice in the drawer and a text lookup is ambiguous.
    const groupLabels = Array.from(container.querySelectorAll('.portal-nav-group-label')).map(
      (el) => el.textContent
    )
    // Spec 081: three groups, not four. The mini-app catalog moved into Tools — since spec 073
    // collapsed it to a single entry, a group of its own was a heading, a rule and a fold in
    // service of one row.
    expect(groupLabels).toEqual(['Quick Access', 'Finance', 'Tools'])

    // Removed Admin group / personal-account entries are absent from the menu.
    expect(screen.queryByRole('button', { name: 'Preferences' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
  })

  it('lists Accounts under Quick Access with Payments, not under Finance', () => {
    const { container } = renderDrawer()

    expect(screen.getByRole('button', { name: 'Accounts' })).toBeInTheDocument()

    // Accounts sits between the Quick Access and Finance group labels, i.e.
    // it belongs to Quick Access rather than Finance's item list.
    const labels = Array.from(
      container.querySelectorAll('.portal-nav-group-label, .portal-nav-item-label')
    ).map((el) => el.textContent)
    const quickAccessIdx = labels.indexOf('Quick Access')
    const financeIdx = labels.indexOf('Finance')
    const accountsIdx = labels.indexOf('Accounts')
    expect(accountsIdx).toBeGreaterThan(quickAccessIdx)
    expect(accountsIdx).toBeLessThan(financeIdx)
  })

  // The two Quick Access labels were renamed (Home → Payments, Portfolio → Accounts) while their
  // ids — and therefore their routes — stayed put. These assert the pairing directly, because a
  // rename that also moved the destination would be a broken link, not a copy change.
  it('routes Accounts to the unified My Account view (spec 074)', () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/wallet?tab=account&view=portfolio')
  })

  it('routes Payments to the dashboard', () => {
    renderDrawer('/wallet?tab=trade')
    fireEvent.click(screen.getByRole('button', { name: 'Payments' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/app')
  })

  it('routes a section item to its wallet tab (Protect → custody)', () => {
    renderDrawer()
    expandSection('Tools')
    fireEvent.click(screen.getByRole('button', { name: 'Protect' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/wallet?tab=custody')
  })

  it('highlights the active section from the URL with aria-current', () => {
    renderDrawer('/wallet?tab=security')
    expect(screen.getByRole('button', { name: 'Recovery' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Trade' })).not.toHaveAttribute('aria-current')
  })

  // The drawer used to keep its OWN copy of the renamed-tab map, with a comment asking it to stay
  // in parity with WalletPage's; it drifted the first time a tab was renamed. Both now read the one
  // exported map, so a legacy id still lights up the entry the tab was renamed to.
  it('highlights the renamed section when the URL carries a legacy tab id', () => {
    renderDrawer(`/wallet?tab=backup`)
    expect(screen.getByRole('button', { name: 'Recovery' })).toHaveAttribute('aria-current', 'page')
  })

  it('resolves every legacy tab id through the shared alias map', () => {
    // Whatever the map says today, each alias must point at a real tab — a rename that forgets to
    // add its alias here is how a saved link starts resolving to the Account fallback instead.
    for (const [legacy, canonical] of Object.entries(TAB_ALIASES)) {
      expect(canonical).toBeTruthy()
      expect(legacy).not.toBe(canonical)
    }
    expect(TAB_ALIASES.preferences).toBe('settings')
  })

  it('contains a copyright-only footer, with no legal/policy links (issue #1025)', () => {
    const { container } = renderDrawer()
    const footer = container.querySelector('.app-footer--drawer')
    expect(footer).toBeTruthy()
    expect(within(footer).getByText(new RegExp(String(new Date().getFullYear())))).toBeInTheDocument()
    expect(within(footer).queryByRole('link', { name: /Terms & Conditions/i })).not.toBeInTheDocument()
    expect(within(footer).queryByRole('link', { name: /Risk Disclosure/i })).not.toBeInTheDocument()
    expect(within(footer).queryByRole('link', { name: /Privacy Policy/i })).not.toBeInTheDocument()
    expect(within(footer).queryByRole('link', { name: /Account Moderation/i })).not.toBeInTheDocument()
  })
})

// Larger screens: the drawer is a persistent icon gutter that expands in
// place rather than sliding fully off-canvas — see AppNavDrawer.jsx.
describe('AppNavDrawer (desktop icon gutter)', () => {
  afterEach(() => {
    // Restore the desktop-by-default matcher the rest of this file relies on.
    mockViewport({ mobile: false })
  })

  it('shows a collapsed icon gutter by default, not hidden off-canvas', () => {
    mockViewport({ mobile: false })
    render(
      <MemoryRouter initialEntries={['/app']}>
        <NavDrawerProvider>
          <AppNavDrawer />
        </NavDrawerProvider>
      </MemoryRouter>
    )

    const aside = document.getElementById('app-nav-drawer')
    expect(aside).not.toHaveAttribute('inert')
    expect(aside.className).toContain('collapsed')
    expect(screen.getByRole('button', { name: 'Expand menu' })).toBeInTheDocument()
    // Entries stay reachable (label visually hidden, not removed) — the
    // accessible name still resolves them.
    expect(screen.getByRole('button', { name: 'Trade' })).toBeInTheDocument()
  })

  it('expands to the full labelled panel once opened', () => {
    mockViewport({ mobile: false })
    render(
      <MemoryRouter initialEntries={['/app']}>
        <NavDrawerProvider>
          <OpenOnMount />
          <AppNavDrawer />
        </NavDrawerProvider>
      </MemoryRouter>
    )

    const aside = document.getElementById('app-nav-drawer')
    expect(aside.className).not.toContain('collapsed')
    expect(screen.getByText('Finance')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close menu' })).toBeInTheDocument()
  })

  it('stays fully hidden off-canvas on mobile until opened', () => {
    mockViewport({ mobile: true })
    render(
      <MemoryRouter initialEntries={['/app']}>
        <NavDrawerProvider>
          <AppNavDrawer />
        </NavDrawerProvider>
      </MemoryRouter>
    )

    const aside = document.getElementById('app-nav-drawer')
    // `inert` rather than `aria-hidden`: the panel is off-canvas but still in the DOM,
    // so it must be removed from the tab order too, not merely from the a11y tree.
    expect(aside).toHaveAttribute('inert')
    expect(aside.className).not.toContain('collapsed')
  })
})

// Favorited mini-apps (App Store Quick Access). A favorite is a device-scoped shortcut
// (lib/miniapps/favorites.js) into `/apps/<slug>`, surfaced alongside Payments/Accounts.
describe('AppNavDrawer (favorited mini-apps / Quick Access)', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetFavoriteAppsForTests()
    __resetNavPreferencesForTests()
  })

  it('renders a favorited app in the pinned strip above the list and routes it to its workspace', () => {
    addFavoriteApp({ id: 12, slug: 'token-mint', name: 'Token Mint' })

    const { container } = renderDrawer()

    // Spec 081: pins are no longer full-width rows spliced into Quick Access — they are tiles in
    // a strip that sits ABOVE the section list, so the region's height is one row whatever the
    // pin count. The tile is still the same shortcut with the same accessible name.
    const strip = container.querySelector('.pinned-apps-strip')
    expect(strip).toBeTruthy()
    expect(within(strip).getByRole('button', { name: 'Token Mint' })).toBeInTheDocument()
    expect(strip.compareDocumentPosition(container.querySelector('.portal-nav')))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    fireEvent.click(within(strip).getByRole('button', { name: 'Token Mint' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/apps/token-mint')
  })

  it('lists Payments, Accounts and Apps under Quick Access, and no strip, when nothing is favorited', () => {
    const { container } = renderDrawer()
    const labels = Array.from(
      container.querySelectorAll('.portal-nav-group-label, .portal-nav-item-label')
    ).map((el) => el.textContent)
    const quickAccessIdx = labels.indexOf('Quick Access')
    const financeIdx = labels.indexOf('Finance')
    // Apps rides Quick Access since spec 093 — the catalog entry is the door to the whole
    // mini-app platform and must not be buried at the bottom of a folded Tools section.
    expect(labels.slice(quickAccessIdx + 1, financeIdx)).toEqual(['Payments', 'Accounts', 'Apps'])
    // An empty shortcuts region is a label with nothing behind it — it does not render at all.
    expect(container.querySelector('.pinned-apps-strip')).toBeNull()
  })

  it('highlights the favorited shortcut itself, not just the Apps entry, when it is the open app', () => {
    addFavoriteApp({ id: 12, slug: 'token-mint', name: 'Token Mint' })
    renderDrawer('/apps/token-mint')
    expect(screen.getByRole('button', { name: 'Token Mint' })).toHaveAttribute('aria-current', 'page')
    // Tools (which now hosts the catalog entry) is not the active group here — the pinned
    // shortcut is what is highlighted — so it stays folded and has to be opened first.
    expandSection('Tools')
    expect(screen.getByRole('button', { name: 'Apps' })).not.toHaveAttribute('aria-current')
  })
})
