# Network settings & member RPC endpoints (spec 069)

FairWins is a multi-network control plane. Every asset carries its own `chainId`, reads fan
out across all supported networks at once, and the connected chain matters only when a
transaction is actually signed. Two consequences shaped this feature:

1. **Network settings are member configuration, not a tool.** The panel moved out of the
   Tools nav group onto the account button beside Preferences.
2. **The RPC route belongs to the member.** A member with their own Alchemy/QuickNode/
   Chainstack endpoint can point any network at it, with a failover behind it and whatever
   credential their provider expects — and every read in the app takes that route.

## Where things live

| Concern | File |
| --- | --- |
| Persistence, validation, redaction, CSP host list | `frontend/src/lib/network/endpointStore.js` |
| Resolution (`member → build default`), probe | `frontend/src/lib/network/rpcEndpoints.js` |
| React binding (`useRpcEndpoints`, `useEndpointsRevision`) | `frontend/src/hooks/useRpcEndpoints.js` |
| Every ethers read provider | `frontend/src/utils/rpcProvider.js` |
| Wallet transports | `frontend/src/wagmi.js` |
| UI | `frontend/src/components/account/NetworkPanel.jsx` + `NetworkEndpointForm.jsx` |
| Panel host (tab id `network`, unchanged) | `frontend/src/pages/WalletPage.jsx` |

## Resolution order

Per chain, highest precedence first:

1. the member's endpoint for that chain (Network settings)
2. `NETWORKS[chainId].rpcUrl` — itself `VITE_RPC_URL_*` or a curated public endpoint

With a member endpoint configured the route becomes a failover chain:

```
member primary  →  member failover (if set)  →  build default
```

`makeReadProvider(url, chainId)` returns an `ethers.FallbackProvider` at quorum 1 in that
case, so a rate-limited or down provider hands over instead of taking the network with it.
`getReadProvider(chainId)` is the preferred entry point in new code — it resolves the
endpoint itself and cannot be called with a URL that contradicts the member's settings.

**Never read `NETWORKS[chainId].rpcUrl` and build a provider by hand.** That bypasses the
member's route, and the bypass is invisible in review. Go through `makeReadProvider` /
`getReadProvider`, or `getRpcUrlForChain(chainId)` when a service client needs a bare URL.

### Build-curated failover (`NETWORKS[chainId].rpcFailoverUrl`)

A chain can also declare its own failover at build time, independent of any member
configuration — `defaultRpcFailoverUrlForChain(chainId)` reads `NETWORKS[chainId].rpcFailoverUrl`.
On a member's default settings this participates as:

```
build default (rpcUrl)  →  build failover (rpcFailoverUrl, if declared and distinct)
```

Ethereum Classic (61) was the only chain with one until release 1.14.0 task 8 generalized the
pattern to every EVM mainnet the app supports (1, 10, 137, 8453, 42161): each now pairs a
`VITE_RPC_URL_<CHAIN>` primary (defaulting to a public `publicnode.com` endpoint — a deploy-time
override may point it at a keyed QuickNode endpoint instead, see `frontend/.env.example`) with a
distinct `VITE_RPC_URL_<CHAIN>_FAILOVER` (defaulting to a second independent public provider,
`drpc.org`, mirroring the relay-gateway's own Polygon pair in
`services/relay-gateway/src/config/chains.js`) — so a keyed primary going dark still leaves the
chain readable. **Both `makeReadProvider` (ethers reads) and `wagmi.js`'s `transportFor` (wallet
reads) consume this** — a chain-declared failover with no member override still wires viem's
`fallback([...])` transport, not just the ethers path, so a member who has configured nothing
gets the same redundancy on every read surface.

This layer is orthogonal to a member's own `failoverUrl` (above): once a member sets their own
primary endpoint, `rpcFailoverUrl` stops participating directly — the member's failover, or the
build's `rpcUrl` default behind it, takes over instead (unchanged by this generalization).

## QuickNode per-chain endpoints

There are **two unrelated QuickNode credentials per chain**, and the difference is the whole of
this section: one is a secret, one cannot be.

| | Archive endpoint | SPA endpoint |
|---|---|---|
| Lives in | Secret Manager (`fairwins-quicknode-<chain>-url`) | a Cloud Build **trigger** substitution |
| Reaches | the workstation (`MAINNET_RPC_URL`, …) | the bundle, as `VITE_RPC_URL_<CHAIN>` |
| Who can read it | operators who can impersonate `fairwins-ops@` | **anyone who loads the app** |
| Restriction | none — it is protected by being secret | referrer/origin allow-list on the endpoint itself |

`VITE_` values compile into the client bundle, so the SPA's endpoint is public the moment it ships
(spec 097 rule 5). That is not a leak to be plugged — it is a property of build-time configuration.
The correct response is a QuickNode endpoint whose *own* settings restrict it to the app's origins,
which is safe to publish. **Never pass an archive URL to the SPA build**: moving a credential into
`VITE_` does not hide it, it publishes it.

