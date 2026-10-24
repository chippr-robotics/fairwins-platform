# Implementation Plan: Hardware Wallet Cold Storage (Protect ▸ Off chain)

**Branch**: `claude/hardware-wallet-protect-ojldc1` | **Date**: 2026-08-15 | **Spec**: [spec.md](./spec.md)

## Summary

Protect's disabled "Off chain" placeholder becomes real cold storage: members add Ledger/Trezor
accounts through a guided bottom-sheet flow, the accounts surface app-wide as a first-class
acting-account kind, and the Protect page itself becomes a three-section accordion. Frontend-only;
no contract, gateway, or subgraph change.

The design turns on one decision: **the device is the only signer, and the app stores only what
the device makes public.** The persisted record is `{ address, vendor, path, label, addedAt }` —
nothing else exists to protect, which is why the store can ride the spec-032 backup without any
encryption of its own, and why every "act as" ceremony must re-derive the address from the device
and refuse on mismatch (the saved reference proves nothing about the device now plugged in).

## Technical Context

**Primary Dependencies**: `@ledgerhq/hw-app-eth` + `hw-transport-webhid`/`webusb` (Ledger),
`@trezor/connect-web` (Trezor popup), all lazy-loaded behind one adapter seam
(`frontend/src/lib/hardware/adapters.js`); `ethers` v6 for the signer wrapper.

> **Superseded (spec 110 T028):** the signer wrapper is **viem**, still ethers-SHAPED for its
> callers. It no longer extends `AbstractSigner`, and its third constructor argument is a
> `{ chainId, client }` binding rather than an ethers `Provider`. Two library differences are
> load-bearing — viem's legacy serializer needs `v` as a bigint (it can only bite ETC 61 /
> Mordor 63), and viem silently drops a field that contradicts an explicit transaction type where
> ethers refused. See `docs/developer-guide/hardware-wallets.md` § "What the device suite can and
> cannot witness".

**Storage**: One per-account userStorage key (`hardware_accounts`) + one synced-backup object
(`hardwareAccounts`, not network-scoped — an EVM address is chain-independent).

**Testing**: Vitest (53 lib + 19 component tests, mock adapters — FR-013), Cypress fast tier
(5 specs via the DEV-only `window.__fwHardwareTestAdapter__` seam), Playwright capture harness
(operator-installed) for the actor-critic visual loop, real-device staging runbook.

**Integration recipe**: spec-062's five steps, applied verbatim — store module → projection hook
(`useHardwareAccounts`) → switcher registration (kind `hardware`, reconnect dialog where legacy
has its unlock dialog) → CustodyContext mode (`operateAsHardware`, session signer in memory only,
transport closed on drop) → seam edits (`useActiveAccount` submit + chain guard,
`useEffectiveAccount` type union, WalletButton/carousel dialogs, address-book upsert).

## Constitution Check — PASS

| Principle | Assessment |
|---|---|
| **I. Security-First** | No contract change. Key material never exists in the browser; signatures are physical device confirmations; `HardwareSigner.signTransaction` recovers the sender from the signed bytes and refuses a mismatch before anything can broadcast. |
| **II. Test-First / Coverage** | Failure paths are first-class: typed error vocabulary (`HW_ERROR_CODES`) with tests asserting raw SDK errors never reach the member; wrong-device, locked, cancelled, unplugged all covered. |
| **III. Honest State** | Vendor options the browser cannot serve are disabled with the reason (FR-003); balances that fail to read render "—", never zero; the DEV-only adapter seam is dead-code-eliminated from production bundles — no mock ships. |
| **IV. Fail Loudly** | Cypress spec added to the fast tier that CI already gates; no `continue-on-error`. SPA image build gained the native toolchain the new dependency tree needs, rather than skipping scripts. |
| **V. Accessible, Consistent** | Reuses `AccordionSection`/`AccordionGroup` (Recovery/Settings pattern), `ActionSheet`, the drawer-search deep-link contract (`#custody-*` hashes), and the platform's toast/audit seams. Axe audits on the shell and the picker step. |
| **Simplicity** | No new service, no new storage engine; four vendor SDS deps, all lazy-loaded; one new synced object entry. |

## Project Structure

```text
frontend/src/lib/hardware/            adapters, ledgerAdapter, trezorAdapter, errors,
                                      derivations, hardwareSigner, connectAccount,
                                      hardwareAccountsStore, hardwareAccounts
frontend/src/hooks/useHardwareAccounts.js
frontend/src/components/custody/      HardwareWalletSection, AddHardwareWalletSheet,
                                      HardwareWallet.css, CustodyPanel (accordion)
frontend/src/components/account/HardwareConnectDialog.jsx
frontend/src/data/ledger/sources/hardwareWalletSource.js
frontend/src/lib/backup/syncedObjects.js          (+ hardwareAccounts entry)
frontend/src/config/navSearchIndex.js             (+ section cards, + Off chain entry)
frontend/cypress/e2e/fast/27-protect-hardware.cy.js
scripts/ui/capture-protect-hardware.mjs
docs/developer-guide/hardware-wallets.md
docs/runbooks/hardware-wallet-staging-validation.md
specs/085-hardware-wallet-protect/{spec,plan}.md + screenshots/
```

## Phases delivered

1. **Library** — adapter seam + vendor adapters + signer + store (unit-tested without hardware).
2. **App-wide identity** — spec-062 recipe end to end; transport lifecycle owned by CustodyContext.
3. **Surface** — accordion refactor, wizard, list; narrative copy removed (FR-009/010); nav-search
   deep links wired to the new section ids.
4. **Core systems** — client-ledger audit source + toasts; synced-backup registration.
5. **Verification** — Vitest + Cypress + actor-critic screenshot loop (round-1 finding: light-mode
   button chrome, fixed in Custody.css/HardwareWallet.css); staging runbook for real devices.
