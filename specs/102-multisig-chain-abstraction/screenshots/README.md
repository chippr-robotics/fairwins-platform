# One vault, every network — screenshot record (spec 102)

Captured by `scripts/ui/capture-vault-sheet.mjs`: the real Protect ▸ On chain surface with a
vault seeded through the app's own reference store on THREE networks (Polygon + Base answered by
two loopback stub chains through the spec-069 member RPC override; Optimism deliberately
unstubbed so the unreadable state is real), a second single-network vault, an address book that
names one owner, and three pending proposals whose `Proposed` logs carry verifiable safeTxHashes.
7 scenarios × {desktop 1280×900, mobile 390×844} × {light, dark} = 28 shots (+ full-height
companions for the Queue, Details, Create and Load sheets).

| shot | what it shows |
|---|---|
| `vault-cards` | ONE compact card per vault address: avatar, Multisig tag, label, `2 of 3`, live `3 pending`, short address, `3 networks`, "Tap to open", the ⋯ outside the option |
| `vault-sheet-queue` (+`-full`) | Queue: rows from Polygon AND Base tagged with their network pill, approvals/threshold, recipient cross-referenced ("to **Alice**"), per-network read status with Optimism `could not be read — Retry` |
| `vault-sheet-style` | Style: the spec-086 customize body against the vault address (one look on every network) |
| `vault-sheet-details` (+`-full`) | Details: address + copy, one article per network (Safe version, threshold, role, policy), owners (You / address book / generated + add-in-place), Owners & threshold governance, acting-account radiogroup, Remove from Protect |
| `vault-sheet-create` (+`-full`) | Vault actions ▸ Create vault inside the shared sheet, in the app's own field chrome |
| `vault-sheet-load` (+`-full`) | Vault actions ▸ Load vault: address field + label, no network picker |
| `vault-wrap-balance` | Trade ▸ Wrap with the staging screenshot's `2.006441459389172406` balance rendering as `2.0064` |

## Actor-critic findings (what the loop changed)

**Round 1 → two defects in the queue read path, one in the fixture.** (a) The Polygon rows were
absent and "Polygon: none pending" was rendered — the stub's block head sat BELOW the recorded
hub deploy block (the harness had Mordor's number, 16645531, where Polygon's is 90120743), so
the scan legitimately covered no blocks; the app was right and the fixture was wrong. Fixed in
the harness, and the same number had been handed to the Cypress lane. (b) The unstubbed Optimism
instance sat on "reading…" for the life of the sheet: ethers retries network detection on a dead
endpoint forever. `useVaultQueueAcrossChains` now races every chain read against a 20 s ceiling
and resolves `unreadable` with the reason. (c) The card said "Tap to use" (the carousel's label
for switching accounts) and showed no pending count; `AccountCard` gained `idleLabel`, the card
reads "Tap to open", and its badge is the same session-cached cross-chain read the sheet makes
(`2+ pending` when a network could not be read).

**Round 2 → chrome and honesty.** The Create and Load forms rendered browser-default fieldset
notches, square white inputs and blue radios beside the app-styled address field — in dark mode
a white box on a dark sheet. One scoped rule set in `Custody.css` gives them the token fill,
border, radius, brand accent and focus ring, with one primary CTA per form. Details repeated the
network as a fact row inside the network's own article and broke the full address at one
character; the governance hint sat above its own heading. Queue rows printed a 42-character
recipient that wrapped on phones — the recipient is now cross-referenced (address book >
callsign > ENS) with the full address on the element. The Wrap fixture returned exactly `2` POL,
which photographed the formatter doing nothing; it now returns the staging balance and answers
token balances so "—" cannot hide a broken read.

**Round 3 → one finding.** After the read ceiling, Optimism's line still said "reading…" beside
Retry: the hook tracked only Safe instances, and the view's fallback assumed a missing entry was
in flight. Instances the list already failed to read now seed an `unreadable` entry carrying the
list's own reason and count toward the partial total.

**Round 4 — clean.** Every cell of the matrix reads as intended in both themes and both
viewports: one card per vault with a live `3+ pending` (the `+` because Optimism could not be
read), the Queue's partial total names the network it is missing and the status list says
`Optimism: could not be read — Retry`, recipients read "to **Alice**" with the address beside
them, the Create/Load sheets sit in the app's own field chrome with one primary action (rendered
in the disabled neutrals until the form is valid — the matched fill/label pair, spec 090), and the
Wrap tile shows `2.0064` where staging showed an 18-decimal string.

**Round 5 → one finding, from running the on-chain suite rather than looking at a picture.**
Driving `full/29-protect-custody.cy.js` against a private chain surfaced two defects no screenshot
could show. The hub scan is chunked and session-cached, so an overlapping range handed the same
`Proposed` log back twice — one pending transaction rendered as two rows with two Approve buttons
(React's duplicate-key warning was the tell). And the Queue reads when it opens without polling,
so a proposal the chain accepted a moment later was simply absent with no way to re-read it: a
queue one block stale looked exactly like a settled one. The queue now dedupes by
(chain, safeTxHash) and carries a **Refresh** that re-reads every network whatever its state — the
per-chain Retry is for a chain that failed, Refresh is for time having passed. Shots re-captured
with the control in place; 11/11 on-chain tests pass locally.

**Round 6 → one finding, then clean.** Allowed to wrap, Refresh dropped onto a line of its own
under the two-line summary at 390px and read as a stray link rather than this queue's control.
The summary now takes the room it needs and wraps within itself while Refresh pins top-right at
every width, flush with the rows' edge rather than inset by the global button padding. Re-captured
clean in both themes and both viewports.

**Not photographed, deliberately:** an approve on another network (the wallet switch is a real
wallet prompt — covered by the no-chain Cypress flow VS-04 with a scripted refusal and by the
on-chain CV-08 on the private chain) and a vault-mode send (spec 088's deferred ceremony).
