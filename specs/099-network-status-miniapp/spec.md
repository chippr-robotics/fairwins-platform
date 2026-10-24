# Feature Specification: Network Status Mini-App

**Feature Branch**: `claude/release-1-14-0-tasks-av87yu` (spec directory `099-network-status-miniapp`)

**Created**: 2026-08-29

**Status**: Draft

**Input**: User description: "A first-party mini-app presenting an L2Beat-style board of the
networks the platform touches: name, stage/status classification, and an honest 'is this
supported here?' answer per network for this build's cohort. From a network row, members jump
straight into the existing Bridge (Transfer ▸ Bridge) and Supply liquidity (Earn ▸ Supply)
surfaces where those are actually available, with honest degradation everywhere they are not."

## Overview

Members ask a simple question the platform currently answers only by wandering: *which networks
does FairWins actually work on, how mature are they, and what can I do there?* The answer today is
scattered across the network selector, the Bridge tab's route list, the Supply section's pool
list, and tribal knowledge (ETC has no Across; Bitcoin has no contracts at all).

This feature ships **Network Status** — a first-party mini-app in the spec-073 catalog — that
presents one board: every network in this build's cohort, its ecosystem stage/status
classification (in the style of L2Beat's public staging framework), and a per-network,
per-capability support answer sourced from the host at runtime. Where a capability is live, the
row offers a **Bridge** or **Supply liquidity** CTA that deep-links into the existing spec-067
surfaces. Where it is not, the row says so, with the reason — never a dead button, never a
fabricated transaction path.

Two kinds of fact live on this board and must never be conflated:

- **Ecosystem facts** (stage classification, rollup type, general maturity) — curated, static,
  dated data shipped inside the package and revised through the registry's own review lifecycle.
- **Platform facts** (is the Bridge router deployed here? can I supply liquidity here? does this
  build support Bitcoin send/receive?) — read live from the host context at render time,
  resolving to an enumerated state where a failed read is never displayed as an absence.

The app is a **registry-curated package like Token Mint and ClearPath** — served from IPFS,
approved on-chain, mounted through the standard verify-and-launch pipeline, and confined to the
`host` object. It is deliberately **read-only**: it moves no value, signs nothing, and needs no
wallet connection to render; the CTAs hand the member to surfaces that already own their own
transaction honesty.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse the network board and get honest support answers (Priority: P1)

A member launches Network Status from the Apps catalog. They see one row per network in this
build's cohort — Polygon, Ethereum, Optimism, Base, Arbitrum, Ethereum Classic, and Bitcoin on a
mainnet build — each showing the network's name, its stage/status classification with the
dataset's as-of date, and a per-capability support summary (Bridge, Supply liquidity, and for
Bitcoin: portfolio / send / receive). A network where a capability is not offered says why ("no
Across deployment on this network"), and a network whose deployment could not be verified says
*that* — visibly distinct from "not offered".

**Why this priority**: The board is the product. Without honest per-network answers there is
nothing to deep-link from, and a board that renders failed reads as absences would be worse than
no board (constitution III).

**Independent Test**: Launch the app on a mainnet-cohort build with all reads healthy; verify
every cohort network renders with a classification and per-capability states matching the
recorded deployments (Bridge/Supply available on 1/10/137/8453/42161, neither on 61, neither on
Bitcoin). Then degrade one chain's read path and verify its row shows "could not verify", never
"not offered" and never an empty/zero state.

**Acceptance Scenarios**:

1. **Given** a mainnet-cohort build with recorded router deployments on the five EVM mainnets,
   **When** the member opens the board, **Then** each of those five networks shows Bridge and
   Supply as available, and Ethereum Classic shows both as not available with a stated reason.
2. **Given** the Bitcoin row on a build where Bitcoin surfaces are enabled, **When** the board
   renders, **Then** the row shows portfolio/send/receive as its capability class and offers no
   Bridge or Supply CTA anywhere on the row.
3. **Given** a network whose deployment answer cannot be obtained (read failure), **When** the
   board renders, **Then** that network's capability cells show a distinct "could not verify"
   state with the row still present, and no capability renders as available or as absent.
4. **Given** any row, **When** the member inspects the stage/status classification, **Then** the
   classification is labelled as third-party framework data with its as-of date, visually
   distinct from the platform-support facts beside it.
5. **Given** a testnet-cohort build, **When** the member opens the board, **Then** only testnet
   networks render (Amoy, Mordor, Bitcoin Testnet4 where enabled) and no mainnet row or
   mainnet-derived support claim appears.

---

### User Story 2 - Jump from a row into Bridge or Supply (Priority: P1)

From a network row where Bridge is available, the member activates **Bridge** and lands on
Transfer ▸ Bridge; from a row where liquidity supply is available, **Supply liquidity** lands on
Earn ▸ Supply. Where a capability is unavailable on that network — undeployed, unreachable, or
simply not offered — the CTA is disabled with the reason stated inline, and activating nothing
ever produces a broken page or a transaction path that cannot complete.

**Why this priority**: The deep links are what make the board actionable rather than a poster.
They are also the sharpest honesty risk: a CTA that renders where the destination cannot serve
it is a fabricated capability claim.

**Independent Test**: On a mainnet build, activate Bridge from the Polygon row and confirm
arrival at Transfer ▸ Bridge; activate Supply from the Ethereum row and confirm arrival at
Earn ▸ Supply. Confirm the ETC row offers both CTAs only in their disabled, reason-stating form,
and that a row in the "could not verify" state offers no enabled CTA.

**Acceptance Scenarios**:

1. **Given** a row whose Bridge state is available, **When** the member activates Bridge,
   **Then** the host navigates in-app to the Transfer ▸ Bridge surface.
2. **Given** a row whose Supply state is available, **When** the member activates Supply
   liquidity, **Then** the host navigates in-app to the Earn ▸ Supply surface.
3. **Given** a row whose capability state is not-available or could-not-verify, **When** the
   member reads the row, **Then** the corresponding CTA is disabled with the state's reason
   shown, and activation performs no navigation and no transaction preparation.
4. **Given** an arrival at Bridge or Supply via a CTA, **When** that surface's own state is
   degraded (paused routes, disabled pools, unreachable RPC), **Then** the destination surface's
   existing honest behavior governs — the mini-app never pre-claimed a specific route or pool,
   only that the surface is offered on that network.

---

### User Story 3 - Curated stage data stays honest over time (Priority: P2)

The stage/status classifications are a curated static dataset inside the package, displayed with
their as-of date and source attribution. When the ecosystem moves (a rollup advances a stage, a
network is added), the dataset is revised by publishing a new package version through the standard
registry lifecycle — the update lands as a Pending proposed tuple, a curator reviews the dataset
diff along with the rest of the package, and content-committed approval promotes it. A dataset
older than its freshness window renders a prominent staleness notice.

**Why this priority**: Static data is only honest while its age and provenance are on the
surface. This story is what keeps the v1 no-external-fetch decision from decaying into a board of
quietly wrong claims.

**Independent Test**: Verify the board displays the dataset's as-of date and source attribution.
Ship a dataset with an as-of date older than the freshness window and confirm the staleness
notice renders. Publish a dataset revision and confirm it follows the registry's normal
Pending → content-committed-approval path, with the previously approved package serving until
promotion.

**Acceptance Scenarios**:

1. **Given** the board on any build, **When** it renders, **Then** the dataset's as-of date and
   source attribution are visible without further interaction.
2. **Given** a dataset whose as-of date is older than the declared freshness window, **When**
   the board renders, **Then** a prominent staleness disclosure appears and classifications
   remain labelled as dated data, not live status.
3. **Given** a dataset revision, **When** it is published, **Then** it rides the standard
   registry update lifecycle (proposed tuple, Pending, curator approval bound to the reviewed
   manifest hash) and members keep receiving the previously approved package until promotion.
4. **Given** a network present in the cohort but absent from the dataset, **When** the board
   renders, **Then** the row still appears with its live platform-support facts and an explicit
   "no classification data" state — the row is never dropped and a classification is never
   invented.

---

### Edge Cases

- **Registry unreachable at launch**: the standard spec-073 host behavior governs — launch is
  refused with the "verification unavailable" disclosure. The app adds no behavior here and must
  not attempt to be reachable outside the verified-launch pipeline.
- **Router address absent from the host's deployment answers** (e.g. a chain the routers were
  never recorded on, or a dedicated tenant whose contract set omits them): the capability state
  is not-available with reason — a stated fact, not an error, and never rendered as "could not
  verify".
