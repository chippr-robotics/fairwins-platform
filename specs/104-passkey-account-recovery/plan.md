# Implementation Plan: Passkey account recovery — find the account, never guess it

**Branch**: `104-passkey-account-recovery` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/104-passkey-account-recovery/spec.md`

## Summary

Stop deriving a passkey's account and start looking it up. `resolveAccountForCredential` currently
computes an address on the assumption that the key is the account's sole initial owner, then reads
the chain to sanity-check the guess — which silently returns a brand-new empty account when the
guess lands on an undeployed address, and dead-ends when it lands on a deployed one.

The work lands in three releases, sequenced by what unblocks a locked-out member soonest rather
than by the spec's priority ordering (see [research.md](./research.md) R5):

1. **Release 1 — no new infrastructure.** Never open a session on an unverified address (US2), and
   let a member recover by entering their account address, verified against the chain (US3). Both
   are client changes over machinery that already exists.
2. **Release 2 — discovery for initial owners (US1).** Record the factory deploy block, then scan
   `AccountCreated` and confirm every candidate against its current owner set.
3. **Release 3 — keys added later.** Deliberately deferred; it needs an index, and until it exists
   the address fallback covers that shape honestly.

## Technical Context

**Language/Version**: JavaScript (ES modules), React 19, Node 22 toolchain

**Primary Dependencies**: viem (chain reads), ethers via the spec-069 read-provider seam, wagmi
connector surface. **No new dependency** — see Constitution Check.

**Storage**: `localStorage` credential book (`fairwins.passkey.credentials.v1`) via
`lib/passkey/credentials.js`. No new store.

**Testing**: Vitest for all logic and components; Cypress no-chain tier for the recovery surfaces;
Cypress on-chain tier for verified sign-in. Matrix rows already exist (three `absent` flows).

**Target Platform**: Web + PWA + Capacitor native shells (identical code path — recovery is
rail-blind and sits above `resolveCredentialManager`).

**Project Type**: Frontend feature over deployed contracts.

**Performance Goals**: Release 1 adds at most one `getCode` + `nextOwnerIndex` + N × `ownerAtIndex`
per attempt. Release 2's scan is chunked and deadline-bounded (research R7).

**Constraints**: No contract changes. Chain reads through the spec-069 seam. Cohort-bounded
(constitution III). Every leg bounded by a deadline that resolves `unverified`, never `none-found`.

**Scale/Scope**: One resolver module, one recovery surface, one deployments change, plus the
migration of `readControllers` onto the read-provider seam.

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 design — see the bottom of this file.*

| Principle | Assessment |
|---|---|
| **I — Security-first smart contracts** | **Not engaged, deliberately.** No change to `contracts/`. The events this feature reads already exist on the deployed factory and accounts; indexing the owner would be a contract change that could only cover *future* accounts, which is the opposite of what recovery needs (research R1). No Slither/Medusa surface. |
| **II — Test-first** | Every outcome in the state machine gets a Vitest case before its implementation, including the three failure verdicts. The member-supplied-address path gets a test proving an address the key does **not** control is refused — the security property of US3 is a *negative*, so the test that matters is the refusing one. |
| **III — Honest state, no placeholders** | This is the principle the whole feature is about. Four outcomes with a value only on `resolved`; `unverified` never collapses into `none-found`; the cohort boundary is not crossed. The silent-new-account path is removed, which is a constitution III violation currently shipping. |
| **IV — Fail loudly in CI** | No `continue-on-error`. The e2e matrix rows move from `absent` to `covered` as each release lands, and the regenerate-and-diff gate keeps the generated doc in step. |
| **V — Accessible frontend** | The recovery surface is a form with a text input and three distinct result states; axe and Lighthouse gates apply. Error states are text, never colour alone. |
| **Deployments are the source of truth** | Release 2 adds `deployBlocks.accountFactory`, which is a `deployments/` change reviewed as such — not a constant in frontend code. |

**No deviations. No Complexity Tracking entries.**

One item is worth stating rather than leaving implicit: this plan **reorders delivery against the
spec's own priorities** (US3 before US1). That is a sequencing choice, justified in research R5 —
US3 is the cheapest complete answer and depends on nothing, while US1's discovery leg is gated on a
deploy block that does not exist yet. The spec's priorities are unchanged; only the order of
shipping is.

## Project Structure

### Documentation (this feature)

```text
specs/104-passkey-account-recovery/
├── spec.md              # merged, #1429
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── account-resolution.md   # Phase 1 — the resolver's contract
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source code

