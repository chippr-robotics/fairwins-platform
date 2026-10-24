# Runtime Contract: Mini-App ↔ Host (`hostApi: 2`)

The contract between a mini-app package and the FairWins host. A mini-app's entry
module (`manifest.entry`) default-exports a React component; the host mounts it inside
`MiniAppHostProvider` and passes one frozen `host` prop (also exposed via
`useMiniAppHost()` from the SDK shared scope). Everything below is the **entire**
privileged surface — anything not listed is unreachable by design (FR-013).

## Shared module scope (build-time)

`globalThis[Symbol.for('fairwins.miniapp.host')]` (frozen) provides singleton
`react`, `react-dom`, `react/jsx-runtime`, `ethers`, `viem`, and `@fairwins/miniapp-sdk`.
The `tools/miniapp-build/` preset externalizes these bare imports to scope reads —
packages ship none of them. `manifest.hostApi` must be ≤ the host's supported version
or launch is refused.

`viem` joined the scope ADDITIVELY under spec 110 Phase 0 (issue #1591), still at
`hostApi: 2`: packages that do not declare it are unaffected, and a package declaring
`viem` in `sharedDeps` on a host predating the entry is refused at install by the
`sharedDeps ⊆ HOST_SHARED_MODULES` check — a loud refusal, so no version bump. The
breaking half — `ethers` LEAVING the scope — ships later as its own `hostApi` major
(spec 110 Phase 5, issue #1596), after all first-party packages are rebuilt and
re-approved at new CIDs.

## `host` context object

```ts
{
  appId: string,                       // registry-derived identity; namespace root
  wallet: {
    address: string | null,            // active identity (personal / vault / legacy per useActiveAccount)
    connectedAddress: string | null,
    chainId: number | null,
    isConnected: boolean,
    submit(payload: { to, data?, value?, chainId }): Promise<SubmitResult>,
    switchChain(chainId: number): Promise<void>,  // hostApi 2 — asks the wallet to move
    //  - routes through the active account (signer / passkey UserOp / Safe proposal / legacy key)
    //  - host auto-audits every call (miniapp_tx_submitted)
    //  - rejects when wallet absent or wrong network, with a typed error the app must surface
    //  - RESOLVES AT BROADCAST, NOT CONFIRMATION — see "Submission is not confirmation"
    //  - SCREENS the acting account for sanctions first; a positive restriction refuses
    requestConnect(): void             // opens the host connect modal
  },
  readProvider(chainId?: number): Provider,   // spec-069-resolved read provider; default = wallet chain
  contracts(name: string, chainId?: number): string | null,   // hostApi 2 — see below
  network(chainId?: number): NetworkDescriptor | null,        // hostApi 2 — see below
  store: {                             // namespaced to appId; cross-namespace access impossible
    get(key: string): any,
    set(key: string, value: any): void,        // host auto-audits significant changes
    subscribe(listener): () => void
  },
  audit: { log(kind: string, refs?: object): void },  // app-contextual entries (miniapp_app_logged)
  toast: { show(message: string, type?: 'info'|'success'|'error'|'warning'): void },
  navigate(to: string): void           // in-app paths only; external URLs refused
}
```

## Deployments and networks (`hostApi: 2`)

A package **cannot carry the address book**. Importing `config/contracts.js` reaches
`config/tenant.js`, which imports the `virtual:tenant` module supplied by a Vite plugin the
package preset does not register — a hard build failure. And if it built, the preset's
`envPrefix` means every `import.meta.env` read inlines as `undefined`, so a bundled
`NETWORKS` would report every subgraph as absent: the app would tell a Polygon member "this
network has no subgraph", a fabricated fact rather than an outage.

A hand-copied table is worse than it looks. Frozen into immutable bytes, it turns a routine
redeploy into a re-publish, re-review and re-approve cycle for every installed app, while
`npm run sync:frontend-contracts` keeps the host's own copy correct beside it. So the host
answers instead, and a redeploy is a host release.

```ts
host.contracts('tokenFactory', 137)  // '0x…' | null
host.network(137)
// { chainId, name, isTestnet,
//   nativeCurrency: { symbol, decimals },
//   explorer: { name, baseUrl } | null,
//   subgraphUrl: string | null }  | null
```

**`contracts` is gated by a per-package allowlist.** The manifest declares both the
capability and the specific names:

```json
{ "permissions": ["contracts", "network"], "contracts": ["tokenFactory"] }
```

Declaring names without the permission is a build failure and a launch refusal — a manifest
that misdescribes itself is worse than one that asks for too much. A reviewer reads one line
instead of diffing a bundled table.

The two negative answers are **different, and must stay different**:

| Situation | Result |
|---|---|
| Name is not in the manifest allowlist | **Throws** `undeclared_contract` |
| Name is declared, no deployment on that chain | Returns `null` |

Answering `null` for an undeclared name would let "you are not approved for this" pass as
"it is not deployed here". Note `null`, never `''` — the address book spells absence as an
empty string, and an app must not have to know both spellings.

`network()` is a flat **value projection**, never the `NETWORKS` entry (which also carries
`rpcUrl`, `dex`, `polymarket` and passkey config — handing it over would break "wrappers,
never handles"). An unknown chain is `null`, **not** the default network: an app must be able
to say "unknown network", and must never render one chain's explorer link against another
chain's data.

## Sanctions screening is the HOST's, not yours

`submit` screens the **acting account** before it touches any rail, and refuses
`sanctioned_account` on a positive restriction. Your app does nothing — and cannot opt out.

That placement is deliberate. FairWins' own contracts carry an on-chain sanctions guard, but a
mini-app's whole purpose is calling contracts FairWins did not write, where none exists. Screening
in the app layer would be optional in practice: a package that simply never calls a screening
function is unscreened, and the packages most worth screening are the least likely to cooperate.

**Uncertainty allows.** Only a positive `restricted` refuses; an unreachable screening endpoint
yields `uncertain` and the transaction proceeds. Treating uncertainty as a restriction would invent
a compliance finding the data does not support. The read is forced live at submit time, so an
account deny-listed since the page loaded is still caught.

## Asking the wallet to switch networks

`wallet.switchChain(chainId)` is the companion to `submit`'s `wrong_chain` refusal — without it an
app can name the problem and never offer the fix, which matters for anything that browses across
chains. It grants no authority: switching still requires the member's explicit approval in their
own wallet, and a declined prompt is a typed `switch_refused` rather than a silent no-op, so your
button can return to the right state.

## Submission is not confirmation

`submit` resolves as soon as the transaction is **broadcast**. `kind: 'sent'` means the
network accepted it, not that it mined, and not that it succeeded — it may still revert.
`kind: 'proposed'` means nothing has moved at all: a vault action is waiting for its
threshold, and there is no transaction hash yet.

An app that awaits `submit` and then tells the member the action is done **is lying**. To
report confirmation, wait for it — `SubmitResult.wait()` (`hostApi: 2`) resolves the receipt
through the host's own read provider:

```js
const result = await host.wallet.submit({ to, data, chainId })
if (result.kind === 'proposed') return showQueuedForVaultApproval()
const receipt = await result.wait()          // rejects for a proposal; no hash to wait on
if (receipt?.status !== 1) return showFailed()
```

`wait` grants no capability `readProvider` did not already grant — it is
`waitForTransaction` with the chain and hash filled in. It is **non-enumerable**, so
`SubmitResult` stays a plain serialisable `{kind, txHash, safeTxHash}`.

Two caveats to design for rather than hide. The read provider is a **different endpoint**
than the one the wallet broadcast through, so "not visible yet" and "not mined yet" are
indistinguishable — impose your own timeout and say *still pending*, never spin forever.
And it does not follow a wallet-side speed-up or cancel the way a
`TransactionResponse.wait()` would.

## The two write rails (why an app must not branch on the wallet)

FairWins has two transaction rails. A classic wallet signs through an ethers signer; a
**passkey smart account** (specs 041/050) has **no signer at all** and writes through an
ERC-4337 UserOp batch. `submit` chooses between them, and that choice is the host's alone —
`sendCalls` and `loginMethod` are deliberately absent from the `host` object, so a mini-app
has nothing to branch on and needs nothing.

Precedence is by **identity first, rail second**: a passkey member acting as a Safe vault
still gets a vault *proposal*, not a UserOp from their own account.

On the passkey rail `txHash` may be a UserOp hash or an intent id rather than a transaction
hash, taken in decreasing order of finality. It is never fabricated: if the rail returns no
identifier, `txHash` is `null`.

## Host obligations

- Verify status + integrity before import (approved tuple only); contain app failures
  in an error boundary; inject `manifest.styles` scoped under the app's workspace root;
  tolerate unmount/remount (store survives); auto-audit launch, tx submit, integrity
  failure, and state changes.

## Mini-app obligations

- Default-export a mountable React component; use only the `host` object + shared scope
  for privileged behavior (bundled pure libraries are fine); style via the package's own
  scoped stylesheet(s) (CSS modules recommended; no global selectors); remain functional
  after remount; surface transaction errors through `host.toast`.

## Refusal semantics (professional, specific messages)

| Condition | Host behavior |
|---|---|
| Status ≠ Approved at launch | Refuse; catalog entry updates |
| Manifest keccak mismatch | Refuse, audit `miniapp_integrity_failed`, discard bytes |
| File sha256 mismatch | Same as above |
| Unknown `schema` / unsupported `hostApi` | Refuse with version message |
| Registry unreachable | Refuse launch; "verification unavailable" disclosure |
| All gateways unreachable | Availability message; retry affordance |
| Wallet absent / wrong network on `submit` | Typed rejection; host directs user |
| Session offers no write rail (no signer, no `sendCalls`) | Typed rejection `no_write_rail` — distinct from "no wallet" and from "locked" |
| Acting account is sanctions-restricted | Typed rejection `sanctioned_account`; nothing is sent |
| `switchChain` declined, or wallet cannot switch | Typed rejection `switch_refused` |
| `contracts(name)` for an undeclared name | Typed rejection `undeclared_contract` — never `null`, which would read as "not deployed" |
```
