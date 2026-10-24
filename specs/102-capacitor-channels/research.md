# Research: Native Release Channels

Decisions R1–R8. Each records what was chosen, why, and what was rejected.

## R1 — Packaging technology: Capacitor with bundled assets

**Decision**: Capacitor (`@capacitor/core`/`cli` + platform packages), serving
the **built `frontend/dist` bundled into the app package** — not a remote-URL
shell pointing at the web origin.

**Rationale**: Capacitor is the only mainstream path that ships the existing
WebView-run React codebase as store apps without a rewrite, and it is the
successor to the Cordova model with first-party plugins for exactly the four
gaps this spec names (lifecycle, deep links, BLE via community plugin,
native credential bridging via plugin). Bundled assets are required for two
reasons: store policy (a thin wrapper around a remote site is rejectable on
both stores) and integrity (the release record can digest the exact bytes the
app runs; a remote shell would decouple the artifact from its content and
make the digest a lie). Bundling also keeps the PWA's offline posture.

**Alternatives considered**: React Native / Flutter — a rewrite of a very
large, seam-rich frontend; rejected outright. Remote-URL Capacitor shell —
rejected per above (policy + digest honesty). PWA-only via store PWA wrappers
(TWA on Android) — Android-only, no iOS answer, and no native passkey/BLE
bridge; rejected.

## R2 — OS floors: iOS 16+, Android 10+ (API 29+)

**Decision**: Deployment targets iOS 16.0 and Android API 29, with the passkey
ceremony additionally feature-detected at runtime (Android passkey support is
a Play-services capability, not an API level).

**Rationale**: The wallet is the product and the passkey ceremony is its key
custody (spec assumption). iOS 16 is where platform passkeys (
`ASAuthorizationPlatformPublicKeyCredential`) ship; Android's Credential
Manager backports passkeys via Google Play services on API 28+, so the floor
is set by healthy WebView + BLE + maintained-device reality at API 29, with
runtime detection carrying the honest refusal on devices whose Play services
cannot do passkeys (spec Story 2, scenario 3).

**Alternatives considered**: iOS 15 (WebAuthn partial, no platform passkey
API) — rejected; higher floors (iOS 17/API 34) — excludes devices for no
capability gain; rejected.

## R3 — Passkey ceremony on native: native credential bridge behind the existing credential layer

**Decision**: In the native apps, the passkey create/get ceremonies run
through a Capacitor plugin that calls the platform credential APIs (iOS
AuthenticationServices; Android Credential Manager), selected inside
`frontend/src/lib/passkey/credentials.js` by the `lib/native/runtime.js`
seam. The relying-party identity stays the **tenant's web origin domain**,
proven to the OS by the tenant origin hosting the platform association files
(Apple App Site Association `webcredentials`; Android `assetlinks.json`) —
the same files R5's deep links require.

**Rationale**: The in-WebView `navigator.credentials` path is not a reliable
citizen inside an embedded WebView on either platform; the platform APIs are
the supported route and — critically — because the RP id is the tenant
domain, **the same passkey works on web and native** (spec FR-003: same
account, same addresses). The bridge produces the same WebAuthn-shaped
attestation/assertion objects the existing credential layer already consumes,
so everything above `credentials.js` (PRF-derived keys, smart account,
signing) is untouched. Which concrete plugin (an audited community plugin vs
a thin in-repo plugin over the two platform APIs) is a tasks-stage choice
with a security review either way; the contract it must satisfy is pinned in
`contracts/native-runtime-seams.md`.

**Alternatives considered**: Remote ceremony via system browser tab
(ASWebAuthenticationSession / Custom Tabs) — works but bounces the member out
of the app for every unlock re-prompt; rejected for UX on the app-lock path,
kept as the disclosed fallback when the platform ceremony is unavailable.
In-WebView `navigator.credentials` as primary — unreliable/unsupported;
rejected.

## R3a — Bridge choice: `@capgo/capacitor-passkey` (pinned 8.5.1) behind an in-repo adapter

**Decision**: The platform ceremony runs through `@capgo/capacitor-passkey`
(Cap-go, the established Capacitor plugin vendor; Capacitor 8; WebAuthn-shaped
`createCredential`/`getCredential` taking browser-shaped options and returning
WebAuthn-JSON), wrapped by `frontend/src/lib/native/nativeCredentials.js` — a
`navigator.credentials`-shaped adapter consumed through the credential layer's
existing `deps.credentials` seam.

**Why the adapter is not optional**: reading the plugin source found two
encoding hazards the contract's PRF rule exists for. (1) The plugin JSON-clones
request extensions (`JSON.parse(JSON.stringify(...))`), which mangles a
`Uint8Array` PRF salt into an index-keyed object — the adapter pre-encodes
binary extension leaves to WebAuthn-JSON base64url strings, which the clone
carries losslessly. (2) Responses arrive as WebAuthn-JSON strings while the
credential layer reads API shapes (buffers, `getPublicKey()`,
`getClientExtensionResults()`) — the adapter decodes, including
`prf.results.first/second`. Both are pinned by
`src/test/native/passkeyBridge.test.js`.

**Security review**: this dependency sits on the key-custody path and needs
the `.github/agents` smart-contract-security-adjacent review posture on the PR
that ships it; the PRF round-trip on REAL devices (iOS 18+ exposes PRF via
AuthenticationServices; Android via Credential Manager) is part of the staged
manual validation protocol — until a device run confirms PRF output, native
sign-in for prf-derived wallets must be treated as unvalidated.

**Alternatives considered**: in-repo thin plugin over the two platform APIs —
full control but ships Swift/Kotlin this repo cannot compile-verify outside
the CI platform jobs; kept as the fallback if the vendor plugin's PRF support
proves insufficient on device. Older community plugins
(`@darkedges/capacitor-native-webauthn`, `capacitor-native-passkey`) — pinned
to Capacitor 4/5; rejected.

