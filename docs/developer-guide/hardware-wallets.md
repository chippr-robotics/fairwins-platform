# Hardware wallets (Protect ▸ Off chain, spec 087)

Members keep long-term funds on a Ledger or Trezor and see those accounts inside FairWins: add
them through a guided flow, watch their balances, receive to them from every address field, and —
when they choose to act as one — sign with the device itself, confirming every action on its own
screen. It is a **frontend-only** feature: no contracts, no gateway, no subgraph.

A third vendor, **Sigil** (MPC signer, floppy-held presignatures, reached through a loopback
bridge), rides the same seam — see [Sigil cold signer](sigil-cold-signer.md) for what differs.

The point of a hardware wallet is that its keys never touch a browser. Everything below follows
from taking that seriously.

## Where it lives

| Concern | Module |
|---|---|
| The vendor seam (`connectHardware`, `vendorAvailability`, `detectTransports`, `ledgerTransportKind`) | `frontend/src/lib/hardware/adapters.js` |
| Connect copy derived from the chosen transport (`connectGuidance`) | `frontend/src/lib/hardware/connectCopy.js` |
| Ledger adapter (WebHID/Web Bluetooth/WebUSB + `@ledgerhq/hw-app-eth`) | `frontend/src/lib/hardware/ledgerAdapter.js` |
| Trezor adapter (`@trezor/connect-web` popup) | `frontend/src/lib/hardware/trezorAdapter.js` |
| Typed failure vocabulary (`HW_ERROR_CODES`, `describeHardwareError`) | `frontend/src/lib/hardware/errors.js` |
| Derivation-path schemes | `frontend/src/lib/hardware/derivations.js` |
| Device-backed signer (viem; ethers-shaped for its callers) | `frontend/src/lib/hardware/hardwareSigner.js` |
| Reconnect a saved account (re-derive + match) | `frontend/src/lib/hardware/connectAccount.js` |
| Backup-synced store (public metadata only) | `frontend/src/lib/hardware/hardwareAccountsStore.js` |
| Per-owner CRUD facade (`hardwareWalletVault`) | `frontend/src/lib/hardware/hardwareAccounts.js` |
| React projection of the store | `frontend/src/hooks/useHardwareAccounts.js` |
| Protect surface (accordion + list + add wizard) | `frontend/src/components/custody/{CustodyPanel,HardwareWalletSection,AddHardwareWalletSheet}.jsx` |
| Reconnect-to-act-as dialog | `frontend/src/components/account/HardwareConnectDialog.jsx` |
| Operate-as wiring | `frontend/src/contexts/CustodyContext.jsx` + `frontend/src/hooks/{useActiveAccount,useAccountSwitcher}.js` |
| Audit records (no secrets) | `frontend/src/data/ledger/sources/hardwareWalletSource.js` |
| Backup domain registration | `frontend/src/lib/backup/syncedObjects.js` (`hardwareAccounts`) |

## The adapter seam

**UI code never imports a vendor module.** Everything above `adapters.js` — the add wizard, the
reconnect dialog, the signer — talks to one session interface:

```
connectHardware(vendor) → {
  vendor, getAddress(path, { display }), getAddresses(paths),
  signPersonalMessage(path, bytes), signTypedData(path, payload),
  signTransaction(path, unsignedSerialized, txFields), close()
}
```

Three reasons the seam is absolute:

- **Lazy loading.** Vendor SDKs are heavy and most members never open the flow; they are
  `import()`ed only inside `connectHardware`. A static import from UI code would put them in the
  main bundle.
- **Failure normalization.** Every vendor error is classified into `HW_ERROR_CODES` before it
  leaves the layer (`classifyLedgerError` maps transport names + APDU status words like `0x6511`;
  `classifyTrezorError` maps Connect payloads). The UI renders `describeHardwareError` verbatim
  and never a raw SDK message (FR-012).
- **Testability.** Component tests hand mock adapters through the `deps` props
  (`{ connect, availability, guidance, provider }` on the sheet,
  `{ connectAccount, guidance }` on the dialog); nothing needs hardware (FR-013).

The two vendors differ underneath and the seam absorbs it: Ledger is local — WebHID, Web Bluetooth
or WebUSB (see below), one APDU at a time, and the adapter probes one address at connect time so
"locked" / "wrong app" surface in the step whose UI explains them. Trezor runs vendor code in a trezor.io
popup; `TrezorConnect.init` is once-per-page (memoized, with a retry path after a failed init such
as a blocked popup), `getAddresses` is one popup round-trip for a whole page, and `close()` is a
no-op because the popup lifecycle is per-call. The caller owns the session and must `close()` it
when the flow ends — the sheet's teardown does — so the transport is released for other tabs.

