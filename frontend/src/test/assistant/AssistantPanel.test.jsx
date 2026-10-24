/**
 * AssistantPanel (specs 095 + 104) — which step the panel opens on, and what it says when a turn
 * fails.
 *
 * The panel's contract is that it never invents anything: not a reply, and not a reason. Two
 * families of assertion follow from that.
 *
 * THE FIRST STEP IS DECIDED BY `resolveProvider`, NOT BY THIS COMPONENT.
 *   · FairWins    → "Sign to start" (the grant IS the rail — the gateway is the model path).
 *   · GutterToken → the chat opens AT ONCE. No FairWins service is in the model path, so there is
 *                   nothing to authorise; the read grant is OFFERED, dismissibly, and only to a
 *                   member whose own data the tools could read.
 *   · Nothing     → a chooser, or, for a membership that is pending or UNREADABLE, an honest
 *                   sentence. Never a denial for a read that did not happen.
 *
 * EVERY ERROR STATE HAS ITS OWN SENTENCE AND ITS OWN ACTION. A `key_invalid` offers the key sheet,
 * a `key_missing` offers the chooser, an `out_of_credit` links out to top up, a GutterToken `quota`
 * says whose rate limit it was. Collapsing any of these into "something went wrong" would leave the
 * member with no idea which of them to fix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const m = vi.hoisted(() => ({
  byokEnabled: true,
  walletState: null,
  runTurn: null,
  signOk: true,
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
  default: () => ({ getRoleDetails: () => null, refresh: vi.fn() }),
  MembershipTier: { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 },
}))
vi.mock('../../lib/apiAccess/grantSigner', () => ({
  resolveGrantSigner: () =>
    m.signOk
      ? { canSign: true, kind: 'eoa', sign: async () => '0x' + '11'.repeat(65) }
      : { canSign: false, kind: 'none', reason: 'This account cannot authorize a session.' },
}))
vi.mock('../../lib/assistant/conversation', () => ({
  runAssistantTurn: (...args) => m.runTurn(...args),
}))

import AssistantPanel from '../../components/assistant/AssistantPanel'
import { AssistantError, __resetAssistantSessionForTests } from '../../lib/assistant/assistantClient'
import {
  __resetAssistantPrefsForTests,
  setAssistantEnabled,
  setAssistantProvider,
} from '../../lib/assistant/assistantPrefs'
import {
  __resetGutterTokenKeyForTests,
  saveGutterTokenKey,
} from '../../lib/assistant/guttertokenKeyStore'
import { loadMemory } from '../../lib/assistant/memoryStore'

const ACCOUNT = '0x' + '7'.repeat(40)
const KEY = 'sk-panel-fixture-wxyz'
const ACTIVE = { isActive: true, tier: 2, tierName: 'Silver', readable: true, hasRole: true }
const INACTIVE = { isActive: false, tier: 0, tierName: 'None', readable: true, hasRole: false }
const UNREADABLE = { isActive: false, tier: 0, tierName: 'Unknown', readable: false, hasRole: false }

function renderPanel(membership = ACTIVE, props = {}) {
  return render(
    <MemoryRouter>
      <AssistantPanel
        open
        onClose={props.onClose ?? vi.fn()}
        surface="/wallet"
        membership={membership}
        onRetryMembership={props.onRetryMembership ?? vi.fn()}
      />
    </MemoryRouter>
  )
}

/** Put the account on the GutterToken rail: preference + a saved key. */
function onGutterTokenRail() {
  setAssistantProvider(ACCOUNT, 'guttertoken')
  saveGutterTokenKey(ACCOUNT, KEY)
}

const ask = (text = 'what is a wager?') => {
  fireEvent.change(screen.getByLabelText(/message the assistant/i), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
}

/**
 * Wait for a reply BUBBLE. The reply text is deliberately in two places at once — the thread and
 * the polite live region — so every lookup here is scoped to the thread.
 */
const thread = () => within(screen.getByTestId('assistant-thread'))
const findReply = (re) => thread().findByText(re)

/** A `runAssistantTurn` that throws the given `AssistantError` state. */
const failsWith = (state, extra = {}) =>
  vi.fn().mockRejectedValue(new AssistantError(`raw ${state}`, { state, ...extra }))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetAssistantPrefsForTests()
  __resetGutterTokenKeyForTests()
  __resetAssistantSessionForTests()
  m.byokEnabled = true
  m.signOk = true
  m.walletState = { address: ACCOUNT, signer: {}, loginMethod: 'injected', chainId: 137, isConnected: true }
  m.runTurn = vi.fn().mockResolvedValue({
    reply: 'A wager is an agreement between two people.',
    model: 'claude-opus-5',
    usage: { inputTokens: 10, outputTokens: 20 },
    toolEvents: [],
    roundsExhausted: false,
  })
  setAssistantEnabled(ACCOUNT, true)
})

