# 04 — Annex: Connectors & Ports

> Every connector that crosses a process boundary, and every socket anything
> listens on. Two tables answer two different audit questions: *what talks to
> what* (§A, the connector map) and *what could be reached* (§B, the port and
> egress inventory).
>
> Numbers here are cited, never inferred. Where the repository contradicts
> itself, the contradiction is recorded rather than resolved — see
> [Annex 09](09-findings-and-drift.md).

## Reading the port inventory

Three properties decide whether a listener is an attack surface, and the
inventory records all three separately because they are independent:

1. **Bind address.** `127.0.0.1` versus `0.0.0.0`. Most FairWins listeners bind
   loopback and are reachable only through the node's own nginx.
2. **Publication.** A container port published by the namespace owner versus one
   that exists only inside the shared namespace.
3. **Ingress restriction.** Whether the firewall admits anything to the host port
   at all — and from where.

A listener on `0.0.0.0` inside a namespace with no published port and no firewall
rule is not exposed; a loopback listener behind a published port is. Reading any
one column alone gives the wrong answer.


## §A — Connector map

## 2. CONNECTOR MAP

### 2.1 Relay-gateway HTTP route table (enumerated from `GW/**/routes.js` + `GW/server.js` + `GW/identity/routeTable.js` + `GW/memberApi/contract.js`)

Global middleware order (server.js): `helmet` → CORS allow-list → body parse (32 kb; 256 kb for
`POST /v1/bitcoin/:network/tx`) → **origin lock** (`X-Origin-Auth`, timing-safe; exempt
`/healthz`, `/status`, `/v1/engine/webhook`) → **identity middleware** (spec 106) → **access
router** → module routers → engine webhook → error handler.

