# The dependency vulnerability gate

`npm run check:dep-alerts` (issue #1521). Source: `scripts/security/check-dependency-alerts.js`,
policy: `scripts/security/dependency-alert-policy.json`.

## Why it exists

`.github/dependabot.yml` has carried this line in its header since it landed:

> There is currently no vulnerability gate anywhere in CI while `npm audit` reports findings on
> every install, so this is the first automated pressure on that.

The pressure it meant was Dependabot opening pull requests, capped at five. Nothing ever read the
**alerts**, so they were not a signal anybody had to answer. By 2026-09-06 there were 45 open — one
critical, nine high — and every required check had been green throughout.

That is the same shape as every other invariant this repo ended up gating: `check:specs`,
`check:ci-gating`, `check:finops`, the byte gates. A prose rule with no enforcement is the rule that
gets broken. Dependency vulnerabilities were the last class still on the honour system.

## What it does *not* do

**It does not run `npm audit`.** Two reasons, both disqualifying:

1. `npm audit` re-resolves the tree to answer. An incremental resolve in this repo silently drops
   the platform rolldown binary from `node_modules` **and** the lockfile (npm/cli#4828, spec 075),
   so the gate would break the builds it is meant to protect.
2. It cannot see dismissals. The 12 OpenZeppelin alerts against a 4.7.3 copy nested under
   `@chainlink/contracts` that solc never reads (#1520) would keep it permanently red for a reason
   that is already understood and written down.

It reads the Dependabot alerts API instead, where a dismissed alert is simply not `open`.

## The threshold

Declared in the policy file, not in code:

| severity | scopes that fail |
|---|---|
| `critical` | `development` and `runtime` |
| `high` | `runtime` only |
| `medium`, `low` | never |

A gate that failed on all 45 would have been red on the day it landed, and a gate that is always red
gets bypassed — which is how the repo went without one. 32 of the 45 are development-scope and none
of those is critical, so they are reported by Dependabot and do not block a merge.

**An unknown scope counts as `runtime`.** The API can report `scope: null`; absence of a
"development" label is not evidence of safety.

## Acceptances are time-boxed

Every entry in `acceptances` needs four things: a valid `ghsa` id, the `package`, a `reason` of real
length, the `issue` tracking its removal, and an `expires` date.

The expiry is the point. An acceptance with no end date is a silenced alert, and silence is what let
45 accumulate. When one expires the gate fails and the choice comes back: fix it, or renew
deliberately with a fresh reason.

**The list only ever shrinks.** D-04 removes an entry that no longer matches an open alert, so a
stale excuse cannot sit in the file hiding the next real finding. That is the same rule as
`LEGACY_COLLISIONS` under the spec registry's S-04.

Note what is deliberately *not* accepted: the OpenZeppelin alerts belong on the alert itself as a
**dismissal**, with the import-graph reasoning attached (see [Dismissals are the other
half](#dismissals-are-the-other-half)). An acceptance here would record them as tolerated risk,
which is a different and wrong claim.

## Two halves, because they need different things

| | runs | needs | enforces |
|---|---|---|---|
| **offline** (default) | every PR, in the `Spec Registry` job | nothing | D-01, D-02, D-06 |
| **live** (`--live`) | push to `staging`/`main`, daily cron, manual | `vulnerability-alerts: read` | D-03, D-04, D-05 |

**The live half deliberately does not run per-PR.** Dependabot alerts are computed for the
*repository*, not for a branch, so a pull request's own diff cannot move them — running it there
would re-report repository state as though it were a property of the change. It would also fail on
every fork and Dependabot PR, where `GITHUB_TOKEN` is not granted that permission.

Expiry is enforced in the **offline** half on purpose, so an acceptance rotting past its date fails
a pull request rather than waiting for the nightly job.

`vulnerability-alerts: read` is the only permission that lets `GITHUB_TOKEN` list Dependabot alerts
— `security-events` covers code scanning, which is a different API. No PAT is required.

## The rules

| rule | half | fails when |
|---|---|---|
| **D-01** | offline | the policy is malformed: bad threshold, or an acceptance missing a GHSA id, package, reason, issue or expiry; duplicates |
| **D-02** | offline | an acceptance has expired |
| **D-03** | live | an open alert at or above the threshold has no unexpired acceptance |
| **D-04** | live | an acceptance no longer matches any open alert |
| **D-05** | live | the alert list could not be read |
| **D-06** | offline | `dependency-alerts.yml` is missing, lacks `vulnerability-alerts: read`, never runs `--live`, or uses `continue-on-error` |

## D-05: unreadable is a failure, never a pass

Same rule the estate reads follow (spec 071) and the FinOps catalogue follows (spec 089): a value
exists only when it was read. A gate that goes green when it cannot see also reports success when it
is broken, which is strictly worse than having no gate — you get the silence *and* the reassurance.

`check-ci-gating` makes the sibling point about skipped jobs: "passed" and "never ran" must not look
alike. The live workflow always writes a line to the run summary saying which happened.

## Dismissals are the other half

`npm run dismiss:alerts` (issue #1520). Source: `scripts/security/dismiss-alerts.js`, plan:
`scripts/security/dismissals.json`.

An **acceptance** says "this risk is real and we are carrying it until a date". A **dismissal** says
"this alert describes code this repository does not contain". They are different claims and they
live in different places: the acceptance in the policy file, the dismissal on the alert, where the
next reader meets it without having to find this document first.

Twelve of the original forty-five were the second kind. They name `@openzeppelin/contracts` and
`@openzeppelin/contracts-upgradeable`, and every one of them tops out below 4.9.6 — the pin here is
5.4.0, outside every range. What they match is a nested 4.7.3 copy that arrives through
`@chainlink/contracts` → `@arbitrum/nitro-contracts`, which solc never opens, so no FairWins
bytecode contains it. Nothing we can bump clears them either: `@chainlink/contracts` is exact-pinned under spec 075 because it
contributes Solidity source, and OZ is held at 5.4.0 deliberately (5.5+ emits `mcopy`, which fails
at `evmVersion: paris`).

### Why a plan file instead of twelve clicks

Twelve hand-typed paragraphs are twelve slightly different paragraphs — but that is the small
reason. The real one is that a dismissal records a conclusion and not the **criteria** that reached
it. Clicking leaves no answer to "why those twelve and not a thirteenth". The plan is that answer,
and it is reviewed in a pull request before it is ever executed.

### Selection is by proof, never by alert number

An alert is eligible only when the advisory's vulnerable range **excludes** the version this
repository compiles against. Alert numbers would encode nothing and go stale; a range test
re-derives the argument on every run, so bumping the pin *into* a vulnerable range makes the alerts
stop matching instead of being dismissed anyway.

**An unparseable range counts as including the version.** Not being able to prove code is
unreachable is not the same as proving it is — the same rule as D-05 above, one level down.

| rule | fails when |
|---|---|
| **X-01** | the plan is malformed: no `id`, `issue`, `expectedCount`, or `match`; an invented `dismissedReason`; a `comment` under 40 characters or over the API's 280 |
| **X-02** | `match.compiledVersion` disagrees with the pin in `package.json`, or the package is gone |
| **X-03** | an advisory range includes the compiled version — that alert is about code we do compile |
| **X-04** | the alert is runtime-scope (an unknown scope counts as runtime), or above the reviewed `maxSeverity` |
| **X-05** | the live selection is a different size than the reviewed `expectedCount` |
| **X-06** | the alert list could not be read |
| **X-07** | on `--apply`: the plan in hand is not the one merged on `staging`, or that could not be confirmed |
| **X-08** | on `--apply`: the token is known not to carry `security_events`, or a write failed part-way |

X-02 is the one that matters over time. `compiledVersion` is an assertion about this repository, and
the day someone bumps OpenZeppelin it stops being true; unchecked, the plan would keep dismissing
alerts with an argument that no longer holds.

### Why the code is unreachable — and why the first version of this was wrong

The first draft of this argument said nitro-contracts is **"reachable only from `automation/**`"**,
and the fixtures encoded the same claim: *no `.sol` may import chainlink `automation/**`*. It is
false. 16 files in `@chainlink/contracts@1.5.0` import nitro and **11 are outside `automation/`** —
among them `shared/util/ChainSpecificUtil.sol` and three under `functions/`, which are the two
directories this repo *does* import from. The assertion passed while proving nothing, and would have
kept passing if a contract started importing `shared/util/`. Worse, a future reader grepping for
nitro under `shared/` would have found a hit and concluded the whole dismissal was wrong.

It was caught by a reviewing agent before any alert carried the text — which is the argument for
writing the reasoning down in a reviewable file rather than typing it into twelve dismissal boxes.

The correct argument never mentions a directory, because **solc reads a closure, not a directory**.
Start at the chainlink files `contracts/` imports and follow every import:

| | |
|---|---|
| roots | 4 (`functions/v1_0_0/**` ×2, `shared/access/ConfirmedOwner.sol`, `shared/interfaces/AggregatorV3Interface.sol`) |
| closure | 11 files |
| non-relative imports anywhere in it | **none** |

A closure with no non-relative imports cannot name a package at all, so it reaches neither
OpenZeppelin nor nitro — whatever else `@chainlink/contracts` happens to contain. That holds where
the directory claim did not.

`npm run check:chainlink-closure` re-derives it. The roots are in this repo, so the fixtures pin
them on every run; the closure is a property of an installed package, so it is checked when the
package is present and reported **UNVERIFIED** (never "clean") when it is not.

X-05 is consent. A set that grew is a set nobody looked at, so the run refuses rather than
dismissing the extras under a paragraph written about something else.

### X-07: only a reviewed plan may be applied

"The criteria are reviewed before they are ever executed" was the premise of this whole design, and
for its first day it was a sentence in a comment rather than anything enforced. Two ways to break
it, and a reviewing agent hit both within hours:

- **Stale.** The correction above lived in an open pull request while `staging` still carried the
  retracted wording. The instruction of the moment — *pull staging first, then apply* — would have
  stamped the **retracted** text onto twelve alerts.
- **Unreviewed.** Nothing stopped anyone editing `dismissals.json` locally and applying it.

Both are the same bug: executing a plan nobody merged. So `--apply` now fetches
`scripts/security/dismissals.json` from `staging` and refuses unless the entry in hand matches it on
`comment`, `dismissedReason`, `expectedCount` and `match`. An unreadable review branch refuses too —
not being able to confirm a plan was reviewed is not the same as it having been.

**There is deliberately no override flag.** An override is how a gate becomes decoration, and the
legitimate path is three steps: merge the plan, pull, re-run the dry run, then apply.

### X-08: a green dry run is not a working credential

From the first real apply: **a token carrying `repo` but not `security_events` reads the alert list
perfectly well and 403s only on the PATCH.** Reading needs `repo`; dismissing needs
`security_events`. So the dry run goes green, prints a clean selection, and the scope gap surfaces
only at the write — where a green dry run naturally reads as "the credential is good".

On its own that is an annoyance. What made it worth a gate is the state a *late* failure leaves:
the apply loop had no error handling, so a 403 on the seventh alert would leave **six permanently
dismissed** and throw. The next run then sees 6 open against an `expectedCount` of 12 — X-05 fires,
and the tool refuses to finish the job it half did, leaving the operator between an unfinished
dismissal and editing a reviewed plan. That was survived only because the failing token happened to
fail on the *first* write.

Two changes:

- **Pre-flight.** GitHub advertises a classic PAT's scopes on every response (`x-oauth-scopes`), so
  the gap is knowable before any write. Fine-grained and app tokens send no such header, and that is
  reported as **unknown** rather than guessed in either direction.
- **A partial apply is now legible.** The loop stops at the first failure instead of hammering, and
  says exactly which alerts were dismissed, that they are permanent, and that `expectedCount` will
  now legitimately need correcting — once, in a merged change.

This matters more here than in most gates because of an asymmetry: a `dismissed_comment` is what the
next reader meets on the alert, and **no later pull request can correct it**. A wrong file is a
nuisance; a wrong dismissal is permanent.

### It cannot run in CI

Dismissing needs write access to Dependabot alerts, and there is no `vulnerability-alerts: write`
for `GITHUB_TOKEN` — Actions offers the read half and that is all, which is why
`dependency-alerts.yml` only reconciles. This runs from an operator's workstation under a token with
the `security_events` scope (fine-grained: *Dependabot alerts: write*), the class of credential
spec 097 keeps in Secret Manager rather than a `.env`. **Dry run is the default**; `--apply` writes.

## Things that will bite you

- **The alerts endpoint has no `page` parameter.** It answers
  `400 Pagination using the `page` parameter is not supported.` and pages by cursor through the
  `Link` header. The first implementation used `?page=N`, passed every stubbed unit test, and failed
  on the first real call. There is now a regression test asserting on the URL actually built, but
  the general lesson stands: run `--live` before believing the fixtures.
- **Adding an acceptance is a decision, not a formality.** It is the one edit that makes the gate
  quieter. Reviews should read the `reason`, not just the diff stat.
- **Do not raise the threshold to get green.** Widening `failOn` downward is fine; narrowing it is
  how a gate stops meaning anything. If a class of alert genuinely should not block, say so in the
  policy's `$comment` where the next reader will find it.

## Running it

```bash
npm run check:dep-alerts          # offline: schema, expiry, wiring
npm run test:dep-alerts           # the gate's own must-fail fixtures

GITHUB_REPOSITORY=chippr-robotics/fairwins-platform \
GITHUB_TOKEN=$(gh auth token) \
npm run check:dep-alerts:live     # live reconciliation
```

Dismissals, with a token carrying `security_events`:

```bash
GITHUB_REPOSITORY=chippr-robotics/fairwins-platform \
GITHUB_TOKEN=$SECURITY_EVENTS_TOKEN \
npm run dismiss:alerts                      # dry run — prints the selection and every near miss

GITHUB_REPOSITORY=chippr-robotics/fairwins-platform \
GITHUB_TOKEN=$SECURITY_EVENTS_TOKEN \
npm run dismiss:alerts -- --apply
```

**Order matters, and X-07 enforces it.** If the plan has been changed, that change must be *merged*
to `staging` first — applying from a checkout that predates it stamps the old wording permanently.

Read the dry run before applying. The near-miss lines are the interesting part: an alert that
*almost* matched is either a thirteenth case worth understanding or a bug in the criteria.
