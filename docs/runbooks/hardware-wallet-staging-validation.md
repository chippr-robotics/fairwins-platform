# Runbook: Hardware Wallet Staging Validation (spec 087)

Unit and component tests drive mock adapters (FR-013); what they cannot prove is the real
transport, real vendor firmware, and real browser permission prompts. This checklist is run
against staging with **physical devices** before enabling the feature for members, and again
after any bump of `@ledgerhq/*` or `@trezor/connect-web`.

## Prerequisites

- Staging URL for the frontend build under test, opened in a **Chromium** browser (Chrome or
  Edge; Ledger needs WebHID/WebUSB). Keep a Firefox window handy for the transport-unsupported
  negative test.
- One Ledger (Ethereum app installed) and one Trezor, each initialized with a **test seed**.
  **NEVER use a production seed** — the dust-send checks broadcast real transactions, and a typo
  in this checklist must never be able to touch real funds.
- A second, different test seed (or a passphrase on the same device) for the wrong-device
  negative test.
- Wallet connected on a **testnet** the build serves, with a little native token on one derived
  account per device for the dust send.
- A second browser profile (clean) for the backup-restore check.
- **DevTools console open for every check.** Every hardware failure now logs its raw cause as a
  `[hardware-add]` / `[hardware-connect]` console line alongside the member-facing sentence —
  copy that line into any failure report. "No relevant logs" is itself a finding: it means the
  diagnostic seam regressed.
- For Trezor: the site must be allowed to open popups (the Connect window). A blocked popup
  renders as the `popup-blocked` sentence — that is the browser setting, not a device fault.

## Per-vendor checklist (run once for Ledger, once for Trezor)

### Add-account flow

1. Protect ▸ Off chain → "Add hardware wallet". The vendor step must show both vendors; on
   Chromium both are enabled.
2. Connect (device unlocked, Ethereum app open for Ledger; approve the Trezor window for
   Trezor). The pick step lists 5 accounts with address + derivation path + native balance.
3. Switch derivation scheme (Ledger Live ↔ BIP-44 standard). Addresses and paths change; the
   selection resets.
4. "Show more accounts" pages 5 more, appended, on the current scheme.
5. Select two accounts, set a label, save. Saved step lists both; toast fires; both appear in
   the Off chain list with vendor badge, and in the address book / account switcher.

### Duplicate re-add

6. Re-run the flow and save an already-saved address with a new label. The pick step marks it
   "Saved"; saving must **update the label, not duplicate** (FR-011). List still shows one row.

### Label + remove

7. Rename via re-add (above) shows the new label everywhere (list, switcher, address book).
8. "Forget" asks for confirmation stating the device keeps controlling the funds (FR-008);
   confirming removes the row and toasts.

### Reconnect + act-as (dust send)

9. Re-add an account that holds testnet funds. From the account switcher, choose it — the
   connect dialog opens, the device confirms, and the header shows the hardware identity.
10. Send a dust amount of native token to your own personal wallet. The transaction **must be
    confirmed on the device's own screen** — verify the amount and recipient shown there match
    the app before approving.
11. After it mines, verify on the explorer that the **from address is the hardware account**,
    not the connected wallet.
12. Switch the wallet to a different network while still acting as the hardware account and try
    to send: the app must refuse with the "switch back to the network where you connected"
    message (chain guard), not send on the wrong chain.

### Negative tests (each must end in the exact stated sentence — codes from
`frontend/src/lib/hardware/errors.js`)

| # | Scenario | Expected outcome (code) |
|---|---|---|
| N1 | Wrong device: reconnect a saved account with the second-seed device (or passphrase on) | Refusal naming the mismatch: "The connected device does not hold this account…" — never a silent act-as |
| N2 | Device locked (PIN screen) during connect | "The device is locked. Unlock it with your PIN and try again." (`device-locked`) |
| N3 | Ledger: wrong app open (e.g. Bitcoin app) | "Open the Ethereum app on the device, then try again." (`wrong-app`) |
| N4 | Cancel the browser device-picker prompt (Ledger) | "The browser was not given permission…" (`permission-denied`) |
| N5 | Reject/cancel on the device during a sign | "The request was cancelled on the device." (`user-cancelled`); the app returns to an actionable state |
| N6 | Unplug mid-flow (during account listing or a sign) | "The device was disconnected. Reconnect it and try again." (`disconnected`); no hung spinner, retry works after replug |
| N7 | Firefox: open the add flow | Ledger option **disabled** with the WebHID/WebUSB reason (`transport-unsupported`), never a dead control; Trezor stays available |
| N8 | Trezor: block popups for the staging origin, then connect | A stated permission/popup failure (`permission-denied`); after allowing popups, retry succeeds without a page reload |

