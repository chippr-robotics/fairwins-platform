# Phase 0 Research: Gateway Caller Authentication and Abuse Prevention

**Feature**: `specs/106-gateway-caller-auth` | **Date**: 2026-09-04

Method: eleven independent agents — nine reading the repository, two researching vendors — followed by
an adversarial completeness critic that walked all 37 functional requirements looking for requirements
with no landing place. The critic found four structural blind spots and seven contradictions between
streams. **Its findings changed the design**, so this document leads with what it broke rather than
with what was confirmed.

---

## 0. Empirically verified during research

One dependency was too important to take from documentation. The vendor documents a per-endpoint `cors`
boolean and *nothing* about its semantics — no page says what it emits or whether preflight is answered
— while the entire "clients read direct from the provider" design rests on a browser being able to send
`Authorization` cross-origin. Probed against the live Polygon endpoint:

| Probe | Result |
|---|---|
| `OPTIONS` with `Access-Control-Request-Headers: authorization` | **`200`**, `access-control-allow-headers: Content-Type,Authorization,User-Agent` |
| Origin `https://fairwins.app` | echoed |
| Origin `https://evil.example.com` | **echoed** |
| Origin `capacitor://localhost` (iOS shell) | **echoed** |
| Origin `https://localhost` (Android shell) | **echoed** |
| Origin `null` | echoed |

**Three conclusions, and the second is not the good news it looks like.**

1. **The browser-direct design is viable.** Preflight succeeds and `Authorization` is allowed. Had this
   failed, the whole approach would have collapsed back to the rejected proxy alternative.
2. **The provider's CORS is not an access control.** It reflects any origin presented. It permits
   browsers to call; it restricts nothing. This *strengthens* the case for JWT — CORS contributes no
   protection whatsoever, so the token is the only real control — and it means no amount of CORS
   configuration substitutes for it.
3. **The native shells can read directly**, which matters because their origins are *not* allowlisted at
   our own gateway (§2.6). The provider is reachable from a channel our own gateway currently refuses.

---

## 1. Findings that change the design

### 1.1 CRITICAL — Enabling JWT on any endpoint we own would take down the gasless bundler

`QUICKNODE_POLYGON_API` is not one credential among many. It is:

| Consumer | How it reads it | Failover |
|---|---|---|
| alto bundler | `ALTO_RPC_URL`, marked **required** (`infra/vm/common/fetch-secrets.sh:217`) | **none** — "no failover and no default" (`credential-rotation.md:87`) |
| relay-gateway | `RPC_URL_PRIMARY_137` (`fetch-secrets.sh:143`) | yes |
| FinOps exporter | `fetch-secrets.sh:180` | yes |
| hardhat (deploys, fork tests) | the four mainnet URLs, all derived from **one** multichain endpoint (`terraform.tfvars:102-107`) | n/a |

The vendor rule is AND: with `jwts` enabled, *every* client must present a valid JWT. Turning enforcement
on for FR-026 therefore locks out four URL-token-only consumers, one of which has no failover and
executes gasless UserOps.

**CORRECTED 2026-09-05 — this was overstated, and the correction matters.**

"Locks out the bundler" was never a fact about the vendor. Alto is *our* software: we choose what it
connects to and what it sends. Verified against the account's admin API:

- **Five endpoints already exist**, two of them `matic` multichain. Configuring one for browsers is a
  dashboard action inside the current plan, **not a purchase**.
- All five report `jwts: false, tokens: true, requestFilters: false` — nothing is enforcing today, and
  one endpoint can be changed without touching the others.
- The vendor allows a JWT **in a URL**, so even a client that cannot set headers can carry one.

So the lockout dissolves. **The binding constraint is capacity instead**, and it is worse than a
lockout because no amount of configuration fixes it — see §1.7, which is now the blocker this feature
actually turns on.

### 1.2 CRITICAL — "JWT stand-alone" exists and is strictly better than what the spec assumed

`tokens` and `jwts` are **independent per-endpoint booleans**. The spec assumed enabling JWT renders the
URL token harmless; in fact enabling JWT makes the client present **both**. But the vendor also supports
`tokens: disabled` + `jwts: enabled`, in which **the endpoint URL carries no credential at all.**

That mode deletes the spec's ACCEPTED RESIDUAL premise ("the client necessarily holds both the endpoint
address and its expiring credential"). The address becomes public information and the JWT is the sole
factor. **Adopt stand-alone as the target configuration.**

