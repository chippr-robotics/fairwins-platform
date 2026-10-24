import { describe, it, expect } from 'vitest'
import { keccak256, toUtf8Bytes, getBytes } from 'ethers'
import {
  exportAddressBook,
  importAddressBook,
  PLAINTEXT_FILE_NOTE,
} from '../../lib/addressBook/addressBookFile'
import { addContact, createEmptyBook } from '../../lib/addressBook/addressBookStore'
import { encryptJson, utf8ToBytes } from '../../utils/crypto/primitives'
import {
  ADDRESS_BOOK_BACKUP_MESSAGE_V1,
  LEGACY_ENCRYPTED_FORMAT,
  LEGACY_ENCRYPTED_VERSION,
} from '../../lib/addressBook/constants'

const ADDR = '0x1111111111111111111111111111111111111111'
const signerA = { signMessage: async () => '0xsignature-from-wallet-A' }
const signerB = { signMessage: async () => '0xsignature-from-wallet-B' }

function sampleBook() {
  return addContact(createEmptyBook(), {
    nickname: 'Alex',
    addresses: [{ address: ADDR, chainId: 137, notes: 'dinner bet' }],
  }).book
}

/** Build a pre-#1550 encrypted envelope the way the old exporter did. */
function legacyEnvelope(signature, payloadOverride) {
  const key = getBytes(keccak256(toUtf8Bytes(signature)))
  const payload = payloadOverride ?? {
    type: 'fairwins-address-book',
    schemaVersion: 1,
    exportedAt: 1750000000000,
    contacts: [{ nickname: 'Alex', addresses: [{ address: ADDR, chainId: 137, notes: 'dinner bet' }] }],
  }
  const aad = utf8ToBytes(`${LEGACY_ENCRYPTED_FORMAT}:${LEGACY_ENCRYPTED_VERSION}`)
  const { nonce, ciphertext } = encryptJson(key, payload, aad)
  return {
    format: LEGACY_ENCRYPTED_FORMAT,
    version: LEGACY_ENCRYPTED_VERSION,
    alg: 'chacha20poly1305',
    nonce,
    ciphertext,
  }
}

describe('addressBookFile — plain-text export (issue #1550)', () => {
  it('round-trips with no wallet, no signer, no signature (FR-019, FR-020)', async () => {
    // Note the shape of this call: ONE argument out, ONE argument in. A passkey
    // session has no ethers signer, and neither direction may ask for one.
    const file = exportAddressBook(sampleBook())
    const restored = await importAddressBook(file)
    expect(restored.contacts).toHaveLength(1)
    expect(restored.contacts[0].nickname).toBe('Alex')
    expect(restored.contacts[0].addresses[0].address).toBe(ADDR)
    expect(restored.contacts[0].addresses[0].chainId).toBe(137)
    expect(restored.contacts[0].addresses[0].notes).toBe('dinner bet')
  })

  it('exports the contacts in READABLE form — that is the change', () => {
    // The inverse of the pre-#1550 assertion. The file is meant to be opened,
    // read and shared; if this ever passes with the data hidden again, the
    // feature has silently reverted.
    const file = exportAddressBook(sampleBook())
    expect(file).toContain('Alex')
    expect(file).toContain('dinner bet')
    expect(file).toContain(ADDR)
    expect(JSON.parse(file).note).toBe(PLAINTEXT_FILE_NOTE)
  })

  it('is synchronous — the export path can never prompt for a signature', () => {
    // Enforced by type, not by convention (the spec-084 verifyMessage device).
    const file = exportAddressBook(sampleBook())
    expect(typeof file).toBe('string')
    expect(file).not.toBeInstanceOf(Promise)
  })

  it('labels a known network for whoever opens the file, and never guesses one', () => {
    const known = JSON.parse(exportAddressBook(sampleBook()))
    expect(known.contacts[0].addresses[0].network).toBe('Polygon')

    // getNetwork() would answer the primary network for an unknown chain. A
    // shared file must not carry a confident, wrong network name.
    const unknown = JSON.parse(
      exportAddressBook({
        schemaVersion: 1,
        contacts: [{ nickname: 'Sam', addresses: [{ address: ADDR, chainId: 99999, notes: '' }] }],
      }),
    )
    expect(unknown.contacts[0].addresses[0]).not.toHaveProperty('network')
    expect(unknown.contacts[0].addresses[0].chainId).toBe(99999)
  })

  it('ignores the informational network label on the way back in', async () => {
    const restored = await importAddressBook(
      JSON.stringify({
        format: 'fairwins-address-book',
        version: 2,
        schemaVersion: 1,
        contacts: [
          {
            nickname: 'Sam',
            // A hand-edited file may carry a stale or wrong label. chainId governs.
            addresses: [{ address: ADDR, chainId: 137, network: 'Ethereum', notes: '' }],
          },
        ],
      }),
    )
    expect(restored.contacts[0].addresses[0].chainId).toBe(137)
    expect(restored.contacts[0].addresses[0]).not.toHaveProperty('network')
  })

  it('accepts a hand-edited file (the point of plain text)', async () => {
    const edited = JSON.parse(exportAddressBook(sampleBook()))
    edited.contacts[0].nickname = 'Alexandra'
    edited.contacts.push({
      nickname: 'Sam',
      addresses: [{ address: '0x2222222222222222222222222222222222222222', chainId: 137, notes: '' }],
    })
    const restored = await importAddressBook(JSON.stringify(edited))
    expect(restored.contacts.map((c) => c.nickname)).toEqual(['Alexandra', 'Sam'])
  })

  it('fails on a corrupt or unrecognised file, without touching the caller (FR-021)', async () => {
    await expect(importAddressBook('{not valid')).rejects.toThrow(/not a valid address book/i)
    await expect(importAddressBook(JSON.stringify({ format: 'nope' }))).rejects.toThrow(
      /Unrecognised/i,
    )
    await expect(
      importAddressBook(JSON.stringify({ format: 'fairwins-address-book', version: 2 })),
    ).rejects.toThrow(/not a valid address book/i)
  })

  it('refuses a file from a newer app rather than guessing at its shape', async () => {
    await expect(
      importAddressBook(
        JSON.stringify({ format: 'fairwins-address-book', version: 99, contacts: [] }),
      ),
    ).rejects.toThrow(/newer version of FairWins/i)
  })
})

