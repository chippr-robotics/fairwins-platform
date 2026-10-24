# Feature Specification: Keyed RPC Access Without a Published Credential

**Feature Branch**: `spec/107-keyed-rpc-access`

**Created**: 2026-09-05

**Status**: Draft — capacity blocker likely dissolves once #1459 lands (see P2a)

**Input**: Split out of `specs/106-gateway-caller-auth/` after Phase 0 research. Spec 106 originally
carried both caller authentication and keyed data access; research established that the second half
cannot be hosted on infrastructure the platform currently owns, so it ships separately with its own
procurement and lifecycle.

---

## Why this exists

The product needs **keyed** data-provider capacity for reads. Public endpoints throttle a multi-chain
portfolio view into partial or missing data — that is the whole reason keyed capacity was procured.

The obvious way to give a browser that capacity is to compile the credential into the build. The slots
already exist (`_RPC_URL_*` build substitutions). **They are empty today, so nothing is exposed**, and
they should stay empty, for three reasons that only bite later:

1. **Rotation becomes a frontend release.** So does adding a chain. The operation that would shorten a
   credential's life is the one made expensive, which is how credentials end up long-lived.
2. **The usual protection is not one.** Provider-side referrer restriction is described *by the
   provider* as bypassable — "attackers can easily bypass this by faking their domain using scripts".
   It stops a rival website and nothing else. The provider's own recommendation for a frontend with a
   visible endpoint URL is to not publish the credential.
3. **Nothing verifies any of it.** Existing tooling checks which *chain* an endpoint answers for and
   has no notion of restriction; the environment-hygiene check only emits a non-failing note. An
   unrestricted archive endpoint pasted into one of those slots would ship to every visitor with
   nothing firing.

So the client obtains keyed capacity **at runtime**, as a short-lived read-only credential, from a
platform-controlled issuing point — and reads **directly** from the provider afterwards.

---

## Prerequisites — this feature cannot start without them

### P1. A dedicated issuance endpoint — **NOT a procurement** (corrected 2026-09-05)

An earlier draft called this a purchase. **That was wrong**, and the correction came from the
observation that the bundler is our own software: we control what it connects to and what it sends,
so "enabling enforcement locks out the bundler" was never a fact about the vendor — it was a fact
about a configuration we are free to change.

Verified against the account's admin API:

- **Five endpoints already exist**, including **two `matic` multichain** endpoints. Adding or
  repurposing one is a dashboard/API action inside the current plan.
- All five currently report `jwts: false`, `tokens: true`, `requestFilters: false` — so no endpoint
  is enforcing anything today, and one can be configured without touching the others.
- The vendor states plainly that **"JWTs can be sent through a URL, POST parameter, or inside an HTTP
  header"**, so even a client that cannot set headers can carry one.

So the lockout dissolves two independent ways: give browsers their **own** endpoint and leave the
server-side one alone, or teach the server-side consumers to present a credential. The first is
simpler and is the plan.

### P2. Rate headroom — **THIS is the real blocker**

Read from the admin API, identically on every one of the five endpoints:

```
rate_limits: { "account": 50, "rps": 50, "rpd": -1, "rpm": -1 }
```

The cap is **account-wide**, surfaced per endpoint. **Adding endpoints adds no capacity at all.**
Fifty requests per second is shared by the gateway, the cost exporter and alto — and alto is the one
with no failover behind it.

That reframes the feature's central choice, because the two designs scale differently in kind:

| | Upstream load |
|---|---|
| **Browser reads direct** | proportional to **visitor count** — every visitor's fan-out is upstream traffic |
| **Platform proxies with a cache** | proportional to **cache misses** — visitor count is decoupled from upstream load |

Against a hard 50 req/s shared with a bundler that cannot fail over, that decoupling stops being an
architectural preference and becomes the difference between viable and not. A single multi-chain
portfolio screen fans out across every supported chain; a handful of concurrent visitors can plausibly
consume the whole account allowance and starve the bundler.

**Two ways forward, and they are a genuine choice rather than a formality:**

1. **Raise the plan** — a real purchase, sized for browser traffic, after measuring the per-screen
   call count. Keeps the browser-direct design and its zero added latency.
2. **Adopt the proxy alternative** recorded in spec 106's research as rejected. It was rejected on
   latency and on putting platform infrastructure in the read path — neither of which outweighs a
   capacity ceiling the design cannot fit under.

