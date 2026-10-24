# Quickstart: Funding Pools (spec 103)

## Contracts

```bash
npm run compile
npx hardhat test test/pools/FundingPool*.test.js test/upgradeable/FundingPoolFactory.upgrade.test.js
npx hardhat test test/intent/TypehashParity.test.js       # structs + domains vs the package
npm run check:storage-layout
node scripts/codegen/bytecode-digest.js --compare specs/075-monorepo-workspaces/baseline-bytecode.json
```

## Local chain + frontend

```bash
npx hardhat node &                                        # terminal 1
npm run setup:local                                       # deploys everything incl. deploy:local:funding
npm run frontend                                          # /app → Request → Pool
```

## Frontend tests (scoped — never the full suite locally)

```bash
cd frontend && TZ=UTC npx vitest run src/test/funding
```

## E2E

```bash
# no-chain
cd frontend && CYPRESS_VIEWPORT_PROFILE=phone npx cypress run --spec cypress/e2e/fast/42-funding-pools.cy.js
# on-chain (needs the node + setup:e2e)
cd frontend && npx cypress run --spec cypress/e2e/full/39-funding-pools.cy.js
npm run e2e:matrix && git diff --exit-code docs/developer-guide/e2e-coverage-matrix.md
```

## Actor–critic screenshots

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
npx hardhat node & npm run setup:local
npm run dev --workspace frontend -- --port 5199 --strictPort &
NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-funding-pools.mjs
```

Shots land in `specs/103-funding-pools/screenshots/`; the README there records each round.

## Manual walkthrough

1. `/app` → Request → Pool. Purpose "Dana's party", goal 120, window 1 week → Create.
2. Copy the link; open it as a second account → contribute 40; feed shows the entry, bar 33%.
3. As the organizer: Close & collect → balance +40, state Closed.
4. New pool; two contributors; each votes to refund → Refunding after the 2nd; each collects.
