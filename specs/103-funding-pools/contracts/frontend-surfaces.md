# Frontend surfaces: Funding Pools (spec 103)

## Routes and entry points

| Surface | Where | How reached |
|---|---|---|
| Pool option | Payments home ▸ Request mode ▸ kind switch `Direct` / `Pool` (compact pills, arrow-in / people glyphs) (`data-testid="request-kind"`) | `/app` → Request |
| Create panel | `FundingPoolCreatePanel` inside `RequestPanel` when kind = Pool | — |
| Share view | replaces the create panel after success (`data-testid="funding-created"`) | — |
| Pool page | `pages/FundingPoolPage.jsx` | `/fund/<w1>-<w2>-<w3>-<w4>` or `/fund/0x<address>` |
| My Pools sheet | `MyFundingPoolsSheet` (built on `components/account/ActionSheet`) | "My Pools" button in the Pool kind (`data-testid="my-pools-open"`) |
| Phrase lookup | existing `UnifiedLookupModal` (`resolvePhraseLookup` extended) | Wager mode ▸ Accept a challenge; four words that resolve to a funding pool navigate to its page |

## Pool page layout (top → bottom)

1. Header: purpose (h1), organizer alias + short address, state chip (`data-testid="funding-state"`).
2. `FundingProgress`: `role="progressbar"`, `aria-valuenow` = capped pct, `aria-valuetext` "X of Y
   USDC raised (Z%)", raised / goal, contributor count, time left or "contributions closed"
   (`data-testid="funding-progress"`). Goal met → "Goal met" chip.
3. Action block, ONE primary per state and role:
   - open + not organizer (or organizer too) → `ContributeControl` (AmountKeypad-style amount +
     "Contribute" primary, `data-testid="contribute"`); after `contributeDeadline` → sentence.
   - open + organizer → "Close & collect X" (`data-testid="close-pool"`) + secondary "Refund
     everyone" (`data-testid="cancel-pool"`), each behind a confirm step that states amount,
     destination and finality (`data-testid="confirm-close"` / `confirm-cancel`).
   - open + contributor → "Vote to refund" (`data-testid="vote-refund"`) or "You voted".
   - refunding + contributor with balance → "Collect my X back" (`data-testid="claim-refund"`).
   - open + past settleDeadline → "Start refunds (deadline passed)" (`data-testid="poke-deadline"`).
   - closed → "Closed — X collected by the organizer" sentence.
4. `RefundStatusBar` (`data-testid="refund-status"`): open → votes/needed bar; refunding → collected
   /total bar + reason; hidden when closed.
5. Share row: words (`data-testid="funding-phrase"`), copy link (`data-testid="copy-link"`), QR
   toggle.
6. `FundingActivityFeed` (`data-testid="funding-feed"`): entries newest-first; empty state sentence;
   unreadable state sentence + retry (`data-testid="feed-retry"`).
7. Notices: `role="alert"` for errors (`data-testid="funding-notice"`), `role="status"` for progress.

## My Pools sheet

- Title "My Pools"; top: find field (four words or a link, `data-testid="my-pools-find"`).
- Sections "Active" / "Finished"; rows (`data-testid="my-pools-row"`) show purpose, role chip,
  state, mini progress, next action button; tapping the row opens the page.
- Empty: "You haven't organized or contributed to a pool on this device yet." + "Start a pool".

## Create panel fields

`funding-purpose` (text, maxLength 200, counter), `funding-goal` (AmountKeypad, USDC), window
pill (`funding-window`: 1 day / 3 days / 1 week / 2 weeks / 30 days), public-purpose note, primary
"Create pool" (`data-testid="funding-create"`), disconnected → "Connect wallet".

## Storage keys

- `fairwins_funding_pools_v1_<account>` — device record `[{ address, role }]`.

## CSS

`components/funding/funding.css`, tokens only (`--brand-primary`, `--accent-color`,
`--success-color`, `--warning-text`, `--surface-2`, `--border-color`, `--text-muted`, …). Progress
fill uses `--brand-primary` (a fill colour per spec 090 rule 1); refund bar fill uses
`--warning-color` (signal); labels use text tokens. No `font-family`.