- **Cohort = testnet**: the board shows only testnet rows. The spec-067 routers are recorded on
  the five EVM mainnets only, so a testnet build honestly shows Bridge/Supply as not available on
  its cohort networks rather than borrowing mainnet answers (constitution III forbids the
  crossing; the host's cohort enumeration makes the mainnet rows unreachable by construction).
- **CTA target surface hidden by tenant flags** (a tenant that disables `bridge` or `earn`): the
  package cannot read tenant configuration and must not re-implement tenant gating. Activation
  goes through host navigation, whose standard resolution for an unavailable destination applies
  — the member lands on an honest platform state, never a blank surface. Where the host's
  deployment answers already reveal the absence (a dedicated tenant's own contract set), the CTA
  is disabled with reason instead.
- **Read provider fails mid-render for one chain**: only that chain's cells degrade to
  could-not-verify; other rows are unaffected (per-network failure isolation, as in every estate
  surface).
- **Bitcoin surfaces disabled in this deployment** (gateway module off / feature off): the
  Bitcoin row's capability class derives from the dataset's capability description, and any
  navigation lands on the platform's own honestly degraded Bitcoin surface; the row never claims
  a working send path the deployment does not offer.
- **No wallet connected**: the board renders fully — it is a read surface. CTAs still navigate;
  the destination surfaces own their own connect prompts.
- **Dataset names a network outside the cohort** (mainnet rows in a testnet build, a network the
  platform dropped): the row is not rendered. The dataset is descriptive; the host's cohort
  enumeration is authoritative for what appears, mirroring the nav-search rule that an index can
  never resurrect a hidden surface.
- **Stage framework revision upstream** (L2Beat changes its stage definitions): the dataset
  records the framework version it was curated against; the attribution line carries it, so a
  member comparing against the live source can see the vintage.

## Requirements *(mandatory)*

### Functional Requirements

**Board, cohort & rows**

- **FR-001**: The system MUST ship a Network Status mini-app presenting one board with a row per
  network: network name, ecosystem stage/status classification, and per-capability platform
  support answers. It ships as a **registry-curated first-party package** exactly like Token Mint
  and ClearPath — published content-addressed, approved on-chain, launched through the standard
  verify-and-mount pipeline — never as a host-bundled screen.
- **FR-002**: The board MUST render only the build's cohort, taken from the host context's
  network enumeration — never from a network list bundled into the package. A testnet build shows
  testnet rows only; no support claim may derive from a read against the other cohort
  (constitution III).
- **FR-003**: Non-EVM networks (Bitcoin, per the spec-061 string-id precedent) MUST appear as
  rows presenting their own capability class — portfolio, send, receive — and MUST NEVER show a
  Bridge or Supply CTA in any state, because no router exists or can exist there. Their string
  ids MUST never be passed to any EVM-shaped host seam.

**Honest support states**

- **FR-004**: Every per-network, per-capability support answer MUST resolve to exactly one of an
  enumerated set — **`available`**, **`not-available`** (with a stated reason), or
  **`could-not-verify`** — and each MUST render distinctly. A failed read never renders as
  not-available, as available, or as an empty cell; an absence is a fact, not an error; nothing
  is ever displayed as zero-because-unreadable.
- **FR-005**: Platform-support facts MUST be resolved at runtime from the host context (the
  host's deployment answers for the Bridge and Liquidity routers, and its network descriptors) —
  never from addresses, network tables, or capability flags bundled into the package. An absent
  deployment answer is `not-available`; a host read that errs is `could-not-verify`.
- **FR-006**: The reason attached to a `not-available` state MUST distinguish "this network does
  not host the underlying protocols" (ETC/Mordor: no Across, no Uniswap) from "not offered in
  this build's cohort" (testnet builds) where the distinction is knowable, and MUST NOT speculate
  where it is not.
- **FR-007**: Row-level read failures MUST be isolated per network: one chain's failed read
  degrades only that row's cells, and any summary derived across rows that is missing one MUST
  say so rather than silently totalling.

**CTAs & deep links**

- **FR-008**: A row whose Bridge state is `available` MUST offer a Bridge CTA deep-linking
  in-app to the existing Transfer ▸ Bridge surface; a row whose Supply state is `available` MUST
  offer a Supply liquidity CTA deep-linking to the existing Earn ▸ Supply surface. Navigation
  goes through the host's navigation interface (in-app paths only); the mini-app builds no
  transaction and pre-fills no value path of its own.
- **FR-009**: Where a capability is `not-available` or `could-not-verify`, the CTA MUST degrade
  honestly: rendered disabled with the state's reason, or an equivalent inline statement —
  never hidden into ambiguity on a row that names the capability, never an enabled control that
  fails on activation, and never a fabricated or broken transaction path.
- **FR-010**: CTA availability asserts only that the destination surface is offered on that
  network — it MUST NOT be presented as a promise that a specific route, pool, or pause state is
  open. The destination surface remains the sole authority on its own live state (spec 067's
  pause and pool semantics are not restated or second-guessed by this board).
- **FR-011**: The board MUST NOT claim Across bridge-LP supply anywhere except Ethereum
  (spec 067: the HubPool is an L1 contract); where a row summarizes what Supply offers, the
  Ethereum row alone may name bridge-LP alongside trading-pool liquidity.
- **FR-012**: The package MUST NOT re-implement tenant feature gating (it cannot read tenant
  configuration). Where a CTA's destination is absent from a deployment for reasons invisible to
  the host context, activation MUST resolve through standard host navigation to an honest
  platform state — a broken or blank landing is a defect of this feature.

**Data provenance & staleness**

- **FR-013**: The stage/status classification data MUST be a curated static dataset inside the
  package: no live external ingest ships in v1, and the package performs no network fetches for
  classification data. Every classification MUST carry the dataset's as-of date, source
  attribution (the third-party staging framework it follows, including that framework's
  version/vintage), and the dataset MUST be versioned with the package.
- **FR-014**: The board MUST display the dataset's as-of date and attribution without requiring
  interaction, MUST label classifications as dated third-party framework data — visually
  distinct from the live platform-support facts — and MUST NOT present them as FairWins' own
  audit, endorsement, or as live status.
- **FR-015**: A dataset older than its declared freshness window MUST render a prominent
  staleness disclosure. The freshness window is declared in the dataset itself so the threshold
  travels with the data it governs.
- **FR-016**: Dataset revisions MUST ship as new package versions through the standard registry
  lifecycle — proposed tuple, Pending, curator approval bound to the reviewed manifest hash —
  and this is the feature's data-honesty mechanism: a classification change is a reviewed,
  content-committed publication, never a silent edit. Curator review of this app includes the
  dataset diff.
- **FR-017**: A cohort network absent from the dataset MUST still render its row with live
  platform-support facts and an explicit "no classification data" state; a dataset network
  absent from the cohort MUST NOT render. The host's cohort enumeration is authoritative for
  what appears; the dataset is descriptive only and can never resurrect or invent a network.

**Runtime contract & catalog**

- **FR-018**: The package MUST use only the documented host context (spec 073, `hostApi` 2) for
  every privileged read — deployment answers via the manifest-allowlisted contracts interface,
  network descriptors and the cohort enumeration via the host's network interfaces, navigation
  via the host — declaring exactly the permissions and contract names it uses and nothing more.
  It bundles no host configuration, imports nothing from the host source tree, and the host
  source tree imports nothing from it (both directions gated by the existing package-boundary
  test).
- **FR-019**: The app is read-only by construction: it requests no transaction submission, needs
  no wallet connection to render, and MUST remain fully readable disconnected. It signs nothing
  and moves no value; the CTAs delegate all value paths to the destination surfaces.
- **FR-020**: Catalog and launch behavior are inherited from spec 073 and restated here, not
  re-derived: the chain's `launchable` answer is the serving decision (never `status`), approval
  is content-committed to the reviewed manifest hash, the registry has one home per cohort
  (Polygon 137 on mainnet builds, Mordor 63 on testnet builds), and a registry-unreachable
  launch is refused with the standard "verification unavailable" disclosure. This spec adds no
  new registry, lifecycle, or serving behavior.
- **FR-021**: The board MUST meet the platform's accessibility bar (WCAG 2.1 AA): support
  states are distinguishable without color alone, the board is navigable by keyboard and
  screen reader, and styling uses the platform token system through the package's own scoped
  stylesheet.

### Key Entities

- **Network Row**: One cohort network's presentation — identity (name, kind: EVM chain id or
  non-EVM string id), classification (or its explicit absence), and a set of Support Answers.
- **Stage/Status Classification**: A curated, dated, attributed description of a network's
  ecosystem maturity per a named third-party framework vintage; never a live or platform-owned
  fact.
- **Support Answer**: One (network, capability) resolution — `available` | `not-available`
  (+ reason) | `could-not-verify` — derived from host-context reads at render time.
- **Capability CTA**: The actionable projection of an `available` Support Answer — an in-app
  deep link to the owning surface (Transfer ▸ Bridge, Earn ▸ Supply); degrades to a disabled,
  reason-stating control in every other state.
- **Curated Dataset**: The package-internal classification data — entries keyed by network,
  plus as-of date, source attribution, framework vintage, and freshness window; versioned and
  reviewed with the package.
- **Registry Record**: The app's on-chain listing — standard spec-073 record; per-registry ids
  differ across cohorts and are resolved by slug, never by id across cohorts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero fabricated availability: under fault injection (per-chain read failures,
  absent deployment records, disabled modules), 100% of degraded cells render `not-available`
  or `could-not-verify` correctly, and no cell ever renders available, empty, or zero from a
  failed read.
- **SC-002**: 100% of enabled CTAs land on the correct live surface (Transfer ▸ Bridge,
  Earn ▸ Supply) on the row's network context; zero enabled CTAs exist on rows whose support
  state is not `available`; zero CTA activations produce a blank or broken landing, including
  under tenant configurations that hide the destination.
- **SC-003**: Cohort isolation is absolute: on a testnet build, zero mainnet rows and zero
  mainnet-derived claims render, and vice versa, verified by automated tests on both cohorts.
- **SC-004**: The dataset's as-of date and attribution are visible on 100% of board renders,
  and a dataset aged past its freshness window produces the staleness disclosure in 100% of
  renders.
- **SC-005**: The package passes the standard mini-app gates: package-boundary test clean in
  both directions, build-digest baseline recorded, launch integrity verification passes, and
  the manifest declares exactly the permissions and contract names the code uses.
- **SC-006**: Accessibility scans (serious/critical) pass on the board in both themes and both
  viewport profiles, and no support state is distinguishable by color alone.

## Assumptions

- **"L2Beat-style" is a presentation and framework reference, not an integration.** v1 uses
  L2Beat's publicly documented staging framework descriptively, with attribution and vintage; no
  API agreement, live ingest, or affiliation is implied. A live-data follow-up would be its own
  spec and would have to confront the mini-app CSP/fetch posture explicitly; v1 deliberately
  prefers static data.
- **The existing host object suffices.** The board's needs — cohort enumeration, network
  descriptors, deployment answers for the two routers, in-app navigation — are already on
  `hostApi` 2. This spec adds **no new host key**: a key added for one package is granted to
  every package forever (spec 073), and nothing here justifies that.
- **Router deployment presence is the v1 availability signal.** "Available" means the host
  resolves a recorded router deployment for that chain; deeper liveness (pause flags, route
  tables, pool enablement) belongs to the destination surfaces, which already disclose it.
  An optional on-chain liveness probe distinguishing `could-not-verify` is an implementation
  choice, not a requirement beyond FR-004's state semantics.
- **The app lands in the catalog's existing category set** (Reporting & Audit) with artwork via
  the catalog's own slug-derived artwork seam (spec 077) — no new icon fields anywhere.
- **Slug and naming**: working name "Network Status", slug `network-status`; per-registry ids
  differ per cohort and are resolved by slug (spec 073 rule restated).
- **Deployment targets follow the registry's homes**: listed on Polygon 137 (mainnet cohort) and
  Mordor 63 (testnet cohort), like the other converted first-party apps.
- **The spec-067 admin handoff (issue #966) is out of scope** — this board reads router
  presence, not router authority, and takes no dependency on which key holds
  `DEFAULT_ADMIN_ROLE`.
- **Wager/pool/membership per-network availability is out of scope for v1** — the board covers
  the two spec-067 capabilities plus the non-EVM capability class; widening the capability
  matrix is additive follow-up work under the same state semantics (FR-004).
- **No new e2e tier**: the board is validatable without a chain for its rendering and state
  semantics (no-chain tier per spec 094's admission rules); it signs nothing that costs money,
  so no on-chain-tier obligation attaches.
