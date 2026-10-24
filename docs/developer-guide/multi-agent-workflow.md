# Multi-Agent Development Flow

**Issue #1460.** Several agents work this repository at the same time, and the Spec Kit flow was
written for one. Two things broke as a result, and this document is the fix for both:

- **Spec numbers get claimed twice.** `017`, `041`, `050`, `102` and `104` each name two unrelated
  features. Not carelessness: `create-new-feature.sh` answers "what is the next number?" with
  `max(existing) + 1`, which is correct exactly once per merge. Two agents who ask before either
  has merged get the same answer, and *both of them checked*.

  `104` is the one to look at. Both halves of it — `104-passkey-account-recovery` and
  `104-guttertoken-assistant-rail` — were written, implemented and merged to `staging` on
  2026-09-04 and 2026-09-05, i.e. **while the gate below was being written**, and were caught by
  its first CI run. Neither agent did anything wrong. That is the rate at which this happens, and
  it is why the rule is a gate rather than a paragraph.
- **Nobody can see what is being worked.** An issue's state lived in whichever agent's context
  window was working it. A second agent picking up the "next" issue had no way to know the first
  one had started ten minutes earlier.

The protocol below is written for an agent to follow verbatim. Where a rule is enforced by a gate,
the gate is named — the rules that are only prose are the ones that decay, so the load-bearing ones
are not prose.

---

## What an agent can actually write

This is the first thing to get straight, because half the flow is shaped by it.

| Field | Where it lives | Writable by an agent? |
|---|---|---|
| Title, body, open/closed, labels, assignees, milestone | Issue | Yes — `issue_write` |
| **Type** (Task / Bug / Feature) | Issue | Yes — `issue_write` `type` |
| **Priority** (Urgent / High / Medium / Low) | Org-level issue field | Yes — `issue_write` `issue_fields` |
| **Effort** (High / Medium / Low) | Org-level issue field | Yes — `issue_write` `issue_fields` |
| Start date, Target date | Org-level issue field | Yes — `issue_write` `issue_fields` |
| Parent / sub-issue links | Issue hierarchy | Yes — `sub_issue_write`, or `parent_issue_number` on create |
| **Status** (Todo / In progress / …) | **Project item** | **No.** There is no Projects v2 write tool. |

Run `list_issue_fields` before writing a field for the first time — the option names are validated
against the live field, and a wrong one fails the call rather than silently doing nothing.

### The board moves itself; this repo keeps no copy of what it says

Two separate facts, often confused:

- **An agent cannot write Status from here.** The GitHub MCP server exposes no Projects v2 tool at
  all — `issue_write` reaches Type, Priority, Effort and the dates, all of which are org-level
  *issue* fields, while Status lives on the *project item*.
- **The Projects v2 GraphQL API can write it**, and is current and undeprecated:
  `updateProjectV2ItemFieldValue` and `addProjectV2ItemById`, under the `project` scope. What it
  needs is a **classic PAT or a GitHub App installation token** — `GITHUB_TOKEN` cannot do it, and
  fine-grained PATs have a poor record here.

So the board *can* be driven by code. It mostly should not be, because **GitHub already drives it
for free**. Projects ships built-in workflows that need no token, no code and nothing in this
repository: *item closed → Done* and *pull request merged → Done* are **on by default**, and
*item added → Todo*, *item reopened*, and *auto-add matching items* are one toggle each in the
project's own settings.

Those are not the mirror this repo rejected, and the distinction is the whole point. The rejected
design stored a `status:*` label **here** and copied it onto the board: two copies, both ours, both
able to drift — an agent that set `status:in-progress` and then stopped left an issue reading as
actively worked forever, and nothing could notice. GitHub's built-ins store nothing here; they
derive the column from the item's own closed/merged/added state, at the moment it changes.

**What the built-ins do not cover is "In Progress".** Nothing GitHub ships watches for work
starting, so that column is either moved by hand or driven by a small workflow holding a classic
PAT. This repo does neither today, because the two rows below already answer it without a
credential. If the board's In Progress column is wanted badly enough to be worth a PAT, that is a
deliberate decision to take, not a gap to fill quietly.

