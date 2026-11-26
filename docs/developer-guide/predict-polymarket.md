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
| State machine | `frontend/src/hooks/usePredictTrade.js` (region → fee → [passkey: approvals] → derive creds → submit); the plan-first ticket flow is `usePredictPlanTrade.js` on top of it (spec 114) |
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
- `submitOrder` / `cancelOrder` / `fetchOpenOrders` — `submitOrder` builds with the SDK's `createOrder`, hashes,
  then posts (see "Order progress"; the SDK resolves tick size when none is passed, and fee rate). `negRisk` is a
  stated boolean or the venue's answer — never a guess. **The order struct and its EIP-712
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

## The amount-first order ticket (spec 114, slice 5)

A member says **how much**, sees what that means from the depth actually on offer, reviews it, and only
then is a signature requested. Custody, the signer rails, credential derivation and the builder-sign call
are the ones above, unchanged; this is what sits in front of them.

**What the ticket shows** (`components/predict/OrderTicket.jsx`): the amount field starts empty with no quick
amount chosen; from a *live* reading it derives the average price, shares, what the member receives if right,
the most they can lose, the share of visible depth the order takes (from 10%), and every fee as its own line
(`computeCostForPlan` over the plan's own notional — never average price × shares). Near certainty (average
price ≥ 90¢) states the dollars at risk beside the dollars to gain; an amount beyond the visible depth says how
much can be filled; a refusal is always a sentence ("The smallest order here is 5 shares (about $4.70)."), never
a reason code. A reading that is **not live** shows "Waiting for a current price…" with its age, **no figure**,
and Review disabled — `planForTicket` returns only `{ status: 'not-live' }`, and `planOrder` refuses first.
"Set my own price" (collapsed, unmounted until opened) turns the order into a resting GTC order
(`submitRestingOrder`), and the review says it rests and may never fill. The tick the member reviewed on travels
with that order: if the venue's tick has since become coarser, the SDK **refuses** it. Without the tick the SDK
would round the member's price to the nearest step of the new grid and place an order at a price nobody reviewed.

**The limit is the guarantee.** A marketable order is sent **fill-and-kill** (`OrderType.FAK`, never FOK) with
`price` = the plan's `limitPrice`: the worst price the member accepts (worst level touched, plus the **price
tolerance** — one tick unless the member chose otherwise, below). The
review names it in cents — *"This order cannot fill above 95¢ a share. Whatever is not filled is cancelled and not
charged."* — and Sign re-plans against the **current** reading (`checkStillSignable`): not live ⇒ nothing is
signed and the ticket goes back to waiting; the reviewed limit no longer reaching the depth ⇒ nothing is signed,
the new figures are shown, and Sign needs another press; otherwise the order is signed with the **reviewed** limit,
never a newer one. The re-check runs twice (on the press, and again after any first-trade ceremonies, right
before the order is built — a passkey prompt can take minutes).

**Price tolerance** (T032a, `lib/predict/tolerance.js`, collapsed "Price tolerance" control, unmounted until
opened). Three choices: **one tick** (the default and the tightest), **1¢** and **2¢** — never wider (research R7).
Each is converted to `toleranceTicks` from the READING's own tick (`1¢ ÷ tick`), and a choice is *offered* only when
it is honest on the market: never finer than the tick, a whole number of ticks (so on a 1¢ market "1¢" *is* one
tick and appears once, and a 2¢-or-coarser market offers only the default), and the limit it would produce stays
inside (0, 1) (`worst + offset ≤ 1 − tick` for a buy, `worst − offset ≥ tick` for a sell — `planOrder` would
otherwise clamp it and silently give less than was chosen). It does nothing for a price the member names (that
order rests). The choice lives in the ticket component's own state only — **never in storage, never carried to the
next ticket, reset when the outcome changes** — so nobody carries a loosened limit forward by accident (a test
unmounts the ticket and opens another). `toleranceTicks` flows through `usePredictPlanTrade` into `planForTicket`,
the review's "Price limit" and `checkStillSignable`, so the figures, the limit signed and the at-Sign re-check use
one tolerance. What it changes: the *limit* — the worst price the order may fill at — and so how many shares a buy
may get back at worst. What it does **not** change for a buy: "You pay at most" and "The most you can lose" are the
amount typed (the signed maker amount) plus the fee, whatever the limit, so those figures do not move with the
tolerance; the sentence says the extra cost is per share.

