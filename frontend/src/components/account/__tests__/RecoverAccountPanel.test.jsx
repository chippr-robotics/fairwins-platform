/**
 * Spec 045 US6 — wallet-only recovery, now a guided bottom-sheet wizard.
 * Covers: session gating (wallet sessions only), the step flow (intro →
 * account → confirm → done), the isOwnerAddress controller gate, the happy
 * path (create passkey → addOwnerPublicKey → receipt → book record), honest
 * failure reporting, the plain-language BAD_DATA message that replaced the raw
 * ethers error testers hit, the up-front passkey-unavailable warning, and
 * standard address entry (browser-known hint chips).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockWallet = {
  address: '0x' + 'e'.repeat(40),
  // The write rail: `signer.sendTransaction` with real calldata, decoded in the assertions.
  signer: { sendTransaction: (...a) => addOwnerPublicKey(...a) },
  provider: {},
  loginMethod: 'injected',
  isConnected: true,
  chainId: 137,
}
vi.mock('../../../hooks/useWalletManagement', () => ({
  useWallet: () => mockWallet,
}))

vi.mock('../../../config/networks', () => ({
  getNetwork: vi.fn(() => ({ name: 'Polygon' })),
}))

// Per-test behaviour for the one read and the one write the panel makes.
const { isOwnerAddress, addOwnerPublicKey, txWait, reads } = vi.hoisted(() => ({
  isOwnerAddress: vi.fn(),
  addOwnerPublicKey: vi.fn(),
  txWait: vi.fn(),
  reads: [],
}))

/**
 * Spec 110 — the panel reads through the chain seam and writes through `signer.sendTransaction`,
 * so those are what is faked. The `vi.mock('ethers')` that stood here replaced `Contract` with a
 * class whose constructor took `target` and stored it on `this` — and nothing ever read it back,
 * so a controller check aimed at the WRONG ACCOUNT satisfied every assertion in the file. The
 * read's chain, address and argument are recorded and asserted now.
 */
vi.mock('../../../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      reads.push({ chainId, address, functionName, args })
      if (functionName === 'isOwnerAddress') return isOwnerAddress(args[0])
      throw new Error(`unexpected read: ${functionName}`)
    },
  }
})

import { Interface, getAddress } from 'ethers'
import RecoverAccountPanel from '../RecoverAccountPanel'

// The panel's own two-entry ABI, restated here so the assertions decode with the REAL ethers
// Interface rather than with the encoder under test (divergence 17).
const RECOVERY_ABI = [
  'function isOwnerAddress(address owner) view returns (bool)',
  'function addOwnerPublicKey(bytes32 x, bytes32 y)',
]
import { knownCredentials } from '../../../lib/passkey/credentials'

const ACCOUNT = '0x' + 'a'.repeat(40)
const PUBLIC_KEY = { x: `0x${'1'.repeat(64)}`, y: `0x${'2'.repeat(64)}` }

const createCredential = vi.fn().mockResolvedValue({
  credentialId: 'cred-new',
  publicKey: PUBLIC_KEY,
  prfCapable: true,
  label: 'Recovered device',
})

// Passkeys available by default so the confirm step never blocks the happy path
// (jsdom has no WebAuthn, so the real detector would report unavailable).
const available = () => Promise.resolve({ available: true, platformAuthenticator: true })

function baseDeps(extra = {}) {
  return { createCredential, detectCapability: available, ...extra }
}

async function openToAccountStep(user) {
  await user.click(screen.getByRole('button', { name: 'Recover an account' }))
  await user.click(screen.getByRole('button', { name: 'Get started' }))
}

