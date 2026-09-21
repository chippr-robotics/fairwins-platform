# Runbook: release and promotion

Operating the release train. Spec 076. For the *why*, see
`docs/developer-guide/versioning-and-releases.md`.

---

## One-time setup

These are the operational steps that cannot be made by a pull request. Until each is done, the
corresponding automation is inert — and inert automation looks like working automation, so check
them off explicitly.

### 1. Create and protect `staging` (FR-016, FR-017)

```bash
git fetch origin main
git checkout -B staging origin/main
git push -u origin staging
```

Then protect it to the same standard as `main`: required status checks, no force-push, no deletion.

Until this exists, `branch-policy.yml`'s drift job logs a warning and does nothing — deliberately,
since the alternative is a daily failing job about a branch that does not exist yet.

### 2. Register the required status checks (FR-010, T031)

In branch protection for **both** `main` and `staging`, mark as required:

- `Change classification` (from `version-gate.yml`)
- `Mini-app version pairing` (from `version-gate.yml`)
- `PRs into main come from staging or a hotfix` (from `branch-policy.yml`, `main` only)
- `staging must mirror production` (from `branch-policy.yml`, `main` only)

**A gate that is not required is not a gate.** The workflow files exist and will run and fail
correctly, but GitHub will happily let a red check merge until it is marked required.

### 3. Nothing to do — the release record arrives as a pull request

> The promotion rule admits `release/*-changelog` alongside `staging` and `hotfix/*` for exactly
> this reason. Without that arm, turning the rule on makes the release record unmergeable and the
> in-repo record drifts behind the tags — which is how `CHANGELOG.md` ended up ten versions behind
> and `v1.2.4`'s entry was lost. The contradiction is invisible until `staging` exists, because the
> job is inert before then.

`release.yml` pushes the TAG directly (tags are not covered by the branch ruleset) and then opens a
**pull request** for the generated `CHANGELOG.md` and manifest version bumps.

It used to push that commit straight to `main`, and once branch protection arrived that failed on
every release:

```
remote: error: GH013: Repository rule violations found for refs/heads/main.
- Changes must be made through a pull request.
- 2 of 2 required status checks are expected.
```

A ruleset bypass for the bot was the alternative. Opening a PR was chosen instead, so the protection
on the branch that deploys to members stays intact with no exception. **The cost is a small
`chore(release): vX.Y.Z` PR after each release — review and merge it; there is nothing to edit.**

> **⚠️ MERGE THE RECORD PR WITH GITHUB'S DEFAULT COMMIT MESSAGE. Do not retitle it.**
>
> The `[skip release]` marker lives in the record *branch* commit, and `release.yml` reads
> `github.event.head_commit.message` — the **merge** commit, one level above it. So the marker is
> invisible at that point, and the only thing stopping the train from releasing its own paperwork
> is that GitHub's default subject (`Merge pull request #N from …/release/vX.Y.Z-changelog`) **fails
> to classify** and therefore votes for no bump.
>
> Retitling the merge to a conventional commit re-arms the loop. `chore(release): v1.15.1 (#1391)`
> parses as `chore(release)` → **patch**, which is how **v1.15.2 was cut from the merge of the
> v1.15.1 record** on 2026-08-31 — a release containing nothing but the previous release's
> paperwork. Same failure as `v1.5.6`/`v1.5.7`. Verify before merging:
>
> ```bash
> # Must FAIL to classify. If it succeeds, the merge will mint a version.
> node scripts/release/classify.js --title "<the merge subject you are about to use>"
> ```
>
> If you must set a subject, also put `[skip release]` in the merge commit **body** — that
> short-circuits the whole workflow at its top-level `if`, rather than relying on classification
> failing. Belt and braces; the body is the only lever that works from the merge commit.
>
> Tags are immutable (FR-004), so a version minted this way **cannot be withdrawn**. Merge its
> record PR too: leaving it out makes `git describe` disagree with every manifest, which breaks the
> version gate's backfill exemption on every subsequent back-merge.

### 4. Provision the two staging services (FR-023, FR-026c, T035)

