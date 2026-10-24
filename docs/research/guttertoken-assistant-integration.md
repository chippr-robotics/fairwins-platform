# GutterToken as a member-paid assistant rail — integration evaluation

**Status**: Evaluation — input to a `/speckit-specify` for the feature
**Date**: 2026-09-05
**Scope**: Part I — how FairWins members could use [GutterToken](https://app.guttertokens.com/docs)
prepaid credits to run the spec-095 assistant, as an alternative to the members-only, FairWins-funded
rail; evaluates the three surface options that were on the table (a mini-app, a series of bottom
sheets, "let the member add an API key") and recommends one. Part II (§ 8) — how the existing
`services/mcp-server` should relate to the in-app assistant so the assistant can actually read the
member's data, on either rail.

Sources: the GutterToken public docs, signup page and Acceptable Use Policy as served on 2026-09-05;
live probes of `api.guttertokens.com` (recorded below); and a read of the spec-095 assistant seams
(`frontend/src/lib/assistant/`, `frontend/src/components/assistant/`,
`services/relay-gateway/src/memberApi/assistant.js`), the credential-storage precedents (spec 069
RPC endpoints, spec 062 legacy key vault, spec 095 API-key metadata), the spec-073 host contract and
the spec-089 FinOps gate.

---

## 1. What GutterToken is, as measured

Claims from the docs that were checked against the live service are marked **verified**; claims the
docs make that could not be checked without a funded account are marked *docs*.

| Fact | Status | Evidence |
|---|---|---|
| An HTTP proxy to Anthropic Claude models, prepaid credits, no subscription | *docs* | docs front page |
| Base URL `https://api.guttertokens.com`; `POST /v1/messages` (Anthropic shape), `POST /v1/chat/completions` (OpenAI shape), `GET /v1/models`; `stream: true` on all | *docs* | "Supported endpoints" |
| Auth is `Authorization: Bearer sk-…` | **verified** | every unauthenticated probe answers `401 {"error":{"code":"invalid_api_key","message":"Invalid API key. Pass it as \`Authorization: Bearer sk-...\`…"}}` |
| `x-api-key` (what our gateway sends to Anthropic) is accepted | **inconclusive** | a bogus key in `x-api-key` returns the same body as no header at all; only a real key can tell "ignored" from "invalid" |
| **CORS is open**: `Access-Control-Allow-Origin: *`, `Allow-Headers: *`, methods incl. POST, max-age 43200 | **verified** | `OPTIONS /v1/messages` with `Origin: https://app.fairwins.io` → `204` with those headers |
| **No account, balance, usage or key endpoint** | **verified (negative)** | `/v1/balance`, `/v1/credits`, `/v1/usage`, `/v1/me`, `/v1/account`, `/v1/key`, `/v1/keys`, `/v1/billing` all `404`; docs say the deposit address and balance are "shown on the billing page once you have enrolled a wallet" |
| No OAuth, no delegated auth, no webhooks, no embeddable widget or iframe | *docs* | docs "not supported" list |
| Wallet signup: "Your wallet will ask you to sign a short message. It costs nothing and sends no transaction" — an account may exist with a wallet and no e-mail, and is unrecoverable if the key is lost | *docs* | signup page |
| Crypto top-up: USDC/USDT on Ethereum, Base, Arbitrum One, Polygon; `1 USDC = $1.00` credit, zero fee, min `$0.50`; ~1 min finality on Polygon; must be "sent from a wallet you can sign for" (exchange withdrawals cannot be claimed); a transfer that predates signup is claimable after signing up with the same wallet | *docs* | "Crypto payments" |
| Rate limits are **per source IP** (concurrency + request rate); spend is bounded by balance, not by limits; `403 insufficient_quota` = out of credit, `429` = throttled, `503 model_unavailable` = no capacity | *docs* | "Limits", error table |
| AUP: resale is allowed — "Put us behind your own product, serve your own customers" — but "if you resell or otherwise give others access through your account, **their use is your use**" | *docs* | Acceptable Use |
| Referral: referrer gets 15 % of the referee's **first** deposit as **credit** (cap `$50`); referee gets `$5` on a first deposit ≥ `$25`; credit is non-refundable and non-cashable; self-referral is void | *docs* | "Referrals"; the signup form has a referral-code field |
| Pricing per model ($/M in, $/M out): opus-5 1.25/6.25 · sonnet-5 0.50/2.50 · haiku-4.5 0.25/1.25; cache writes +25 %, cache reads −90 % | *docs* | pricing table — **treat as volatile, never hardcode** |

Two open facts that only a manual test with a real account can settle, both recorded in § 7:
whether the wallet login accepts an ERC-1271 signature (our passkey members are contract accounts),
and whether `x-api-key` is honoured.

## 2. What those facts do to the design space

Three of them are decisive, and they are worth stating before any pattern is discussed.

**No delegated authorisation exists.** There is no OAuth, no "sign in with GutterToken", no
account-linking API. The only credential a member can bring is a raw `sk-…` key copied from
GutterToken's dashboard. Every integration pattern is therefore a variant of exactly two questions —
*where does that key live* and *who makes the HTTP call* — and the surface (mini-app, sheet, Settings
card) is the third, independent axis. A "mini-app for managing the user's experience" cannot avoid
the key paste; it can only put a different frame around it.

**There is nothing to manage.** With no balance, usage, deposit-address or key-listing endpoint, an
in-app "GutterToken console" would have three controls: paste a key, test it, and a link out to
`app.guttertokens.com`. Balance is knowable only in retrospect, as a `403 insufficient_quota` on a
real request. Under constitution III that also fixes the UI: FairWins cannot render a credit balance,
a burn rate or a "credits remaining" bar, because it cannot read one, and anything it did render would
be fabricated.

**The browser can call the API directly.** Open CORS plus the spec-069 `connect-src https:` grant in
`frontend/nginx.conf` (and the native CSP derived from it, spec 103) means a page at our origin can
`POST https://api.guttertokens.com/v1/messages` today, with no header change and no gateway in the
path. That is the fact that makes the recommended pattern cheap: FairWins never has to hold, forward
or even see the member's key.

## 3. The patterns

### P1 — Bring-your-own-key, browser-direct  ← **recommended**

The member pastes a GutterToken key into FairWins once. It is stored on the device only, and the
assistant panel calls GutterToken's Messages endpoint straight from the browser with it. The FairWins
gateway is not in the request path at all.

- **Key custody**: device (wallet-scoped `userStorage`), never synced, never backed up.
- **Caller**: the member's browser, from the member's IP.
- **Who may use it**: anyone with a connected wallet and a key — i.e. this is the rail that makes the
  assistant *not* members-only, which is the ask.
- **What FairWins sees**: nothing. Conversation content goes device → GutterToken. The privacy story
  is simpler than the current rail, not more complicated: GutterToken is a processor the **member**
  chose and contracted with, not FairWins' processor.
- **AUP liability**: none on FairWins. The member is using their own GutterToken account; "their use
  is your use" does not attach.
- **Cost control**: the member's prepaid balance is the ceiling. The gateway's request quota and
  token budget do not apply and are not needed — they exist to bound FairWins' bill.
- **Rate-limit domain**: per member IP, which is exactly the domain GutterToken limits on. (Members
  behind carrier-grade NAT can share a source address and see a `429` that is not theirs to fix; the
  panel must render it as GutterToken's throttle, not as a FairWins fault.)
- **Prompt**: the system prompt has to be composed client-side. See § 4 for how to keep it single-
  source with the gateway's.
- **Size of change**: frontend only, plus legal copy and a FinOps entry. No contract, no gateway
  route, no infra.

### P2 — Bring-your-own-key, forwarded through the gateway  ← rejected

The member's key rides to our gateway in a header; the gateway swaps its upstream to GutterToken for
that request and keeps the server-side prompt, budgets and screening.

Rejected because every property it preserves is one the member-paid rail does not need, and every
property it adds is a liability: FairWins handles a third-party spending credential in flight
(a new class of secret in a process that today holds none of a member's); every member's traffic
collapses onto the gateway's single source IP, which is precisely what GutterToken rate-limits on;
the route would still require a member-API bearer, so it stays members-only unless a new
unauthenticated relay is opened, at which point FairWins is running an open proxy for other people's
keys. The only thing P2 protects is the server-side prompt, and § 4 solves that without it.

### P3 — A FairWins-owned GutterToken account as the gateway's upstream  ← complementary ops change, not the ask

`ASSISTANT_BASE_URL=https://api.guttertokens.com` is already a supported config
(`services/relay-gateway/src/config/index.js:770`); with a FairWins-funded key this swaps the
member-funded rail's *billing* from an Anthropic invoice to prepaid stablecoin credit and pairs
neatly with the referral credit from P1 (it lands on the same account). It does not give non-members
anything and it is not what was asked, but it is worth recording because it is nearly free.

Three things to check before doing it: (1) the proxy sends `x-api-key`, and whether GutterToken
honours that is unconfirmed — switching to `Authorization: Bearer` is a one-line, injectable change;
(2) all members would share one source IP and one account's concurrency limit; (3) under the AUP,
members' use becomes FairWins' use, and the FinOps catalogue entry `assistant-model-api` must be
re-based from `billed` to `modelled` (prepaid credit has no invoice).

### P4 — A GutterToken mini-app (spec 073 registry package)  ← rejected

Four structural reasons, any one of which is sufficient:

1. **The host store is the wrong place for a key.** A package's only persistence is `host.store`,
   which **rides the spec-032 encrypted backup** as the `miniAppState` synced object. A key stored
   there is exported, restored onto other devices, and outlives the member's memory of having
   entered it — the exact outcome the spec-069 (`network_endpoints`) and spec-095
   (`api_access_keys`) decisions exist to prevent. There is no non-synced store on the host object,
   and adding one is a host-contract change granted permanently to every third-party package.
2. **A package cannot reach the assistant.** The launcher and panel are host surfaces mounted in
   `App.jsx`; a package has no route to them, and the package-boundary gate
   (`frontend/src/test/miniapps/packageBoundary.test.js`) forbids `frontend/src` importing a
   converted tree in the other direction. A mini-app could only be a *second* chat surface,
   duplicating `AssistantPanel`, `memoryStore` and the reply disclosure — the "two copies drifting"
   failure the FR-030 amendment named when it kept Wagers out of the catalog.
3. **There is nothing for it to manage** (§ 2). A console with no balance read is a key field and a
   link-out, which is one Settings card, not an app.
4. **Registry ceremony per cohort** (Polygon and Mordor, separate ids, curator approval, keccak-
   committed bytes) for a first-party surface that will change with GutterToken's API is the wrong
   cost profile. The spec-093 precedent is explicit: first-party screens whose file closure lives in
   `frontend/src` are host-bundled, not registry packages.

If a "console" is ever wanted, the viable form is a spec-093-style host-bundled screen — which is
P1's Settings card with more chrome.

### P5 — "A series of bottom sheets"  ← this is P1's surface, not an alternative

`AssistantPanel` is already an `ActionSheet`. The bottom-sheet idiom is how P1 should be presented:
the panel's existing "Sign to start" authorisation step becomes a two-way chooser, and the key
ceremony is a second sheet reached from it or from the Settings card. The abstraction the user
asked about ("if we can sufficiently abstract") is a **provider seam** in `lib/assistant/`, not a UI
component: the sheet stays one component; what changes is which transport `send` resolves to.

### Comparison

| | P1 BYOK direct | P2 BYOK via gateway | P3 FairWins GT account | P4 Mini-app |
|---|---|---|---|---|
| Key held by | member device | member device, in flight through gateway | FairWins (secret) | member, **in synced store** |
| Caller / IP | browser / member's | gateway / one IP | gateway / one IP | browser / member's |
| Opens assistant to non-members | **yes** | only with a new unauthenticated relay | no | yes, as a second surface |
| FairWins sees message content | **no** | yes | yes | no |
| AUP "their use is your use" | no | no | **yes** | no |
| Prompt location | client (shared source, § 4) | server | server | client, duplicated |
| Spend ceiling | member's balance | member's balance + our budgets | FairWins budgets | member's balance |
| Change footprint | frontend + legal + FinOps | gateway route + frontend + secret handling | env only (+ header check) | package + registry + store change |

## 4. Recommended design, mapped to the existing seams

### 4.1 Provider seam

```
frontend/src/lib/assistant/
  assistantClient.js        unchanged: the FairWins rail (session grant → gateway)
  providers/
    guttertoken.js          POST https://api.guttertokens.com/v1/messages
                            Authorization: Bearer <key> · anthropic-version: 2023-06-01
                            same {system, messages, max_tokens, model} body the gateway sends
                            same AssistantError states, plus two of its own (below)
    resolveProvider.js      (account) => 'fairwins' | 'guttertoken', from assistant_prefs
  guttertokenKeyStore.js    the key, and only the key
  assistantPrefs.js         gains  provider: 'fairwins' | 'guttertoken'   (default 'fairwins')
```

`AssistantPanel.send` resolves the provider once per turn and calls one of two functions with the
same signature and the same error contract. The panel's honest-state rendering does not change;
two states are added:

| Upstream | State | Panel copy | Action |
|---|---|---|---|
| `401 invalid_api_key` | `key_invalid` | "GutterToken did not accept this key. It may have been revoked." | open key sheet |
| `403 insufficient_quota` | `out_of_credit` | "Your GutterToken balance is empty. Top up at GutterToken and try again." | link out (billing) |
| `429` | `quota` (existing) | "GutterToken is rate-limiting requests from your network." | retry after |
| `503 model_unavailable` | `unavailable` (existing) | as today | retry |
| transport | `unreachable` (existing) | as today, naming GutterToken | retry |

**No fabricated reply on any of them**, and no shortened reply — the spec-095 invariants hold
unchanged. The `/status` probe on the transport-failure path is FairWins-rail-only; GutterToken has
no equivalent, so `unreachable` stands as the honest answer.

### 4.2 The system prompt has one source

`buildSystemPrompt` currently lives in the gateway, deliberately server-side so a member cannot
replace it. On P1 the member could always replace it (they hold the key and could call GutterToken
from a terminal), so server residency buys nothing on this rail — but **two copies of the prompt** is
issue #1038's shape again. Hoist it into a plain-Node-resolvable shared package
(`packages/assistant-prompt`, extensioned imports + explicit `exports`, per spec 075 rule 3) consumed
by both the gateway and `providers/guttertoken.js`. This is a workspace-member addition: it touches
the root lockfile, so the change goes through `npm run deps:reinstall`, `check:deps` and both byte
gates (`monorepo-workspace` / `monorepo-verify` skills). If that cost is refused, the fallback is a
client copy pinned by a Vitest parity test that imports the gateway module directly (tests are not
shipped code, so the cross-tree import is legal there) — weaker, and it should say so in the plan.

The prompt's hard rules ("you have NOT performed any action", "never ask for a key") matter *more*
on this rail, not less: the member is now on a surface where they just pasted a key.

### 4.3 Key storage

Follow the spec-069 RPC-credential precedent, not the spec-062 vault:

- **Wallet-scoped** `userStorage` (localStorage), key `assistant_guttertoken_key_v1`. Wallet- rather
  than device-scoped, matching `assistant_prefs`: enabling a third-party processor is a decision
  about an *account*, and a second account on the same device must not inherit it.
- **Deliberately absent from `lib/backup/syncedObjects.js`**, with the same test that asserts the
  absence for `network_endpoints`, `api_access_keys` and `assistant_prefs`.
- **Redacted at every display and log boundary**: `sk-…` plus the last four characters, via one
  helper; never in a URL, an audit field, a toast or an error message. The access-ledger event is
  "GutterToken key added / removed" — metadata only, under the existing `access` domain beside
  "API key created".
- **Validated and tested on save**, the way an RPC endpoint is: `^sk-` shape, then one
  `GET /v1/models` with the key. `401` refuses the save ("GutterToken did not accept this key");
  unreachable saves with the failure shown. `/v1/models` is also the honest source for the model
  picker if one is ever offered — "the models your key can reach".
- **Plaintext at rest, stated plainly.** The spec-062 vault wraps secrets under a passphrase or
  passkey PRF because a private key is unbounded, unrevocable authority. A GutterToken key is a
  revocable, re-copyable credential over a bounded prepaid balance, and the RPC-key precedent is
  plaintext for the same class. If product wants the wrap anyway, the PRF-KEK path in
  `lib/passkey/prfKeys.js` is reusable; it should be a follow-up, not a v1 blocker.

### 4.4 Gating

`AssistantLauncher` today renders for `tenant feature ∧ wallet ∧ opted-in ∧ membership active-paid`,
with the membership read mounted last because it costs an RPC call. The new gate is

```
tenant feature ∧ wallet ∧ opted-in ∧ ( guttertoken key present  ∨  membership active-paid )
```

evaluated in that order: a member with a key never pays the membership read at all. The three-state
membership rule is untouched — `pending`/`unreadable` still render nothing, never a denial — and a
non-member with a key gets the launcher because the disjunction short-circuits before the read.
Wallet connection stays required in v1: preferences and the key are wallet-scoped, and the
`surface` field and memory semantics assume an account.

A tenant feature flag `assistant-byok` (on for `fairwins`) lets a white-label tenant keep the
assistant without a third-party rail; the manifest is the only place a tenant identity value lives
(spec 072), so the referral-coded signup URL belongs there too.

### 4.5 Surfaces

**Settings ▸ Assistant** (`AssistantPreferencesPanel`, card id `assistant-prefs`), new rows:

- *Answered by*: **FairWins (membership)** | **GutterToken (your credits)** — a radio, with the second
  disabled-with-reason until a key is saved.
- *GutterToken key*: masked value or "None", **Add / Replace** (opens the key sheet), **Remove**,
  **Test**.
- *Get a key* ↗ — the tenant's referral-coded signup link, with the referral disclosed in words
  ("FairWins receives credit from GutterToken when you fund an account through this link").
- Disclosure block gains a third branch: *while GutterToken is selected, your messages and the
  screen you are on go from this device directly to GutterToken; FairWins does not receive them.*

**Key sheet** (`ActionSheet`, the spec-045 informative idiom): what the key authorises (spending
your GutterToken balance, from this device, for this account), that it is stored on this device
only and never backed up, paste field, Test, Save. Reached from the Settings row and from the panel.

**Assistant panel** first-open step: when the account has no active membership and no key, the
"Sign to start" step becomes a chooser — *Become a member* (link) | *Use your own GutterToken
credits* (key sheet). When a key exists and the provider is GutterToken, the *chat* needs no
session grant — the gateway is not in the model path — but the **tools** in Part II do: reading the
member's own wagers or membership is a member-API call, and it needs the same 24-hour grant the
FairWins rail mints. So a member on the GutterToken rail is offered the grant when they first ask
something that needs their data, and a non-member gets the public tools only (§ 8.4). The sheet
header states the provider ("Answered by GutterToken on your credits"); the per-reply disclosure
stays as it is.

**Nav search** (`config/navSearchIndex.js`): add `guttertoken`, `byok`, `api key` synonyms on the
Assistant card so "guttertoken" in the drawer lands on the card.

### 4.6 Cost disclosure

The confirm-UI rule from specs 057/060 applies in spirit: the member must know who charges what
before the first token. The honest sentence is *"GutterToken charges your prepaid balance per token
at its own rates; FairWins charges nothing on this path."* Rates are not rendered — they are not
readable from the API and the docs' table is volatile — the link is. `usage.inputTokens/outputTokens`
from each reply may be shown per turn because they are facts GutterToken reported; a running dollar
figure may not, because it would multiply a fact by a guess.

### 4.7 Legal

`frontend/src/legal/privacy-policy.md` §2 and §5 currently say assistant messages are shared with
"the AI model provider that generates the reply (currently Anthropic), acting as our processor". Amend
(not append — spec 095 R11): when the member selects GutterToken, messages are sent by the member's
own device to GutterToken under the member's own GutterToken agreement; FairWins does not receive or
process them, and GutterToken is not FairWins' processor for that content. Terms gain a third-party
service clause; the Risk Disclosure notes prepaid credit is GutterToken's, non-refundable, and
unrecoverable if a wallet-only account loses its key.

### 4.8 FinOps (spec 089)

The referral is a revenue source and the catalogue is the source of truth: add
`referral-guttertoken` (`kind: revenue`, `collector: referral`, in-kind credit, non-cashable, stated
in `meaning`). Note that gate C2b enumerates payee env reads in `services/relay-gateway/src/**`
only — a referral code that lives in the tenant manifest and ships in the frontend would be
invisible to it, so the entry is added on purpose, not because a gate demanded it. If P3 is also
adopted, `assistant-model-api` moves to `basis: modelled` and its cost is offset by the same
account's referral credit; the two entries should say so.

### 4.9 Tests and E2E

- Vitest: `syncedObjects` absence; redaction helper never leaks more than four trailing chars;
  launcher gate matrix gains the (no membership, key present) and (unreadable, key present) rows —
  both render the launcher without an RPC read; error mapping for the five upstream cases; prompt
  parity.
- Cypress fast tier (no chain): `cy.intercept('https://api.guttertokens.com/**')` for save-test,
  out-of-credit, invalid-key, and a real reply — each asserting the rendered sentence, none behind a
  precondition guard (spec 094 assertion-depth rule). New `matrix.json` rows under the 095 spec's
  section, depth `real`.
- Actor-critic screenshots for the Settings card and both sheets, light + dark, phone + desktop.

### 4.10 Things that do not change

`memoryStore` (device-local, bounded, never synced). The reply disclosure. The `assertive`/`polite`
split. Native shells — the native CSP is derived from `nginx.conf` and `connect-src https:` already
admits the host. Sanctions screening — no FairWins service is in the request path on P1, so there is
nothing to screen (P3 keeps the gateway's existing fail-closed screen).

## 5. Why not simply "let the user add API keys" as a generic feature

The phrase covers P1, but a *generic* "add any OpenAI-compatible endpoint + key" seam is a
different, larger product: arbitrary hosts get the member's page path and conversation, the error
vocabulary stops being knowable, and the disclosure copy stops being true for all providers at
once. Ship the seam provider-shaped (`providers/guttertoken.js`) with a fixed base URL; the
`resolveProvider` indirection is what makes a second named provider cheap later without making
"any URL" the v1 contract.

## 6. Sequencing

1. **Spec 104 — GutterToken BYOK assistant rail** (P1 + P5): provider seam, key store, gate change,
   Settings card + key sheet + panel chooser, prompt package, legal amendments, FinOps entry, tests,
   E2E rows. Frontend-only in shipped paths.
2. **Ops (optional, separate PR)**: P3 — fund a FairWins GutterToken account through the referral
   link, confirm the auth header with a real key, point `ASSISTANT_BASE_URL` at it, re-base the
   FinOps cost entry.
3. **Follow-ups, not v1**: streaming (`stream: true` is available and the browser-direct path
   makes it trivial); model picker from `/v1/models`; optional PRF-wrapped key at rest.

## 7. Open questions (answer before `/speckit-plan`)

1. **Does GutterToken's wallet login accept ERC-1271, and can FairWins sign it in-app?** ANSWERED
   2026-09-05 by reading the signup page and its bundles (`/build/assets/app-*.js`, `eth-*.js`) and
   probing the endpoints. The flow is: `window.ethereum` ONLY (no EIP-6963, no WalletConnect — with
   no injected provider the wallet button is *removed* and signup is e-mail only) →
   `eth_requestAccounts` → `POST /login/wallet/challenge {address}` (Laravel: `X-XSRF-TOKEN`
   double-submit from a cookie we cannot read, session cookie `gt_customer_session`
   `SameSite=Lax; HttpOnly`, **no CORS headers at all** — the preflight from our origin fails) →
   returns a SIWE message with a per-session nonce, `Chain ID: 1` and a 5-minute expiry →
   `personal_sign` → form POST to `/signup/wallet` gated by the CSRF `_token`, the terms box and
   an **Altcha proof-of-work** captcha. Consequences: (a) FairWins cannot perform the sign-in from
   its own origin — not headless, and not by pre-signing and redirecting, because the nonce is
   minted inside their session and nothing accepts an externally produced message; (b) a passkey
   member cannot use wallet signup at all: there is no provider to inject on the web, and the
   verification is pinned to chain 1 with wording ("prove you control this wallet") that indicates
   `ecrecover`, so an ERC-1271/6492 envelope from a Polygon smart account would not verify even
   through a native-shell WebView bridge; (c) classic-wallet members already have the path — their
   extension or wallet app signs on GutterToken's page directly. What FairWins *can* do: deep-link
   `https://app.guttertokens.com/signup?ref=<code>` (verified: `ref` prefills), tell classic-wallet
   members to sign with the same address they use here, and steer passkey members to e-mail signup
   with an honest note that crypto deposits must come from a wallet GutterToken can attribute.
   The unlock is on GutterToken's side (ERC-1271 + 6492 verification, an EIP-6963/WalletConnect
   path, or a key-provisioning API); it is a partnership ask, not code here.
2. **Is `x-api-key` honoured?** Only matters for P3. Manual test with a real key.
3. **Plaintext at rest, or PRF-wrapped?** § 4.3 recommends plaintext with the RPC precedent; a
   product decision.
4. **Wallet required, or a wallet-less guest path?** § 4.4 says required in v1; a guest path would
   need a device-scoped preference and a different memory key, and a different disclosure.
5. **Should the member choose the model?** Deferred; if yes, populate from `/v1/models` and state
   that rates differ, without rendering them.
6. **Referral disclosure wording** in the Settings row — legal to confirm.

---

# Part II — Making the assistant useful: the MCP server and tools

## 8. The assistant has no hands, and the MCP server is a transport, not a brain

### 8.1 What exists, as read

**The in-app assistant calls the model with no tools.** `services/relay-gateway/src/memberApi/assistant.js`
sends `{ model, max_tokens, system, messages }` and nothing else. The 24-hour session grant asks for
`read:profile`, `read:membership`, `read:wagers` and `read:fees` (`ASSISTANT_SESSION_SCOPES`), and
nothing on the chat path exercises any of them — the gateway verifies the token's scope
`assistant:chat` and forwards the conversation. Every fact the assistant states about the member's
own position is therefore a guess, and the system prompt's "do not guess a balance, a rate, a
deadline" line is doing the work that a tool call should.

**The MCP server is a transport adapter over the member API.** `services/mcp-server/src/tools.js`
defines eight tools; each is one `fetch` to one gateway route with the member's `fw1` token and an
honest error mapping (`isError: true`, "this is an UNKNOWN, not an empty result"). Three resources
(live `openapi.json`, live `/status`, an embedded guide), two prompts (`wager-review`,
`portfolio-briefing`). Zero dependencies, not a workspace member, stdio by default, an HTTP mode that
binds loopback and validates `Origin`. The hosted Cloud Run instance is declared but gated off
(`manage_mcp_server = false`; no pipeline pushes the image). It exists for *external* agents —
Claude Desktop, Claude Code — and it is good at that.

**So the two artefacts do not touch.** The assistant knows the platform's shape from its prompt and
nothing about the member; the MCP server knows the member's data and is never in the assistant's
path. "Make the assistant more useful with the MCP server" resolves to one question: *how does the
tool table the MCP server already curates reach the model the assistant is talking to?*

### 8.2 Four ways to connect them

| | How | Verdict |
|---|---|---|
| **T1** Anthropic MCP connector | The Messages request carries `mcp_servers: [{type:'url', url, name, authorization_token}]` + `tools: [{type:'mcp_toolset', mcp_server_name}]` under beta `mcp-client-2025-11-20`; **Anthropic's servers** dial the MCP server. | **Rejected for the in-app assistant.** It needs the hosted MCP instance on public HTTPS (undeployed; the HTTP transport is a single-message `POST /mcp`, and connector compatibility with that shape is unverified). Worse, the member's capability token rides in the request **body** as `authorization_token`: browser → Anthropic → MCP → gateway on the FairWins rail, and browser → **GutterToken** → Anthropic → MCP → gateway on the other — a spending-adjacent credential transiting a third party whose header passthrough for beta features is itself unknown. Availability is also platform-dependent. It **is** the right shape for external clients once the hosted instance ships (a remote-server entry in Claude Desktop instead of a local `node` command). |
| **T2** Run the MCP server in the browser | Bundle `services/mcp-server` into the SPA. | **Pointless.** It is JSON-RPC framing around `fetch`; the browser already has `fetch` and the token. It would also breach the package boundary rules for no capability gained. |
| **T3** Client-side tool loop | The panel builds the Messages `tools` array from a shared table, runs a bounded loop in the browser, and executes each `tool_use` as an ordinary member-API request with the session grant (or a public route with none). Works identically against the gateway proxy and against GutterToken. | **Recommended, on both rails.** One loop implementation. Tool executions arrive at the gateway as **the same member-API traffic the MCP server generates** — already authenticated, scoped, quota'd and audited, with no new route. The browser can also run tools the gateway cannot (§ 8.4), and the panel can render per-tool progress and per-tool honest states ("Polygon indexer did not answer") instead of hiding them behind one reply. |
| **T4** Gateway-side tool loop | `assistant.js` runs the loop in-process, calling the member-API module functions under the token's scopes. | **Viable for the FairWins rail only**, and it forks the loop (browser for GutterToken, server for FairWins). Its one advantage — fewer round trips — is small at ≤4 rounds; its cost is two loops that drift and a member who cannot see which read failed. Keep it as the fallback if T3's content-block validation proves unacceptable on the gateway (§ 8.6). |

The principle under T3: **the assistant needs the MCP server's tool table, not its transport.** The
MCP server stays what it is — the external-agent door — and the in-app assistant becomes a second
client of the same tools, executed in the member's own browser.

### 8.3 One source of truth for the tool table

Today the table lives in `services/mcp-server/src/tools.js` with each definition bound to
`api.get(...)`. The MCP server **cannot import a shared package** (zero dependencies, not a workspace
member, standalone Docker context) and shipped frontend code cannot import from `services/`. The
repo has already solved this shape once (`@fairwins/intent-types` + `TypehashParity`): one package,
one vendored copy where a package is impossible, one parity test that fails when they diverge.

```
packages/assistant-contract/              plain-Node resolvable (spec 075 rule 3)
  src/prompt.js       buildSystemPrompt (Part I § 4.2 — same package, one lockfile event)
  src/tools.js        TOOL_DEFS: name · title · description · inputSchema · exec: { route | public | local }
  src/results.js      okResult / errorResult text — the MCP server's honest wording, verbatim

consumers
  services/relay-gateway/src/memberApi/assistant.js   attaches TOOL_DEFS (FairWins rail; § 8.6)
  frontend/src/lib/assistant/tools/                   Messages `tools` array + executor
  services/mcp-server/src/toolDefs.snapshot.json      VENDORED copy — the server stays dependency-free
  services/relay-gateway/test/mcpToolParity.test.js   snapshot ⇔ package, both directions
```

`exec` is data, not a function: `{ route: 'wagers', query: ['chainId','first'] }`,
`{ route: 'intentsBuild', body: ['action','chainId','params'] }`, `{ public: '/v1/perps/pairs' }`,
`{ local: 'find_in_app' }`. The MCP server, the browser executor and the OpenAPI renderer each bind it
to their own transport. The `route` ids are `contract.js`'s `ROUTES[].id`, so a tool over a route
that does not exist fails the parity test, not a member. The document already carries
`x-fairwins-scope`; adding `x-fairwins-tools` to `openapi.json` lets any generic client discover the
same table the MCP server ships.

This is the one lockfile-touching change in the whole proposal (a new workspace member); it goes
through `deps:reinstall`, `check:deps` and both byte gates once, for the prompt and the tools together.

### 8.4 The v1 tool surface

**Reads that exist today** (each is one member-API route the MCP server already wraps; every result
keeps the per-chain `read / not-configured / unreadable` envelope verbatim):

| Tool | Route | Auth |
|---|---|---|
| `get_profile` | `/v1/member/me` | grant |
| `get_membership` | `/v1/member/membership` | grant |
| `get_wagers` | `/v1/member/wagers` | grant |
| `get_fees` | `/v1/member/fees` | grant |
| `get_gateway_status` | `/status` | none |
| `get_prediction_markets` | `/v1/polymarket/137/markets` | none |
| `get_perps_pairs` | `/v1/perps/pairs` | none |

**One local tool the gateway cannot serve:** `find_in_app(query)` over `config/navSearchIndex.js` +
`lib/nav/navSearch.js` — the same index the drawer's search uses, returning real paths with their
`focus=<id>` attention markers. This replaces the hardcoded path list in the system prompt with the
app's own map, and it is what makes "never invent a URL" enforceable: the model asks the index, and
`replyLinks.js`'s allow-list still decides what becomes a link. It is the assistant's equivalent of
the drawer's rule that the index is *descriptive, never authoritative* — a hidden surface does not
resurrect because the model found it.

**Deliberately not in v1:**

- **`build_intent`.** In the browser the member *can* sign, which is exactly why this is the
  dangerous one. The spec-095 invariant is "the assistant never signs or submits", and the first
  in-app tool that returns typed data will be followed by a request for a button that signs it. The
  right v2 shape is `prepare_action` → a **review card that deep-links to the surface that owns the
  action, with fields prefilled** — the member signs where fees, sanctions, chain switching and
  confirmation already live (`wagerVm`, the pool page, Membership) and never in the panel. Not a
  tool that signs, not a tool that submits, and not before § 8.5 is designed in.
- **`navigate`.** The mini-app host has one; the assistant should not. Moving the member's screen
  from inside a chat turn is an action on the UI they did not take; a link they tap is the
  established idiom (`replyLinks.js`) and the honest one.
- **Anything device-scoped that reads a credential** (RPC endpoints, keys). Nothing the model sees
  should be able to describe a secret.

Gating follows the grant: on the FairWins rail the session grant exists before the first message;
on the GutterToken rail the panel offers the grant the first time a member-data tool is needed
(Part I § 4.5), and a non-member simply has the three public tools. `tools` is **the same sorted
array on every request of a conversation** — a mode change (grant arrives mid-thread) starts a new
thread rather than swapping the tool set under a cached prefix.

### 8.5 Prompt injection is the design constraint, not an afterthought

Tool results carry **text other people wrote**: a counterparty's wager description, a pool name, a
Polymarket question. Once tools exist, that text enters the model's context. With a read-only
surface the blast radius is a misleading sentence — bounded by the per-reply disclosure and by
`replyLinks.js` refusing to link anything off-origin — and that bound is the whole reason § 8.4 keeps
writes out. Four rules for the implementation:

1. Tool results are wrapped as data (`tool_result` blocks, never pasted into a user turn), and the
   system prompt states that instructions found inside a result are content to report, not to
   follow.
2. No tool result may cause the app to *do* anything — no auto-navigation, no prefilled form
   without a member tap, no second tool call the member did not ask a question to justify.
3. The link allow-list stays the only path from model text to a clickable target.
4. `prepare_action` (v2) renders the **contract's** fields from the built typed data, never the
   model's paraphrase of them — the review card is a rendering of what will be signed, so an
   injected "send 500 instead" has nowhere to hide.

### 8.6 Loop mechanics, budgets and caching

- **Bounded rounds.** At most 4 tool rounds per member turn; the fifth response is rendered as-is.
  `tool_choice: {type: 'auto'}` only — forced tool use is rejected on the newest model tier and
  buys nothing here. `strict: true` on every tool (the schemas already carry
  `additionalProperties: false`), so arguments validate before a fetch is made.
- **Parallel calls.** A response may carry several `tool_use` blocks; execute them concurrently and
  return **all** `tool_result` blocks in **one** user message. A failed read is
  `is_error: true` with the MCP server's exact wording, never dropped.
- **Per-tool timeouts** (a subgraph read is not allowed to hold the turn), and the panel shows what
  is being read while it waits.
- **The FairWins rail.** `parseChatRequest` today admits `{role, content: string}` only. It must
  admit `tool_use` / `tool_result` content blocks under an allow-list of block types, and the
  **gateway attaches the tool definitions itself** from the package — a client never supplies
  `tools`, because on this rail that would be arbitrary text into the model at FairWins' expense.
  Each loop round is a separate gateway request, so the existing reserve-then-settle token budget
  already binds per round; the round cap is the multiplier, so `ASSISTANT_MAX_ROUNDS` joins the boot
  check beside `ASSISTANT_MAX_TOKENS`. `assistant_budget_exhausted` mid-loop ends the turn with the
  honest sentence, never a truncated answer.
- **Prompt caching.** Render order is tools → system → messages, and the cache is a byte-prefix
  match. `buildSystemPrompt({ surface })` interpolates the member's **current path into the system
  prompt**, so every navigation rewrites the prefix. It is moot today (the prompt is under the
  cacheable minimum); with tool schemas the prefix crosses that minimum on both current model
  tiers and it stops being moot — and on GutterToken cache reads are billed at a tenth of the
  rate. Move `surface` into the **last user turn** (or a mid-conversation `system` message on the
  models that support it), sort the tool list deterministically, and freeze the system text.
- **Memory stays text-only.** `memoryStore` keeps the last 50 messages / 64 KB on device; persist
  the member's and assistant's *text* turns only. Tool results are the member's own data and the
  reason the memory was deliberately kept out of the backup — writing wager envelopes into device
  storage is a new retention decision, not a cache.

### 8.7 The MCP server afterwards

Unchanged in role and in invariants: zero dependencies, never mints a token, never signs, never
pays. Two additions: the vendored `toolDefs.snapshot.json` with its parity gate, and — once the
hosted instance is published (runbook § 3.8) — a remote-server entry in the client examples, which
is where T1 becomes available to *external* agents. Its two prompts become the panel's suggested
starters ("Review my wagers", "Portfolio briefing") from the same table, so the phrasing that tells
the model to name an unreadable chain is written once.

### 8.8 Open questions for Part II

1. **T3 or T4 on the FairWins rail?** § 8.2 recommends T3 for one loop and visible per-tool states;
   the cost is content-block validation on the gateway. Decide before `/speckit-plan`.
2. **Round cap and per-round budget interaction** — 4 rounds × worst-case turn must fit the
   per-account window, or the boot check refuses the config.
3. **`find_in_app` scope** — the nav index only, or also the accordion `hash` deep links.
4. **Whether `prepare_action` is a v2 spec of its own.** It should be: it is the first assistant
   feature with a path to a signature, and it deserves the security lifecycle spec 082 gave the
   perps execution wrapper.
5. **Hosted MCP deployment** is a prerequisite for nothing here — T3 needs no MCP process at all —
   but it is what lets a Claude Desktop member skip the local `node` command.
