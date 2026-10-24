# Funding pools — screenshot record (spec 103)

Captured by `scripts/ui/capture-funding-pools.mjs` (see its header for how to run it): the real
surface in a real Chromium against the `dev:e2e` server, reading REAL pools created and contributed
to on the local Hardhat node (`HARDHAT_LOCAL_CHAIN_ID=80002` + `setup:e2e`), with an injected wallet
that forwards every JSON-RPC call — reads and `eth_sendTransaction` — to that node. Every non-loopback
request is aborted. 9 scenarios × {desktop 1280×900, mobile 390×844} × {light, dark} = 36 shots.

| shot | what it shows |
|---|---|
| `request-pool-form` | Payments home ▸ Request ▸ **Pool**: the compact Direct | Pool switch, goal pad, purpose field with byte counter, window pills, the public-purpose note, Create (disabled until valid) + My Pools |
| `my-pools-sheet` | The My Pools bottom sheet: find field, Active / Finished, role from the chain, mini progress, one next action per row |
| `pool-open-contributor` | An open pool as a contributor: progress bar with contributors + time left, contribute pad, Vote to refund, refund-votes bar with own standing, share row, feed |
| `pool-open-organizer` | The same pool as the organizer: **Close & collect** + **Refund everyone** lead the page, above the contribute pad |
| `pool-close-confirm` | The close confirm: amount, destination (own account), contributor count, goal-not-met-and-allowed, finality sentence |
| `pool-empty` | A fresh pool: 0 of 600, 0 contributors, refund bar says "No contributors yet — nothing to refund", feed says what to do next |
| `pool-refunding` | Refunding by majority: Collect-my-100-back primary, collected-of-total bar in amber, the reason, own standing, vote + refunding entries in the feed |
| `pool-closed` | Closed with goal met: Goal met chip, closed sentence, no controls, the close in the feed |
| `pool-unreadable` | `/fund/0x…AA` (no pool there): "Pool not found" with the reason — no bar, no zeros |

## Actor-critic findings (what the loop changed)

**Round 1 → fixes.**

1. *My Pools labelled a contributed pool "Organizer"* — the row's role came from the device record,
   which the harness (like a stale record) could get wrong. Role now comes from the chain
   (`isOrganizer` / `contributed[me]`), the record only says which pools to look at
   (`useMyFundingPools.js`).
2. *The sheet's find field collapsed to a 50px box on mobile* — the ActionSheet's mobile rule widens
   every button to the sheet, so "Open" took the row. Scoped `width:auto; flex:0 0 auto` on the find
   button (`funding.css`).
3. *The organizer's primary action sat below the contribute keypad.* The organizer's controls
   (Close & collect / Refund everyone) and their confirm card now render first; the contribute pad
   follows (`FundingPoolPage.jsx`).
4. *An empty pool's refund bar read "0 / 0".* The count is hidden while there are no contributors;
   the sentence carries the meaning (`RefundStatusBar.jsx`).
5. *A non-pool address rendered as "unreadable — could not decode result data"*, an ethers message.
   Empty return data from an address with no pool code is "not a pool here", not an outage: the page
   now lands on **Pool not found** with the network hint; a genuine RPC failure still renders the
   unreadable sentence + Retry (`FundingPoolPage.jsx`).

**Round 2 (member feedback + axe).** The kind switch became **Direct | Pool** with a subtle glyph each
(arrow-in / people) at a compact size — one quiet two-way switch under the mode bar, not a second mode
bar. The no-chain a11y scan then flagged the SELECTED window pill's label: `PillSelect`'s active state
coloured small text with `--brand-primary`, a large-text/fill colour under spec 090 rule 1, at under
4.5:1 on its own tint. Fixed at the source (`PillSelect.css` → `--accent-color`; the border keeps the
brand hue), which every pill in the app inherits.

**Round 3.** Clean across both themes and both viewports: every control is visibly a control in both
themes (brand fill + inverted label on dark), status chips are opaque, the refund bar's amber is a
signal not a fill, the confirm reads as sentences, the feed names the viewer as "You", the share URL
and words wrap without overflow on mobile, and no cell shows a placeholder where a number belongs.

**Known capture artifact, not a finding:** on the mobile `request-pool-form` cells the fixed mode bar
(Pay / Request / Wager) is painted at the viewport's bottom edge inside a taller element capture, so it
appears mid-form. In the browser the form scrolls beneath it with the safe-area padding spec 058 added.

**Not photographed, deliberately:** a passkey-account (`sendCalls`) submission and a relayed
submission — the former needs the WebAuthn harness, the latter a gateway that does not serve funding
pools in this release (research R8).
