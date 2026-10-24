# Contract: Caller Identity and Keyed Access

**Feature**: `specs/106-gateway-caller-auth` | **Phase**: 1 | **Date**: 2026-09-04

Interface contract for what this feature adds to the relay-gateway. Error envelopes follow the
existing shape (`{ error: { code, reason } }`) and new codes extend the existing vocabulary
(`origin_denied`, `rate_limited`, `quota_exceeded`, `insufficient_scope`, `upstream_unavailable`, …)
rather than inventing a second convention.

---

## Part 1 — Caller identity applies to every client-facing route

Not a route. A resolution step that runs before route handlers and attaches a `CallerIdentity`.

### Ordering, and why it is load-bearing

```
CORS / preflight ─► body parse ─► origin lock ─► CALLER IDENTITY ─► route + quota ─► handler
```

Three ordering facts that a naive implementation gets wrong:

- **After the origin lock, not before.** The lock is cheap and rejects non-edge traffic; identity
  resolution may make a network call. Resolving first would let an off-edge caller cost us an upstream
  round trip per request.
- **Before route dispatch, not inside handlers.** Identity must be resolvable for a route that does not
  exist, so an unauthenticated probe cannot enumerate routes by their differing error shapes.
- **Preflight never carries credentials.** `OPTIONS` short-circuits at CORS, exactly as today.
  Resolution must never see one, or every preflight resolves `anonymous` and pollutes metering.

### Resolution

Every configured verifier runs. The result is the **highest accepted tier**. Precedence for
`verificationState` when verifiers disagree:

1. Any verifier `accepted` → `verified` at the highest accepted tier. A single success settles it —
   another verifier's timeout is then irrelevant.
2. No acceptance, any `unverifiable` → `verified: unverifiable`, tier `anonymous`.
3. Otherwise → `verified` at `anonymous`.

**Rule 1 before rule 2 is deliberate.** A member holding a valid grant must not be downgraded because
an unrelated challenge service timed out.

### Refusal contract

| Situation | Status | Code | Retryable |
|---|---|---|---|
| Tier below the route's minimum, `member` required | **403** | `member_grant_required` | no |
| Tier below the route's minimum, `human` required | **403** | `challenge_required` | no |
| A credential was presented and is invalid | **403** | `credential_rejected` | no |
| A credential was presented, verification unreachable | **503** | `auth_unverifiable` | **yes** |
| Membership source unreachable | **503** | `membership_unreadable` | **yes** |
| Per-subject or per-tier quota exhausted | **429** | `quota_exceeded` | yes, after window |
| Upstream ceiling reached before the call | **429** | `upstream_ceiling_reached` | yes |
| Identity layer disabled by configuration | — | — | request proceeds; state disclosed at `/status` |

`auth_unverifiable` and `membership_unreadable` are **already established** by spec 095 as retryable
503s. This feature reuses them verbatim rather than minting synonyms — a second code for the same
condition is how one of them ends up handled as a denial.

Every 403 body names what is required and how to obtain it (FR-008):

```json
{ "error": {
    "code": "member_grant_required",
    "reason": "This action signs with a platform credential and requires a member session. Authorise one in Settings ▸ API access.",
    "required": { "tier": "member" } } }
```

`required` is additive and safe for an older client to ignore.

### Response headers

`X-FairWins-Tier: anonymous|human|member` on every client-facing response.

Diagnostic only — **never** an input to authorisation, and it deliberately does not name an
application, because the web cannot prove one (FR-005).

---

## Part 2 — Keyed-access issuance moved to spec 107

`POST /v1/access/rpc` and its refusal contract moved with the requirements. Nothing in this feature
mints a credential.

## Part 3 — `GET /status` additions

**`/status` is origin-lock EXEMPT** (`server.js:240`); only the per-chain object inside it is gated
(`:358-361`). An earlier draft of this contract asserted the opposite, and the difference matters:
anything added to the public body is world-readable on the raw origin URL, without transiting the
edge at all.

So the additions below go **inside the gated portion**, beside the existing operator telemetry — not
into the public body. What a public caller sees is unchanged.

```json
{ "callerIdentity": {
    "verifiers": { "challenge": "configured", "grant": "configured", "attestation": "not-built" },
    "enforcing": true },
  "upstreams": {
    "state": "read",
    "items": [ { "id": "opensea", "ceiling": "…", "consumedPct": 12,
                 "byTier": { "anonymous": 4, "human": 7, "address": 1 } } ] } }
```

Three honesty rules bind this payload:

- **`enforcing: false` must be visible.** A gateway running with identity checks disabled looks
  identical to one enforcing them; FR-015 requires it to say so, here and loudly at boot.
- **`state` is `read` / `not-configured` / `unreadable`**, and `items` exists only under `read`. An
  unreadable scrape never renders as an empty list — absence of data is not data, and an empty list
  would read as "no upstreams are being consumed".
- **`attestation: "not-built"` is deliberate wording.** Not `false`, not `disabled` — the tier does not
  exist yet, and saying "disabled" would imply it could be turned on.

Tier keys in `byTier` come from the fixed ladder, never from request content — the label set is
bounded by construction (FR-036).

---

## Part 4 — What this contract deliberately does not add

- **No RPC passthrough.** No route accepts an arbitrary JSON-RPC body and forwards it. FR-030 — such a
  route would be a general-purpose proxy over a platform credential, which is the thing being
  prevented. The issuance route hands out access; it never carries traffic.
- **No operator write route.** FR-014's reload is driven by a signal, deliberately, so this feature
  does not open an authenticated write channel into the gateway.
- **No tier in a request body.** A caller never asks for a tier; a tier is only ever concluded from
  evidence.
- **No pricing.** x402 is a separate rail on separate routes and is untouched here.
