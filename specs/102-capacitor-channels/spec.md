# Feature Specification: Native Release Channels (iOS + Android + Web)

**Feature Branch**: `102-capacitor-channels`

**Created**: 2026-08-30

**Status**: Draft

**Input**: User description: "Capacitor packaging of the FairWins frontend so that iOS, Android, and web are first-class release channels. Members get the same FairWins app — wagers, transfers, passkey wallet, hardware wallets, mini-apps — as an installable native app on iOS and Android alongside the existing web/PWA channel, with platform artifacts (.ipa, .aab, web bundle) built, tested, and digest-recorded in the existing release chain per release tag. Native-only behaviors the product must confront: passkey (WebAuthn) sign-in and app-lock re-prompt on native app lifecycle (background/foreground), Ledger hardware wallet connectivity over native Bluetooth (web-ble does not exist in a native WebView), deep links into the app, and per-tenant app identity (one app id per tenant, mirroring one origin per tenant). Platform builds and their smoke tests must fail loudly in CI, and native-only behaviors get coverage rows in the e2e matrix."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install FairWins as a native app and use it fully (Priority: P1)

A member installs FairWins on their iPhone or Android phone as a real installed
app — an icon on the home screen, launched like any other app — and finds the
same FairWins they know from the web: they can browse and create wagers, accept
and resolve them, send and receive funds, view their portfolio, and open
mini-apps. Nothing they could do on the web is missing, and nothing behaves
differently without saying so.

**Why this priority**: This is the feature. A native channel that ships a
reduced or divergent app is worse than no native channel — it fragments the
product's trust surface. Everything else in this spec exists to make this story
true on platforms whose runtime differs from a browser.

**Independent Test**: Install the platform build on a device (or emulator),
sign in, and complete one wager end-to-end (create → accept → resolve → claim)
plus one transfer. Deliverable value: the full product, installable.

**Acceptance Scenarios**:

1. **Given** a member with the native app installed and signed in, **When** they
   create a wager, have it accepted, resolve it, and claim the payout, **Then**
   every step completes exactly as it does on the web channel, with the same
   honest state and finality disclosures.
2. **Given** a member using a surface that is unavailable or degraded in the
   native runtime, **When** they reach it, **Then** the app says so honestly in
   place (what is unavailable and why) — it never renders a broken control or
   silently hides a capability the web channel offers without disclosure.
3. **Given** the same release version, **When** a member compares the native app
   and the web app, **Then** the member-visible feature set and displayed
   version are the same.

---

### User Story 2 - Passkey sign-in and app lock respect the native app lifecycle (Priority: P1)

A member signs in to the native app with their passkey exactly as they do on the
web. When they background the app (switch apps, take a call, lock the phone) and
come back, the app-lock re-prompt behaves the way it does on the web when a tab
is hidden and re-shown: if the lock policy says a re-authentication is due, the
member is asked before any wallet surface is visible.

**Why this priority**: The passkey wallet is the platform's key custody. A
native app that either breaks passkey sign-in (no wallet at all) or fails to
re-lock on backgrounding (an unattended phone with an open wallet) is a security
regression, not a packaging detail. Native lifecycle events are not browser
visibility events, so this behavior must be specified, not assumed.

**Independent Test**: On a device/emulator, sign in with a passkey, background
the app past the lock threshold, foreground it, and observe the re-prompt gate
before any balance or action is reachable.

**Acceptance Scenarios**:

1. **Given** a member with a passkey account, **When** they sign in on the
   native app, **Then** the platform's native passkey ceremony completes and
   the resulting account is the SAME account they hold on the web channel (same
   addresses, same balances).
2. **Given** a signed-in member with app lock enabled, **When** the app is
   backgrounded past the lock threshold and then foregrounded, **Then** the
   re-authentication prompt gates every wallet surface, exactly as the web
   channel's re-prompt does.
3. **Given** a device where the native passkey ceremony cannot run (unsupported
   OS version, platform authenticator unavailable), **When** the member attempts
   sign-in, **Then** the app explains what is unsupported and what their options
   are — it never spins or fails silently.

---

### User Story 3 - Every release produces tested, recorded artifacts for all three channels (Priority: P2)