async function enterAndVerify(user, address = ACCOUNT) {
  await openToAccountStep(user)
  await user.type(screen.getByLabelText('Passkey account address'), address)
  await user.click(screen.getByRole('button', { name: 'Verify ownership' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockWallet.loginMethod = 'injected'
  mockWallet.isConnected = true
  reads.length = 0
  isOwnerAddress.mockResolvedValue(true)
  txWait.mockResolvedValue({ status: 1 })
  addOwnerPublicKey.mockResolvedValue({ wait: txWait })
})

// The panel is a COLLAPSED accordion section on the Recovery tab, so tests open
// the section first — the same order a member does it in. (jsdom does not
// enforce `inert`, so skipping the expand would pass here and fail in a browser.)
function renderPanel(props) {
  const utils = render(<RecoverAccountPanel {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /recover a passkey account/i }))
  return utils
}

describe('RecoverAccountPanel', () => {
  it('renders nothing for passkey sessions (they use the Controllers panel)', () => {
    mockWallet.loginMethod = 'passkey'
    const { container } = render(<RecoverAccountPanel deps={baseDeps()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when no wallet is connected', () => {
    mockWallet.isConnected = false
    const { container } = render(<RecoverAccountPanel deps={baseDeps()} />)
    expect(container.firstChild).toBeNull()
  })

  it('walks the wizard: intro → account entry → verified confirm step', async () => {
    const user = userEvent.setup()
    renderPanel({ deps: baseDeps() })
    // Sheet is closed until the member starts recovery.
    expect(screen.queryByLabelText('Passkey account address')).not.toBeInTheDocument()
    await enterAndVerify(user)
    await waitFor(() => expect(screen.getByTestId('recover-verified')).toBeInTheDocument())
    // The controller gate asked THAT account, on THAT chain, about THIS wallet. The fake
    // `Contract` this replaced took the address in its constructor and never gave it back, so a
    // check aimed at the wrong account would have looked identical.
    expect(reads).toEqual([
      {
        chainId: 137,
        address: ACCOUNT,
        functionName: 'isOwnerAddress',
        args: [getAddress(mockWallet.address)],
      },
    ])
  })

  it('refuses recovery when the wallet is not a controller and never reaches the ceremony', async () => {
    isOwnerAddress.mockResolvedValue(false)
    const user = userEvent.setup()
    renderPanel({ deps: baseDeps() })
    await enterAndVerify(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not a controller/i))
    // Stays on the account step — the confirm/ceremony button is not rendered.
    expect(screen.queryByText('Create & authorize new passkey')).not.toBeInTheDocument()
    expect(createCredential).not.toHaveBeenCalled()
  })

  it('turns the BAD_DATA decode failure into a plain-language, actionable message', async () => {
    isOwnerAddress.mockRejectedValue(
      Object.assign(new Error('could not decode result data (value="0x")'), { code: 'BAD_DATA' })
    )
    const user = userEvent.setup()
    renderPanel({ deps: baseDeps() })
    await enterAndVerify(user)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/doesn't respond like a FairWins passkey account/i)
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/Polygon/)
    // Raw ethers noise must not leak to the member.
    expect(screen.getByRole('alert')).not.toHaveTextContent(/BAD_DATA/)
  })

  it('flags an undeployed / wrong-network account before hitting the contract', async () => {
    mockWallet.provider = { getCode: vi.fn().mockResolvedValue('0x') }
    const user = userEvent.setup()
    renderPanel({ deps: baseDeps() })
    await enterAndVerify(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/No passkey account is deployed/i))
    expect(isOwnerAddress).not.toHaveBeenCalled()
    expect(reads).toEqual([]) // …and nothing was read at all
    mockWallet.provider = {}
  })

  it('recovers end-to-end: verify → new passkey → wallet tx → receipt → book record → done', async () => {
    const user = userEvent.setup()
    renderPanel({ deps: baseDeps() })
    await enterAndVerify(user)
    await waitFor(() => expect(screen.getByTestId('recover-verified')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Create & authorize new passkey' }))
    await waitFor(() => expect(screen.getByText(/New passkey authorized/i)).toBeInTheDocument())

    expect(createCredential).toHaveBeenCalled()
    // DECODED from real calldata, aimed at the account being recovered — the old assertion read
    // two arguments off a fake whose constructor discarded the address it was given.
    const tx = addOwnerPublicKey.mock.calls[0][0]
    expect(tx.to).toBe(ACCOUNT)
    const [x, y] = new Interface(RECOVERY_ABI).decodeFunctionData('addOwnerPublicKey', tx.data)
    expect(x).toBe(PUBLIC_KEY.x)
    expect(y).toBe(PUBLIC_KEY.y)
    // Recorded only AFTER the receipt — the credential is now a controller.
    const [rec] = knownCredentials()
    expect(rec.credentialId).toBe('cred-new')
    expect(rec.address.toLowerCase()).toBe(ACCOUNT.toLowerCase())
  })

  it('reports a reverted authorization honestly and does NOT record the credential', async () => {
    txWait.mockResolvedValue({ status: 0 })
    const user = userEvent.setup()
    renderPanel({ deps: baseDeps() })
    await enterAndVerify(user)
    await waitFor(() => expect(screen.getByTestId('recover-verified')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Create & authorize new passkey' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed/i))
    expect(knownCredentials()).toHaveLength(0)
    // Still on the confirm step so the member can retry.
    expect(screen.getByRole('button', { name: 'Create & authorize new passkey' })).toBeEnabled()
  })

  it('warns up front when this browser cannot create passkeys (in-app browser)', async () => {
    const user = userEvent.setup()
    render(
      <RecoverAccountPanel
        deps={baseDeps({
          detectCapability: () =>
            Promise.resolve({ available: false, reason: 'This browser does not support passkeys.' }),
        })}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Recover an account' }))
    await waitFor(() =>
      expect(screen.getByText(/can't create passkeys/i)).toBeInTheDocument()
    )
    expect(screen.getByText(/default browser/i)).toBeInTheDocument()
  })

  it('offers known local addresses as one-tap chips in the address step', async () => {
    const hinted = '0x' + 'b'.repeat(40)
    const user = userEvent.setup()
    render(
      <RecoverAccountPanel
        deps={baseDeps({ knownCredentials: () => [{ credentialId: 'c1', address: hinted }] })}
      />
    )
    await openToAccountStep(user)
    const chip = screen.getByRole('button', { name: `${hinted.substring(0, 6)}…${hinted.substring(hinted.length - 4)}` })
    expect(chip).toBeInTheDocument()
    await user.click(chip)
    expect(screen.getByLabelText('Passkey account address')).toHaveValue(hinted)
  })
})
