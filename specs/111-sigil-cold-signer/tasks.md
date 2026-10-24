# Tasks: Sigil cold signer (spec 111)

## Sigil (chippr-robotics/sigil#66)

- [x] T001 `DiskStatus.child_pubkey` (optional on the wire); pure `disk_status_response` with 3 tests
- [x] T002 `sigil disk` prints the key; `sigil-mcp` fills `DiskState.public_key`
- [x] T003 Sigil spec 004 with Coverage table; CHANGELOG; backlog row
- [x] T004 File the adjacent defects: proof of execution (sigil#67), MCP placeholders and `sign_evm` length (sigil#68)

## Bridge (`services/sigil-bridge`)

- [x] T010 Daemon IPC client: Ping, GetDiskStatus, Sign, UpdateTxHash only (no import op)
- [x] T011 HTTP handler:
  - Host check, Origin allowlist, private-network preflight, bearer token, JSON-only bodies
  - disk pre-checks, serialized signing, named refusals
- [x] T012 CLI: loopback-only default, required origins, `0600` token file, `--confirm`
- [x] T013 `node:test` suite (28) against a stand-in daemon on a real Unix socket
- [x] T014 CI job *Sigil Bridge Tests*; README with the security model

## Frontend

- [x] T020 `sigilBridgeStore.js`: device-scoped pairing, loopback/CSP validation, redaction, not synced
- [x] T021 `sigilAdapter.js`: digests for tx / EIP-191 / EIP-712, `v` recovery, error vocabulary, `describeAccounts`, `noteBroadcast`
- [x] T022 `adapters.js` / `hardwareAccountsStore.js` / `connectCopy.js`: `sigil` vendor, native-shell refusal
- [x] T023 Add sheet:
  - pairing fields (validated before any request)
  - one-account pick step with budget and low/empty/invalid warnings
  - Sigil saved copy
- [x] T024 Reconnect dialog copy (disk, not screen); `--hw-sigil-color`; nav search keywords
- [x] T025 `HardwareSigner.noteBroadcast` hook after broadcast
- [x] T026 `ActionSheet` ceremony tier and top-of-stack keyboard handling (spec-088 defect found by SIG-03)
- [x] T027 `.hw-account-row__path` contrast fix (spec-085 defect found by the SIG-01 axe scan)
- [x] T028 Vitest: adapter (31), add sheet (9), stacking (3)

## E2E

- [x] T030 `cypress/support/tasks/sigil.js`: the real bridge in front of a stand-in daemon
- [x] T031 `fast/51-protect-sigil.cy.js` SIG-01..SIG-04
- [x] T032 `full/46-sigil-operate-as-send.cy.js` SGO-01 (settled transfer; the chain recovers Sigil)
- [x] T033 Coverage matrix row → covered; regenerated doc

## Docs

- [x] T040 `docs/developer-guide/sigil-cold-signer.md`; cross-link from `hardware-wallets.md`; mkdocs nav
- [x] T041 `docs/runbooks/sigil-cold-signer-staging-validation.md` (real-disk protocol)
- [x] T042 CLAUDE.md guardrail entry
