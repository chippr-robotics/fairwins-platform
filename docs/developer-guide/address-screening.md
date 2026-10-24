# Address screening: every list, every network, one honest pill

**Spec:** [021 (amendment 2026-09-06)](../../specs/021-address-book/spec.md) · **Issue:** #1458 ·
**Code:** `frontend/src/lib/screening/`, `hooks/useEstateScreening.js`,
`components/ui/ScreeningPill.jsx`, `components/ui/AddressScreenNotice.jsx`

## What changed, and why

The original screen asked one question — *does the FairWins `SanctionsGuard` on the wallet's
chain allow this address?* — and rendered nothing when the answer was yes. Two problems:

1. The guard exists on three chains. On Ethereum, Optimism, Arbitrum and Base every address was
   *Unscreened*, while the Chainalysis oracle and the USDC freeze list sat readable on those
   very chains.
2. "Nothing" is not an answer a member can act on. A clear result that renders as silence is
   indistinguishable from a screen that never ran.

Now an entered address is checked against **every configured source on every chain in the
cohort**, and the member gets ONE word with the receipts one tap away.

## The sources (`lib/screening/sources.js`)

| Kind | Read | Where | What a flag means |
|---|---|---|---|
| `fairwins-guard` | `SanctionsGuard.isAllowed` (+ `isDenied` for the reason) | wherever `getContractAddressForChain('sanctionsGuard', id)` resolves | a wager / membership / pool action with this address **reverts** |
| `chainalysis-oracle` | `isSanctioned` on the Chainalysis Sanctions Oracle | 1 / 10 / 137 / 42161 at `0x40C5…C8fb`, Base at `0x3A91…739B` | on the OFAC SDN list |
| `issuer-freeze` | `isBlacklisted` (Circle USDC) / `isBlackListed` (Tether USDT) | native USDC on the five mainnets + Amoy; USDT on Ethereum | the issuer has frozen it — that token sent here **cannot be moved** |

Every row was verified by a live read before it was written down (`eth_getCode` non-empty, the
zero address answering `false`, a known SDN address answering `true`). **A row is a claim that
the contract at that address exposes that selector.** A wrong row does not fabricate a verdict —
the call reverts and the source reports `unreadable` — but it silently costs a member a source.
Verify before adding one, and only list NATIVE issuer contracts: a bridged token has no freeze
function.

Chains with no source (Ethereum Classic, Mordor, the non-EVM ids) are **reported as uncovered**,
never counted as clear.

## Two reading states, four verdicts, one rule (`lib/screening/verdict.js`)

A reading is `{ status: 'read', flagged }` or `{ status: 'unreadable', reason }`. The verdict:

| Verdict | Condition | Pill |
|---|---|---|
| `flagged` | ANY source answered "listed" | red, `role="alert"` |
| `screened` | EVERY configured source answered, none flagged | green |
| `partial` | nothing flagged, ≥1 answered, ≥1 unreadable | amber |
| `unscreened` | nothing answered (or nothing to ask) | amber |

The asymmetry is the feature. A flag is a positive fact from a named list and stands on its own.
"Clear" is the absence of a flag from **every** list, so one list that did not answer means the
absence was never established — `screened` requires `unreadable === 0`, and there is no way to
reach green with a source missing.

The verdict is **derived from the readings, never stored**: the readings are what is cached, so
the rows a member expands always match the pill.

## The roster: the cohort, minus what cannot be reached

```js
import { screeningChainIds } from '../lib/screening/sources'
```

**A source a build can never reach is not a degraded source — it is not a source.** Chain 1337 is
`isTestnet: true`, so it sat in every testnet build's cohort; it carries a `sanctionsGuard` in the
contracts config; and its endpoint is `http://127.0.0.1:8545`. The deployed testnet build therefore
told every member, about every address, that "FairWins sanctions guard on Hardhat could not be
read" — and since an unanswered list can never be a clear one, the pill could never reach green
there. QA found it as *"screening is failing to read from networks on testnet staging; working on
staging mainnet"*, with three of four sources unreadable.

`screeningChainIds()` is `cohortChainIds()` minus `isLocalOnlyChain`. It can only subtract, so the
cohort boundary (constitution III) still binds. `frontend/src/test/screening/screeningRoster.test.js`
drives the filter against a cohort that contains a sandbox, because the cohort a test run happens
to resolve is not the thing under test.

The other half of that QA report was an endpoint, not a rule: Amoy's build default was Polygon's
own `rpc-amoy.polygon.technology`, which had stopped answering browser reads. It now defaults to
publicnode, like Polygon mainnet, Sepolia and Hoodi already did. A member's own endpoint (spec 069)
still wins over it.

## The sweep (`lib/screening/screenEstate.js`)

`screenAddressAcrossEstate(address, opts)`:

- **Roster-bounded** — `screeningChainIds()` (above); `readProviderFor` refuses an out-of-cohort
  chain regardless.
- **Failure-isolated** — every source resolves on its own. The function **never rejects**.
- **Deadline-bounded** — `DEFAULT_DEADLINE_MS` (8 s) per source; a timeout is `unreadable` with
  that reason (spec-104 lesson: an unbounded wait turns one failure into a hung surface).
- **Spec-069 providers** — `readProviderFor(chainId, walletChainId, walletProvider)`. Never
  `NETWORKS[chainId].rpcUrl`.
- **Cached** per lowercase address + chain set for `SCREENING_TTL_MS` with in-flight
  de-duplication; `force: true` bypasses, `forgetEstateScreening(address)` evicts.
