# Wrap & Unwrap the Native Coin

**Trade ▸ Wrap** turns any supported network's coin into its canonical wrapped ERC-20 form, and
back again. It is the plainest money-moving surface in the app, because the operation itself is
plain: a WETH9-shaped contract mints exactly what you send it on `deposit()` and burns exactly what
you name on `withdraw(wad)`.

- View: `frontend/src/components/wallet/WrapView.jsx`
- Engine: `frontend/src/hooks/useWrapNative.js`
- Picker options + balances: `frontend/src/hooks/useWrapCoinOptions.js`
- Address resolution + candidate list: `frontend/src/config/wrappedNative.js`
- ABI: `frontend/src/abis/WNative.js` (already used by `DexContext` for its wrapped-balance read)
- Tests: `frontend/src/test/wallet/{wrappedNative,useWrapNative,useWrapCoinOptions,WrapView}.test.*`

## The asset is the entry point (spec 108)

The view is no longer pinned to the connected chain. A trading-view-style picker
(`UniversalAssetSelect`, spec 064) lists every **cohort** chain's base coin that has a configured
wrapper — `listWrappableCoins()` lives beside the resolver in `config/wrappedNative.js`, so the file
that answers "what is the wrapped form here?" also owns "which coins are offered" — with the
member's balance beside each, read per chain through `readBalancesSettled` + `getReadProvider` with
failure isolation (an unreadable chain's row shows `—`, never `0`, and stays selectable).

The **network is a property of the selection**, resolved at submit time per rail
(`useWrapNative({ chainId })`, default: the wallet's chain — every pre-108 caller is unchanged):

- **Classic signer, other chain** → switch-then-settle first (the spec-102 / `useEarnSend`
  device: awaited `switchNetwork`, then a 150 ms poll on a render-updated snapshot until the
  chain-scoped signer exists, 20 s deadline). A refusal names BOTH chains and sends nothing.
- **Passkey** → the batch is chain-targeted by parameter (`sendCalls(calls, { chainId })`),
  offered only where `isPasskeySupported(target)`; elsewhere the rail is stated as unavailable
  BEFORE the tap, with the support seam's own reason.
- **Vault / legacy / hardware** → unchanged refusals; the picker pins to the acting account's
  chain (multichain custody actions belong to spec 102, not this surface).

Changing the coin clears the amount — a MAX quoted against one chain's balance and gas reserve is
never carried to another. Sponsorship, the reserve, and the fee line all follow the **target**.

E2E: `fast/48-wrap-multi-currency.cy.js` (picker honesty, refused switch) and
`full/45-wrap-cross-chain.cy.js` (real cross-chain deposit on the local chain).

Members need the wrapped form for anything that only accepts an ERC-20 — a DEX pair, a liquidity
position, a contract that takes `transferFrom`. Previously the app could *show* a member their
wrapped balance (it is in the portfolio registry) with no way to obtain or redeem one in-app.

## It is not a swap and not a bridge

Nothing here has a price, a quote, a slippage tolerance, a counterparty, or an expiry — and the view
must never grow controls that imply otherwise. The rate is 1:1 in both directions, permanently, and
the entire cost is the network fee. That is why:

- the confirm block states `1:1 — no price, no slippage` rather than showing a rate row that could be
  mistaken for a market;
- there is no route, no protocol attribution and no venue link — the contract is the network's own;
- the only disclosed cost is the fee line, which reads *sponsored* only when the passkey UserOp
  genuinely is (spec 050), and `You pay the <COIN> network fee` in every other case.

## One resolver for "what is the wrapped coin here?"

`config/wrappedNative.js#getWrappedNative(chainId)` is the single seam. It reads, in order:

1. `NETWORKS[chainId].dex.wnative` — what the swap surface pairs against;
2. `getContractAddressForChain('wmatic', chainId)` — the synced deployment record. Despite the key's
   name this holds **WETC** on Ethereum Classic and Mordor; it is the DEX wrapper the contracts were
   configured with, not a Polygon token.

`getPortfolioRegistry` (`config/assetTaxonomy.js`) used to re-derive the same answer from the same
two sources inline. It now calls this resolver, so a chain cannot be wrappable on one surface and
missing from the portfolio on the other.

**There is deliberately no curated fallback table.** Wrapping sends a member's coin to whatever
address this returns, so an address that is not already in the app's own verified configuration is a
guess — and a guess here is unrecoverable. A network without one resolves to `null` and the Wrap view
says exactly that (Constitution III). Sepolia, Hoodi and an unconfigured Amoy are in that state
today; adding one means adding the address to that network's config, where
`scripts/ops/verify-protocol-addresses.js` covers it, not to a table in this feature.

`symbol`/`name` from the resolver are **derived labels** for the first render only. The hook then
asks the contract what it calls itself and prefers that answer — Polygon's wrapper answers `WPOL`
while `NETWORKS[137].nativeCurrency` still says `MATIC`, and the member should see the token's own
name.

## Routing mirrors `useTransfer`

"Who is acting" is the same question it is for a send, so the answer is the same shape:

| Acting as | What happens |
|---|---|
| Custody vault (spec 043) | A threshold-gated **proposal** (`useActiveAccount().submit`) — nothing moves until the signers approve. Button reads *Propose*. |
| Recovered legacy account (spec 062) | Signed by the unlocked in-memory key through the same seam, never by the connected wallet. |
| Passkey smart account (specs 041/050) | One `sendCalls` batch, sponsored where the chain runs a paymaster. |
| Classic wallet | A plain transaction; the sender pays the fee. |

Both the vault and legacy branches re-check the network before signing, and a passkey op that is
submitted but never included is reported as **pending** — a `userOpHash` is not a transaction hash,
no explorer resolves one, and it is never rendered as one.

## Two honesty rules the tests pin

**An unread balance is not a zero balance.** A failed read leaves the balance `null`, the view
renders `—`, and it says the value could not be read. Rendering `0` would be a false claim about the
member's money.

**MAX never spends the fee.** Wrapping is paid for in the very coin being wrapped, so `maxWrappable`
is the balance less a gas reserve quoted from the chain's own `getFeeData()` (doubled against a fee
tick between quote and signature), and the view discloses the hold-back. Unwrapping has no such
reserve — the fee comes out of the native balance, which is not the balance being spent. An amount
above the reserve but within the balance gets its own message ("leaves nothing for the network fee"),
because "exceeds balance" would not be true.

## Where Activity went

The Transfer section no longer has an Activity tab. Transfer history belongs to the activity ledger
(spec 051) and **My Account ▸ Activity** renders it in full, for every class of entry; a
transfer-only copy of the same feed inside this section only created two places to look for one
answer. The `?view=activity` id is gone with it, so a saved link falls back to Transfer rather than
opening an empty panel.

Wrap results are reported in place (a notification plus an explorer link for the confirmed
transaction) rather than written to the ledger — a wrap has no counterparty and no value change, so
a ledger entry would be a transfer-shaped record of something that is not a transfer.