Either way, **nothing in this repository asserts a status**, so status is still read from state
GitHub tracks exactly once:

| Question | Answered by | Why it cannot drift |
|---|---|---|
| Is anyone working this? | The **assignee** | One field, set by the agent that claimed it |
| Has work started? | A **linked PR** (`Closes #N`) | GitHub links it; the PR exists or it does not |
| Is it done? | The issue is **closed** | Closed from the PR body on merge; verified after |
| What is it part of? | Its **parent / sub-issues** | Real hierarchy, not a naming convention |
| Is it stuck? | The `blocked` label **plus a comment** | The one state nothing else records — see below |

`blocked` is the single exception, and it is not a mirror: an issue can be open, assigned and stuck,
and GitHub has no other representation of that. It is only meaningful next to a comment naming the
blocker, so **never apply it without one** — and remove it when the blocker clears.

The board is a **view of that**, maintained by GitHub's own automations plus whatever a human moves.
It is never authoritative here: if it disagrees with the issue, the issue is right. Do not report a
status you did not put into one of the rows above, and never report having moved a card.

---

## The lifecycle

### 1. Claim the issue before doing anything else

Claiming is what stops two agents starting the same work, and **the assignee is the claim** — one
field, no second copy. In one `issue_write` update:

- **assign yourself** (or the human operator, if you have no bot identity),
- set **Type** if it is unset (`Feature`, `Bug` or `Task`),
- set **Priority** and **Effort** if unset (see the sizing table below),
- add `agent-coordinated`.

Then comment once, saying what you are about to do and on which branch. That comment is how a human
— or the next agent, after your context is gone — reconstructs where the work went.

**If the issue already has an assignee who is not you, stop.** Say so and pick something else.
Overlapping work is more expensive than idle capacity.

**And release the claim if you abandon it**: unassign yourself and say why in a comment. An
assignee is only a useful signal while it is true, and an agent that walks away silently is exactly
the drift that a status label would have made permanent.

### 2. Triage before planning

Read the issue and decide, in this order:

1. **Is it already covered by an existing spec?** `ls specs/` and grep. Re-specifying something that
   exists is the most common wasted day here.
2. **Is it one issue?** Anything `size:xl` is not. Split it into sub-issues *now* (step 6), before a
   number is reserved, because the split usually changes the shape of the spec.
3. **Does it need a spec at all?** Per the constitution: a change touching funds, access control or
   oracle resolution **always** does. A typo fix does not. `size:xs`/`size:s` with no contract,
   money-path or new-surface involvement usually does not.
4. **Is the acceptance criterion testable?** If you cannot say what would prove it done, run
   `/speckit-clarify` or ask in a comment — do not guess and build.

Record the outcome as a comment. Triage that lives only in your context did not happen.

### 3. Branch from `staging`, never from `main`

`main` is the production branch (spec 076); everything on it is deployed. Feature work branches from
`staging` and merges back into it, and only a promotion or a declared hotfix reaches `main` —
`branch-policy.yml` enforces the second half of that.

```bash
git fetch origin staging
git checkout -b <NNN>-<short-slug> origin/staging
```

Name the branch after the reserved spec number when there is one. It is what makes a stray branch
attributable months later, and `create-new-feature.sh` reads the prefix.

### 4. Reserve the number — as its own PR, merged first

**This is the step that fixes duplicate numbering, and it only works if it is done first.**

A spec number is *not* claimed by computing it, by writing it on a branch, or by opening a draft PR.
It is claimed by **merging a reservation PR into `staging`**. Until that merge, another agent asking
the same question will get the same answer and be equally entitled to it.

```bash
# The proposal. Numbers against origin/staging and origin/main, not just your (possibly stale)
# checkout — each agent's container was cloned at a different moment.
.specify/scripts/bash/create-new-feature.sh --dry-run --short-name 'funding pools' 'Funding pools'
```

