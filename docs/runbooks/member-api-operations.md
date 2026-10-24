# Runbook: Member API and Assistant Operations (spec 095)

## 1. Overview

Operate the member-facing HTTP API on the relay gateway (`services/relay-gateway/src/memberApi/`),
the agentic assistant proxy inside it, and the `fairwins-mcp-server` Cloud Run service that
consumes it — **which is not deployed**: its Terraform is gated off behind `manage_mcp_server`
because nothing publishes its image, and 3.8 is how that changes.

Hold four facts before touching anything:

1. **The gateway issues no credentials and stores no key material.** A member's API token is an
   EIP-712 grant they signed in their own wallet. There is no key table to protect, dump, or
   restore — and no operator action that can create, read, or extend a member's token.
2. **The only secret this feature adds is `ANTHROPIC_API_KEY`.** Everything else is public
   configuration. Treat that one key as production credential material; treat the rest as flags.
3. **Revocation is in-process and does not survive a restart.** Every revocation response says so
   (`durable: false`). Never tell a member their key is permanently dead — the durable bound on a
   compromised token is its signed `expiresAt`.
4. **No endpoint here moves a member's money.** Every operation reads, quotes, or returns unsigned
   typed data, and no scope can spend. An incident on this module cannot drain an account; it can
   leak reads or run up model spend.
5. **One rail does take money, from non-members only** — the x402 pay-per-request path (spec 096,
   3.3), which is **off by default**. A payer signs a transfer of their own funds and the gateway
   submits it; the platform escrows nothing and holds no key. Members with a valid token are never
   charged, and with `X402_ENABLED=false` none of it exists.

Design: `specs/095-member-api-agentic-access/` and `specs/096-x402-agentic-payments/`. Developer
detail: [member-api.md](../developer-guide/member-api.md),
[mcp-server.md](../developer-guide/mcp-server.md),
[agentic-chat.md](../developer-guide/agentic-chat.md),
[agentic-payments.md](../developer-guide/agentic-payments.md).

---

## 2. Prerequisites

Before running any procedure below, confirm you have:

- `gcloud` authenticated against `chippr-bots-site-wp`, with IAP tunnel access to the gateway VM.
  **The GCP project is shared** — never touch a secret that is not named in this runbook. See
  [credential-rotation.md](credential-rotation.md).
- Access to the gateway's environment: `infra/vm/gateway/docker-compose.yml` for public config, and
  `infra/vm/common/fetch-secrets.sh` for secret delivery.
- Repository write access via the normal PR path. **Two of the changes below are code changes, not
  console changes** — adding a secret to `fetch-secrets.sh`, and adding a subgraph URL to a
  per-chain env — and both ship through `staging` → `main`.
