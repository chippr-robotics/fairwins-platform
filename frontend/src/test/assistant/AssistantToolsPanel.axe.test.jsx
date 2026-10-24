/**
 * Tools ▸ Assistant WCAG 2.1 AA audits (spec 104), in the light AND dark themes.
 *
 * Both themes, because the tab is almost entirely disclosure: reason sentences under disabled
 * options, a redacted credential, a status line after a key test. Those are exactly the elements a
 * dark palette gets wrong (spec 090 — an amber or muted tone that passes on Cloud and fails on
 * Gunmetal), and a disclosure nobody can read is not a disclosure.
 *
 * The states audited are the ones that render DIFFERENT things, not the same tree twice:
 *   · the chooser with a reason under each option (no key, membership unreadable),
 *   · the key card holding a key — the state with the redacted value, Test and Remove,
 *   · the key sheet, which is a form inside a dialog and the only place a secret is typed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { axe } from 'vitest-axe'

const m = vi.hoisted(() => ({ walletState: null, membershipState: null }))

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => m.walletState }))
vi.mock('../../hooks/useRoleDetails', () => ({
  default: () => ({ getRoleDetails: () => m.membershipState, refresh: vi.fn() }),
  MembershipTier: { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 },
}))
vi.mock('../../components/account/ApiAccessPanel', () => ({
  default: () => <div data-testid="api-access-stub" />,
}))

import AssistantToolsPanel from '../../components/assistant/AssistantToolsPanel'
import GutterTokenKeySheet from '../../components/assistant/GutterTokenKeySheet'
import {
  __resetAssistantPrefsForTests,
  setAssistantEnabled,
} from '../../lib/assistant/assistantPrefs'
import {
  __resetGutterTokenKeyForTests,
  saveGutterTokenKey,
} from '../../lib/assistant/guttertokenKeyStore'

const ACCOUNT = '0x' + '8'.repeat(40)
const KEY = 'sk-axe-fixture-key-wxyz'
const UNREADABLE = { isActive: false, tier: 0, tierName: 'Unknown', readable: false, hasRole: false }
const ACTIVE = { isActive: true, tier: 2, tierName: 'Silver', readable: true, hasRole: true }

function renderPanel(themeClass, openSection) {
  return render(
    <MemoryRouter>
      <div className={themeClass}>
        <AssistantToolsPanel openSection={openSection} />
      </div>
    </MemoryRouter>
  )
}

function renderSheet(themeClass) {
  return render(
    <div className={themeClass}>
      <GutterTokenKeySheet open onClose={vi.fn()} account={ACCOUNT} onSaved={vi.fn()} />
    </div>
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetAssistantPrefsForTests()
  __resetGutterTokenKeyForTests()
  m.walletState = { address: ACCOUNT, signer: null, loginMethod: 'injected', chainId: 137, isConnected: true }
  m.membershipState = ACTIVE
  setAssistantEnabled(ACCOUNT, true)
})

describe('Assistant tab accessibility', () => {
  it('has no WCAG 2.1 AA violations with the chooser open, in the light theme', async () => {
    const { container } = renderPanel('theme-light platform-fairwins', 'assistant-prefs')
    expect(screen.getByTestId('assistant-provider-guttertoken')).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)

  it('has no violations with the chooser open, in the dark theme', async () => {
    const { container } = renderPanel('theme-dark platform-fairwins', 'assistant-prefs')
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)

  it('has no violations while the FairWins option carries an UNREADABLE reason (light)', async () => {
    m.membershipState = UNREADABLE
    const { container } = renderPanel('theme-light platform-fairwins', 'assistant-prefs')
    expect(screen.getByTestId('assistant-provider-fairwins-reason')).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)

  it('has no violations while the FairWins option carries an UNREADABLE reason (dark)', async () => {
    m.membershipState = UNREADABLE
    const { container } = renderPanel('theme-dark platform-fairwins', 'assistant-prefs')
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)

  it('has no violations on the key card holding a key, in the light theme', async () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    const { container } = renderPanel('theme-light platform-fairwins', 'guttertoken-key')
    expect(screen.getByTestId('guttertoken-key-value')).toHaveTextContent('sk-…wxyz')
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)

  it('has no violations on the key card holding a key, in the dark theme', async () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    const { container } = renderPanel('theme-dark platform-fairwins', 'guttertoken-key')
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)
})

describe('GutterToken key sheet accessibility', () => {
  it('has no WCAG 2.1 AA violations in the light theme', async () => {
    const { container } = renderSheet('theme-light platform-fairwins')
    // The secret field is labelled — an unlabelled password box is both a failure and a trap.
    expect(screen.getByLabelText(/guttertoken key/i, { selector: 'input' })).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)

  it('has no violations in the dark theme', async () => {
    const { container } = renderSheet('theme-dark platform-fairwins')
    expect(await axe(container)).toHaveNoViolations()
  }, 20000)
})