describe('AssistantPanel — the provider badge', () => {
  it('names the FairWins rail', () => {
    renderPanel()
    expect(screen.getByTestId('assistant-provider-badge')).toHaveTextContent('Answered by FairWins')
  })

  it('names the GutterToken rail, and says whose credits pay', () => {
    onGutterTokenRail()
    renderPanel()
    expect(screen.getByTestId('assistant-provider-badge')).toHaveTextContent(
      'Answered by GutterToken on your credits'
    )
  })

  it('shows no badge while nothing can answer', () => {
    renderPanel(INACTIVE)
    expect(screen.queryByTestId('assistant-provider-badge')).not.toBeInTheDocument()
  })
})

describe('AssistantPanel — the first step', () => {
  it('asks a FairWins member to sign before anything is sent', () => {
    renderPanel()
    expect(screen.getByTestId('assistant-authorize')).toBeInTheDocument()
    expect(screen.queryByLabelText(/message the assistant/i)).not.toBeInTheDocument()
  })

  it('opens straight into the chat on the GutterToken rail — there is nothing to authorise', () => {
    onGutterTokenRail()
    renderPanel(INACTIVE)
    expect(screen.queryByTestId('assistant-authorize')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/message the assistant/i)).toBeInTheDocument()
    // A non-member has no member data to read, so no grant is offered either.
    expect(screen.queryByTestId('assistant-grant-offer')).not.toBeInTheDocument()
  })

  it('offers the read grant, dismissibly, to a MEMBER on the GutterToken rail', () => {
    onGutterTokenRail()
    renderPanel(ACTIVE)
    const offer = screen.getByTestId('assistant-grant-offer')
    expect(offer).toHaveTextContent(/optional, 24 h, read-only/i)
    expect(offer).toHaveTextContent(/no transaction, no fee, nothing moves/i)

    fireEvent.click(screen.getByTestId('assistant-grant-offer-dismiss'))
    expect(screen.queryByTestId('assistant-grant-offer')).not.toBeInTheDocument()
    // Dismissing it does not take the chat away.
    expect(screen.getByLabelText(/message the assistant/i)).toBeInTheDocument()
  })

  it('offers a chooser when nothing can answer, with a membership link for a non-member', () => {
    renderPanel(INACTIVE)
    const choose = screen.getByTestId('assistant-choose')
    expect(choose).toHaveTextContent(/Nothing can answer yet/i)
    expect(screen.getByTestId('assistant-choose-guttertoken')).toBeInTheDocument()
    expect(screen.getByTestId('assistant-choose-fairwins')).toHaveAttribute(
      'href',
      '/wallet?tab=membership'
    )
  })

  it('opens the key sheet from the chooser', () => {
    renderPanel(INACTIVE)
    fireEvent.click(screen.getByTestId('assistant-choose-guttertoken'))
    expect(screen.getByTestId('guttertoken-key-sheet')).toBeInTheDocument()
  })

  it('drops the GutterToken choice on a tenant without assistant-byok', () => {
    m.byokEnabled = false
    renderPanel(INACTIVE)
    expect(screen.queryByTestId('assistant-choose-guttertoken')).not.toBeInTheDocument()
    expect(screen.getByTestId('assistant-choose-fairwins')).toBeInTheDocument()
  })

  it('says "checking" while membership is PENDING — never a denial', () => {
    renderPanel(null)
    expect(screen.getByTestId('assistant-pending')).toHaveTextContent(/checking your membership/i)
    expect(screen.queryByTestId('assistant-choose')).not.toBeInTheDocument()
  })

  it('says the membership could not be READ, and offers a retry — never a denial', () => {
    const onRetryMembership = vi.fn()
    renderPanel(UNREADABLE, { onRetryMembership })
    const box = screen.getByTestId('assistant-unreadable')
    expect(box).toHaveTextContent(/network problem, not an answer about your account/i)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetryMembership).toHaveBeenCalled()
  })
})

describe('AssistantPanel — a grant starts a new thread', () => {
  it('clears the conversation when a member signs mid-chat on the GutterToken rail', async () => {
    onGutterTokenRail()
    renderPanel(ACTIVE)

    ask()
    await findReply(/A wager is an agreement/i)
    expect(loadMemory(ACCOUNT)).toHaveLength(2)

    fireEvent.click(screen.getByTestId('assistant-grant-offer-sign'))

    // The tool set is part of what a conversation IS, so it must not change under one.
    await screen.findByTestId('assistant-notice')
    expect(screen.getByTestId('assistant-notice')).toHaveTextContent(/New conversation/i)
    expect(thread().queryByText(/A wager is an agreement/i)).not.toBeInTheDocument()
    expect(loadMemory(ACCOUNT)).toHaveLength(0)
  })
})