### P2a. Measured 2026-09-05 — and it changes the answer again

The per-screen call count is now known well enough to decide, and it points at a third option that
neither of the two above considered.

`hooks/useAccountAssets.js:42-47` issues **one RPC request per asset, per chain**, via
`Promise.allSettled` over the registry. There is no batching anywhere in the read path. With 16
curated tokens on chain 1, 8 on chain 137, plus native and wrapped-native entries on each, a
portfolio spanning the five EVM mainnets is on the order of **50–70 requests per load**.

Against a 50 req/s account cap, **one portfolio load by one user is about one second of the entire
account's capacity**. Two concurrent loads saturate it and starve the bundler. That is why the
ceiling bites at current usage despite a small user base — the fan-out, not the user count, is what
consumes it.

**The cache helps less than it first appears, and it is worth being precise about why.** A shared
read cache collapses identical requests. Balances are `balanceOf(<user address>)` — unique per user,
so there is **no cross-user hit rate on the traffic that dominates the volume**. A cache genuinely
helps the same user reloading inside the TTL, and it helps truly shared reads (block number, gas
price, price feeds, pool state) — real, but the minority.

**Batching is the bigger and more certain lever.** Multicall3 is deployed at the canonical address
`0xcA11bde05977b3631167028862bE2a173976CA11` on all five EVM mainnets — verified by `eth_getCode`,
identical bytecode. Aggregating per-chain balance reads takes a portfolio load from ~50–70 requests
to **~5–10**: roughly 10×, on exactly the traffic the cache cannot touch, and it works whether reads
go direct or through a proxy.

