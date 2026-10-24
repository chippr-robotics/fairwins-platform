/**
 * Spec 045 — the single connect surface (US2/US3/US4):
 *  - ordering + featured badges (Passkey, WalletConnect over Browser Wallet);
 *  - honest availability states;
 *  - first-time passkey explainer, shown at most once (FR-010);
 *  - in-app account picker when several passkeys are known (FR-007), with the
 *    chosen credential pinned into the connect call;
 *  - errors surface in the dialog; ceremony cancellation resets silently.
 *
 * Onboarding step-reduction: when this browser already knows a usable passkey
 * the dialog OPENS on that chooser (unlock in one tap) instead of methods →
 * Passkey → chooser, with every connector still one tap away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockWallet = {
  isConnectModalOpen: true,
  closeConnectModal: vi.fn(),
  connectWallet: vi.fn().mockResolvedValue(true),
  isConnected: false,
  connectors: [],
}
vi.mock('../../../hooks/useWalletManagement', () => ({
  useWallet: () => mockWallet,
}))

const mockAvailability = {
  isChecking: false,
  isAvailable: vi.fn(() => true),
  unavailableReason: vi.fn(() => undefined),
  status: {},
}
vi.mock('../../../hooks/useConnectorAvailability', () => ({
  useConnectorAvailability: () => mockAvailability,
}))

import ConnectModal from '../ConnectModal'
import { rememberCredential } from '../../../lib/passkey/credentials'
import { markExplainerSeen, hasSeenExplainer } from '../../../lib/passkey/explainer'

const CONNECTORS = [
  { id: 'injected', name: 'MetaMask', type: 'injected' },
  { id: 'walletConnect', name: 'WalletConnect', type: 'walletConnect' },
  { id: 'fairwinsPasskey', name: 'Passkey', type: 'passkey' },
]

const PK = (n) => ({ x: `0x${String(n).repeat(64)}`, y: `0x${String(n).repeat(64)}` })

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mockWallet.isConnectModalOpen = true
  mockWallet.isConnected = false
  mockWallet.connectors = CONNECTORS
  mockWallet.connectWallet = vi.fn().mockResolvedValue(true)
  mockAvailability.isChecking = false
  mockAvailability.isAvailable = vi.fn(() => true)
  mockAvailability.unavailableReason = vi.fn(() => undefined)
})

describe('ConnectModal — single surface ordering (US2)', () => {
  it('features Passkey (Recommended) and WalletConnect ahead of Browser Wallet', () => {
    render(<ConnectModal />)
    const options = screen.getByTestId('connect-options').querySelectorAll('.connect-modal__option')
    const names = [...options].map((b) => b.querySelector('.connect-modal__option-name').textContent)
    // The injected row resolves through getWalletLabel (vendor detection —
    // 'MetaMask' here from the test connector name); what matters is that it
    // sorts LAST, under "More options".
    expect(names).toEqual(['Passkey', 'WalletConnect', 'MetaMask'])
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    expect(screen.getByText('More options')).toBeInTheDocument()
  })

  it('shows honest unavailability instead of failing on tap (FR-003)', () => {
    mockAvailability.isAvailable = vi.fn((c) => c.type !== 'injected')
    mockAvailability.unavailableReason = vi.fn((c) =>
      c.type === 'injected' ? 'No browser wallet detected' : undefined
    )
    render(<ConnectModal />)
    expect(screen.getByText('No browser wallet detected')).toBeInTheDocument()
    const row = screen.getByText('MetaMask').closest('button')
    expect(row).toBeDisabled()
  })

  it('traps Tab focus inside the dialog (aria-modal keyboard navigation)', async () => {
    const user = userEvent.setup()
    render(<ConnectModal />)
    const dialog = screen.getByRole('dialog')
    const focusables = dialog.querySelectorAll('button:not([disabled]), [href]')
    const last = focusables[focusables.length - 1]
    last.focus()
    await user.tab() // Tab from the last element wraps to the first
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(focusables[0])
    await user.tab({ shift: true }) // Shift+Tab from the first wraps to the last
    expect(document.activeElement).toBe(last)
  })

  it('renders nothing when closed and closes itself once connected', async () => {
    mockWallet.isConnectModalOpen = false
    const { rerender, container } = render(<ConnectModal />)
    expect(container.firstChild).toBeNull()

    mockWallet.isConnectModalOpen = true
    mockWallet.isConnected = true
    rerender(<ConnectModal />)
    await waitFor(() => expect(mockWallet.closeConnectModal).toHaveBeenCalled())
  })

  it('connects classic wallets directly through the serialized context path', async () => {
    const user = userEvent.setup()
    render(<ConnectModal />)
    await user.click(screen.getByText('WalletConnect').closest('button'))
    expect(mockWallet.connectWallet).toHaveBeenCalledWith('walletConnect', undefined)
  })

  it('surfaces connect errors in the dialog (alert), not the console alone', async () => {
    mockWallet.connectWallet = vi.fn().mockRejectedValue(new Error('Please approve the connection request'))
    const user = userEvent.setup()
    render(<ConnectModal />)
    await user.click(screen.getByText('WalletConnect').closest('button'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Please approve the connection request')
    )
  })
})

describe('ConnectModal — first-time passkey explainer (US4)', () => {
  /*
   * These two used to assert that an empty credential book connects IMMEDIATELY — the exact
   * assumption that lost members their account. A browser with no record cannot tell a brand-new
   * member from one whose passkey synced here from another device, so connecting immediately
   * means signing the second one UP, into a different account, with their funds apparently gone.
   * The chooser is now always the next step; only the member resolves the ambiguity.
   */
  it('shows the explainer once, then offers the chooser on continue', async () => {
    const user = userEvent.setup()
    render(<ConnectModal />)
    await user.click(screen.getByText('Passkey').closest('button'))
    expect(screen.getByText(/What's a passkey\?/)).toBeInTheDocument()
    expect(mockWallet.connectWallet).not.toHaveBeenCalled()

    await user.click(screen.getByText('Continue with passkey'))
    expect(hasSeenExplainer()).toBe(true)
    expect(screen.getByTestId('passkey-picker')).toBeInTheDocument()
    // Still no ceremony: an empty book offers the choice rather than guessing at it.
    expect(mockWallet.connectWallet).not.toHaveBeenCalled()

    await user.click(screen.getByText('Create a new account'))
    expect(mockWallet.connectWallet).toHaveBeenCalledWith('fairwinsPasskey', { mode: 'sign-up' })
  })

  it('offers the synced-passkey route from a browser that knows nothing', async () => {
    const user = userEvent.setup()
    render(<ConnectModal />)
    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('Continue with passkey'))

    // The route that did not exist before: reachable WITHOUT first minting a stray account.
    await user.click(screen.getByText('I already have a passkey'))
    expect(mockWallet.connectWallet).toHaveBeenCalledWith('fairwinsPasskey', {
      mode: 'sign-in',
      discoverable: true,
    })
  })

  it('never re-shows after it was seen (FR-010)', async () => {
    markExplainerSeen()
    const user = userEvent.setup()
    render(<ConnectModal />)
    await user.click(screen.getByText('Passkey').closest('button'))
    expect(screen.queryByText(/What's a passkey\?/)).not.toBeInTheDocument()
    expect(screen.getByTestId('passkey-picker')).toBeInTheDocument()
  })

  it('dismissing counts as seen and returns to the methods list', async () => {
    const user = userEvent.setup()
    render(<ConnectModal />)
    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('Back'))
    expect(hasSeenExplainer()).toBe(true)
    expect(screen.getByTestId('connect-options')).toBeInTheDocument()
    expect(mockWallet.connectWallet).not.toHaveBeenCalled()
  })
})