describe('addressBookFile — pre-#1550 encrypted backups', () => {
  it('still opens with the wallet that wrote it', async () => {
    const envelope = legacyEnvelope('0xsignature-from-wallet-A')
    const restored = await importAddressBook(JSON.stringify(envelope), { signer: signerA })
    expect(restored.contacts[0].nickname).toBe('Alex')
    expect(restored.contacts[0].addresses[0].notes).toBe('dinner bet')
  })

  it('names ENCRYPTION as the reason when this session has no wallet key — never "wallet not connected"', async () => {
    // The #1550 bug in one assertion: a passkey member gets a sentence about the
    // FILE, naming the two ways out, not a false claim about their session.
    const envelope = legacyEnvelope('0xsignature-from-wallet-A')
    let caught
    try {
      await importAddressBook(JSON.stringify(envelope))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(caught.message).toMatch(/older encrypted backup/i)
    expect(caught.message).toMatch(/export a fresh plain-text file/i)
    expect(caught.message).not.toMatch(/wallet not connected/i)
    // "Wrong wallet" is a different fact and nothing has been tried yet.
    expect(caught.message).not.toMatch(/different wallet/i)
  })

  it('says "different wallet or corrupted" only after a signature was actually tried', async () => {
    const envelope = legacyEnvelope('0xsignature-from-wallet-A')
    await expect(
      importAddressBook(JSON.stringify(envelope), { signer: signerB }),
    ).rejects.toThrow(/different wallet|corrupted/i)
  })

  it('rejects a tampered envelope (AEAD)', async () => {
    const envelope = legacyEnvelope('0xsignature-from-wallet-A')
    /*
     * The replacement is CONDITIONAL, matching backupCrypto.test.js:34 and claimCode.test.js:126.
     * It used to append a constant '00', which is a no-op whenever the ciphertext already ends in
     * '00' — nothing was tampered, the import legitimately succeeded, and the test failed with
     * "promise resolved instead of rejecting". Measured rate over 200k random ciphertexts: 0.022%,
     * about 1 run in 4,500 — rare enough to look like a mystery flake in a crypto test and read as
     * "AEAD did not detect tampering", which is alarming and was never true.
     */
    const tail = envelope.ciphertext.slice(-2)
    envelope.ciphertext = envelope.ciphertext.slice(0, -2) + (tail === '00' ? 'ff' : '00')
    await expect(
      importAddressBook(JSON.stringify(envelope), { signer: signerA }),
    ).rejects.toThrow()
  })

  it('reports an incomplete envelope rather than asking for a signature', async () => {
    await expect(
      importAddressBook(
        JSON.stringify({ format: LEGACY_ENCRYPTED_FORMAT, version: 1 }),
        { signer: signerA },
      ),
    ).rejects.toThrow(/incomplete or corrupted/i)
  })

  it('keeps the legacy signing message domain-separated and unchanged', () => {
    // Wallet-breaking if edited: an existing backup is only openable under this
    // exact string. It is read-only from here on.
    expect(ADDRESS_BOOK_BACKUP_MESSAGE_V1).toBe('FairWins Address Book Backup v1')
  })
})