**What is shown is what is signed.** The SDK takes `price` and `amount` as JavaScript **numbers** and rounds
them by its own per-tick table. Everything upstream of it is exact decimal-string / BigInt arithmetic, so there is
exactly one string → number boundary: `toSdkNumber` in `lib/predict/clobSession.js`, which refuses a value that
does not print back as the same decimal. `marketOrderSignedAmounts` / `restingOrderSignedAmounts` (same file) are
BigInt twins of the SDK's rounding — the package exports neither its `ROUNDING_CONFIG` nor `getMarketOrderRawAmounts`,
and a deep import is not a contract — so `test/predict/signedAmounts.test.js` builds **real** orders with the
installed `@polymarket/clob-client` (throwaway key, no network) and requires the twin, and the ticket's own
"You pay at most" and limit, to equal what the SDK built. In particular a buy's USDC is rounded **down to cents**,
a sell's shares down to hundredths; the plan is built from the rounded amount, so the review shows the rounded
figure and says it differs from what was typed. If part of an order has no offer at any shown price, only the
fillable part is signed, so the ceiling shown is the ceiling of the signature.

*Exactly how far "equal" goes.* The **maker** amount — what the member gives, the figure shown as "You pay at most"
/ "You sell up to" — matched the SDK in every one of 200,000 random orders. The **taker** amount (the minimum
received) is derived, and the SDK derives it in floating point: it matched whenever it was under 100,000 shares or
USDC; from there to a billion it differed in about 1 order in 50, by one step of the last decimal the SDK signs;
beyond a billion the SDK runs out of precision. That is why shares are shown as "about" and no surface prints the
taker amount as an exact figure. The test asserts those bounds. (Its first version claimed "random orders on every
tick" and reported perfect agreement. It drew `seed % 4` and `seed % 2` from a linear generator whose low bits
cycle with period 4, four draws per order — so every one of its 240 orders was a **sell on the 0.01 tick**, under
$5,000. If you write a fuzz, assert that each branch ran.)

**Which exchange the order is signed for.** `negRisk` picks the contract that verifies the signature. A market row
carries the flag from the listing; a position may not, and a missing flag is **left out** of the SDK call so the
SDK asks the venue for that token. It is never signed as `false` by default.

**What the venue's answer means.** The SDK never throws from the post — its HTTP helper returns every failure as
`{ error, status? }` — so a throw out of `createAndPost…` means nothing was sent (the order could not be built, or
the member declined to sign), and `readPostFailure` (`lib/predict/clobSession.js`) reads what comes back:

| Answer | Means | The ticket |
| :-- | :-- | :-- |
| a 4xx, or `success: false` | refused before it could match; nothing placed | `error`, with the venue's short reason and a way back |
| a balance or allowance shortfall | refused; will not succeed on a re-sign | `error` that says so — **not** "the market moved" |
| "no orders found to match" and similar | the limit no longer reaches the book | `moved`: new figures, another deliberate Sign |
| a 5xx, a 408, or **no HTTP status** | the order **may** have been received | `unknown` |

`unknown` is terminal for the ticket. It says the order may have been placed, points at positions and open orders,
and offers no way back to Sign, because the same fill-and-kill order sent twice can fill twice. An HTML error page
or an object is never shown as the reason. Two more guards against a second order: `signAndPost` and `confirm` each
hold a ref-based lock (state alone cannot stop two calls made in one render), and the ticket is not swapped for
the fixed-price confirm while an order is in flight or has just been answered.

**Fees and disclosure** (spec 057 FR-003/FR-010–FR-012): the builder fee is its own line, the venue's own taker
fee is disclosed in words, a zero fee draws no line, and signing stays blocked when the fee schedule cannot be
confirmed. The sentences live once, in `lib/predict/disclosures.js`. Four rules the ticket adds:

- **The column adds up.** A buy's fee lines and "The most you can lose" are read from the *same* quote — the
  ceiling, i.e. what the signature can spend — so "You pay at most" plus each fee line equals the total.
- **Every money figure names USDC** (FR-011). A "$" alone does not.
- **Polymarket's own fee is in no figure**, because FairWins can read its rate but not what it will come to. Every
  figure it would change ("The most you can lose", "If you are right, you receive", "You receive about", the
  near-certainty sentence) says "before Polymarket's fee" — unless the gateway **read** the rate as zero. A rate it
  could not read (`null`) is not a zero.
- **A named-price order says which builder rate it pays.** One that rests fills later as a maker (the maker rate,
  often none); one that crosses the book fills at once as a taker. `restingFeeText` says which, and a resting buy's
  ceiling assumes the larger of the two — the book can move before the order arrives — with that fee line labelled
  "if it fills at once".

