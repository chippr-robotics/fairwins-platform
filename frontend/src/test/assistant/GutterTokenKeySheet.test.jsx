/**
 * GutterTokenKeySheet (spec 104) — paste, test, save.
 *
 * The two failure modes are deliberately DIFFERENT, and that asymmetry is the whole test:
 *
 *   · GutterToken REFUSES the key (401) → the save is refused too. Saving a key the service has
 *     just said is invalid would leave the Assistant tab claiming a rail that cannot answer.
 *   · GutterToken cannot be REACHED → the key IS saved and the failure is shown (the spec-069 rule
 *     for saving an RPC endpoint). A timeout is a fact about the network, not about the key, and
 *     refusing would strand a member on a flaky connection with a perfectly good key.
 *
 * And one thing that must hold in both: after a save the component renders no more of the key than
 * `sk-…` plus four characters — never the value that was typed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({ walletState: null }))

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => m.walletState }))

import GutterTokenKeySheet from '../../components/assistant/GutterTokenKeySheet'
import {
  __resetGutterTokenKeyForTests,
  hasGutterTokenKey,
  describeGutterTokenKey,
} from '../../lib/assistant/guttertokenKeyStore'
import { response } from './helpers/http'

const ACCOUNT = '0x' + '6'.repeat(40)
const KEY = 'sk-live-paste-me-wxyz'

function renderSheet(props = {}) {
  return render(
    <GutterTokenKeySheet
      open
      onClose={props.onClose ?? vi.fn()}
      account={ACCOUNT}
      onSaved={props.onSaved ?? vi.fn()}
    />
  )
}

const paste = (value) =>
  fireEvent.change(screen.getByTestId('guttertoken-key-input'), { target: { value } })
const save = () => fireEvent.click(screen.getByTestId('guttertoken-key-save'))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetGutterTokenKeyForTests()
  m.walletState = { address: ACCOUNT, signer: null, loginMethod: 'injected', chainId: 137, isConnected: true }
  vi.restoreAllMocks()
})

describe('GutterTokenKeySheet — the lead branches on how the member signs in', () => {
  it('tells a PASSKEY member to sign up by e-mail, because GutterToken cannot see a passkey account', () => {
    m.walletState = { ...m.walletState, loginMethod: 'passkey' }
    renderSheet()
    const lead = screen.getByTestId('guttertoken-key-lead')
    expect(lead).toHaveTextContent(/cannot sign GutterToken's wallet sign-in/i)
    expect(lead).toHaveTextContent(/with an e-mail address/i)
    // It must never imply FairWins can connect or sign them in over there.
    expect(lead).not.toHaveTextContent(/connect|link your account/i)
  })

  it('tells a CLASSIC-wallet member they may use the same wallet, or an e-mail address', () => {
    renderSheet()
    expect(screen.getByTestId('guttertoken-key-lead')).toHaveTextContent(
      /Sign up at GutterToken with the same wallet you use here, or with an e-mail address/i
    )
  })

  it('discloses the referral beside its own Get-a-key link', () => {
    renderSheet()
    const link = screen.getByTestId('guttertoken-key-sheet-signup')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link.getAttribute('href')).toContain('app.guttertokens.com/signup')
    expect(screen.getByTestId('guttertoken-key-sheet')).toHaveTextContent(
      /FairWins may receive referral credit/i
    )
  })
})

describe('GutterTokenKeySheet — the paste field', () => {
  it('hides the key by default and reveals it only on request', () => {
    renderSheet()
    const input = screen.getByTestId('guttertoken-key-input')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')

    fireEvent.click(screen.getByTestId('guttertoken-key-show'))
    expect(screen.getByTestId('guttertoken-key-input')).toHaveAttribute('type', 'text')
  })

  it('names the format problem inline and refuses to submit', () => {
    renderSheet()
    paste('not-a-key')
    expect(screen.getByTestId('guttertoken-key-format-error')).toHaveTextContent(/starts with "sk-"/i)
    expect(screen.getByTestId('guttertoken-key-save')).toBeDisabled()
  })
})

describe('GutterTokenKeySheet — test and save', () => {
  it('REFUSES the save when GutterToken answers 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401)))
    const onClose = vi.fn()
    const onSaved = vi.fn()
    renderSheet({ onClose, onSaved })

    paste(KEY)
    save()

    await waitFor(() =>
      expect(screen.getByTestId('guttertoken-key-status')).toHaveTextContent(
        /GutterToken did not accept this key/i
      )
    )
    expect(screen.getByTestId('guttertoken-key-status')).toHaveTextContent(/Nothing was saved/i)
    // Nothing stored, nothing announced to the card, and the sheet stays open to be fixed.
    expect(hasGutterTokenKey(ACCOUNT)).toBe(false)
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('SAVES with the failure shown when GutterToken cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const onClose = vi.fn()
    const onSaved = vi.fn()
    renderSheet({ onClose, onSaved })

    paste(KEY)
    save()

    await waitFor(() => expect(hasGutterTokenKey(ACCOUNT)).toBe(true))
    const status = screen.getByTestId('guttertoken-key-status')
    expect(status).toHaveTextContent(/could not be reached to check it/i)
    // The sheet stays open so the failure is READ rather than hidden behind a close.
    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalled()
  })

  it('saves and closes when GutterToken accepts the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { data: [{ id: 'claude-opus-5' }] })))
    const onClose = vi.fn()
    const onSaved = vi.fn()
    renderSheet({ onClose, onSaved })

    paste(KEY)
    save()

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(hasGutterTokenKey(ACCOUNT)).toBe(true)
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'ok', hint: 'sk-…wxyz' })
    )
  })
})

describe('GutterTokenKeySheet — the key never survives on screen', () => {
  it('renders no more than the redacted form after a save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    renderSheet()

    paste(KEY)
    save()

    await waitFor(() => expect(hasGutterTokenKey(ACCOUNT)).toBe(true))
    // The paste field is gone, the confirmation names the key by its last four characters only,
    // and the value that was typed appears nowhere in the DOM.
    expect(screen.queryByTestId('guttertoken-key-input')).not.toBeInTheDocument()
    expect(document.body.textContent).toContain('sk-…wxyz')
    expect(document.body.textContent).not.toContain(KEY)
    expect(describeGutterTokenKey(ACCOUNT).redacted).toBe('sk-…wxyz')
  })

  it('never puts the key in the request URL — it rides an Authorization header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { data: [] }))
    vi.stubGlobal('fetch', fetchImpl)
    renderSheet()

    paste(KEY)
    save()

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).not.toContain(KEY)
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
  })
})