Then open a PR into `staging` containing the reservation and **nothing else**:

```
specs/<NNN>-<slug>/spec.md                       # skeleton: problem statement and scope
frontend/cypress/coverage/matrix.json            # + a row for <NNN>-<slug>
docs/developer-guide/e2e-coverage-matrix.md      # regenerated: npm run e2e:matrix
```

The last two are not optional extras — `check:e2e-matrix` fails a spec directory with no row, and
the doc is generated and diff-gated. A spec with no member-facing flow carries a **reason** instead
of flows; see the [E2E testing policy](e2e-testing-policy.md). At reservation time the row is
usually a single `planned` flow, or the reason.

Label the PR `spec-reservation`, title it `spec(<NNN>): reserve — <slug>`, and merge it as soon as
CI is green. No implementation, no plan, no tasks. Small on purpose: the collision window is
however long that PR sits open.

Only then do the design work — `/speckit-plan`, `/speckit-tasks` — in the normal feature PR.

**The gate.** `npm run check:specs` (`scripts/specs/check-spec-registry.js`, CI job *Spec Registry*)
fails when two directories claim one number. It also enforces `NNN-kebab-case` naming and that a
reserved number has a `spec.md` — a reservation with no spec is indistinguishable from an abandoned
one. The five pre-gate collisions are frozen in `LEGACY_COLLISIONS` with their own rule (S-04) that
fails if an entry outlives the collision it excuses — so the list shrinks when someone renumbers a
pair, and cannot silently rot. Renumbering is owned by whoever owns those specs, not by this gate.

Adding to that list is not a way to get CI green. Once the gate is on `staging`, S-01 fails before a
second claimant can merge, so a new entry could only describe a collision the gate was never able to
see — which, from that point, is none.

**And the gate has to be able to see the PR.** `specs/**` is now its own change-detection filter in
`ci-manager.yml`. It had none, so a PR touching only `specs/` matched no filter and ran zero jobs —
and with required checks in force, `skipped` *satisfies* them. The one PR type whose entire purpose
is claiming a number was the one type the number gate could never run on.

### 5. Implement through the Spec Kit flow

`/speckit-specify` → `/speckit-clarify` (optional) → `/speckit-plan` → `/speckit-tasks` →
`/speckit-analyze` (optional) → `/speckit-implement`. Every `plan.md` opens with the constitution
check; read `.specify/memory/constitution.md` before planning, not after.

### 6. Sub-issues are how work is delegated and tracked

A task worked by a subagent gets a sub-issue. Not a checkbox in a comment — a sub-issue, because
that is the only representation the project board, the parent issue and the next agent can all see.

Create them with `issue_write` and `parent_issue_number` (one call, created and linked), or link an
existing issue with `sub_issue_write`. Each sub-issue gets, at creation:

- a **Type** (almost always `Task`),
- a **Priority** — inherit the parent's unless the sub-task is genuinely on a different critical path,
- an **Effort** and its `size:*` label,
- **no assignee** — unassigned *is* "available".

Then, for each one:

| Moment | What you do |
|---|---|
| You hand the task to a subagent | **Assign it** (to yourself if the subagent has no identity) |
| The subagent reports back | Nothing yet — **you have not reviewed it** |
| You reviewed and accepted it | Open the PR with `Closes #<sub-issue>` in its body |
| The PR merges | `close-linked-issues.yml` closes it — **read it back and confirm** |
| The subagent is stuck outside the task | `blocked` **+ a comment naming the blocker** |
| You abandon the task | **Unassign**, remove `blocked`, say why |

Every row is either a field with one copy or a link GitHub maintains. There is nothing here to
update "at the end", because there is nothing here that can be stale while the underlying fact has
moved on — which is precisely why a `status:*` label is not in this table.

### 7. Review subagent work before accepting it

A subagent's report is a claim, not a result. Before you mark anything accepted:

