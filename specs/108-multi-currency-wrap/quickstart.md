# Quickstart — validating multi-currency wrap/unwrap (spec 108)

## Prerequisites

- Root install healthy (`npm run check:deps` — never recover with `npm install`; see the
  monorepo-workspace skill).
- For on-chain legs: the standard local stack — `npm run node:e2e` then `npm run setup:e2e`.

## Unit validation (fast, no chain)

```bash
cd frontend
npx vitest run src/test/wallet/wrappedNative.test.js        # listWrappableCoins cohort/coverage rules
npx vitest run src/test/wallet/useWrapCoinOptions.test.jsx  # settled balances: null stays null
npx vitest run src/test/wallet/useWrapNative.test.jsx       # target rebinding + rail refusals
npx vitest run src/test/wallet/WrapView.test.jsx            # picker renders, amount resets on selection
npx vitest run src/test/e2e-policy/                          # matrix rows still well-formed
```

Expected: all green; the useWrapNative suite includes the switch-refusal arm asserting the
error names BOTH chains and that nothing was submitted.

## E2E validation

```bash
# Picker honesty (no chain; runs at both viewports in CI):
npx start-server-and-test dev:fast http://localhost:5173 \
  'cypress run --spec cypress/e2e/fast/<picker-spec>.cy.js'

# Cross-chain submit (on-chain tier; local chain + deployed fixtures):
CYPRESS_E2E=1 npx cypress run --spec cypress/e2e/full/<wrap-spec>.cy.js
```

Expected outcomes map 1:1 to the matrix rows:
- `trade.wrap-multi-currency-picker`: every cohort coin with a configured wrapper is
  listed with its network name; a chain whose RPC stub refuses answers shows "—" (asserted
  not to be "0"); Sepolia-class chains are absent, not disabled-with-an-address.
- `trade.wrap-cross-chain-submit`: with the mock wallet connected to chain A, selecting
  chain B's coin and submitting first requests the network switch, then wraps against
  chain B's own wrapper (asserted by reading the wrapped balance from chain B); the
  refused-switch leg asserts the both-chains error and zero balance movement.

## Manual smoke (dev server)

1. `npm run frontend`, connect the mock/dev wallet on the local chain.
2. Trade ▸ Wrap: the amount card now leads with the coin picker. Confirm: rows show
   icon + symbol + network + balance; searching "pol"/"etc" filters; picking a coin the
   wallet's chain doesn't match shows the switch disclosure on the submit button copy.
3. Wrap a small amount on the connected chain (no switch) — 1:1 receipt, fee line names
   that chain's coin. Switch direction — the wrapped-side balances and MAX cap follow.
4. Select another chain's coin and submit — the wallet prompts the switch; decline it and
   confirm the refusal names both chains and no transaction was created.

## Gates before PR

```bash
npm run e2e:matrix && npm run check:e2e-matrix   # rows flipped to covered + doc regenerated
npm run check:specs
cd frontend && npx vitest run src/test/wallet/ src/test/e2e-policy/
```

Plus the actor-critic screenshot loop over the reworked Wrap view (both themes × both
viewports) — the surface is member-facing UI.
