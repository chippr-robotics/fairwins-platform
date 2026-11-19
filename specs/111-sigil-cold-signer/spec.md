# Feature Specification: Sigil cold signer in Protect ▸ Off chain

**Feature Branch**: `111-sigil-cold-signer`

**Created**: 2026-09-22

**Status**: Implemented. See `plan.md` and `tasks.md`; tracking issue #1633.

**Input**: Issue #1633 — "Sigil was built for agentic control of keys; the same cold-storage
protocol protects humans. Let a member use Sigil as a cold signer, with every action available on
every supported network."

## Problem statement

Sigil (`chippr-robotics/sigil`) is a 2-of-2 MPC ECDSA signer. The cold half is a set of
presignature shares on a floppy disk, consumed one per signature. The agent half lives on the
member's machine behind `sigil-daemon`. Neither half can sign alone, and a signature can only exist
while the disk is physically present. That property is exactly what spec 085 bought from a hardware
wallet: the physical consent step leaves the browser. Sigil just gets it with different hardware.

Two things stand between a member and that property today:

1. **Nothing in FairWins can reach Sigil.** The daemon speaks newline-delimited JSON on a Unix
   socket and nothing else. The Sigil constitution (Principle I, III) forbids an HTTP listener
   inside its trusted computing base, and its SECURITY.md assigns the remote UI to FairWins, to be
   built "out of TCB, against a deliberately chosen interface".
2. **Nothing can name the account.** The daemon exposes no public key, so no address can be
   derived. Sigil's own MCP `get_address` tool returns a hardcoded placeholder.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Add a Sigil disk as a cold account (Priority: P1)

As a member with a Sigil agent machine, I pair FairWins with my local Sigil bridge, insert my
floppy, and save the disk's account in Protect ▸ Off chain, next to my Ledger and Trezor accounts.

**Independent Test**: With the bridge answering and a disk present, the add flow shows the disk's
address and remaining presignatures, and saving stores public metadata only.

### User Story 2 — Act as the Sigil account, everywhere (Priority: P1)

As a member operating as my Sigil account, I can do anything I could do as any other acting
account on any EVM network the build supports:

- send native coins and tokens;
- wrap and swap;
- sign a message in Verify;
- sign typed data;
- approve and execute vault proposals where the account is an owner;
- submit from a mini-app.

Each signature needs the disk to be present.

**Independent Test**: Operating as a Sigil account on a local chain, a native send settles, and the
recovered signer of the broadcast transaction is the saved address.

### User Story 3 — Honest failure (Priority: P1)

When the bridge is unreachable or unpaired, when no disk is inserted, or when the disk's
presignatures are spent or expired, the app says which one it is and what fixes it. It signs
nothing and never offers a generic error.

## Requirements

- **FR-001** Sigil is reached only through a loopback bridge outside Sigil's TCB. The bridge
  requires a pairing token, serves only listed origins, and never accepts or returns key material.
- **FR-002** The browser computes every digest (unsigned transaction, EIP-191, EIP-712) and sends
  only the 32-byte hash plus a human description. v is recovered against the disk's public key and
  never trusted from the transport.
- **FR-003** A Sigil account is a vendor behind the existing `connectHardware` seam. The saved
  entry is public metadata only (spec 085). The pairing token is device-scoped and never enters the
  backup.
- **FR-004** Every signature is recovered and verified against the saved address before broadcast.
  A reconnect whose disk names a different account is refused.
- **FR-005** Each signature consumes one presignature. The remaining count is shown before the
  member saves or signs, and an exhausted disk is a named state.
- **FR-006** Every refusable disk state is refused BEFORE a presignature is spent, and each is named
  with its own remedy: no disk, exhausted, expired/invalid, wrong disk. The same holds for an
  unreachable or unpaired bridge and for a daemon that is down or outdated.
- **FR-007** The deferred-signing ceremony (spec 088) renders above the surface that requested it,
  and only the top sheet answers the keyboard.
- **FR-008** After a broadcast, the transaction hash is written back to the disk usage log for the
  presignature that signed it (best-effort; it never delays or undoes a send).
- **FR-009** The bridge never forwards the daemon's `proof_hash`. The app claims no proof of
  execution until Sigil produces one (chippr-robotics/sigil#67).

## Coverage

| Requirement | Test |
| --- | --- |
| FR-001 | `services/sigil-bridge/test/bridge.test.js` (origin, token, Host, JSON-only, no import route); `main.test.js` (loopback-only bind, 0600 token) |
| FR-002 | `sigilAdapter.test.js` (EIP-191 byte-identical to a plain key; EIP-712 verifies; legacy and EIP-1559 on 137/61/63/8453 recover; a foreign-key signature is refused); `full/46` SGO-01 (the chain recovers Sigil as the sender) |
| FR-003 | `AddSigilAccount.test.jsx` (saved key set, token not in the store); `sigilAdapter.test.js` (absent from `syncedObjects`); `fast/51` SIG-01 |
| FR-004 | `sigilAdapter.test.js` (wrong disk, foreign key); `HardwareSigner` recover-and-verify (existing) |
| FR-005 | `AddSigilAccount.test.jsx`, `fast/51` SIG-01/SIG-04 |
| FR-006 | `bridge.test.js` (no Sign sent for each refusable state); `sigilAdapter.test.js` (error mapping); `fast/51` SIG-02 |
| FR-007 | `ActionSheetStacking.test.jsx`; `fast/51` SIG-03 |
| FR-008 | `sigilAdapter.test.js` (`noteBroadcast`); `full/46` SGO-01 (`UpdateTxHash` carries the mined hash) |
| FR-009 | `bridge.test.js` (a sign response carries no proof field) |

## Out of scope

- Bitcoin (spec 061 signs with raw keys only; no hardware BTC path exists).
- FROST schemes (the Sigil daemon has no FROST sign operation today).
- Verifying a proof of execution (Sigil's `proof_hash` is not a proof today; revisit after
  chippr-robotics/sigil#67, per the owner's decision on 2026-09-23).
- Native shells (no Sigil daemon or floppy drive can exist on a phone).
