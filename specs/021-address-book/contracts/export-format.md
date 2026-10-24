# Contract: plain-text export/import (`addressBookFile`)

`frontend/src/lib/addressBook/addressBookFile.js` — serializes the address book to a
plain JSON file and reads one back.

> **Amended 2026-09-10 (issue #1550).** This file previously specified an encrypted
> envelope keyed on a wallet signature. A passkey session has no ethers signer, so that
> design refused export AND import to every passkey member with `Wallet not connected`,
> and the file it produced could only ever be opened by one key. The export is now plain
> text: readable, shareable, and available on every account type. The module was renamed
> from `addressBookCrypto.js` to match what it does. Pre-amendment envelopes are still
> readable — see "Legacy" below.

## No key derivation

There is none. Export takes a book and returns a string; nothing signs, and nothing
prompts. `exportAddressBook` is **synchronous**, which is what makes "this path can never
ask for a signature" true by type rather than by convention.

## File (what the member downloads)

```json
{
  "format": "fairwins-address-book",
  "version": 2,
  "schemaVersion": 1,
  "exportedAt": 1750000000000,
  "note": "Plain text: anyone who opens this file can read these names, addresses and notes.",
  "contacts": [
    {
      "nickname": "Alex",
      "addresses": [
        { "address": "0xAbc…", "chainId": 137, "network": "Polygon", "notes": "main" },
        { "address": "0xDef…", "chainId": 63, "network": "Mordor", "notes": "" }
      ]
    }
  ]
}
```

- The file **is** the payload. What used to be the ciphertext's inner `type` is now the
  file's own `format`, which is why one validator accepts a new file and a decrypted
  legacy payload alike.
- `note` states the privacy fact inside the file, so it survives the file leaving the app
  (FR-031).
- `network` is **informational only** — it is written for whoever opens the file and is
  ignored on import, where `chainId` governs. It is omitted entirely when the build does
  not know the chain: the lookup is a strict `NETWORKS[chainId]`, never `getNetwork()`,
  which falls back to the primary network and would stamp a shared file with a confident,
  wrong network name.
- Local-only fields (`id`, `addedAt`, `updatedAt`) are stripped on export and regenerated
  on import.
- The file contains nicknames, addresses and notes **in the clear**, by design (FR-019).

## API

```js
// Pure string formatting. No wallet, no network, no ceremony — and SYNCHRONOUS so it
// cannot acquire one later without changing its type.
exportAddressBook(book: AddressBook): string /* JSON */

// Async only because the legacy branch may still sign. `signer` is used for NOTHING else;
// a plain-text file never touches it.
importAddressBook(fileJson: string | object, opts?: { signer?: Signer })
  : Promise<{ schemaVersion: number, contacts: Array }>
```

## Behavioural contract

| Scenario | Result |
|----------|--------|
| Export on any account type, passkey included | A readable JSON file. No signature prompt, no wallet check (FR-019, SC-012). |
| Export with an empty book | The surface says there is nothing to export; no file is written. |
| Import a plain file, any session | Full round-trip: contacts, addresses, networks, notes (FR-020). |
| Import a file another member exported | Works. A file no longer belongs to a wallet (FR-020). |
| Import a hand-edited file | Works, as long as the shape holds. Editing it is a supported use. |
| Corrupt / not-an-address-book / unknown `format` | Named error; existing book unchanged (FR-021). |
| `version` newer than this build | "Written by a newer version of FairWins" — never a silent partial read. |
| Overlap with existing contacts | Hand off to `mergeBook` (additive, keyed on address; conflicts surfaced) (FR-022). |

## Legacy: pre-#1550 encrypted envelopes

Nothing writes this format any more; it is read-only, so members who already have a file
on disk can still open it.

```json
{ "format": "fairwins-address-book-backup", "version": 1,
  "alg": "chacha20poly1305", "nonce": "<hex>", "ciphertext": "<hex>" }
```

Key = `keccak256(signer.signMessage(ADDRESS_BOOK_BACKUP_MESSAGE_V1))`, AAD =
`"fairwins-address-book-backup:1"`. That signing message is **wallet-breaking if changed**
and must not be reused for anything.

| Scenario | Result |
|----------|--------|
| Signer present, correct wallet | Decrypts and imports as it always did (FR-021). |
| **No signer** (passkey session, or no wallet) | Refused with a message naming the FILE as the cause — an older encrypted export, openable only by the wallet that made it — plus the two ways out. It MUST NOT say the wallet is wrong, different, or not connected: nothing has been tried, and on a passkey session none of that was ever true (SC-014). |
| Signer present, different wallet | AEAD authentication fails → "may belong to a different wallet or be corrupted". This is the ONE place that sentence is legitimate, because a signature was actually attempted. |
| Tampered ciphertext | AEAD authentication fails; existing book unchanged. |