A release operator cuts a release exactly as today. The release chain now
produces three channel artifacts — an iOS app package, an Android app package,
and the web bundle — each built from the same tagged source, each smoke-tested,
and each recorded in the release record with its digest, so an operator can
later prove which bytes shipped on which channel for which version.

**Why this priority**: Channels that are built by hand outside the release
chain drift: different versions, unrecorded bytes, unverifiable provenance.
The existing release discipline (one version source, immutable tags, recorded
digests) must extend to the new channels or they are not "first-class".

**Independent Test**: Cut a release tag on a test branch; verify the pipeline
produces all three artifacts, runs each channel's smoke test, fails the
pipeline if any build or smoke test fails, and records all three digests in the
release record.

**Acceptance Scenarios**:

1. **Given** a release tag, **When** the release pipeline runs, **Then** it
   produces an iOS artifact, an Android artifact, and a web artifact, all
   carrying the same version derived from the single version source.
2. **Given** a platform build or its smoke test fails, **When** the pipeline
   completes, **Then** the release fails loudly — no release record is
   published describing artifacts that do not exist or were not tested.
3. **Given** a published release record, **When** an operator audits it,
   **Then** it lists each channel artifact with a digest that matches the
   shipped bytes.

---

### User Story 4 - Ledger hardware wallets connect over native Bluetooth (Priority: P3)

A member who protects funds with a Ledger device connects it to the native app
over Bluetooth and signs with it — the same pairing, verification, and physical
confirmation flow the web channel offers, on a runtime where the browser's
Bluetooth machinery does not exist.

**Why this priority**: Hardware-wallet members are the platform's
highest-value custody users, and this is the one existing capability that
cannot ride the web code path at all in a native runtime. It is P3 only
because the native channels are viable (and honest) shipping without it —
provided its absence is disclosed per Story 1's degradation rule.

**Independent Test**: On a physical device with a Ledger, pair, connect,
verify the address on the device screen, and sign one transaction; separately
verify a denied Bluetooth permission renders an honest, recoverable explanation.

**Acceptance Scenarios**:

1. **Given** a member with a paired Ledger, **When** they sign a transaction in
   the native app, **Then** the signature requires the same physical
   confirmation on the device screen and the same pre-broadcast verification as
   the web flow.
2. **Given** Bluetooth permission is denied or the radio is off, **When** the
   member attempts to connect, **Then** the app names the actual obstacle
   (permission, radio, discovery) and how to fix it — never a raw error or a
   silent timeout.

---

### User Story 5 - Links into FairWins open the app (Priority: P3)

A member who taps a FairWins link — a wager share link, a claim link, a
deep-linked settings card — on a phone with the native app installed lands in
the app, on the surface the link names, signed in as themselves. Without the
app installed, the same link works on the web exactly as today.

**Why this priority**: Share links are how wagers spread between friends; if
the native app breaks them (or hijacks them to a home screen), the core social
loop degrades for exactly the members who adopted the app.

**Independent Test**: With the app installed, open a wager share link from a
messaging app and verify it lands on that wager in the native app; uninstall
and verify the same link opens the web experience.

**Acceptance Scenarios**:

1. **Given** the native app is installed, **When** a member opens a FairWins
   link, **Then** the app opens on the linked surface (and gates through
   sign-in/app-lock first if required).
2. **Given** the app is not installed, **When** the same link is opened,
   **Then** the web channel serves it unchanged.

---

### User Story 6 - A white-label tenant gets its own app identity (Priority: P3)

A tenant operator whose brand runs on FairWins infrastructure ships their own
native apps: their name, their icon, their app identity in the stores —
carrying only their tenant's configuration, exactly as their web origin carries
only their tenant today. No tenant's app can be built carrying another
tenant's identity or estate.

**Why this priority**: The tenant model already binds one origin to one
tenant at build time; the native channels must extend that binding or
white-labeling breaks the moment a tenant asks for an app. P3 because the
default tenant's apps ship first and prove the seam.

**Independent Test**: Build the native artifacts for a non-default test tenant
and verify the app identity, branding, and resolved contract set are that
tenant's alone; verify an unknown tenant id fails the build loudly.

**Acceptance Scenarios**:

1. **Given** a tenant id at build time, **When** the native artifacts are
   built, **Then** each carries that tenant's app identity and configuration
   only, and a build for an unknown tenant fails rather than falling back to
   another tenant.