- **Read the diff**, not the summary. The summary is what the subagent believes it did.
- **Run the gates it touched.** See the `monorepo-verify` skill for which gate proves what. At
  minimum: the test suite for the surface, plus `check:specs`, `check:storage-layout` (any
  upgradeable contract), `check:deps` (anything touching dependencies).
- **Check for the failure this repo keeps having**: an assertion that cannot fail. A test behind a
  precondition guard that ends in `expect(true).to.be.true` reports as coverage and proves nothing
  (`frontend/src/test/e2e-policy/assertionDepth.test.js`).
- **Verify it did not widen the scope.** A subagent asked to fix a CI failure that also refactored a
  module has done two things, one of which nobody reviewed.

If the work is not right, say what is wrong on the sub-issue and hand it back. Do not silently fix
it yourself — the next identical task will be delegated with the same instructions.

### 8. Close the loop

**`Closes #N` in the PR body is what closes the issue** — but not the way you may expect, and the
difference matters if it ever stops working.

GitHub honours closing keywords only when a PR merges into the repository's **default branch**,
which here is `main`. Every feature PR targets `staging` (step 3), so **GitHub closes nothing on a
feature merge in this repo** — and the later `staging` → `main` promotion does not rescue it either,
because GitHub reads *that* PR's body, which does not name your issue. This was found the only way
it could be: PR #1461 merged with `Closes #1460` in its body and #1460 stayed open, with
`closed_by_pull_requests: 0`.

`.github/workflows/close-linked-issues.yml` restores the behaviour on the branch the work actually
merges into. On a **merged** PR whose base is `staging`, it parses the body and closes what it
names, with a comment saying which PR did it.

- Open the PR into `staging` as **ready for review**, not draft (draft PRs run no CI here).
- Put **`Closes #<issue>`** in the body — one line per issue the PR finishes, including every
  sub-issue. A PR that says "fixes the thing in #123" without the keyword links nothing and closes
  nothing.
- If a PR only *advances* an issue, write **`Part of #123`** and no closing keyword. A closing
  keyword on partial work closes an issue that is not done.
- **After the merge, read the issues back and confirm they closed.** This is not ceremony: the
  automation is a workflow, workflows fail, and the whole point of deriving state from the repo is
  that you can check it. If they are open, close them by hand and say why. A write nobody verified
  is a claim, not a fact.
- If part of the scope was left out, say so in the closing comment and open a follow-up issue for
  it. Scaling the work down is the operator's call, not yours — but silently scaling it down is
  nobody's.
- The board looks after itself here — GitHub's built-in *item closed* / *pull request merged*
  workflows move the card to **Done**. You did not do that; do not claim you did.

### Put the keyword at the start of a line

The parser follows GitHub's rules — the nine keywords, `#123` / `owner/repo#123` / issue URLs, code
spans and fences ignored, cross-repo references dropped — with **one deliberate narrowing: a closing
keyword only counts at the start of a line.** A list marker or bold is fine (`- Closes #12`,
`**Closes** #12`); a keyword mid-sentence is prose and closes nothing.

That narrowing was bought, not designed. On the workflow's **first live run** (PR #1462), the body
explained in prose that the parser does not interpret negation — using the words *"does not fix
#123"* — and the parser extracted `123`. Nothing was harmed only because issue #123 happened to be
closed already and the caller skips those. Had it been open, a documentation change would have
closed an unrelated issue.

GitHub can afford to match anywhere because its UI shows you the linked issues **before** you merge.
Nothing shows you what this workflow will do. And the costs are not symmetric: an issue that fails
to close is visible and one command from fixed, while an issue closed by mistake is silent and looks
like a decision somebody made. So the rule is narrower than the platform's, and statable in one
line.

Negation is still *not* interpreted on an anchored line — `Closes #12` and `Does not close #12` both
close, exactly as GitHub does. Being stricter than the platform about **where** it looks is a
narrower rule; being cleverer than it about **English** is unpredictable behaviour.