### Which rail a Ledger uses (and why the copy follows it)

Transport selection is **capability-driven and lives inside the adapter** — `ledgerTransportKind`
in `adapters.js`, read from `navigator`:

| Browser exposes | Rail | Who that is |
|---|---|---|
| `navigator.hid` | `webhid` | any desktop Chromium — **exactly the transport it always used** |
| no `hid`, `navigator.bluetooth` | `webble` (`@ledgerhq/hw-transport-web-ble`) | Android Chrome |
| no `hid`, no `bluetooth`, `navigator.usb` | `webusb` | fallback for a browser with only that |
| none of the three | *(none)* | iOS Safari, old browsers — a stated refusal |

Bluetooth is ranked **above** WebUSB but only where WebHID is absent. Android Chrome exposes
WebUSB too, yet reaching a Ledger that way needs an OTG cable, while BLE is the rail a Nano X
actually offers a phone. A desktop keeps WebHID, so nothing about the existing flow moves.

Two consequences that are easy to get wrong:

- **Copy is derived, never assumed.** `connectCopy.js#connectGuidance(vendor)` returns the vendor
  hint, the connect checklist and the reconnect sentence for the rail that would actually open.
  "Plug the device into this computer" is *false* on a phone pairing over Bluetooth, and a member
  who follows it concludes the feature is broken — so every hardware-connect string in the UI
  comes from that one function. A component that hardcodes a sentence is the bug this prevents.
- **Trezor has no Bluetooth rail and is untouched by any of this.** Its `transport` is `null`, its
  copy is the same as it ever was, and it must never claim a capability the vendor lacks.

Everything above the adapter stays transport-agnostic: the session shape is identical on either
rail, which is what lets `HardwareSigner` sign without knowing how the bytes reach the device. The
session carries a `transport` field for diagnostics only — nothing branches on it.

No header change was needed: `bluetooth` is a policy-controlled feature whose default allowlist is
`self`, and `frontend/nginx.conf`'s `Permissions-Policy` lists only the features it restricts — the
same reason WebHID and WebUSB already work without appearing there. Do not "fix" this by adding
`bluetooth=(self)` alone; the header is an allowlist of *stated* features and rewriting it changes
the others.

BLE-specific failures land in the existing vocabulary rather than a new one: a dismissed pairing
chooser is `permission-denied` (`TransportOpenUserCancelled`, or a raw `NotFoundError` /
`NotAllowedError` DOMException), a link dropping mid-session is `disconnected` (a GATT
`NetworkError`, same member-visible fact as a yanked cable), and the radio being switched off is
`bluetooth-unavailable` — checked with `navigator.bluetooth.getAvailability()` **before** any
chooser appears, because a chooser that can never find a device also reads as a broken feature.

One deliberate privacy choice in the Ledger adapter: `signTransaction` passes `null` resolution,
skipping Ledger's remote clear-signing metadata service. No external call is made from the app;
the device falls back to on-screen review of the raw fields.

## The security model

- **Public metadata only, ever.** A saved account is `{ address, vendor, path, label, addedAt }`
  (FR-005). No key material, no seed, no xpub, no device identifier beyond the vendor name — the
  record is deliberately too little to fingerprint a device. Discovery asks the device for each
  address individually; no xpub leaves it.
- **Every signature is a physical confirmation.** `HardwareSigner` routes `signMessage`,
  `signTypedData`, and `signTransaction` through the device, so each call is a ceremony on the
  device's own screen. Nothing here can sign silently; that is the security property, not a
  limitation.
- **Recover-and-verify before broadcast.** After the device signs a transaction, the signer
  recovers the sender from the serialized signature and compares it to the expected address. A
  vendor-layer mixup (wrong path, wrong account) can never broadcast silently from someone else's
  account — it becomes a stated error instead.
- **Reconnect re-derives and must match.** `connectHardwareAccount` asks the connected device for
  the saved path's address and refuses if it differs from the saved one: a different device (or a
  different passphrase on the same device) yields a different account, and silently acting as the
  wrong one is exactly the failure the check exists to prevent.
- **Removal forgets the reference, not the funds.** The confirm says so (FR-008), and re-adding a
  known address updates its label instead of duplicating (FR-011, case-insensitive throughout).

## Two derivation schemes, both offered

`derivations.js` defines the two Ethereum conventions that cover effectively every Ledger/Trezor
account in the wild:

| Scheme id | Path | Who created accounts there |
|---|---|---|
| `live` | `m/44'/60'/i'/0/0` | Ledger Live (account per hardened index) |
| `bip44` | `m/44'/60'/0'/0/i` | Trezor, MEW, MyCrypto, pre-Live Ledger tooling |

