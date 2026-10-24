# Implementation Plan: Multi-Currency Wrap/Unwrap

**Branch**: `claude/multichain-experience-improvements-7z3wti` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/108-multi-currency-wrap/spec.md` (issue #1439)

## Summary

The Wrap view stops being pinned to the connected chain. A member picks any cohort chain's
base coin they hold from one trading-view-style picker; the app resolves that chain's
canonical wrapped-native contract (`config/wrappedNative.js`, no guessed addresses) and, at
submit time, retargets the write: a classic signer is switched-then-settled onto the coin's
chain (the `useEarnSend.sendOnChain` / spec-102 `settleOnVaultChain` precedent), a passkey
batch pins the target chain via the `sendCalls` `{ chainId }` override where
`isPasskeySupported(target)`. Unwrap is symmetric. Frontend only — no contract, gateway, or
deployment changes.

## Technical Context

**Language/Version**: JavaScript (ES2022), React 18, Vite 8 (rolldown)

**Primary Dependencies**: ethers v6, wagmi (chain switching), existing app seams only — no new packages (spec-075 lockfile rules)

**Storage**: none new; no synced objects, no device prefs

**Testing**: Vitest (hook + option-builder units), Cypress fast tier (picker honesty) + full tier (cross-chain submit, money path)

**Target Platform**: web/PWA + Capacitor shells (no native seam involvement — pure web code)

**Project Type**: web frontend feature inside the existing `frontend/` workspace member

**Performance Goals**: picker opens without blocking on chain reads (balances stream in settled, per chain)

**Constraints**: unread balance ≠ 0 (Constitution III); cohort boundary never crossed; no curated wrapper fallback; MAX still holds back the gas reserve on the selected chain's own fee data

**Scale/Scope**: ~6 cohort chains mainnet / ~3 testnet; 1 new hook + 1 option builder + WrapView changes; 2 e2e flows

## Constitution Check

- **I. Security-first contracts**: PASS — `contracts/` untouched. The one fund-path decision
  (which address receives the coin) stays inside `getWrappedNative`, which already refuses
  unconfigured chains rather than guessing (spec's non-goal restates it).
- **II. Test-first**: PASS — Vitest for the option builder + retargeted hook (including the
  refusal arms); the two matrix flows land as real Cypress specs in this feature
  (`trade.wrap-multi-currency-picker` fast tier, `trade.wrap-cross-chain-submit` on-chain
  tier — the member signs something that costs money, so the e2e policy's money-path rule
  applies).
- **III. Honest state**: PASS by design — settled per-chain balance reads (`null` stays "—"),
  cohort-scoped candidates (`cohortChainIds()`, never `listSupportedChainIds()`), refused
  switches name both chains and send nothing, no finality overstated (existing
  `pending`/userOpHash honesty in `useWrapNative` is kept).
- **IV. Fail loudly in CI**: PASS — no CI shape changes; new specs join existing sharded
  tiers via `tier-split` (unmeasured specs are estimated and announced).
- **V. Accessible frontend**: PASS — picker reuses `UniversalAssetSelect` (already
  axe-covered); new controls keep the `pt-*` vocabulary; a11y scans ride the existing
  fast-tier `cy.a11yScan` rules.

No deviations; no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/108-multi-currency-wrap/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
└── tasks.md             # Phase 2 (/speckit-tasks)
```

(No `contracts/` dir: the feature adds no external interface — no new contract, API, or
host-object surface. The on-chain interface is the chains' existing WETH9 `deposit`/
`withdraw`, already carried by `abis/WNative.js`.)

### Source Code (repository root)

```text
frontend/src/
├── config/wrappedNative.js          # + listWrappableCoins() (cohort × hasWrappedNative)
├── hooks/
│   ├── useWrapNative.js             # takes an explicit target { chainId }, retargets rails
│   └── useWrapCoinOptions.js        # NEW: candidate coins + settled per-chain balances
├── components/wallet/WrapView.jsx   # + coin picker (UniversalAssetSelect), target-aware copy
└── test/wallet/                     # unit coverage beside the existing wrap tests

frontend/cypress/e2e/
├── fast/…                           # picker honesty (both viewports ride free)
└── full/…                           # cross-chain wrap execution + refused-switch leg
```

## Phase 0 → research.md, Phase 1 → data-model.md + quickstart.md (see files)

## Design decisions (binding for tasks)

1. **The candidate list is `cohortChainIds().filter(hasWrappedNative)`**, built in
   `config/wrappedNative.js#listWrappableCoins()` so the config file that owns "what is
   wrappable" also owns "what is offered" — one resolver, one list (its own header's rule).
   Each candidate is a SelectableAsset-shaped option (spec 064): `{ key, chainId, symbol,
   networkName, kind: 'native' }` plus its wrapped twin for the unwrap direction.

2. **Balances are a read layer, not a gate.** `useWrapCoinOptions` feeds
   `readBalancesSettled` one native (or wrapped, per direction) asset per candidate chain
   through `getReadProvider(chainId)`; a failed chain's row renders "—" and stays
   selectable. No `?? 0`, no zero-fabrication — `null` survives to the view
   (`formatUnitsForDisplay` renders it as "—" already).

3. **`useWrapNative` gains a target, not a fork.** The hook takes
   `{ chainId: targetChainId }` (default: the wallet's chain — existing behaviour is byte-
   compatible for callers that pass nothing). Internally: reads bind to the TARGET chain
   (`getReadProvider(target)`, `getWrappedNative(target)`, fee/gas reserve from the target);
   the write path retargets per rail:
   - **classic signer**: if `walletChainId !== target`, switch-then-settle before
     `sendTransaction` — `switchNetwork(target)` then the 150 ms / 20 s poll on a
     `latestRef` snapshot until `chainId === target && signer` (exact
     `useActiveAccount.settleOnVaultChain` shape); a refusal throws
     `"This wrap runs on <target>, but the wallet stayed on <current> — nothing was sent."`
   - **passkey**: `sendCalls(calls, { chainId: target })` where
     `isPasskeySupported(target)`; where not, the rail is refused BEFORE the tap with the
     `getPasskeySupport(target).reason` text (write-rail precedent: state the reason in
     place of a button that would throw).
   - **vault / legacy / hardware**: unchanged acting-account refusals; the picker pins to
     the acting account's chain(s) exactly as today (`canActAsVault` etc. already carry the
     switch machinery from spec 102 — surfacing a multichain vault wrap is NOT widened
     here; the vault path keeps its existing single-chain behaviour).

4. **Sponsorship, MAX and fee copy follow the TARGET.** `sponsored` reads the target
   chain's paymaster config; the gas reserve quotes the target chain's fee data; the fee
   line names the target coin. A MAX computed on one chain is never applied to another —
   changing the selection clears the amount (the spec-105 sheet-reset precedent).

5. **The picker is `UniversalAssetSelect`** with `pinPredicate` favouring coins with a
   non-zero read balance and the network name on every row (multi-chain rows always badge,
   the `TradeTokenSelect` visual convention). Direction stays the existing two-radio
   control; the asset select replaces the implicit "connected chain" as the subject.

6. **No nav/tab changes.** Wrap stays a Trade view (spec 082 owns the switch); deep links
   (`?tab=trade&view=wrap`) are unchanged.

## Phase 2 note

Tasks are generated by `/speckit-tasks` into tasks.md. Validation gates for this feature:
scoped Vitest suites, `npm run e2e:matrix` regenerate-and-diff after flipping the two
matrix rows to `covered`, actor-critic screenshots over the reworked view (both themes ×
both viewports), and the standard monorepo-verify pass (no dependency changes expected, so
byte gates should be no-ops).