"Signing this order costs no network fee" is about the order only: a passkey member's first-trade approvals are a
transaction, described by the first-trade note beside it.

**The fixed-price fallback has the same safety rules.** `TradeConfirm` → `usePredictTrade.submit` →
`clobSession.submitOrder` shares ONE internal build → hash → post function with `submitRestingOrder`
(`buildAndPostLimit`), so it too throws a venue refusal instead of reporting it as an order sent, treats an
answer that never arrived as `unknown` (the sentences are shared with `OrderTicket` — `unknownOutcomeText` /
`orderSentText` in `ticketStatements.js` — and there is no re-send control), asks the venue which exchange a market
settles on when the listing does not state it (a sell opened from a position no longer signs `negRisk: false`;
a non-boolean answer signs nothing), and hands every order it places to the progress tracker. The hand-off lives
in ONE place, `usePredictTrade.signAndPost({ track })`, which both tickets use. The one difference: this path has
no reviewed tick, so none is passed and the SDK resolves the venue's current one.

**Never stranded.** The ticket needs live readings, which come from the gateway's `/books` route. A gateway without
it (404 — remembered by `lib/markets/routeSupport.js`; a 5xx is an outage, not an absent route) or without
`/events` (the legacy list) keeps the fixed-price flow: `MarketDetailSheet` → `TradeConfirm` still work and are what
opens. While the price source is merely unreachable the ticket stays in its waiting state with a link to the venue.

**Moving parts.** `usePredictPlanTrade` composes `usePredictTrade` (which gained `signAndPost`, the shared
body of every submission: gates → Polygon → approvals → signer → creds → last freshness check → build client →
`send(client)`; everything that waits is done before the freshness check, so only the SDK's own build-and-sign
follows it; `submit` is now one caller of it) — region check, fee gate, signer rail and attribution are one implementation. `lib/predict/ticketPlan.js`
is the pure plan/re-check; `lib/predict/ticketStatements.js` the shared sentences. The ticket reads only its own
outcome's two tokens through `useMarketReadings`; opened from an event page, the page selects that row first (its
two tokens are already among its ten), and while a ticket for a *position* is open the page stands down, so the
poll never holds more than ten tokens. `done` returns what the venue answered and hands the order to the progress
tracker (next section).

## Order progress (spec 114, slice 6)

After a signature the member sees where the order is, on the Predict panel, without refreshing — and the order is
still there after a reload. Pieces: `lib/predict/orderProgress.js` (reducer + device store), `usePredictOrders` (the
poll), `OrderProgress` (the words), `lib/predict/orderWords.js` (the sentences, pure).

**The reducer** knows the diagram of data-model.md and nothing else: `signed → sent → resting → partial →
matched → settled`, `sent → matched`, `resting/partial → cancelled | expired`, `signed → unconfirmed → sent |
not-delivered`, `signed → rejected`, `matched → failed`. An event that is not a legal move hands back the SAME
record. A venue observation may skip a state it did not see (a poll that never caught `partial`) but never goes
backwards or leaves an ending; fills only grow; amounts are decimal strings compared in micro-units. `unconfirmed`
is never terminal. Terminal records, and a `matched` the app can never advance, are pruned seven days after they
last moved.

**Matched is the venue's word, settled is the chain's.** The app reads the venue, not the chain, for a matched
order, so nothing in the app emits `settled` or `failed`: the reducer accepts them (a chain read or the market feed
can drive them later) and the tracker stops at matched and says settlement happens on chain. A venue status string
can never produce either.

**The device store** is `predict_orders_v1` in `localStorage`, scoped by wallet (`userStorage`), so an order
survives closing the app. It is **device-only and deliberately absent from `lib/backup/syncedObjects.js`** (a test
asserts it). A record holds the order id and the public facts of the order — token, side, size and its unit, the
limit, a label — never a signature or a credential.

**The id before the post.** A post whose answer never arrives gives the app no venue id, so the two submit
functions in `clobSession.js` now BUILD and POST as separate calls (what `createAndPost…` does in one) and compute
the order's EIP-712 hash from the signed order in between, with the SDK's own exported `ExchangeOrderBuilder` and
`getContractConfig`. What is signed is unchanged — same call, same tick, same order type (FAK for a marketable
order, GTC for a named price), and `negRisk` resolved exactly as the SDK would (a stated flag, else the venue's
answer for that token, never a guessed `false`). The hash rides on the thrown error (`orderHash`) and on the
answer. `test/predict/orderHash.test.js` runs the real SDK: the split path signs the same order as the one-call
path (only the random salt and signature differ), the hash equals an independent `hashTypedData` over the
exchange's published domain, and the signature recovers to the signer over exactly that digest.

