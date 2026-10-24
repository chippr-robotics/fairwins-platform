# Tasks: Native Release Channels (iOS + Android + Web)

**Input**: Design documents from `/specs/102-capacitor-channels/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included — constitution II is test-first, and every seam contract in
`contracts/native-runtime-seams.md` names the behavior its Vitest must pin.

**Organization**: Grouped by user story (US1–US6 from spec.md). US1 (the
installable full-feature app) is the MVP; US2 rides its foundation and is
required before any store-facing ship (the lock is a security property).

## Format: `[ID] [P?] [Story] Description`

## Path Conventions

Per plan.md: native shells under `frontend/ios/` + `frontend/android/`; seam
code under `frontend/src/lib/native/`; sync/gate scripts under
`scripts/native/`; workflow changes in `.github/workflows/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and generated shells, under the spec-075 lockfile rules.

- [X] T001 Add `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`, `@capacitor/app` (pinned EXACT) to `frontend/package.json` via `npm run deps:reinstall`; verify `npm run check:deps` passes and the rolldown platform binary survived (root `package-lock.json`).
- [X] T002 Run both byte gates on the dependency change (`node scripts/codegen/bytecode-digest.js --check`, `node scripts/miniapps/record-build-digests.js --compare`); if mini-app output bytes moved, STOP and treat per spec 075 (deliberate re-record + version bump), do not fold silently into this PR.
- [X] T003 Generate the native shells: `npx cap add ios && npx cap add android` from `frontend/` with a provisional `frontend/capacitor.config.ts` (default tenant appId placeholder, `webDir: 'dist'`); commit the generated `frontend/ios/` + `frontend/android/` trees.
- [X] T004 [P] Add `docs/developer-guide/native-channels.md` skeleton (channels, seams, build commands) — filled through the phases below.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The runtime seam, tenant identity, and version sync every story reads.

- [X] T005 Implement `frontend/src/lib/native/runtime.js` per `contracts/native-runtime-seams.md` §1 (`getRuntime()`, `nativeCapability(name)` three-state with member-renderable reasons; web answers wrap existing checks; memoized; no UA sniffing) + Vitest `frontend/src/test/native/runtime.test.js` covering web/native resolution and the never-fabricate-available rule.
- [X] T006 Extend the tenant manifest schema with the `native` block (data-model.md): update `tenants/fairwins/manifest.json` with real iOS/Android appIds + displayName + iconSource, extend the validator behind `npm run tenants:validate` (schema + cross-tenant appId uniqueness + absent-block ⇒ no native channel), with a must-fail fixture per gate convention.
- [X] T007 Implement `scripts/native/sync-native-config.js` (tenant manifest + cohort + `scripts/release/version.js` → `frontend/capacitor.config.ts`, Android `versionName`/`versionCode`, iOS `CFBundleShortVersionString`/`CFBundleVersion`, per `contracts/release-artifacts.md` derivation); unknown tenant or missing `native` block fails naming the tenant.
- [X] T008 Implement `scripts/native/check-native-versions.js` (regenerate-and-diff gate over every synced field) + wire `npm run check:native-versions` into the root `package.json` scripts and the CI gate group that runs the other regenerate-and-diff checks in `.github/workflows/test.yml`.
- [X] T009 [P] Native CSP: inject the per-platform `<meta http-equiv="Content-Security-Policy">` into the bundled `index.html` at native build (in `sync-native-config.js` or a sibling step) per research R7 (`script-src` keeps `blob:`, never gains `https:`; `connect-src` keeps spec-069 grants) + parity gate `frontend/src/test/native/nativeCspParity.test.js` asserting shared directives agree with the nginx policy files.

**Checkpoint**: `npx cap sync` produces tenant-correct, version-correct shells; gates fail on hand edits.

---

## Phase 3: User Story 1 — Install FairWins as a native app and use it fully (P1) 🎯 MVP

**Goal**: The full product boots and works in both native shells from bundled assets.

**Independent test**: quickstart.md "Build and run" + device validation 5 (mini-apps).

- [X] T010 [US1] Make the production build boot in the Capacitor WebView: run `npm run build --workspace frontend && npx cap run android` (emulator) and fix what breaks in seam code/config only (asset paths, origin-dependent assumptions, storage availability), keeping the web channel byte-identical; document each fix in `docs/developer-guide/native-channels.md`.
- [X] T011 [US1] Mini-app loader: make the service-worker package cache honestly optional per research R6 — verify the loader's no-SW path fetches + verifies + runs Token Mint in the native WebView; add/adjust Vitest in `frontend/src/test/miniapps/` only if the no-SW path needs a code change (the verify-before-execute invariant must be provably unaffected).
- [X] T012 [P] [US1] Honest degradation surface: a small `frontend/src/components/native/NativeCapabilityNotice.jsx` (existing tokens/components) rendering `nativeCapability(...)` `unavailable(reason)` in place, used by the stories below; Vitest for the three-state rendering (never renders for `available`, never blank for `unavailable`).
- [X] T013 [P] [US1] Version + support floor: surface the synced version in the native builds where the web shows it, and implement the FR-015 stale-build notice (build older than a supported floor names the update path) behind the runtime seam; Vitest in `frontend/src/test/native/`.

