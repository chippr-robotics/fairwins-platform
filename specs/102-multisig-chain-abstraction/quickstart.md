# Quickstart: spec 102

## Run the surface

```bash
npm run dev --workspace frontend -- --port 5199 --strictPort
# open http://localhost:5199/wallet?tab=custody
```

Seed a two-chain vault without a chain (DevTools console, before reload), replacing `<addr>` with
the connected wallet lowercased:

```js
localStorage.setItem('fw_user_<addr>_custody_vault_references', JSON.stringify([
  { address: '0xcf76db7aa9fb1bFE08e010468F3344bB458abCDe', chainId: 137, label: 'Treasury', addedAt: 1, role: 'owner' },
  { address: '0xcf76db7aa9fb1bFE08e010468F3344bB458abCDe', chainId: 8453, label: 'Treasury', addedAt: 1, role: 'owner' },
]))
```

You should see ONE card, "2 networks". "⋯" opens the sheet; Queue shows a per-network read line
for each chain (unreadable without RPC — that is the honest state).

## Tests

```bash
npx vitest run src/test/custody/vaultGroups.test.js src/test/custody/VaultSheet.test.jsx \
  src/test/custody/VaultQueueView.test.jsx src/test/custody/VaultDetailsView.test.jsx \
  src/test/custody/VaultCardList.test.jsx src/test/format/amount.test.js \
  src/test/wallet/WrapView.test.jsx --root frontend
npm run e2e:matrix && npm run check:e2e-matrix
cd frontend && npx cypress run --spec cypress/e2e/fast/42-protect-vault-sheet.cy.js   # needs dev:fast
```

## Screenshots

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-vault-sheet.mjs
```
