# ADR-006: Dependency version policy — how a version is chosen, held, watched and bumped

**Status**: Accepted

**Date**: 2026-10-09

**Authors**: FairWins engineering

**Deciders**: realcodywburns

**Technical Story**: #1648 (OZ Relayer held at v1.4.0 with no recorded reason)

## Context

Every component FairWins runs is open source, so a newer version is always *observable*. Before this
ADR, observation was only automated for half of the supply chain:

- **Covered.** npm (one root lockfile, spec 075) and GitHub Actions had Dependabot. Vulnerability
  alerts had a gate (#1521). Solidity sources and the compiler had documented exact pins with
  byte-diff gates.
- **Not covered.** Everything *outside* the lockfile had no upgrade signal at all: container base
  images, compose `image:` tags, the engine images we build from upstream git tags (OZ Relayer, alto),
  Terraform core and providers, and the native toolchain (Java, Xcode, Gradle/AGP, SDK levels). A pin
  there was a decision made once and never revisited.

#1648 is that failure in miniature. The relay engine was pinned at OZ Relayer **v1.4.0** on
2026-07-05, the day of the as-built deploy. v1.5.0 was **already two months old** on that day. No ADR,
README or comment recorded why 1.4.0 was chosen. When a report arrived that the engine was outdated,
nobody could say whether the pin was a decision or an accident.

The re-evaluation then showed that "outdated" and "should bump" are different claims. 1.5–1.7
fix nonce-gap and cancel-tracking bugs, but 1.5.0 introduced a receipt regression (upstream #817). That
regression would hit our multi-endpoint RPC failover. One open bug (#808) affects us *at any
version*. The correct answer was **hold, mitigate, and watch named upstream issues**. Before this ADR,
that answer had nowhere to live, and nothing would ever have brought it back up.

## Decision

We will treat every third-party version as an explicit, recorded, *expiring* decision. There are four
parts.

### 1. Selection — what a pin must look like

- **Exact versions only in shipped paths.** A container image is `name:X.Y.Z` (or `@sha256:` digest).
  It is never `latest`, never a bare major (`node:22`, `redis:7`), and never `stable`. A floating tag
  has two failures. It is not reproducible: two builds of the same commit can differ. And it gives no
  upgrade signal: the version moves under you, so nothing ever tells you it moved.
- **Prefer the newest stable release that is not inside its first patch window.** For a new
  dependency, take the latest stable release that has at least one patch release or ~2 weeks of
  public use. Choosing an older version needs a written reason.
- **Prefer supported lines.** A runtime that reaches upstream end-of-life (endoflife.date is the
  reference) is a bump, not a preference. Plan the migration ≥ 90 days before EOL.
- **Pins that change deployed bytes or value paths are their own class.** Solidity sources, `solc`, the
  hardhat toolchain, the upgrades plugin, the relay engine and the bundler change bytecode or move value.
  They are never bundled into a routine sweep. Each one ships alone, with its gate (byte-diff,
  storage-layout) or a soak on a testnet lane.

### 2. Holds — a pin below latest must say why, and must expire

A pin that deliberately trails upstream is a **hold**. Every hold is recorded in
`scripts/deps/version-pins.json` with:

- `reason`: why newer is worse *for us*, at least 30 characters, and naming the mechanism. "Untested"
  is not a reason.
- `ref`: the issue or doc where the evidence lives.
- `watch`: the upstream issues or events whose resolution lifts the hold, where there are any.
- `reviewBy`: a date no more than **180 days** out.

When `reviewBy` passes, the offline gate fails the next pull request. The choice then comes back:
bump, or renew the hold *deliberately* with fresh evidence. This mirrors the time-boxed acceptances
of the vulnerability gate (#1521), for the same reason: a hold with no end date is a decision nobody
will ever revisit. That is exactly how 1.4.0 happened.

Existing documented holds keep their documents, and the registry entry points at them. Examples:
`@openzeppelin/contracts` 5.4.0 for pre-Cancun ETC/Mordor, `solc` exact pin, Hardhat 3 migration
#1053, OZ Relayer 1.4.0 #1648.

### 3. Detection — every pin has a machine watching upstream

| Pin lives in | Detected by |
|---|---|
| npm lockfile | Dependabot `npm` (weekly) |
| workflow `uses:` | Dependabot `github-actions` (weekly) |
| Dockerfile `FROM` / compose `image:` | Dependabot `docker` / `docker-compose` (weekly) |
| Terraform providers | Dependabot `terraform` (weekly) |
| Images we build from an upstream **git tag** (OZ Relayer, alto), toolchain lines in workflows, Ansible collections, the VM Docker engine, anything Dependabot cannot parse | `version-watch.yml` (weekly). It reads `version-pins.json`, asks upstream (git tags / Docker Hub / endoflife.date), and rewrites ONE rolling issue labelled `version-watch` |
| Gradle wrapper / AGP / SDK levels | Not yet watched. They are coupled to the Capacitor template (spec 102), and a bot bump of AGP would fight `sync-native-config`. Tracked as a follow-up |

**Coverage is gated, not hoped for.** `npm run check:version-pins` (offline, every PR) has three
checks:

- It fails if a Dockerfile or compose file introduces an image the registry does not know. A
  watcher that cannot see a pin is not protection; this is the FinOps C2b lesson.
- It fails if a registry entry's `contains` string no longer appears verbatim in its recorded
  file, i.e. the registry has drifted from the files. It matches on strings rather than line
  numbers, so unrelated edits don't trip it.
- It fails on any floating tag.

### 4. Review schedule

| Cadence | What happens | Who |
|---|---|---|
| Weekly | Dependabot PRs triaged. `version-watch` issue refreshed. | Whoever is on rotation |
| Monthly (first week) | Walk the `version-watch` issue. Each item becomes **bump**, **hold** (with a registry entry) or **replace**. EOL-in-90-days items get an issue. | Owner of the affected area (see `.claude/agents/` roster) |
| Quarterly | Review every hold whose `reviewBy` falls in the quarter, plus the bytes/value-path class as a set. | Deciders above |
| On upstream event | A watched upstream issue closes, or a security advisory lands, so re-evaluate that hold now. | Area owner |

### Bump criteria

A version is bumped when **all** of the following hold:

1. The release is stable and outside its first patch window. Security fixes are the exception: a fix
   for an advisory that affects our usage ships immediately.
2. The changelog from our pin to the target has been read for our usage surface. Config schema, defaults,
   storage/state format, and auth all count. Breaking items have a migration step written down.
3. No **open** upstream issue on the target hits a path we actually use. If one does, that is a hold
   reason, and the issue goes in `watch`.
4. The gate that proves the change is named and green: byte-diff, storage-layout, the scoped test
   suite, or a testnet soak for value-path services.
5. The rollback is stated: the previous image is kept in Artifact Registry, and for the relay engine the
   kill switch and self-submit fallback stay in place.

## Rationale

- **Asymmetric costs.** Running behind is quiet: it costs nothing until a known bug or CVE bites.
  Bumping is loud: it takes a PR, a soak, and some risk. Without a forcing function, the quiet option
  always wins. Expiring holds and a rolling watch issue make "stay" an active, re-justified choice
  instead of the default.
- **Same shape as gates that already worked here.** Time-boxed acceptances (#1521), legacy lists
  that must shrink (S-04), and "a gate that cannot see the source is not protection" (C2b) all
  survived because they fail CI rather than ask nicely.
- **Report, don't fail, on "behind".** Being one minor behind is not a defect, and a gate that is red
  every Monday gets bypassed. The live half reports. The offline half fails only on things that are
  wrong *now*: a floating tag, an unknown pin, registry drift, or an expired hold.

## Consequences

### Positive

- Every pin below latest carries its reason, its evidence and its expiry in one file.
- New upstream releases surface within a week for every component, not only npm.
- A floating tag cannot merge.

### Negative

- Dependabot volume rises with the docker/terraform ecosystems. It is mitigated by grouping and by
  `open-pull-requests-limit`.
- Holds need renewing. That is the intent, and it is also work.

### Risks

- **Registry drift.** Someone bumps a Dockerfile but not the registry. The offline gate's drift
  rule (V-03) fails it in the same PR.
- **Upstream unreadable.** The live half records `unreadable` for that entry and names it. It never
  reports "up to date" for a component it could not read. This is the same three-state rule as
  spec 071 / 089.

## Alternatives Considered

### Renovate instead of Dependabot

It covers git-tag-built images and regex-managed pins natively. It would replace most of
`version-watch`.

**Why not chosen:** it is a second bot with its own config language and app install. Dependabot is
already wired into the staging branch policy, the vulnerability gate and the grouping rules. The
residue Dependabot cannot parse is small (about a dozen pins), and a 200-line script over a registry we
need anyway (for holds) covers it. Revisit if the residue grows.

### Auto-bump everything weekly

**Why not chosen:** #1648 is the counterexample. The newest engine introduces a regression that would
affect our RPC topology. Automatic bumps of value-path components would trade a quiet risk for a loud
outage.

## Implementation Notes

- Registry: `scripts/deps/version-pins.json`.
- Offline gate (every PR, `Dependency Hygiene` job): `npm run check:version-pins`. Rule tests (must-fail
  fixtures for V-01…V-06 and the live half): `npm run test:version-pins`.
- Floating-tag exemptions live in the same file, with the same reason/ref/expiry rule as holds.
- Live watch (weekly + dispatch): `.github/workflows/version-watch.yml`, which runs
  `npm run check:version-pins:live`.
- Dependabot: `.github/dependabot.yml` (docker, docker-compose and terraform added; majors ignored, so a runtime line change is a review decision rather than a bot PR).
- Runbook for a stuck relay lane (#808 mitigation): `docs/runbooks/relayer-operations.md#stuck-transactions`.

## References

- #1648: OZ Relayer upgrade evaluation (this ADR's trigger)
- #1521: dependency vulnerability gate (time-boxed acceptance pattern)
- Spec 075: monorepo workspaces, exact pinning of Solidity sources
- Spec 089: FinOps C2b, "a gate that cannot see the source is not protection"
- https://endoflife.date (EOL reference)

## Revision History

| Date | Changes | Author |
|------|---------|--------|
| 2026-10-09 | Initial version | FairWins engineering |
