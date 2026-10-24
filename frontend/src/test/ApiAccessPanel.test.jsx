/**
 * ApiAccessPanel (spec 095) — the Settings card that mints capability tokens.
 *
 * Four things are pinned here, each because getting it wrong is invisible until it matters:
 *   · membership gating has THREE states and an unreadable read is never a denial;
 *   · creating a key produces an `fw1.` token in the UI and metadata WITHOUT it in storage;
 *   · the token is shown once — dismissing it destroys the only copy;
 *   · revoking posts the signed revocation and reports what that actually bought, including the
 *     grant's own expiry, rather than implying a durable withdrawal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ethers } from 'ethers'

let walletState
let membershipState
let gatewayUrl
const refresh = vi.fn()

vi.mock('../hooks/useWalletManagement', () => ({ useWallet: () => walletState }))
vi.mock('../hooks/useRoleDetails', () => ({
  default: () => ({ getRoleDetails: () => membershipState, refresh }),
  MembershipTier: { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 },
}))
vi.mock('../lib/relay/intentClient', () => ({ relayerBaseUrl: () => gatewayUrl }))

import ApiAccessPanel from '../components/account/ApiAccessPanel'
import { API_KEYS_STORAGE_KEY, buildGrant, listKeyRecords, recordApiKey } from '../lib/apiAccess/apiKeys'

const ACTIVE = { isActive: true, tier: 1, tierName: 'Bronze', readable: true, hasRole: true }
const INACTIVE = { isActive: false, tier: 0, tierName: 'None', readable: true, hasRole: false }
const UNREADABLE = { isActive: false, tier: 0, tierName: 'Unknown', readable: false, hasRole: false }

let wallet

function renderPanel() {
  return render(
    <MemoryRouter>
      <ApiAccessPanel />
    </MemoryRouter>
  )
}

/** Cards are collapsed by default; open the one under test. */
function openCard() {
  fireEvent.click(screen.getByRole('button', { name: /api access/i }))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
// Fixed key (Wallet.createRandom's mnemonic path hits an ethers/jsdom crypto quirk under vitest).
  wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  walletState = {
    address: wallet.address,
    signer: wallet,
    loginMethod: 'injected',
    chainId: 137,
    isConnected: true,
  }
  membershipState = ACTIVE
  gatewayUrl = 'https://relay.example'
  global.fetch = vi.fn()
})

describe('membership gating (three states, never two)', () => {
  it('says it is checking while the first read is in flight', () => {
    membershipState = null
    renderPanel()
    openCard()
    expect(screen.getByText(/checking your membership/i)).toBeInTheDocument()
  })

  it('offers a route to upgrade — never a dead disabled control', () => {
    membershipState = INACTIVE
    renderPanel()
    openCard()
    expect(screen.getByTestId('api-access-upgrade')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /go to membership/i })).toBeEnabled()
    expect(screen.queryByTestId('api-access-console')).not.toBeInTheDocument()
  })

  it('treats an UNREADABLE membership as unknown, not as "not a member"', () => {
    membershipState = UNREADABLE
    renderPanel()
    openCard()
    const node = screen.getByTestId('api-access-unreadable')
    expect(node).toHaveTextContent(/could not read your membership/i)
    expect(node).toHaveTextContent(/not an answer about your account/i)
    // Emphatically NOT the upgrade prompt: that would tell a member with a slow RPC they own nothing.
    expect(screen.queryByTestId('api-access-upgrade')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the console to an active member', () => {
    renderPanel()
    openCard()
    expect(screen.getByTestId('api-access-console')).toBeInTheDocument()
  })
})