Which one a member's funds sit on depends on which tool originally created the account — so the
picker starts on the vendor's own default (`defaultSchemeFor`) and lets the member switch rather
than guessing. Rows show address + native balance on the connected network (balance reads are
`Promise.allSettled`; an unreadable balance renders "—", never a zero), page in fives, and mark
already-saved addresses.

## Operate-as (the spec-062 recipe)

A saved hardware account is a first-class acting identity, exactly like a recovered legacy
account:

1. `useAccountSwitcher` lists it (`kind: 'hardware'`) alongside personal / vault / legacy.
2. **Choosing it switches instantly, address-only (spec 088)** — no device ceremony at switch
   time. The public address is enough to view, receive, and navigate as the account; balances
   everywhere follow it through `useEffectiveAccount`.
3. The device ceremony is DEFERRED to the moment a signature is needed:
   `useActiveAccount.submit` (and message signing) asks the CustodyContext **broker**
   (`requestActingSigner`), and the globally-mounted `SignerRequestHost` renders
   `HardwareConnectDialog` right then (`connectHardwareAccount` — re-derive + match, above).
   Cancelling the dialog rejects that one action with a stated reason.
4. `CustodyContext` holds the attached `HardwareSigner` **in memory only** — never persisted,
   never serialized, cleared on any identity change. It holds no key material (the device does),
   but it wraps a live transport session, so it is session-scoped like the legacy signer.
5. The chain binding belongs to the SIGNER, set at ceremony time — a `{ chainId, client }`
   binding, from which the signer resolves its own read client through the spec-069 seam
   (`connectHardwareAccount({ entry, chainId })`). If the wallet has switched networks since,
   submit DROPS the stale signer and re-runs the ceremony (binding to the current chain) instead
   of refusing with a "switch back" error. A signer built with NO binding can still sign — which
   is what the emulator suite does — but `sendTransaction` has no network to populate from or
   broadcast to, and says so rather than guessing one.

After a reload or unplug the in-memory session is gone and the member reconnects — there is
nothing to restore, by design.

## Honest failure vocabulary (FR-012)

Every connect/derive/sign path ends in a stated, human-readable outcome — never a hanging spinner,
never a silent close, never a raw SDK message:

| Code | Rendered sentence (summary) |
|---|---|
| `transport-unsupported` | this browser cannot reach the device over USB **or Bluetooth** — Chromium on a computer, Chrome + Bluetooth on Android, and iPhone/iPad cannot at all |
| `bluetooth-unavailable` | Web Bluetooth exists but the radio is off or blocked — turn Bluetooth on |
| `permission-denied` | the browser prompt was dismissed (USB chooser or Bluetooth pairing) — choose the device to continue |
| `device-locked` | unlock with your PIN and try again |
| `wrong-app` | open the Ethereum app on the device |
| `user-cancelled` | the request was cancelled on the device |
| `disconnected` | the device was disconnected — reconnect and try again |
| `timeout` | the device did not respond in time |
| `popup-blocked` | the vendor window could not open or did not respond — allow popups |
| `unknown` | something went wrong talking to the device |

`vendorAvailability` applies the same rule before anything connects: a vendor the browser cannot
reach renders **disabled with the reason**, never as a dead control (FR-003).

At the UI boundary, errors are rendered through **`reportHardwareError`**, not
`describeHardwareError`: the member still sees only the sentence, but the RAW failure (with its
`cause`) is logged as a `[hardware-add]` / `[hardware-connect]` console line. This exists because
the first staging validation reported both vendors failing "with no relevant logs" — the sentence
was honest, but the swallowed cause made the field report undiagnosable.

## Node globals and bundler interop (the staging connect failures)

Both vendors failed to connect in the first staging round, from two bundling gaps that no
dev-side flow could reach (Cypress and the capture harness drive the test-adapter seam; only a
real browser executing the BUILT bundle runs the vendor SDK bytes):

1. **The SDKs assume Node globals.** `@ledgerhq/*` and `@trezor/*` call `Buffer.*` bare; Vite
   externalizes the Node built-in to an empty stub, so the first device exchange threw
   `ReferenceError: Buffer is not defined`. Fix: `lib/hardware/nodeShims.js#ensureNodeGlobals` —
   `connectHardware` installs the npm `buffer` polyfill (and `global`) **before any vendor module
   loads**. It is deliberately lazy: the rest of the app never gains a Buffer global to lean on.