describe('ConnectModal — multi-passkey account picker (US3)', () => {
  beforeEach(() => {
    markExplainerSeen()
  })

  it('offers the chooser for a single known passkey — never silently pins index 0 (issue #849)', async () => {
    rememberCredential({ credentialId: 'c-only', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    const user = userEvent.setup()
    render(<ConnectModal />)

    // A member with one recorded passkey is still presented with a choice
    // (acceptance #1) rather than being locked to the first credential.
    expect(screen.getByTestId('passkey-picker')).toBeInTheDocument()
    expect(mockWallet.connectWallet).not.toHaveBeenCalled()
    expect(screen.getByText('Use a different passkey…')).toBeInTheDocument()
    expect(screen.getByText('Create a new account')).toBeInTheDocument()

    await user.click(screen.getByText('Phone').closest('button'))
    expect(mockWallet.connectWallet).toHaveBeenCalledWith('fairwinsPasskey', {
      credentialId: 'c-only',
      mode: 'sign-in',
    })
  })

  it('offers an explicit account choice when several passkeys are known — the app never guesses', async () => {
    rememberCredential({ credentialId: 'c1', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    rememberCredential({ credentialId: 'c2', publicKey: PK(2), address: '0x' + 'b'.repeat(40), label: 'Laptop' })
    const user = userEvent.setup()
    render(<ConnectModal />)

    expect(screen.getByTestId('passkey-picker')).toBeInTheDocument()
    expect(mockWallet.connectWallet).not.toHaveBeenCalled()

    await user.click(screen.getByText('Laptop').closest('button'))
    expect(mockWallet.connectWallet).toHaveBeenCalledWith('fairwinsPasskey', {
      credentialId: 'c2',
      mode: 'sign-in',
    })
  })

  it('excludes records that cannot transact from the picker (they cannot sign anyway)', async () => {
    rememberCredential({ credentialId: 'c1', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    rememberCredential({ credentialId: 'c-broken', address: '0x' + 'b'.repeat(40), label: 'Broken' }) // no key
    const user = userEvent.setup()
    render(<ConnectModal />)
    // The picker lists only the usable record; the broken one never appears.
    expect(screen.getByTestId('passkey-picker')).toBeInTheDocument()
    expect(screen.getByText('Phone')).toBeInTheDocument()
    expect(screen.queryByText('Broken')).not.toBeInTheDocument()

    await user.click(screen.getByText('Phone').closest('button'))
    expect(mockWallet.connectWallet).toHaveBeenCalledWith('fairwinsPasskey', {
      credentialId: 'c1',
      mode: 'sign-in',
    })
  })

  it('supports "use a different passkey" (unpinned) and "create new account" escapes', async () => {
    rememberCredential({ credentialId: 'c1', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    rememberCredential({ credentialId: 'c2', publicKey: PK(2), address: '0x' + 'b'.repeat(40), label: 'Laptop' })
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Use a different passkey…'))
    // Discoverable request (no allowCredentials) so passkeys this browser has
    // never recorded — but that live on the device — are reachable (issue #849).
    expect(mockWallet.connectWallet).toHaveBeenLastCalledWith('fairwinsPasskey', {
      mode: 'sign-in',
      discoverable: true,
    })

    await user.click(screen.getByText('Create a new account'))
    expect(mockWallet.connectWallet).toHaveBeenLastCalledWith('fairwinsPasskey', { mode: 'sign-up' })
  })

  it('lets the user remove a stale entry from this browser', async () => {
    rememberCredential({ credentialId: 'c1', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    rememberCredential({ credentialId: 'c2', publicKey: PK(2), address: '0x' + 'b'.repeat(40), label: 'Stale' })
    const user = userEvent.setup()
    render(<ConnectModal />)
    await user.click(screen.getByLabelText(/Remove Stale/))
    expect(screen.queryByText('Stale')).not.toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem('fairwins.passkey.credentials.v1'))
    expect(stored.map((c) => c.credentialId)).toEqual(['c1'])
  })
})

describe('ConnectModal — returning members unlock in one tap', () => {
  beforeEach(() => {
    markExplainerSeen()
  })

  it('opens straight on the unlock chooser when this browser knows a passkey', () => {
    rememberCredential({ credentialId: 'c1', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    render(<ConnectModal />)

    // No methods list to walk through first — the account is one tap away.
    expect(screen.getByTestId('passkey-picker')).toBeInTheDocument()
    expect(screen.queryByTestId('connect-options')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Unlock your account' })).toBeInTheDocument()
  })

  it('still reaches every other connector from the chooser', async () => {
    rememberCredential({ credentialId: 'c1', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('More sign-in options'))
    expect(screen.getByTestId('connect-options')).toBeInTheDocument()
    await user.click(screen.getByText('WalletConnect').closest('button'))
    expect(mockWallet.connectWallet).toHaveBeenCalledWith('walletConnect', undefined)
  })

  it('returns to the chooser — not backwards to the methods list — when a ceremony is cancelled', async () => {
    rememberCredential({ credentialId: 'c1', publicKey: PK(1), address: '0x' + 'a'.repeat(40), label: 'Phone' })
    const cancelled = Object.assign(new Error('Passkey prompt was cancelled'), { name: 'CeremonyCancelled' })
    mockWallet.connectWallet = vi.fn().mockRejectedValue(cancelled)
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Phone').closest('button'))
    await waitFor(() => expect(screen.getByTestId('passkey-picker')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a browser with no recorded passkey still opens on the methods list', () => {
    render(<ConnectModal />)
    expect(screen.getByTestId('connect-options')).toBeInTheDocument()
    expect(screen.queryByTestId('passkey-picker')).not.toBeInTheDocument()
  })
})

/**
 * Spec 104 — a ceremony that succeeds but leaves the ACCOUNT unconfirmed.
 *
 * The property under test is that the dialog offers a way forward instead of a red sentence over
 * a dead end, and that it keeps the resolver's three verdicts apart all the way to the member.
 */
describe('ConnectModal — recovery when the account cannot be confirmed (spec 104)', () => {
  const unresolved = (outcome, reason, extra = {}) =>
    Object.assign(new Error(reason), { name: 'AccountUnresolved', outcome, ...extra })

  it('offers recovery rather than an error when nothing on chain lists the passkey', async () => {
    mockWallet.connectWallet = vi
      .fn()
      .mockRejectedValue(
        unresolved('none-found', 'No account on this network lists this passkey as an owner.', {
          credentialId: 'cred-phone',
        })
      )
    markExplainerSeen() // the explainer has its own tests; this suite is about what follows it
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('I already have a passkey'))

    await waitFor(() => expect(screen.getByTestId('recover-account')).toBeInTheDocument())
    // The reason is shown as guidance, not as the dialog's error banner — the member has
    // something to do here.
    expect(screen.getByTestId('recover-reason')).toHaveTextContent(/lists this passkey/i)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('an unreachable network leads with RETRY and never reads as "no account"', async () => {
    // The distinction constitution III exists for: `unverified` is not `none-found`. Rendering
    // them alike tells a member with a perfectly good account that they have none.
    mockWallet.connectWallet = vi
      .fn()
      .mockRejectedValue(
        unresolved(
          'unverified',
          'We could not reach the network to check. This does not mean you have no account.',
          { credentialId: 'cred-phone' }
        )
      )
    markExplainerSeen() // the explainer has its own tests; this suite is about what follows it
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('I already have a passkey'))

    await waitFor(() => expect(screen.getByTestId('recover-account')).toBeInTheDocument())
    expect(screen.getByText('Try again')).toBeInTheDocument()
    expect(screen.getByTestId('recover-reason')).toHaveTextContent(/does not mean you have no account/i)
    expect(screen.getByLabelText(/or enter your account address/i)).toBeInTheDocument()
  })

  it('passes the member’s address BACK THROUGH the connector, pinned to the same passkey', async () => {
    // The address never becomes an account on the client's say-so: it is handed to the connector,
    // which checks it against the chain. What this asserts is only that it is carried, and that
    // the retry is pinned to the credential the ceremony already identified.
    mockWallet.connectWallet = vi
      .fn()
      .mockRejectedValue(unresolved('none-found', 'Nothing found.', { credentialId: 'cred-phone' }))
    markExplainerSeen() // the explainer has its own tests; this suite is about what follows it
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('I already have a passkey'))
    await waitFor(() => expect(screen.getByTestId('recover-account')).toBeInTheDocument())

    const ADDR = '0x' + 'b'.repeat(40)
    await user.type(screen.getByLabelText(/enter your account address/i), ADDR)
    await user.click(screen.getByText('Find my account').closest('button'))

    await waitFor(() =>
      expect(mockWallet.connectWallet).toHaveBeenLastCalledWith('fairwinsPasskey', {
        mode: 'sign-in',
        credentialId: 'cred-phone',
        discoverable: undefined,
        accountAddress: ADDR,
      })
    )
  })

  it('offers a not-yet-deployed account as its own labelled choice, and takes it only when pressed', async () => {
    // The member this protects is the one who signed up on another device and has not spent yet:
    // their account is real and simply holds no code. It is offered rather than opened, because
    // US2's rule is that an unverified address is never presented as though the app confirmed it —
    // and offered rather than refused, because they cannot type an address nobody has shown them.
    const CF = '0x' + 'c'.repeat(40)
    mockWallet.connectWallet = vi
      .fn()
      .mockRejectedValue(
        unresolved('none-found', 'No account on this network lists this passkey as an owner.', {
          credentialId: 'cred-phone',
          counterfactualAddress: CF,
        })
      )
    markExplainerSeen()
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('I already have a passkey'))
    await waitFor(() => expect(screen.getByTestId('recover-account')).toBeInTheDocument())

    // Shown, with what it is stated — not opened behind the member's back.
    expect(screen.getByText(CF)).toBeInTheDocument()
    expect(screen.getByText(/has not been used on the network/i)).toBeInTheDocument()

    mockWallet.connectWallet.mockClear()
    await user.click(screen.getByText('Continue to that account').closest('button'))
    await waitFor(() =>
      expect(mockWallet.connectWallet).toHaveBeenLastCalledWith('fairwinsPasskey', {
        mode: 'sign-in',
        credentialId: 'cred-phone',
        discoverable: undefined,
        acceptCounterfactual: true,
      })
    )
  })

  it('offers NO such choice when the chain was merely unreadable', async () => {
    // An unreachable network says nothing about whether an account exists, so inviting the member
    // to "continue to a new one" here would be inviting them to walk away from a real one.
    mockWallet.connectWallet = vi
      .fn()
      .mockRejectedValue(
        unresolved('unverified', 'We could not reach the network to check.', {
          credentialId: 'cred-phone',
          counterfactualAddress: null,
        })
      )
    markExplainerSeen()
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('I already have a passkey'))
    await waitFor(() => expect(screen.getByTestId('recover-account')).toBeInTheDocument())

    expect(screen.queryByText(/continue to that account/i)).not.toBeInTheDocument()
    expect(screen.getByText('Try again')).toBeInTheDocument()
  })

  it('refuses to submit a malformed address, in words rather than colour alone', async () => {
    mockWallet.connectWallet = vi
      .fn()
      .mockRejectedValue(unresolved('none-found', 'Nothing found.', { credentialId: 'cred-phone' }))
    markExplainerSeen() // the explainer has its own tests; this suite is about what follows it
    const user = userEvent.setup()
    render(<ConnectModal />)

    await user.click(screen.getByText('Passkey').closest('button'))
    await user.click(screen.getByText('I already have a passkey'))
    await waitFor(() => expect(screen.getByTestId('recover-account')).toBeInTheDocument())

    mockWallet.connectWallet.mockClear()
    await user.type(screen.getByLabelText(/enter your account address/i), '0xnotanaddress')
    await user.click(screen.getByText('Find my account').closest('button'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/should start with 0x/i)
    expect(mockWallet.connectWallet).not.toHaveBeenCalled()
  })
})
