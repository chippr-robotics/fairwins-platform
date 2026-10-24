# Native release operations (spec 102)

The release pipeline's obligation ends at store-ready, digest-recorded
artifacts. Everything on this page is the OPERATOR ceremony: store accounts,
signing identities, association files, review submission, rollout. None of it
is automated, because all of it involves external accounts, review timelines,
and judgments a pipeline cannot make.

## What the pipeline hands you

Per release tag, the record PR's artifact table lists per channel:
`channel · artifact · sha256 · signed`. Rules:

- The Android `.aab` is signed with the **upload key** (Secret Manager,
  spec-097 delivery). `signed: true`.
- The iOS artifact is an **unsigned** archive export (`signed: false`) — the
  Apple distribution identity is operator-held and never enters CI.
- A row exists only for an artifact whose build AND smoke job passed. A
  missing row is a failed release; do not ship around it.

Verify the digest of anything you are about to upload:
`shasum -a 256 <artifact>` must equal the record row. If it does not, you are
not holding the released bytes — stop.

## One-time setup (per tenant, per store)

1. **Apple**: App Store Connect app record under the tenant's iOS `appId`
   (from `tenants/<id>/manifest.json` → `native.ios.appId`); note the Team ID.
   Distribution certificate + provisioning profile stay in the operators'
   keychain custody — never in the repo, never in CI secrets.
2. **Google Play**: app record under `native.android.appId`. Enroll in Play
   App Signing; the CI upload key's certificate is registered there. The
   upload key itself lives in Secret Manager under the spec-097 registry.
3. **Association files** — the tenant origin must serve both documents or
   passkeys (R3) and deep links (R5) silently degrade on native:

   ```bash
   node scripts/native/generate-association-files.js --out /tmp/assoc \
     --tenant <id> --team-id <APPLE_TEAM_ID> \
     --android-cert-sha256 <UPLOAD_CERT_SHA256>
   ```

   Deploy the two files to `https://<tenant-domain>/.well-known/` (served
   `application/json`, no redirect, CDN-cacheable). Placeholder output
   (missing team id / fingerprint) is deliberately rejected by both
   platforms — fill both flags before deploying. Re-deploy whenever an appId
   or signing certificate changes.
4. **Store-policy review checklist** (before FIRST submission, spec
   assumption): the mini-app section runs verified JS in the app's own web
   runtime (permitted model on both stores) — have the spec-073 verification
   summary ready for review questions; wagering surfaces may need
   jurisdiction declarations per store program. If a reviewer objects to a
   surface, the per-tenant/platform disable switch (spec FR-014) answers it
   by configuration, not an emergency release.

## Per-release ceremony

1. Confirm the release record PR is merged and its artifact rows are green.
2. **Android**: download the recorded `.aab`, verify the digest, upload to
   the chosen Play track (internal → closed → production). Play App Signing
   re-signs for distribution; the record still pins what we built.
3. **iOS**: download the recorded archive, verify the digest, open in Xcode
   (or `xcodebuild -exportArchive`) with the distribution profile, sign, and
   upload via the organizer/Transporter. The signed IPA's digest will differ
   from the record row (signing rewrites the bundle) — the record pins the
   ARCHIVE; note the uploaded build number matches the record's version
   derivation (`major*1e6 + minor*1e3 + patch`).
4. TestFlight / internal testing tracks are consumers of the same artifacts —
   same verification, smaller audience.
5. Update the support floor when a release retires older builds: publish
   `/.well-known/fairwins-native-support.json`
   (`{ "minimumVersion": "X.Y.Z", "updateUrl": "<store page>" }`) on the
   tenant origin. Absence of the file means "no floor claimed" — the app
   shows nothing (FR-015 is honest in both directions).

## Staged manual validation (device-bound flows)

CI's emulator/simulator smoke covers launch, sign-in gating, one live read,
and the lifecycle lock re-prompt. What only a physical device proves — run
before any store submission, record outcomes on the release issue:

- Passkey ceremony end-to-end on iOS and Android hardware, INCLUDING the PRF
  output check: sign in with a web-created passkey and confirm the same
  account (addresses match). A ceremony that signs in but cannot derive keys
  is a red stop (research R3a).
- Ledger over Bluetooth per
  `docs/runbooks/hardware-wallet-staging-validation.md` (native addendum).
- A share link from a messaging app landing on the linked surface through the
  unlock gate; the same link on a clean device serving the web app.
