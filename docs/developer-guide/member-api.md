# Member API — private keys and capability tokens (spec 095)

A paid member can hand a program the same read access they have themselves, and no more.
The **Member API** is a small HTTP surface on the existing relay gateway
(`services/relay-gateway/src/memberApi/`) authorised by an **EIP-712 capability token the
member signs in the app**. It reads a member's own data, quotes live fee rates, and builds
**unsigned** typed data for actions the member may then sign somewhere else.

It moves no money. There is no endpoint that submits a transaction on a member's behalf,
because there is no key on the server that could sign one.

## Architecture

```
  browser (Tools ▸ Assistant ▸ API access)         gateway (services/relay-gateway)
  ─────────────────────────────────                ─────────────────────────────────
  wagmi signTypedData(ApiKeyGrant)                 src/memberApi/
        │                                            contract.js   scopes · error codes · routes
        ▼                                            routes.js     mount + module gate
  fw1.<b64url(grant)>.<b64url(sig)>                  auth.js       ← the whole trust model
        │  shown ONCE, never stored                  openapi.js    the document, in JS
        │  metadata only in userStorage              revocation.js in-process set
        │                                            membership.js · wagers.js · intents.js
        ▼                                            assistant.js
                                                           │
  Authorization: Bearer fw1.…  ──────────────────────►  auth.js
                                                          │ 1 parse + TTL cap
                                                          │ 2 ECDSA recover → ERC-1271 fallback
                                                          │ 3 revocation set (in-process)
                                                          │ 4 membership, reference chain, ~60s
                                                          │ 5 sanctions screen (fail closed)
                                                          │ 6 scope + quota
                                                          ▼
                                            deps.feeRates ·  subgraph proxy ·
                                            @fairwins/intent-types ·  Anthropic Messages API
                                                          │
  services/mcp-server ────────────────────────────────────┘  (an ordinary client of this API)
```

Nothing in that picture holds a member secret at rest. The gateway does not issue tokens, does
not store them, and has no table of who holds what.

## Why it is shaped this way

**The gateway is stateless, so issuance is a signature, not a record.** The relay gateway has no
database — every other module in it is a proxy or a policy check over data that lives on chain
or at a vendor. Adding an API-key store would have made this the first module that owns
durable member state, with a key table to back up, migrate, leak, and rotate. A member-signed
grant carries its own authority instead: the token *is* the record. The gateway needs only the
member's address, which is public, and arithmetic.

**The member signs; the host signs; the server never signs.** Creating a key is a
`signTypedData` in the member's own wallet. The gateway verifies. `services/mcp-server`
forwards a token it was given. No component of this feature holds a private key that can
authorise anything, which is what lets an untrusted agent hold a token without holding custody.

**A token is a capability, not an identity.** Scopes are baked into the signed struct, so a
token cannot be widened after the fact — not by the holder, not by the gateway, not by us.
Broadening a key means signing a new one.

**Unknown is never forged.** ERC-1271 verification is a chain read, so an RPC failure during it
answers `503 auth_unverifiable`, never `401`. This is the spec-084 three-verdict rule applied to
authentication: a smart-account signature that cannot be checked right now looks exactly like a
forged one from outside, and reporting it as a forgery would lock passkey members out of their
own data during an RPC blip. The same discipline governs membership (`503 membership_unreadable`,
never tier 0) and screening (`503 screening_unavailable`, never "allowed").

**Revocation is honest about what it is.** Phase 1 keeps the revocation set in process, like
every other gateway store. A restart forgets it. Rather than implying durability the module does
not have, every revocation response carries `durable: false` and says so in words, and the UI
pairs it with the grant's own expiry — which *is* durable, because it is signed into the token.

## The token

Wire format, sent as `Authorization: Bearer <token>`:

```
fw1.<base64url(grantJSON)>.<base64url(signatureBytes)>
```

`grantJSON`, canonical field order:

```json
{ "v": 1, "account": "0x…", "keyId": "0x…32 bytes",
  "scopes": ["read:profile", "read:wagers"],
  "issuedAt": 1750000000, "expiresAt": 1757776000, "label": "my agent" }
```

`label` is display-only and **is not part of the signed struct** — renaming a key does not
invalidate it, and a label can never smuggle authority.

### EIP-712 — off-chain, and deliberately chain-agnostic

```
domain    { name: 'FairWins Member API', version: '1' }        // no chainId, no verifyingContract

ApiKeyGrant       account address · keyId bytes32 · scopes string
                  · issuedAt uint256 · expiresAt uint256
ApiKeyRevocation  account address · keyId bytes32 · revokedAt uint256
```

`scopes` is signed as the scope array **sorted ascending and joined with single spaces**, so the
signed bytes are canonical regardless of the order a client listed them in.

