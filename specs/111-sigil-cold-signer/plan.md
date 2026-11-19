# Implementation Plan: Sigil cold signer in Protect ▸ Off chain

**Branch**: `claude/sigil-cold-signer-ux-j3lxgy` | **Spec**: [spec.md](spec.md) | **Issue**: #1633

## Summary

Sigil (2-of-2 MPC ECDSA, cold presignature shares on a floppy) becomes a third vendor behind the
spec-085 hardware seam. There are three parts:

1. **Sigil, TCB side** (chippr-robotics/sigil#66, sigil spec 004): `DiskStatus` reports the disk's
   public key. One read-only field; no share or secret crosses the boundary.
2. **`services/sigil-bridge`**: a dependency-free loopback HTTP↔IPC bridge. It lives in this repo because
   Sigil's constitution keeps HTTP out of its TCB and assigns the remote UI to FairWins.
3. **Frontend**: `lib/hardware/sigilAdapter.js` + `sigilBridgeStore.js`, wired into `adapters.js`
   and the add sheet.

The browser computes every digest and recovers `v`. Everything downstream (`HardwareSigner`,
operate-as, every write surface) is unchanged, which is why every EVM action is available on every
EVM chain.

## Technical context

- **Frontend**: React + Vite + Vitest. Adds **no new dependency**: `viem` and `@noble/curves` are already direct dependencies.
- **Bridge**: Node ≥ 20 built-ins only. Not a workspace member, following the `services/mcp-server` precedent. CI runs `node --test` with no install step.
- **CSP**: unchanged. `connect-src` already grants loopback http (`localhost`, `127.0.0.1`) for spec 069. The pairing form accepts only those hosts, via `CSP_RPC_GRANTS.httpHosts`.
- **Browser**: Chrome's Local Network Access prompts before a public origin reaches loopback. The bridge sends `Access-Control-Allow-Private-Network: true` on its preflight.

## Constitution check

| Principle | Result |
|---|---|
| I. Security-first contracts | No contract change. |
| II. Test-first | Coverage by layer:<br>• Vitest: adapter (31 cases, real keys), add sheet (9), ActionSheet stacking (3).<br>• Bridge `node:test` (28).<br>• Cypress no-chain (SIG-01..04) and on-chain (SGO-01).<br>• Sigil: 3 daemon tests plus the traceability gate. |
| III. Honest state | Every disk state is read, never invented: the address comes from the key the disk reports, and the budget and expiry are the daemon's own figures.<br>Absent key ⇒ `SIGIL_DAEMON_OUTDATED`, never a placeholder.<br>`proof_hash` is not forwarded because it is not a proof.<br>Mocks live only under `cypress/` and `test/`, and the stand-in daemon is labelled as one. |
| IV. Fail loudly in CI | New job *Sigil Bridge Tests* is gating. No `continue-on-error`. |
| V. Accessible frontend | The pick step is axe-scanned (SIG-01). The scan found a pre-existing spec-085 contrast failure (`.hw-account-row__path` at 65% opacity), fixed to `--text-muted`. Colours come from tokens (`--hw-sigil-color` → `--accent-color`, `--warning-text`, `--text-secondary`). |
| Key management | The pairing token is device-scoped, never synced, never in a URL, and redacted for display. The bridge has no key-import route and its daemon client has no import function (Sigil Principle IV). |
| Multi-agent | Spec number reserved by merged PR #1634. Tracking issue #1633. |

## Complexity tracking

| Addition | Why it earns its place |
|---|---|
| A new service (`services/sigil-bridge`) | A browser cannot open a Unix socket, and Sigil's constitution forbids an HTTP listener inside Sigil. It has zero dependencies, so it adds no lockfile coupling. |
| `ActionSheet` `tier="ceremony"` + top-of-stack key handling | SIG-03 found that the spec-088 ceremony rendered under the sheet that requested it. The bug affected Ledger, Trezor and recovered accounts too, and needed a fix to reach Verify at all. |
| `noteBroadcast` hook in `HardwareSigner` | Optional, best-effort, and a no-op for vendors without it. It gives Sigil's reconciliation a tx hash for each spent presignature. |

## Decisions

- **Loopback bridge, not a browser extension or WebUSB.** The daemon owns the floppy and the agent shard, so a bridge to it is the only path that keeps Sigil's TCB unchanged.
- **The bridge adds no mandatory human prompt.** Sigil's consent is the disk, as its constitution defines it. `--confirm` is available for members who want a terminal "yes" too.
- **Proof of execution is out of scope** by owner decision (2026-09-23): the daemon's proving is a stub. Tracked as chippr-robotics/sigil#67 and revisited after it lands.
- **Bitcoin and FROST are out of scope.** There is no hardware BTC seam (spec 061) and no daemon FROST operation.