Both are Cloud Run services in the same project as production. See
`specs/076-monorepo-semantic-versioning/contracts/environments.md` for the full matrix.

| Service | Cohort | Host |
| --- | --- | --- |
| `prediction-dao-research-staging` | mainnet (137) | `staging.fairwins.app` |
| `prediction-dao-research-staging-testnet` | testnet (80002) | `staging-testnet.fairwins.app` |

**Each needs its own** — not production's:

- relayer gas wallet, separately funded and sized for testing
- paymaster EntryPoint deposit
- origin-lock secret
- RPC keys and API credentials

**Neither gets an admin or deployer key.**

This matters because the mainnet staging service reaches the live Polygon estate. Sharing a funded
account with production means a staging defect can drain or rate-limit something members depend on.
FR-026c is not advice.

Also set both to `noindex`.

### 5. Point a Cloud Build trigger at the `staging` branch

**A Cloud Build trigger builds and deploys staging. CI does not.** The `Staging Candidate`
workflow tags `vX.Y.Z-rc.N` and stops there — it used to submit `cloudbuild.staging.yaml` and never
worked in a single run, because the grant it assumed was never made.

```bash
gcloud builds triggers create github \
  --name=staging-branch-build \
  --repo-owner=chippr-robotics \
  --repo-name=fairwins-platform \
  --branch-pattern='^staging$' \
  --build-config=cloudbuild.staging.yaml \
  --description='Build + deploy both staging services on every push to staging'
```

The trigger's service account needs `roles/artifactregistry.writer` (push both images),
`roles/run.admin` (deploy both services) and `roles/iam.serviceAccountUser` (act as each service's
runtime identity). A trigger that can build but not deploy leaves the previous revision serving and
reports success on the build — the exact shape of failure that hides a stale service.

`_RC_VERSION` defaults to empty, so a branch-triggered build self-describes as `unreleased+<sha>`
in the drawer rather than a candidate number. **That is correct and deliberate** (FR-031): the
branch push does not know which candidate tag the workflow is about to mint, and a guessed tag is
worse than an honest sha.

> **Do not use Cloud Run's built-in "deploy from a repository" for this.** It builds the root
> `Dockerfile` with no `--build-arg`, and every `VITE_*` in that image is then undefined: no
> relayer URL (gasless silently degrades to self-submit), no subgraph URL, no version identity, no
> `VITE_NETWORK_ID` — the cohort the whole two-service design exists to fix. Staging was in exactly
> that state on 2026-08-11: a service that was up, looked fine, and mirrored production in nothing.
> The build args are the point, and only `cloudbuild.staging.yaml` carries them. Verify with the
> fingerprint check in "Staging is serving an old build" below.

Production is the same shape — a trigger on `main` running `cloudbuild.yaml`.

**A trigger must not carry `_VITE_*` substitutions.** The wizard writes a set of them when it
creates a trigger, and they survive being repointed at a build config that does not read them. The
production trigger carried `_VITE_NETWORK_ID: '80002'` and a `fairwins-amoy` subgraph URL that way —
inert, because `cloudbuild.yaml` hardcodes its build args, and a loaded gun for exactly as long as
that stays true. The day someone parameterises one of those args, production builds as Amoy. They
were removed on 2026-08-11; if a trigger is ever recreated through the console, check for them:

```bash
gcloud builds triggers describe <trigger> --format='value(substitutions)'
```

Build configuration belongs in the build config, where it is reviewed in a pull request. The only
substitution either file reads is its release identity (`_APP_VERSION` / `_RC_VERSION`), both
declared with empty defaults in the file itself.

---

## Daily operation

### Merging work

Feature branch → `staging`, squash-merged, PR titled `type(scope): subject`.

Every merge into `staging` tags a candidate (`vX.Y.Z-rc.N`) and deploys both staging services.

### Promoting to production

1. Open a pull request `staging` → `main`.
2. Confirm the checks pass — including **staging must mirror production**, which fails if the two
   configurations differ anywhere unenumerated.
3. **Merge with a merge commit. Not a squash.** The workflow prints this as a notice on every
   promotion PR. Squashing collapses every PR title into one subject, and the release version is
   computed from those subjects — a release containing a `feat` would ship as a patch.