2. **Given** two tenants, **When** both ship native apps, **Then** their app
   identities are distinct and installable side by side.

---

### Edge Cases

- **Backgrounded mid-action**: the app is backgrounded while a transaction is
  awaiting signature or broadcast. On foreground (and after any due lock
  re-prompt), the app must show the action's true state — signed, broadcast,
  failed, or abandoned — never a stale "waiting" it can no longer resolve.
- **Lifecycle kill**: the OS terminates the backgrounded app. Relaunch must
  restore the member to a locked, honest state; nothing pending may be
  reported as done because a completion callback died with the process.
- **Native runtime without a needed capability**: an OS version below the
  passkey or Bluetooth baseline, a WebView missing an API the web app assumes.
  Every such gap must resolve to an in-place honest disclosure, never a blank
  screen or dead control.
- **Stale installed version**: unlike the web, members run old native builds.
  A build older than a platform-support floor must say so and point to the
  update path rather than failing obscurely against newer backends.
- **Link while locked**: a deep link arrives while the app is locked or signed
  out; the destination must survive the sign-in/unlock gate rather than being
  dropped.
- **Store-policy conflict**: a distribution store objects to a surface (e.g.
  third-party mini-apps or wagering features in a given jurisdiction). The
  channel must be able to disable that surface per tenant/platform honestly
  (named, disclosed) without a new release of the web channel.
- **Cohort integrity**: a native build is one cohort (mainnet or testnet), like
  a web build; a testnet-cohort app must never read or display mainnet estate
  data, and store-distributed builds are mainnet-cohort only.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The product MUST ship on three release channels — iOS app,
  Android app, and the existing web/PWA — built from the same source at the
  same version for any given release.
- **FR-002**: The native channels MUST present the same member-facing feature
  set as the web channel. Where the native runtime cannot support a
  capability, the surface MUST degrade honestly in place (naming what is
  unavailable and why); silent removal or broken controls are not acceptable
  degradation.
- **FR-003**: Passkey sign-in MUST work in the native apps using the
  platform's native passkey ceremony, resolving to the same member account
  (same addresses and balances) the member holds on the web channel.
- **FR-004**: The app-lock policy MUST be enforced across native lifecycle
  transitions: backgrounding/foregrounding and process restart MUST trigger the
  same re-authentication gating the web channel applies on visibility loss, and
  no wallet surface may render ahead of a due re-prompt.
- **FR-005**: Ledger hardware-wallet signing MUST be available in the native
  apps over the device's native Bluetooth, preserving the existing flow's
  guarantees: physical confirmation on the device screen for every signature,
  address re-derivation checks on reconnect, and pre-broadcast verification of
  what was signed. All vendor connectivity MUST remain behind the platform's
  single existing hardware-wallet seam; permission or radio failures MUST
  render as named, recoverable guidance.
- **FR-006**: FairWins links MUST open in the installed native app on the
  linked surface, gated by sign-in/app-lock when due (with the destination
  preserved through the gate), and MUST continue to serve the web experience
  when the app is not installed.
- **FR-007**: App identity MUST be per tenant: one tenant, one app identity
  per platform, selected at build time; a build for an unknown tenant MUST
  fail loudly and MUST never fall back to another tenant's identity or estate.
- **FR-008**: Each release tag MUST produce all three channel artifacts with
  the version derived from the platform's single version source, and the
  release record MUST list each artifact with its content digest.
- **FR-009**: Every platform build and its smoke test MUST gate the release
  pipeline: a failed build or failed smoke test fails the release, and no
  release record may describe an artifact that was not built and tested.
- **FR-010**: Each native channel MUST have an automated smoke tier exercising
  at minimum: app launch, sign-in gating, one read surface rendering real
  data, and the app-lock lifecycle re-prompt.
- **FR-011**: Native-only behaviors (app-lock on lifecycle, native passkey
  ceremony, Bluetooth hardware signing, deep-link entry) MUST carry rows in
  the e2e coverage matrix, with status and depth recorded honestly (a behavior
  only testable on physical hardware is recorded as such, not marked covered
  by a test that cannot fail).
- **FR-012**: The native channels MUST NOT weaken the web channel's security
  posture: existing content-security and origin rules are not widened
  globally to accommodate native runtimes; any platform-specific allowance is
  scoped to that platform's builds and documented with its reasoning.