## R4 — App lock on native lifecycle: adapter onto the existing activity events

**Decision**: `lib/native/lifecycle.js` subscribes to Capacitor
`App.appStateChange` (+ `pause`/`resume`) and emits the exact
hide/show events the existing `lib/applock/appLock.js` policy already
consumes from `visibilitychange`, so the lock policy itself does not change.
Process restart lands on the normal cold-start path, which already gates.

**Rationale**: The 041-amendment lock overlay and its policy are tested and
shipped; the only native gap is that a backgrounded WebView does not reliably
fire `visibilitychange`. Mapping lifecycle → the same events keeps ONE policy
implementation (no fork of thresholds or re-prompt logic) and makes the
Vitest for this seam a pure event-mapping test.

**Alternatives considered**: A second, native-specific lock policy —
duplicate thresholds drifting apart; rejected.

## R5 — Deep links: universal/app links on the tenant domain, destination preserved through the gate

**Decision**: iOS Universal Links + Android App Links bound to the tenant's
web origin domain (AASA `applinks` + `assetlinks.json` — co-hosted with R3's
credential associations). `lib/native/deepLinks.js` maps `App.appUrlOpen` to
the SPA route and hands it to the existing navigation; the lock/sign-in gate
already preserves an intended destination, and the seam test proves a link
arriving while locked lands post-unlock.

**Rationale**: The links members share ARE web URLs; universal/app links make
the same URL serve both channels (spec Story 5) with no new URL scheme to
leak into shared content. Custom schemes are kept out of shared surfaces
entirely (they break for non-installed recipients).

**Alternatives considered**: Custom URL scheme as the primary — breaks the
uninstalled-recipient path and is spoofable on Android; rejected as primary
(the scheme Capacitor registers by default stays as an internal fallback
only).

## R6 — Mini-apps on native: same loader, service-worker cache treated as absent

**Decision**: The mini-app platform runs unchanged in the native WebView with
one posture adjustment: the loader's service-worker package cache is treated
as an optional accelerator that may be entirely absent (iOS WKWebView does
not offer service workers to embedded WebViews without entitlements this
plan does not take). Every launch already re-verifies keccak(manifest) against
the chain and sha256 of every executed/injected byte after retrieval — cache
or network — so the trust invariant (nothing unverified ever runs) is
unaffected; the cost of no SW is a network fetch per launch, disclosed by
nothing because it changes no behavior, only latency.

**Rationale**: Spec-073's verification deliberately does not trust the cache;
that design is exactly what makes native viable without new machinery. The
native CSP (R7) must still carry `blob:` in `script-src` for verified package
bytes.

**Alternatives considered**: App-Bound Domains entitlement to enable SW on
iOS — constrains the WebView to a fixed domain list, which collides with
bring-your-own-node and buys only a cache; rejected. Disabling mini-apps on
native — unnecessary given the invariant holds; the per-platform disable
switch (spec FR-014) exists as store-policy contingency, config-only.

## R7 — CSP on native: per-platform policy in the bundled index, web nginx untouched

**Decision**: The web channel's nginx CSP files do not change. The native
build injects a `<meta http-equiv="Content-Security-Policy">` into the
bundled `index.html` at native-build time, stating the same policy adjusted
for the native origin (the WebView serves assets from the Capacitor local
origin; `connect-src` keeps the existing `https:` + loopback grants — the
spec-069 bring-your-own-node reasoning applies identically; `script-src`
keeps `blob:` for mini-app packages and gains nothing else). A Vitest gate
asserts the native meta policy and the nginx policy agree on the directives
they share, so the two cannot drift silently — mirroring the existing
`nginxCspConnectSrc.test.js` pattern.

**Rationale**: Spec FR-012 — no global widening; a native runtime needs its
own statement of the same rules, scoped to the native artifact, with a gate
instead of a convention.

**Alternatives considered**: One shared CSP file consumed by both — nginx
headers and a meta tag have different capabilities (frame-ancestors etc.), so
"shared" becomes "lowest common denominator"; rejected in favor of two
statements + a parity gate.

## R8 — Release chain: two platform jobs, digest-recorded; store publication is an operator ceremony

**Decision**: The spec-076 release workflow gains `android-artifact` (Ubuntu:
Gradle `bundleRelease` → `.aab`, signed with the upload key delivered from
Secret Manager via the spec-097 mechanism) and `ios-artifact` (macOS:
`xcodebuild archive` → export; **unsigned** export in CI, since Apple signing
is certificate + provisioning material the operators hold — signing and store
upload are the runbook ceremony). Both jobs and the native smoke jobs gate
the release; the record PR's digest table gains rows for the two native
artifacts next to the web bundle. `scripts/native/sync-native-config.js`
writes versionName/versionCode and CFBundleShortVersionString/build from
`scripts/release/version.js` (build number = monotonic derivation from the
version, one source), and `check-native-versions.js` is the regenerate-and-
diff gate that keeps hand edits out.

**Rationale**: Spec Story 3 + FR-008/FR-009; the split between CI-built
artifacts and operator-performed store publication is the spec's recorded
assumption, and unsigned iOS export is the honest boundary of what a CI
runner without the operators' Apple identity can produce (its digest still
pins the archive bytes).

**Alternatives considered**: CI-side iOS signing with certs in Secret
Manager — puts the Apple distribution identity in the shared cloud project
and couples releases to certificate rotation; rejected for launch, revisit if
release cadence makes the manual step the bottleneck. Fastlane — extra
toolchain + Ruby surface for what two `xcodebuild`/`gradle` invocations do;
rejected for launch.