The parser also never closes a pull request: `gh issue view` happily resolves a PR number, so the
caller asks the REST issues endpoint and skips anything carrying a `pull_request` key.

Its rules are driven against fixtures it must **refuse**
(`scripts/ci/__tests__/parse-closing-keywords.test.js`), including the exact sentence from #1462
that caused the near-miss.

---

## Skipping the end-to-end tiers

A documentation change used to run the whole Cypress estate: **12 fast legs** (6 shards × 2 viewport
profiles), **4 on-chain shards** at ~20–25 minutes each, and the passkey full stack. That is roughly
two hours of runner time to prove that markdown does not change a pixel.

It is now skipped automatically when the diff cannot reach the running app. Nothing to opt into, no
label to remember, no judgement call: `ci-manager.yml`'s **`app`** path filter decides, and
`test.yml` gates the three Cypress jobs on it.

### Why this is safe, and the one edit that would make it dangerous

**A skipped job SATISFIES a required status check.** That is not a quirk to work around — it is the
hole spec 075 documented, where a PR touching only unfiltered paths merged green having run nothing.
A bypass built carelessly recreates it exactly.

What makes this one safe is the *shape* of the filter. `app` is a **negative list**:

```yaml
app:
  - '**'          # everything…
  - '!**/*.md'    # …minus what provably cannot reach the app
  - '!docs/**'
  - '!specs/**'
  …
```

A path nobody has thought about — a new top-level directory, a new config file — matches `**`, makes
`app` true, and **runs the suite**. The default is to test.

Rewrite it as a positive allowlist (`- 'frontend/**'`, `- 'contracts/**'`, …) and it looks tidier
while behaving as the opposite: every unlisted path skips, silently, and merges green. That edit is
small, plausible, and catastrophic, so it is gated rather than merely commented —
`npm run check:ci-gating` (`scripts/ci/check-ci-gating.js`, in the *Spec Registry* CI job) enforces:

| Rule | What it stops |
|---|---|
| **C-01** | `app` missing, or not starting at `'**'` — i.e. converted to an allowlist |
| **C-02** | a positive entry smuggled in after the negative head |
| **C-03** | `app` not exported, or not passed to `test.yml` as `run_e2e` |
| **C-04** | any Cypress tier losing its `if: inputs.run_e2e` guard |
| **C-05** | `run_e2e` defaulting to anything but `true` — a manual `workflow_dispatch` run, the thing you reach for when you distrust a result, must not quietly test nothing |

Each rule is driven against a workflow pair it must **reject**, including the inverted-allowlist
case, because a guard that enforces nothing prints the same line as one that enforces everything.

### Adding an exclusion

Adding a path to `app`'s exclusion list is a real assertion: *these bytes cannot affect the built
app, the local chain, the gateway, or a Cypress run.* Make it deliberately, and keep the list short —
every entry is a place the suite can stop looking. When in doubt, leave it out: the cost of running
the suite unnecessarily is runner minutes, and the cost of skipping it wrongly is a regression that
merges green.

A skipped tier is also **announced** in the run's change summary, naming what did not run. A skipped
job and a passing job look identical on a PR otherwise, and "the suite passed" and "the suite never
ran" must never be the same sentence.

---

## Sizing and priority

Set both at creation. An unsized backlog cannot be planned, and an agent that skips sizing has moved
the work of estimating onto whoever reads the issue next.

| `size:*` | Meaning | **Effort** field |
|---|---|---|
| `size:xs` | Under an hour. A typo, a constant, a doc line. | Low |
| `size:s` | A few hours, one surface, no spec needed. | Low |
| `size:m` | A day or two, or more than one surface. | Medium |
| `size:l` | Multi-day. Needs a spec and a reserved number. | High |
| `size:xl` | Too big to deliver as one issue — **split it**. | High |

| `Priority` | Meaning |
|---|---|
| `Urgent` | Production is broken, or this blocks other work now. |
| `High` | On the critical path for the current milestone. |
| `Medium` | Planned, not blocking. |
| `Low` | Wanted, unscheduled. |