describe('creating a key', () => {
  it('mints an fw1 token, shows it once, and stores metadata without it', async () => {
    renderPanel()
    openCard()

    fireEvent.change(screen.getByLabelText(/name \(only you see this\)/i), { target: { value: 'my agent' } })
    fireEvent.click(screen.getByRole('button', { name: /^create key$/i }))

    const token = await screen.findByTestId('api-access-token')
    expect(token.textContent.startsWith('fw1.')).toBe(true)

    // Metadata is stored; the token is not — asserted against the RAW storage string.
    const raw = localStorage.getItem(`fw_user_${wallet.address.toLowerCase()}_${API_KEYS_STORAGE_KEY}`)
    expect(raw).toBeTruthy()
    expect(raw).not.toContain(token.textContent)
    expect(raw).not.toContain('fw1.')
    expect(JSON.parse(raw)[0].label).toBe('my agent')

    // The reveal states plainly that this is the only showing.
    expect(screen.getByTestId('api-access-reveal')).toHaveTextContent(/only time it is shown/i)
    expect(screen.getByTestId('api-access-reveal')).toHaveTextContent(/not saved/i)
  })

  it('destroys the only copy when the member dismisses the reveal', async () => {
    renderPanel()
    openCard()
    fireEvent.click(screen.getByRole('button', { name: /^create key$/i }))
    await screen.findByTestId('api-access-token')

    fireEvent.click(screen.getByRole('button', { name: /i have stored it/i }))

    expect(screen.queryByTestId('api-access-token')).not.toBeInTheDocument()
    // There is no "show it again" — only the create form comes back.
    expect(screen.getByTestId('api-access-create')).toBeInTheDocument()
    expect(screen.getAllByTestId('api-access-key')).toHaveLength(1)
  })

  it('refuses to sign a key that may do nothing', async () => {
    renderPanel()
    openCard()
    for (const box of screen.getAllByRole('checkbox')) {
      if (box.checked) fireEvent.click(box)
    }
    expect(screen.getByRole('button', { name: /^create key$/i })).toBeDisabled()
  })

  it('still creates a key with no gateway configured, and says what is unavailable', async () => {
    gatewayUrl = ''
    renderPanel()
    openCard()

    expect(screen.getByTestId('api-access-no-gateway')).toHaveTextContent(/no fairwins api gateway configured/i)
    // Signing is local, so the button is live rather than disabled with no explanation.
    fireEvent.click(screen.getByRole('button', { name: /^create key$/i }))
    expect((await screen.findByTestId('api-access-token')).textContent.startsWith('fw1.')).toBe(true)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('revoking a key', () => {
  beforeEach(() => {
    recordApiKey(
      wallet.address,
      buildGrant({
        account: wallet.address,
        scopes: ['read:profile'],
        ttlDays: 30,
        label: 'leaked agent',
        nowSeconds: Math.floor(Date.now() / 1000),
      })
    )
  })

  it('posts the signed revocation and reports the honest, non-durable result', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ revoked: true, durable: false, reason: 'in-process only' }),
    })

    renderPanel()
    openCard()
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))

    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    const [url, options] = global.fetch.mock.calls[0]
    expect(url).toBe('https://relay.example/v1/member/keys/revoke')
    const body = JSON.parse(options.body)
    expect(body.revocation.account.toLowerCase()).toBe(wallet.address.toLowerCase())
    expect(body.signature).toMatch(/^0x[0-9a-f]+$/i)

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(/does NOT survive a gateway restart/i)
    // The part that DOES survive is always stated beside it.
    expect(notice).toHaveTextContent(/also expires on its own/i)

    expect(listKeyRecords(wallet.address)[0].revokedAt).toBeTruthy()
  })

  it('is honest when the gateway could not be reached: signed and noted, but NOT registered', async () => {
    global.fetch.mockRejectedValue(new Error('connection refused'))

    renderPanel()
    openCard()
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/not registered/i)
    expect(alert).toHaveTextContent(/still works until it is registered or expires/i)
  })
})

/*
 * ── THE BRANCH NO E2E BUILD CAN REACH (issue #1285) ──────────────────────────────────────────────
 *
 * `gatewayConfigured` is `relayerBaseUrl() !== ''`, and every Cypress build resolves that one way:
 * the no-chain dev server points VITE_RELAYER_URL at a dead port (a CONFIGURED gateway that does not
 * answer — which is a different fact, and is what API-03 tests), and the on-chain build sets other
 * gateway variables entirely. Neither can produce the UNCONFIGURED build, so the branch is only
 * reachable where the module boundary is a stub: here.
 *
 * It is worth reaching, because "no gateway" and "gateway unreachable" produce DIFFERENT member
 * text, and the failure mode of getting it wrong is silent — the card would tell someone their
 * revocation failed for a transient reason that will never clear.
 *
 * Both directions are asserted throughout. A surface that renders one state correctly proves
 * nothing about whether it can tell the two apart.
 */