4. `release.yml` tags, publishes the GitHub Release, then opens a `chore(release): vX.Y.Z` pull
   request carrying the generated `CHANGELOG.md` entry and manifest version bumps. Merge it.

### Hotfixes

```bash
git checkout -b hotfix/<what> origin/main
# fix, PR into main, merge
```

Then **back-merge**, or the next promotion reverts it:

```bash
git checkout staging && git merge origin/main && git push
```

`branch-policy.yml` opens an issue labelled `release-drift` when `main` holds commits `staging`
lacks, and closes it when the drift clears. Do not close it by hand — closing it without merging
just removes the reminder.

### Back-merging (`main` → `staging`)

Two flows exist and they are not interchangeable:

| | Direction | What it carries |
|---|---|---|
| **Promotion** | `staging` → `main` | product changes reaching production |
| **Back-merge** | `main` → `staging` | release records and hotfixes returning |

**Release records are born on `main`** — the release workflow tags, then opens a
`release/*-changelog` PR against `main` — so a back-merge is the only route by which they reach
`staging`. A hotfix is the same by definition.

It is now automated: when `branch-policy.yml` detects drift it *also* points
`chore/auto-backmerge-main-into-staging` at `main`'s tip and opens a PR into `staging`. Review and
merge it; there is nothing to edit. Filing an issue alone was not enough — the drift only hurts
later, on somebody else's pull request, and the first one sat open for three days and cost PR #1195
a rebase.

**Merge it with a merge commit, never a squash.** A squash copies the content but not the ancestry:
`git log staging..main` stays non-empty, the drift issue reopens on the next run, and the problem
looks fixed while persisting.

Verify afterwards — this is what distinguishes a merge from a squash:

```bash
git fetch origin main staging
git log --oneline origin/staging..origin/main   # must print NOTHING
```

Left unmerged, drift does not lose work, but it does two things: every PR into `staging` that
touches a manifest trips the version gate for bumps its author never made, and `staging` reports an
older version than the code it is running, so a bug found there cannot be traced to a release.

---

## When something goes wrong

### Reproducing a release problem locally — check your clone depth FIRST

```bash
git rev-parse --is-shallow-repository   # must print false
git rev-list --count HEAD               # compare against the count CI reports
```

**A shallow clone will make release bugs invisible and, worse, produce wrong output that looks
right.** This has already cost real time twice:

- The v1.0.0 investigation. The pipeline was reading a ~5.6 MB commit log in CI and blowing Node's
  1 MiB `execFileSync` default. Locally the same command produced 430 KB and worked perfectly,
  because the clone held 193 of 2508 commits. The measurement was right and the conclusion was
  wrong.
- Anything that generates a changelog. `changelog.js` walks the whole range, so running it against
  a shallow clone silently emits an entry missing most of the release.

`actions/checkout` in `release.yml` uses `fetch-depth: 0` for exactly this reason. Match it locally
before drawing conclusions:

```bash
git fetch --unshallow    # or: git clone (without --depth) into a scratch directory
```

### The release published nothing

Expected in three cases: an empty commit range, a range holding nothing but the generated release
record, or no commit in the range carrying a classification.

```bash
node scripts/release/version.js --explain
```

prints every commit, how it classified, and which one set the bump. Two kinds of commit do not vote:

- `[unclassified]` — merge commits and anything predating the convention.
- `[skipped]` — carries `[skip release]`, i.e. the release process's own paperwork.

The three silences are reported as distinct reasons (`empty-range`, `only-skipped-commits`,
`no-classified-commits`) because they mean different things. `only-skipped-commits` is the system
working. `no-classified-commits` means nobody has established what the range contains.

### The version keeps incrementing but nothing new ships

Look at what the tags are actually sitting on:

```bash
git tag --list 'v*' | sort -V | tail -5 | while read t; do
  echo "$t  $(git log -1 --format='%s' "$t^{commit}")"
done
```

If a tag's commit is a merge of a `release/vX.Y.Z-changelog` branch, the release train is releasing
its own paperwork rather than any product change, and the fix is in
`scripts/release/classify.js#carriesSkipMarker` — see contracts/version-scheme.md §2. This happened
for `v1.5.6` and `v1.5.7`.