**So the sequencing changes.** Batching (#1459) lands first. At ~5–10 requests per load, 50 req/s
supports a comfortable number of concurrent loads at current usage, and the choice between "raise the
plan" and "proxy with a cache" is made against a baseline an order of magnitude smaller — quite
possibly making both unnecessary. The cache then becomes a proportionally larger win, because once
per-user reads collapse the shared reads are no longer the minority.

> The 50–70 figure is estimated from static reading of the registry assembly, not instrumented at
> runtime. The order of magnitude is solid; the exact count is not measured, and should be before
> anything is bought.

### P3. Spec 106's tier ladder

Issuance is gated by assurance tier. Spec 106 establishes the ladder and the resolution layer.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Data-heavy screens work at full speed, for everyone (Priority: P1)

A member opens a screen reading across several chains at once — balances, holdings, positions. It
loads completely and quickly. **The same is true for a visitor who has connected no wallet.** Neither
is throttled into partial or missing data.

**Why this priority**: This is the problem keyed capacity was bought to solve. A design that leaves
the unauthenticated path on public infrastructure has not solved it.

**Independent Test**: Load the heaviest multi-chain read surface as an anonymous visitor and as a
member; confirm both complete without throttling and without missing data.

**Acceptance Scenarios**:

1. **Given** an anonymous visitor, **When** they open a multi-chain read surface, **Then** it obtains
   keyed capacity and completes without throttling — **keyed reads are not a member benefit**.
2. **Given** keyed access is unavailable, **When** a member reads, **Then** the app falls back to
   public capacity, still functions, and **discloses the degraded state** rather than silently
   rendering partial data as complete.
3. **Given** a member who has configured their own endpoint, **When** they read, **Then** their choice
   takes precedence over anything the platform issues.
4. **Given** any failure in this feature, **When** a member reads, **Then** they are never left with no
   route to the chain at all.
5. **Given** a chain the provider does not serve, **When** the app reads it, **Then** public capacity
   is the permanent and correct path, presented as normal rather than as degraded.

---

### User Story 2 - An operator rotates a credential or adds a chain without shipping a frontend (Priority: P1)

An operator rotates a keyed credential, or brings a newly supported chain online. They change
server-side configuration and it takes effect for every client already running — no frontend rebuild,
no redeploy, no version skew, and no window in which some clients hold a revoked credential.

**Why this priority**: This is the requirement that eliminates the otherwise-obvious design.

**Independent Test**: Rotate while clients are actively reading; confirm no client observes an
interruption. Separately add a chain and confirm existing clients can read it without updating.

**Acceptance Scenarios**:

1. **Given** clients actively reading, **When** an operator rotates, **Then** reads continue
   uninterrupted and no client requires a reload or a new build.
2. **Given** a rotation, **When** it completes, **Then** the superseded credential no longer grants
   access, and the window in which both are valid is bounded and deliberate.
3. **Given** a newly configured chain, **When** an already-running client requests access, **Then**
   access is granted without that client being updated.
4. **Given** a credential that expires mid-session, **When** the client next reads, **Then** it renews
   without member-visible interruption.

---

### User Story 3 - A credential is never transmitted unprotected (Priority: P1)

The system refuses to hand a client access for an endpoint whose enforcement it has not positively
verified — and refuses equally when it *cannot tell*.

**Why this priority**: This is the load-bearing invariant, and it fails silently. An endpoint with
enforcement off is identical in every log to one with it on, until the moment it matters.

**Independent Test**: Configure an endpoint with enforcement disabled, and separately make the
verification unreachable. Confirm both refuse and alert.

**Acceptance Scenarios**:

1. **Given** an endpoint whose enforcement is not verified as active, **When** a client requests
   access, **Then** access is refused and the operator is alerted.
2. **Given** enforcement that cannot be checked because the provider is unreachable, **When** access is
   requested, **Then** it is refused as *unverified*.
3. **Given** a verified endpoint, **When** access is served, **Then** the system records which endpoint
   was served, under which enforcement, and to which tier.
4. **Given** any refusal here, **When** the client receives it, **Then** the member sees a **degraded
   read**, not an error — the correct client response is to fall back to public capacity and say so.

---

### Edge Cases

- **A credential expires mid-read.** The client renews and retries transparently.
- **Issuing is unavailable.** Fall back to public capacity, disclose, never leave a member with no route.
- **A member configured their own endpoint.** Their choice wins over anything issued.
- **A credential is stolen from a browser.** Assumed possible, not prevented. Bounded by lifetime,
  confined to read operations, metered on re-acquisition, revocable by retiring its signing key.
- **A rotation is in flight.** Predecessor and successor are simultaneously valid for a bounded window.
- **The provider does not serve a chain.** Public capacity is permanent there, not a degradation.
- **A partially-applied enforcement change.** The provider's flags ride in one update and a partial
  apply is possible; the verifier must detect that state rather than average it.

---

## Requirements *(mandatory)*

Numbered to match the FR-020…FR-031 block they were split from in spec 106, so cross-references written
against those numbers remain valid.

- **FR-020**: Keyed access credentials MUST NOT be embedded in client-visible build configuration.
  Clients MUST obtain them at runtime from a platform-controlled issuing point.
- **FR-021**: Issued access MUST expire, and its lifetime MUST be configurable without a client update.
  The issuer MUST be **structurally incapable** of minting a non-expiring credential — the provider
  enforces no maximum lifetime and would accept one, so this bound has no upstream backstop.
- **FR-022**: Issuing MUST be available to every assurance tier **including anonymous**. Tier MAY
  determine lifetime and rate ceiling; it MUST NOT determine whether anything is issued at all.
- **FR-023**: Issued access MUST permit read operations only, enforced **at the provider** rather than
  by client convention. It MUST NOT be usable to broadcast a transaction or to invoke administrative
  or debugging operations.
- **FR-024**: An operator MUST be able to rotate the credential, and add or remove a chain, entirely
  through server-side configuration — no client rebuild, no member-visible interruption.
- **FR-025**: Multiple signing keys MUST be able to be valid simultaneously, so rotation proceeds by
  introducing a successor before retiring its predecessor. The key identifier MUST be present from the
  first issued credential, not added at first rotation.
- **FR-026**: The system MUST verify, **per endpoint at the moment access is served**, that the
  endpoint enforces the expiring credential and restricts operations. It MUST refuse when enforcement
  is absent **or cannot be verified**. Checking that a restriction *exists* is insufficient — a
  restriction can exist while switched off, which is exactly the failure mode.
- **FR-027**: The signing key is key material: held in the platform secret store, never falling back to
  an ambient environment value on any public network, and never appearing in any log, metric or error.
- **FR-028**: When issuing is unavailable, clients MUST fall back to public capacity, remain
  functional, and **disclose the degraded state** rather than presenting throttled or partial results
  as complete.
- **FR-029**: A member's own configured endpoint MUST continue to take precedence over any
  platform-provided access.
- **FR-030**: No unrestricted passthrough to the provider may be exposed. The issuing point hands out
  access; it MUST NOT carry traffic.
- **FR-031**: The system MUST record which endpoints were served, to which tier, and under which
  enforcement — the decision, never the credential.

### Requirements added by research

- **FR-032**: Enforcement MUST be enabled on the issuance endpoint **before** any weaker factor is
  disabled on it. Disabling the weaker factor first leaves the endpoint fully public for the duration,
  and the provider applies both in one update, so a partial apply is possible.
- **FR-033**: The verification in FR-026 handles credential material — the provider returns live
  endpoint credentials alongside the enforcement flags it is asked for. The implementation MUST extract
  only the fields it needs and discard the rest **before** anything can serialise the response.
- **FR-034**: Issuance MUST be metered against a ceiling that protects the existing consumers' share of
  the provider account, and MUST refuse rather than contend when that ceiling is reached.
- **FR-035**: The client seam MUST remain **synchronous**. Credential attachment MUST be per-request,
  not resolved during provider construction — the existing resolution seam is synchronous by deliberate
  design, is consumed during module evaluation and inside render, and is part of a frozen third-party
  contract consumed by immutable published packages.

---

## Success Criteria *(mandatory)*

- **SC-001**: No keyed access credential appears in any client build artifact, verified by scanning a
  production build for every configured provider credential.
- **SC-002**: A request for access against an endpoint whose enforcement is disabled — or cannot be
  checked — is refused, demonstrated against both a disabled fixture and an unreachable one.
- **SC-003**: A credential rotation completes with clients actively reading and produces **zero failed
  reads**, requiring no client rebuild or redeploy.
- **SC-004**: A chain added purely through server-side configuration becomes readable by a client that
  has not been updated.
- **SC-005**: An anonymous visitor obtains keyed read capacity, demonstrated by completing the heaviest
  multi-chain read surface with no wallet connected and no throttling.
- **SC-006**: Issued access cannot broadcast a transaction or invoke an administrative or debugging
  operation, demonstrated by attempting each and observing refusal **at the provider**.
- **SC-007**: With issuing unavailable, every read surface still returns data via public capacity and
  states that it is degraded; no surface renders throttled or partial results as complete.
- **SC-008**: The exposure window of a stolen credential is bounded by its configured lifetime,
  demonstrated by replaying one past expiry and observing refusal.
- **SC-009**: The issuer refuses to mint a credential with no expiry, demonstrated by configuration
  that attempts it.
- **SC-010**: Issuance load never reduces the bundler's available share below its configured floor,
  demonstrated under synthetic issuance load.

---

## Assumptions

### Verified during spec 106 research

- **Plan tier is sufficient.** Expiring-credential auth, operation restriction and the administrative
  read-back are all available on the platform's tier. Operator-confirmed.
- **A browser can send the credential.** Probed against the live endpoint: preflight answers `200` with
  the authorization header allowed, from web and from both native shell origins.
- **The provider's CORS restricts nothing.** It echoes any origin presented, including an arbitrary
  one. This is not a gap to close — it means the credential is the only real control, which is the
  design's premise.
- **Stand-alone mode exists and is the target.** The weaker URL-borne factor can be disabled entirely,
  so the endpoint address carries no credential at all. This **removes** the residual that spec 106
  originally accepted, and is why FR-032's ordering rule exists.
- **Rotation by succession is supported**, unlimited simultaneous keys.
- **Enforcement is readable per endpoint**, which is what makes FR-026 implementable rather than
  aspirational.

### Constraints research established

- **No claim binds a credential to an endpoint.** The provider verifies no issuer, audience or subject;
  scoping is purely which endpoint holds the public key. **Per-chain or per-tier scoping must be built
  from separate endpoints with separate keys** — it cannot live in the credential.
- **Two chains are not served by the provider at all.** For those, public capacity is permanent and
  correct, not a degradation to disclose.

### Accepted residual

Under stand-alone mode the endpoint address is public and only the expiring credential grants access.
A stolen credential is usable until it expires. The design **bounds** theft — lifetime, read-only
enforcement at the provider, metered re-acquisition, revocation by key retirement — and does not
prevent it. FR-026 is what keeps the address alone insufficient.

---

## Out of Scope

- Caller identity and the tier ladder — spec 106.
- Proxying read traffic through platform infrastructure. Recorded in spec 106's research as the
  rejected alternative, and it **becomes the design** if P1 is never satisfied.
- Changing which chains the product supports.
- Server-side consumers, which continue to read the credential directly from the secret store.