Every failure must be a rendered sentence in the sheet/dialog — a hanging spinner, a silent
close, or a raw SDK/APDU message (e.g. "0x6511") is a **fail** (FR-012).

### Backup restore

13. Run a backup export, open the second browser profile, restore, connect the same member
    wallet. Saved hardware accounts **reappear** (address, vendor, path, label). Inspect the
    restored storage/backup payload: public metadata only — no key material, no xpub, no device
    ids (FR-005).

### Audit + notifications

14. Activity ledger shows one `hardware_account_added` per saved account and one
    `hardware_account_removed` per forget, refs = address + vendor + path only. Re-adding the
    same account on the same chain creates **no duplicate** entry (stable entryId).
15. Toasts fired for save, forget, and the act-as flows exercised above.

## Results table

Copy per run (one table per vendor):

| Check | Vendor | Expected | Pass/Fail | Notes |
|---|---|---|---|---|
| Add flow (both schemes, paging, balances) | | steps 1–5 | | |
| Duplicate re-add updates label | | step 6 | | |
| Label + remove/forget | | steps 7–8 | | |
| Reconnect + act-as dust send, from address verified | | steps 9–11 | | |
| Chain guard refuses cross-network send | | step 12 | | |
| N1 wrong device refused | | mismatch sentence | | |
| N2 locked | | `device-locked` sentence | | |
| N3 wrong app (Ledger) | | `wrong-app` sentence | | |
| N4 permission prompt cancelled | | `permission-denied` sentence | | |
| N5 cancel on device | | `user-cancelled` sentence | | |
| N6 unplug mid-flow | | `disconnected` sentence, retry works | | |
| N7 Firefox transport-unsupported | | disabled with reason | | |
| N8 Trezor popup blocked | | stated failure, retry works | | |
| Backup restore, no secrets | | step 13 | | |
| Audit entries + toasts | | steps 14–15 | | |

## Escalation

File an issue for any failed row and **include the exact error code/sentence shown** (the codes
above map one-to-one onto `HW_ERROR_CODES`, so the sentence identifies the classification path
that fired — or failed to). A raw vendor message on screen is itself a bug against FR-012 even
when the underlying failure is legitimate. Note browser + version, vendor firmware version, and
whether the failure reproduces with the DEV test adapter (if it does, it is not a
transport/firmware problem).

## Native app addendum (spec 102 — Ledger over the OS Bluetooth stack)

The native iOS/Android apps reach a Ledger through
`lib/native/ledgerBleTransport.js` (the Capacitor BLE plugin speaking the
Ledger BLE framing), selected by runtime inside the same one-seam ladder.
Everything above the transport is identical, so this addendum validates ONLY
the rail; every row above still applies inside the native app.

Run on PHYSICAL devices (a Nano X — the only Bluetooth Ledger), per platform:

| Check | iOS | Android | Notes |
|---|---|---|---|
| Pair + connect from Protect ▸ Off chain | | | first connect shows the OS pairing dialog, not a browser chooser |
| Address verify-on-device at add time | | | must match the saved address on reconnect (re-derive rule) |
| Sign one transaction with physical confirmation | | | recover-and-verify before broadcast still runs |
| Bluetooth permission DENIED | | | expects the `permission-denied` sentence, never a raw plugin message |
| Radio OFF | | | expects the `bluetooth-unavailable` sentence (distinct remedy from denial) |
| Link drop mid-session (walk away / power off) | | | expects `disconnected`, reconnect works |
| App backgrounded mid-signature | | | on return (through any due lock re-prompt) the action reports its true state |

A raw SDK/plugin sentence reaching the member fails the run (FR-012), exactly
as on web. Record outcomes on the release issue alongside the passkey PRF
check from `docs/runbooks/native-release-operations.md`.
