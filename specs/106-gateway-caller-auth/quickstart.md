# Quickstart: Caller Identity

**Feature**: `specs/106-gateway-caller-auth` | **Phase**: 1

How to run, exercise and verify this feature locally.

---

## Configuration

Every control is optional and **mounts unconditionally**, so the answer is always honest. Unset means
disabled and *says so* at boot and in the gated `/status` — it never silently looks like enforcement.

| Variable | Default | Effect |
|---|---|---|
| `IDENTITY_ENABLED` | `false` | master switch for the layer |
| `IDENTITY_KILLSWITCH` | `false` | resolve every caller as `anonymous`, keep serving |
| `CHALLENGE_SECRET` | unset | Turnstile secret. **Unset ⇒ the challenge verifier returns `absent`, never `rejected`** |
| `CHALLENGE_VERIFY_URL` | vendor default | override for tests |
| `CHALLENGE_TTL_SEC` | `900` | how long one verified challenge is reusable |
| `QUOTA_<TIER>_PER_MIN` | see config | per-tier ceilings; tiers never share a window |
| `UPSTREAM_CEILING_<ID>` | unset | per-upstream cap, checked **before** the upstream call |
| `ALLOWED_ORIGINS` | `https://fairwins.app` | **must gain `capacitor://localhost` and `https://localhost`** or the native shells cannot send a credential at all |

`VITE_CHALLENGE_SITEKEY` is the client half. It is public by design — a sitekey is not a secret, and the
secret never leaves the gateway.

---

## Running it

```bash
# Gateway, identity on, challenge NOT configured (the common local case)
IDENTITY_ENABLED=true npm run -w services/relay-gateway dev

# With a challenge configured. Use the vendor's ALWAYS-PASS test pair for local work.
IDENTITY_ENABLED=true CHALLENGE_SECRET=<test-secret> npm run -w services/relay-gateway dev
```

> **The vendor's test key pairs always pass or always fail.** They are correct locally and are a
> placeholder in production — a mock in a shipped path, which the constitution forbids. A build gate
> refuses them outside development; do not work around it.

---

## Exercising each tier

```bash
G=http://localhost:8787

# anonymous — a read still works, at the low ceiling
curl -s "$G/v1/perps/pairs" | head -c 200

# what did the gateway conclude about me?
curl -sD - -o /dev/null "$G/v1/perps/pairs" | grep -i x-fairwins-tier

# human — a verified challenge buys throughput, never access
curl -s "$G/v1/perps/pairs" -H 'X-FairWins-Challenge: <token>'

# address / member — the existing member token
curl -s "$G/v1/member/me" -H "Authorization: Bearer fw1.<grant>.<sig>"
```

---

## Verifying the behaviour that actually matters

Each of these is a requirement that fails silently if it regresses.

```bash
# 1. A challenge OUTAGE must cost throughput, never access  (FR-017)
CHALLENGE_VERIFY_URL=http://127.0.0.1:1/dead IDENTITY_ENABLED=true CHALLENGE_SECRET=x \
  npm run -w services/relay-gateway dev &
curl -s -o /dev/null -w '%{http_code}\n' "$G/v1/perps/pairs"      # expect 200, NOT 403

# 2. unverifiable is RETRYABLE, never a denial  (FR-009)
#    Present a grant while the membership source is unreachable.
#    expect 503 membership_unreadable — never 401/403.

# 3. Quotas cannot be evaded by changing request content  (FR-011, SC-004)
for i in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code} ' \
    "$G/v1/opensea/137/account/0x$(printf '%040x' $i)/nfts"
done; echo
# Every request names a DIFFERENT address. Before this feature that reset the quota each time.
# expect the ceiling to bind regardless.

# 4. A disabled layer must SAY it is disabled  (FR-015)
IDENTITY_ENABLED=false npm run -w services/relay-gateway dev
curl -s "$G/status" -H "X-Origin-Auth: $ORIGIN_AUTH_SECRET" | jq .callerIdentity.enforcing
# expect false, explicitly — not a missing key

# 5. Config reload without redeploy  (FR-014, SC-006)
kill -USR2 $(pgrep -f relay-gateway)
# expect the new config in effect, in-flight requests undisturbed
```

---

## Tests

```bash
# Gateway
npm run -w services/relay-gateway test -- identity

# Frontend — SCOPED. The full suite OOMs this environment; CI runs it whole.
npx vitest run src/test/nginxCspScriptSrc.test.js src/test/nginxCspConnectSrc.test.js
npx vitest run src/test/identity/

# Edge config parses
envsubst < frontend/nginx.conf.template > /tmp/site.conf && nginx -t -c /tmp/nginx.conf
```

---

## Things that will bite you

- **`X-Origin-Auth` is not authentication.** Cloudflare injects it for everyone. If you find yourself
  reasoning "it came through the edge, so it's our app" — that is the bug this feature exists to fix.
- **`/status` is origin-lock EXEMPT.** Only the per-chain object inside it is gated. Anything you add to
  the public body is world-readable on the raw origin URL.
- **Preflight carries no credentials.** `OPTIONS` short-circuits at CORS before identity resolution. If
  resolution ever sees one, every preflight resolves `anonymous` and pollutes metering.
- **Native shells cannot reach the gateway until `ALLOWED_ORIGINS` grows.** They are not on
  `https://fairwins.app`; they are `capacitor://localhost` and `https://localhost`.
- **Mini-app packages are keccak-committed.** A newly *required* header breaks already-approved
  packages. Additive and default-tolerant, or injected by the host on their behalf.
- **Counters are in-process.** The deployed Redis is engine-owned and non-persistent; it is not a shared
  counter store. Per-subject quotas are per-instance, which is fine at one instance and must be stated
  rather than assumed.