- The gateway's public base URL. Today there is exactly ONE gateway:
  `https://relay.fairwins.app` (the `fairwins-gateway` GCE VM, serving chains 63 + 137).
  `relay-staging.fairwins.app` was designed but never built — it has no origin and no DNS
  record (#1290); the staging SPA rides the self-submit fallback until that lands.

Know which state you are starting from before you change it:

```bash
curl -s https://relay.fairwins.app/status | jq '.memberApi'
# { "enabled": false, "killSwitch": false, "assistant": { "configured": false } }
```

---

## 3. Step-by-Step Instructions

### 3.1 Enable the Member API

Set the module's environment on the gateway and restart the unit.

| Variable | Default | Set it to | Notes |
|---|---|---|---|
| `MEMBER_API_ENABLED` | `false` | `true` | Master switch. Off ⇒ every path answers `503 member_api_unconfigured`. |
| `MEMBER_API_KILLSWITCH` | `false` | leave `false` | Module-scoped stop. See 3.4. |
| `MEMBER_API_MAX_TTL_DAYS` | `90` | leave, or lower | Ceiling on a grant's lifetime. Lowering it invalidates longer grants **immediately**. |
| `MEMBER_API_SUBGRAPH_<chainId>` | unset | a subgraph URL per enabled chain | Unset is honest: that chain reports `not-configured`. |
| `MEMBER_API_QUOTA_PER_ACCOUNT` | `120` | leave | Requests/min for one authenticated account, keyed by the account behind a verified signature. |
| `MEMBER_API_QUOTA_GLOBAL` | `600` | leave | Requests/min across all authenticated callers. |
| `MEMBER_API_PUBLIC_QUOTA` | `240` | leave | Requests/min for the **unauthenticated** routes, in a window of their own. `0` fails the boot. See 3.1.1. |
| `MEMBER_API_REVOKE_QUOTA` | `60` | leave | Requests/min for `POST /v1/member/keys/revoke` **alone**. `0` fails the boot. See 3.1.1. |

Do this in order — and note the pinned image comes FIRST, because the live pin may predate the
module entirely (the compose file's own perps history is the cautionary tale: a flag with no code
behind it looks enabled and does nothing):

1. **Confirm the pinned image carries the module.** Read the `image:` tag comment in
   `infra/vm/gateway/docker-compose.yml`. If it predates spec 095, build and push a new image and
   repin — this is a manual ritual by design (no pipeline pushes this image):
   ```bash
   git checkout <the merged commit>            # never a dirty tree — the tag names a commit
   docker build -f services/relay-gateway/Dockerfile \
     -t us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/prediction-dao-research/fairwins-relay-gateway:<tag> .
   docker run --rm -e ENABLED_CHAIN_IDS=137 -p 8788:8788 <image>   # boot it; curl /status must
   #   answer with the memberApi block before you push — verify, then:
   docker push <image>
   ```
   Edit the `image:` line with the new tag, record the digest in the comment above it (house
   ritual), and uncomment the spec-095/096 env block in the same change.
2. **Set the reference chain explicitly.** `MEMBER_API_REFERENCE_CHAIN_ID: "137"` is load-bearing
   on this gateway: `ENABLED_CHAIN_IDS` starts with `63`, Mordor also records a
   `membershipManager`, and the default ("first enabled chain with one") would silently pin
   membership and ERC-1271 auth to testnet. Both chains pass the boot check — this wrong answer
   fails silently, which is why it is spelled out here.
3. **Confirm the secret exists under the exact id `anthropic-api-key`** (Secret Manager, project
   `chippr-bots-site-wp`) — `fetch-secrets.sh` emits it by that id, `optional`, into the gateway
   env file. A differently-named secret is silently absent and the assistant stays
   `503 assistant_unconfigured`.
4. Open a PR with the compose edit; merge through `staging` → `main`. **The VM tracks `main`**
   (Ansible checks out `main`; the startup script hard-resets to `origin/main`) — a compose edit
   sitting on `staging` is invisible to the node.
5. Converge and restart on the VM (no public SSH — IAP only):
   ```bash
   cd infra/ansible && ansible-playbook playbooks/gateway.yml --check --diff && \
     ansible-playbook playbooks/gateway.yml
   # or, if the checkout on the box is already current:
   gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap \
     --command 'sudo systemctl restart fairwins-secrets@gateway && sudo systemctl restart fairwins-stack@gateway'
   ```
   **Restart the unit, never a single container** — all containers share one network namespace,
   and secrets are read at boot (a new secret version does nothing without the
   `fairwins-secrets@gateway` restart).
6. Verify with 3.7 before announcing anything.

**Lower `MEMBER_API_MAX_TTL_DAYS` only deliberately.** The cap is evaluated per request against the
grant's own `issuedAt`/`expiresAt`, so dropping 90 → 30 rejects every outstanding 90-day token at
the next call with `401 token_ttl_exceeded`. That is a legitimate blunt control in an incident
(3.6), and a surprise outage if you do it casually.

#### 3.1.1 Why there are four request quotas and not one

`/v1/member/*` is **not** behind `express-rate-limit` — that middleware sits on `/healthz`,
`/status` and `POST /v1/intents`. The module's whole limiter is the in-process sliding window in
`src/policy/quotas.js`, and it runs as **four separate instances** because they make four different
promises:

| Instance | Keyed by | Covers |
|---|---|---|
| `MEMBER_API_QUOTA_*` | the account recovered from the token signature | every authenticated route |
| `MEMBER_API_PUBLIC_QUOTA` | `ip:<req.ip>` | `GET /v1/member/openapi.json`, and the x402 `402` challenge |
| `MEMBER_API_REVOKE_QUOTA` | `ip:<req.ip>` | `POST /v1/member/keys/revoke`, and nothing else |
| `ASSISTANT_QUOTA_*` | the account | `POST /v1/member/assistant/chat` (see 3.2) |

The separation is the control, and merging any two of them re-creates a real denial of service:

- **`trust proxy` is deliberately unset** on this gateway, and nginx fronts the container, so
  `req.ip` is the proxy for every caller. Every unauthenticated request is therefore ONE key as far
  as any counter can tell. **Do not "fix" that by setting `trust proxy`** — it would re-key every
  IP-scoped quota across this estate, not just this module.
- While that one anonymous key drew on the authenticated instance it also drew on its **global**
  counter: roughly 600 unauthenticated requests a minute answered `429 quota_exceeded` to every
  member, on every route of the module — **including key revocation.**
- Revocation therefore has a window of its own again. A member reaches for it exactly when their
  key is loose, which is also when whoever holds that key may be hammering the gateway. It is
  **budgeted, not exempt**: the handler does an ECDSA recovery and, for a smart account, an
  ERC-1271 chain call per request, so an unmetered version would be an amplifier pointed at our own
  RPC. What matters is that nothing else can spend from it.

A `0` on either new variable **fails the boot by name** rather than silently refusing every request
on that route. If you need to stop the module, use the killswitch (3.4) — that answers an honest
`503`, where an unreachable quota would answer a `429` nobody can clear.

### 3.2 Enable the assistant

The assistant is a **sub-config of the Member API module**. It cannot answer while
`MEMBER_API_ENABLED` is false, and the Member API killswitch takes it down with the module.

| Variable | Default | Notes |
|---|---|---|
| `ASSISTANT_ENABLED` | `false` | Off ⇒ `503 assistant_unconfigured`. |
| `ANTHROPIC_API_KEY` | — | **SECRET.** Missing ⇒ `503 assistant_unconfigured`. |
| `ASSISTANT_MODEL` | `claude-sonnet-5` | Public config. |
| `ASSISTANT_MAX_TOKENS` | `1024` | Output ceiling per turn. **Hard-capped at 4096 in code** — a higher value fails the boot. |
| `ASSISTANT_QUOTA_PER_ACCOUNT` | `20` | Model **calls**/min per account. Tighter than the module's `120` reads on purpose. |
| `ASSISTANT_QUOTA_GLOBAL` | `60` | Model calls/min across the gateway. |
| `ASSISTANT_TOKEN_BUDGET_PER_ACCOUNT` | `200000` | Model **tokens** per account per window. The ceiling on money. |
| `ASSISTANT_TOKEN_BUDGET_GLOBAL` | `2000000` | Model tokens per window across the gateway. |
| `ASSISTANT_TOKEN_BUDGET_WINDOW_MS` | `3600000` | The token-budget window (1 h). Separate from the request-quota window. |

#### The spend ceilings, and why a request count is not one

Two turns inside the same minute can differ by orders of magnitude in what they cost, so a request
quota bounds **traffic**, never **money**. Read these three facts before changing any number above:

1. **The token budget is the actual ceiling.** A turn reserves its worst case
   (estimated input + `ASSISTANT_MAX_TOKENS`) before the provider is called, and settles the
   reservation down to the measured usage when the answer arrives — so turns already in flight
   cannot overshoot the budget between them. Exhausted answers **`429 assistant_budget_exhausted`**
   with `Retry-After`: a distinct code from `quota_exceeded`, because an agent should back off on a
   different timescale. It is **never** served as a shortened reply.
2. **An unknown cost is never a zero cost.** A provider answer carrying no usage counts keeps its
   full reservation, and a turn that failed after the request was sent is not credited back —
   otherwise a retry loop against a failing provider would be free, which is precisely the spend
   these controls exist to bound.
3. **`ASSISTANT_MAX_TOKENS` is capped in code, not in the env file.** `ASSISTANT_MAX_TOKENS=1000000`
   is a typo that reads exactly like the correct value and multiplies the cost of every turn; boot
   refuses anything above 4096 by name. Boot also refuses a per-account budget below one maximal
   turn (it would be a size limit wearing a budget's name — a member would be refused for asking a
   long question rather than for spending their budget) and a gateway budget below a member's.

**Sizing them.** The defaults hold one member to ~200k tokens/hour and the gateway to ~2M — roughly
$3/hr and $30/hr respectively at Sonnet-5 rates if every token were output, and well under that in
practice. Raise them only with a figure in mind; they are the difference between a bad hour and a
bad invoice. Before these existed, the only control over model spend was `ASSISTANT_ENABLED=false`.

**Deliver `ANTHROPIC_API_KEY` through Secret Manager and `fetch-secrets.sh`. Never put it in
`docker-compose.yml`, a build arg, a Terraform variable, or a `VITE_` variable.**

1. Create the secret and add a version:

   ```bash
   gcloud secrets create ANTHROPIC_API_KEY --replication-policy=automatic   # first time only
   printf '%s' "$KEY" | gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-
   ```

2. Add the delivery line to the **gateway** container block in `infra/vm/common/fetch-secrets.sh`,
   beside the other optional vendor keys:

   ```sh
   emit "$GW" ANTHROPIC_API_KEY ANTHROPIC_API_KEY latest optional
   ```

   Mark it **`optional`**, not `required`. A missing assistant key must degrade the assistant to
   `503 assistant_unconfigured` — it must never abort the gateway boot and take the gasless relay
   path down with it. That is the never-stranded rule.

3. Ship that edit through `staging` → `main`. **A secret version alone does nothing**: secrets are
   read at boot into tmpfs, so the script must name the variable before the container can ever see
   it.

4. Set `ASSISTANT_ENABLED=true` in the gateway env, then restart the unit (4.1).

5. Verify `.memberApi.assistant.configured == true` at `/status`, then run one real chat turn from
   a member account and confirm a reply and non-zero `usage`.

**Rotate the key** by adding a new version and restarting the unit — the delivery line is pinned to
`latest`, so no code change is needed for a rotation, only for the first wiring. Retire the previous
version at the provider after the restart is verified.

### 3.3 Enable pay-per-request (x402, spec 096)

The x402 rail lets an agent with **no member token** pay per request. It is a **sub-module of the
Member API** — it cannot answer while `MEMBER_API_ENABLED` is false — and it is the only part of this
estate that takes money. Read [agentic-payments.md](../developer-guide/agentic-payments.md) before
enabling it.

Four facts before you touch it:

1. **Members are never charged.** The bearer token is checked first; a valid one never reaches the
   payment path. If a member reports being billed, that is a defect, not a configuration question.
2. **The platform holds nothing.** The payer signs a transfer of their own USDC to `X402_PAY_TO` and
   the gateway submits it through the existing engine lane. There is no balance to reconcile, no
   float, and no key added to the gateway.
3. **`X402_PAY_TO` has no default, on purpose.** An enabled rail without one **fails to boot**. Do not
   "fix" that by putting an address in a default — a stale default is money sent to an address nobody
   holds.
4. **Settlement acceptance is a broadcast, not a confirmation.** Never tell anyone a payment is final
   because the API returned 200.

| Variable | Default | Notes |
|---|---|---|
| `X402_ENABLED` | `false` | Master switch. Off ⇒ the member API behaves exactly as it did before spec 096. |
| `X402_KILLSWITCH` | `false` | On ⇒ no offers made, no payments taken. See 3.4. |
| `X402_CHAIN_ID` | the gateway's default chain | Settlement chain. Must be enabled and have a payment token, a token domain **and** an engine lane. |
| `X402_PAY_TO` | — | Treasury address. **Required. No default.** Public config — it appears in every offer. |
| `X402_SETTLE_BUFFER_SECONDS` | `60` | Minimum remaining validity a payment must carry. |
| `X402_MAX_TIMEOUT_SECONDS` | `300` | Published in the offer. |
| `X402_PRICE_READ` / `_BUILD` / `_ASSISTANT` | `10000` / `50000` / `100000` | USDC base units (6 decimals). **`0` ⇒ that class is not offered at all.** All three at `0` fails the boot. |
| `X402_NONCE_MAX` | `50000` | Bound on the in-process replay set. |

Do this in order:

1. **Choose the treasury deliberately.** It is public: it is printed in every 402 answer and in every
   settlement receipt. Prefer an address whose control is already documented, and record the choice
   in the change. Changing it later is a config edit plus a restart, and payments signed against the
   old offer will simply fail to match — which is correct, not an outage.
2. Set the environment in `infra/vm/gateway/docker-compose.yml`; open a PR; merge through `staging`
   first. **None of these are secrets** — the treasury, the network and the prices are published to
   every unauthenticated caller by design.
3. Restart the whole unit (4.1).
4. Verify at `/status` **before** announcing anything, then run one real paid request end to end on
   staging and confirm the payer's balance moved by exactly the offered amount.

```bash
curl -s https://relay.fairwins.app/status | jq '.memberApi.x402'
# { "enabled": true, "killSwitch": false, "network": "eip155:137",
#   "priced": { "read": "10000", "build": "50000", "assistant": null } }
# A class at 0 reports null, not "0": "not offered" and "costs nothing" are different facts.
```

**Repricing** is an env edit plus a restart. It takes effect on the next offer; a payment already
signed against the old price still matches the offer it names, so nobody is retro-charged.

**To stop selling one class**, set its price to `0`. That class stops being offered entirely and its
operations refuse exactly as they did before this feature — it does **not** become free.

### 3.4 Use the killswitch

Two switches exist. Choose by blast radius.

| Switch | Effect | Use when |
|---|---|---|
| `MEMBER_API_KILLSWITCH=true` | This module answers `503 member_api_killed`. Everything else on the gateway keeps working. | Abuse, quota exhaustion, or a defect confined to this module. |
| The gateway-wide killswitch | Every module answers `503 killswitch_active`. | A gateway-wide incident. Do not reach for this to stop the Member API. |
| `ASSISTANT_ENABLED=false` | The assistant answers `503 assistant_unconfigured`; reads keep working. | Model-provider incident or bad model behaviour. **For runaway spend, reach for the budget first** — it is the narrower control. |
| Lower `ASSISTANT_TOKEN_BUDGET_*` | Members who have already spent the new figure answer `429 assistant_budget_exhausted`; everyone else is unaffected, and the assistant stays up. | Runaway model spend. Narrower than the kill above — prefer it. |
| `X402_KILLSWITCH=true` | The offer is withdrawn: priced routes refuse exactly as unpriced ones do, and no payment is taken or settled. Member-authenticated traffic is untouched. | Anything wrong with the paid rail. |
| `X402_ENABLED=false` | The paid rail ceases to exist; the member API is spec 095 exactly. | A deliberate withdrawal of the offering, not an incident stop. |

Set the flag, restart the unit, confirm at `/status`, and state which switch you used in the
incident channel. Killing the assistant alone leaves members' data reads working — prefer the
narrowest switch that ends the incident.

**On the paid rail there are two different things to stop, and they are not the same.** Stopping the
**offering** (a price set to `0`, or `X402_ENABLED=false`) means new callers are not quoted a price.
Stopping the **taking** (`X402_KILLSWITCH=true`) means a payment presented right now is refused
rather than settled. In an incident where money is moving wrongly you want the second: it is the one
that guarantees nobody is charged while you look. Neither can leave a caller half-paid, because
verification always completes before any submission — a refused payment was never submitted.

### 3.5 Handle a revocation request

Understand what revocation does before you promise anything.

- A member revokes in the app: they sign an `ApiKeyRevocation` and the client POSTs it to
  `/v1/member/keys/revoke`. The endpoint is **self-authorising** — a valid signature is the
  authority, so no bearer token is needed and a member with a leaked token can still revoke it.
- The gateway adds the key id to an **in-process set**. That set is memory. **A gateway restart,
  a redeploy, or a scale event forgets it**, and the token becomes valid again until its signed
  `expiresAt`.
- The response says exactly that: `{ revoked: true, durable: false, reason: "…" }`. The app shows
  the member both facts — the revocation is registered on the live gateway, and the grant also
  expires on its own date.

Therefore:

1. **Re-submit the revocation after any gateway restart.** Tell the member to press revoke again,
   or replay the stored signed revocation. It is idempotent.
2. **Never state that a token is permanently disabled.** The durable bound is `expiresAt`.
3. **If a leaked token has a long life and the member cannot wait**, lower
   `MEMBER_API_MAX_TTL_DAYS` below its remaining lifetime and restart — that rejects it, and every
   other token longer than the new cap, at the next request. Announce it: it is a blunt control.

### 3.6 Incident playbook

| Symptom | Likely cause | Do this |
|---|---|---|
| Every member call returns `503 member_api_unconfigured` | `MEMBER_API_ENABLED` unset, or the unit restarted without the env | Check `/status`; re-apply the env; restart the unit (4.1). |
| Every call returns `503 member_api_killed` | The module killswitch is on | Confirm it was intentional. If not, clear it and restart. |
| Widespread `503 auth_unverifiable` | Reference-chain RPC is failing; ERC-1271 checks cannot run | **Do not "fix" this by accepting the signatures.** Check the RPC endpoint; this is a correct answer to an unknown. |
| Widespread `503 membership_unreadable` | Same RPC failure on the membership read | Same. A tier that cannot be read is not tier 0. |
| Widespread `403 sanctioned_signer` | Screening source misconfigured or answering wrongly | Screening fails closed by design. Investigate the source; do not bypass. |
| Sustained `429` from one account | One member's agent is hot-looping | Confirm from quota counters; contact the member. Kill the module (3.4) only if the gateway is degraded. |
| `429 quota_exceeded` on **every** member at once | Something is flooding the module | Check whether it is authenticated. Unauthenticated traffic draws on its own window (3.1.1) and **cannot** cause this — if members are being refused, the flood is holding valid tokens. Revocation keeps working throughout by design; confirm it does. |
| `429 quota_exceeded` on `/openapi.json` while members are fine | The public window is doing its job | Not an outage. Raise `MEMBER_API_PUBLIC_QUOTA` only if a legitimate client needs it — the document is cached, so a client re-fetching it in a loop is the more likely cause. |
| `429 assistant_budget_exhausted` | The **token** budget is spent for that account, or for the gateway | Distinct from `quota_exceeded`: this counts what was billed, not requests. The reason names which ceiling bit. Raise `ASSISTANT_TOKEN_BUDGET_*` only with a cost figure in mind (3.2); the assistant is working as designed. |
| Assistant returns `503 assistant_unavailable` | Model provider unreachable, timing out, or refusing the key | Check the provider's status; verify the key reached the container (4.2). The SPA shows an honest unreachable state meanwhile. |
| Assistant returns `503 assistant_unconfigured` after a rotation | New secret version added but the unit was not restarted | Restart the unit. Secrets are read at boot. |
| A member on the **GutterToken** provider reports "key not accepted", "out of credit" or "rate-limited" | Nothing on our side — that rail never touches this gateway | See 3.9. There is no FairWins log, config or secret involved; do not go looking for one. |
| Model spend spiking | Abuse or a client retry loop | The token budget bounds it already (3.2). To tighten fast, lower `ASSISTANT_TOKEN_BUDGET_PER_ACCOUNT`/`_GLOBAL` and restart — heavy accounts refuse, everyone else keeps working. `ASSISTANT_ENABLED=false` is the blunt fallback. |
| A revoked key works again | The gateway restarted and forgot the in-process set | Expected. Re-submit the revocation (3.5). |
| A chain reports `not-configured` in `/wagers` | `MEMBER_API_SUBGRAPH_<chainId>` unset | This is honest, not an outage. Set the URL only if that chain should be readable. |
| The MCP service is unreachable | Cloud Run revision failing, or `FAIRWINS_API_URL` wrong | Check `GET /healthz` on the service, then its `FAIRWINS_API_URL`. It holds no secret — never look for one. |
| **A member reports being charged** | A defect — the bearer path is checked before the paywall | `X402_KILLSWITCH=true`, restart, then investigate. This is a correctness incident, not a config question. |
| Widespread `503 settlement_unavailable` | The engine lane is down or the relayer is out of gas | Fix the engine (see [relayer-operations.md](relayer-operations.md)). **Nobody was charged** — verification precedes settlement. Do not "unblock" it by serving priced operations free. |
| Sustained `402 payment_replayed` from one payer | A client retrying a spent authorisation | Their bug, not ours. A replay costs them nothing. |
| A settled payment's transaction never confirms | A chain or relayer problem, not an API one | The receipt was always a **broadcast**. Reconcile from the tx hash in the audit line; do not re-serve or refund from the gateway — it holds no funds. |
| `402 payment_signature_invalid` from a smart account that signed correctly | Working as designed — the paid rail is EOA-only, and the reason says so | Point them at the membership rail, where ERC-1271 is fully supported. Do not "fix" it by adding a 1271 check: it would pass here and revert at the token. |
| Payments arriving for the wrong treasury | `X402_PAY_TO` changed without a restart, or a stale cached offer | Offers name the treasury; a mismatched payment is refused, so nothing was mis-sent. Confirm `/status`, restart if needed. |
| The gateway will not boot after enabling x402 | `X402_PAY_TO` unset, an unknown `X402_CHAIN_ID`, or that chain has no payment token or engine lane | Correct or configuration. Read the boot error, fix the env. **Never add a default treasury address.** |

**Escalate to a security incident, not a support ticket**, if any of these appear: an error body, a
log line, or an audit record containing a `fw1.` token, an assistant message body, an **x402 payment
signature or authorisation nonce**, or the value of `ANTHROPIC_API_KEY`. Rotate the Anthropic key
immediately in that last case (3.2) and follow [credential-rotation.md](credential-rotation.md). A
leaked payment signature is a bearer instrument until it is spent — treat it like a token, not like a
log line.

### 3.7 Verify honest state

Run this after every change. The point is not that the endpoints answer — it is that they answer
**correctly about what they could not do**.

1. **Disabled reads as disabled, not as absent.** With the module off, every path answers `503
   member_api_unconfigured` — not `404`. An operator must be able to tell "off" from "gone".
2. **A failed read is never a zero.** Point a `MEMBER_API_SUBGRAPH_<chainId>` at an unreachable
   host and confirm that chain resolves `unreadable` **with no `wagers` field at all**. An empty
   array there is a defect: it says "you have no wagers", which is a fabricated fact.
3. **An unset chain is `not-configured`, and does not alert.** Absence of configuration is not an
   outage.
4. **Unknown authentication is `503`, never `401`.** Break the reference-chain RPC and confirm a
   contract-account token yields `auth_unverifiable`, not `invalid_signature`.
5. **Unreadable membership is `503`, never `403`.** Same test on the membership read.
6. **Revocation admits it is not durable.** Confirm `durable: false` in both the revoke response
   and `/keys/status`.
7. **The assistant never invents.** With `ASSISTANT_ENABLED=false`, confirm the panel shows an
   honest unavailable state and **no reply text**.
8. **No secret is in any output.** Grep the boot log and one request's logs for `fw1.`, for the
   Anthropic key prefix, for any chat content, and for an x402 payment signature or nonce. All must
   be absent.
9. **A member is never charged** (x402 on). Repeat one authenticated read with a payment header
   attached and confirm it is served on the membership rail with **no** `X-PAYMENT-RESPONSE` and no
   settlement in the engine's log.
10. **Zero price means not offered, not free.** Set a class to `0`, restart, and confirm its
    operations answer `401` as before — never `402`, and never `200`.
11. **A refused payment costs nothing.** Present an expired authorisation and confirm the engine was
    asked to submit nothing. Verification precedes settlement; if a rejected payment ever reaches the
    engine, stop and file it.
12. **The receipt says broadcast.** Confirm no surface — header, docs, or MCP tool result — describes
    a settlement as confirmed or final.

### 3.8 Publish and enable the MCP server

**The MCP server is NOT deployed, and Terraform is gated off so that a merge cannot deploy it.**
`manage_mcp_server = false` in both `infra/terraform/environments/prod/terraform.tfvars` and
`.../staging/terraform.tfvars`; while it is false the `module "mcp_server"` / `"mcp_server_staging"`
blocks declare nothing at all.

The gate exists because of a gap, not a preference: **no pipeline builds or pushes this image.**
`cloudbuild.yaml` builds the SPA, `cloudbuild.staging.yaml` builds the two staging SPA cohorts, and
`.github/workflows/container-build.yml`'s `mcp-image` job builds `services/mcp-server` only to boot
it and speak one `initialize` handshake — under a local `fairwins-mcp-server:ci` tag it never
pushes. There is no `fairwins-mcp-server/*` package in `cloud-run-source-deploy`. Meanwhile
`infra-apply.yml` applies on push to `main` **with no human in the loop**, its matrix is
`fail-fast: true` (prod failing means staging never applies), and a failed apply is never retried
unattended (FR-035). Ungated, one promotion would try to create a Cloud Run service from an image
that does not exist and wedge the estate's apply path behind a person.

Publishing the image is necessary but **not sufficient on its own**: the image build and the infra
apply would both hang off the same push to `main`, concurrently, with no ordering between them. The
flag is what makes the create happen at a moment somebody chose.

Do it in this order. Steps 1–2 need someone with **write access to Artifact Registry**; step 3 is an
ordinary PR.

1. **Build and push the image.** Standalone build context — `services/mcp-server`, not the repo
   root (the service has no dependencies and no workspace package; a root context would re-admit
   the failure mode the spec-075 images guard against).

   ```bash
   git checkout <the merged commit>          # never a dirty tree
   REPO=us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/fairwins-mcp-server

   docker build -f services/mcp-server/Dockerfile -t "$REPO/fairwins-mcp-server:<sha>" services/mcp-server
   docker tag "$REPO/fairwins-mcp-server:<sha>" "$REPO/fairwins-mcp-server:latest"

   # Boot it before pushing, exactly as CI does — a container that answers /healthz but not
   # `initialize` is broken in the only way a client can see.
   docker run -d --name mcp -p 8790:8790 -e FAIRWINS_API_URL=https://gateway.invalid "$REPO/fairwins-mcp-server:<sha>"
   curl -fsS http://127.0.0.1:8790/healthz
   curl -fsS -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ops","version":"0"}}}' \
     http://127.0.0.1:8790/mcp | grep -q '"name":"fairwins-mcp"'
   docker rm -f mcp

   docker push --all-tags "$REPO/fairwins-mcp-server"
   ```

   For staging, repeat with the `fairwins-mcp-server-staging` name in the same
   `fairwins-mcp-server/` path — the two Terraform modules name different packages.

2. **Confirm it is really there.** Do not take the push's word for it; the tag Terraform names is
   `:latest`, and a partial push is exactly the state that produces a create failure later:

   ```bash
   gcloud artifacts docker images list \
     us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy \
     --include-tags --format='value(package,tags)' | grep fairwins-mcp-server
   ```

   Both `fairwins-mcp-server` and `fairwins-mcp-server-staging` must appear, each carrying `latest`.

3. **Flip the flag, as its own PR.** Set `manage_mcp_server = true` in the environment(s) whose
   image you verified — prod and staging are separate flags and may be flipped separately. Read the
   Infra Plan output on that PR: it must report exactly one Cloud Run service and one
   `run.invoker`/`allUsers` member being CREATED, and nothing else. Merge it alone, not stacked
   behind other infra work.

4. **Verify** with 4.6. The URI is the `mcp_server_service_uri` output; while the flag is false that
   output is **null**, which means "not declared" — a different fact from a declared service that is
   unreachable.

**If you ever deploy the service by hand first**, adopt it with the commented `import` block in
`imports.tf` rather than letting Terraform create a second one. Note the block is indexed
(`module.mcp_server[0]`) because the module carries `count`.

**A standing pipeline is the better end state** and is deliberately not improvised here: adding a
build-and-push step is a change to what production ships, and belongs in a spec-095 follow-up with
its own review — not folded into the change that closed the unattended-apply hazard.

---

### 3.9 The GutterToken rail — nothing to operate

Spec 104 lets a member have the assistant answered by **GutterToken** on their own prepaid credit.
On that provider the member's browser calls `https://api.guttertokens.com/v1/messages` **directly**
with a key the member pasted; FairWins is not in the request path, holds no GutterToken credential,
sees no message content, and charges nothing. Consequently there is **no env var, no secret, no
quota, no killswitch and no log line** for it in this gateway — `ASSISTANT_ENABLED=false` does not
affect it, and neither does the member-API killswitch. The only FairWins-side switch is the tenant
feature flag `assistant-byok` in `tenants/<id>/manifest.json`, which is a **build-time** change.

The one thing that does reach this gateway from that rail is the assistant's **tool reads**
(`GET /v1/member/*` under the member's session grant, and the public routes) — ordinary member-API
traffic, handled and audited exactly like the MCP server's.

**Support script — the three things members will report.** Every one of these is a state the panel
already names honestly; the job is to confirm the member is reading it correctly and point them at
GutterToken, not at us.

| Member says | It means | Say |
|---|---|---|
| "GutterToken did not accept this key" (`key_invalid`) | GutterToken answered `401`. The key was mistyped, or revoked/rotated at GutterToken. | Copy a fresh key from `app.guttertokens.com` and use **Add / Replace** on Tools ▸ Assistant; **Test** before saving. We cannot see or check the key — it is on their device only, and we never receive it. Never ask a member to paste a key into a support channel. |
| "Your GutterToken balance is empty" (`out_of_credit`) | GutterToken answered `403 insufficient_quota`. | Top up at GutterToken (USDC/USDT on Ethereum, Base, Arbitrum One or Polygon, from a wallet they can sign for — an exchange withdrawal cannot be claimed). We cannot see their balance and cannot credit anything. Billing disputes go to GutterToken. |
| "GutterToken is rate-limiting requests from your network" (`quota`) | GutterToken answered `429`. Its limits are **per source IP**, so an office or shared network can trip it with one member's traffic. | Wait and retry; it is not our quota and not something we can lift. |
| "The assistant service is not reachable", naming GutterToken | Transport failure to `api.guttertokens.com`, or `503 model_unavailable`. | Check GutterToken's own status; retry. There is no FairWins-side probe for this rail. If the member is on a corporate network, an outbound proxy blocking the host presents the same way. |

A member who has **lost the wallet** they opened a wallet-only GutterToken account with has lost
that account and its credit; there is nothing FairWins can do, and the Risk Disclosure §13 says so.
A member switching devices needs to re-enter the key (it is never backed up) — that is by design,
not a sync fault.

## 4. Code Examples

### 4.1 Restart the gateway unit after a config or secret change

```bash
gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap \
  --command 'sudo systemctl restart fairwins-secrets@gateway && sudo systemctl restart fairwins-stack@gateway'
```

Restart the whole unit, never one container: the containers share a network namespace, and
recreating the owner leaves the joiners in a stack that looks healthy and is not.

### 4.2 Confirm the assistant key reached the container without printing it

```bash
gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap \
  --command 'sudo grep -c "^ANTHROPIC_API_KEY=" /run/fairwins/gateway.env'
# 1 = delivered, 0 = not delivered (fix fetch-secrets.sh, then restart)
```

Never `cat` an env file from `/run/fairwins/`. Count the line; do not read the value.

### 4.3 Check module state and the served contract

```bash
BASE=https://relay.fairwins.app

curl -s "$BASE/status" | jq '.memberApi'
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/member/openapi.json"   # 200 enabled, 503 off
curl -s "$BASE/v1/member/openapi.json" | jq '{openapi, paths: (.paths|keys)}'
```

### 4.4 Exercise an authenticated read with a member's own token

Ask a member to generate a **short-lived, read-only** token for a support session and to revoke it
afterwards. Never ask for a long-lived one, and never store it.

```bash
TOKEN='fw1.…'   # supplied by the member, held for this shell only

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/member/me" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/member/wagers" \
  | jq '.chains | map_values(.state)'
```

Expect `read`, `not-configured` or `unreadable` per chain — never a bare list.

### 4.5 Prove the honest-failure path

```bash
# A chain whose subgraph is unreachable must omit `wagers` entirely.
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/member/wagers?chainId=137" \
  | jq '.chains["137"] | {state, hasWagers: (has("wagers"))}'
# { "state": "unreadable", "hasWagers": false }   ← correct
# { "state": "unreadable", "hasWagers": true  }   ← DEFECT: file it, do not work around it
```

### 4.6 Check the MCP service

**Not deployed yet.** Terraform's `manage_mcp_server` is false in both environments and no pipeline
publishes the image, so there is no `fairwins-mcp-server` service and the `mcp_server_service_uri`
output is null. §3.8 is how that changes. Until then the server runs locally over stdio, which is
what `docs/developer-guide/mcp-server.md` documents for a member.

```bash
curl -s https://fairwins-mcp-server-<hash>-uc.a.run.app/healthz

curl -s -X POST https://fairwins-mcp-server-<hash>-uc.a.run.app/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

The service holds no secret and no service account of its own. Authorisation arrives per request.

---

## 5. Troubleshooting

**`/status` shows `enabled: true` but calls still 503.** Read the code in the body.
`member_api_killed` is the module killswitch; `killswitch_active` is the gateway-wide one; both are
independent of `MEMBER_API_ENABLED`.

**A member says their key "stopped working" with no change on our side.** Check, in order: the
grant's `expiresAt` (decode the middle segment of the token — it is public JSON, not a secret in
itself, but do not paste a whole token anywhere); `MEMBER_API_MAX_TTL_DAYS` against that grant's
lifetime; their membership state; and only then screening. `401 token_ttl_exceeded` means we
lowered the cap under an already-signed grant.

**A member says a revoked key still works.** Expected after a gateway restart (3.5). Re-submit the
revocation and explain the expiry date.

**A browser client gets a CORS error carrying a bearer token.** Confirm `Authorization` is present
in `Access-Control-Allow-Headers`. It was added deliberately for this module; nothing else about
the CORS posture changed, and no credentials mode or cookie is involved.

**A chain shows `unreadable` and stays that way.** That is the subgraph, not this module. Confirm
the URL, then check the subgraph itself. Do not set the chain to `not-configured` to quieten it —
that would say "we never offered this" about a surface that is simply down.

**The assistant answers slowly, then fails.** The proxy uses an `AbortController` timeout; a
timeout surfaces as `503 assistant_unavailable`. Check provider latency before changing
`ASSISTANT_MAX_TOKENS` — and note a failed turn keeps its budget reservation on purpose (3.2), so a
provider outage does consume a member's budget. That is the correct trade: the alternative makes a
retry loop against a failing provider free.

**The gateway will not boot after touching a quota or the assistant.** Read the error — every one of
these validations names the variable and its value. `MEMBER_API_PUBLIC_QUOTA=0` and
`MEMBER_API_REVOKE_QUOTA=0` are refused (they would deny every unauthenticated request, and every
key revocation, with a `429` nobody can clear); `ASSISTANT_MAX_TOKENS` above 4096 is refused; a token
budget below one maximal turn, or a gateway budget below a member's, are refused. None of it is
evaluated while the module (or the assistant) is switched off, so an unconfigured optional block can
never take the gateway down.

**You cannot find an API-key table, dump, or backup.** There is none. Issuance is a member
signature; the gateway holds nothing. If a procedure seems to require reading a member's key, the
procedure is wrong.

---

## 6. References

- [Member API](../developer-guide/member-api.md) — token format, verification order, endpoints.
- [Agentic payments](../developer-guide/agentic-payments.md) — the x402 paid rail, its wire format and
  its invariants.
- [MCP Server](../developer-guide/mcp-server.md) — the Cloud Run consumer.
- [Agentic Assistant](../developer-guide/agentic-chat.md) — opt-in model, memory, disclosures.
- [Credential rotation and connected systems](credential-rotation.md) — the shared-project rules
  and the boot-time secret model.
- [Relayer operations](relayer-operations.md) — the gateway this module lives in.
- [Infrastructure operations](infrastructure-operations.md) — the VM and Cloud Run estate.
- [Configuration](../reference/configuration.md#member-api-and-assistant-gateway) — every variable.
- [Assistant & API access](../user-guide/assistant-and-api.md) — what members are told.
- Specs: `specs/095-member-api-agentic-access/`, `specs/096-x402-agentic-payments/`.