**It happened again on 2026-08-31 (`v1.15.2`), by a different route, and the difference matters.**
`carriesSkipMarker` was working: the record commit did not vote. What voted was the **merge commit's
own subject**, hand-written as `chore(release): v1.15.1 (#1391)` instead of left as GitHub's default.
`version.js` runs `git log --format=%s…` over the range with no `--no-merges`, so merge commits are
classified like any other, and a conventional-commit merge subject is a vote.

So there are two independent ways in, and only one of them is fixed in code:

| Route | Voter | Guarded by |
| --- | --- | --- |
| The record commit itself | `chore(release): vX.Y.Z [skip release]` | `carriesSkipMarker` ✅ |
| The **merge** of the record PR | the merge subject | nothing but the default subject not parsing ⚠️ |

The second is a convention, not a gate. Before merging any `release/*-changelog` PR, run
`classify.js --title` on the subject you intend to use and confirm it **fails**; or put
`[skip release]` in the merge body. A mechanical fix would be to have the version gate reject a
classifiable merge subject on a `release/*` head — that does not exist yet.

The second thing to check is whether the version is the *only* thing that moved:

```bash
git log --oneline origin/main..origin/staging | wc -l   # work merged but never promoted
```

`branch-policy.yml` opens a `release-drift` issue when `main` holds commits `staging` lacks. It does
**not** watch the other direction, so work sitting unpromoted on `staging` raises nothing on its own.
A non-zero count here with no open promotion PR means production is running without it. Promote it —
see "Promoting to production" above.

### The tag already exists

`release.yml` fails hard and does not force-update. This means a release already claimed that
version. **Investigate before doing anything** — do not delete or move the tag. Published tags are
the only durable record of what shipped (FR-004). The usual cause is a re-run of a completed
release; if so, nothing is wrong and no action is needed.

### The release tagged and published, but the CHANGELOG commit failed

The tag and the GitHub Release are already correct and immutable — do not re-run the release to
"fix" the changelog. Re-running hits the tag-immutability guard (FR-004) and fails, which is the
intended behavior.

What is missing is only the in-repo `CHANGELOG.md` entry and the manifest version sync. Backfill it
by hand, **from a full clone** (see the clone-depth warning above — a shallow one writes an entry
missing most of the release):

```bash
git fetch --unshallow                      # MANDATORY — see the clone-depth warning above
node scripts/release/changelog.js --version vX.Y.Z --previous vX.Y.W
node scripts/release/sync-manifest-versions.js --version vX.Y.Z
```

For several missed releases, run `changelog.js` once per tag **oldest first** (each call prepends,
so the newest ends on top), then sync the manifests once to the newest tag.

Then open a pull request with the result. Use a **`release/*` branch** if you can — the version gate
exempts that branch outright. On any other branch the gate still passes provided the PR also updates
`CHANGELOG.md` and every manifest version equals the newest tag, which is exactly what a release
record looks like; an arbitrary version number still fails.

This is the one case where a generated file is committed outside the release job, and it is still
generated — never hand-written (FR-037).

### A promotion is blocked by config drift

The check names the offending build arg. Two possibilities:

- **The difference is a mistake** — fix the config so staging matches production.
- **The difference is intended** — add it to the enumerated list in `contracts/environments.md`
  *and* to `ENUMERATED` in `scripts/release/check-promotion-config.js`, in a reviewed PR. Widening
  the list is a decision about how faithful staging is; it should not be made while unblocking a
  release.

### A promotion is blocked because the cohort boundary moved

Staging reaches both cohorts by being two services, never by changing how a build resolves its
cohort (FR-026b). The gate names exactly what moved — a chain-id constant, one of the resolver
functions (`buildIsTestnet`, `cohortChainIds`, `membershipChainId`, `miniAppChainId`, `isInCohort`,
`listSupportedChainIds`, `getCurrentChainId`), a network's `isTestnet` flag, or a chain entering or
leaving `NETWORKS`. Split that change into its own pull request where it gets reviewed as what it
is: a change to the testnet/mainnet boundary, a constitution III concern.

