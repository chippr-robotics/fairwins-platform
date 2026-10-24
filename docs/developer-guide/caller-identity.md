# Caller Identity (spec 106) and Issued RPC Access (spec 107)

The relay-gateway holds every third-party credential the platform owns. Before spec 106 it
authenticated **no caller**: the origin lock proves a request transited Cloudflare (the edge injects
that header for everyone, an attacker's `curl` included), CORS is a browser-only control, and quotas
keyed on values callers supplied about themselves. Spec 106 gives the gateway an answer to *"who is
calling?"* and keys everything on that answer. Spec 107 uses it to hand browsers keyed RPC read
capacity without ever compiling a credential into a build.

## The ladder

| Tier | Proves | Obtained from |
|---|---|---|
| `anonymous` | nothing — the request arrived | absence of any credential |
| `human` | a real browser on a real device, recently | a verified Turnstile token (`X-FairWins-Challenge`) |
| `address` | control of a specific account | a valid spec-095 grant **signature** (no membership read) |
| `member` | that, plus an **active paid membership** | the same grant, plus a successful tier read |
| `app` | this exact signed application binary | device attestation — **not built**; the verifier seam always abstains |

Rules that are the point, not decoration:

- **A web app cannot prove its identity to a server.** Anything the SPA sends, a member can read out
  of the bundle and replay. `app` is reachable only via hardware-rooted native attestation (#1449,
  deferred); no surface may claim it on the web (FR-005), and `isProofOfApp()` is the one place that
  answer lives.
- **`address` exists because `member` means "has paid".** The spec-095 verifier refuses without an
  active paid tier — gating trading on it would stop unpaid members from trading. Routes that sign
  or broadcast need an *answerable party*, not a customer; **no route demands `member`**, and a test
  pins that.
- **A challenge buys throughput, never entry.** Every read sits at the `anonymous` minimum; tier
  decides *how much* (rate ceilings), never *whether*. A challenge outage therefore costs a visitor
  their tier upgrade — never their reads (FR-017) — and every client-side failure mode is silent.
- **`rejected` and `unverifiable` never share a value.** An unreachable dependency is a retryable
  503 (`auth_unverifiable`), not a denial — a boolean would collapse "our RPC was slow" into "your
  signature is forged". The one deliberate inversion is issuance-endpoint enforcement (below).

## Where things live

```
services/relay-gateway/src/identity/
  tiers.js            the ladder; ordinals never serialised
  resolve.js          runs verifiers; ACCEPTANCE SETTLES IT even if another verifier timed out
  routeTable.js       THE one table: every mounted route's minimum tier (CI-enforced completeness)
  middleware.js       resolves per request; enforcement behind its own switch; sets X-FairWins-Tier
  quotaKey.js         metering keys the caller cannot rotate
  upstreamCeiling.js  per-upstream budgets, charged BEFORE the outbound call, wrapping the client
  verifiers/          challenge.js · grant.js · attestation.js (the seam)
services/relay-gateway/src/access/    spec 107: jwt.js · enforcement.js · routes.js
frontend/src/lib/identity/challenge.js   Turnstile client: off-screen, silent degradation
frontend/src/lib/network/issuedAccess.js  issued RPC access: module memory, per-request injection
```

## Switches (all reloadable via SIGHUP — see below)

| Env | Effect |
|---|---|
| `IDENTITY_ENABLED` | resolve and report (`X-FairWins-Tier`); **no status changes** |
| `IDENTITY_ENFORCE` | refuse a route whose declared minimum is unmet |
| `IDENTITY_KILLSWITCH` | back to inert, without touching the global kill switch |
| `CHALLENGE_SECRET` | Turnstile siteverify secret. Unset ⇒ the verifier **abstains**. Published test secrets are **boot-fatal in production** |
| `UPSTREAM_CEILING_<ID>` | per-upstream calls/window, unset = unlimited (an absent cap, stated) |
| `RPC_ACCESS_*` | spec 107 issuance — see the switch-on runbook on #1438 |

Deploy sequence is deliberately two-step: run `IDENTITY_ENABLED` alone first and watch the tier
header on real traffic; turn `IDENTITY_ENFORCE` on once the model is validated. A safety layer that
starts refusing the moment it deploys fails in the shape "the product is broken".

## Operability

- **`SIGHUP` reloads; `SIGUSR2` stays the kill switch.** SIGHUP re-reads the **allowlisted
  operational switches** from `RELOAD_ENV_FILE` (the mounted env file — process env is frozen at
  exec). Fund-path config (keys, engine URLs, endpoints) deliberately does **not** reload: a key
  swappable by editing a file and signalling is a key swapped silently by anyone who can write that
  file. Absent keys mean "leave alone", never "reset to default". In-flight requests finish under
  what they read.
- **`/status` is origin-lock EXEMPT, and has THREE tiers — not two.**
  1. *Public* (no headers): status, build, per-chain `rpc`, killSwitch, fees. The Google uptime
     check reads this tier and matches on `"rpc":"up"`, so nothing here may move.
  2. *Edge* (`X-Origin-Auth`): the identity/access blocks and `gasWalletRunwayHrs`. **This is not an
     authorization tier.** Cloudflare's zone-wide Transform Rule injects that header on every
     request, so it means "did not arrive on the raw origin IP" and nothing more — measured in
     production on 2026-09-06, when these blocks were readable by anyone curling the public
     hostname (#1505). The on-VM probe reads this tier for the runway numbers.
  3. *Operator* (`X-FairWins-Ops`, `OPS_STATUS_SECRET`): `callerIdentity.enforcing` only. It is the
     single most useful fact an abuser can learn about the gateway — observe mode says the door is
     open. Unset secret ⇒ the field is absent for everyone; there is deliberately no fallback to
     public, because "nobody sees it" is recoverable and "everybody sees it" is not.

  **FR-015 is satisfied at BOOT, not by the HTTP body.** The gateway prints its identity mode on
  listen and again after every SIGHUP reload (`src/identity/mode.js#describeIdentityMode`, one
  function so the two can never disagree). That is the disclosure that is always available to the
  audience FR-015 was written for — an operator reading the journal. Attestation still reports
  `"not-built"` — not `false`, which would imply a switch exists.

## Issued RPC access (spec 107), briefly

`POST /v1/access/rpc` mints a short-lived **read-only** JWT for a dedicated provider endpoint; the
client then reads **directly** from the provider (the gateway never proxies read traffic, FR-030).
Anonymous callers mint too — keyed reads are not a member benefit; tier buys *lifetime*. Client-side,
resolution precedence is **member override → issued → build default**, the credential lives in module
memory only, and it reaches the wire per request via a `FetchRequest` preflight — so rotation never
rebuilds a provider and the failover leg never sees it.

Two hard rules on the gateway side:

- **The mint refuses structurally** — no kid, no expiry, past the cap — because the provider enforces
  no maximum lifetime, so the cap has no upstream backstop.
- **Enforcement is verified per endpoint at serve time** (`GET /v0/endpoints/{id}/security`): `jwts`
  on, the method whitelist **switched on** (a filter can exist while disabled — the silent failure
  mode), every method read-only. `unverifiable` **refuses**, identically to absent — the one place
  "could not tell" means "no", because failing open transmits a credential that may be sufficient by
  itself. Every refusal maps client-side to "fall back to public capacity, disclosed" — never an
  error surface.

## Gates that protect all of this in CI

- `test/identity/routeTable.test.js` — enumerates the **real Express app**; an undeclared mounted
  route fails by name (silence is not permission).
- `frontend/src/test/nginxCspScriptSrc.test.js` — script-src is a **pinned allowlist** with written
  reasons; adding or removing a source fails in both directions.
- `scripts/secrets/check-env-hygiene.js` — a credential-shaped value in any `VITE_RPC_URL*` /
  `VITE_BUNDLER_URLS*` variable **fails** (not a note): keyed capacity is issued at runtime so
  nothing keyed is ever a build-time constant.
- `vite.config.js` guards — production builds refuse the Pinata JWT and the published Turnstile
  test sitekeys (a mock in a shipped path).

Related: `docs/runbooks/credential-rotation.md` (the three new rows), the switch-on runbook on
[#1438](https://github.com/chippr-robotics/fairwins-platform/issues/1438),
`specs/106-gateway-caller-auth/` and `specs/107-keyed-rpc-access/`.
