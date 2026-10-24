# Native release channels (spec 102)

FairWins ships on three channels — iOS, Android, and the web/PWA — from one
codebase. The native apps are Capacitor shells (`frontend/ios/`,
`frontend/android/`) serving the **bundled** production build of
`frontend/dist`; nothing is served from a remote origin
(`specs/102-capacitor-channels/research.md` R1).

## The rules that bind every change here

- **Seam-only native logic.** UI code never asks "am I native" itself:
  `frontend/src/lib/native/runtime.js` is the ONE runtime/capability seam, and
  the four native gaps are bridged inside existing seams — the passkey
  ceremony inside `lib/passkey/credentials.js`, Ledger BLE inside
  `lib/hardware/ledgerAdapter.js`, app-lock lifecycle via
  `lib/native/lifecycle.js` feeding the existing `lib/applock/appLock.js`
  events, deep links via `lib/native/deepLinks.js`. Contracts:
  `specs/102-capacitor-channels/contracts/native-runtime-seams.md`.
- **Lockfile discipline (spec 075).** Capacitor packages are pinned EXACT and
  installed only via `npm run deps:reinstall`; `check:deps` + both byte gates
  arbitrate every dependency change.
- **Version fields are sync-only.** `scripts/native/sync-native-config.js`
  writes `capacitor.config.ts` and the native version fields from the tenant
  manifest + `scripts/release/version.js`; `check-native-versions.js` fails CI
  on a hand edit.
- **One tenant, one app id.** The `native` block in `tenants/<id>/manifest.json`
  is the identity source; an unknown tenant or a tenant without the block
  fails the native build loudly — never a fallback to another tenant.
- **CSP is per-platform, never widened globally.** The web nginx policy is
  untouched; the native build injects its own CSP meta (research R7) and a
  parity gate keeps the shared directives in agreement.
- **Honest degradation.** Every native capability gap renders an in-place,
  named reason (`nativeCapability(...)` three-state) — never a silent hide,
  never a broken control.

## Build and run

See `specs/102-capacitor-channels/quickstart.md` for the full validation
guide. Short form:

```bash
npm run build --workspace frontend
node scripts/native/sync-native-config.js
cd frontend && npx cap sync android && npx cap run android   # or: ios
```

## Boot fixes log (US1)

Fixes made to let the production bundle boot in the Capacitor WebView are
recorded here as they land, each with its reasoning.

- **Pipeline proven, no code fixes needed so far**: `vite build` →
  `node scripts/native/inject-native-csp.js` → `npx cap sync android` lands
  the bundle (CSP meta included) in `android/app/src/main/assets/public/`,
  with `@capacitor/app` detected as a plugin. Runtime boot on a device is
  arbitrated by the CI smoke tier; anything it surfaces gets recorded here.
- **Mini-apps need no change for the SW-less iOS WebView (research R6
  confirmed)**: the package cache lives entirely inside `public/sw.js` as
  fetch interception — `lib/miniapps/loader.js` just calls `fetch()` and
  verifies keccak(manifest) + sha256 of every executed byte AFTER retrieval,
  so with no service worker the loader's path is simply the network path,
  same invariant. SW registration itself is guarded
  (`serviceWorkerUpdate.js`: `if (!('serviceWorker' in navigator)) return`),
  so a WebView without SW support boots clean.

## Release chain

The spec-076 release workflow builds and digest-records the `.aab`, the iOS
archive, and the web bundle per tag; store publication is an operator
ceremony — `docs/runbooks/native-release-operations.md`.

### What the CI toolchain must be (learned the hard way)

The native jobs run for the first time on a **push to `main`**, because that is the only trigger
`release.yml` has. So the first time they ever executed — the v1.16.0 attempt on 2026-09-04 — all
four failed, `Publish release` was skipped, and no version could be minted at all. Neither failure
was in product code; both were toolchain facts nothing else in CI exercises.

**Java 21, not 17.** `capacitor-android` (Capacitor 8) declares source/target compatibility 21.
An older JDK answers with `error: invalid source release: 21` at
`:capacitor-android:compileReleaseJavaWithJavac`, which reads like a project misconfiguration and
is not one. Both the artifact job and the emulator smoke job set `java-version: '21'`.

**The macOS toolchain is a floor, not a preference — and it lies when it is too low.** Capacitor 8
ships its Swift API as prebuilt XCFrameworks (`capacitor-swift-pm` resolves `Capacitor.xcframework`
and `Cordova.xcframework`, not source). An older Swift compiler reads a binary module through its
`.swiftinterface` and **silently drops every declaration it cannot parse**. What that looks like is
not "your Xcode is too old": it is

```
BluetoothLe/Plugin.swift:719: value of type 'CAPPluginCall' has no member 'reject'
CapacitorPasskeyPlugin.swift:410: value of type 'CAPPluginCall' has no member 'reject'
```

— every third-party plugin failing at once, each looking independently stale. The first reading here
was exactly that: bluetooth-le was blamed and excluded from the iOS package, whereupon passkey failed
identically. **Two current plugins failing the same way is the host, not the guests.**
`@capacitor/ios`'s own test script targets iPhone 17 / iOS 26, so the floor sits far above the
`macos-14` image's default Xcode 15.4. `native-prepare` therefore selects the newest Xcode on the
image and PRINTS it with `swift --version`, so a log always says what built the app.

**Confirmed, not inferred**: on Xcode 26.6 / Swift 6.3.3 every plugin Swift error disappeared with
BOTH bluetooth-le and passkey present in the package. Ledger over BLE works on iOS; nothing needed
excluding.

**Never name a simulator device.** The same run then failed on `name:iPhone 15`, which the Xcode 26
image does not have (its newest are iPhone 17s). A compile takes
`generic/platform=iOS Simulator`; the smoke picks the last available iPhone by UDID from
`simctl list devices available` and builds for THAT device, so the thing built and the thing booted
cannot disagree.

`scripts/native/exclude-ios-spm-plugins.js` survives that episode, unwired, for the case where a
plugin genuinely is incompatible. Reach for it only with evidence that the plugin and not the
toolchain is what fails — excluding one costs a real capability (Ledger over BLE) and the first time
it was reached for, the cause was not real.

**A check now runs before `main`.** `native-build.yml` compiles both shells on any pull request
touching what a native build reads — dependencies, either shell, the Capacitor config, the native
scripts, these workflows — and on EVERY push to `staging`, unfiltered, as the backstop for a break
no path filter predicted. It builds only: no smoke, no signing, no archive, no digest, all of which
stay in `release.yml` as the sole authority for what a release record may claim. Both compiles are
where the 2026-09-04 failures actually landed, at a fraction of the cost.

Both it and the four release jobs prepare the shell through ONE composite action,
`.github/actions/native-prepare`. That is the load-bearing part: an early check that installs,
builds, stamps or syncs differently from the release would pass while the release fails, which is
worse than having no check at all. Change the preparation in the action, never in a caller.

That paragraph is a leftover worth correcting rather than deleting, because the wrong version of it
shipped for an hour: **Ledger over BLE works in the native iOS shell.** `nativeCapability('ble')`
resolves `available` there once the BluetoothLe plugin registers itself, and it is the WEB build on
iOS Safari that has no Bluetooth to offer — a browser limitation, not a shell one. Had the plugin
been excluded, the seam would have reported the native shell unavailable too and
`NativeCapabilityNotice` would have rendered that reason in place; honest, but a capability lost to
a cause that was not real.