One hazard, and it is an ordering hazard: `tokens: disabled` *alone* "will allow anyone to make requests
to the endpoint without the token". Both flags ride in one `PATCH`, so a partial apply is possible. The
runbook must register the key and enable `jwts` **before** disabling `tokens`, and the FR-026 verifier
must be able to detect the intermediate state.

### 1.3 CRITICAL — `data-model.md` contradicted the spec, and the error was mine

The first-draft data model assigned `minimumTier: human` to market/listing/perps reads. Combined with
the refusal contract, an unreachable challenge service then produces a **non-retryable 403** on exactly
the surfaces FR-006, FR-017, US1 scenario 3 and two Edge Cases require to keep working.

All ten repository streams independently assumed those reads stay anonymous. They were right and the
data model was wrong.

**Resolution — and this is the correction that most improves the feature.** A challenge is a **metering
upgrade, never an access gate**:

| Tier | Read access | Rate ceiling |
|---|---|---|
| `anonymous` | **yes** | low |
| `human` | yes | materially higher |
| `member` | yes | highest |

Anonymous reads survive unconditionally, so a challenge outage costs throughput and never access. It
also removes the boot-time challenge ceremony a logged-out visitor would otherwise need before the first
market fetch. Reads never refuse for want of a tier; they slow down.

### 1.4 CRITICAL — A second, unmetered credential-injecting edge that the spec never mentions

`frontend/nginx.conf.template:38-72` proxies `/api/pinata/` → `api.pinata.cloud/pinning/`, injecting
`Authorization: Bearer ${VITE_PINATA_JWT}` at line 48. Its only control is the origin-lock header — the
very control this feature's Context exists to discredit — and it then sets
**`Access-Control-Allow-Origin: *`** (line 56), so any website's JavaScript can drive it. There is no
quota, no caller identity, and no `limit_req` anywhere in the repo. The trailing-slash `proxy_pass`
makes it a **path-wildcard passthrough into Pinata's entire `pinning/` namespace**.

This is the cleanest FR-030 violation in the estate, it is live today, and it is load-bearing
(`credential-rotation.md:190` — wager creation and encrypted backup pin through it with no fallback).