describe('AssistantPanel — sending', () => {
  it('persists TEXT turns only, and never the tool results', async () => {
    onGutterTokenRail()
    m.runTurn = vi.fn(async ({ onToolEvent }) => {
      onToolEvent({ name: 'get_wagers', phase: 'start' })
      onToolEvent({ name: 'get_wagers', phase: 'done', ok: true })
      return {
        reply: 'You have two open wagers.',
        model: 'claude-opus-5',
        usage: {},
        toolEvents: [{ name: 'get_wagers', ok: true }],
        roundsExhausted: false,
      }
    })
    renderPanel(INACTIVE)

    ask('what are my wagers?')
    await findReply(/You have two open wagers/i)

    const stored = loadMemory(ACCOUNT)
    expect(stored.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(stored)).not.toContain('get_wagers')
  })

  it('shows what was read, and reports it as a Sources line afterwards', async () => {
    onGutterTokenRail()
    m.runTurn = vi.fn(async ({ onToolEvent }) => {
      onToolEvent({ name: 'get_wagers', phase: 'start' })
      onToolEvent({ name: 'get_wagers', phase: 'done', ok: false, code: 'unreadable' })
      return { reply: 'I could not read them.', model: null, usage: {}, toolEvents: [], roundsExhausted: false }
    })
    renderPanel(INACTIVE)

    ask('what are my wagers?')
    await screen.findByTestId('assistant-tool-result')

    // "could not be read" — never a zero, never a silent omission.
    expect(screen.getByTestId('assistant-tool-result')).toHaveTextContent(/your wagers/i)
    expect(screen.getByTestId('assistant-tool-result')).toHaveTextContent(/could not be read/i)
  })

  it('announces replies POLITELY — a reply is not an alert', async () => {
    onGutterTokenRail()
    renderPanel(INACTIVE)
    ask()
    await findReply(/A wager is an agreement/i)
    const live = document.querySelector('[aria-live="polite"]')
    expect(live).toHaveTextContent(/A wager is an agreement/i)
  })

  it('repeats the disclaimer under every reply', async () => {
    onGutterTokenRail()
    renderPanel(INACTIVE)
    ask()
    await findReply(/A wager is an agreement/i)
    expect(thread().getByText(/AI-generated — verify before acting/i)).toBeInTheDocument()
  })
})

describe('AssistantPanel — every error state has its own sentence and action', () => {
  beforeEach(() => {
    onGutterTokenRail()
  })

  it('key_invalid: says GutterToken refused the key, and offers to re-enter it', async () => {
    m.runTurn = failsWith('key_invalid')
    renderPanel(INACTIVE)
    ask()

    const error = await screen.findByTestId('assistant-error')
    expect(error).toHaveTextContent(/GutterToken did not accept your key/i)
    fireEvent.click(screen.getByTestId('assistant-error-update-key'))
    expect(screen.getByTestId('guttertoken-key-sheet')).toBeInTheDocument()
  })

  it('key_missing: says nothing can answer, and puts the chooser back', async () => {
    m.runTurn = failsWith('key_missing')
    renderPanel(INACTIVE)
    ask()

    await waitFor(() => expect(screen.getByTestId('assistant-choose')).toBeInTheDocument())
    expect(screen.getByTestId('assistant-choose-guttertoken')).toBeInTheDocument()
  })

  it('out_of_credit: says the balance is empty, links out to top up, and keeps a retry', async () => {
    m.runTurn = failsWith('out_of_credit')
    renderPanel(INACTIVE)
    ask()

    const error = await screen.findByTestId('assistant-error')
    expect(error).toHaveTextContent(/Your GutterToken balance is empty/i)
    const topUp = screen.getByTestId('assistant-error-top-up')
    expect(topUp).toHaveAttribute('rel', 'noopener noreferrer')
    expect(topUp.getAttribute('href')).toContain('app.guttertokens.com')
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('quota on GutterToken: names whose rate limit it was', async () => {
    m.runTurn = failsWith('quota')
    renderPanel(INACTIVE)
    ask()

    expect(await screen.findByTestId('assistant-error')).toHaveTextContent(
      /GutterToken is rate-limiting requests from your network/i
    )
  })

  it('no_grant: explains what is missing and re-offers the grant rather than failing flat', async () => {
    m.runTurn = failsWith('no_grant')
    renderPanel(ACTIVE)
    // The grant offer is up already for a member; dismiss it so its return is the assertion.
    fireEvent.click(screen.getByTestId('assistant-grant-offer-dismiss'))
    ask()

    const error = await screen.findByTestId('assistant-error')
    expect(error).toHaveTextContent(/short, read-only grant/i)
    expect(screen.getByTestId('assistant-grant-offer')).toBeInTheDocument()
  })

  it('a terminal state offers no retry, and says why retrying would not help', async () => {
    m.runTurn = failsWith('unconfigured')
    renderPanel(INACTIVE)
    ask()

    const error = await screen.findByTestId('assistant-error')
    expect(error).toHaveTextContent(/sending again will get the same answer/i)
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  it('never renders a reply when the turn failed', async () => {
    m.runTurn = failsWith('unavailable')
    renderPanel(INACTIVE)
    ask('what is a wager?')

    await screen.findByTestId('assistant-error')
    // The member's own question is still there; nothing was invented in answer to it.
    expect(thread().getByText('what is a wager?')).toBeInTheDocument()
    expect(loadMemory(ACCOUNT).filter((t) => t.role === 'assistant')).toHaveLength(0)
  })
})