Neither is committed. `cloudbuild.yaml` and `cloudbuild.staging.yaml` declare four substitutions —
`_RPC_URL_MAINNET`, `_RPC_URL_OPTIMISM`, `_RPC_URL_BASE`, `_RPC_URL_ARBITRUM` — that **default to
empty** and are set on the trigger. Empty falls through to the committed `publicnode.com` primary
(`'' || 'https://…'`), so an unset trigger reproduces the previous bundle exactly. They ride the
**mainnet-cohort image only**; the `staging-testnet` build deliberately gets none of them, because
chains 1/10/8453/42161 are mainnet and constitution III forbids a testnet build carrying a route to
mainnet state.

Polygon 137 is not in that set — it is the app's own chain and rides the existing global
`VITE_RPC_URL` build arg.

Provisioning and rotating the archive side is documented in
`docs/developer-guide/workstation-secrets.md` §"QuickNode endpoints are PER-CHAIN".

## Rules that are not negotiable

- **Credentials never enter a URL that could be logged.** Header/bearer keys ride on an
  ethers `FetchRequest` (or viem `fetchOptions.headers`). Anything rendered or logged goes
  through `redactRpcUrl` first — protocol + host, with `/…` stating that a credential
  exists. This is the T148 leak class (a keyed URL printed into CI logs); do not reintroduce it.
- **The API key goes to the primary endpoint only.** A failover is usually a different
  provider; fanning the member's credential out to a second host is a decision we do not
  make on their behalf. A failover that needs its own key carries it in its URL.
- **Endpoint settings are device-scoped and never backed up.** They live in the non-wallet
  global preference blob (`fw_global_prefs.network_endpoints`) because reads happen with no
  wallet connected. They are deliberately absent from `lib/backup/syncedObjects.js` (spec
  032) so a provider credential never rides into an exportable backup — do not add an entry
  there.
- **A wrong-chain endpoint cannot be saved.** The panel's "Test" asks the endpoint for
  `eth_chainId`; a mismatch is blocked, because such an endpoint would silently serve
  another network's state into every balance, position and policy read for this one. An
  *unreachable* endpoint saves with the failure shown — a member may be configuring ahead of
  a provider or CSP change — but nothing claims it works.
- **HTTPS only** (plus `http://localhost` for dev). WebSocket endpoints are rejected with a
  reason: the read providers are HTTP.

## The CSP grant is part of this feature

The browser blocks `fetch` to anything the production `connect-src` does not admit
(`frontend/nginx.conf` + `nginx.conf.template`), so the policy decides what a member can
actually configure. Members run their own nodes — in their cloud on a domain we cannot know
at build time, or locally — and a static header served to everyone cannot express a
per-member allowlist, so the RPC grant is **scheme-wide**:

- `https:` — any host. A curated provider list would have made every self-hosted endpoint a
  dead network.
- `http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*` — the local-node case. `http://`
  is otherwise unusable from an https page (mixed content), and loopback is the only http
  origin browsers treat as potentially trustworthy.

**The cost, stated plainly:** with `script-src` carrying `'unsafe-inline'`, an injected script
could POST to any https host rather than only to a curated list. The XSS entry point is
unchanged; what widens is where data could go afterwards. That trade was made deliberately to
make member-run nodes real. `https:` is granted to `connect-src` **only** — a test asserts
`script-src`, `frame-src` and `img-src` never carry a bare `https:` grant.

`CSP_RPC_GRANTS` in `endpointStore.js` mirrors what the header admits and is what the endpoint
form validates against; `src/test/nginxCspConnectSrc.test.js` asserts the two stay in sync in
both nginx files.

**A LAN node (`http://192.168.x.x:8545`) is refused**, with the reason: mixed-content blocking
is not ours to grant. The two paths that work are https (put the node behind TLS) or an SSH
tunnel to `localhost`.

**A local or self-hosted node must allow cross-origin requests from the app's origin** (e.g.
`geth --http.corsdomain=https://…`). That is the most common cause of a "Could not reach"
probe result, and the message says so before it says "offline". Note also that Chrome's
private-network-access rules can require a preflight for public→loopback requests, so a node
that answers `curl` may still refuse the browser until CORS is configured.

## Changing an endpoint at runtime

- **Reads** pick up a change on the next lookup. Provider instances are memoized, so read
  hooks include `useEndpointsRevision()` in their memo dependencies (`usePortfolio`,
  `useAccountAssets`, `useEarnPositions`, `useTransfer`). A new memoized provider path
  should do the same.
- **Wallet transports** are built once at module load in `wagmi.js` (localStorage is
  synchronous, so member endpoints apply from the first render of a session). A change
  therefore needs an app reload before wallet-signed transactions use it — the panel says
  so plainly rather than implying an instant switch.

## Network switching

Switching remains a wallet action via `wagmi.switchChain`, but it is framed as optional in
the panel: assets carry their own chain, reads span all of them, and only *sending* on a
network the wallet is not currently on requires a switch — which the sending surfaces
(Transfer, Pay, Earn, ClearPath, custody) already prompt for at submit time. Bitcoin (spec
061) has no wallet switch at all and stays display-only here.