It is a **different edge** from the relay-gateway (the SPA's own nginx), so it is genuinely separate
work — but leaving it out would mean shipping a feature about not exposing platform credentials while
the most exposed one stays open.

### 1.5 HIGH — Three requirements have no landing place

| Requirement | Why it cannot be built as written |
|---|---|
| **FR-014 / SC-006** (disable a control in under a minute, no redeploy) | There is **no operator write channel to the gateway at all**. The only runtime control is one global boolean toggled by `SIGUSR2` over IAP-tunnelled SSH; every module killswitch is a boot-time env read. The admin console's `infrastructure` app is read-only. |
| **FR-033** (consumption observable per upstream and per tier) | The FinOps catalogue **explicitly refuses gateway-held counters** (`sources.js:262-266`: a gateway counter "would reset on every restart and vanish entirely if the container were replaced"). There is no gateway collector and no Prometheus endpoint on the gateway. |
| **FR-004's `app` tier** | No attestation code exists anywhere. The natural seam (`NATIVE_CAPABILITIES` in `lib/native/runtime.js`) would need a new Capacitor plugin — a lockfile event under spec 075. |

FR-004 was always deferred, so only the *seam* is in scope and this is not a surprise. The other two
need scope decisions rather than clever implementations.

### 1.6 HIGH — The native shells cannot send a credential to our own gateway

`ALLOWED_ORIGINS` is exactly `https://fairwins.app` (`docker-compose.yml:48`), and the CORS middleware
emits no `Access-Control-Allow-*` for anything else (`server.js:207-221`). The Capacitor shells run at
`capacitor://localhost` and `https://localhost` and use the WebView's `fetch`, subject to CORS.

So FR-007's member-grant requirement on Bitcoin broadcast — a **passkey-only, native-bridged flow** —
would land on a channel that cannot send the header. Adding both shell origins to the allowlist is a
prerequisite, not a nicety.

### 1.7 HIGH — The account rate cap contends with the bundler

`credential-rotation.md:186`: **"50 req/s hard cap shared across all three consumers; the bundler is the
one with no failover behind it."** US5/SC-015 hands keyed capacity to every anonymous visitor's browser
for a multi-chain fan-out. On the current account that contends directly with the bundler.

**Measured 2026-09-05 via the admin API, identically on all five endpoints:**

```
rate_limits: { "account": 50, "rps": 50, "rpd": -1, "rpm": -1 }
```

The cap is **account-wide**, surfaced per endpoint — so **adding endpoints adds no capacity**. This is
now the feature's real blocker, and it discriminates between the two designs in kind rather than in
degree: browser-direct makes upstream load proportional to **visitor count**, while a caching proxy
makes it proportional to **cache misses**. Against a hard 50 req/s shared with a bundler that has no
failover, that decoupling is the difference between viable and not.

The choice is therefore a bigger plan (a genuine purchase) or the proxy alternative recorded in §4 as
rejected — and it was rejected on latency, which does not outweigh a ceiling the design cannot fit
under. **Measure the per-screen upstream call count first**; that number decides it, and it has not
been measured.

---

## 2. Findings that constrain implementation

### 2.1 The frontend RPC seam is synchronous by deliberate design and cannot be made async

Three independently frozen assumptions:

1. wagmi transports are built during **module evaluation** (`wagmi.js:313-327`), no top-level await;
2. **~29 call sites** build providers inside `useMemo`/render and cannot await;
3. `host.readProvider(chainId): Provider` is **synchronous in the spec-073 mini-app host contract**, and
   packages consuming it are pinned at immutable CIDs — returning a Promise breaks already-approved bytes.

**Resolution: per-request injection, never async resolution.** The credential is fetched in the
background into module memory and attached at request time via ethers `preflightFunc` / viem
`onFetchRequest`. The seam stays synchronous and every one of the three assumptions survives.

### 2.2 The trap a naive implementation hits first

**Auth headers are applied only when `source === 'member'`** — `rpcProvider.js:113-115` and
`wagmi.js:240-251`. The wagmi non-member branch builds a bare `http(url)` with no `fetchOptions` at all.

An issued credential returned as a `default`-source route with populated `headers` is **silently
dropped**: no error, no log, just an unauthenticated request to a keyed endpoint. Worse, fixing only the
ethers rail leaves every wallet-side read unauthenticated.

Related traps: the revision counter is **global**, so bumping it per token refresh re-derives every
provider memo on every chain (a 15-minute TTL would churn the whole app on a timer); the provider cache
key **includes headers**, so baking a rotating token into them rebuilds providers on each rotation and
breaks the mini-app `WeakMap` identity whose entire purpose is preventing an infinite render loop. Both
are avoided by per-request injection.

### 2.3 Two existing seam violations sit in the blast radius

- `data/wagers/EventsSource.js:37` hand-builds `new ethers.JsonRpcProvider(...)`, bypassing the seam
  entirely — the only remaining non-test hand-built provider, and it would bypass issued credentials.
- `components/earn/SupplySheet.jsx:706` calls `makeReadProvider(pool.chainId)` as the *URL* argument,
  bypassing both route resolution and the provider cache.

### 2.4 The member verifier requires a **paid membership**, not merely a proven address

`auth.js:299-301` returns **403 `membership_required`** unless the account holds an active paid
`WAGER_PARTICIPANT` tier on the reference chain. "Member-verified" in this codebase therefore means
*"holds a live paid membership"*, not *"proved control of this address"*.

FR-007 gates order-signing, Bitcoin broadcast and marketplace writes on the `member` tier. Taken
literally against this verifier, **a member with a wallet but no paid tier could no longer trade** — a
severe regression that the spec did not intend.

**Resolution: the tier ladder needs a rung the spec did not name.** Split into `address` (a valid
signature over a grant, no membership read) and `member` (that plus an active tier). FR-007's routes
require **`address`**; nothing in this feature requires a purchase that did not require one before.
Spec 096's `PAYWALL_FALLTHROUGH_CODES` (`routes.js:154-161`) is the precedent for falling through on a
narrow set of codes without treating a 503 as a denial.

### 2.5 There is no reusable guard, and `ROUTES` cannot become the one route table

`createMemberAuth` is called **once, inline**, inside the `createMemberApiRouter` argument object
(`server.js:899-906`). It returns `authenticate(req, scope)` — a plain async function, **not**
`(req,res,next)` — and `guard()` is a module-private closure. Nothing outside `/v1/member/*` can reach
it. FR-003's "reuse the verifier" therefore means **extracting** it, not calling it.

And `memberApi/contract.js` `ROUTES` cannot be the universal table the data model demands: it holds only
the nine `/v1/member/*` routes and feeds the **public OpenAPI document** and **x402 pricing**. A new
table is required.

### 2.6 The CSP change is safe, and the gate it needs does not exist

Verified: adding a named host to `script-src`/`frame-src` **breaks none of the existing assertions** —
they are negative token checks plus one `script-src` byte-identity test
(`nginxCspScriptSrc.test.js:101-104`); `frame-src` carries a single `not.toContain('blob:')` and no
cross-file identity check. So FR-018's pinning gate genuinely does not exist yet and must be written.

Three corrections to assumptions the plan would otherwise inherit:

- **`frontend/nginx.conf` and `nginx.conf.template` are not twins** (118 vs 175 lines); only the CSP line
  is byte-identical. "Edit both" is right; "they are a maintained pair" is not.
- **`frontend/Dockerfile` does not exist** (deleted in `d8b760c3`); the root `Dockerfile:132` copies the
  template.
- **A fourth policy exists**: Helmet sets one inside the relay-gateway. Any CSP inventory must count it.

### 2.7 `/status` is origin-lock **exempt**

`server.js:240` exempts it outright; only the per-chain object is gated (`:358-361`). The Phase-1
contract asserted the opposite and must be corrected — anything added to the public body is
world-readable on the raw origin URL.

### 2.8 Mini-app packages are keccak-committed clients of the gateway

A package's entire network layer is the gateway, and its bytes are committed on-chain at an immutable
CID. **Any new required request header breaks already-approved packages.** New requirements must be
additive and default-tolerant, or the host must inject them on the package's behalf via `host.*`.

The MCP server (`services/mcp-server/`) is a third consumer of the member-API contract and was never
read by any stream — it forwards `X-PAYMENT` byte-for-byte and holds no key.

### 2.9 The shared counter store the spec depends on does not exist

The spec's Dependencies names "the existing shared counter store already deployed alongside the
gateway". The gateway has **no Redis client**; every quota is in-process. The deployed Redis is
engine-owned and runs `--save "" --appendonly no` — deliberately non-persistent. Per-subject quotas are
therefore per-instance, which is acceptable at one instance and must be stated rather than assumed.

### 2.10 Most routes the spec treats as credential-spending spend no platform credential

Verified: Polymarket, perps, bridge and Bitcoin upstreams hold **no platform credential** on the current
deployment. FR-013's real inventory is roughly seven items, not the whole route surface. This does not
weaken FR-007 — order-signing still spends *commercial standing*, and broadcast is still irreversible —
but it does mean the tier assignment must be justified per route rather than by "it calls an upstream".

---

## 3. Unknowns resolved

| Question | Answer |
|---|---|
| Provider plan tier | **Build or above** — operator-confirmed; JWT, method whitelisting and Admin API all available |
| Does JWT make the URL token harmless? | Imprecise. Both are enforced when both are on. **Stand-alone mode is better** (§1.2) |
| Is FR-026 implementable? | **Yes** — `GET /v0/endpoints/{id}/security` returns per-endpoint `options.{tokens,jwts,requestFilters}` plus `request_filters[]` |
| Can a browser send `Authorization` to the provider? | **Yes, verified empirically** (§0) |
| Algorithms | RS256 / ES256 only. No HS\*, no EdDSA |
| Enforced claims | **None.** No `iss`/`aud`/`sub`/`jti` verified; `exp` is enforced but **no maximum lifetime** |
| Multiple keys for rotation | **Yes**, unlimited; `kid` is "optional" in name only once rotating |
| Chain coverage | **No ETC (61) or Mordor (63)** — public capacity is permanent there, not a fallback |
| Method whitelisting | Per-endpoint "request filters"; rejection is JSON-RPC **-32611** |

Two consequences that shape requirements rather than merely informing them:

- **No claim binds a JWT to an endpoint.** Scoping is purely "which endpoint holds this public key". Any
  per-chain or per-tier scoping must be built from **separate endpoints with separate keys** — it cannot
  live in the token. This directly constrains FR-022: permitted operations are a property of the
  *endpoint's* request filter, not of the credential.
- **The FR-026 verifier handles credential material.** `GET /security` returns `data.tokens[].token` —
  live endpoint tokens in plaintext — alongside the booleans. It must destructure the two or three fields
  it needs and drop the rest before anything can serialise it.

---

## 4. Decisions required before implementation

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| **D1** | Procure a dedicated client-issuance endpoint | §1.1 — no owned endpoint can host JWT enforcement without taking down the bundler. Spend + FinOps entry |
| **D2** | Scope of the Pinata proxy fix | §1.4 — live, unmetered, `ACAO: *`, different edge. In this feature or its own |
| **D3** | FR-014 / SC-006 | §1.5 — build the gateway's first authenticated operator write channel, or relax to boot-time config |
| **D4** | FR-033 | §1.5 — build a gateway metrics surface the catalogue will accept, or narrow to `/status` telemetry |

`D1` and `D3` are the two that block work; `D2` and `D4` change scope rather than feasibility.