**It no longer fires on ordinary edits to `networks.js`.** It used to fail on ANY change to the
file, and that proxy was too coarse: the file changed 36 times in 90 days — tickers, RPC failovers,
explorer links — and each one blocked a release it had nothing to do with. The documented remedy
(land the file on `main` in its own PR first) only works for a file that changes rarely; for this
one it became a treadmill, and on 2026-08-29 the file changed again *mid-remedy*, twice in six
hours. A guard that cries wolf on ordinary configuration gets worked around, and a worked-around
guard protects nothing.

If the gate reports it **could not locate the cohort machinery**, that is a refusal, not a pass —
somebody restructured `networks.js` and `COHORT_CONSTANTS`/`COHORT_FUNCTIONS` in
`scripts/release/check-promotion-config.js` need to follow. It fails closed on purpose: a guard that
cannot read the file must never report a safety it did not establish.

### An environment reports `unreleased+<sha>`

Accurate, not broken. That build was not made from a published release — a manual trigger, a rebuild
of an untagged commit, or an out-of-band deploy. Two of this estate's services are deliberately
deployed out of band (the multi-container relay gateway and the alto bundler), so they will often
read this way.

If **production** reads it after a normal release, the Cloud Build trigger fired before the release
workflow tagged. The next release fixes it; nothing is broken.

### Staging is down but production is fine

Staging failing does not block production — but a promotion should not proceed on a candidate nobody
exercised. Fix staging first. Bypassing it is the thing this feature exists to stop.

### Staging is serving an old build

A staging host that is *up* and serving a tree from days ago looks exactly like a working staging
service until someone goes looking for a change that should be there. Settle it from the bytes it is
actually serving rather than from a workflow run:

```bash
BASE=https://<staging-host>
ENTRY=$(curl -s "$BASE/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
curl -s "$BASE$ENTRY" > /tmp/deployed.js

# A string the change ADDED, and one it REMOVED. Both answers matter:
grep -c "New statement"    /tmp/deployed.js   # expect 1 once deployed
grep -c "Reporting period" /tmp/deployed.js   # expect 0 once deployed
```

A string the repository no longer contains anywhere, still present in the deployed bundle, is proof
the service has not rebuilt — not a routing or caching question, and nothing a hard refresh fixes.

**Then check it was built with its build args at all**, which is a different failure and a worse
one. Vite folds `VITE_*` into the bundle, so the args a build received are readable from the bytes:

```bash
for s in relay-staging.fairwins.app staging.fairwins.app fairwins-polygon; do
  printf '%-32s %s\n' "$s" "$(grep -c "$s" /tmp/deployed.js)"
done
```

All zeros means the image was built with **no** `--build-arg` — not stale config, *absent* config.
Such a build has no relayer, no subgraph, no version identity and no `VITE_NETWORK_ID`, so it is
not a mirror of production in any respect, and the app degrades quietly rather than failing. Fix
the trigger's build config (§5); rebuilding from the same source will not help.

Two further reads, both cheap:

- **The drawer footer.** `vX.Y.Z-rc.N` means the build carried a candidate identity;
  `unreleased+<sha>` names the exact commit; a bare `unreleased` means the build got no
  `VITE_APP_VERSION`/`VITE_GIT_SHA` at all, which tells you the builder is not passing them.
- **Compare chunk hashes with production.** Identical `vendor-*.js` and `index-*.css` with a
  different `contracts-*.js` says "same source tree, different build-time config" — i.e. staging is
  configured correctly and is simply stale, rather than pointed at the wrong branch.

Then go to the service's own build configuration. CI does not deploy staging (see §4).

---

## Emergencies

**Production is broken and staging cannot be used.** Use a `hotfix/*` branch. That is what it is for,
CI allows it, and the release record will say `Promoted from: none (hotfix)` so the shortcut is on
the record rather than hidden. Back-merge afterwards.

**The version gate is blocking an urgent fix.** Retitle the PR. It takes seconds and the check
re-runs on `edited`. Do not disable the gate — constitution IV forbids making it advisory, and an
urgent fix is exactly when a mis-classified release is most expensive.
