/**
 * AssistantLauncher (specs 095 + 104) — the gating chain, which is almost the whole component.
 *
 * The launcher's job is mostly to NOT exist: tenant feature, connection, opt-in, and then SOMETHING
 * that can answer — a saved GutterToken key on the GutterToken preference, or an active, readable
 * membership. Two properties are asserted here that no amount of reading the file proves:
 *
 *   · the ORDER is load-bearing. A member on the key rail must never pay the membership RPC read,
 *     so this counts how many times the membership hook is mounted and expects ZERO on that path.
 *     The split-component shape is the only thing that makes that true; folding the hook back into
 *     the top-level component would keep every assertion below green except that one.
 *   · pending and unreadable render NOTHING, and no alert. An entry point is the wrong place to
 *     tell someone their RPC is slow, and an unreadable membership is never a denial.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/*
 * Hoisted, because `config/appNav.js` calls `isFeatureEnabled` at MODULE LOAD to build NAV_GROUPS —
 * the mock factory runs before any `let` in this file is initialised, and a plain closure variable
 * would be in its temporal dead zone.
 */
const m = vi.hoisted(() => ({
  featureEnabled: true,
  byokEnabled: true,
  walletState: null,
  membershipState: null,
  membershipReads: 0,
}))

vi.mock('../../config/tenant', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    isFeatureEnabled: (id) => {
      if (id === 'assistant') return m.featureEnabled
      if (id === 'assistant-byok') return m.byokEnabled
      return actual.isFeatureEnabled(id)
    },
  }
})
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => m.walletState }))
vi.mock('../../hooks/useRoleDetails', () => ({
  default: () => {
    m.membershipReads += 1
    return { getRoleDetails: () => m.membershipState, refresh: vi.fn() }
  },
  MembershipTier: { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 },
}))

import AssistantLauncher from '../../components/assistant/AssistantLauncher'
import {
  __resetAssistantPrefsForTests,
  setAssistantEnabled,
  setAssistantProvider,
} from '../../lib/assistant/assistantPrefs'
import {
  __resetGutterTokenKeyForTests,
  saveGutterTokenKey,
} from '../../lib/assistant/guttertokenKeyStore'
import { __resetAssistantSessionForTests } from '../../lib/assistant/assistantClient'

const ACCOUNT = '0x' + '3'.repeat(40)
const KEY = 'sk-test-launcher-abcdwxyz'
const ACTIVE = { isActive: true, tier: 2, tierName: 'Silver', readable: true, hasRole: true }
const INACTIVE = { isActive: false, tier: 0, tierName: 'None', readable: true, hasRole: false }
const UNREADABLE = { isActive: false, tier: 0, tierName: 'Unknown', readable: false, hasRole: false }

function renderLauncher() {
  return render(
    <MemoryRouter>
      <AssistantLauncher />
    </MemoryRouter>
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetAssistantPrefsForTests()
  __resetGutterTokenKeyForTests()
  __resetAssistantSessionForTests()
  m.featureEnabled = true
  m.byokEnabled = true
  m.membershipReads = 0
  m.walletState = { address: ACCOUNT, signer: null, loginMethod: 'injected', chainId: 137, isConnected: true }
  m.membershipState = ACTIVE
  setAssistantEnabled(ACCOUNT, true)
})

describe('AssistantLauncher gating', () => {
  it('renders nothing when the tenant does not enable the assistant', () => {
    m.featureEnabled = false
    renderLauncher()
    expect(screen.queryByTestId('assistant-launcher')).not.toBeInTheDocument()
  })

  it('renders nothing without a connected wallet', () => {
    m.walletState = { address: null, signer: null, loginMethod: null, chainId: 137, isConnected: false }
    renderLauncher()
    expect(screen.queryByTestId('assistant-launcher')).not.toBeInTheDocument()
  })

  it('renders nothing until the account has opted in (default OFF)', () => {
    __resetAssistantPrefsForTests()
    localStorage.clear()
    renderLauncher()
    expect(screen.queryByTestId('assistant-launcher')).not.toBeInTheDocument()
  })

  it('renders nothing while membership is still being read', () => {
    m.membershipState = null
    renderLauncher()
    expect(screen.queryByTestId('assistant-launcher')).not.toBeInTheDocument()
  })

  it('renders nothing — and no denial — when membership is UNREADABLE', () => {
    m.membershipState = UNREADABLE
    const { container } = renderLauncher()
    expect(screen.queryByTestId('assistant-launcher')).not.toBeInTheDocument()
    // Not a toast, not an alert, not a "you are not a member": simply absent.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for an account with no membership and no key', () => {
    m.membershipState = INACTIVE
    renderLauncher()
    expect(screen.queryByTestId('assistant-launcher')).not.toBeInTheDocument()
  })

  it('renders the launcher when every gate passes', () => {
    renderLauncher()
    const button = screen.getByTestId('assistant-launcher')
    expect(button).toHaveAccessibleName(/open the fairwins assistant/i)
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('AssistantLauncher — the GutterToken rail costs no chain read', () => {
  it('renders for a NON-member with a saved key, and never reads membership', () => {
    m.membershipState = INACTIVE
    setAssistantProvider(ACCOUNT, 'guttertoken')
    saveGutterTokenKey(ACCOUNT, KEY)

    renderLauncher()

    expect(screen.getByTestId('assistant-launcher')).toBeInTheDocument()
    // THE assertion of this file: local state alone decided it, so the RPC read never mounted.
    expect(m.membershipReads).toBe(0)
  })

  it('renders while membership is UNREADABLE, because the key does not depend on it', () => {
    m.membershipState = UNREADABLE
    setAssistantProvider(ACCOUNT, 'guttertoken')
    saveGutterTokenKey(ACCOUNT, KEY)

    renderLauncher()

    expect(screen.getByTestId('assistant-launcher')).toBeInTheDocument()
    expect(m.membershipReads).toBe(0)
  })

  it('still reads membership for a member on the default (FairWins) preference', () => {
    saveGutterTokenKey(ACCOUNT, KEY) // a key alone does not move the preference
    renderLauncher()
    expect(screen.getByTestId('assistant-launcher')).toBeInTheDocument()
    expect(m.membershipReads).toBeGreaterThan(0)
  })
})

describe('AssistantLauncher — opening the panel', () => {
  it('asks a member to authorize a session before anything is sent', () => {
    renderLauncher()
    fireEvent.click(screen.getByTestId('assistant-launcher'))

    expect(screen.getByRole('dialog', { name: /fairwins assistant/i })).toBeInTheDocument()
    const authorize = screen.getByTestId('assistant-authorize')
    expect(authorize).toHaveTextContent(/no transaction, no fee, nothing moves/i)
    expect(authorize).toHaveTextContent(/24 hours/i)
    // There is no composer until a session exists — nothing can be typed, so nothing can be sent.
    expect(screen.queryByLabelText(/message the assistant/i)).not.toBeInTheDocument()
  })

  it('takes the launcher out of the tab order while its own panel is open', () => {
    renderLauncher()
    fireEvent.click(screen.getByTestId('assistant-launcher'))
    const button = screen.getByTestId('assistant-launcher')
    expect(button).toHaveClass('assistant-launcher--hidden')
    expect(button).toHaveAttribute('tabindex', '-1')
  })
})
