# Quickstart — Spec 105 validation

## Prerequisites

- `npm run deps:reinstall`-clean workspace (never bare `npm install`; spec 075)
- Dev server: `npm run dev:fast` (port 5173)
- On-chain tier: `npm run setup:e2e` (hardhat node + Safe fixtures via
  `scripts/e2e/setup-custody-fixtures.js`; deploys guard V2 + hub + canonical Safe set)

## Unit (Vitest — scoped runs only, full suite OOMs locally)

```bash
npx vitest run frontend/src/test/custody/vaultCreationRecords.test.js \
               frontend/src/test/custody/vaultRulesConfig.test.js \
               frontend/src/test/custody/vaultDeployment.test.js \
               frontend/src/test/custody/describeProposal.test.js
npx vitest run frontend/src/test/custody   # whole custody dir before pushing
```

Prove, at minimum: record immutability + merge determinism; initializer replay reproduces the
recorded address (pure `computeVaultAddress`); banded lane realization + inapplicable-stable
disclosure; every deployment-state transition incl. `already-live` and per-stage `failed`;
`describeProposal` returns null (not a guess) for unknown calldata; needs-you truth table.

## No-chain e2e (both viewport profiles)

```bash
CYPRESS_RUN_BINARY=$HOME/.cache/Cypress/*/Cypress/Cypress \
CYPRESS_VIEWPORT_PROFILE=desktop npx cypress run --spec frontend/cypress/e2e/fast/43-vault-create-flow.cy.js
CYPRESS_VIEWPORT_PROFILE=phone   npx cypress run --spec frontend/cypress/e2e/fast/43-vault-create-flow.cy.js
```

Covers: four-sheet navigation; preset semantics (Joint fixes 2 owners/1 sig; Controlled tracks n);
rules tiles + live summary; network multi-select honesty (rail-unavailable reason in place);
Details one-card render with drift + unreadable disclosures (stubbed loopback RPC, spec-102
pattern); queue chips/needs-you/decoded rows; Load sheet restyle + `cy.a11yScan` per sheet.

## On-chain e2e (money path — spec 094 admission rule)

Extend `full/29-protect-custody.cy.js` (or sibling): create a Joint vault via the flow on the
local chain → address matches prediction → rules installed (guard set, `readPolicyV2` shows the
three-lane set) → an over-cap send is refused by preview → deploy-later path re-lands the same
address. Controlled path: rules land as queued proposals ("awaiting approval" shown).

## Matrix + gates

```bash
npm run e2e:matrix         # regenerate doc after adding spec-105 rows
npx vitest run frontend/src/test/e2e-policy frontend/src/test/brand
npm run lint --workspace frontend && npm run build --workspace frontend
```

## Manual screen validation

Actor-critic loop (skill `actor-critic-screens`): all four sheets + Details + Queue + Load, both
themes × both viewports; record under `specs/105-multichain-vault-creation/screenshots/`.
