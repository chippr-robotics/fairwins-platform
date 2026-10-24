# Implementation Plan: Gateway Caller Authentication and Abuse Prevention

**Branch**: `spec/106-gateway-caller-auth` | **Date**: 2026-09-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/106-gateway-caller-auth/spec.md`

## Summary

Give the relay-gateway an answer to *"who is calling?"*, then key metering on that answer instead of on
values a caller supplies about itself.

Today the gateway holds every third-party credential the platform owns and authenticates no caller. The
origin lock proves a request transited Cloudflare — a header injected zone-wide, for an attacker's
request exactly as for ours. CORS is a browser-only control. Quotas key on IP or on an address the
caller writes into the request path.

This ships a **credential-verifier registry** resolving each request to an assurance tier
(`anonymous` / `human` / `address` / `member`), a **route table** declaring each route's minimum, and
**tier-scoped metering** keyed on non-rotatable subjects. Reads stay open to everyone and a challenge
buys throughput rather than access; routes that sign or broadcast require a proven, answerable account.

Keyed data access split to **spec 107** — its mechanism cannot be hosted on any endpoint the platform
currently owns without locking out the gasless bundler.

## Technical Context

**Language/Version**: Node.js ESM (relay-gateway, `services/mcp-server` untouched); React 19 + Vite 8
(frontend). No Solidity.

**Primary Dependencies**: Express (gateway); `@fairwins/intent-types/offchain` for the existing grant
struct; Cloudflare Turnstile (new, client widget + server verification); `axe-core` via the existing
Cypress runner. **No new npm dependency in the gateway** — the challenge verification is one `fetch`.

**Storage**: None persistent. Identity is request-scoped; counters are in-process. The deployed Redis is
engine-owned and runs non-persistently, so it is **not** a shared counter store and the spec's
Dependencies line claiming one was wrong.

**Testing**: Vitest (gateway + frontend), Cypress (E2E, both viewport profiles), `nginx -t` for edge
config. Local frontend runs are **scoped to named files** — the full suite OOMs this environment.

**Target Platform**: Linux containers on GCE behind Cloudflare; the SPA additionally ships as Capacitor
iOS/Android shells.

**Project Type**: Web — gateway service + frontend SPA + edge configuration.

**Performance Goals**: Identity resolution adds no upstream round trip on the common path (challenge
tokens verify once and are reused for their lifetime; grant verification is already on the member path).

**Constraints**: The frontend RPC seam is **synchronous and must stay so**. Mini-app packages are
keccak-committed clients, so no *newly required* request header. Native shell origins are not currently
allowlisted at the gateway.

**Scale/Scope**: ~20 gateway routes across five modules; ~28 quota call sites audited; 4 CSP documents
in the estate (two nginx, one derived native, one Helmet).

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design. Re-evaluation at the end.*

### I. Security-First Smart Contracts — NOT ENGAGED, and worth stating

No Solidity changes. No proxy upgrade, no storage layout movement, no new Slither or Medusa input. The
principle's procedural gates do not apply.

Its **posture** does. This is adversarial-by-default code guarding platform funds, platform commercial
standing and a credential surface. The absence of a contract change is not an argument for a lighter
review, so this plan requires a security review of the same depth: credential lifetime and revocation,
replay, the fail-open vs fail-closed decision at each dependency, and whether any control can be
bypassed by reordering or omitting a header.

### II. Test-First and Comprehensive Coverage — ENGAGED, binding

Every requirement here is behaviour, so every one is testable before it is built.

- **Negative fixtures are the point.** SC-009 (a sibling upstream operation is refused *before* the
  upstream is reached) and SC-012 (no credential material in any emitted output) need fixtures that
  must FAIL before the code exists. A test that can only pass is not evidence — and the repo already
  tracks that failure mode as assertion debt under spec 094.
- **Local runs are scoped**; CI runs the suite. Any task claiming "tests pass" states which scope ran.

### III. Honest State — ENGAGED, dominant

More requirements serve III than any other principle: FR-005, FR-009, FR-015, FR-017, FR-034.

**Three III hazards this design introduces, each with a mitigation that is itself a task:**

1. **Challenge test keys are a mock in a shipped path.** The vendor publishes always-pass and
   always-fail key pairs. Legitimate in development, a placeholder in production. The build must make
   shipping one impossible — a gate, not a convention.
2. **A disabled control looks exactly like an enforcing one.** Every control here is disableable
   (FR-014), which is right for operations and dangerous for honesty. FR-015 requires the state be
   self-disclosed loudly at boot and visible in the gated `/status`.
3. **A tier is a claim about evidence, not about an app.** FR-005 binds every message, log field and
   metric label. `X-FairWins-Tier` is diagnostic and deliberately names no application.

### IV. Fail Loudly in CI — ENGAGED

FR-018 (the CSP exception is pinned, so a future widening breaks the build) and FR-019 (policy parity)
are themselves gates and must fail rather than warn.

**A live gap this feature closes rather than inherits:** `check-env-hygiene.js` emits a non-failing
NOTE for credential-shaped `VITE_` values. That was right when every such value was public-safe. It is
not right for an RPC substitution once spec 107 establishes those must never be build-time constants —
and it is cheap to make that one case fail now.

### V. Accessible, Consistent Frontend — ENGAGED

An interactive challenge is a new interactive surface: operable and announced without sight of the
widget, WCAG 2.1 AA, covered by `cy.a11yScan`. Degraded-state disclosures (FR-028's sibling in 106, and
this feature's refusal messaging) are perceivable text, never colour or position alone.

### Additional Constraints — new technology

| New technology | Why it earns its place | Rejected alternative |
|---|---|---|
| Cloudflare Turnstile | The only mechanism raising the cost of anonymous automation **without requiring an account**, which is what preserves logged-out browsing. It is the edge provider already in the estate, so it adds no vendor relationship and one CSP host. | Member grants for reads — deletes the discovery funnel. IP/ASN limits alone — trivially rotated, and they punish shared egress. |

### No-backend footprint

No application backend is added. This extends the relay-gateway, the documented bounded exception:
stateless with respect to member business data, holding no member funds or authority, optional,
degrading to self-submit. FR-010 and SC-007 make the last property testable. **No read traffic moves
onto platform infrastructure.**

### Gate result: PASS, with two amendments recorded in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/106-gateway-caller-auth/
├── plan.md              # this file
├── spec.md              # rescoped after research
├── research.md          # Phase 0 — 11-agent sweep + adversarial critic
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── gateway-api.md   # Phase 1
└── checklists/requirements.md
```

