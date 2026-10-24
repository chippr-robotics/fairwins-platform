# Data Model — Multi-Currency Wrap/Unwrap (spec 108)

No persistent state is added: no synced objects, no device prefs, no storage keys. All
entities are in-memory view/hook state.

## WrappableCoin (option-builder output; SelectableAsset-shaped, spec 064)

Produced by `config/wrappedNative.js#listWrappableCoins()` — one per
`cohortChainIds().filter(hasWrappedNative)` chain.

| Field | Type | Rules |
|---|---|---|
| `key` | string | `native:<chainId>` (wrap direction) / `wrapped:<chainId>` (unwrap) — stable, unique |
| `chainId` | number | a cohort chain with a configured wrapper; never crosses the cohort |
| `kind` | `'native' \| 'wrapped'` | decides which balance is read and which leg of the pair is spent |
| `symbol` | string | native: `NETWORKS[chainId].nativeCurrency.symbol`; wrapped: derived `W<symbol>` label (display hint — the view still prefers the contract's own `symbol()` once read) |
| `networkName` | string | `NETWORKS[chainId].name` — rendered on every row (multi-chain list always badges) |
| `wrapped` | `{ address, symbol, name, decimals }` | verbatim `getWrappedNative(chainId)`; never synthesized elsewhere |

Validation: `listWrappableCoins()` returns `[]` rather than throwing when the cohort has
no wrappable chain; an unconfigured chain is absent, not a disabled row with a guessed
address.

## CoinBalanceReading (per option, from `useWrapCoinOptions`)

Settled semantics (`readBalancesSettled`): a value exists only when the chain answered.

| Field | Type | Rules |
|---|---|---|
| `balance` | `bigint \| null` | `null` = not read (renders "—"); NEVER coerced to `0n` |
| `readState` | `'read' \| 'unreadable' \| 'pending'` | per chain, failure-isolated — one dark chain never blanks the list |

State transitions: `pending → read` (chain answered) or `pending → unreadable` (settled
rejection / provider absent). A later refresh may move `unreadable → read`; it never moves
anything to a fabricated zero.

## WrapTarget (hook input, `useWrapNative({ chainId })`)

| Field | Type | Rules |
|---|---|---|
| `chainId` | `number \| undefined` | undefined ⇒ wallet's connected chain (byte-compatible with today's callers) |

Derived, all re-bound to the target chain: `token` (`getWrappedNative(target)`),
`readProvider` (`getReadProvider(target)`), `gasReserve` (target fee data × 100k × 2),
`sponsored` (`NETWORKS[target].passkey?.sponsorPaymasterUrl` + `sendCalls`' own report),
`writeRail` (below).

## WrapWriteRail (derived; the "stated before the tap" fact)

| Value | When | Member-facing consequence |
|---|---|---|
| `signer-same-chain` | classic signer, wallet already on target | plain submit |
| `signer-switch` | classic signer, wallet elsewhere | submit switches first (settle loop: 150 ms poll, 20 s timeout); refusal names both chains, sends nothing |
| `passkey` | passkey session AND `isPasskeySupported(target)` | `sendCalls(calls, { chainId: target })` |
| `unavailable` | passkey session, target unsupported | `getPasskeySupport(target).reason` rendered in place of the action |
| `acting-account` | vault / legacy / hardware active | existing `useWrapNative` refusal wording unchanged; picker pins to the acting account's chain |

Invariant: `unavailable` is a *rail* fact, not "view-only" — the coin row stays visible
with its reason, exactly the spec-102 Queue convention.

## Amount (view state)

- Cleared whenever the selected coin (or direction) changes — a MAX quoted against one
  chain's balance/reserve is never carried to another.
- Parse/over-balance/over-spendable rules unchanged from the current `WrapView`.