2. **Double-default interop.** In the production bundle `@trezor/connect-web`'s instance sits at
   `mod.default.default` (dev serves it at `mod.default`), so `TrezorConnect.init` was
   `undefined`. Fix: the adapter resolves the export **by capability** (the object that has
   `.init`), never by wrapper shape.

Both are pinned by `src/test/hardware/stagingRegressions.test.js`, and
`scripts/ui/verify-hardware-bundle.mjs` proves the whole path against the built bundle served
with the REAL nginx CSP/Permissions-Policy headers (run it after any dependency or build-config
change touching this area). `frame-src` grants `https://connect.trezor.io` for the Connect
bridge frame; `Permissions-Policy` needs no change (unlisted features like `hid`/`usb` keep
their default `self` allowlist).

## The Protect accordion and deep links

Protect's three areas — On chain, Verify, Off chain — are `AccordionSection`s in one exclusive
`AccordionGroup` (the Recovery/Settings pattern), each with a one-line live summary while
collapsed (vault count, last verify outcome, hardware account count). The section ids —
**`custody-onchain` / `custody-verify` / `custody-offchain`** — double as the drawer-search
attention/deep-link ids (`navSearchIndex` entries with `hash: '#custody-<x>'`; `CustodyPanel`'s
`openSection` prop is the hash-driven card the page asks to land open). Renaming a section id
breaks search deep links, so don't.

## Backup semantics

The store rides the spec-032 backup as the `hardwareAccounts` synced object. It is **not
network-scoped** — a hardware EOA address is the same on every EVM chain, so entries are keyed by
lowercased address alone. Restore-merge is `mergeHardwareAccounts`: union by address, and where
both sides know the same address the entry with the newer `addedAt` wins; a vendor/path
disagreement is surfaced as an informational conflict, not an error. There is no key material in
the value — that is why this synced object needs no encryption beyond what the backup itself
provides.

## Audit and notifications

Adding and removing accounts each append one client-ledger record
(`hardware_account_added` / `hardware_account_removed`; `refs` = address + vendor + path only)
with a **stable entryId per (event, chain, address)**, so re-adding is idempotent
(`appendClientRecord` no-ops on an existing id). Both actions also toast. Audit and the
address-book upsert are best-effort: a failure in either must never lose the saved account.

## The DEV-only test seam

In DEV builds, a capture harness or e2e run may plant `window.__fwHardwareTestAdapter__(vendor)`
and `connectHardware` uses it instead of real vendor code. The guard is `import.meta.env.DEV`,
which Vite replaces with a constant — **production bundles contain no test path at all**, because
dead-code elimination removes the branch (constitution III: no mocks in shipped paths). Do not
replace the guard with a runtime flag; the whole point is that the branch does not exist in the
shipped artifact.

## Browser support

| Browser | Ledger | Trezor |
|---|---|---|
| Chromium (Chrome, Edge, Brave, …) | ✅ WebHID (or WebUSB) | ✅ Connect popup |
| Firefox / Safari | ❌ no WebHID/WebUSB — option disabled with the reason | ✅ Connect popup |

