# Sigil cold signer (Protect ▸ Off chain, spec 111)

[Sigil](https://github.com/chippr-robotics/sigil) is a 2-of-2 MPC ECDSA signer:

- **Cold half:** presignature shares on a **floppy disk**, consumed one per signature.
- **Agent half:** held by `sigil-daemon` on the member's computer.

Neither half can sign alone, and no signature can exist unless the disk is physically in the drive.
Sigil was built for agentic control of keys. The same property protects a person's funds. This
feature makes a Sigil disk a cold account in FairWins, beside Ledger and Trezor.

It is a third **vendor behind the spec-085 hardware seam**, so everything in
[Hardware wallets](hardware-wallets.md) applies:

- public-metadata-only store;
- recover-and-verify before broadcast;
- reconnect must re-derive the saved account;
- operate-as through the spec-088 deferred ceremony.

This page covers only what is different.

## Shape

```
browser tab (FairWins)                                  member's computer
  lib/hardware/sigilAdapter.js ── fetch ──▶ services/sigil-bridge ── unix socket ──▶ sigil-daemon ──▶ floppy
       builds every digest              loopback, Origin-listed,          (Sigil TCB)
       recovers v, verifies             token-paired, no key routes
```

| Concern | Module |
|---|---|
| Adapter: digests, v recovery, error vocabulary | `frontend/src/lib/hardware/sigilAdapter.js` |
| Device-scoped pairing (bridge URL + token) | `frontend/src/lib/hardware/sigilBridgeStore.js` |
| Vendor wiring (`sigil` in `VENDOR_LABELS`, `HARDWARE_VENDOR_ORDER`, `vendorAvailability`, `connectHardware`) | `frontend/src/lib/hardware/adapters.js` |
| Copy (`connectGuidance('sigil')`, `describeSigilBudget`) | `frontend/src/lib/hardware/connectCopy.js` |
| Pairing fields, one-account pick step, budget warnings | `frontend/src/components/custody/AddHardwareWalletSheet.jsx` |
| The bridge (Node built-ins, not a workspace member) | `services/sigil-bridge/` (see its README) |
| Daemon support for `child_pubkey` | chippr-robotics/sigil `specs/004-disk-public-key` (#66) |

## Five rules

1. **The daemon signs a 32-byte prehash, so every digest is built here.**
   - `keccak(unsignedSerialized)` for transactions;
   - EIP-191 `hashMessage` for messages;
   - `keccak(0x1901 ‖ domainSeparator ‖ hashStruct)` for typed data, built from the same values `HardwareSigner` already computes for Ledger.

   Sigil never needs to understand an encoding, and nothing about what is signed depends on it. That is why a Sigil account can do **every** EVM action on **every** EVM chain the build supports. Operate-as, send, wrap, swap, Verify, vault `approveHash` and mini-app `submit` all go through `HardwareSigner`.
2. **`v` is recovered, never transported.** The daemon returns low-S `r‖s` with no recovery id. The adapter tries both parities against the disk's public key, and a signature that recovers to neither is refused. This makes the adapter a recover-and-verify gate for messages and typed data, not just transactions.
3. **One account per disk.**
   - The saved `path` is `sigil:<child id>`.
   - The session offers `describeAccounts()` instead of paging derivation paths, so the pick step shows the disk's own budget: signatures left and expiry, every figure as the daemon reported it.
   - Reconnecting with another disk inserted is `SIGIL_WRONG_DISK`. The bridge also refuses a wrong disk **before** spending a presignature (`expectedPublicKey`).
4. **The pairing token is a device credential, not account data.**
   - It follows the spec-069 RPC-credential rules: device-scoped in `fw_global_prefs.sigil_bridge`.
   - It is deliberately absent from `lib/backup/syncedObjects.js` (a test asserts it).
   - It travels only in the `Authorization` header and is redacted to `…` + 4 characters for display.
   - The bridge URL must be loopback on a host the CSP grants (`localhost` / `127.0.0.1`), so no CSP change was needed.
5. **Each refusal names its remedy.** Each state has its own `HW_ERROR_CODES` entry:
   - `SIGIL_BRIDGE_UNREACHABLE`, `SIGIL_NOT_PAIRED`, `SIGIL_DAEMON_DOWN`, `SIGIL_NO_DISK`, `SIGIL_DISK_EXHAUSTED`, `SIGIL_DISK_INVALID`, `SIGIL_WRONG_DISK`, `SIGIL_DAEMON_OUTDATED`.

   Folding them into `DISCONNECTED` would tell a member with an empty disk to "reconnect". The bridge checks disk state before signing, so none of these spends a presignature.

## Consent

- **A hardware wallet's consent is its screen. Sigil's is the disk in the drive**, one presignature burned per signature. The reconnect dialog says exactly that; it never claims a screen.
- **Members who want a human "yes" as well** run the bridge with `--confirm`, which prompts on the terminal with the description, chain and digest before every signature.
- **The browser still shows the full confirm step** before it asks for any signature (the spec-058 Pay confirm, the Verify sheet, and so on).

After a broadcast, `HardwareSigner` calls the session's optional `noteBroadcast(hash)`. For Sigil,
this writes the transaction hash into the disk's usage log (`UpdateTxHash`), so reconciliation at the
mother device can match every spent presignature to a transaction. It is best-effort and never
delays or undoes a send.

## Not yet

- **Proof of execution.** Sigil's daemon returns a `proof_hash`, but today it is a hash of public data, not a zkVM proof. There is no signing ELF, no verification key and no prover wired in. The bridge does not forward it and the app shows nothing about it. Verifying a real per-signature SP1 proof is chippr-robotics/sigil#67 and will be revisited after that lands.
- **Bitcoin.** Spec 061 signs with raw keys only, and no hardware BTC path exists. A disk's secp256k1 key could sign P2WPKH, but that needs a signing callback seam in `lib/bitcoin/psbt.js` first.
- **FROST schemes** (Taproot, Ed25519, Ristretto255). The daemon has no FROST sign operation. `sigil-mcp`'s `sign_frost` calls the ECDSA path (chippr-robotics/sigil#68).
- **Native shells.** `vendorAvailability('sigil')` refuses on iOS/Android: no daemon or floppy drive can exist there.

## Testing

| Layer | Where |
|---|---|
| Adapter against a fake bridge that signs like the daemon (real keys, real recovery) | `frontend/src/test/hardware/sigilAdapter.test.js` |
| Add sheet: pairing validation before any request, one-account pick step, save shape | `frontend/src/test/custody/AddSigilAccount.test.jsx` |
| Ceremony layering (the spec-088 dialog above the sheet that asked for it) | `frontend/src/test/account/ActionSheetStacking.test.jsx` |
| Bridge refusals (origin, token, Host, JSON-only, no import routes, disk states) | `services/sigil-bridge/test/` (CI: *Sigil Bridge Tests*) |
| No-chain e2e: pair, add, failure vocabulary, Verify signing | `frontend/cypress/e2e/fast/51-protect-sigil.cy.js` |
| On-chain e2e: operate-as send settles; the chain recovers Sigil as the sender | `frontend/cypress/e2e/full/46-sigil-operate-as-send.cy.js` |

The e2e specs plant **no adapter seam**:

- The browser runs the real adapter against the **real** bridge (`cypress/support/tasks/sigil.js`).
- A stand-in daemon sits behind the bridge on a real Unix socket. It speaks the daemon's wire format and signs a prehash with a local test key.
- The 2-party combination and the floppy I/O are Sigil's TCB and are tested there. A combined MPC signature is an ordinary ECDSA signature under the child key, which is the only property the app depends on.

This is why the Sigil rail has on-chain coverage when the Ledger/Trezor rail cannot (`full/40-acting-account-purchase` explains why).

Real-disk validation (a mother-created disk, `sigil-daemon`, a floppy drive) is manual. See
[the staging runbook](../runbooks/sigil-cold-signer-staging-validation.md).