```text
frontend/src/lib/passkey/
├── accountLookup.js         # NEW — the resolver: outcomes, search legs, verification
├── credentials.js           # unchanged by this feature
└── __tests__/
    └── accountLookup.test.js  # NEW

frontend/src/connectors/
└── passkey.js               # resolveAccountForCredential rewritten to consume the resolver

frontend/src/lib/passkey/smartAccount.js
                             # readControllers moved onto the spec-069 read-provider seam

frontend/src/components/wallet/
├── ConnectModal.jsx         # renders the recovery outcomes; entry point to relink
└── RecoverAccount.jsx       # NEW — address entry + the three verdicts

deployments/*.json           # deployBlocks.accountFactory per chain (Release 2)

frontend/cypress/e2e/        # rows already reserved in coverage/matrix.json
```

## Phase sequencing

### Release 1 — honest outcomes and address recovery (no infrastructure)

Delivers **US2** and **US3**, and removes the silent wrong-account path.

1. `accountLookup.js` with the four-outcome resolver and the *verification* half only:
   given owner bytes and a candidate address, read the current owner set and decide.
2. `resolveAccountForCredential` rewritten: it may return an address **only** when verification
   succeeded. The undeployed-derived-address branch stops returning that address.
3. `RecoverAccount.jsx`: the member supplies an address; the chain decides. Refusal distinguishes
   "that account exists and this passkey does not control it" from "nothing at that address".
4. `readControllers` onto the read-provider seam (FR-012, research R6).

Derivation survives only where it is truthful: creating a *new* account, which the member chooses
explicitly.

### Release 2 — discovery for initial owners

Delivers **US1** for keys that were initial owners.

5. `deployBlocks.accountFactory` recorded per chain — **blocking prerequisite** (research R2).
6. Measure `AccountCreated` log volume per chain and record the result (research, open item).
7. Nonce enumeration (leg A) — cheap, narrow, honest about its narrowness.
8. `AccountCreated` scan (leg B), chunked and deadline-bounded, every candidate confirmed against
   the current owner set.
9. Multiple verified accounts → the member picks (FR-007).

### Release 3 — keys added later (deferred)

`AddOwner` has no address to filter on, so discovery means a topic-only scan of the whole chain or
an index. The subgraph indexes no account entities today and is Polygon-only (research R3). This
gets its own spec; until then the address fallback covers the shape and says so.

## Phase 1 artifacts

- **[data-model.md](./data-model.md)** — the four outcomes, the entities, and the state transitions.
- **[contracts/account-resolution.md](./contracts/account-resolution.md)** — the resolver's contract:
  inputs, outcomes, and the invariants a caller may rely on.
- **[quickstart.md](./quickstart.md)** — how to validate each release.

## Post-design Constitution Check

Re-evaluated after Phase 1. **Still passing, no deviations.**

The design added no dependency, no contract change, no new store, and no second source of truth: the
resolver is one module, the credential book stays the only client-side record, and `deployments/`
stays the source of truth for the deploy block. The one thing Phase 1 sharpened is constitution III
— the four-outcome type makes "a value exists only on `resolved`" a property of the data model
rather than a rule contributors must remember, which is the same shape as spec 089's `reading.js`
and spec 071's estate reads.

## Risks

| Risk | Handling |
|---|---|
| `AccountCreated` volume makes leg B too slow on Polygon | Measured in T-002 before the leg is built; deadline-bounded so it degrades to `unverified` rather than hanging (research R7) |
| A member enters an address they do not control | The chain decides, never the input; the refusal test is the one that matters |
| Recovery becomes the next unbounded wait | Every leg deadline-bounded — the direct lesson of v1.16.1 |
| Deploy block recorded wrong (too late) | A too-late block silently misses accounts; T-001 verifies the recorded block against the factory's first `AccountCreated` rather than trusting the deployment transaction alone |
