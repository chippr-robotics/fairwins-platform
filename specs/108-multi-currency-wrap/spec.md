# Feature Specification: Multi-Currency Wrap/Unwrap — the asset is the entry point

**Feature Branch**: `claude/multichain-experience-improvements-7z3wti`

**Created**: 2026-09-06

**Status**: Reserved — skeleton (problem + scope); full requirements land with the plan

**Input**: Issue #1439 — "make wrap/unwrap multi currency": members need to wrap or unwrap
any supported base token they hold without manually visiting the network selector first.

## Problem

The Wrap view (Trade ▸ Wrap, spec 082's view switch) is pinned to the **connected** chain:
`useWrapNative` resolves `getWrappedNative(useWallet().chainId)` and offers exactly that one
coin. A member holding POL, ETH and ETC who wants WETC must first find the network selector,
switch to Ethereum Classic, and come back — three steps of network plumbing for a 1:1
operation with no price, no slippage and no counterparty. The platform already treats "which
network" as a property of the transaction rather than a mode the member sets (spec 102's
tap-time switch; `useEarnSend.sendOnChain`'s switch-then-settle loop); Wrap is the surface
that still makes it a prerequisite.

## User Scenarios & Testing

### User Story 1 - Wrap any base coin from one picker (Priority: P1)

As a member, I select any supported network's base coin that I hold — from a dropdown in the
style of the Trade token picker, showing icon, symbol, network and my balance — and wrap it.
The app resolves that network's canonical wrapped-native contract itself and, at submit time,
switches the wallet if it is connected elsewhere. Unwrap works the same way in the other
direction (any wrapped coin I hold → its base coin).

**Why this priority**: it is the issue's whole ask — both acceptance scenarios on #1439 live
in this story.

**Independent Test**: with a wallet connected to chain A and holding chain B's coin, wrapping
chain B's coin end-to-end (picker → correct wrapper address → wallet switch prompt → executed
wrap) without touching the network selector.

**Acceptance Scenarios**:

1. **Given** an account holding a base network token on any supported chain in the build's
   cohort, **When** the member selects it in the Wrap view and confirms, **Then** the wrap
   (and the reverse unwrap) completes through the UI with no manual network-selector visit.
2. **Given** a base token selected for wrapping, **When** the member submits, **Then** the
   system resolves the appropriate network's wrapped-native contract for that token
   (`getWrappedNative`, no guessed addresses) and wraps against it on that token's own chain.
3. **Given** the wallet is connected to a different chain than the selected coin's,
   **When** the member submits, **Then** the wallet is switched at submit time and the
   transaction is sent only after the switch settles; a refused switch names both chains and
   sends nothing.

### User Story 2 - Honest balances and honest absences (Priority: P2)

The picker shows my balance beside each coin, read per chain with failure isolation: a chain
that could not be read shows "—" (never zero) and the selection still works; a chain with no
wrapped-native contract configured in this build is not offered as wrappable, exactly as the
single-chain view refuses today (no curated fallback addresses — an unconfigured wrapper
receives member funds and is never guessed).

**Acceptance Scenarios**:

1. **Given** one chain's RPC is unreachable, **When** the picker renders, **Then** that coin
   row shows an unread balance ("—"), other chains are unaffected, and nothing renders as a
   zero it did not read.
2. **Given** a cohort chain with no wrapper configured, **When** the picker renders,
   **Then** that coin is not offered for wrapping and the reason is stated where relevant.

## Scope

- Frontend only. No contract changes, no gateway changes: the wrappers are the chains' own
  canonical WETH9-shaped contracts already resolved by `config/wrappedNative.js`.
- Candidate list is `cohortChainIds().filter(hasWrappedNative)` — never
  `listSupportedChainIds()` (constitution III: reads never cross the testnet/mainnet
  boundary).
- Picker reuses the spec-064 `UniversalAssetSelect` (icon + symbol + network + balance +
  pin predicate); per-chain native balances via the settled batch-read primitive with
  spec-069 providers.
- Submit reuses the existing rails in `useWrapNative` unchanged per rail; what is new is
  targeting: classic signers switch-then-settle (spec-102 / `useEarnSend` precedent),
  passkey batches pin the target chain via the `sendCalls` chain override where
  `isPasskeySupported(target)`; vault/legacy/hardware keep their existing acting-account
  refusals.

## Non-goals

- Not a swap and not a bridge: one coin, its own chain's wrapper, 1:1, no routing across
  chains.
- No change to which chains have wrappers (no new curated addresses; Sepolia/Hoodi stay
  honestly unwrappable).
- No change to the Trade view switch or Wrap's place in it (spec 082 owns that).
