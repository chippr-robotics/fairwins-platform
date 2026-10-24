# Address Book & Screening

The **Address Book** lets you save the people you wager with under friendly
names so you never have to paste a long `0x…` address again. It also screens
saved and entered addresses against sanctions/compliance lists and warns you
before you transact.

Your address book is stored **only on your device** (in your browser), scoped to
the connected wallet. FairWins never uploads your contacts to a server.

## Where to find it

- **My Account → Address Book** — the full manager, where you add, edit, delete,
  search, import, and export contacts.
- **Anywhere you enter an address** (for example, the opponent or arbitrator field
  when creating a wager) — an **address-book icon button** sits next to the QR
  scan button. Tap it to search and pick a saved contact.

## Managing contacts

Each contact has:

- a **nickname** (e.g. "Alex");
- one or more **addresses** — a friend may use several wallets, so you can group
  them all under one name;
- a **network** for each address (defaults to the network you are on); and
- optional **notes**.

A single address is identified by the pair *(address, network)*, so the same
address can be saved for more than one network, and the book warns you if you try
to save a duplicate.

### Adding an address by QR code

When adding or editing a contact, each address row has a **QR scan button**.
Tap it to open your camera and scan a wallet QR code (a raw address, an
`ethereum:` URI, or a FairWins share link). The scanned address fills that row
automatically.

## How screening works

Every address you enter or save is checked against **every screening list FairWins knows
about, on every network this app can read** — not just the network your wallet is on. The
result is a small pill under the address:

| Pill | Meaning |
|-----|---------|
| **Screened clear** (green) | Every list on every network answered, and none of them flag this address. |
| **Flagged** (red) | At least one list says the address is listed. The sentence names the list and the network. |
| **Partly screened** (amber) | No list flagged it, but at least one list could not be read. This is **not** a clean bill. |
| **Unscreened** (amber) | No list could be read, or no list exists for this network. |
| **Screening…** | The check is still running. |

Beside the pill, a small **segmented bar** shows the scan itself: one segment per list that was
asked — green for clear, red for a flag, amber for one that could not be read.

**Tap the pill** to see exactly which lists were asked, on which networks, and what each one
said — including the ones that could not be reached and the networks that have no list at all.

Your saved contacts carry the same pill, checked the same way. It does not depend on which network
your wallet is on, or on having a wallet connected at all.

The lists are:

- **FairWins sanctions guard** — FairWins' own on-chain guard (the OFAC list plus FairWins'
  deny list). Where it says no, a wager, membership or pool action with that address is refused
  on-chain.
- **Chainalysis sanctions oracle** — the OFAC sanctions list, published on-chain by Chainalysis.
- **Issuer freeze lists** — Circle's USDC and Tether's USDT freeze lists. An address on one of
  these cannot receive or move that token: the transfer fails and the funds stay put.

Four principles govern screening:

1. **Green means all of them said yes.** One flag from any list is **Flagged**. One list that
   could not be reached is **Partly screened** — never green, because a missing answer is not a
   clear one.
2. **Advisory only.** The pill is a convenience pre-check. It does **not** block anything by
   itself.
3. **The chain enforces.** FairWins' smart contracts independently screen every participant, and
   an issuer freeze is enforced by the token itself. A flagged address is refused on-chain
   **even if the app shows no warning** — the contract is the source of truth, not the UI.
4. **Fails closed.** If nothing can be checked, the address shows as **Unscreened**, never as
   clear. Treat amber as "unknown, proceed with caution."

Results are cached briefly during your session to avoid repeated on-chain reads, then
re-checked the next time you enter or pick the address.

## Portability: export & import

You can move your address book between devices, or hand it to someone else.

- **Export** produces a plain `.json` file. No signature, no passphrase, no wallet
  — it works the same whether you sign in with a browser wallet, a hardware
  wallet, or a passkey.
- **Import** on another device (or after clearing your browser) restores your
  contacts. Any account can open any export: a file is no longer tied to the
  wallet that made it, so you can also share one with a friend or move it to a
  different account of your own.
- The file is **readable**, which is the point — you can open it in a text
  editor, check it, or edit it by hand before importing.
- Importing **merges** additively: new addresses are added, existing ones are
  kept (no duplicates), and where a nickname or note differs you are asked which
  to keep. Nothing is silently deleted.

> **The export file is not encrypted.** Every nickname, address and note in it is
> readable by anyone who opens it. Treat it like a contacts list, because that is
> what it is — think before you email it, drop it in shared storage, or leave it
> in your Downloads folder on a shared computer.

If you import a corrupted file, or a file that is not an address book, the import
fails safely and your existing book is left unchanged. An import is not a
verification: a file can put any address under any name, so a contact that arrived
from someone else deserves the same look as one you typed yourself — the screening
tags apply to imported addresses exactly as they do to the rest.

### Older encrypted exports

Exports made before this changed were encrypted with a key from your wallet's
signature. They still open — but only in a session connected to the **browser
wallet that created them**, since only that wallet can produce the key. If you now
sign in with a passkey, that file cannot be opened; export a fresh one from a
device that still has the book instead. The app will tell you this in those words
rather than blaming your wallet.

## Privacy notes

- Contacts live in your browser's local storage, keyed to your wallet address.
  Clearing your browser data removes them — export a copy first, and keep in mind
  that the copy is plain text.
- The separate **Backup** feature (My Account → Recovery) is a different thing and
  is still encrypted: it syncs your address book along with your other app data
  under a key only your wallet can derive. Use that when you want your contacts
  protected; use Export when you want a file you can read or share.
- Different wallets on the same device have separate, isolated address books.
