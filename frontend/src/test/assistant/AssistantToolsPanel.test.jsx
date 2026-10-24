/**
 * AssistantToolsPanel (spec 104) — the body of Tools ▸ Assistant.
 *
 * What is worth asserting here is not that three cards render, but the two places this surface can
 * quietly say something untrue:
 *
 *   1. THE CHOOSER'S THREE MEMBERSHIP STATES. `pending` and `unreadable` are not "not a member".
 *      Unreadable in particular keeps the FairWins option ENABLED with a sentence explaining what is
 *      unknown — an RPC that did not answer is not evidence about a tier, and disabling the rail on
 *      a timeout would present a network problem as a decision about the member's account.
 *   2. THE TENANT GATE. `assistant-byok` is what makes the GutterToken rail exist at all. Without
 *      it the option, the key card and the GutterToken branch of the disclosure are ABSENT — not
 *      offered-and-refused, because there is nothing a member could do about it.
 *
 * `ApiAccessPanel` is stubbed: it is another surface's file, mounted here unchanged, and it has its
 * own test. Stubbing it keeps this file about the cards spec 104 actually introduced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const m = vi.hoisted(() => ({
  byokEnabled: true,
  walletState: null,
  membershipState: null,
}))

vi.mock('../../config/tenant', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    isFeatureEnabled: (id) => (id === 'assistant-byok' ? m.byokEnabled : actual.isFeatureEnabled(id)),
  }
})
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => m.walletState }))
vi.mock('../../hooks/useRoleDetails', () => ({
  default: () => ({ getRoleDetails: () => m.membershipState, refresh: vi.fn() }),
  MembershipTier: { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 },
}))
vi.mock('../../components/account/ApiAccessPanel', () => ({
  default: () => <div data-testid="api-access-stub" />,
}))

import AssistantToolsPanel from '../../components/assistant/AssistantToolsPanel'
import {
  __resetAssistantPrefsForTests,
  setAssistantEnabled,
  setAssistantProvider,
  getAssistantProvider,
} from '../../lib/assistant/assistantPrefs'
import {
  __resetGutterTokenKeyForTests,
  saveGutterTokenKey,
} from '../../lib/assistant/guttertokenKeyStore'

const ACCOUNT = '0x' + '5'.repeat(40)
const KEY = 'sk-tools-panel-key-wxyz'
const ACTIVE = { isActive: true, tier: 2, tierName: 'Silver', readable: true, hasRole: true }
const INACTIVE = { isActive: false, tier: 0, tierName: 'None', readable: true, hasRole: false }
const UNREADABLE = { isActive: false, tier: 0, tierName: 'Unknown', readable: false, hasRole: false }

function renderPanel(openSection = null) {
  return render(
    <MemoryRouter>
      <AssistantToolsPanel openSection={openSection} />
    </MemoryRouter>
  )
}

/** Open a card by its accordion header. */
const openCard = (name) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetAssistantPrefsForTests()
  __resetGutterTokenKeyForTests()
  m.byokEnabled = true
  m.walletState = { address: ACCOUNT, signer: null, loginMethod: 'injected', chainId: 137, isConnected: true }
  m.membershipState = ACTIVE
  setAssistantEnabled(ACCOUNT, true)
})

describe('AssistantToolsPanel — the cards', () => {
  it('renders the three cards of the tab, keeping the ids the old deep links name', () => {
    renderPanel()
    expect(screen.getByTestId('assistant-prefs-panel')).toBeInTheDocument()
    expect(screen.getByTestId('guttertoken-key-panel')).toBeInTheDocument()
    expect(screen.getByTestId('api-access-stub')).toBeInTheDocument()
  })

  it('opens the card a deep-link hash named', () => {
    renderPanel('guttertoken-key')
    // The card is open, so its body — not just its heading — is on screen.
    expect(screen.getByTestId('guttertoken-key-value')).toBeInTheDocument()
  })

  it('summarises the GutterToken key as None, then as the redacted form', () => {
    const { unmount } = renderPanel()
    expect(screen.getByRole('button', { name: /^guttertoken key/i })).toHaveTextContent('None')
    unmount()

    saveGutterTokenKey(ACCOUNT, KEY)
    renderPanel()
    const header = screen.getByRole('button', { name: /^guttertoken key/i })
    expect(header).toHaveTextContent('sk-…wxyz')
    // The summary is the ONLY form of the key on screen — never the key itself.
    expect(document.body.textContent).not.toContain(KEY)
  })
})