There is **no Solidity verifier**. The gateway is the only party that checks these signatures, and
the grant is not tied to a chain because the reads it authorises span the build's cohort. That is
why the domain carries neither `chainId` nor `verifyingContract` — a chain-pinned domain would be
a claim about where this is enforced that is not true.

The tables live once, in `packages/intent-types/src/offchain.js`, reached over the package's
`@fairwins/intent-types/offchain` subpath export: `MEMBER_API_DOMAIN`, `MEMBER_API_GRANT_TYPES`,
`MEMBER_API_REVOCATION_TYPES` and `canonicalScopeString`. The frontend and the gateway both import
from there. **Never write a local copy** — the duplicated-struct failure this repo already had
(issue #1038) is exactly the shape of bug where a correct type table under a drifted domain
produces a signature that verifies nowhere.

They sit in a **separate module from the contract-verified structs on purpose**. `test/intent/TypehashParity.test.js`
compares `CONTRACT_VERIFIED_TYPES` against typehashes parsed out of the Solidity, in both
directions; a struct with no Solidity counterpart placed in that set would fail the gate by
design, because the gate's whole job is to notice a struct the contracts do not verify. The
verifier for these is `services/relay-gateway/src/memberApi/auth.js`, and the gate that covers
them is `services/relay-gateway/test/memberApiAuth.test.js` — which signs with this table and
asserts the gateway accepts it.

### Scopes (v1)

| Scope | Grants |
|---|---|
| `read:profile` | token introspection (`/me`), revocation status |
| `read:wagers` | the token account's wagers, per chain |
| `read:membership` | tier / expiry on the membership reference chain |
| `read:fees` | live FeeRouter rates |
| `build:intents` | build unsigned typed data for an action |
| `assistant:chat` | the assistant proxy |

Every scope is a **read or a quote**. None of them submits anything.

## Verification, in order

`auth.js` runs these in sequence and stops at the first failure. Every body is the gateway's
nested shape, `{ "error": { "code": …, "reason": … } }`.

| # | Check | Failure |
|---|---|---|
| 1 | Parse `fw1.…`; `expiresAt` in the future; TTL ≤ `MEMBER_API_MAX_TTL_DAYS` (default 90) | `401 invalid_token` · `401 token_expired` · `401 token_ttl_exceeded` |
| 2 | ECDSA-recover the EIP-712 digest; on mismatch, ERC-1271 `isValidSignature` on the reference chain | `401 invalid_signature` · **`503 auth_unverifiable`** when the chain read fails |
| 3 | Revocation set (in-process) | `401 token_revoked` |
| 4 | Active `WAGER_PARTICIPANT` on the reference chain, cached ~60 s | `403 membership_required` · **`503 membership_unreadable`** |
| 5 | Sanctions screen the account (`policy/sanctions.js`, fail closed) | `403 sanctioned_signer` · `503 screening_unavailable` |
| 6 | Scope; then per-account and global quota | `403 insufficient_scope` · `429 quota_exceeded` with `Retry-After` |

The quota in step 6 is one of **four separate windows**, and the separation is load-bearing rather
than tidy. The two unauthenticated routes can only key on `ip:<req.ip>`, and `trust proxy` is
deliberately unset — so every anonymous caller is one key. While that key drew on the authenticated
instance it drew on its global counter too, and a flood of unauthenticated GETs answered `429` to
every member on every route, **including key revocation**. So: authenticated traffic, unauthenticated
traffic, `POST /keys/revoke` alone, and assistant calls each draw from a window nothing else can
spend. Revocation is *budgeted, not exempt* — the handler does an ECDSA recovery and possibly an
ERC-1271 call per request — but no volume of other traffic can starve it.

The assistant additionally carries a **token budget** (`assistant_budget_exhausted`, 429), because a
request count bounds traffic and not money. See [agentic-chat.md](agentic-chat.md) and
[Configuration](../reference/configuration.md#member-api-and-assistant-gateway).

`contract.js` is the single declaration of the scope list, the error codes and the route table,
and `openapi.js` renders the served document from it — so the published contract, the enforced
scope and the documented error cannot drift apart by anyone editing one and not the others. The
full wire contract lives in `specs/095-member-api-agentic-access/contracts/member-api.md`.

Step 4's "reference chain" is the first enabled chain that has a `membershipManager` recorded —
the same resolution the rest of the estate uses. Membership has one home (spec 071); reading it
anywhere else would answer a different question.

## Endpoints

All paths are absolute. The module is mounted unconditionally and gates itself, so a disabled
module answers `503 member_api_unconfigured` rather than 404 — an operator can tell "off" from
"gone".

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/v1/member/openapi.json` | — | The OpenAPI 3.1 document. No token required; the module must be enabled. |
| `GET` | `/v1/member/me` | `read:profile` | Introspection: account, keyId, scopes, validity window, three-state membership (`read` / `not-configured` / `unreadable`), revocation state. |
| `POST` | `/v1/member/keys/revoke` | — | Self-authorising: a valid `ApiKeyRevocation` signature *is* the authority. No bearer token. |
| `GET` | `/v1/member/keys/status` | `read:profile` | `?account=&keyId=` → `{ revoked, durable: false }`. |
| `GET` | `/v1/member/membership` | `read:membership` | Three-state tier read on the reference chain. |
| `GET` | `/v1/member/wagers` | `read:wagers` | Per-chain envelope: `{ chains: { "137": { state, wagers? } } }`. |
| `GET` | `/v1/member/fees` | `read:fees` | Live FeeRouter rates via the existing `deps.feeRates` reader. |
| `POST` | `/v1/member/intents/build` | `build:intents` | `{ action, chainId, params }` → typed data the **member** signs. |
| `POST` | `/v1/member/assistant/chat` | `assistant:chat` | See [Agentic Assistant](agentic-chat.md). |

`GET /status` gains a `memberApi: { enabled, killSwitch, assistant: { configured } }` block,
spliced in the same way as the perps block.

### A second rail: pay-per-request (spec 096)

The operations above also accept a **per-request payment** from a caller with no token, using the
x402 protocol — the request is answered `402` with a machine-readable price, the agent signs an
EIP-3009 transfer to the platform treasury, retries with an `X-PAYMENT` header, and is served **as the
payer**. It is off by default and lives in its own module (`src/x402/`), so the member API is spec 095
exactly when it is disabled.

**The bearer token is checked first, and a member is never charged** — a request carrying a valid
token never reaches the payment path, even with a payment attached. `openapi.json` and the key routes
are never priced. See [Agentic payments](agentic-payments.md).

### The OpenAPI document is JavaScript, on purpose

`src/memberApi/openapi.js` exports the document as an object rather than shipping a static
`.json`. Scope names, error codes and the TTL cap are interpolated from the constants the code
actually enforces, so the published contract cannot drift from the implementation by the usual
route — somebody editing one and not the other.

### `/v1/member/wagers` — three states, per chain

Subgraph URLs are configured per enabled chain as `MEMBER_API_SUBGRAPH_<chainId>`. Each chain in
the response independently resolves:

- `read` — the subgraph answered; `wagers` is present (possibly an empty array, which is a fact).
- `not-configured` — no URL for that chain. Not an error, and not zero.
- `unreadable` — the fetch failed. **`wagers` is absent.** A failed read never serialises as `[]`.

This is constitution III on the wire: an absent value has no place to hide behind a plausible
default, because the field simply is not there.

### `/v1/member/intents/build` — quotes, never submissions

Given an action name, a chain and params, the endpoint returns:

```json
{ "typedData": { "domain": …, "types": …, "primaryType": …, "message": … },
  "target": "0x…",
  "submitVia": { "relay": "/v1/intents", "selfSubmit": "…" } }
```

Three properties are load-bearing:

- **The actor field is forced to the token account.** It is never taken from the request body. A
  token cannot be used to build an intent that acts as somebody else.
- **`authOnly` actions return their EIP-3009 authorisation shape** rather than a `…WithSig`
  struct, because that is what the contract actually verifies for them (pool join).
- **`invalidateNonce` is refused, `400 unsupported_action`, with the reason stated in the body.**
  It is a footgun over an API: a program that burns a nonce can strand a member's own pending
  intent. The refusal names the action rather than pretending it does not exist.

Relaying the signed result uses the **existing public `POST /v1/intents`**. This module does not
own a second relay pipeline; duplicating one would double the policy surface that decides what
gets broadcast.

## Member surfaces

The signing half lives in the host, because a key is created by a wallet signature and a member has
to be able to see what they are signing:

- **Tools ▸ Assistant ▸ API access** (accordion card `api-access`, `ApiAccessPanel`, on the
  `assistant` tab at `/wallet?tab=assistant` since spec 104 — the old `?tab=settings#api-access`
  link redirects) — create, list and revoke keys, and generate an MCP configuration snippet. The token is displayed **once**; only
  metadata (`keyId`, `label`, `scopes`, `issuedAt`, `expiresAt`) is kept, wallet-scoped in
  `userStorage` under `api_access_keys`, and **deliberately not in `lib/backup/syncedObjects.js`** —
  the metadata is a convenience, and putting a key inventory into the encrypted backup would make
  the backup a more attractive target than the keys themselves. Because signing is entirely local,
  a member can still **create** a key with the gateway unreachable; only introspection and
  revocation registration need it.
- **Tools ▸ Assistant** (card `assistant-prefs`, same tab) — see [Agentic Assistant](agentic-chat.md).
- **The assistant's tool reads are ordinary member-API calls.** When the in-app assistant reads a
  member's profile, membership, wagers or fee rates (spec 104), the browser issues the same
  `GET /v1/member/*` requests the MCP server would, under the same 24-hour session grant, and they
  are authenticated, scoped, quota'd and audited exactly like any other call — there is no
  assistant-specific read route and no server-side tool executor on the member's behalf. On the
  FairWins rail the grant is the chat bearer and exists before the first message; on the GutterToken
  rail (where the chat itself never touches this gateway) the grant is optional and offered from the
  panel the first time a member-data tool is needed. The public tools (`/status`,
  `/v1/polymarket/137/markets`, `/v1/perps/pairs`) need no token, as always. Audit records for tool
  reads carry counts only.
- Key creation and revocation are durable events in the client activity ledger under the **`access`**
  notification domain ("Programmatic access"). Metadata only: `keyId`, label and scopes — **never a
  token**.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MEMBER_API_ENABLED` | `false` | Master switch. Off ⇒ `503 member_api_unconfigured`. |
| `MEMBER_API_KILLSWITCH` | `false` | On ⇒ `503 member_api_killed`, module only. |
| `MEMBER_API_MAX_TTL_DAYS` | `90` | Ceiling on a grant's `expiresAt − issuedAt`. |
| `MEMBER_API_SUBGRAPH_<chainId>` | — | Per-chain subgraph URL for `/wagers`. Unset ⇒ `not-configured`. |

Validation that can fail the boot lives **inside** the `if (enabled)` branch, so an unconfigured
module never takes the gateway down. Full list, including the assistant's:
[Configuration](../reference/configuration.md#member-api-and-assistant-gateway).

## CORS

`Access-Control-Allow-Headers` gains `Authorization`. Browser calls carrying a bearer token are
the point of this module and cannot work without it. Nothing else about the CORS posture moves:
no credentials mode, no cookies, the origin allow-list is unchanged, and the X-Origin-Auth edge
lock is unchanged.

## Invariants

- **No key material anywhere on the server.** The gateway issues nothing, stores no token, and
  cannot sign. If that stops being true, this module has become a custodian.
- **A token's authority is exactly what its signature covers.** Scopes, account, key id and the
  validity window are signed. `label` is not, and grants nothing.
- **`503` for unknown, `401`/`403` only for known-bad.** Signature-unverifiable, membership
  unreadable, and screening unavailable are all three-state answers.
- **A failed read never renders as `0`, `[]`, or `false`** in any response body.
- **The actor of a built intent is the token account.** Always. No request field overrides it.
- **Revocation reports `durable: false`** until it is backed by something that survives a restart.
- **Every error body is `{ error: { code, reason } }`**, and every `429` carries `Retry-After`.
- **Key revocation is never starvable.** It draws from a window nothing else can spend, because a
  member reaches for it exactly when their key is loose.
- **Model spend has a ceiling denominated in tokens, not requests.** A turn reserves its worst case
  before the provider is called and settles to the measured usage; an exhausted budget refuses with
  `429 assistant_budget_exhausted` and is **never** served as a shortened answer. An unknown cost is
  never a zero cost.
- **The struct tables have one source**, `@fairwins/intent-types`. A local copy is a defect.

## Tests

- Gateway: `services/relay-gateway/test/memberApiAuth.test.js` — the trust model, signing with the
  real `@fairwins/intent-types/offchain` table: token parse, expiry, the TTL cap, the ECDSA and
  ERC-1271 paths including the unverifiable branch, revocation, and the membership three-state.
- Gateway: `services/relay-gateway/test/memberApi.test.js` — routes, scope matrix, quota headers,
  the module gate and both killswitches, and the served OpenAPI document against `contract.js`.
- Gateway: `services/relay-gateway/test/memberApiQuotaIsolation.test.js` — that the four windows are
  genuinely separate, and that revocation survives a flood from either side of the auth boundary.
- Gateway: `services/relay-gateway/test/memberApiSpend.test.js` — the assistant's token budget, its
  tighter request class, and the boot-time caps.
- E2E: `frontend/cypress/e2e/fast/` — key creation and revocation, and honest-unreachable states.

## Related

- [Agentic payments](agentic-payments.md) — the x402 pay-per-request rail on these same operations.
- [MCP Server](mcp-server.md) — the reference consumer of this API.
- [Agentic Assistant](agentic-chat.md) — the one endpoint here that talks to a model provider.
- [Member API Operations](../runbooks/member-api-operations.md) — enabling, killswitch, incidents.
- [Assistant & API access](../user-guide/assistant-and-api.md) — the member-facing how-to.
- Spec: `specs/095-member-api-agentic-access/`.
