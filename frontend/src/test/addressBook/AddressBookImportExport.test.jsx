/**
 * AddressBookImportExport — the component that shipped issue #1550 with zero
 * direct test coverage. Every case below is written as a PASSKEY session
 * (`signer: null`), because that is the session the old code refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// A passkey session: an address is present, an ethers signer is NOT.
// WalletContext nulls the signer for that login, and no feature may branch on
// `loginMethod` — so the fixture deliberately does not carry one.
let walletState = {
  address: '0x1111111111111111111111111111111111111111',
  chainId: 137,
  provider: {},
  signer: null,
}
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => walletState,
}))

import AddressBookImportExport from '../../components/account/AddressBookImportExport'
import { useAddressBook } from '../../hooks/useAddressBook'
import { exportAddressBook } from '../../lib/addressBook/addressBookFile'
import {
  addContact,
  createEmptyBook,
  saveAddressBook,
  loadAddressBook,
} from '../../lib/addressBook/addressBookStore'

/**
 * The component takes the book as PROPS. This host mirrors how AddressBookPanel
 * supplies them — one useAddressBook() for the subtree — so the test exercises
 * the same wiring the app does. Rendering the component with its own hook call
 * is what produced the stale second copy the e2e run caught.
 */
function Host() {
  const { book, importBook, resolveConflicts } = useAddressBook()
  return (
    <AddressBookImportExport
      book={book}
      importBook={importBook}
      resolveConflicts={resolveConflicts}
    />
  )
}

const OWNER = '0x1111111111111111111111111111111111111111'
const FRIEND = '0x2222222222222222222222222222222222222222'

/** Capture what the component hands to the browser as a download. */
let downloaded
function captureDownloads() {
  downloaded = []
  const realCreate = URL.createObjectURL
  const realRevoke = URL.revokeObjectURL
  URL.createObjectURL = (blob) => {
    downloaded.push(blob)
    return 'blob:mock'
  }
  URL.revokeObjectURL = () => {}
  return () => {
    URL.createObjectURL = realCreate
    URL.revokeObjectURL = realRevoke
  }
}

function seedBook() {
  const { book } = addContact(createEmptyBook(), {
    nickname: 'Alex',
    addresses: [{ address: FRIEND, chainId: 137, notes: 'dinner bet' }],
  })
  saveAddressBook(OWNER, book)
  return book
}

let restoreDownloads

describe('AddressBookImportExport (issue #1550)', () => {
  beforeEach(() => {
    localStorage.clear()
    walletState = { address: OWNER, chainId: 137, provider: {}, signer: null }
    restoreDownloads = captureDownloads()
  })

  afterEach(() => {
    restoreDownloads()
  })

  it('never tells a signed-in member their wallet is not connected', async () => {
    const user = userEvent.setup()
    seedBook()
    render(<Host />)

    await user.click(screen.getByRole('button', { name: 'Export address book' }))

    // The whole bug, in one assertion.
    expect(screen.queryByText(/wallet not connected/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('exports a readable file on a session with no signer', async () => {
    const user = userEvent.setup()
    seedBook()
    render(<Host />)

    await user.click(screen.getByRole('button', { name: 'Export address book' }))

    expect(downloaded).toHaveLength(1)
    const text = await downloaded[0].text()
    expect(text).toContain('Alex')
    expect(text).toContain('dinner bet')
    expect(JSON.parse(text).contacts).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(/plain text/i)
  })

  it('says so when there is nothing to export, instead of writing an empty file', async () => {
    const user = userEvent.setup()
    render(<Host />)

    await user.click(screen.getByRole('button', { name: 'Export address book' }))

    expect(downloaded).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent(/no contacts to export/i)
  })

  it('imports a plain-text file on a session with no signer, and persists it', async () => {
    const user = userEvent.setup()
    const file = new File(
      [
        exportAddressBook({
          schemaVersion: 1,
          contacts: [
            { nickname: 'Sam', addresses: [{ address: FRIEND, chainId: 137, notes: 'poker' }] },
          ],
        }),
      ],
      'book.json',
      { type: 'application/json' },
    )
    render(<Host />)

    await user.upload(screen.getByTestId('ab-import-input'), file)

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Address book imported/i),
    )
    const stored = loadAddressBook(OWNER)
    expect(stored.contacts.map((c) => c.nickname)).toEqual(['Sam'])
    expect(stored.contacts[0].addresses[0].notes).toBe('poker')
  })

  it('names encryption — not the wallet — when handed a pre-#1550 backup with no signer', async () => {
    const user = userEvent.setup()
    const legacy = new File(
      [
        JSON.stringify({
          format: 'fairwins-address-book-backup',
          version: 1,
          alg: 'chacha20poly1305',
          nonce: '00'.repeat(12),
          ciphertext: 'deadbeef',
        }),
      ],
      'old-backup.json',
      { type: 'application/json' },
    )
    render(<Host />)

    await user.upload(screen.getByTestId('ab-import-input'), legacy)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/older encrypted backup/i)
    expect(alert.textContent).not.toMatch(/wallet not connected/i)
    expect(alert.textContent).not.toMatch(/different wallet/i)
  })

  it('leaves the existing book untouched when an import fails (FR-021)', async () => {
    const user = userEvent.setup()
    seedBook()
    const junk = new File(['{ not json'], 'junk.json', { type: 'application/json' })
    render(<Host />)

    await user.upload(screen.getByTestId('ab-import-input'), junk)

    await screen.findByRole('alert')
    expect(loadAddressBook(OWNER).contacts.map((c) => c.nickname)).toEqual(['Alex'])
  })

  it('discloses that the export is readable before anyone taps Export', () => {
    render(<Host />)
    expect(
      screen.getByText(/anyone who opens the file can see these names, addresses and notes/i),
    ).toBeInTheDocument()
  })

  it('names both controls even where the labels are hidden at phone width', () => {
    // `.ab-btn-label` is display:none below 640px and the icons are aria-hidden,
    // so without these names the buttons are unnamed on a phone (axe: critical).
    render(<Host />)
    expect(screen.getByRole('button', { name: 'Export address book' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import address book' })).toBeInTheDocument()
    // The icons themselves stay out of the accessibility tree.
    document.querySelectorAll('.ab-icon').forEach((svg) => {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
    })
  })
})
