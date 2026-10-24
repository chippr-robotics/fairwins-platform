# Implementation Plan: Native Release Channels (iOS + Android + Web)

**Branch**: `claude/release-1-14-0-tasks-av87yu` | **Date**: 2026-08-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/102-capacitor-channels/spec.md`

## Summary

Package the existing React/Vite frontend as native iOS and Android apps with
**Capacitor**, alongside the unchanged web/PWA channel. The native apps serve
the **bundled build output** from the app package (no remote-URL shell), bridge
four runtime gaps through existing seams — passkey ceremonies via a native
credential bridge selected inside the existing passkey credential layer,
app-lock via a lifecycle adapter feeding the existing `appLock` activity
events, Ledger BLE via a new rung inside `lib/hardware/adapters.js`, deep
links via universal/app links routed through the existing nav — and extend the
spec-076 release chain with two platform build jobs whose artifacts are
digest-recorded in the release record. Tenant identity (app id, name, icons)
derives from the tenant manifest at build time; version derives from
`scripts/release/version.js` and is *synced into* the native projects, never
hand-edited.

## Technical Context

**Language/Version**: JavaScript (Node 22, React 19, Vite 8/rolldown); generated native shells: Swift (iOS), Kotlin/Gradle (Android) — kept as thin as Capacitor generates them.

**Primary Dependencies**: `@capacitor/core` + `@capacitor/cli` + `@capacitor/ios` + `@capacitor/android` (pinned exact), `@capacitor/app` (lifecycle + deep links), `@capacitor-community/bluetooth-le` (Ledger BLE rung), a native passkey bridge plugin (research R3). All installs via `npm run deps:reinstall` (spec 075 — never `npm install`); `check:deps` and both byte gates arbitrate.

**Storage**: N/A (no new persistence; native apps use the same origin-scoped web storage the WebView provides; nothing new joins `syncedObjects.js`).

**Testing**: Vitest for the new frontend seams (lifecycle adapter, runtime detection, tenant native config generation); existing Cypress tiers untouched; new native smoke tier — Android emulator + iOS simulator jobs asserting launch → sign-in gate → one live surface → lock re-prompt (FR-010); spec-094 matrix rows with hardware-bound legs recorded as staged manual validation.

**Target Platform**: iOS 16+ / Android 10+ (API 29+) — floors set by platform passkey support (research R2); web unchanged.

**Project Type**: Mobile packaging of an existing web application + CI/release-chain extension.

**Performance Goals**: Cold launch to interactive sign-in ≤ 5s on a mid-range device; deep link to linked surface ≤ 5s including unlock (SC-007).

**Constraints**: Root-lockfile hazard (spec 075); web nginx CSP not widened (FR-012 — native builds carry their own scoped policy); mini-app verify-before-execute invariant preserved without relying on the service worker (research R6); one tenant = one app id, unknown tenant fails the build (spec 072); version single-source (spec 076); no secrets in the repo — store signing credentials are operator-held (spec 097 registry).

**Scale/Scope**: 2 native shells + ~6 frontend seam files + tenant manifest schema extension + 2 CI jobs + release-record schema extension; no contract changes, no gateway changes.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` before Phase 0; re-checked after Phase 1.*

- **I. Security-first contracts** — PASS (no `contracts/` changes; no new custody surface; the native BLE and passkey bridges sit behind the existing seams whose guarantees — physical confirmation, recover-and-verify before broadcast, re-derive on reconnect — are preserved by contract tests on the seam).
- **II. Test-first / coverage** — PASS (each seam lands with Vitest coverage; native smoke tier in CI; matrix rows added honestly per spec 094, hardware-bound legs recorded as staged manual validation, not fake coverage).
- **III. Honest state, no mocks in shipped paths** — PASS with explicit design attention: every native capability gap resolves to an honest in-place disclosure (spec FR-002/FR-015); cohort isolation holds because a native build is one build-time cohort exactly like a web build; runtime detection must never fabricate a capability (e.g. reporting BLE available before the plugin confirms).
- **IV. Fail loudly in CI** — PASS (platform build + smoke jobs gate the release; no `continue-on-error` on any of them; a missing signing input fails the job with a named reason rather than skipping).
- **V. Accessible, consistent frontend** — PASS (no new UI beyond disclosure notices, which use existing tokens/components; axe/Lighthouse tiers unchanged).
- **Additional constraints** — new core technology (Capacitor) is justified here: it is the only mainstream way to ship the existing WebView-run codebase as store apps without a rewrite, and the alternative (React Native/Flutter) is a rewrite, rejected in research R1. No secrets committed; native signing material stays in Secret Manager under the spec-097 registry.

**Post-design re-check (after Phase 1)**: PASS — no violations introduced; no Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/102-capacitor-channels/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0: R1..R8 decisions
├── data-model.md        # Phase 1: entities + config schemas
├── quickstart.md        # Phase 1: build/run/validate guide
├── contracts/
│   ├── native-runtime-seams.md   # lifecycle, passkey bridge, BLE rung, deep links
│   └── release-artifacts.md      # artifact naming, digest record, version sync
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
frontend/
├── capacitor.config.ts            # generated per tenant+cohort by the sync script — committed for the default tenant, regenerated at build
├── ios/App/                       # Capacitor-generated iOS shell (committed; version fields sync-only)
├── android/                       # Capacitor-generated Android shell (committed; version fields sync-only)
├── src/lib/native/
│   ├── runtime.js                 # isNativeApp()/platform detection — the ONE runtime seam
│   ├── lifecycle.js               # appStateChange → the events appLock already consumes
│   └── deepLinks.js               # appUrlOpen → router path, destination preserved through the lock gate
├── src/lib/passkey/credentials.js # gains the native-bridge selection (web ceremony vs native ceremony)
├── src/lib/hardware/
│   └── ledgerAdapter.js           # gains the native-BLE transport rung (same HW_ERROR_CODES)
└── src/test/native/               # Vitest for the seams above

scripts/native/
├── sync-native-config.js          # tenant manifest + version.js → capacitor config + native version fields
└── check-native-versions.js       # gate: native version fields match version.js (regenerate-and-diff)

tenants/<id>/manifest.json         # gains a `native` block (appId per platform, display name, icon source)

.github/workflows/                 # release chain gains android-artifact / ios-artifact / native-smoke jobs
docs/developer-guide/native-channels.md
docs/runbooks/native-release-operations.md   # store publication operator ceremony
```

**Structure Decision**: native shells live under `frontend/` (Capacitor's
convention, and they wrap `frontend/dist`); all new runtime logic is frontend
seam code under `frontend/src/lib/native/` plus additions inside the two
existing seams (passkey credential layer, hardware adapter) — no new workspace
member, so the lockfile surface is the Capacitor packages alone.

## Complexity Tracking

No constitution violations to justify.
