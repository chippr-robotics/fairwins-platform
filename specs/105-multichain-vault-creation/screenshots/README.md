# Guided multichain vault creation — screenshot record (spec 105)

First actor pass (2026-09-05): the three creation sheets that render without a chain — **type**
(presets + owners + label), **rules** (tile grid, one tile open in `-editing`, live summary with
the `Joint account · 1 of 2` chip), **networks** (cohort multi-select, connected chain
preselected, one primary "Deploy vault" CTA) — captured against the real dev app with a mocked
injected wallet on Polygon, 2 viewports × 2 themes = 16 shots. Every non-loopback request aborted.

Critic notes from this round: dark-mode selected network chip correctly inverts to the Teal 300
fill + Gunmetal label pair; tiles read title/value/hint at three sizes with token colours; the
summary restates the arrangement in the same words `describeSemanticRules` feeds the flow, so it
cannot claim what the realized rules will not enforce. No defects requiring a fix were found in
this pass.

Second actor pass (2026-09-05, issue #1455): the stub-chain surfaces, via
`scripts/ui/capture-vault-create.mjs` (spec-102 harness pattern — two loopback stub chains behind
the spec-069 member RPC override; Polygon completes the REAL orchestration through receipts, Base
refuses `eth_sendTransaction` with a genuine JSON-RPC error, Optimism is referenced but never
answered). 8 scenes × 2 viewports × 2 themes = 32 shots (+`-full` sheet extents):

- **create-status** — the deploy orchestration mid-truth: predicted address before any signature,
  Polygon `Live · rules awaiting approval` (the queued-install label for a 2-of-2), Base `Failed`
  with ITS reason (`insufficient funds for intrinsic transaction cost`) + Retry, `1 of 2 selected
  networks live.` Failure isolation photographed, not asserted.
- **create-done** — the done sheet's honest pending list: queued rules named per network, the
  failed network named with its reason and the way out ("retry from the vault's details").
- **details-one-card** — ONE card: Live rows (wallet-here action on the connected chain, Switch on
  the other), Optimism `Could not be read`, missing cohort networks as `Not deployed` rows with
  record-gated Deploy; `Approvals: 3 of 3 owners — Differs on Base (2 of 2 owners)` names the
  drifted network; the coverage line names the unread one.
- **details-deploy-later** — the FR-017 original-arrangement disclosure over the Deploy confirm.
- **details-no-record** — the same missing rows with the FR-018 reason and NO deploy control.
- **queue-chips / queue-needs-you** — `3 pending across 2 networks · Optimism not read`, chips
  (All / Needs you (2) / Polygon / Base), decoded titles ("Send 250 USDC on Polygon"), the
  needs-you row's primary Approve, "waiting on other owners" on the already-approved row.
- **load-sheet** — the app-styled Load form, no network picker.

Critic findings from this round, and what was done:

1. **Fixed** — the deploy-later disclosure printed the record's owners as FULL 42-character
   addresses (`creationRecord.owners.join(', ')`), a wall of hex that wrapped across four lines on
   mobile while every other owner reference on the card is shortened. Now rendered through
   `shortAccountAddr` (recaptured; all four `details-deploy-later-*` shots are the fixed form).
2. Dark mode keeps the spec-090 pairs everywhere new: the Done/Deploy primaries invert to the
   Teal 300 fill + Gunmetal label, failure text is `--error-color`, the done sheet's pending list
   uses amber TEXT (`--warning-text`), not amber fill.
3. The Failed row's reason is ethers' own message, unedited — honest, if terse; judged acceptable
   because the Retry control and the done sheet's "retry from the vault's details" carry the way
   out.

The multi-NETWORK wallet-switch journey itself (real prompts, two real chains) is out of a
harness's honest reach — that is the staged manual protocol in
`docs/runbooks/multichain-vault-staging-validation.md` (#1453).