- **FR-013**: A native build MUST belong to exactly one network cohort, with
  no cross-cohort reads or displays; store-distributed builds are
  mainnet-cohort.
- **FR-014**: Mini-apps MUST remain available on the native channels under the
  same verification model as the web (nothing unverified ever runs), and MUST
  be individually disableable per tenant and platform with an honest in-app
  disclosure, so a store-policy objection can be answered by configuration
  rather than an emergency release.
- **FR-015**: Members on a native build older than the supported floor MUST be
  told so in-app, with the update path named, before degraded behavior is
  attributed to anything else.

### Key Entities

- **Release channel**: one of iOS, Android, web. A distribution surface for the
  same product at the same version; carries channel-specific packaging and a
  channel-specific smoke tier.
- **Platform artifact**: the installable output of one channel for one release
  tag (iOS package, Android package, web bundle), identified by version + digest
  in the release record.
- **App identity**: the per-tenant, per-platform identity a native app installs
  under (name, icon, store identity, link-handling domain association). Bound
  to exactly one tenant at build time.
- **Native capability gap**: a capability the web channel assumes that a native
  runtime lacks (browser Bluetooth, browser visibility events); each gap maps
  to either a native-backed equivalent or an honest degradation, never silence.
- **Coverage row**: the e2e matrix entry for a native-only behavior, carrying
  status, depth, and — where hardware-bound — the honest reason full automation
  is impossible.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can install the app on iOS and Android and complete a
  full wager lifecycle (create → accept → resolve → claim) and a transfer on
  each, with zero steps that require falling back to the web channel.
- **SC-002**: Passkey sign-in succeeds on supported devices in the native apps
  for 100% of accounts that can sign in on the web channel, resolving to the
  same account.
- **SC-003**: In lifecycle testing, 100% of background→foreground transitions
  past the lock threshold present the re-authentication gate before any wallet
  surface is visible, across both native platforms.
- **SC-004**: 100% of release tags after adoption produce all three channel
  artifacts with recorded digests; zero releases publish a record describing an
  untested or missing artifact.
- **SC-005**: Zero silent platform-build failures: every failed native build or
  smoke test in the observation window fails its pipeline run visibly.
- **SC-006**: Every identified native-only behavior has a coverage matrix row
  with honest status/depth at ship; zero native-only behaviors are absent from
  the matrix.
- **SC-007**: A share link opened on a device with the app installed reaches
  the linked surface in-app in under 5 seconds on a mid-range device, including
  any required unlock, with the destination preserved through the gate.
- **SC-008**: A non-default tenant can produce installable native artifacts
  carrying only its own identity and configuration, with a build for an
  unknown tenant failing 100% of the time.

## Assumptions

- **Store publication is an operator ceremony, not a pipeline step.** The
  release chain's obligation ends at store-ready, digest-recorded artifacts;
  account setup, listings, review submission, and store rollout are human
  operator tasks (with a runbook), since they involve external accounts,
  review timelines, and judgments the pipeline cannot make. TestFlight/internal
  testing tracks are likewise operator-driven consumers of the recorded
  artifacts.
- **The web/PWA channel is unchanged for members.** Existing web members see no
  behavioral difference from this feature; the web bundle simply becomes a
  recorded artifact alongside the native two.
- **Mini-apps ship on native.** They are verified content executed by the
  app's own web runtime (the model stores permit), so they are included by
  default; FR-014's per-platform disable switch is the contingency if a store
  reviewer disagrees, and store-policy review is an explicit operator checklist
  item before first submission.
- **First ship is the default tenant, mainnet cohort.** Tenant and testnet
  builds are proven by build-time tests and internal installs, not store
  distribution.
- **Signing credentials for store artifacts are operator-held secrets** managed
  under the platform's existing secret-custody rules; the pipeline consumes
  them, never stores them in the repository.
- **Device-hardware-bound flows (physical Ledger over Bluetooth, real platform
  passkey ceremonies on physical phones) cannot be fully automated in CI**;
  their coverage rows record a staged manual validation protocol, mirroring how
  the platform already treats hardware-wallet staging validation.
- **Supported OS floor** is set by the platforms' passkey support baselines
  (the wallet is the product; a device that cannot do the passkey ceremony
  cannot be a target), and is disclosed in-app per FR-015.
