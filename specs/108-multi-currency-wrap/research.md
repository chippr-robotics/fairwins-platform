# Research — Multi-Currency Wrap/Unwrap (spec 108)

All unknowns from the Technical Context resolved against the codebase on 2026-09-06.

## R1 — Which chains can offer a wrap, and where the answer lives

**Decision**: candidates = `cohortChainIds().filter(hasWrappedNative)`, exposed as
`listWrappableCoins()` in `config/wrappedNative.js`.

**Rationale**: `getWrappedNative(chainId)` (`frontend/src/config/wrappedNative.js:34`) is
already the ONE resolver — `NETWORKS[chainId].dex?.wnative || getContractAddressForChain('wmatic', chainId)`,
`null` otherwise with deliberately no curated fallback (an unconfigured wrapper would
receive member funds). Coverage measured: mainnet cohort {1, 10, 61, 137, 8453, 42161} all
resolve (ETC 61 via its hardcoded default WETC in `networks.js`); testnet cohort resolves
Mordor 63 + Amoy 80002 + local 1337 (via `wmatic` deployments) while Sepolia 11155111 and
Hoodi 560048 honestly do not. `cohortChainIds()` (`config/networks.js:1160`) is mandatory —
`listSupportedChainIds()` crosses the testnet/mainnet boundary (constitution III).

**Alternatives considered**: a per-feature allowlist (second copy of the config, drifts);
extending `NETWORKS` with a new field (the resolver already unifies the two existing
sources — a third would recreate the split it fixed).

## R2 — Cross-chain balance reads

**Decision**: `lib/portfolio/batchBalances.js#readBalancesSettled` with one asset per
candidate chain, providers from `getReadProvider(chainId)` (spec 069), wrapped in a small
`useWrapCoinOptions` hook.

**Rationale**: it is the existing settled-semantics primitive — Multicall3-batched on
{1,10,137,8453,42161}, per-asset fallback on ETC/Mordor, and a failed read is skipped,
never zero. `usePortfolio` was rejected as the seam: heavier (prices, taxonomy, 60 s poll)
and its roster is `getPortfolioChainIds`, not the cohort. `useSwapBalances` is the right
*pattern* (balances follow the SELECTED network, `null` never zero) but ERC-20-only.

**Alternatives considered**: sequential `getBalance` per chain (no batching, no failure
isolation guarantees); extending `useAccountAssets` (connected-chain axis, wrong shape).

## R3 — Submit-time retargeting per rail

**Decision**: classic = switch-then-settle; passkey = `sendCalls` chain override; other
actors keep their existing refusals.

**Rationale**:
- Classic wallets ignore any chain parameter — the bound signer signs on whatever chain
  the wallet is on. The proven shape is `useEarnSend.sendOnChain`
  (`hooks/useEarnSend.js:104`): `switchChainAsync`/`switchNetwork(target)`, then poll a
  render-updated `latestRef` every 150 ms until `chainId === target && signer`, 20 s
  timeout, with refusal text naming both chains. Spec 102's
  `useActiveAccount.settleOnVaultChain` (`hooks/useActiveAccount.js:97`) is the identical
  device on the vault rail — precedent twice over.
- Passkey UserOps are chain-targeted BY PARAMETER: `WalletContext.sendCalls` accepts
  `{ chainId }` (`contexts/WalletContext.jsx:142-152`, passed to `sendPasskeyBatch`), so no
  switch ceremony exists or is needed. Gate on `isPasskeySupported(target)`
  (`config/passkeySupport.js:120` — bundler config AND deployed entryPoint/accountFactory;
  note `useEarnSend.canTransactOn` checks only the bundler half and is NOT the gate to
  copy). Where unsupported, `getPasskeySupport(target).reason` renders in place of the
  action (the write-rail rule: an unavailable rail is stated before the tap).
- Vault/legacy/hardware: `useWrapNative` already refuses with "switch to the …'s network"
  wording via `canActAsVault`/`canActAsLegacy`/`canActAsHardware`; widening vault wraps to
  arbitrary chains would drag in proposal-hub chain selection and is out of scope
  (spec 102 already gives vault-mode submit its own settle loop for the vault's chains).

**Alternatives considered**: making the picker filter to the connected chain for classic
wallets (defeats the issue's whole ask); auto-switching on SELECTION rather than submit
(a network prompt before the member has committed to anything — spec 105's rule is that no
network question is asked before a signature needs one).

## R4 — Where the target's config feeds the existing hook honesty

**Decision**: every read in `useWrapNative` re-binds to the target: `getWrappedNative(target)`,
`getReadProvider(target)` (replacing the `net?.rpcUrl ? makeReadProvider(...)` hand-build —
also the spec-069-preferred form), fee data → gas reserve, `NETWORKS[target].passkey`
sponsorship, on-chain `symbol()` label.

**Rationale**: the hook's invariants (unread ≠ 0, MAX holds back the target chain's quoted
reserve ×2, sponsored ⇒ no holdback, `pending` honesty for un-included UserOps) are all
already correct per-chain — the change is which chain, not the rules. Selection change
resets the amount so a MAX quoted on chain A is never submitted on chain B.

## R5 — Picker component

**Decision**: `components/ui/UniversalAssetSelect` fed by SelectableAsset-shaped options
(spec 064) from the new `useWrapCoinOptions`; `TradeTokenSelect` stays TradePanel-private.

**Rationale**: `UniversalAssetSelect` already renders artwork + symbol + network + balance
(`SensitiveValue` + display formatter), shares the `matchesAssetQuery` search rule, and
takes `pin`/`pinPredicate` with an honest empty-state — exactly the issue's "dropdown
similar to the trading view" with the balance column the trade pill lacks. Consumers
(PayPanel, RequestPanel, SupplySheet) prove the reuse path.

**Alternatives considered**: reusing `TradeTokenSelect` (no balance column, bespoke to
TradePanel's pair-leg semantics); a new bespoke dropdown (violates workflow simplicity —
YAGNI).

## R6 — E2E shape

**Decision**: picker honesty in the fast tier (stubbed RPC per chain, both-rails stubs per
issue #1463's lesson — every intercept matches `publicnode|drpc`); cross-chain submit in
the on-chain tier (the member signs something that costs money — e2e policy admission
rule 2), driving the classic-signer switch path against the local chain with the mock
wallet's chain-switch approval, plus the refused-switch leg asserting nothing was sent.

**Rationale**: mirrors how spec 105 split its flows; the two reserved matrix rows
(`trade.wrap-multi-currency-picker` → no-chain, `trade.wrap-cross-chain-submit` →
on-chain) were shaped for exactly this at reservation time.