- Test seams: `providerFor`, `sourcesFor`, `chainIds`, `deadlineMs`.

## What the member actually reads

| Element | Carries |
|---|---|
| `ScreeningPill` | the verdict **in a word**, and the expansion naming every source with its answer |
| `ScreeningStatusBar` | the **shape of the scan** — one segment per source asked, coloured by its answer |
| the summary line | counts, and — for `flagged` only — the lists that objected |

The summary used to name every unreachable source. On a build where three of four could not be
read that made the notice a paragraph, and QA's note was blunt: *"the end user does not need the
text specifics."* They do need them eventually — so they moved one tap away, into the pill's own
rows, where each source is named with the reason it gave. `flagged` is the exception that still
names its lists inline: a member about to send value needs to know whether a FairWins guard will
revert the transaction or an issuer freeze will strand the token after it lands.

The bar is never the only carrier of a fact (WCAG 1.4.1) — it is one `role="img"` element whose
accessible name is the summary sentence, sitting beside a pill that says the verdict in words.

**There is no ⓘ in the notice.** It opened a bubble taller than a phone, clipped by the scrolling
modal it sat in, and stacked under the assistant launcher on the Pay panel. The explainer lives on
the Address Book header instead, and `InfoTip` itself was fixed for every caller: it now sits above
the assistant (z-index 1350, still below the nav drawer and the modal tier) and scrolls internally
rather than running off the screen.

## Two hooks, on purpose

| Hook | Question | Used by |
|---|---|---|
| `useAddressScreening` (spec 021) | does the guard on **this** chain allow it? | every surface that puts an address in front of a value action — Transfer, Pay, Bridge, Supply, group pay. Bridge, Supply, group pay and the mini-app host `submit` re-read it **forced past the cache at submission** (`{ force: true }`, **spec 067** FR-032); Transfer and Pay single-recipient use it as an advisory pre-check and lean on the gateway and the on-chain guard to enforce |
| `useEstateScreening` (this amendment) | is it flagged **anywhere**? | `AddressScreenNotice` — the pill under every address field |
| `useEstateScreeningMany` (same sweep, many addresses) | same question, for a list | `AddressBookPanel` (the book) and `AddressInputBookAddon` (the inline addon beside an address field). **Not** the modal picker — `AddressBookButton` still calls `useAddressScreening().getStatus` and was missed by the #1458 migration (issue #1571) |

`force: true` is the difference that matters. The cache has a 60-second TTL (`SCREENING_TTL_MS`),
so a verdict good enough for browsing is not good enough to authorise a signature: a wallet
deny-listed between the quote and the tap would still read "clear" for up to a minute. **Spec 067**
FR-032 is the requirement — *"enforced at the point of submission — not only at display time"* —
and it is why `screenOne` takes `force`, and why a forced read never joins the shared in-flight
slot. Spec 021 itself requires no submission-time read; it requires the warning to be advisory and
never to weaken on-chain enforcement (FR-013), which is a ceiling on what the client may claim, not
a floor on what it must check.

The address book used to ask the per-chain hook, which can only answer for the chain the wallet is
connected to — so a contact saved on Amoy while the wallet sat on Polygon, or any contact at all
with no wallet connected, rendered **Unscreened**. QA's screenshot showed thirteen contacts and
thirteen amber tags on a build where screening worked perfectly. Screening needs no wallet, so the
book no longer pretends it does: one sweep per unique address (shared through the module cache),
`getVerdict(address)` for the contact-level flag, and `getVerdictOn(address, chainId)` for a saved
address's own network — which answers `no-source` when nothing screens that chain, a different
sentence from "nothing answered", and never collapses into it.

Do not collapse them. The per-chain read is the one the contract will repeat, and it must stay a
live read on the chain the value moves on. The estate read is advisory and its cache is fine.

## The pill (`components/ui/ScreeningPill.jsx`)

Icon + word for every state (WCAG 1.4.1 — never colour alone). It is a `button` with
`aria-expanded`; expanding lists every source per network with `Clear` / `Flagged — <detail>` /
`Could not read — <reason>`, and every uncovered network with `No screening source on this
network`. The network the surrounding flow acts on is marked `(this network)`. Fills are opaque
status tokens paired with their text tokens (spec 090 rule 3) — no literal colour.

`AddressScreenNotice` wraps it with the sentence from `describeVerdict` and the ⓘ, and now
renders for **every** valid address. It is mounted under the recipient field in Transfer, Pay,
the wager-create opponent field, and each address row of the contact editor.

## The no-chain e2e tier

The fast tier's RPC stub answers `0x` to every `eth_call` it does not model, so every source is
`unreadable` there and the pill must read **Unscreened** or **Partly screened** — never green.
`[MS-06]` in `34-member-surfaces.cy.js` asserts exactly that, and that the expanded rows say
*Could not read*. `[CM-01]` in `31-identity-access.cy.js` models the guard's `isAllowed` as
`false` and asserts the notice is an `alert` naming the FairWins guard.

## What is deliberately not here

- **Subgraph indexing of `DenyListUpdated`.** A single-address verdict is a point read; the
  subgraph would add a per-network deploy dependency and no new fact. Follow-up if the operator's
  reason text is wanted in the UI.
- **Off-chain risk providers** (TRM, Chainalysis KYT, Elliptic). The source shape —
  `read(provider, account) → { flagged, detail }` — is what one would implement, behind a
  member-held credential. Nothing here should ever route a member's counterparty through a
  FairWins-held API key.
- **Enforcement.** Nothing in this feature blocks. The on-chain guard and the issuing token do.