### Source Code (repository root)

```text
services/relay-gateway/
├── src/
│   ├── identity/                 # NEW — the whole caller-identity layer
│   │   ├── tiers.js              #   the ladder + comparison; no I/O
│   │   ├── resolve.js            #   runs verifiers, resolves CallerIdentity
│   │   ├── routeTable.js         #   ProtectedRoute declarations (the ONE table)
│   │   ├── middleware.js         #   express glue; attaches req.caller
│   │   └── verifiers/
│   │       ├── challenge.js      #   Turnstile siteverify
│   │       ├── grant.js          #   wraps the EXTRACTED member verifier
│   │       └── attestation.js    #   registration seam only — returns 'absent'
│   ├── memberApi/auth.js         # MODIFIED — extract a reusable verify, add address-only mode
│   ├── policy/
│   │   ├── killswitch.js         # MODIFIED — signal-driven config reload (FR-014)
│   │   └── quotas.js             # MODIFIED — tier-scoped, subject-keyed
│   ├── metrics/                  # NEW — scrape surface for FR-033
│   ├── {opensea,polymarket,perps,bitcoin}/routes.js   # MODIFIED — stop keying on caller-asserted address
│   └── server.js                 # MODIFIED — mount identity; widen ALLOWED_ORIGINS
└── test/identity/                # NEW

services/finops-exporter/src/collectors/gateway.js     # NEW — persists what it scrapes
packages/finops-catalogue/src/sources.js               # MODIFIED — declare the new source

frontend/
├── nginx.conf, nginx.conf.template                    # MODIFIED — one CSP host
├── scripts/native/nativeCsp.js                        # derived; parity-gated
└── src/
    ├── lib/identity/challenge.js                      # NEW — widget lifecycle + token cache
    ├── lib/relay/gatewayClient.js                     # MODIFIED — attach credentials
    └── test/{brand,nginxCsp*}                          # MODIFIED — pin the exception
```

**Structure Decision**: The identity layer is a new sibling module under `services/relay-gateway/src/`,
following the established module anatomy (router factory, injected config/quota/killswitch, optional but
unconditionally mounted). It is *not* folded into `memberApi/`, because that module's route table feeds
the public OpenAPI document and the pay-per-request pricing table, and neither should grow to describe
every route in the gateway.

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| **A second route table**, separate from `memberApi/contract.js` `ROUTES` | The data model requires one table covering **every** route with deny-by-default. `ROUTES` covers only the nine member routes and feeds the public API document and pricing. | Extending `ROUTES` would publish every internal route in the public OpenAPI document and entangle assurance with pricing. |
| **Extracting the member verifier** rather than calling it | FR-003 says reuse. There is nothing callable: `createMemberAuth` is invoked once inline and returns `authenticate(req, scope)`, not middleware; `guard()` is module-private. | Duplicating verification would create a second signature path — precisely the drift this repo's type-parity gates exist to prevent. |
| **A new tier (`address`) the spec did not name** | The existing verifier refuses without an **active paid membership**. Gating trading, broadcast and listing on it would stop unpaid members from trading — a regression the spec never intended. | Using `member` as written fails the product. Loosening the member verifier itself would change spec 095's contract for its own consumers. |
| **CSP `script-src` gains a named host** | Turnstile cannot function otherwise. | No alternative provides proof-of-human without an account. The scheme-wide prohibition the rule targets stays intact; this is one named host, pinned by a new gate. |

### Amendments to the spec recorded during planning

1. **FR-014** was "disableable without a redeploy" with no mechanism. There is **no operator write
   channel to the gateway**, and adding one is a larger security surface than the problem justifies.
   Amended to a signal-driven configuration reload, described honestly as a reload rather than a remote
   control.
2. **FR-033** was "observable per upstream and per tier". The cost catalogue **explicitly refuses**
   gateway-held counters, because they reset on restart and an undercount that looks like a number is
   worse than an honest absence. Amended to require export plus a collector that persists what it
   scrapes and reports *unreadable* on scrape failure.

## Phase 0 — Research

Complete: [research.md](./research.md). Eleven agents plus an adversarial completeness critic. Four
structural blind spots found, three of which invalidated assumptions in the first-draft artifacts. One
dependency was settled empirically rather than from documentation.

## Phase 1 — Design

Complete: [data-model.md](./data-model.md), [contracts/gateway-api.md](./contracts/gateway-api.md),
[quickstart.md](./quickstart.md).

## Constitution re-check after design

**PASS.** The design adds no contract surface, no backend, no persistent member state, and no new npm
dependency in the gateway. The two amendments above are recorded rather than silently absorbed. The one
new client technology is justified in the table above, and its CSP cost is a single named host pinned by
a gate that did not previously exist — which leaves the estate's script-src invariant strictly better
enforced after this feature than before it.
