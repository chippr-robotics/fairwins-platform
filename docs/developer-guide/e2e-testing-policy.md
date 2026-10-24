# End-to-End Testing Policy

**Spec**: [094-e2e-coverage-expansion](../../specs/094-e2e-coverage-expansion/spec.md) ·
**Matrix**: [e2e-coverage-matrix.md](./e2e-coverage-matrix.md) · **Issue**: #1228

This is the document to read before writing an end-to-end test. It answers two questions without a
judgement call — which tier does this belong in, and what must the test assert to count — and it
carries the anti-patterns that made the current suite report coverage it did not have.

## The three tiers

| Tier | Directory | Needs | Runs | Budget |
|---|---|---|---|---|
| **no-chain** | `frontend/cypress/e2e/fast/` | A built app | Every push, twice — once per viewport profile, **6 shards each** | **< 7 min per leg** — revised from 6, with the reason recorded below (#1249). Measured 312–407s across the twelve legs |
| **on-chain** | `frontend/cypress/e2e/full/` | A local chain, a deploy and a seed | Every push, 4 shards in parallel | **< 15 min per shard** (measured 9:53 / 10:04 / 12:31 / 13:36) |
| **account-native** | `frontend/cypress/e2e/passkey/` | The WebAuthn harness | Every push, **once** — it rides the no-chain job's desktop leg for a runner, not because it is a viewport question | **< 5 min** |

## The two admission rules

**1. A flow that can be validated without a chain MUST NOT live in the on-chain tier.**

Rendering, validation, disclosure copy, gated controls, error and degraded states, responsive
behaviour and accessibility all belong to the no-chain tier. The on-chain tier's cost is mining real
transactions and waiting on real receipts; spending it to prove a button exists spends the merge
gate's wall clock on nothing.

The test for this, from #1228: *would this test pass against a mock and still let a real bug
through?* If yes, it does not need a chain.

**2. A flow in which a member signs something that costs them money MUST have on-chain-tier
coverage.**

Not "should". The on-chain tier exists because the fast tier cannot tell a working money path from a
broken one. A money flow with only fast-tier tests is a gap in the coverage matrix no matter how
thorough those tests are.

It runs on **every push**, which is affordable because it is sharded: the measured legs are
6:37 / 7:51 / 6:29 / 6:09 against a serial total of ~27 minutes. Deferring it to the release PR was
considered and rejected once those numbers existed — a money-path regression caught at the release
PR is caught later and against a much larger diff, and ~7 minutes in parallel is not what a branch
waits on.

## What a test must do to count

- **Establish its own preconditions.** With per-test chain isolation, a test that relies on state an
  earlier test left behind is not saving setup — it is unfalsifiable when run alone. If a
  precondition cannot be established, the test **fails**. It never continues past it.
- **Judge the outcome by the authority that decides it.** Where the chain settles it, read the chain
  (`waitForWagerActive`, `waitForWagerResolved`, a token balance). Modal wording has passed here
  while the transaction was never sent — that is how #1226 and #1227 stayed hidden.
- **Assert something that can be false.** An accepted-terms list containing both the success and the
  failure wording proves only that the page contains words.

## Assertion depth

The matrix records depth as a fact separate from coverage, because a flow can be `covered` by a test
that cannot fail:

| Depth | Means |
|---|---|
| `settled` | The outcome was read back from the authority that decides it — chain state, a stored record, a balance. |
| `flow` | The journey completed and the interface agreed it had. |
| `smoke` | A surface rendered; a control existed. |
| `skipped` | Tests are written and cited, and they **do not execute**. |
| `none` | No test, or only assertions that cannot fail. |

A flow whose only test is guarded by a precondition that can be absent is `smoke`, however many
tests pass.

`skipped` exists because a permanently-skipped test is the same defect as anti-pattern 7 arriving
by another route — the suite is green, the row says covered, nothing was checked. It was measured
(#1271): the account-native tier ran **1 of its 17 tests** for want of an env var nothing set, while
six rows read `covered / flow`. The depth cites the dead tests, so a reader can find them, and
claims nothing: its status must be `absent` or `partial`, and `missing` must say why they do not
run. It sorts below `smoke`, so it loses every is-this-proven comparison.

A skip that is *conditional* on something CI provides is fine. A skip nothing can satisfy is a
gap, and belongs in the matrix as one.

## Anti-patterns

Each of these was a real cause in the 122-blocker list, and each made a test that *looked* like it
was checking something.

| # | Pattern | Why it looks fine | What it actually did |
|---|---|---|---|
| 1 | `cy.get(x).then($el => { if ($el.length) … })` | Reads as an optional step | `cy.get` **fails the command** when nothing matches, so the guard never runs. The step is not optional — it is absent. |
| 2 | Unscoped `cy.contains` in a portalled-modal app | The assertion passes | It matched the page *behind* the modal. A visibility assert does not catch it: the wrong element genuinely is visible. |
| 3 | `$panel.find(...)` inside `.then()` reported as state | Looks like reading the UI | It is a DOM snapshot taken once, before async-gated controls render. |
| 4 | `cy.on(...)` registered before `cy.mockWeb3Provider()` | Both lines are present | `cy.on` registers synchronously and the mock only enqueues, so the wrapper finds nothing to wrap and installs nothing. |
| 5 | Rejecting `eth_sendTransaction` to test a refusal | Looks like a refusal test | On the intent rail the member's authorization is a **signature**; nothing is refused. |
| 6 | Silent no-op branches | The test goes green | It continued past a failed precondition and died somewhere unrelated — or passed having tested nothing. |
| 7 | `expect(true).to.be.true` behind a precondition guard | Reports as coverage | 33 branches across four money-path specs. **A test that passes when its precondition is absent is worse than a missing test.** |
| 8 | `if (!Cypress.env('X')) this.skip()` where nothing sets `X` | Reads as a conditional skip | The skip is permanent, not conditional. 16 of the account-native tier's 17 tests were pending for a year while the matrix called them covered; when they were finally allowed to run, every one of them failed (#1271) — including three asserting a `data-testid` the app does not have. Record it as depth `skipped`, and make the env var real or delete the test. |
| 9 | `const t0 = Date.now()` in a Cypress test body | Looks like a stopwatch | The body is EVALUATED before a single command runs, so the timer starts at test start and a later assertion is charged everything before it. RU-01 read 16s for a sign-in that takes ~700ms. Stamp inside `cy.then()`. |
| 10 | A selector only one viewport profile renders | Green on the profile you ran locally | The no-chain tier runs at **both** `desktop` and `phone` (FR-019), and plenty of switchers ship twice: My Account's view strip is `display:none` ≤768px while `SectionIconNav` renders only ≤768px. `[role="tab"]` still **exists** at 390px, so `.should('exist')` passes and `.click()` then hits a hidden element. Pick the switcher the viewport actually shows, and assert through that control's own idiom (`aria-selected` on a tab, `aria-current` on the icon bar). |
| 11 | `cy.clock(Date.now(), …)` to age something out | Reads as "pin the clock to now" | Same evaluation trap as #9: the argument runs at test-body evaluation, so the clock pins to test START. A later `cy.tick(61_000)` then lands in the past of anything the test set up in between, and the thing that was supposed to expire looks fresh. BTC-03 broadcast a real transaction and reported a product bug that was its own. Stamp it inside `cy.then()`. |
| 12 | A fixture that rewrites chain state the checkpoint cannot undo | The spec passes, and passes again | The full-tier checkpoint (`chainCheckpoint`) only rewinds within ONE `cypress run` — the snapshot id lives in the plugin process. A fixture like `legacyFixture: makeTokenRefuse`, which `hardhat_setCode`s a reentrant token over the wrapped coin, therefore survives the run and greets the NEXT one with a coin that refuses every transfer. The spec then fails in the test that arms nothing and is innocent (LKR-S1), which reads as a product regression. Undo it in an `after` hook (`restoreTokenCode`), and treat the checkpoint as isolation between specs, never as cleanup. |

### Pattern 7 is gated

`frontend/src/test/e2e-policy/assertionDepth.test.js` fails the build on an unconditional-truth
assertion in `cypress/e2e/**` unless the line above it carries:

```js
// EITHER-WAY: <why this outcome is genuinely either-way>
expect(true).to.be.true
```

There is one legitimate use of the pattern — an outcome that may honestly go either way — and it
deserves a sentence saying which, so the exceptions stay countable. The gate reports the running
total on every failure.

The same gate reports **contradictory accepted-terms** (a success check that also accepts `'error'`
or `'failed'`) and requires every accessibility suppression to name its tracking issue.

## Fixture and precondition conventions

- On-chain preconditions go through the `chainTx` task, never through the UI — unless driving the UI
  *is* the thing under test.
- A spec that advances the chain clock opts into per-test isolation with `resetChainBetweenTests()`,
  called **after** the spec's own `before` hook so durable fixtures survive the reverts.
- After any revert, re-point the browser clock at the chain with `syncBrowserClockToChain()`. The app
  decides expiry in browser time and the contracts enforce chain time; a deadline test is meaningless
  while the two disagree.
- `chainTx` decodes custom errors, so a reverting precondition says why rather than failing silently.
- The **development warning banner is dismissed before every test** (`dev_warning_banner_dismissed`,
  set from `window:before:load` in `cypress/support/e2e.js`). It is a dev-build affordance that never
  ships, it is `position: fixed`, and it reserves a hardcoded 45px while wrapping to three lines at
  390px — so at phone width it covers the fixed wallet-connect button (#1248). A spec working around
  it would be paying attention to something no member ever sees.

## Viewports

Both viewport profiles live in `frontend/cypress/support/viewports.js` and are applied from a global
`beforeEach`, selected by `CYPRESS_VIEWPORT_PROFILE`:

| Profile | Size | Notes |
|---|---|---|
| `desktop` (default) | 1280 × 720 | What every existing spec was written against. |
| `phone` | 390 × 844 | iPhone 12/13/14 logical viewport. |

Applying it globally is deliberate: a spec that sets its own viewport inherits desktop forever, and
the phone leg quietly stops growing. Only the no-chain tier runs both legs — responsive behaviour
needs no chain, and admission rule 1 applies to it like everything else.

Use `cy.assertReachable(selector)` before operating a control in a responsive assertion.
`should('be.visible')` passes for an element scrolled outside a clipping container: present is not
reachable.

## Accessibility

`cy.a11yScan()` runs the installed `axe-core` against the surface on screen.

```js
cy.a11yScan()                                         // the document
cy.a11yScan({ context: '.modal-root' })                // an open modal, not the page behind it
cy.a11yScan({ disableRules: [{ rule: 'color-contrast', issue: '#1019' }] })
```

- **Serious and critical violations fail the build**, per constitution V's WCAG 2.1 AA commitment.
  Moderate and minor are logged.
- **Scope the context** when a modal or drawer is open. The app portals its modals; a document-wide
  scan attributes the page's violations to the modal under test — pattern 2 in a different costume.
- **Every suppression names an issue.** Both the command and the gate reject one that does not.
- A scan that could not run fails. An accessibility check that silently did nothing is a green gate
  over an absent test.

## Performance

Budgeted routes live in `frontend/lighthouse-routes.json` and are measured on both a desktop and a
mobile profile (`frontend/lighthouserc.desktop.json`, `frontend/lighthouserc.mobile.json`). Both
configs must collect **exactly** that route list — asserted by
`check-lighthouse-coverage.js --routes-only` and by a unit-job gate, because otherwise the route set
lives in three files and a disagreement makes the coverage check answer a different question than
the one it appears to answer.

Budgets **report**; they do not block. A Lighthouse score on a shared runner moves several points
run to run, and a gate that mostly reports the runner is a gate people learn to re-run.

That is asserted, not assumed: **only accessibility audits may be set to `error`**, and the configs
carry no assertion preset — `lighthouse:recommended` marks nearly every audit `error`, which is how
`non-composited-animations` blocked this job on four routes the first time it measured more than
one. `frontend/src/test/e2e-policy/lighthouseRoutes.test.js` fails on a re-added preset, or on any
non-accessibility audit set to `error`.

What does block is a route that produced **no measurement**:
`scripts/e2e/check-lighthouse-coverage.js` fails when any route × profile is missing. `lhci` asserts
only over URLs it collected, so a route that failed to load otherwise contributes nothing and leaves
the job green — the same shape as every gate this repo has had to repair.

## Runtime budgets and sharding

**Both** Cypress tiers are split longest-first, because balancing spec *count* leaves the critical
path almost unchanged — the specs are nowhere near equal, and one spec can cost a hundred times
another. The packing lives once, in `scripts/e2e/lib/tier-split.js`; each tier has its own entry
point and its own measured weights:

| Tier | Legs | Splitter | Weights |
|---|---|---|---|
| on-chain | 4, one private chain each | `scripts/e2e/split-full-tier.js` | `full-tier-weights.json` |
| no-chain | 6 **per viewport profile** | `scripts/e2e/split-fast-tier.js --profile <desktop\|phone>` | `fast-tier-weights.json` |

The no-chain tier's two profiles do not run the same specs — the account-native (passkey) specs
ride the desktop leg only — so its splitter takes a `--profile` and packs the right set. Passing an
unknown profile is a hard error rather than a default: a phone leg packing the desktop set would
schedule passkey specs on a leg that never sets `PASSKEY_ENABLED`, and they would report as pending
rather than as a mistake.

A spec with no recorded weight is estimated at the file mean and **announced** as a CI warning. It is
never dropped: a spec silently leaving the merge gate is the failure this feature exists to prevent.

A tier over budget is a backlog item: split it, trim it, or move flows to a cheaper tier. Raising the
number is a decision that gets written down with its reason.

### The no-chain budget was raised from 6 to 7 minutes (#1249)

Written down here because the rule above requires it, and because a budget nobody can reconstruct
the reasoning for is a number rather than a budget.

**What was measured.** After sharding, the twelve no-chain legs ran 312–407s — four of the six
desktop legs above 360s, worst 407s (6:47). Phone was inside at every leg. Predictions had been 349s
/ 315s, so the model runs 7–20% low; the per-spec weights do not account for the fixed cost a leg
pays simply for existing (browser boot, support-file load, server warm-up), which a split into N
legs pays N times.

**Why the number moved rather than the shard count.** Both were on the table — 7 or 8 shards would
have brought the worst leg comfortably under 360s. The reason not to is that **this tier is no
longer the merge gate's critical path**. The gate is the on-chain tier at 13:36. Taking the no-chain
tier from 407s to ~320s would cost four more runners and roughly twelve minutes of aggregate
`npm ci`, and would not move the merge gate by one second. An optimisation that improves a number
nobody is waiting on is not an improvement.

**What would change the answer.** If the 6 minutes had meant "a leg should be quick enough to
iterate against locally" rather than "the gate should be fast", more shards would be the right
answer instead — the distinction is real, and this revision takes the second reading. Should the
no-chain tier ever become the critical path again, revisit the shard count before the budget.

**What did not change.** The budget is still enforced against measurement, and the tier is still
sharded longest-first from CI-recorded weights. 7 minutes leaves ~53s of headroom over the worst
observed leg, which covers the runner variance seen across a single run.

### What the no-chain tier cost before it was split (#1249)

Left unsharded, it became the merge gate's critical path — **34:29** of Cypress on the desktop leg,
against 09:53–17:09 for the on-chain shards that compile contracts, boot a chain and send real
transactions. The tier that starts no chain was more than twice as slow as the tier that does.

Nothing about the work explains that; the cause was structural. It is worth stating plainly because
the instinct on reading "the fast tier is slow" is to hunt for a slow spec, and there isn't one — the
per-spec spread is ordinary. **The on-chain tier was sharded four ways and this one was a single leg
per profile.**

Six is the first shard count at which both profiles fit the 6-minute budget (predicted 349s desktop /
315s phone). Seven and eight buy little: the floor is the longest single spec, and
`34-member-surfaces` alone is 192s. Runner minutes are roughly neutral — 2 legs × ~37 min ≈ 74
against 12 legs × (≈50s setup + ≈6 min) ≈ 82 — because this tier installs only frontend
dependencies, with no contract compile and no chain, so the per-job overhead sharding adds is small
next to the wall clock it removes.

### Keeping the weights honest

Weights are wall clock as Cypress reported it, re-recorded from CI. They decay: by the time #1249 was
measured, `29-protect-custody` had become the heaviest spec in the on-chain tier at **326s** while the
splitter was still estimating it at the ~110s file mean, so shard 1 carried roughly three times its
assumed load and ran 17:09 against 09:53 for the lightest leg. Balanced sharding is not a
set-and-forget property; a weights table that has stopped matching reality produces a split that
looks balanced and is not.

One trap when re-recording from a job log: Cypress **wraps long spec names across two lines** in its
summary table, so a `grep` for a duration on the same line as a name silently drops those rows. The
check is arithmetic — the per-spec durations should sum to close to the reported run total. Two
missing rows showed up as 161s of "unattributed overhead"; with them, it is 9s.

## Adding coverage

1. Add or update the flow's row in `frontend/cypress/coverage/matrix.json`.
2. If the row's status is `absent` or `partial`, its `issue` field MUST cite a tracking issue that
   is actually **OPEN** right now — present is not enough. #1400 found 11 of the matrix's 15 absent
   rows citing issues that had already been closed: a gap pointing at a dead link, and on
   inspection, a repeat of the same mistake rather than a one-off. `npm run check:e2e-trackers`
   (`scripts/e2e/check-absent-trackers.js`) enforces this in CI
   (`.github/workflows/e2e-matrix-trackers.yml`): it reads every `absent`/`partial` row, resolves
   its `issue` field against the GitHub API, and fails naming any row whose tracker is closed,
   missing, malformed, or could not be verified at all — an unverifiable reference is never treated
   as a pass, closed or open.
3. Run `npm run e2e:matrix` and commit the regenerated document.
4. Write the test in the tier the admission rules choose.
5. Run `npm run test:frontend -- --run src/test/e2e-policy` before pushing.

**Do not add a dependency for any of this without reading spec 075's lockfile hazard first.** The
accessibility scan injects the already-installed `axe-core` rather than adding `cypress-axe` for
exactly that reason.

## Decision records

Dated entries for calls this policy had to make explicit. They live here rather than only in a
closed issue or a merged PR description, because a decision nobody can find the next time the same
question comes up gets re-litigated instead of read.

**2026-09-01 — Decision (#1400 §B): the merge gate carries a local hardhat + alto stack.** The
account-native full-stack job (`cypress-passkey-full-stack` in `test.yml`) runs the
`PASSKEY_FULL_STACK`-gated specs against a local chain, the deployed account stack + verifying
paymaster, a pinned alto container and the relay-gateway paymaster endpoint on a hardhat test key;
`paymaster.sponsored-userop`, `passkey.controllers`, `passkey.recover-account` are covered there.

The three `102-capacitor-channels` native rows — `native.passkey-signin`, `native.lifecycle-lock`,
`native.deep-link-entry` (tracked by #1389) — are deliberately **not** covered by that job, or by
any browser-based tier: they need a real emulator/simulator shell (Android's Credential Manager
test authenticator, an `appUrlOpen` intent, an instrumented background/foreground transition), which
neither Cypress tier can host no matter how it is configured. Their home is the native release lane
(see `docs/developer-guide/native-channels.md`, spec 102), not `fast/`, `full/` or `passkey/` — the
tier for those three rows is deliberately not a browser tier at all, and #1389 tracks what still
needs to land there.