**Checkpoint**: MVP — installable apps running the full product from bundled assets.

---

## Phase 4: User Story 2 — Passkey sign-in and app lock on the native lifecycle (P1)

**Goal**: Same account via the platform passkey ceremony; lock re-prompt on background/foreground.

**Independent test**: quickstart.md device validation 1–2.

- [X] T014 [US2] Implement `frontend/src/lib/native/lifecycle.js` per contract §4 (Capacitor `App.appStateChange`/`pause`/`resume` → the exact hide/show events `lib/applock/appLock.js` consumes; inert on web; no policy here) + Vitest `frontend/src/test/native/lifecycle.test.js` proving the event mapping and the no-double-fire rule.
- [X] T015 [US2] Wire the lifecycle adapter into app boot (where `visibilitychange` is subscribed today — `frontend/src/contexts/ActivityProvider.jsx`) behind `getRuntime()`; extend the existing app-lock Vitest to prove a native background past threshold gates every wallet surface on foreground.
- [X] T016 [US2] Choose and pin the native passkey bridge per research R3 (audited plugin vs thin in-repo plugin over AuthenticationServices/Credential Manager); record the choice + security-review notes in `specs/102-capacitor-channels/research.md` as R3a, add the dependency via `npm run deps:reinstall` (byte gates re-run), and note it needs the `.github/agents` security review on this PR.
- [X] T017 [US2] Implement the ceremony selection inside `frontend/src/lib/passkey/credentials.js` per contract §2 (web path byte-identical; native bridge takes/returns WebAuthn-shaped objects; PRF round-trip or named refusal; unavailability → seam reason; system-browser ceremony as disclosed fallback) + Vitest `frontend/src/test/native/passkeyBridge.test.js` with a stub bridge proving shape-parity and the PRF-refusal rule.
- [X] T018 [P] [US2] Association files: add the AASA (`webcredentials` + `applinks`) and `assetlinks.json` templates + generator to `scripts/native/` (fed by the tenant manifest appIds; operator team ids as placeholders documented in the runbook), and document serving them from the tenant origin in `docs/runbooks/native-release-operations.md`.

**Checkpoint**: Same-account passkey sign-in + lifecycle lock, provable on emulator/simulator for the lock and by staged manual protocol for the ceremony.

---

## Phase 5: User Story 3 — Release artifacts per tag, digest-recorded (P2)

**Goal**: The spec-076 chain builds, smoke-tests, and records all three channels.

**Independent test**: quickstart.md "Release-chain validation" on a test tag.

- [X] T019 [US3] Add `android-artifact` job to the release workflow (web build → `cap sync android` → Gradle `bundleRelease` → sign with the upload key via the spec-097 delivery; missing credential FAILS naming the secret) producing `.aab` + sha256; add the upload-key secret to `scripts/secrets/registry.js` AND both tfvars lists together (`npm run test:secrets` proves no drift).
- [X] T020 [P] [US3] Add `ios-artifact` job (macOS runner: web build → `cap sync ios` → `xcodebuild archive` + unsigned export → zipped archive + sha256) per `contracts/release-artifacts.md`; signing/upload stays the operator ceremony.
- [X] T021 [US3] Add `native-smoke-android` (emulator) and `native-smoke-ios` (simulator) jobs asserting launch → sign-in gate visible → one live read surface → background/foreground past threshold re-prompts (FR-010); all four new jobs GATE the release (no `continue-on-error` — constitution IV).
- [X] T022 [US3] Extend the release record generation (spec-076 scripts) with the per-channel artifact rows (`channel`/`artifact`/`sha256`/`signed` per data-model.md), with the row-only-if-built-and-smoked rule enforced in the generator, and a must-fail check for a record describing a missing artifact.
- [X] T023 [P] [US3] Write `docs/runbooks/native-release-operations.md`: store account setup, iOS signing + upload ceremony, Android track promotion, association-file deployment, store-policy review checklist (mini-apps/wagering), consuming the recorded digests.

**Checkpoint**: A test tag yields three digest-recorded artifacts with gating smoke jobs.

---

## Phase 6: User Story 4 — Ledger over native Bluetooth (P3)

**Goal**: The BLE rung behind the one hardware seam.

**Independent test**: quickstart.md device validation 4 (staged manual protocol).

