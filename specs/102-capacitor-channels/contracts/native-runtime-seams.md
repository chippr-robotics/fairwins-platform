# Contract: Native Runtime Seams

The four seams the native channels add or extend. Each is a contract the
implementation and its tests must satisfy; UI code touches ONLY these seams.

## 1. Runtime seam — `frontend/src/lib/native/runtime.js`

- `getRuntime(): 'web' | 'native-ios' | 'native-android'` — resolved from the
  packaging layer, memoized, never a user-agent sniff. THE single source every
  native-conditional reads.
- `nativeCapability(name): { state: 'available' } | { state: 'unavailable', reason }`
  for `passkey-ceremony` | `ble` | `deep-links`. `unavailable` ALWAYS carries a
  member-renderable reason; the seam never fabricates `available` ahead of the
  underlying plugin confirming (constitution III).
- On `web`, every capability answers from the existing web checks — this seam
  wraps, it does not fork.

## 2. Passkey ceremony bridge — inside `frontend/src/lib/passkey/credentials.js`

- Selection: `getRuntime() === 'web'` → existing `navigator.credentials`
  path, byte-for-byte unchanged. Native → the bridge.
- Bridge contract: `create(options)` / `get(options)` take the SAME
  WebAuthn-shaped option objects the web path builds (rp id = tenant origin
  domain) and return the SAME attestation/assertion shapes the credential
  layer already parses — callers above this file cannot tell which rail ran.
- PRF/extension outputs the wallet derivation depends on MUST round-trip
  through the bridge or the ceremony MUST refuse with a named reason —
  a passkey that signs in but cannot derive keys is a corrupted account state,
  not a degraded one.
- Unavailability (OS floor, no platform authenticator, Play-services gap)
  surfaces as the seam's `unavailable(reason)`, rendered in place; the
  system-browser ceremony is the disclosed fallback, never silent.

## 3. Ledger BLE rung — inside `frontend/src/lib/hardware/ledgerAdapter.js`

- The rung slots into the existing transport ladder exactly where
  `TransportWebBLE` sits for web: selected when `getRuntime()` is native and
  `nativeCapability('ble')` is `available`.
- It yields a transport object satisfying the same interface the Ledger app
  bindings consume (`exchange(apdu): Promise<Buffer>`, `close()`), implemented
  over the native BLE plugin with the Ledger BLE service/characteristic
  framing.
- ALL failures normalize to the existing `HW_ERROR_CODES` and render through
  `describeHardwareError` — a raw plugin/SDK message reaching a member is a
  contract violation. Permission-denied and radio-off map to distinct codes
  with recovery guidance (spec Story 4, scenario 2).
- Everything above the transport is untouched: `HardwareSigner`'s
  recover-and-verify before broadcast, `connectAccount.js` re-derive-and-match
  on reconnect, metadata-only store.

## 4. Lifecycle adapter — `frontend/src/lib/native/lifecycle.js`

- Subscribes to the packaging layer's app-state events and emits the SAME
  hide/show activity events `lib/applock/appLock.js` consumes from
  `visibilitychange` on web. No thresholds, no policy, no storage here — pure
  event mapping (that is what makes it unit-testable).
- Cold start after process death takes the normal boot path, which already
  gates; the adapter does nothing special for it.
- On `web`, the adapter is inert (never double-fires alongside
  `visibilitychange`).

## 5. Deep-link seam — `frontend/src/lib/native/deepLinks.js`

- Maps an incoming universal/app link URL to the SPA route/path and hands it
  to the existing navigation; unroutable URLs fall through to the home surface
  with nothing claimed.
- If the sign-in/lock gate is up, the destination is held as the pending deep
  link (see data-model) and consumed exactly once after the gate clears.
- Only the tenant's own origin URLs are accepted from the link channel;
  anything else is ignored (never opened, never navigated).
- **Both link channels are read.** `appUrlOpen` only fires for a link arriving
  while the app already runs; the link that *launched* the app is consumed by
  the platform before any listener exists and is readable only from
  `App.getLaunchUrl()`. A URL reported down both (Android does; iOS reports
  only the launch one) is delivered exactly once, and the de-duplication is
  single-use so a member deliberately re-opening the same link still
  navigates.

## Native CSP parity gate

- The native build injects a CSP `<meta>` into the bundled `index.html`; a
  Vitest gate asserts the shared directives (`connect-src`, `script-src`,
  `img-src`, `frame-src`) agree with the nginx policy per the R7 rules —
  `script-src` carries `blob:` (mini-app packages) and never `https:`;
  `connect-src` keeps the spec-069 grants. The web nginx files are byte-
  untouched by this feature.