The issue templates collect both, but a template answer is text in the body — an agent triaging the
issue still has to write them onto the **fields**, which is what the board reads.

---

## Reading an issue's state

There is no status field to read, so read the four facts that are actually recorded:

| You want to know | Look at |
|---|---|
| Is someone on it? | **Assignee.** Empty means available. |
| Has work started? | **Linked PRs**, shown on the issue by GitHub itself. |
| Is it finished? | **Open or closed.** Closed by a merged PR means done and merged. |
| Is it stuck? | The **`blocked`** label, and the comment beside it saying why. |

Each of those has exactly one copy, and three of the four are maintained by GitHub rather than by an
agent remembering to. That is the entire point: a state an agent has to *remember to update* is a
state that is wrong as soon as the agent stops.

Where an issue sits on the project board follows from those facts — GitHub's built-in workflows move
it on close, merge and reopen — but the board is **not authoritative here**. If it disagrees with
the issue, the issue is right.

---

## Rules that hold regardless

- **One agent per issue.** The assignee is the claim. Respect it, and release it if you walk away.
- **One number per spec, claimed by a merge.** Not by a branch, not by a draft PR.
- **Branch from `staging`.** Only promotions and declared hotfixes touch `main`.
- **`Closes #N` closes the issue — via a workflow, not GitHub.** GitHub ignores closing keywords
  outside the default branch, so `close-linked-issues.yml` does it on the `staging` merge. Read the
  issue back afterwards: an automation you never verify is a second thing that can be quietly
  wrong.
- **Never introduce a second copy of a state GitHub already keeps.** It will drift, and a drifted
  record is worse than no record — it is read with the same confidence as a true one.
- **A subagent's report is a claim.** Review the diff and run the gates before accepting.
- **Never close a sub-issue for work you have not seen merged.**
- **Say what you did not do.** A closed issue with unfinished scope and no follow-up is the one
  outcome that costs more than not starting.

---

## Setup

Only one thing, and it is optional:

**Labels** — merge `.github/labels.json` to `main` or `staging`, or run the *Sync Coordination
Labels* workflow manually. `GITHUB_TOKEN` is sufficient; no PAT, no secret, no variable. Applying a
label that does not exist yet works anyway — GitHub creates it, grey and undescribed — so an agent
is never blocked on this; the sync is what gives each label its colour and its description.

**Project board automations** — worth turning on, and free. In the project's own settings
(⋯ → Workflows), no token and no code:

| Built-in workflow | Effect | Default |
|---|---|---|
| *Item closed* | → **Done** | on |
| *Pull request merged* | → **Done** | on |
| *Item reopened* | → back off Done | on |
| *Item added to project* | → **Todo** | off — turn it on |
| *Auto-add to project* | pulls matching new issues/PRs onto the board (`is:issue is:open`) | off — turn it on |

With those, the board tracks itself for everything except **In Progress**, which GitHub ships no
built-in for. Leave it manual, or drive it from a workflow holding a **classic PAT** with the
`project` scope (`GITHUB_TOKEN` cannot write Projects v2, and fine-grained PATs have a poor record
with it). That is a real decision about a real credential — take it deliberately or not at all.

**Nothing else is required**, and that is deliberate. An earlier draft of this feature stored a
`status:*` label *in this repository* and copied it onto the board. That was removed: it is a second
copy of state we already hold, it drifts the moment an agent stops mid-task, and the board then
shows the wrong answer with full confidence. GitHub's built-ins are not that — they store nothing
here and derive the column from the item's own state.

---

## See also

- [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) — the standards every plan checks against
- [Contributing](contributing.md) — branch model, PR process
- [Release and promotion](../runbooks/release-and-promotion.md) — `staging` → `main`
- [E2E testing policy](e2e-testing-policy.md) — why a new spec needs a coverage-matrix row
- `monorepo-verify` skill — which gate proves what, before you accept a subagent's work