| Method + path | Module | Auth / tier | Proxies to / does | Sync? |
|---|---|---|---|---|
| `GET /healthz` | server.js:587 | none, **origin-lock exempt** (GFE-intercepted on `*.run.app`) | RPC fan-out (cached) per chain | sync |
| `GET /status` | server.js:588 | none, origin-lock exempt; `gasWalletRunwayHrs` only with a valid `X-Origin-Auth` | same cached fan-out | sync |
| `POST /v1/intents` | server.js:591 | **self-authenticating** — member EIP-712 signature inside the payload; tier `ANONYMOUS` | verify → screen → quotas → `engineClient.submitTransaction` (OZ relayer) | async (returns intent id) |
| `GET /v1/intents/:id` | server.js:765 | ANONYMOUS | in-process intent store | sync |
| `POST /v1/paymaster` | server.js:784 | self-authenticating (userOp); ANONYMOUS. JSON-RPC body: `pm_getPaymasterStubData` (no sign) / `pm_getPaymasterData` | killswitch → op ceilings → sanctions → deposit gate → quotas → **KMS sign** ERC-7677 | sync |
| `POST /v1/access/rpc` | access/routes.js:49 | ANONYMOUS (tier shapes **lifetime**, not access) | mints a short-lived JWT for a dedicated provider endpoint; **issues, never carries traffic**; admin check via `RPC_ACCESS_ADMIN_URL` (QuickNode) | sync |
| `GET /v1/opensea/collections/:slug/stats` | opensea/routes.js:196 | ANONYMOUS | OpenSea API (`api.opensea.io`) | sync |
| `GET /v1/opensea/:chainId/account/:address/nfts` | :127 | ANONYMOUS | OpenSea | sync |
| `GET /v1/opensea/:chainId/contract/:contract/nfts/:identifier` | :158 | ANONYMOUS | OpenSea | sync |
| `GET /v1/opensea/:chainId/collections/:slug/required-fees` | :219 | ANONYMOUS | OpenSea | sync |
| `POST /v1/opensea/:chainId/listings` | :243 | **ADDRESS** tier | OpenSea write w/ platform API key + referral | sync |
| `POST /v1/opensea/:chainId/listings/cancel` | :309 | ADDRESS | OpenSea | sync |
| `POST /v1/opensea/:chainId/offers/fulfillment` | :273 | ADDRESS | OpenSea | sync |
| `GET /v1/polymarket/:chainId/markets` | polymarket/routes.js:126 | ANONYMOUS | Gamma API (`gamma-api.polymarket.com`, public) | sync |
| `GET /v1/polymarket/:chainId/markets/:conditionId` | :156 | ANONYMOUS | Gamma | sync |
| `GET /v1/polymarket/:chainId/fee-rate` | :181 | ANONYMOUS | FeeRouter read / config | sync |
| `GET /v1/polymarket/:chainId/positions` | :223 | ANONYMOUS | Data API (`data-api.polymarket.com`, public) | sync |
| `POST /v1/polymarket/:chainId/builder-sign` | :248 | **ADDRESS** (`sign` class — spends the platform's commercial standing) | CLOB (`clob.polymarket.com`) with L2 creds + builder code | sync |
| `GET /v1/perps/pairs` | perps/routes.js:254 | ANONYMOUS | Gains (`backend-{arbitrum,base,polygon}.gains.trade`, `backend-pricing.eu.gains.trade`), GMX (`arbitrum-api.gmxinfra.io`), Hyperliquid (`api.hyperliquid.xyz`) | sync |
| `GET /v1/perps/positions` | :347 | ANONYMOUS | same three venues | sync |
| `GET /v1/perps/config` | :454 | ANONYMOUS | public attribution config + live HL builder bps | sync |
| `GET /v1/news/:chainId/:asset` | news/routes.js:91 | ANONYMOUS | Alphaday (`api.alphaday.com/items/news/?tags=<slug>`) — **keyless** | sync |
| `POST /v1/bitcoin/:network/addresses` | bitcoin/routes.js:122 | ANONYMOUS (a POST-shaped **read**) | Esplora (`mempool.space/api`, `/testnet4/api`) | sync |
| `GET /v1/bitcoin/:network/fees` | :147 | ANONYMOUS | Esplora | sync |
| `POST /v1/bitcoin/:network/tx` | :167 | **ADDRESS** (irreversible broadcast) | Esplora broadcast; 256 kb body cap | sync |
| `GET /v1/bitcoin/:network/tx/:txid` | :196 | ANONYMOUS | Esplora | sync |
| `GET /v1/bitcoin/:network/stamps` | :220 | ANONYMOUS | `BTC_STAMPS_URL` (optional; absent ⇒ fail-safe "protected") | sync |
| `GET /v1/bridge/:chainId/quote` | bridge/routes.js:100 | ANONYMOUS | Across (`app.across.to/api/suggested-fees`) | sync |
| `GET /v1/bridge/:chainId/status` | :153 | ANONYMOUS | Across deposit status | sync |
| `GET /v1/member/openapi.json` | memberApi (contract id `openapi`) | **none** — never priced | serves the generated OpenAPI 3.1 doc | sync |
| `GET /v1/member/me` | `me` | Bearer `fw1` grant, scope `read:profile`; never priced | token introspection | sync |
| `POST /v1/member/keys/revoke` | `revoke` | member **signature** (no bearer); own quota bucket | in-process revocation store (`durable: false`) | sync |
| `GET /v1/member/keys/status` | `keyStatus` | Bearer, `read:profile` | revocation store | sync |
| `GET /v1/member/membership` | `membership` | Bearer, `read:membership`; never priced | membership read on the **reference chain** | sync |
| `GET /v1/member/wagers` | `wagers` | Bearer, `read:wagers`; **opClass `read`** (x402-priceable) | subgraph / chain reads per chain | sync |
| `GET /v1/member/fees` | `fees` | Bearer, `read:fees`; opClass `read` | FeeRouter view (3-state: `read`/`env-fallback`/`unreadable`) | sync |
| `POST /v1/member/intents/build` | `buildIntent` | Bearer, `build:intents`; opClass `build` | returns **unsigned** EIP-712 typed data; actor forced to the token account | sync |
| `POST /v1/member/assistant/chat` | `assistantChat` | Bearer, `assistant:chat`; opClass `assistant`; token budget + tighter quota | model provider (`api.anthropic.com`), **tools attached server-side**; client-supplied `tools` refused | sync |
| `POST /v1/engine/webhook` | server.js:1194 | **HMAC-SHA256 `X-Signature`** over raw bytes (shared secret with OZ relayer); origin-lock exempt; fail-closed | intent status transitions | async (inbound callback) |

Unauthenticated calls to a priced op answer **402** with an x402-v2 offer; `X-PAYMENT` request
header carries the signed `TransferWithAuthorization`; `X-PAYMENT-RESPONSE` returns the receipt.

### 2.2 Browser (SPA) → gateway

| Source | Target | Transport | Payload | Auth | Sync |
|---|---|---|---|---|---|
| `FE/lib/relay/intentClient.js` (`relayIntent`, `pollStatus`, `probeHealth`) | `POST /v1/intents`, `GET /v1/intents/:id`, `GET /status` | HTTPS JSON | signed EIP-712 intent | signature-in-payload + edge `X-Origin-Auth` (injected by Cloudflare) | async poll |
| `FE/lib/passkey/bundlerTransport.js` + `sendBatch.js` | alto bundler JSON-RPC; `POST /v1/paymaster` | JSON-RPC over HTTPS | UserOp | userOp signature; ERC-7677 | sync + receipt poll |
| `FE/lib/collectibles/gatewayClient.js` | `/v1/opensea/*` | HTTPS JSON | chain/address/slug | origin lock | sync |
| `FE/lib/predict/predictClient.js` | `/v1/polymarket/*` | HTTPS JSON | market/condition/trader | origin lock (+ ADDRESS tier for builder-sign) | sync |
| `FE/lib/perps/perpsClient.js` | `/v1/perps/*` | HTTPS JSON | address | origin lock | sync |
| `FE/lib/bitcoin/gatewayClient.js` | `/v1/bitcoin/*` | HTTPS JSON | addresses, **signed raw tx hex** | origin lock; ADDRESS for broadcast | sync |
| `FE/lib/bridge/acrossQuotes.js` | `/v1/bridge/*` | HTTPS JSON | route + amount | origin lock | sync |
| `FE/lib/news/newsClient.js#fetchTokenNews` | `GET /v1/news/:chainId/:asset` | HTTPS JSON | chainId + slug (resolved locally first; **no call when uncovered**) | origin lock | sync |
| `FE/lib/network/issuedAccess.js` | `POST /v1/access/rpc` | HTTPS JSON | chainId | origin lock | sync; then direct provider reads with the issued token |
| `FE/lib/assistant/assistantClient.js` (`authorizeSession`, `sendChat`) | `POST /v1/member/assistant/chat` | HTTPS JSON, `Authorization: Bearer fw1…` | messages + surface path (trailing block on last user msg) | member-signed `ApiKeyGrant`, TTL 1 day, `ASSISTANT_SESSION_SCOPES`; token in **module memory only** | sync |
| `FE/lib/apiAccess/grantSigner.js` + `tokenCodec.js` | — (local) | — | signs the off-chain `ApiKeyGrant` | wallet / passkey | sync |

### 2.3 Browser → external, **not** via gateway

| Source | Target | Transport | Payload | Auth | Notes |
|---|---|---|---|---|---|
| `FE/lib/assistant/providers/guttertoken.js#sendGutterTokenTurn` | `https://api.guttertokens.com/v1/messages` | HTTPS JSON (open CORS) | conversation turn, model `claude-opus-5`, `max_tokens 1024` | member's own `sk-…` key from device store | **FairWins is never in the path** — no key, no message, no rate/credit figure rendered |
| SPA read providers | member RPC endpoint / build default / issued keyed endpoint | JSON-RPC over HTTPS (loopback http allowed for a local node) | eth calls | credential in a **request header**, primary endpoint only | `connect-src https:` scheme-wide is the reason BYO-node works |
| SPA wallet transports (`wagmi.js`) | same endpoints | JSON-RPC | txs | wallet | module-load-time ⇒ panel discloses a reload |
| Mini-app loader | IPFS gateways | HTTPS fetch → **Blob URL import** | package bytes | integrity-verified (keccak manifest + sha256 per file) | `blob:` in `script-src` exists only for this |
| Solana / Bitcoin send paths | `lib/solana/rpc.js`, Esplora via gateway | JSON-RPC / HTTPS | signed txs | client-side keys | keys never leave the client |
| Hardware wallet | device | **WebUSB / WebHID / WebBLE** (native: Capacitor BLE) | APDUs | physical confirmation | only via `connectHardware` |
| Service worker | `fairwins-shell-v1`, `fairwins-miniapp-packages-v1` | Cache API | shell + packages | — | package cache is cache-first, **not a trust boundary** |

### 2.4 Gateway → external

| Target | Transport | Auth |
|---|---|---|
| OZ relayer engine (`GW/engine/client.js`) | `POST {ENGINE_URL}/api/v1/relayers/{id}/transactions`, `Authorization: Bearer <apiKey>` | engine API key |
| Anthropic (`api.anthropic.com`) | HTTPS JSON | gateway-only model credential |
| OpenSea, Polymarket CLOB (L2 creds), Gamma/Data (public), Gains/GMX/Hyperliquid (public), Across, Esplora/mempool.space, Alphaday (keyless), Cloudflare Turnstile siteverify, QuickNode admin API | HTTPS JSON | per-vendor; secrets are gateway-only |
| Chain RPCs (`GW/config/providers.js`) | JSON-RPC | per-chain; URLs redacted at display/log boundaries |
| KMS (paymaster signing) | cloud API | workload identity |

### 2.5 MCP server (`services/mcp-server`)

| Connector | Transport | Payload | Auth | Notes |
|---|---|---|---|---|
| MCP client → server | **stdio** (newline-delimited JSON-RPC; stdout is protocol-only) | JSON-RPC | `FAIRWINS_API_TOKEN` env | **no per-call header ⇒ no payment possible on stdio, by design** |
| MCP client → server | **HTTP** `POST /mcp`, `GET /healthz` | JSON-RPC | per-request `Authorization: Bearer` overrides env; `X-PAYMENT` forwarded byte-for-byte; `X-PAYMENT-RESPONSE` returned | the **only** mode a payment can travel |
| server → gateway (`src/api.js#createApiClient`) | HTTPS to the member API routes | as the route | the member's own token, or a supplied `X-PAYMENT` (substitutes for the token; no `Authorization` sent) | dependency-free; **holds no key and cannot pay** |

**MCP tools** (from `toolDefs.snapshot.json`, gated both directions by
`services/relay-gateway/test/mcpToolParity.test.js`):

| Tool | Auth | Scope | Executes |
|---|---|---|---|
| `find_in_app` | local | — | local nav-index lookup (no network) |
| `get_profile` | grant | `read:profile` | route `me` |
| `get_membership` | grant | `read:membership` | route `membership` |
| `get_wagers` | grant | `read:wagers` | route `wagers` (query `chainId`, `first`) |
| `get_fees` | grant | `read:fees` | route `fees` |
| `get_gateway_status` | none | — | `GET /status` |
| `get_prediction_markets` | none | — | `GET /v1/polymarket/{chainId}/markets` |
| `get_perps_pairs` | none | — | `GET /v1/perps/pairs` |
| `get_token_news` | none | — | `GET /v1/news/{chainId}/{asset}` |
| `build_intent` | grant | `build:intents` | **MCP-ONLY** (`src/tools.js:243`) — deliberately absent from the in-app assistant |

The in-app assistant runs the same 9 non-`build_intent` tools in the **browser**
(`FE/lib/assistant/tools/{executor,toolLoop}.js`, ≤ `MAX_TOOL_ROUNDS` 4; gateway ceiling
`ASSISTANT_MAX_ROUNDS` default 4 max 8). No `navigate` tool exists;
`FE/lib/assistant/replyLinks.js` is the only path from model text to a click.

### 2.6 Other process boundaries

| Source → target | Transport | Notes |
|---|---|---|
| `services/finops-exporter` → Prometheus | `GET /metrics` on **loopback only** (`app.listen(config.port, config.host)`, nginx does not proxy) | serves the scheduler's **last readings** — a scrape never fails because a vendor is down |
| finops-exporter → GCP Billing / vendor APIs / chain RPC | HTTPS | **read-only by construction** (no signer, no write route); `fetch-secrets.sh` refuses to boot if key material reaches its env |
| Prometheus/Grafana (`infra/observability/`) → exporter, gateway, bundler | HTTP loopback probes asserting on **content** (a plain 200 proves nothing) | read-only viewing surface, not the pager (Cloud Monitoring pages) |
| VM units → GCP Secret Manager | `infra/vm/common/fetch-secrets.sh` shelling `gcloud` | one mechanism shared with the workstation fetcher |
| Workstation → Secret Manager | `npm run sec -- --profile <p> -- <cmd>` (`scripts/secrets/with-secrets.js`) shelling `gcloud` | delivers a **profile** into a child env; must never gain an npm dependency |
| Subgraph indexer → chain | The Graph | `subgraph/subgraph.yaml`, `schema.graphql`, `networks.json` |
| SPA → subgraph | HTTPS GraphQL | `getSubgraphUrl(chainId)` / `hasSubgraph(chainId)` |
| Terraform/Ansible → GCP + Cloudflare | provider APIs | apply is automatic on merge, executes the **reviewed** plan, gated on the infra-tree digest |
| Ansible → VM nodes | SSH **through IAP tunnel only** (`:22` open to the IAP range) | a failed connect means fix the tunnel, never widen the firewall |

---


---

## §B — Processes, ports and egress

## 1. Production — `fairwins-gateway` GCE VM (role `gateway`)

Unit: `fairwins-stack@gateway.service` → `docker compose -f /opt/fairwins/gateway/docker-compose.yml up -d`
(`infra/vm/systemd/fairwins-stack@.service:22`). Compose project `fairwins-gateway`
(`infra/vm/gateway/docker-compose.yml:23`). `engine`, `finops`, `alloy` and `redis` all join the
**gateway container's network namespace** (`network_mode: "service:gateway"`), so every
`localhost:<port>` coupling below is literal and correct
(`infra/vm/gateway/docker-compose.yml:3-16`).

| Process | Port | Proto | Bind | Where | Caller | Evidence |
|---|---|---|---|---|---|---|
| host `nginx` (TLS terminator) | **443** | TCP/TLS 1.2+1.3, HTTP/2 | VM external + all ifaces | VM host (Debian pkg) | Cloudflare proxy; Google uptime probers (direct to origin IP) | `infra/vm/nginx/fairwins-gateway.conf:10`; installed `infra/vm/startup.sh:23,80-98` |
| host `nginx` (redirect only) | **80** | TCP/HTTP | VM external | VM host | Cloudflare (301 → https) | `infra/vm/nginx/fairwins-gateway.conf:47-51` |
| `fairwins-gateway-gateway` (relay-gateway, Node/express) | **8788** | TCP/HTTP | published **`127.0.0.1:8788`** on host; `0.0.0.0:8788` inside its netns | VM container | host nginx `proxy_pass http://127.0.0.1:8788` | published `infra/vm/gateway/docker-compose.yml:47-48`, `PORT` `:57`; proxy `infra/vm/nginx/fairwins-gateway.conf:30,36`; code `services/relay-gateway/src/server.js:1276`; default 8788 `services/relay-gateway/src/config/index.js:417`; `EXPOSE 8788` `services/relay-gateway/Dockerfile:49` |
| relay-gateway **counters/metrics** endpoint (`/counters`) | **9091** | TCP/HTTP | in-namespace only, **never published** | VM container | FinOps exporter (`http://gateway:9091/counters`) | `infra/vm/gateway/docker-compose.yml:177-179`; consumer `:300`; code `services/relay-gateway/src/metrics/counters.js:78,94`; config `services/relay-gateway/src/config/index.js:549-551` |
| `fairwins-gateway-engine` (OpenZeppelin Relayer) | **8080** | TCP/HTTP | in-namespace (`localhost`), **no `ports:`** | VM container | gateway (`ENGINE_URL=http://localhost:8080`); probes via `docker exec` | `infra/vm/gateway/docker-compose.yml:254` (`APP_PORT: "8080"`), `:60`; probe `infra/vm/common/probe.sh:126`; `infra/vm/common/poststart.sh:59` |
| `fairwins-gateway-redis` | **6379** | TCP (RESP) | in-namespace, **no `ports:`**, no persistence | VM container | engine (`REDIS_URL=redis://localhost:6379`); gateway limiter/dedup store | `infra/vm/gateway/docker-compose.yml:257`, `:7`, cmd `:406` |
| `fairwins-gateway-finops` (FinOps exporter) | **9464** | TCP/HTTP (`/metrics`, `/healthz`) | **`127.0.0.1` explicitly** (`FINOPS_BIND_HOST`) | VM container | Grafana Alloy scrape (`localhost:9464`) | `infra/vm/gateway/docker-compose.yml:295-296`, comment `:276-278`; code `services/finops-exporter/src/server.js:201`, defaults `services/finops-exporter/src/config/index.js:55,58`; `EXPOSE 9464` `services/finops-exporter/Dockerfile:38`; scrape `infra/grafana/alloy/config.alloy:26` |
| `fairwins-gateway-alloy` (Grafana Alloy agent HTTP/UI) | **12345** | TCP/HTTP | **`127.0.0.1:12345`** (`--server.http.listen-addr`) | VM container | nothing (deliberately not exposed) | `infra/vm/gateway/docker-compose.yml:384` |
| `sshd` | **22** | TCP/SSH | VM (firewall-restricted to IAP range) | VM host | `gcloud compute start-iap-tunnel`; Ansible | `infra/ansible/inventory/gcp.yml:7,60-61`; firewall §5 |

Health/probe endpoints on this VM (callers, not extra listeners):
`GET /__probe/health` → `127.0.0.1:8788/status` (`infra/vm/nginx/fairwins-gateway.conf:27-33`);
container healthcheck `wget http://127.0.0.1:8788/status` (`infra/vm/gateway/docker-compose.yml:231`);
exporter healthcheck `http://127.0.0.1:9464/healthz` (`:349`);
`fairwins-probe@gateway` timer every 60 s → `curl http://127.0.0.1:8788/status`
(`infra/vm/systemd/fairwins-probe@.timer:8`, `infra/vm/common/probe.sh:63`).

Runtime signals (not sockets, but the only other control surface): `SIGUSR2` kill-switch toggle
and `SIGHUP` config reload (`services/relay-gateway/src/server.js:1267,1275`).

---

## 2. Production — `fairwins-bundler` GCE VM (role `bundler`)

Compose project `fairwins-bundler`; `nginx` joins **alto's** namespace
(`infra/vm/bundler/docker-compose.yml:3-12,117`).

| Process | Port | Proto | Bind | Where | Caller | Evidence |
|---|---|---|---|---|---|---|
| host `nginx` (TLS terminator) | **443** | TCP/TLS, HTTP/2 | VM external | VM host | Cloudflare; Google uptime probers | `infra/vm/nginx/fairwins-bundler.conf:10` |
| host `nginx` (redirect) | **80** | TCP/HTTP | VM external | VM host | Cloudflare (301) | `infra/vm/nginx/fairwins-bundler.conf:61-65` |
| `fairwins-bundler-nginx` (origin-lock sidecar) | **8080** | TCP/HTTP | published **`127.0.0.1:8080`**; `listen 8080` inside alto's netns | VM container | host nginx `proxy_pass http://127.0.0.1:8080` | publish `infra/vm/bundler/docker-compose.yml:26`; `listen 8080` `services/alto-bundler/nginx/bundler.conf.template:46`; `EXPOSE 8080` `services/alto-bundler/nginx/Dockerfile:17`; proxy `infra/vm/nginx/fairwins-bundler.conf:47` |
| `fairwins-bundler-alto` (pimlico alto v1.2.7, ERC-4337) | **3000** | TCP/HTTP JSON-RPC | published **`127.0.0.1:3000`** | VM container | origin-lock nginx (`upstream 127.0.0.1:3000`); host nginx `/__probe/health` directly | publish + rationale `infra/vm/bundler/docker-compose.yml:27-32`; `ALTO_PORT: "3000"` `:74`; upstream `services/alto-bundler/nginx/bundler.conf.template:40-43`; probe `infra/vm/nginx/fairwins-bundler.conf:34-40` |
| `sshd` | **22** | TCP/SSH | IAP range only | VM host | IAP tunnel / Ansible | see §5 |

Unauthenticated `GET /healthz` on the origin-lock sidecar is a static `return 200` that never
touches alto — explicitly **not** a bundler health signal
(`services/alto-bundler/nginx/bundler.conf.template:52-56`, restated
`infra/vm/bundler/docker-compose.yml:100-101`).
alto container healthcheck posts `eth_supportedEntryPoints` to `http://127.0.0.1:3000`
(`infra/vm/bundler/docker-compose.yml:102`); `poststart.sh` additionally asserts the host `:8080`
returns 403 to prove the origin lock is armed (`infra/vm/common/poststart.sh:39-44`).

---

## 3. Cloud Run

| Service | Port | Proto | Bind | State | Caller | Evidence |
|---|---|---|---|---|---|---|
| `prediction-dao-research` (SPA, nginx static + `/api/pinata` proxy) | **8080** (Cloud Run container port) | TCP/HTTP | container `listen 8080` | **LIVE** (deployed by Cloud Build; Terraform `manage_spa=false`) | Cloudflare → Cloud Run ingress | `frontend/nginx.conf.template:41`, `frontend/nginx.conf:18`; `EXPOSE 8080` `Dockerfile:169`; deploy `cloudbuild.yaml:109-121`; `manage_spa = false` `infra/terraform/environments/prod/terraform.tfvars:266` |
| `fairwins-mcp-server` | **8790** (image default; Cloud Run injects `PORT`) | TCP/HTTP (`POST /mcp`, `GET /healthz`) | `0.0.0.0` in the image CMD; `127.0.0.1` otherwise | **NOT DEPLOYED** — `manage_mcp_server = false`, and no pipeline publishes the image | AI agents carrying a member token | `ENV PORT=8790` + `EXPOSE 8790` `services/mcp-server/Dockerfile:31-32`; `CMD … --http --host 0.0.0.0` `:49`; defaults `services/mcp-server/src/server.js:41,47,49`, `listen` `:339`; gate `infra/terraform/environments/prod/terraform.tfvars:17`, rationale `infra/terraform/environments/prod/main.tf:301-364` |
| `fairwins-relay-gateway` (3-container: gateway 8788 / engine 8080 / redis 6379) | 8788, 8080, 6379 | TCP/HTTP, RESP | Cloud Run sidecar namespace | **DECOMMISSIONED** — manifest kept as reconciliation/recovery record | — | banner `services/oz-relayer/deploy/production/service.yaml:1-8`; ports `:34,42,131`, redis probe `:165`; Mordor variant `services/oz-relayer/deploy/mordor/service.yaml:2,37,45,70,91,103` |
| `fairwins-alto-bundler` (nginx 8080 ingress + alto 3000 sidecar) | 8080, 3000 | TCP/HTTP | Cloud Run sidecar namespace | **DECOMMISSIONED, must stay so** (guardrail G-11; `check:iac` + `single-alto-gate.sh`) | — | banner `services/alto-bundler/deploy/service.yaml:1-11`; ports `:57,105,150`; removal record `cloudbuild.yaml:122-138`; gate `infra/vm/bundler/single-alto-gate.sh:78,135` |

Cloud Run itself is reached on **443** via Cloudflare; the container port is what is listed.
Terraform's `cloud-run-service` module declares **no `ports` block**, so the platform default
container port applies and the image must honour `$PORT`
(`infra/terraform/environments/prod/main.tf:348-349`).

---

## 4. Uptime probes / monitoring targets (ingress from Google)

| Check | Target | Port | Assertion | Evidence |
|---|---|---|---|---|
| `fairwins-bundler-origin` | bundler static IP, `GET /__probe/health` | **443** (module default) | body contains `0x5FF137D4` | `infra/terraform/environments/prod/main.tf:460-483`; port default `chippr-tf-modules/modules/monitoring/variables.tf:26`; resource `chippr-tf-modules/modules/monitoring/main.tf:55-77` |
| `fairwins-gateway-origin` | gateway static IP, `GET /__probe/health` | **443** | body contains `"rpc":"up"` (NOT `status:ok`, which is unconditional) | `infra/terraform/environments/prod/main.tf:484-495`; rationale `infra/vm/nginx/fairwins-gateway.conf:20-26` |

`validate_ssl = false` on both (Cloudflare Origin CA is not publicly trusted)
(`infra/terraform/environments/prod/main.tf:482,494`).
Grafana Alloy `remote_write` → Grafana Cloud over **443**
(`infra/vm/gateway/docker-compose.yml:375`).

---

## 5. Firewall rules / ingress restrictions

| Rule | Ports | Source | Target | Evidence |
|---|---|---|---|---|
| `fairwins-allow-cloudflare` | tcp **80, 443** | Cloudflare published IPv4 ranges (live data source) | tag `fairwins-edge` | `chippr-tf-modules/modules/network/main.tf:69-83`; wired `infra/terraform/environments/prod/main.tf:59-60`; bootstrap equivalent `infra/vm/provision.sh:64-67` |
| `fairwins-allow-cloudflare-v6` | tcp **80, 443** | Cloudflare IPv6 ranges | `fairwins-edge` | `chippr-tf-modules/modules/network/main.tf:85-98`; `infra/vm/provision.sh:69-71` |
| `fairwins-allow-uptime-probers` | tcp **443** | Google uptime prober /32s (generated list; empty list fails the plan) | `fairwins-edge` | `chippr-tf-modules/modules/network/main.tf:108-132`; list `infra/terraform/environments/prod/prober-cidrs.json`, loaded `infra/terraform/environments/prod/main.tf:31-32`; `infra/vm/provision.sh:80-84` |
| `fairwins-allow-iap-ssh` | tcp **22** | **`35.235.240.0/20` (IAP TCP forwarding) only — never `0.0.0.0/0`** | `fairwins-edge` | `chippr-tf-modules/modules/network/main.tf:142-156`, default `chippr-tf-modules/modules/network/variables.tf:60-62`; `infra/vm/provision.sh:86-90`; sole Ansible route `infra/ansible/inventory/gcp.yml:7,60-61`, `infra/ansible/ansible.cfg:24` |

Application-layer ingress restrictions (defence in depth):

| Control | Mechanism | Evidence |
|---|---|---|
| **Origin lock** | Cloudflare Transform Rule injects `X-Origin-Auth: <secret>`; the bundler's nginx sidecar 403s a mismatch (`ORIGIN_LOCK_ENABLED=1`); armed state asserted at start | `services/alto-bundler/nginx/bundler.conf.template:17-21,73`; Terraform header name `infra/terraform/environments/prod/main.tf:446`; arm check `infra/vm/common/poststart.sh:39-44`; gateway side passes header through untouched `infra/vm/nginx/fairwins-bundler.conf:53-54` |
| **Geo gate** | Cloudflare zone-wide WAF answers **HTTP 451** to US-sourced requests (legal control, spec 007) — the reason probes bypass Cloudflare | `infra/terraform/environments/prod/main.tf:444`; referenced `infra/vm/nginx/fairwins-bundler.conf:18-22` |
| **Prober allowlist in nginx** | `/__probe/health` includes a generated `allow <prober IPs>; deny all;` | `infra/vm/nginx/fairwins-bundler.conf:24`, `infra/vm/nginx/fairwins-gateway.conf:28`; generated `infra/vm/startup.sh:72-78` |
| **Loopback-only publishes** | Every VM container port is published to `127.0.0.1` or not published at all; only the namespace owner may declare `ports:` | `infra/vm/gateway/docker-compose.yml:15-16,47-48`; `infra/vm/bundler/docker-compose.yml:8-9,26,32`; exporter `:276-278` |
| **CORS allowlists** | bundler nginx map (`https://fairwins.app` only, preflight answered before the origin lock); gateway `ALLOWED_ORIGINS` | `services/alto-bundler/nginx/bundler.conf.template:31-34,64-71`; `infra/vm/gateway/docker-compose.yml:59` |
| **SPA CSP** | `connect-src` carries a deliberate scheme-wide `https:` grant (member-run RPC nodes, spec 069) plus `http://localhost:*` / `http://127.0.0.1:*`; that grant is `connect-src` only | `frontend/nginx.conf.template:164-206` |
| **sshd hardening** | `sshd_config` edits + restart handler (no password/root paths) | `infra/ansible/roles/hardening/tasks/main.yml:8-24` |

---

## 6. Outbound egress

### 6a. From the VMs / services (server-side)

| Destination | Port/Proto | Process | Evidence |
|---|---|---|---|
| Polygon / Mordor public JSON-RPC (`polygon-bor-rpc.publicnode.com`, `polygon.drpc.org`, `rpc.mordor.etccooperative.org`, `geth-mordor.etc-network.info`) | **443** HTTPS | gateway, FinOps exporter, OZ engine | `infra/vm/gateway/docker-compose.yml:63,75,303,308`; engine's own list `services/oz-relayer/deploy/production/config.json:100-119` |
| QuickNode keyed endpoints (`*.quiknode.pro`) | **443** HTTPS | alto (`ALTO_RPC_URL`, single endpoint, no failover), gateway primary, exporter | `infra/vm/bundler/docker-compose.yml:38-40,62-66`; `infra/vm/gateway/docker-compose.yml:161-169`; usage read `services/relay-gateway/src/config/index.js` (`https://api.quicknode.com`) |
| The Graph hosted subgraph (`api.studio.thegraph.com`) | **443** HTTPS | gateway member API | `infra/vm/gateway/docker-compose.yml:117` |
| Bitcoin: `mempool.space/api` (Esplora), `stampchain.io` | **443** HTTPS | gateway `bitcoin/` module | `infra/vm/gateway/docker-compose.yml:137-138`; `services/relay-gateway/src/config/index.js` (`https://mempool.space/api`, `…/testnet4/api`) |
| Polymarket (`gamma-api`, `clob`, `data-api`), OpenSea (`api.opensea.io`), Alphaday (`api.alphaday.com`), Anthropic (`api.anthropic.com`), Hyperliquid (`api.hyperliquid.xyz`), GMX (`arbitrum-api.gmxinfra.io`), Gains (`backend-*.gains.trade`), Across (`app.across.to/api`), Cloudflare Turnstile siteverify, Morpho/Merkl | **443** HTTPS | gateway proxy modules | host list enumerated in `services/relay-gateway/src/config/index.js` |
| Grafana Cloud Prometheus remote_write | **443** HTTPS | Alloy | `infra/vm/gateway/docker-compose.yml:375` |
| Google APIs — Secret Manager (`gcloud secrets versions access`), Cloud KMS (engine signing), Cloud Run describe (alto gate), BigQuery billing export, Logging/Monitoring | **443** HTTPS | `fetch-secrets.sh`, engine, `single-alto-gate.sh`, exporter | `infra/vm/common/fetch-secrets.sh:84`; KMS SA `infra/vm/gateway/docker-compose.yml:308-310` region (`GCP_CLIENT_EMAIL` `:259`); `infra/vm/bundler/single-alto-gate.sh:78`; BigQuery `infra/terraform/environments/prod/main.tf:149-166` |
| Cloudflare IP ranges + `gcloud monitoring uptime list-ips` (provisioning only) | **443** HTTPS | `provision.sh` | `infra/vm/provision.sh:59-60,79` |
| Container registry pulls (`us-central1-docker.pkg.dev`, `ghcr.io`, Docker Hub) | **443** HTTPS | dockerd on both VMs | images `infra/vm/gateway/docker-compose.yml:44,243,288,364,397`; `infra/vm/bundler/docker-compose.yml:22,114` |
| Debian APT + docker repo (provisioning) | **443/80** HTTPS/HTTP | `startup.sh` | `infra/vm/startup.sh:23` |

### 6b. From the browser/SPA (CSP `connect-src`, `frontend/nginx.conf.template:206`)

| Destination class | Port/Proto | Notes |
|---|---|---|
| `https://relay.fairwins.app`, `https://bundler.fairwins.app` | 443 HTTPS | own gateway + bundler |
| EVM RPC hosts (publicnode ×6 chains, `rpc.mordor…`, `etc.rivet.link`, Amoy, Infura) **plus a scheme-wide `https:` grant** | 443 HTTPS | spec-069 member-supplied endpoints; credentials ride a request **header**, never the URL |
| `http://localhost:*`, `http://127.0.0.1:*` | any, HTTP | member-run local node (loopback http only) |
| WalletConnect | **WSS 443** (`wss://relay.walletconnect.com/.org`) + HTTPS to `relay/rpc/verify/pulse/keys/notify/echo/push.walletconnect.*`, `api.web3modal.*` | only `wss://` in the whole policy |
| IPFS gateways (`ipfs.fairwins.app`, `gateway.pinata.cloud`, `ipfs.io`, `cloudflare-ipfs.com`) | 443 HTTPS | mini-app packages fetched as bytes, hash-verified |
| Polymarket, CoinGecko, Morpho, Merkl, The Graph | 443 HTTPS | read APIs |
| `frame-src`: `challenges.cloudflare.com`, `verify.walletconnect.*`, **`connect.trezor.io`** | 443 HTTPS | Trezor popup (`frontend/src/lib/hardware/trezorAdapter.js:1-15`) |
| Pinata pinning (server-side only) | 443 HTTPS | `proxy_pass https://api.pinata.cloud/pinning/pinJSONToIPFS` `frontend/nginx.conf.template:102` |

### 6c. Non-IP local transports (hardware wallets)

| Transport | Mechanism | Evidence |
|---|---|---|
| **WebHID** (Ledger, desktop) | `@ledgerhq/hw-transport-webhid` | `frontend/src/lib/hardware/ledgerAdapter.js:118-119`; capability probe `frontend/src/lib/hardware/adapters.js:43` |
| **WebUSB** (Ledger fallback) | `@ledgerhq/hw-transport-webusb` | `frontend/src/lib/hardware/ledgerAdapter.js:125-126`; `adapters.js:44` |
| **Web Bluetooth (BLE GATT)** | `navigator.bluetooth` / TransportWebBLE | `frontend/src/lib/hardware/ledgerAdapter.js:43-76`; `adapters.js:45` |
| **Native BLE (Capacitor)** | `@capacitor-community/bluetooth-le` `BleClient` behind the `hw-transport` seam | `frontend/src/lib/native/ledgerBleTransport.js:7,127-130`; rung `ledgerAdapter.js:104-105` |

**No SMTP / mail egress exists anywhere in the repo** — searched `smtp|sendgrid|mailgun|nodemailer|:587|:465|port 25` across `services/`, `infra/`, `scripts/`, `docs/runbooks/`: zero hits. Alerting is Cloud Monitoring notification channels (`notification_emails` passed to the monitoring module, `infra/terraform/environments/prod/main.tf:458`), i.e. Google sends the mail, not us.

---

## 7. Dev / CI-only listeners (never production)

| Process | Port | Bind | Scope | Evidence |
|---|---|---|---|---|
| Hardhat node (JSON-RPC) | **8545** | Hardhat default (see §8) | dev + CI (`npm run node`) | `hardhat.config.js:570-571`; CI `.github/workflows/test.yml:1034,1251`; readiness `:1037,1254`; Cypress `RPC_URL` `frontend/cypress.config.js:334,411,463,496,564`; local chainId 1337 default `hardhat.config.js:519` |
| Vite dev server | **5173** | Vite default | dev + all Cypress tiers | `frontend/package.json:10` (`"dev": "vite"`), `:27-30`; `baseUrl` `frontend/cypress.config.js:308`; CI `.github/workflows/test.yml:1357` |
| Vite preview server | **4173**, `strictPort`, `host: true` (**all interfaces**) | `0.0.0.0` | Lighthouse CI | `frontend/vite.config.js:104-107`; routes `frontend/lighthouserc.desktop.json:5-13` |
| alto (local passkey e2e, `--network host`) | **4338** | host netns | CI passkey tier + local | `scripts/e2e/passkey-stack/start-alto.sh:22-25,40-45` |
| alto CORS proxy (SPA-facing) | **4337** | **`127.0.0.1`** | CI passkey tier + local | `scripts/e2e/passkey-stack/cors-proxy.js:20,69-70`; `start-alto.sh:26,63-66`; SPA env `frontend/package.json:24`; CI `.github/workflows/test.yml:1340` |
| relay-gateway (bare `node src/server.js`) | **8788** | `0.0.0.0` (no host arg) | CI passkey tier | `.github/workflows/test.yml:1311,1326,1341,1353` |
| relay-gateway local compose | **8788** published to all ifaces (`"${PORT:-8788}:${PORT:-8788}"`) | host `0.0.0.0` | local dev only | `services/relay-gateway/docker-compose.yml:23-24` |
| oz-relayer engine, local compose | **8080** published to all ifaces | host `0.0.0.0` | local dev only | `services/relay-gateway/docker-compose.yml:44-45` |
| redis, local compose | **6379** published to all ifaces | host `0.0.0.0` | local dev only | `services/relay-gateway/docker-compose.yml:53-54` |
| relay-gateway container smoke | **8788** (`docker run -p 8788:8788`) | host | CI `container-build.yml` | `.github/workflows/container-build.yml:106,114` |
| MCP server container smoke | **8790** (`docker run -p 8790:8790`) | host | CI `container-build.yml` | `.github/workflows/container-build.yml:156,166,187` |
| MCP server **stdio transport** (no socket at all) | — | — | default mode; what an MCP client spawns | `services/mcp-server/src/server.js:4,72,369` |
| UI capture harness — Vite instances | **5199** (default `HARNESS_PORT`), **5198** (`capture-supply`, `capture-assistant-rails` chooser), **5297** (`verify-hardware-bundle`) | `127.0.0.1` | local screenshot harness | `scripts/ui/capture-admin-apps.mjs:34`; `scripts/ui/capture-agentic-access.mjs:49,741`; `scripts/ui/capture-supply.mjs:45`; `scripts/ui/capture-assistant-rails.mjs:593`; `scripts/ui/verify-hardware-bundle.mjs:33,72` |
| UI capture harness — RPC/gateway stubs | **9797** (perps), **9798** (verify), **9799** (brand / protect-hardware / agentic-access gateway), **9801** (account cards), **9821** + **9822** (assistant rails RPC + gateway), **5197** (platform fees stub) | **`127.0.0.1`** in every case | local screenshot harness | `capture-perps.mjs:59,809`; `capture-verify.mjs:53,138`; `capture-brand.mjs:40,159`; `capture-protect-hardware.mjs:33,119`; `capture-agentic-access.mjs:51,134`; `capture-account-cards.mjs:26,100`; `capture-assistant-rails.mjs:61,63,170,209`; `capture-platform-fees.mjs:47,219` |

**URLs that look like listeners but nothing ever binds them** (verified — no server, only
`cy.intercept` or a deliberately dead host):

| URL | Why it is not a listener | Evidence |
|---|---|---|
| `http://localhost:8090` (`VITE_MINIAPP_GATEWAY`) | every request is `cy.intercept`ed; no process serves it (grep for `8090` finds no server, no CI step) | `frontend/package.json:22`; `frontend/cypress/e2e/full/32-miniapps.cy.js:37,92` |
| `http://localhost:8787` (`VITE_BRIDGE_GATEWAY_URL`, and `wait-for-stack.js`'s unused default) | intercepted in e2e; CI overrides `GATEWAY_URL` to `:8788` | `frontend/package.json:22`; `frontend/cypress/e2e/full/39-api-access-console.cy.js:45,71`; `scripts/e2e/passkey-stack/wait-for-stack.js:28` vs `.github/workflows/test.yml:1341` |
| `http://localhost:8899` (`dev:fast`'s `VITE_RELAYER_URL`) | **deliberately** a host nothing serves, so relayer-gated surfaces degrade in the no-chain tier | `frontend/package.json:12` |
| `http://localhost:8020` / `:5001` (graph-node admin / IPFS API) | operator-supplied external graph-node; **no graph-node, postgres (5432) or IPFS process is defined anywhere in this repo** | `subgraph/package.json:12-13` |

---

## 8. Explicitly undetermined / could not be verified

1. **Bind address of `hardhat node` (8545)** — never stated in this repo. `hardhat.config.js:570-571`
   only gives the *client* URL `http://127.0.0.1:8545`. The listener address is Hardhat's own
   default. Not asserted here.
2. **Bind address of `alto` inside its container (3000)** — no `ALTO_HOST`/`ALTO_BIND` env exists
   anywhere (grep confirms only `ALTO_PORT`). `services/alto-bundler/nginx/bundler.conf.template:11`
   asserts "alto binds 127.0.0.1:3000", yet `infra/vm/bundler/docker-compose.yml:26,32` publishes
   `127.0.0.1:3000:3000` and `127.0.0.1:8080:8080` from that container, which a loopback-only
   in-container bind would not satisfy. One of the two statements is stale; the repo does not settle
   which. **Flagged, not resolved.**
3. **`infra/observability/` does not exist in this checkout.** `CLAUDE.md:1172,1178`,
   `docs/runbooks/workstation-operations.md:71-73` and
   `docs/developer-guide/workstation-secrets.md:165` all reference it (local Prometheus/Grafana,
   "bound to loopback", FR-020 at `specs/097-workstation-secrets-observability/spec.md:80`), but the
   directory, its README and any compose file are absent — so **no Prometheus/Grafana/exporter port
   numbers for the workstation stack can be given**. The only port-bearing observability artefacts
   present are `infra/grafana/alloy/config.alloy` and the dashboards/alerts JSON.
4. **Cloud Run injected container port for the SPA and MCP server.** Terraform's module declares no
   `ports` block (`infra/terraform/environments/prod/main.tf:348-349`); the images' own
   `EXPOSE`/`listen` values (8080 and 8790) are what is recorded. The platform-injected `PORT` value
   is not pinned in-repo.
5. **Resolved:** the image-baked `services/oz-relayer/config/config.json:46` carries the same
   `http://localhost:8788/v1/engine/webhook` as the production deploy copy
   (`services/oz-relayer/deploy/production/config.json:46`), so the engine→gateway webhook port is
   consistent across both. Both decommissioned-Cloud-Run manifests are reconciliation records, so
   live port facts were taken from `infra/vm/`.
6. **Terraform firewall/monitoring port literals live outside this repo** in the SHA-pinned
   `chippr-tf-modules`. They are cited from `/home/user/chippr-tf-modules/...` and would be
   unverifiable from `prediction-dao-research` alone.
7. **Staging environment:** `infra/terraform/environments/staging/` exists and sets
   `manage_mcp_server = false` (`:19`), but its `main.tf` was not read in full; staging-specific
   ports (if any differ) are not covered here.
8. **Redis 6379 on the bundler VM:** none — the bundler compose defines no redis. Only the gateway