describe('AssistantToolsPanel — the three membership states of the chooser', () => {
  it('offers both rails to a paid member with a key', () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    renderPanel('assistant-prefs')
    expect(screen.getByTestId('assistant-provider-fairwins')).toBeEnabled()
    expect(screen.getByTestId('assistant-provider-guttertoken')).toBeEnabled()
  })

  it('says "checking" while membership is PENDING, and does not deny', () => {
    m.membershipState = null
    renderPanel('assistant-prefs')
    expect(screen.getByTestId('assistant-provider-fairwins-reason')).toHaveTextContent(/checking your membership/i)
    expect(screen.queryByText(/requires an active membership/i)).not.toBeInTheDocument()
  })

  it('keeps FairWins OFFERED when membership is UNREADABLE, with the reason said out loud', () => {
    m.membershipState = UNREADABLE
    renderPanel('assistant-prefs')
    const option = screen.getByTestId('assistant-provider-fairwins')
    // Offered, not hidden and not disabled: unreadable is not an answer about the account.
    expect(option).toBeEnabled()
    expect(screen.getByTestId('assistant-provider-fairwins-reason')).toHaveTextContent(
      /could not be read right now/i
    )
  })

  it('disables FairWins for a READ, inactive membership and links to Membership', () => {
    m.membershipState = INACTIVE
    renderPanel('assistant-prefs')
    expect(screen.getByTestId('assistant-provider-fairwins')).toBeDisabled()
    const reason = screen.getByTestId('assistant-provider-fairwins-reason')
    expect(reason).toHaveTextContent(/requires an active membership/i)
    expect(screen.getByRole('link', { name: /go to membership/i })).toHaveAttribute(
      'href',
      '/wallet?tab=membership'
    )
  })

  it('disables GutterToken until a key is saved, and enables it once one is', () => {
    const { unmount } = renderPanel('assistant-prefs')
    expect(screen.getByTestId('assistant-provider-guttertoken')).toBeDisabled()
    expect(screen.getByTestId('assistant-provider-guttertoken-reason')).toHaveTextContent(
      /add a guttertoken key below/i
    )
    unmount()

    saveGutterTokenKey(ACCOUNT, KEY)
    renderPanel('assistant-prefs')
    expect(screen.getByTestId('assistant-provider-guttertoken')).toBeEnabled()
  })

  it('records the choice, and names the rail that is actually answering', () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    renderPanel('assistant-prefs')

    fireEvent.click(screen.getByTestId('assistant-provider-guttertoken'))

    expect(getAssistantProvider(ACCOUNT)).toBe('guttertoken')
    expect(screen.getByTestId('assistant-provider-effective')).toHaveTextContent(
      /answered by GutterToken/i
    )
  })

  it('says who answers in the collapsed summary, not just a label', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: /^assistant/i })).toHaveTextContent(
      'On — answered by FairWins assistant'
    )
  })
})

describe('AssistantToolsPanel — the assistant-byok tenant gate', () => {
  it('drops the GutterToken option, the key card and its disclosure branch when the tenant has no BYOK', () => {
    m.byokEnabled = false
    renderPanel('assistant-prefs')

    expect(screen.queryByTestId('guttertoken-key-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('assistant-provider-guttertoken')).not.toBeInTheDocument()
    // Absent, not offered-and-refused: there is no such rail on this tenant to explain away.
    expect(screen.getByTestId('assistant-disclosure')).not.toHaveTextContent(/Answered by GutterToken/i)
    // The membership rail is untouched.
    expect(screen.getByTestId('assistant-provider-fairwins')).toBeInTheDocument()
  })

  it('states the GutterToken branch of the disclosure when BYOK is on', () => {
    renderPanel()
    const disclosure = screen.getByTestId('assistant-disclosure')
    expect(disclosure).toHaveTextContent(/Answered by GutterToken/i)
    expect(disclosure).toHaveTextContent(/FairWins does not receive or process them/i)
    expect(disclosure).toHaveTextContent(/While the assistant is off, nothing is sent/i)
  })
})

describe('AssistantToolsPanel — the key card', () => {
  it('discloses the referral beside the Get-a-key link, and opens it safely', () => {
    renderPanel('guttertoken-key')
    const link = screen.getByTestId('guttertoken-key-signup')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAttribute('href', expect.stringContaining('app.guttertokens.com/signup'))
    expect(screen.getByTestId('guttertoken-key-panel')).toHaveTextContent(
      /FairWins may receive referral credit/i
    )
  })

  it('says what the key can do before offering to add one', () => {
    renderPanel('guttertoken-key')
    const card = screen.getByTestId('guttertoken-key-panel')
    expect(card).toHaveTextContent(/spend your GutterToken balance/i)
    expect(card).toHaveTextContent(/stored on this device only/i)
    expect(card).toHaveTextContent(/never sent to FairWins/i)
  })

  it('asks before removing, and removing empties the summary', () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    renderPanel('guttertoken-key')

    fireEvent.click(screen.getByTestId('guttertoken-key-remove'))
    expect(screen.getByTestId('guttertoken-key-confirm')).toHaveTextContent(
      /Your GutterToken account and balance are untouched/i
    )

    fireEvent.click(screen.getByTestId('guttertoken-key-remove-confirm'))
    expect(screen.getByTestId('guttertoken-key-value')).toHaveTextContent('None')
  })

  it('opens the key sheet from Add key', () => {
    renderPanel('guttertoken-key')
    fireEvent.click(screen.getByTestId('guttertoken-key-add'))
    expect(screen.getByTestId('guttertoken-key-sheet')).toBeInTheDocument()
  })
})

describe('AssistantToolsPanel — no wallet', () => {
  it('asks for a wallet rather than showing controls that cannot act', () => {
    m.walletState = { address: null, signer: null, loginMethod: null, chainId: 137, isConnected: false }
    renderPanel()

    // Collapsed, the summary is explicitly NOT "Off — nothing is sent": nothing is yet known about
    // any account's preference, and claiming "off" would be a claim about an account we do not have.
    expect(screen.getByRole('button', { name: /^assistant/i })).toHaveTextContent('Connect a wallet')

    openCard(/^assistant/i)
    expect(screen.getByText(/connect your wallet to turn the assistant on/i)).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-enable-switch')).not.toBeInTheDocument()
  })
})

/*
 * The provider chooser is a preference, and `setAssistantProvider` must be the only thing that
 * writes it — a card that also wrote it from a render would flip a member's processor without a tap.
 */
describe('AssistantToolsPanel — the preference is written only by a tap', () => {
  it('leaves a stored GutterToken preference alone when the key is gone', () => {
    setAssistantProvider(ACCOUNT, 'guttertoken')
    renderPanel('assistant-prefs')
    expect(getAssistantProvider(ACCOUNT)).toBe('guttertoken')
    // ...and says so honestly rather than silently answering on the other rail.
    expect(screen.getByTestId('assistant-provider-effective')).toHaveTextContent(
      /Nothing can answer yet: add a GutterToken key/i
    )
  })
})