Trezor needs only a window (the popup does the device talking on the vendor's side); a blocked
popup surfaces as a stated permission failure and init is retryable.

## Deliberately out of scope

- **Bitcoin/Solana hardware accounts.** Ethereum-family paths only (`coin_type 60'`); spec-061
  Bitcoin keys remain passkey-seed-derived and are a separate system.
- **Silent signing.** There is no path that signs without a device confirmation, and none should
  ever be added.
- **Key export / xpub storage.** Nothing secret exists in the app to export, and discovery is
  per-address precisely so no xpub is ever held.

See `specs/085-hardware-wallet-protect/` for the spec, and
`docs/runbooks/hardware-wallet-staging-validation.md` for the real-device validation checklist.

## Testing against real device firmware (Speculos)

Every other hardware suite mocks the session, which means it answers a question the device no
longer asks: a fake that signs with an ethers `Wallet` key proves the signer's own arithmetic and
nothing about the APDUs, the derivation path the device really used, or what the member would have
been shown before approving. `lib/hardware/speculosTransport.js` closes that gap.

**Speculos** is Ledger's own emulator — real app firmware, real APDUs, real screens — reached over
HTTP instead of USB. The confirmation gate is therefore *kept and automated*, not removed, which is
what makes this a hardware test rather than a mock with extra steps.

```bash
cd frontend
npm run hw:speculos:up     # builds the Ethereum app from a pinned ref, boots the emulator
npm run test:hw            # the device suite
npm run hw:speculos:down
```

### Rules that are not negotiable

- **The rail is DEV-only.** It aims signing at an arbitrary HTTP origin, so every path to it sits
  behind `import.meta.env.DEV` and is dead-code-eliminated from a release build. No capability
  probe returns `speculos`; a caller must ask for it by name. `src/test/hardware/speculosSeam.test.js`
  enforces both, and fails if the guard is removed.
- **No new dependency.** `@ledgerhq/hw-transport` is already direct, and the APDU endpoint is plain
  HTTP, so the transport is one file. Adding `@ledgerhq/device-transport-kit-speculos` or
  `hw-transport-node-speculos-http` would re-resolve the root lockfile, which is the npm/cli#4828
  rolldown hazard (spec 075) — a bad trade for a test rail.
- **The seed is the public BIP-39 vector and must stay empty.** A funded seed in a script any
  contributor can run is a seed that gets drained.
- **Green here is not firmware certification.** Speculos is not the Secure Element; syscalls, the
  watchdog and timing differ. It proves the protocol and the screen flow. USB/BLE quirks and
  firmware drift remain the physical soak in
  `docs/runbooks/hardware-wallet-staging-validation.md`.

### Two traps that cost real time, written down so they cost nobody else any

Speculos' `--automation` rules look like the obvious way to replace the button press. They cannot
express what this needs, and both failures are silent:

1. **`text` is an exact match, not containment.** The approve screen reads `Sign transaction`, so a
   rule written `{ "text": "Sign" }` never fires — and nothing errors. The catch-all keeps pressing
   right, the carousel loops, and the APDU never returns, so the suite *hangs* until a timeout.
2. **Rules fire per TEXT EVENT, not per screen** (`seproxyhal.apply_automation` loops over every
   event in the batch). One screen emits several — `Network` and `Polygon` are two — so a catch-all
   pressing right advances *twice* for that screen and overshoots the decision screen. The
   both-press then lands on `Reject transaction` and every signature returns `0x6985`: a suite that
   looks like the device refusing when it is the automation pressing the wrong button one screen
   late.

So the suite **drives the screen itself** — poll, press once, collect — which is what Ledger's own
app tests do (Ragger's navigate-and-compare). It also buys the assertion that matters: the screens
are collected, so a test can check what the member would actually have read.

### What the emulator found

- **A Ledger cannot sign our EIP-712 intents with default settings.** `signEIP712HashedMessage`
  hands the app two hashes, and the app will only review those with **blind signing** enabled: the
  device screen says `Blind signing must be enabled in settings` and the app answers `0x6a80`. That
  status was classified `UNKNOWN`, whose sentence is *"Something went wrong talking to the device.
  Reconnect it and try again"* — advice that can never work, on the path a member takes to sign an
  intent. It is now `BLIND_SIGNING_REQUIRED`, which names the toggle.
- **ETC 61 is genuinely supported.** The app renders `Ethereum Classic` and prices in `ETC` rather
  than showing an unnamed chain id, so 61 is a cohort chain in fact and not only in our config.

### What the device suite can and cannot witness (spec 110)

The signer is viem underneath since spec 110 T028, and this suite was built first precisely so the
conversion had a differential oracle: it passed against the ethers implementation and still passes
after. Two library differences it found are permanent facts about this file, and both are cheap to
reintroduce by accident:

- **`serializeTransaction` wants `v` as a `bigint` on a LEGACY transaction.** Handed a `yParity`
  bit — which is what ethers took on every type — it raises `Cannot mix BigInt and other types`
  from inside viem, naming neither the field nor the transaction. It can only fire on a chain with
  no EIP-1559, which here means **ETC 61 and Mordor 63**, so no EIP-1559 test would ever see it.
  Reintroduce it and the emulated Nano displays the whole transaction, the member presses **Sign
  transaction**, and *then* the TypeError lands: a physical confirmation spent on a signature that
  was never assembled. `signatureForViem` converts once, for every type.
- **viem silently drops a field that contradicts an explicit transaction type**, where ethers
  refused to serialize. `{ type: 0, maxFeePerGas }` becomes a legacy transaction with `gasPrice` 0
  — unmineable, and built from a request that asked for something else. ethers' two refusals are
  reproduced in `transactionTypeOf`, which also writes out ethers' *inference* rule (highest type
  the fields admit: a bare `gasPrice` is type 1, not legacy).

What this suite **cannot** see is the EIP-712 hashing. Its typed-data case asserts the
blind-signing refusal, which the app raises before it looks at the hashes, so `hashDomain` /
`hashStruct` parity with ethers' `TypedDataEncoder` is pinned by `src/test/hardware/
hardwareSigner.test.js` instead — which keeps real ethers as the oracle over the serialization
matrix and the domain shapes. Both suites are needed; neither covers the other's half.