**What that does not prove** is that the venue uses this hash as its `orderID`. Hence the store's `idScheme`:
`unknown` until a successful post returns an id equal to the computed one (`verified`), or `mismatch` if it
differs (sticky; then a computed id is never used for a lookup).

**The device store is shared by every tab, so a write is a delta, not a snapshot** (T036b,
`commitToStore`). Each write re-reads what is on disk *at that moment* and applies only what it means to change:
upserts merge by `orderId` and the record with the newer `updatedAt` stays (a tie goes to the writer), removals
drop only the ids they name, and a record the writer never mentions can never be dropped — an `unconfirmed` record
another tab added loses nothing, including its "do not send it again" notice. `idScheme` merges as a union
(`mismatch` is sticky). `test/predict/orderProgress.test.js` interleaves two writers.

**`usePredictOrders`** reads the venue with the member's own cached CLOB session and a read-only signer (it can
name an address and refuses to sign); no cached session means `locked` — "sign in to trading" — never a prompt.
Its client shape (smart-wallet signature type and funder, or plain) follows the **resolved signer kind**
(`resolveTradeSigner`, as `usePredictTrade` signs with) through `lib/predict/readClient.js`, not the raw
`loginMethod`. The open-orders list reads the same way, so **passkey sessions see their open orders** (T036c): same
read-only signer, same cached session, no derivation and no prompt — no cached session is `locked` and the list says
"Sign in to trading to see your open orders". Cancelling goes through the existing `trade.cancel`, which asks for no
ceremony when the session is cached (`ensureClobCreds` returns the cache before any client exists, and a cancel is an
L2-authenticated request, not an order signature); only a session that lost its cache between listing and tap would
be asked to derive credentials once, which is the same gasless signature enabling trading needs.
It takes no submit function and the source is tested to contain no post call: `unconfirmed` is resolved by LOOKUP
(`lookupOrder`: `getOrder`, then the member's trades if the order is not found) and never by sending again.
A lookup that fails is not an event.

**The app never concludes "not delivered".** The reducer has the state, and nothing emits the event that leads
to it. "Not found, and no trade names it" also describes an order that *filled* and that this lookup cannot see:
whether the venue keeps a fill-and-kill order after it matched, whether its trades name the order they came from,
and what `after` means on the trades read have not been checked against a real account. Being wrong in that
direction tells a member an order was not placed when it was, and they place it again. So an unconfirmed order
resolves only positively — the venue has it, or a trade names it — and otherwise stays unconfirmed, says how to
check, and ends when the member presses "I have checked on Polymarket — stop tracking this". A first version did
conclude it (three clean reads over two minutes on a verified id); review found it could fire for a filled order,
because the trades window started when the post's answer *failed* rather than when the order was signed. The
window now starts an hour before `signedAt`, a time taken before the post, so a slow failure or a wrong device
clock does not leave the order's own fill out of the read. Turning the conclusion on is a decision for after
those three behaviours have been seen on a funded account.

**Cadence.** Tracker: only while the tab is visible and something the venue can still report is tracked; first look
at once, then every 6 s backing off ×1.5 to 30 s while nothing changes, back to 6 s on a change; at most 8 orders a
round, one request at a time. These reads go to the venue directly with the member's session, so they cost the
gateway's 60/min Predict quota nothing. Positions (through the gateway, sharing that quota with the 30/min price
feed) refresh every 30 s backing off to 120 s, and immediately when a tracked order changes; open orders (venue
direct) every 15 s backing off to 60 s. A background refresh that fails keeps the last list and says so (`stale`),
it never empties it. The Refresh buttons are gone.

## The fixed-price ticket's figures

`TradeConfirm`, the market sheet and the positions list print a price in cents (`formatPriceCents`: a buy rounds up,
a sale down) and money as `$x.xx USDC` (`formatUsd`: costs, fees and totals up, proceeds and net down), the same
functions the amount-first ticket uses — never a raw decimal from the gateway. Formatting only: the order signed is
built from the raw `price` and `size` exactly as before (`TradeConfirm.test.jsx` asserts the `submit` arguments for a
price that is an unrounded float).

## Browse chip rows

The two chip rows have visible labels that name their groups (`aria-labelledby`, one accessible name each):
**Popular now** over the topics and "In play", **Categories** over the category chips. "Popular now" is honest only
while the gateway's topics are ranked by 24-hour volume (`selectTopics`, which `usePredictDiscover` carries); a
comment at the row says the label must change if that source does.

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
