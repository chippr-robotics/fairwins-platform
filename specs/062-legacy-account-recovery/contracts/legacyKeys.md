# Contract: `lib/recovery/legacyKeys.js` (extended)

Existing functions (shipped) stay unchanged. This feature **adds** multi-asset sweep functions;
`quoteNativeSweep`/`sweepNativeToSmartAccount` remain for the native-only path but the panel moves to
the all-asset functions below.

## Existing

- `classifySecret(input) → { kind: 'privateKey'|'mnemonic', address, secret, wordCount } | { kind: 'empty'|'invalid' }`
- `addressFromSecret({ kind, secret }) → string`
- `signerForSecret({ kind, secret }, { chainId?, client? }) → Signer | null`
- `encryptLegacySecret({ secret, kind, address, passphrase, deps? }) → Promise<VaultEntry>`
- `decryptLegacySecret({ entry, passphrase, deps? }) → Promise<string>`  *(wrong pass ⇒ throws)*
- `legacyKeyVault(storage?) → { list, get, has, set, delete }`
- `quoteNativeSweep({ kind, secret, chainId?, client? }) → Promise<{ from, balance, gasReserve, sendable, gasLimit, gasPrice }>`
- `sweepNativeToSmartAccount({ kind, secret, to, chainId?, client? }) → Promise<TxResponse>`

### Amendment (spec 110, T028) — the chain is an argument, not a provider

`walletFromSecret({ kind, secret }, provider?)` is **replaced** by the two functions above, and
every network-touching function takes `chainId` (with `client` as the injection point) in place of
a `provider`. The split is deliberate and the rename is the point: a caller that wanted only an
address (`crossChainDerive`) was building a whole signer to read `.address` off it, and a stale
caller passing a provider positionally into the new shape would have silently got an
address-only object instead of a signer. A rename makes that a build error.

`Signer` is an ethers-SHAPED duck type (`lib/chains/localKeySigner.js`) over a viem local
account — `sendTransaction`/`getAddress`/`signMessage`/`signTypedData` plus `provider`, with
`tx.wait()` rejecting on a reverted receipt exactly as ethers' did. It is `null` when the chain
has no configured route; `unlockLegacyAccount` raises rather than returning one, because a caller
handed `null` there would report "unlocked" and fail at the first send.

Two library differences are handled at the seams rather than here: the fee policy
(`lib/chains/feeData.js` — viem's own estimate is 1.2× base where ethers' was 2×, and it throws
outright on a legacy-priced chain such as ETC 61 / Mordor 63) and the nonce floor at zero
(`lib/chains/localKeySigner.js` — viem's stale-read guard is written `previousNonce > 0`, so a
never-used recovered account gets its first two transactions at the same nonce).

## New: `quoteAllAssets`

```
quoteAllAssets({ kind, secret, chainId, client?, registry? }) → Promise<{
  from: string,
  holdings: Array<{ asset, balance: bigint }>,   // non-zero only; ERC-20s then native
  nativeGasReserve: bigint,
  hasNative: boolean,
}>
```

- `registry` defaults to `getPortfolioRegistry(chainId).filter(a => a.kind === 'native' || a.kind === 'erc20')`.
- Reads native via `getBalance(from)` and each ERC-20 via `balanceOf(from)` on the chain's client, **concurrently**.
- Excludes zero balances. `nativeGasReserve` = `~21000 * gasPrice * 1.2` (from `getFeeData`).
- Read-only; no signing.

## New: `sweepAllAssets`

```
sweepAllAssets({ kind, secret, to, chainId, client?, onProgress? }) → Promise<Array<{
  asset, status: 'sent'|'skipped'|'failed', txHash?: string, error?: string,
}>>
```

- Validates `to` (`lib/evm/address#isAddress`) and `to !== from`; throws on invalid destination.
- Transfers **ERC-20s first** (an `encodeFunctionData` `transfer(to, value)` call sent through the signer → `.wait()`),
  then **native last** (send `balance - nativeGasReserve` if positive, else native `skipped`).
- A single asset failure is caught and recorded as `status:'failed'` with `error`; the sweep **continues**.
- `onProgress(outcome)` (optional) is called after each asset for live UI.
- **Never** logs the secret; the signer is built once via `signerForSecret`, and ONE client serves the reads, the nonce, the fee schedule and every send.

## Errors

- Invalid/empty destination → `throw new Error('Enter a valid destination address.')`
- Destination equals the legacy address → `throw new Error('Choose a destination other than the legacy account.')`
- No route for the chain → `throw new Error('No network connection to read balances.')`
- Per-asset failures never throw out of `sweepAllAssets`; they surface as `failed` outcomes.
