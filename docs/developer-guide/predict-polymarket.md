# Predict — Polymarket trading (spec 057)

The **Predict** section lets a connected wallet browse Polymarket prediction markets and buy/sell
outcome shares, routed through FairWins' **builder code** so attributed volume earns revenue. It is
the direct analog of the **Collect** (OpenSea) feature: a frontend section + a relay-gateway proxy,
**no smart-contract changes**, no custody — the member's own wallet is the only order signer.

> **Architecture note (Option A, per-user CLOB creds).** The original plan had the member hand-build a
> CLOB order struct and relay it through a gateway that held one shared operator L2 credential. That does
> not work: **CLOB V2 binds every order to its signer** and rejects any order whose `signer` != the address
> its API key was registered under (401 "Invalid api key"), so a single shared key cannot submit trades for
> other wallets (verified against live CLOB). The shipped design instead has **each member derive their own
> CLOB API creds** (one gasless L1 wallet signature) and post orders **client-direct** to
> `clob.polymarket.com` via the official [`@polymarket/clob-client`](https://www.npmjs.com/package/@polymarket/clob-client).
> The gateway keeps the **public read feed** and gains a **builder-sign attribution endpoint** (below).

## How FairWins earns (builder codes)

A `bytes32` **builder code** (`0x6e0316783960e149b53466f0f2c5fdbaf5ce11ba15669491de980f6dedc493a3`)
attributes volume via the four `POLY_BUILDER_*` request headers. Two revenue streams:

1. **Builder fee** — a flat % of notional charged on attributed **taker** volume, accrued to the
   builder's registered wallet. Default **50 bps taker / 0 maker** (config, capped at 100/50 bps).
2. **Weekly rewards** — a share of Polymarket's weekly USDC builder-rewards pool on attributed volume,
   earned even at a zero explicit fee.

### The honesty difference from Collect

OpenSea's affiliate reward comes out of OpenSea's own fee → **no user cost** → Collect attributes it
silently. Polymarket's builder fee is **additive** — it stacks on top of the platform taker fee and is
a **real cost to the taker**. So Predict **always discloses the builder fee** as its own labelled line
in the confirm UI, never hidden and never described as free (`TradeConfirm.jsx`). Makers pay no fee.

## Architecture

| Concern | Where |
|---|---|
| Capability flag (Polygon-only) | `frontend/src/config/networks.js` `PREDICT_CHAIN_IDS = {137}` |
| Nav item | `frontend/src/config/appNav.js` `{ id: 'predict', label: 'Predict' }` |
| Gateway proxy (public reads) | `services/relay-gateway/src/polymarket/` (client / normalize / routes) |
| Gateway **live-market reads** (spec 114) | `GET …/events`, `…/events/:slug`, `…/books`, `…/prices-history` — see [Live-market reads](#live-market-reads-spec-114) |
| Gateway **builder-sign** (attribution) | `POST /v1/polymarket/:chainId/builder-sign` — signs `POLY_BUILDER_*` headers with the shared builder creds (server-side only) |
| **Per-user CLOB session** | `frontend/src/lib/predict/clobSession.js` — derive creds + build/sign/post orders via `@polymarket/clob-client` |
| Region gate | `frontend/src/lib/predict/geoblock.js` — geoblock check + Polymarket link-out for restricted regions |
| Cost math (honest fee lines) | `frontend/src/lib/predict/clobOrder.js` `computeCost` (additive builder fee; **not** the order struct) |
| Signer capability | `frontend/src/lib/predict/tradeSigner.js` — EOA signs via walletClient; passkey signs via the ERC-1271 rail (`PASSKEY_PREDICT_ENABLED = true`, kill seam) |
| **Passkey ERC-1271 signer** | `frontend/src/lib/predict/passkeyClobSigner.js` — clob-client signer shim over `lib/passkey/intentSigner` (replaySafeHash → WebAuthn → SignatureWrapper) |
| **Passkey first-trade approvals** | `frontend/src/lib/predict/passkeyApprovals.js` — missing USDC/CTF approvals for the three settlement contracts, batched through `sendCalls` (one ceremony; deploys a counterfactual account) |
| State machine | `frontend/src/hooks/usePredictTrade.js` (region → fee → [passkey: approvals] → derive creds → submit) |
| Browse / positions / orders | `usePredictEvents.js` (spec 114; replaced `usePredictMarkets`), `usePredictPortfolio.js` + `components/predict/*` |

### Upstream hosts

Polymarket splits across public hosts. Reads go through the gateway; authed trading is client-direct:

- **Gamma API** (`gamma-api.polymarket.com`) — market **discovery/browse + search**, volume-ranked live
  markets (the CLOB `/markets` endpoint returns mostly closed historical markets, so it is not used for
  browse). Outcomes/prices/token-ids arrive as stringified JSON arrays that the normalizer zips.
- **Data API** (`data-api.polymarket.com`) — the wallet's **positions** (public, no auth).
- **CLOB** (`clob.polymarket.com`) — fee rate (`base_fee`) via the gateway, and **directly from the
  browser** for cred derivation, order submit/cancel, and open orders. CLOB serves
  `Access-Control-Allow-Origin: *`, so the SPA calls it straight; the member's L2 creds never transit
  our gateway (consistent with the no-backend rule).

Read hosts are configurable via `POLYMARKET_GAMMA_URL` / `POLYMARKET_DATA_URL` / `POLYMARKET_BASE_URL`.

### Per-user credentials (`clobSession.js`)

- `ensureClobCreds(walletClient, { address })` — `createOrDeriveApiKey()` is deterministic per wallet:
  one **L1 EIP-712 signature** (a wallet prompt, no gas). Result `{ key, secret, passphrase }` is cached
  in `sessionStorage` per address, so the member signs at most once per session. Creds are session-local
  and **never** sent to a FairWins server.
- `makeClobClient(walletClient, creds, { builderConfig, signatureType, funderAddress })` — an authed
  client bound to the member's signer + their creds. EOAs use signatureType **0** (maker == signer ==
  funder, the default). Passkey smart accounts use signatureType **3 (POLY_1271)** with
  `funderAddress` = the account: maker == signer == funder == the smart account, every signature the
  account's ERC-1271 WebAuthn envelope, and the API key registered against the **account** address
  (satisfying CLOB V2's signer-binding rule). The pinned SDK (5.8.1, archived) predates `POLY_1271` in
  its `SignatureType` enum, but forwards the raw number into the signed order unvalidated —
  `SIG_TYPE_POLY_1271` in `clobSession.js` is the one place the value lives.
- `submitOrder` / `cancelOrder` / `fetchOpenOrders` — `createAndPostOrder` builds, signs, and posts in
  one call (the SDK resolves tick size, fee rate, and negRisk). **The order struct and its EIP-712
  signing are owned by the SDK** — we don't hand-roll it (the real struct is 12 fields, domain
  `"Polymarket CTF Exchange"` v`1`, with **no** `builder` field; attribution rides on headers, below).

### Builder attribution (`makeBuilderConfig` + gateway `builder-sign`)

The builder creds are a **shared secret**, so they stay server-side. The SDK's `BuilderConfig` is pointed
at the gateway's remote signer:

- Client: `makeBuilderConfig(gatewayBaseUrl, chainId)` → `BuilderConfig({ remoteBuilderConfig: { url:
  `${base}/v1/polymarket/${chainId}/builder-sign` } })`. Returns `undefined` when no gateway is configured
  → trades post **unattributed** rather than being blocked (never-stranded, FR-015).
- Gateway: `POST /v1/polymarket/:chainId/builder-sign` (Polygon-only, killswitch + write-quota) takes
  `{ method, path, body, timestamp }`, calls `builderConfig.generateBuilderHeaders(...)` with the shared
  `POLYMARKET_API_*` creds, and returns the four `POLY_BUILDER_API_KEY` / `_PASSPHRASE` / `_SIGNATURE` /
  `_TIMESTAMP` headers. The SDK adds them **on top of** the member's own L2 headers.

### Region gate (`geoblock.js`)

Polymarket blocks order placement for restricted regions (e.g. US persons) as a matter of their policy.
`checkGeoblock()` (`GET polymarket.com/api/geoblock`, CORS `*`, fail-open) runs **before** fee load and
before submit. A blocked member sees an honest region notice and a **"Trade on Polymarket ↗" link-out**
to the market on polymarket.com — we never bypass the block, and never present a dead trade button.

### Fees, honestly

We control and state the **builder fee** exactly (`computeCost`). Polymarket's **own taker fee** is
computed by their engine at execution (a curve over price/size); `base_fee` is carried on the signed
order's `feeRateBps` for validity, but we do **not** fabricate a dollar estimate for it — the confirm UI
discloses it as a separate note. This keeps "shown == charged" honest for the one fee we own. Makers pay
no builder fee.

### Never stranded

Every path degrades gracefully: no builder code / gateway ⇒ orders post **unattributed**; killswitch or
outage ⇒ honest message + a Polymarket link; fees unconfirmable ⇒ signing is **blocked** (never a guessed
fee); restricted region ⇒ honest notice + link-out; a passkey account whose signatures the CLOB rejects ⇒
honest per-account error + the Polymarket link-out (FR-019's per-account fallback, not a blanket
exclusion); a passkey session that lost its credential record ⇒ an actionable "sign in again".

## Live-market reads (spec 114)

Four cached, read-only routes that the redesigned Predict surface is built on. Contract:
`specs/114-predict-live-markets/contracts/gateway-predict-api.md`. None accepts, forwards or signs
an order.

| Route | Upstream | Cache |
|---|---|---|
| `GET /v1/polymarket/:chainId/events?category=&sort=&q=&next=` | Gamma `/events` (or `/public-search` when `q` is set) | `POLYMARKET_CACHE_TTL_MS` |
| `GET /v1/polymarket/:chainId/events/:slug` | Gamma `/events?slug=` | `POLYMARKET_CACHE_TTL_MS` |
| `GET /v1/polymarket/:chainId/books?token_ids=a,b` (≤ 10) | CLOB `/book`, **cached per token** | `POLYMARKET_BOOK_TTL_MS` (2 s, floor 1 s) |
| `GET /v1/polymarket/:chainId/prices-history?token_id=&range=` | CLOB `/prices-history` | `POLYMARKET_HISTORY_TTL_MS` (60 s) |

Things that are deliberate:

- **Every body ends `confirmedAt` / `serverNow` / `stale`.** `confirmedAt` is when the gateway
  fetched its copy from the venue; the client measures a price's age from the two gateway
  timestamps plus its own monotonic timer, never from the device clock. For `/books` it is the
  **oldest** of the tokens served.
- **Categories are a bounded table** (`polymarket/categories.js`), our id → the venue's tag slug.
  An unknown id is a 400, never passed upstream, and cache keys stay bounded. `culture` maps to the
  venue's `pop-culture`; a bare `culture` tag does not exist there.
- **Books are best-first here and worst-first at the venue.** The normalizer sorts by price rather
  than trusting either order, caps each side at 25, and passes prices and sizes through as the
  venue's strings.
- **One unreadable token never blanks the rest**: it is listed in `unreadable` and absent from
  `books`. If *no* requested book could be read the answer is 503, because there is no
  `confirmedAt` to give.
- **A number the venue omitted is `null`.** Never `"0"`.
- **The headline price follows the venue's rule** (`displayPrice`): the midpoint while the spread
  is at most 10¢, else the last trade.
- **Text only.** No image, icon or markup field is forwarded; descriptions are capped at 4,000
  characters.
- **`sort=closing` adds `end_date_min=<now>`** upstream. Without it an ascending end-date list
  opens with events whose date passed long ago and never settled.

### The app and the gateway deploy separately

The gateway image is built and re-pinned by hand; the app ships on the release train. The browse
view therefore tolerates a gateway that does not have these routes yet: a 404 from `/events`
(other than `unsupported_chain`) makes `usePredictEvents` fall back to the spec-057 `/markets`
list for the life of the hook, each market shown as a one-market event, with the category and sort
controls hidden because that route has neither. Nothing is invented for the fields the older route
lacks. Remove the fallback (`eventFromMarket`, `fetchPage`'s second branch) once every deployed
gateway serves `/events`.

## Configuration

Server-side, in the relay-gateway (`services/relay-gateway/src/config/index.js` `polymarket` block; see
`.env.example`): `POLYMARKET_API_KEY` + `API_SECRET`/`API_PASSPHRASE`/`API_ADDRESS` — these are the
**shared builder credentials** used only to sign `POLY_BUILDER_*` attribution headers (they are **not**
per-user order creds). `POLYMARKET_BUILDER_CODE` + `_TAKER_FEE_BPS`/`_MAKER_FEE_BPS` (public), quotas.
The SPA connects directly to `clob.polymarket.com` + `polymarket.com` — both are in the frontend CSP
`connect-src` (`nginx.conf` / `nginx.conf.template`).

## Competitive positioning

Total taker cost ≈ Polymarket platform fee (curved, ~0.75%–1.8% by category; makers 0) + 0.5% builder
fee. Comparable to Kalshi (~≤1.75%) and mid-pack among third-party builders (0–1%). See
`specs/057-predict-polymarket/research.md` (D2–D4) for the full analysis.

## Open dependencies (confirm before mainnet)

- **Allowed-region E2E**: a live end-to-end trade (derive creds → submit → fill) must be verified from a
  **non-restricted** region — the sandbox/dev region is geoblocked, so live submit currently reaches the
  region gate. Everything up to that point is validated live.
- **Passkey path — live E2E confirmation still open**: the full POLY_1271 rail is wired
  (`PASSKEY_PREDICT_ENABLED = true`) — signatureType 3, maker == signer == funder == the account, L1
  auth + orders signed as the account's ERC-1271 envelope, first-trade settlement approvals batched
  via `sendCalls`. What is NOT yet confirmed against the live CLOB (the dev region is geoblocked): (a)
  that the CLOB's POLY_1271 validation accepts an **arbitrary** ERC-1271 account rather than only
  Polymarket-factory deposit wallets, and (b) that the pinned 5.8.1 client's order shape is accepted
  for type-3 orders (POLY_1271 is documented as "V2 orders"). If either fails, passkey members get the
  honest per-account error + Polymarket link-out — never a stuck flow — and the one-line kill seam
  (`PASSKEY_PREDICT_ENABLED = false`) restores the "not available yet" notice.
- **Deploys**: the feature needs a **gateway redeploy** (builder-sign endpoint) and an **SPA
  rebuild/redeploy** (trade code + CSP). Merging main does not auto-deploy.

See also `docs/runbooks/relayer-operations.md` (Predict / Polymarket proxy) for operations.