- [X] T024 [US4] Add `@capacitor-community/bluetooth-le` (pinned exact) via `npm run deps:reinstall` (byte gates re-run) and implement the native BLE transport rung in `frontend/src/lib/hardware/ledgerAdapter.js` per contract §3 (Ledger BLE service/characteristic framing over the plugin; `exchange`/`close` interface; selected by runtime seam + capability).
- [X] T025 [US4] Normalize every plugin failure to `HW_ERROR_CODES` (distinct permission-denied vs radio-off vs discovery codes with recovery guidance) in `frontend/src/lib/hardware/errors.js`/`ledgerAdapter.js`; Vitest `frontend/src/test/native/ledgerBleRung.test.js` with a stub plugin proving framing round-trip and error normalization (a raw SDK message reaching the member is the must-fail case).
- [X] T026 [P] [US4] Extend `docs/runbooks/hardware-wallet-staging-validation.md` with the native-BLE staged manual protocol (pair, verify-on-device, sign, permission-denied leg) referenced by the matrix row.

**Checkpoint**: Rung compiled into native builds; guarantees above the transport untouched.

---

## Phase 7: User Story 5 — Deep links open the app (P3)

**Goal**: Universal/app links land on the linked surface through the gate.

**Independent test**: quickstart.md device validation 3.

- [X] T027 [US5] Implement `frontend/src/lib/native/deepLinks.js` per contract §5 (`appUrlOpen` → SPA route via existing navigation; tenant-origin URLs only; unroutable → home claiming nothing; pending-link held through the sign-in/lock gate, consumed exactly once, dropped only on sign-out) + Vitest `frontend/src/test/native/deepLinks.test.js` including the locked-arrival case.
- [X] T028 [P] [US5] Register the associated domains in both shells (iOS entitlements `applinks:`, Android intent filters with `autoVerify`) from the tenant manifest via `sync-native-config.js`, and extend the T018 association-file generator with the `applinks` entries.

**Checkpoint**: Share link → in-app surface with the gate honored; web fallback untouched.

---

## Phase 8: User Story 6 — Per-tenant app identity (P3)

**Goal**: Prove the tenant seam end-to-end (identity built in Phase 2).

**Independent test**: quickstart.md "Tenant validation".

- [X] T029 [US6] Add a test tenant fixture with a `native` block and a build-time test (Vitest or script-level, `frontend/src/test/native/tenantNativeIdentity.test.js`) proving: shells carry only that tenant's appId/name; unknown tenant fails naming it; two tenants' appIds are distinct (uniqueness gate from T006 exercised).
- [X] T030 [P] [US6] Document the tenant native-onboarding path (manifest block, icons, association files, store identity) in `docs/developer-guide/white-label-tenants.md` + cross-link from `native-channels.md`.

**Checkpoint**: Tenant isolation provable without a second real tenant.

---

## Phase 9: Polish & Cross-Cutting

- [X] T031 Add spec-094 matrix rows: replace the placeholder 102 row in `frontend/cypress/coverage/matrix.json` with flows for the native-only behaviors (lifecycle lock, native passkey ceremony, BLE signing, deep-link entry) — statuses honest (smoke-tier covered vs staged-manual with the runbook named), regenerate `docs/developer-guide/e2e-coverage-matrix.md` (`npm run e2e:matrix`), keep `frontend/src/test/e2e-policy/` green.
- [X] T032 [P] Finish `docs/developer-guide/native-channels.md` (seams, contracts, build/run, gates, degradation rules) and add the CLAUDE.md guardrail bullet for spec 102 (seam-only rule, lockfile rule, version-sync-only rule, CSP parity gate).
- [X] T033 Full verification pass per the `monorepo-verify` skill on the final PR state (check:deps, byte gates, tenants:validate, check:native-versions, scoped Vitest for every new test file, eslint on touched files); confirm the web channel's nginx CSP files and service worker are byte-identical to staging.

---

## Dependencies

- Phase 1 → Phase 2 → all story phases.
- US1 (Phase 3) is the MVP and precedes device-level validation of every other story.
- US2 depends on US1 (a bootable app); T016→T017 sequential (bridge choice before wiring).
- US3 depends on US1 (something to build/smoke); T019/T020 parallel, T021 after both, T022 after T021.
- US4, US5 depend on Phase 2 + US1; independent of each other and of US3.
- US6 depends only on Phase 2 (T006/T007).
- Phase 9 last; T031 needs the smoke tier (T021) and the staged protocols (T026) to exist so statuses are honest.

## Parallel Opportunities

- Phase 2: T005, T006, T009 in parallel (different files); T007/T008 after T006.
- After Phase 3: US2, US4, US5, US6 can proceed in parallel (disjoint files); US3 in parallel once a bootable build exists.
- Within stories: every `[P]` task touches files no sibling task edits.

## Implementation Strategy

MVP = Phases 1–3 (installable full-feature apps). Ship order after MVP:
US2 (security property — required before any store-facing distribution), then
US3 (release chain), then US4/US5/US6 in parallel, then Polish. Each phase
lands committed and gate-green on this PR; device-bound validations follow the
staged manual protocols and are recorded honestly in the matrix rather than
faked in CI.