describe('a build with no gateway configured', () => {
  it('says so on the card, and says nothing of the sort when a gateway IS configured', () => {
    gatewayUrl = ''
    const { unmount } = renderPanel()
    openCard()

    const notice = screen.getByTestId('api-access-no-gateway')
    expect(notice).toHaveTextContent(/no fairwins api gateway configured/i)
    // What is still possible is stated beside what is not: signing is local, so a key can still be
    // created here — the notice must not read as "API access is unavailable".
    expect(notice).toHaveTextContent(/you can still create a key here/i)
    expect(notice).toHaveTextContent(/cannot check a key against a gateway/i)
    expect(screen.getByTestId('api-access-create')).toBeInTheDocument()
    unmount()

    gatewayUrl = 'https://relay.example'
    renderPanel()
    openCard()
    expect(screen.queryByTestId('api-access-no-gateway')).not.toBeInTheDocument()
    expect(screen.getByTestId('api-access-console')).toBeInTheDocument()
  })

  it('writes the documented example URL into the MCP snippet rather than an empty one', () => {
    gatewayUrl = ''
    renderPanel()
    openCard()
    fireEvent.click(screen.getByRole('button', { name: /show setup snippet/i }))

    // `FAIRWINS_API_URL: ""` is config a member would paste into a file and then debug — the
    // fallback keeps the snippet readable as INSTRUCTIONS, which is the only thing it can be on a
    // build that has no address to offer.
    const snippet = JSON.parse(screen.getByTestId('api-access-snippet').textContent)
    expect(snippet.mcpServers.fairwins.env.FAIRWINS_API_URL).toBe('https://relay.fairwins.app')
    expect(snippet.mcpServers.fairwins.env.FAIRWINS_API_TOKEN).toBe('PASTE_YOUR_FW1_TOKEN_HERE')
  })

  it('revokes locally without inventing a request, and names the build — not an outage — as the reason', async () => {
    gatewayUrl = ''
    recordApiKey(
      wallet.address,
      buildGrant({
        account: wallet.address,
        scopes: ['read:profile'],
        ttlDays: 30,
        label: 'leaked agent',
        nowSeconds: Math.floor(Date.now() / 1000),
      })
    )

    renderPanel()
    openCard()
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/not registered/i)
    // The distinguishing sentence. "could not be reached" would send the member off to retry
    // something that cannot succeed on this build.
    expect(alert).toHaveTextContent(/this build has no gateway configured/i)
    expect(alert).not.toHaveTextContent(/could not be reached/i)
    expect(alert).toHaveTextContent(/still works until it is registered or expires/i)

    // No request was posed to a gateway that does not exist.
    expect(global.fetch).not.toHaveBeenCalled()

    // And the chip stays honest: the member's decision is recorded, the gateway's agreement is not
    // claimed. A plain "revoked" here would say a leaked key was dead while it was live.
    expect(screen.getByTestId('api-access-key-state')).toHaveTextContent(
      /revocation signed — not delivered/i
    )
    expect(listKeyRecords(wallet.address)[0].revocationDelivered).toBe(false)
  })
})

describe('MCP setup', () => {
  it('generates a snippet with a token PLACEHOLDER, never a real token', async () => {
    renderPanel()
    openCard()
    fireEvent.click(screen.getByRole('button', { name: /show setup snippet/i }))

    const snippet = screen.getByTestId('api-access-snippet').textContent
    expect(snippet).toContain('PASTE_YOUR_FW1_TOKEN_HERE')
    expect(snippet).toContain('https://relay.example')
    expect(snippet).not.toContain('fw1.')
  })
})
