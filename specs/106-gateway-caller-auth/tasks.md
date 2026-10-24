# Tasks: Gateway Caller Authentication and Abuse Prevention

**Input**: `specs/106-gateway-caller-auth/` — plan.md, spec.md, research.md, data-model.md, contracts/

**Tracking**: parent #1443, with sub-issues #1444 (slice 2), #1445 (slice 4b), #1446 (slice 5a),
#1447 (slice 5b), #1448 (slice 5c), #1449 (attestation, deferred). Spec 107 is tracked on #1438.

**Organization**: five slices, each independently reviewable, testable and shippable. Slice 1 changes
no observable behaviour on purpose: identity resolves and nothing enforces, so the risky part
(enforcement) lands only once resolution is proven.

**Tests**: required. Every slice is test-first, and the negative fixtures are the point — a test that
can only pass is not evidence (constitution II, spec 094's assertion-debt rule).

---

## Slice 1 — Resolution (no enforcement)

**Goal**: every request resolves to a `CallerIdentity`. Nothing refuses. `X-FairWins-Tier` is
observable, so the tier model can be validated in production before anything depends on it.

**Independent test**: hit every client route with and without credentials; assert the header reports the
expected tier and that **no response status changes** versus the previous build.

- [x] **T001** `src/identity/tiers.js` — the ladder, `atLeast()`, and `TIER_ORDER`. Pure, no I/O.
      Ordinals never serialised. Include `address` between `human` and `member` (data-model §1).
- [x] **T002** [P] `test/identity/tiers.test.js` — ordering, comparison, and that `app` is unreachable
      from any web credential.
- [x] **T003** `src/identity/verifiers/attestation.js` — registration seam only. **Always returns
      `absent`.** Exists so FR-004's extension point is real rather than promised.
- [x] **T004** `src/identity/resolve.js` — run every configured verifier, take the highest accepted
      tier. Precedence: any acceptance ⇒ `verified`; else any `unverifiable` ⇒ `unverifiable` at
      `anonymous`; else `verified` at `anonymous`.
- [x] **T005** [P] `test/identity/resolve.test.js` — **the load-bearing test.** A valid grant plus an
      unreachable challenge service must resolve `verified`, not `unverifiable`. A verifier that throws
      must not take down resolution. An unconfigured verifier returns `absent`, never `rejected`.
- [x] **T006** `src/identity/routeTable.js` — `ProtectedRoute` declarations for **every** client route.
      Deny-by-default: a route absent from the table is a configuration error, not a public route.
- [x] **T007** [P] `test/identity/routeTable.test.js` — assert every route the gateway actually mounts
      appears in the table (enumerate from the app), and that reads are `anonymous`.
- [x] **T008** `src/identity/middleware.js` — attach `req.caller`; set `X-FairWins-Tier`. Mounted
      **after** the origin lock and **before** route dispatch. Never sees `OPTIONS`.
- [x] **T009** `src/config/index.js` — `IDENTITY_*` config, boot-time validation, loud disclosure when
      disabled.
- [x] **T010** `src/server.js` — mount the middleware; add `capacitor://localhost` and
      `https://localhost` to `ALLOWED_ORIGINS` **defaults** (research §1.6 — without this the native
      shells cannot send a credential at all).
- [x] **T011** [P] `test/identity/middleware.test.js` — ordering: preflight short-circuits before
      resolution; a request to an unmounted path still resolves.

**Checkpoint**: resolution proven, nothing enforced.

---

## Slice 2 — Proof of human

**Goal**: a challenge buys throughput. It never buys access.

- [ ] **T012** `src/identity/verifiers/challenge.js` — siteverify via one `fetch`. **No new npm
      dependency.** Unreachable ⇒ `unverifiable`; unconfigured ⇒ `absent`; invalid ⇒ `rejected`.
- [ ] **T013** [P] `test/identity/challenge.test.js` — all four outcomes, plus: a token is reusable for
      its TTL (SC-003, at most one challenge per visitor per lifetime).
- [ ] **T014** Build gate refusing the vendor's always-pass/always-fail **test keys** outside
      development. Constitution III — those keys are a mock in a shipped path.
- [ ] **T015** CSP: add `https://challenges.cloudflare.com` to `script-src` and `frame-src` in
      `frontend/nginx.conf` **and** `nginx.conf.template`. The two are **not twins** (118 vs 175 lines);
      only the CSP line is byte-identical.
- [ ] **T016** Verify the derived native CSP and its parity gate still pass; update if the derivation
      needs the new host.
- [ ] **T017** [P] Extend `src/test/nginxCspScriptSrc.test.js` to **PIN** the host as an allowlisted
      exception carrying its reason (FR-018). This gate does not exist today — research §2.6 confirmed
      adding a named host breaks no current assertion, which is exactly why the pin is needed.
- [ ] **T018** `frontend/src/lib/identity/challenge.js` — widget lifecycle, token cache, and **silent**
      degradation: an unreachable challenge service is never rendered as suspicion (FR-017).
- [ ] **T019** [P] Frontend tests + `cy.a11yScan` on the challenge surface (constitution V).

---

## Slice 3 — Proof of address

**Goal**: reuse the member verifier by **extracting** it, and add the `address` rung so trading does not
silently require a purchase.

- [x] **T020** `src/memberApi/auth.js` — extract the signature-verification core into a reusable export.
      Add a mode that stops **before** the membership read. Do not change the existing
      `authenticate(req, scope)` contract — spec 095 and the MCP server both consume it.
- [x] **T021** [P] `test/identity/grant.test.js` (extraction group) — the extracted path returns identical
      verdicts to the original on the existing fixtures. **This is a refactor-safety test and must be
      written first.**
- [x] **T022** `src/identity/verifiers/grant.js` — map verdicts to tiers: valid signature ⇒ `address`;
      plus active membership ⇒ `member`; unreachable ⇒ `unverifiable`.
- [x] **T023** [P] `test/identity/grant.test.js` — an account with a valid grant and **no paid
      membership** resolves `address` and is **not refused** (the regression this rung exists to
      prevent).

---

## Slice 4 — Enforcement and metering

**Goal**: routes demand their minimum; quotas stop keying on values callers supply.

- [x] **T024** Enforcement in `middleware.js` — refusal contract per `contracts/gateway-api.md`:
      403 with a `required` field; **503 for `unverifiable`, never a denial**.
- [x] **T025** [P] `test/identity/enforcement.test.js` — each refusal code; and the inverse: a read
      route still serves at `anonymous` with the challenge service down.
- [x] **T026** `src/policy/quotas.js` — tier-scoped windows keyed on `CallerIdentity.subject`. Tiers
      never share a window (FR-012).
- [x] **T027** Re-key every call site in `{opensea,polymarket,perps,bitcoin}/routes.js` off the
      caller-asserted address. ~28 sites; **a missed one is a hole in the feature**.
- [x] **T028** [P] `test/identity/quotaKeying.test.js` — 40 requests each naming a **different** address
      must hit one ceiling (SC-004).
- [x] **T029** Per-upstream ceilings checked **before** the upstream call (FR-013). A cap enforced on the
      response bounds nothing.
- [x] **T030** [P] `test/identity/upstreamCeiling.test.js` — assert the upstream client is **not
      invoked** past the ceiling, not merely that the response is 429.

---

## Slice 5 — Operability

- [ ] **T031** `src/policy/killswitch.js` — extend the signal handler to re-read module config (FR-014).
      In-flight requests complete under the config they started with.
- [ ] **T032** [P] `test/identity/reload.test.js` — config change takes effect; in-flight undisturbed.
- [ ] **T033** `src/metrics/` — scrape surface, per upstream and per tier. **Bounded labels only** —
      never an address, wager id or tx hash (FR-036).
- [ ] **T034** `services/finops-exporter/src/collectors/gateway.js` — persists what it scrapes; reports
      **`unreadable`, never zero**, on scrape failure (FR-033 as amended).
- [ ] **T035** `packages/finops-catalogue/src/sources.js` — declare the source. **Without this the C2
      gate fails**, which is the intended behaviour.
- [ ] **T036** `/status` additions **inside the gated portion only** — research §2.7: `/status` is
      origin-lock exempt, so the public body is world-readable on the raw origin URL.
- [ ] **T037** [P] `test/identity/statusDisclosure.test.js` — `enforcing: false` is present and explicit
      when disabled (FR-015); the public body is unchanged.
- [ ] **T038** `check-env-hygiene.js` — make a credential-shaped RPC substitution **fail** rather than
      note (constitution IV; plan's recorded gap).
- [ ] **T039** Docs: `docs/developer-guide/caller-identity.md`, rotation runbook entries (FR-032),
      and the `.env.example` correction's spec-106 pointer.

---

## Dependencies

```
Slice 1 ──┬── Slice 2 (challenge)
          ├── Slice 3 (grant)      ──┐
          └───────────────────────────┴── Slice 4 (enforcement) ── Slice 5 (operability)
```

Slices 2 and 3 are independent of each other and can proceed in parallel once Slice 1 lands. Slice 4
requires both — enforcing before both verifiers exist would refuse callers who have a valid credential
the gateway cannot yet read.

## Parallel guidance

`[P]` marks tasks touching files no other in-flight task touches. Test tasks are almost all `[P]`
because each lives in its own file. **T027 is deliberately not `[P]`** — it edits four route files that
other tasks also touch, and correctness there depends on seeing all of them together.
