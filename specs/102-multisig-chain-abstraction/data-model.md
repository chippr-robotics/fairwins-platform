# Data model: spec 102

No new persistent entities. Two in-memory shapes and one context change.

## VaultGroup (in-memory, `lib/custody/vaultGroups.js`)

```js
{
  key: '0xabc…',                 // lowercased address — identity
  address: '0xAbC…',             // checksummed (first instance's)
  label: 'Treasury',             // first non-empty instance label (address book wins upstream)
  instances: [vault, …],         // enriched per-chain objects from useCustodyVaults, as-is
  chainIds: [137, 8453],         // Number[], instance order
  readable: [vault, …],          // instances with isSafe === true
  unreachable: [63],             // chainIds with reachable === false
  unreadable: [1],               // chainIds with isSafe === false
  networkLine: 'Polygon' | '2 networks',
  threshold: { value: 2, of: 3 } | null,   // from the first readable instance
  thresholdVaries: false,        // true when readable instances disagree on threshold/owner count
  owners: ['0x…'],               // union across readable instances (checksummed, deduped)
  anyOwner: true,                // member is owner on ≥1 instance
  ownerChainIds: [137],          // instances where the member is an owner
  policyStatus, policySummary,   // from the first readable instance carrying one
  pinnedChainId: 137,            // pickVaultChain({chainIds, walletChainId}) at group time
  connectedInstance: vault|null, // instance on the wallet's chain
}
```

`pickVaultChain({ chainIds, walletChainId, preferred })` → `preferred` if in `chainIds`, else
`walletChainId` if in `chainIds`, else `chainIds[0]`.

## Queue read (in-memory, `hooks/useVaultQueueAcrossChains.js`)

```js
byChain: {
  [chainId]: {
    state: 'read' | 'unreadable' | 'not-configured' | 'not-supported' | 'loading',
    proposals: [ { ...proposal, chainId, approvers, approvals, threshold, status } ],  // read only
    partial: false,   // read but backfill incomplete
    error: 'string',  // unreadable only
    owner: true,      // member is owner on this chain
  }
}
rows: proposals from every `read` chain where isQueued(status), sorted by blockNumber desc
pending: rows.length
missing: chainIds whose state is not 'read'
partial: missing.length > 0 || any byChain.partial
```

`summarizeQueue(byChain)` → `{ pending, networks, missing, partial, line }` where `line` is e.g.
`"3 pending across 2 networks"` or `"2 pending · Optimism not read"`.

## Acting identity (`contexts/CustodyContext.jsx`)

```js
active = {
  mode: 'vault',
  vaultAddress, label,
  chainIds: [137, 8453],   // NEW — every chain the vault exists on at switch time
  chainId: 137,            // the resolved chain: wallet's if in chainIds, else the pin
}
```

`operateAsVault({ address, chainIds = [chainId], chainId, label })`. Existing callers passing a
single `chainId` keep working (`chainIds` defaults to `[chainId]`).

## Display formatting (`lib/format/amount.js`)

`formatUnitsForDisplay(raw, decimals = 18, { maxFractionDigits } = {}) → string | null`

| input | output |
|---|---|
| `null` / `undefined` | `null` |
| `0n` | `'0'` |
| `< 0.000001` (non-zero) | `'< 0.000001'` |
| `0.000001 ≤ v < 1` | up to 6 fraction digits, trailing zeros trimmed |
| `≥ 1` | up to 4 fraction digits (or `maxFractionDigits`), grouped |
| unparsable | `null` |

## Coverage matrix row

`102-multisig-chain-abstraction` — flows `custody.vault-cards`, `custody.vault-sheet-queue`,
`custody.cross-chain-approve`, `custody.vault-style`, `custody.vault-details`,
`custody.acting-from-sheet`, `custody.load-all-networks`, `wallet.balance-display`.
