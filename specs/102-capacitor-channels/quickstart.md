# Quickstart: Native Release Channels

Validation guide — how to build, run, and prove the feature end-to-end.
Details live in [plan.md](./plan.md), [research.md](./research.md), and
[contracts/](./contracts/).

## Prerequisites

- Repo installed via `npm run deps:reinstall` (NEVER `npm install` — spec 075).
- Android: JDK 17 + Android SDK (API 29+); an emulator or device.
- iOS (macOS only): Xcode 15+; a simulator or device.
- No secrets needed for local debug builds; release signing is CI/operator-only.

## Build and run (default tenant)

```bash
# 1. Web assets + native config (tenant + cohort + version → shells)
npm run build --workspace frontend
node scripts/native/sync-native-config.js            # writes capacitor.config.ts + native version fields

# 2. Sync assets into the shells
npx cap sync android    # from frontend/
npx cap sync ios

# 3. Run
npx cap run android     # or open in Android Studio
npx cap run ios         # or open in Xcode (macOS)
```

Expected: the app launches to the FairWins sign-in surface with the tenant's
name/icon; version shown in-app matches `scripts/release/version.js`.

## Seam validation (fast, no device)

```bash
npx vitest run src/test/native/                      # runtime seam, lifecycle mapping, deep-link routing, CSP parity gate
node scripts/native/check-native-versions.js         # regenerate-and-diff: native version fields match version.js
npm run tenants:validate                             # native block schema + cross-tenant appId uniqueness
npm run check:deps                                   # lockfile still carries the platform rolldown binary
```

Expected: all pass; editing a native version field by hand makes
`check-native-versions` fail naming the field.

## Device validation (per platform)

1. **Passkey**: sign in with a passkey created on the web channel — same
   account (address matches). On an unsupported device, the ceremony refuses
   with a named reason, not a spinner.
2. **App lock**: background the app past the lock threshold; foregrounding
   shows the re-prompt before any wallet surface.
3. **Deep link**: open a wager share link from a messaging app → lands on that
   wager in-app (through the unlock gate, destination preserved). Uninstalled:
   the same link serves the web app.
4. **Ledger (hardware present)**: pair over Bluetooth, verify address on the
   device, sign one transaction; deny the Bluetooth permission and confirm the
   named, recoverable error. (Staged manual protocol — recorded as such in the
   coverage matrix.)
5. **Mini-apps**: launch Token Mint; bytes verify and the app runs (no service
   worker on iOS is a latency difference only — see research R6).

## Release-chain validation (CI, test tag)

Cut a test release tag on a scratch branch and verify:

- `android-artifact`, `ios-artifact`, `native-smoke-*` jobs all run and gate.
- The record PR lists three channel rows with sha256 digests; the `signed`
  column is honest (`true` Android, `false` iOS CI export).
- Delete a required signing secret in a scratch env → the Android job FAILS
  naming the secret (never an unsigned artifact published silently).

## Tenant validation

```bash
VITE_TENANT_ID=<test-tenant> node scripts/native/sync-native-config.js
```

Expected: shells carry that tenant's appId/name only; an unknown tenant id or
a tenant without a `native` block fails loudly naming the tenant.
