# Runbook: FinOps operations

Operating the FinOps exporter, dashboards and alerts (spec 089).

Every alert rule links to a section here by anchor. If you add an alert, add its section — an alert
that says what is wrong but not what to do gets acknowledged and forgotten.

## The one thing to understand first

**A missing number is never shown as zero.** Every source resolves to exactly one of three states:

| State | Means | Alerts? |
|---|---|---|
| `read` | We got a value. | no |
| `unreadable` | The source IS configured and we could not read it. | **yes** — staleness |
| `not-configured` | No credential/config. Nothing is broken; it is not wired up. | no |

On the dashboard: `source_configured == 1 && source_up == 1` is `read`; `configured == 1 && up == 0`
is `unreadable`; `configured == 0` is `not-configured`. The **Source health** table on the overview
shows all three, and it is where you confirm that a zero elsewhere is a real zero.

If a total is missing a live source, the **"sources currently MISSING"** table names it and the total
is partial. An empty table means every live source reported.

## Provisioning

Dashboards and alerts are generated from the catalogue and pushed from the repo. A dashboard edited
in the Grafana UI is **drift** and is overwritten on the next provision.

```bash
npm run finops:generate                        # regenerate infra/grafana/ from the catalogue
npm run check:finops                           # verify coverage + that the committed tree is fresh
GRAFANA_URL=... GRAFANA_API_TOKEN=... npm run finops:provision -- --dry-run
GRAFANA_URL=... GRAFANA_API_TOKEN=... npm run finops:provision
GRAFANA_URL=... GRAFANA_API_TOKEN=... npm run finops:provision -- --detect-drift
```

The token lives in Secret Manager as `finops-grafana-cloud-token`. Never paste it on a command line
on a shared host — export it from `gcloud secrets versions access`.

## Adding a revenue or cost source

This is the workflow the brief made a MUST, and CI enforces it.

1. Add an entry to `FEE_SERVICES` (for a fee) or the appropriate array in
   `packages/finops-catalogue/src/sources.js`.
2. If it needs a new collector, add `services/finops-exporter/src/collectors/<name>.js` and register
   it in `server.js`.
3. `npm run finops:generate`
4. `npm run check:finops` — it names any remaining gap and the exact file to edit.
5. Commit the regenerated `infra/grafana/` tree.

`npm run check:finops` fails on: an uncatalogued fee service, a catalogued metric nothing emits, a
source with no panel, and a stale committed dashboard.

## Alert response

### prepaid-pools

**Prepaid pool runway under 24h / 72h.**

The paymaster deposit and the executor EOAs are prepaid. When one empties, sponsorship or relaying
**stops** and members see failures. This has happened (2026-07-12).

Alerts fire on projected runway, not a balance floor, because a floor that is right at one burn rate
is wrong at another.

1. Check the **Prepaid pool balances** and **runway** panels for which pool and how fast.
2. Top up:
   - `paymaster-137` — send POL to the paymaster's `deposit()`, or `depositTo` the paymaster at the
     EntryPoint. See `docs/runbooks/paymaster-operations.md`.
   - `relayer-137` / `relayer-63` — fund the gas wallet for that chain
     (`docs/runbooks/relayer-operations.md`).
   - `bundler-137` — fund the alto executor EOA.
3. Confirm the balance panel moves within one collection interval (60s).

**A pool with no runway line is not a healthy pool.** It means burn rate is zero or unmeasured. Check
Source health: if the pool is `unreadable`, you are flying blind and should treat it as urgent.

### source-health

**FinOps source stale: `<source>`.**

A configured source has not been read for more than 4× its interval. Its panels show no data and any
total including it is partial.

1. `/status` on the exporter (from the gateway VM: `curl -s localhost:9464/status | jq`) shows every
   source's state and a redacted reason.
2. Common causes: an expired vendor token, an RPC endpoint down, a rotated secret that the container
   has not picked up (secrets are fetched at boot into tmpfs — restart the stack, do not restart one
   container: `systemctl restart fairwins-stack@gateway`).
3. If the source is genuinely retired, set its `status` to `retired` in the catalogue and
   regenerate. Do not leave a dead source alerting; that is how an alert channel gets muted.

### the exporter is not serving at all

**Every panel on every FinOps dashboard reads "no data", and `source-health` alerts on nothing —
because nothing is being scraped.** This is a different failure from any single source going
unreadable, and it looks *quieter*, not louder: the thing that publishes metrics is the thing that
died, so there is no series anywhere carrying the news.

Confirm it in this order — each step distinguishes it from a failure that only *looks* like it:

```bash
# 1. Is the container actually up, or up-and-restarting? RestartCount is the tell; a crash-loop
#    reports `Up 20 seconds` forever and never reaches `(healthy)`.
sudo docker inspect fairwins-gateway-finops \
  --format '{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}'

# 2. Is the port open INSIDE the shared namespace? A host-side `ss` shows nothing either way —
#    the exporter binds loopback in the gateway's netns, so ask from in there.
sudo docker inspect fairwins-gateway-finops --format '{{json .State.Health.Log}}' | tail -c 600

# 3. Kernel OOM kills name the cgroup and the RSS at death. `anon-rss` landing on exactly the
#    mem_limit means it grew into the ceiling rather than spiking past it.
sudo dmesg -T | grep -i 'oom-kill\|Killed process' | tail
```

**If it is OOM:** the exporter's steady state is ~100 MB. A process dying at its `mem_limit` is
almost never "the limit is too low" — it is a collector accumulating something unbounded, and the
overwhelmingly likely candidate is a **log scan whose filter is too wide**. `scanLogs` now refuses
past 50,000 accumulated entries and names the offending `address`/`topics` in the reason, so the
source reports `unreadable` with a usable message instead of taking the process down. If you see
that message, fix the filter — do not raise the cap.

*This happened.* The x402 collector asked Polygon USDC for every `Transfer` and filtered in JS:
~1.1M logs, ~635 MB of JSON, inside a 192 MB container. It was killed 5,966 consecutive times,
always **before `app.listen()`**, so the exporter never served a single scrape in its life and every
panel — including the twenty-four sources that were perfectly healthy — read "no data".

Two properties now stop that shape recurring, and both matter independently:

- **The listener comes up before the first collection**, so a slow or hanging collector can no
  longer keep the exporter dark. An uncollected source reports `unreadable`, which is honest and
  renderable; a closed port is neither.
- **Every collection is deadline-bounded** (120s). A vendor that accepts a connection and goes
  quiet used to hold its source's in-flight slot forever, so that source was never polled again
  while everything else looked fine — the one failure the staleness alert cannot see, because
  nothing ever writes a reading for it to be stale about.

`NODE_OPTIONS=--max-old-space-size` is set on the container for a related reason: **V8 sizes its
heap from host RAM, not the cgroup**. Without it Node looks at the VM's ~2 GB, targets a heap far
above the container ceiling, and feels no pressure to collect before the kernel intervenes.

### the exporter is rate-limited by a vendor

**`-32007 50/second request limit reached` on several on-chain sources at once, shortly after a
restart.** That is the boot fan-out, and it is bounded now — but the shape is worth recognising,
because the budget it spends is not the exporter's own.

The keyed Polygon endpoint is capped at **50 req/s SHARED with the gateway and the bundler**
(`docs/architecture/workbook/06-external-vendors.md`). A reporting service must never be able to
spend a value path's headroom, so two separate bounds apply and they bound different things:

| knob | default | bounds |
|---|---|---|
| `FINOPS_RPC_MAX_PER_SEC` | 25 | requests per SECOND (`chain/rateLimit.js`), evenly spaced |
| `FINOPS_BOOT_CONCURRENCY` | 4 | how many sources collect AT ONCE (`scheduler.collectAll`) |

**Concurrency is not a rate limit.** Four workers issuing 100ms requests is 40 req/s; the same four
against a faster endpoint is 400. Concurrency bounds in-flight work, which is a proxy for rate only
if you know the latency — and it breaks in the direction that hurts exactly when the endpoint gets
quicker. The pace is what the vendor actually measures, which is why both exist.

The default of 25 is half the shared ceiling **by construction**, not by measurement: taking half
is a cheaper guarantee than checking afterwards whether we took too much. `0` disables pacing
rather than deadlocking on a zero rate — a limiter that silently stopped every read would be a
worse outage than the burst it prevents.

**Do not raise these to make a slow boot faster.** The boot pass is a warm-up; since the listener
comes up before it (see above), nothing waits on it. A source not yet reached reports `unreadable`,
which is honest and renderable.

### fees-waived

**Platform fees are being waived (no treasury configured).**

`FeeRouter` emitted `FeeSkippedNoTreasury`: a fee path is live but has no treasury set, so members
are being charged nothing and we are earning nothing. This is invisible in every other view — it
looks exactly like a quiet day.

1. Read the FeeRouter's treasury on the affected chain.
2. Set it via the AdminPanel Fees tab (`FEE_ADMIN_ROLE`), or on-chain.
3. See `docs/runbooks/fee-operations.md`.

The waived amount is the revenue forgone while it was misconfigured. It is never added to any
revenue total.

### revenue-stall

**Revenue stalled on a source that normally earns.**

A source that earned over the last 14 days has earned nothing for 24h. A silently broken fee path
looks identical to a quiet day; only the baseline distinguishes them.

1. Confirm the source is `read` (not stale) — a stale source raises its own alert and this one is
   about a *readable* source reporting nothing.
2. Check the fee rate on chain: a rate set to 0 earns nothing legitimately, and that is a
   configuration change somebody made, not a fault.
3. Check the product surface: is the path reachable? Predict hides off Polygon; Perps hides when
   `PERPS_ENABLED` is false; a mini-app can be un-`launchable`.

### cost-anomaly

**Daily cost above 2× the trailing 7-day mean.**

1. On the **Cost** dashboard, find which `gcp_service` moved (GCP is broken out per service).
2. Common causes: a runaway Cloud Run scale-out, a BigQuery query scanning more than expected, image
   storage growth in Artifact Registry.
3. Remember the **basis** label: only GCP is `billed`. A jump in a `modelled` figure is a jump in
   *usage* or in a plan price somebody edited, not necessarily in an invoice.

### fx-rate

**FX rate is stale — USD figures unavailable.**

The Chainlink feed backing every USD conversion has not updated. USD cost figures **stop being
produced** rather than being converted at a rate we know is old. Native-unit figures are unaffected
and remain exact.

1. Check the feed on chain and the RPC health for the FX chain.
2. Nothing is broken financially; this is a display degradation, and the dashboard says so.

## Per-source notes

### fee-revenue

The 8 `FeeRouter` services. Read from `FeeCharged` events over **finalized** blocks, so a reorg
cannot make a counter go backwards. Several services ship at 0 bps — a genuine zero here is expected
and is not the same as an unread source.

Counters are cumulative **since the exporter started** (cursors are in memory). A restart resets the
window; the dashboard states this rather than implying all-time totals.

### membership-revenue

Two numbers that are **never summed**:

- `membership-received` — withdrawn to treasury (`FeesWithdrawn`). Money that has arrived.
- `membership-accrued` — earned and still in the contract. Money that has not.

Adding them double-counts every fee that has since been withdrawn. This is the spec-071 rule; a
revenue dashboard is exactly where somebody would break it.

### referral-revenue

Mostly `not-configured` today, and correctly so: `OPENSEA_REFERRAL_ADDRESS` is empty and the
Gains/GMX codes are unset in production — no code is registered, so there is nothing to earn.
Polymarket's builder code **is** registered; its weekly rewards need `POLYMARKET_API_KEY`.

To light one up, register the code with the venue and set the corresponding env var. The source
moves from `not-configured` to `read` on the next interval.

### gcp-cost

The **only** `billed` cost source. From the BigQuery `billing_export` dataset.

- It **lags hours**. The lag is exported as `source_lag_seconds` and shown on the panel. Do not
  compare it to a chain read as if equally fresh.
- It is **not retroactive** — it holds nothing from before the export was enabled.
- Querying it is billable, which is why the interval is 6h and `maximumBytesBilled` is capped.

Access is dataset-scoped `roles/bigquery.dataViewer` plus project `roles/bigquery.jobUser`. Project-
level dataViewer is deliberately **not** granted: this is a shared project.

### cloudflare-cost

**Cloudflare publishes no dollar figure.** The GraphQL Analytics API returns requests and bytes; the
dollar figure on the dashboard is `modelled` from `FINOPS_CLOUDFLARE_PLAN_USD`.

The usage is real and is exported separately as `vendor_usage`. Token needs Zone → Analytics: Read.

### quicknode-cost

**QuickNode reports credits, not dollars.** `GET /v0/usage/rpc` returns API-credit consumption.

- On a metered plan set `FINOPS_QUICKNODE_USD_PER_MCREDIT`.
- On Flat Rate RPS set `FINOPS_QUICKNODE_PLAN_USD`; credits are then informational only, because
  spend is decoupled from usage.

If the plan includes the enterprise `/exporter/prometheus` endpoint, set `QUICKNODE_PROMETHEUS_URL`
— it is the vendor's own metrics and is preferred over parsing the usage JSON.

**The Admin API answers errors with HTTP 200 and an `error` field**, so a reachable endpoint proves
nothing about the account. That envelope is now reported verbatim (through the Reading redactor)
rather than being folded into the generic "no recognisable credit field", which is a true statement
that sends you looking for a parser bug while the vendor is saying something specific about the
account. If this source is `unreadable` with a vendor message, the message is the answer.

### pinata-cost

**A paid vendor on the member write path, catalogued late.** Wager creation, open challenges and
encrypted data backup all pin JSON here with **no fallback**, and mini-app packages are published
under CIDs that are keccak-committed on chain. The vendor workbook recorded "we pay them (not
catalogued as a cost source)" from the day of the audit; neither `check:finops` discovery route
could find it, because it registers no FeeRouter `serviceId` and no gateway payee env — the money
flows the other way, and both routes look for money going out to someone else.

**Storage is measured; the dollar figure is not.** `GET /data/userPinnedDataTotal` returns
`pin_count`, `pin_size_total` and `pin_size_with_replications_total` — never money. Both size
figures are published under separate `metric` labels rather than electing one: which of them a plan
bills against is the vendor'"'"'s business, and quietly picking would put an unstated assumption inside
a cost system. Set `FINOPS_PINATA_PLAN_USD` to model the cost; unset reports `not-configured`, and
here that default is more than doctrine — **Pinata is a paid vendor, so a defaulted `0` would not be
a cautious placeholder, it would be a figure known to be wrong.**

#### The credential is NOT the pinning JWT

> `PINATA_JWT` (workstation, `publish` profile) and `VITE_PINATA_JWT` (SPA runtime) authorise
> `pinJSONToIPFS` and `pinFileToIPFS`. They can **write** to a member-facing store. Neither may ever
> reach the exporter, whose entire guarantee is that it holds nothing that can change anything
> (FR-026) — and note the `fetch-secrets.sh` boot guard only matches names that look like signing
> keys, so a pinning JWT would pass it silently.

Provision a **third** key instead:

1. Pinata dashboard → **API Keys** → New Key. Turn **admin off**. Enable
   **only** `data/userPinnedDataTotal`. Nothing else — not `pinList`, not any `pinning/*` scope.
2. Store it as Secret Manager `finops-pinata-read-jwt`; `fetch-secrets.sh` emits it to the exporter
   as `FINOPS_PINATA_READ_JWT` (optional — absent is `not-configured`, not an outage).
3. Restart the whole stack, never one container: `systemctl restart fairwins-stack@gateway`.

**A 401/403 on this source almost certainly means SCOPE, not a dead key**, which is why the
collector says so in the reason rather than reporting a bare "unauthorized". This vendor has already
burned that exact distinction in production: on 2026-08-30 a key valid for `pinFileToIPFS` but not
`pinJSONToIPFS` authenticated correctly, passed `testAuthentication`, and broke every member write.
Check what the key is scoped for before rotating it.

### gateway-upstream-usage

Measured request counts from the relay-gateway (spec 106, #1447): per assurance tier and per
platform-credentialed upstream. **Not a dollar** — it is the attribution series beside the vendor
cost panels, and the one that says where the QuickNode account's shared 50 req/s went.

- **Enable**: set `METRICS_PORT` on the gateway (compose-network internal — **never publish this
  port to the host**) and `FINOPS_GATEWAY_METRICS_URL` on the exporter (e.g.
  `http://gateway:9091/counters`). Unset ⇒ the source reads `not-configured`, which is the honest
  state, not a failure.
- **Unreadable** means the exporter cannot reach the gateway's counters port — a scrape problem,
  never "no traffic". Check the compose network and that the gateway logged the counters listener
  at boot (a bind failure logs and stands down; it never takes the gateway with it).
- **Counters are cumulative-since-boot.** A restart is an ordinary Prometheus counter reset:
  `rate()` shows a moment of zero slope, never a negative and never a phantom level. This is why
  in-process counters are admissible here when the catalogue rejects them for revenue LEVELS — the
  reasoning lives at `services/finops-exporter/src/collectors/gateway.js`.
- **Labels are bounded by construction** (tiers from the fixed ladder, upstreams from the route
  table) and re-bounded by the collector, which drops anything outside the expected sets rather
  than trusting the scrape target with a cardinality promise.

### thegraph-cost

**The tier is which endpoint the app calls — it is not a setting anywhere.**

| endpoint in `frontend/src/config/networks.js` | what it is | what it costs |
|---|---|---|
| `api.studio.thegraph.com/...` | Subgraph Studio, the free **development** tier | $0, no GRT consumed |
| `gateway.thegraph.com/api/<key>/...` | the **decentralized network** | query fees in GRT, from a billing balance on **Arbitrum One** |

Today every configured `subgraphUrl` is a Studio endpoint, so `FINOPS_THEGRAPH_PLAN_USD=0` on the
gateway node is an asserted zero whose evidence is in the repo rather than on a billing page — a
property of the endpoint we call, not a guess about an account.

**Two things about the paid tier that are easy to get wrong.** GRT held on **Ethereum L1 does not
pay query fees**; the billing balance is an Arbitrum One contract, funded through the Studio billing
page. And the free allowance **does not bill over — it fails**: exceeding it makes queries return
errors, so the day this line becomes wrong is also the day subgraph-backed surfaces start degrading.
On Polygon that would arrive on top of the subgraph already indexing a dead registry.

#### If you publish to the decentralized network

`check:finops` **C6** fails the build if any `subgraphUrl` contains `gateway.thegraph.com` while a
committed deployment still asserts `FINOPS_THEGRAPH_PLAN_USD=0`. That rule exists because this
transition is a one-line edit to a networks file, made by somebody thinking about indexing, that
silently invalidates a cost figure on a dashboard nobody rechecks. When it fires:

1. Fund the GRT billing balance on **Arbitrum One** (Studio → Billing).
2. Set `FINOPS_THEGRAPH_PLAN_USD` to the modelled monthly spend on the gateway node.
3. Consider promoting this source from a flat subscription to a real read: the billing balance is an
   on-chain balance on a chain this exporter can already reach, which makes it a **prepaid pool** —
   the shape that gets burn-rate and runway alerting for free (FR-015). It is deliberately NOT that
   today, because a pool with no balance and no burn would alert on nothing while looking monitored.

### self-cost

What this system costs: the Grafana Cloud plan plus the BigQuery query spend the exporter incurs.
Catalogued on purpose — a FinOps system that hides its own cost is not credible about anything else.

The free tier really is $0 — but assert it by setting `FINOPS_GRAFANA_PLAN_USD=0`. Left unset, the
source reports `not-configured`, because "we confirmed the free tier" and "nobody ever set this" are
different facts and a defaulted zero renders as the first while meaning the second.

**Asserted on the gateway node 2026-09-11** (operator-confirmed free tier). It had been unset since
the exporter shipped, which was honest and also indistinguishable, on the panel, from the QuickNode
source beside it that was genuinely broken — which is why the detail dashboards now carry their own
`Source health` table rather than making the reader go to the overview to tell the two apart.

**Every source that reuses the flat-subscription modeller must appear in `flatSubscriptions`** in
`services/finops-exporter/src/config/index.js`. A missing key does not mean "no price declared" — it
falls through to the QuickNode credit path and reports `not-configured` citing `QUICKNODE_API_KEY`,
a message about a vendor it has nothing to do with. `alphaday-news-api` shipped that way with spec
109. Alphaday is also the one entry whose default IS `0` rather than `null`, and only because its
vendor is keyless: there is no account, so there is no tier it could silently be on.

It stops being zero the moment the series budget is exceeded, which is what the cardinality rules
exist to prevent.

### planned-sources

Four sources are declared and **not live**. They render as *not yet live*, contribute nothing to any
total, and emit no metric — a `planned` source showing `$0` would be indistinguishable from a shipped
source earning nothing (FR-014). They fall into three groups, and the difference decides how each is
watched.

**Readable by nobody, and not cash.** `referral-guttertoken` (spec 104): when a member funds a
GutterToken account through the referral-coded signup link on the Assistant tab, GutterToken credits
FairWins' own GutterToken account with prepaid usage credit — in-kind, non-cashable, spendable only on
model calls from that account. It is catalogued `planned` rather than `live` + `not-configured` like
the other referrals for a reason that will not change with configuration: GutterToken exposes no
balance, usage or referral endpoint, so **no collector could ever read the figure**; it is visible
only on GutterToken's billing page. The referral code lives in the tenant manifest
(`settings.assistant.guttertokenReferralCode`) and ships in the frontend, which is also why C2b cannot
see it — the gateway reads no env var for it, so the entry carries `moneyPath: { namespace:
'guttertoken' }` with no `payeeEnv`. Do not promote it to a USD revenue line: if P3 (a FairWins-owned
GutterToken account as the FairWins rail's upstream) is adopted, this credit accrues on the same
account `assistant-model-api` would be billed to and is an **offset against that cost**, to be noted
on the cost entry, never summed with cash revenue. No code is registered yet.

**Does not exist anywhere.** `miniapp-licenses` and `wager-platform-fee`: `MiniAppRegistry` has no
fee or `payable` function, and `WagerRegistry` takes no platform cut. There is nothing that could
produce a value, and nothing to watch for.

**Built, but offered on no deployment.** `x402-agent-payments` and `assistant-model-api`: the code is
complete and tested, and both are one uncommented line in `infra/vm/gateway/docker-compose.yml` away
from moving real money — x402 takes USDC to the platform treasury per priced request, and the
assistant calls a metered model API. Because enabling them is a config change rather than a code
change, each declares a `moneyPath` in the catalogue and **C2b fails the build** the moment a
committed deployment sets `X402_PAY_TO` or `ASSISTANT_ENABLED`:

```
[C2b] Source 'x402-agent-payments' is catalogued 'planned' — "nothing to read" — but
      X402_PAY_TO is configured in infra/vm/gateway/docker-compose.yml:77.
```

That failure is the intended sequence, not an obstacle to route around: switching on a revenue rail
is precisely the moment nobody remembers the dashboard.

**Promoting any of the four.** Change `status` to `live`, give it a `metric` and a collector under
`services/finops-exporter/src/collectors/` that returns `read | not-configured | unreadable`, then
`npm run finops:generate` and commit. The gate already knows its name.

For `x402-agent-payments` specifically, the collector is the real work and must be designed before
the rail is enabled: settlements are EIP-3009 USDC transfers into the **same treasury** that receives
FeeRouter fees and membership withdrawals, so summing arrivals at that address would double-count.
The distinguishing trace is the token's `AuthorizationUsed` event in the settling transaction.

## Rotating a credential

```bash
# 1. Add a new version (payloads are never in Terraform state — guardrail G-04)
printf '%s' "$NEW_TOKEN" | gcloud secrets versions add finops-cloudflare-token \
  --project=chippr-bots-site-wp --data-file=-

# 2. Secrets are fetched into tmpfs at BOOT. Restart the whole stack, never one container —
#    the containers share one network namespace.
gcloud compute ssh fairwins-gateway --tunnel-through-iap --command \
  'sudo systemctl restart fairwins-stack@gateway'

# 3. Confirm
curl -s localhost:9464/status | jq '.config.credentials'
```

`/status` reports credential **presence** only, never any part of a value.

## What this system is not

- Not an accounting system. It is operational telemetry, not an authoritative financial record, and
  nothing here is suitable for tax or revenue recognition.
- Not a spend control. It observes and alerts; a human acts.
- Not member-facing. It is an operator tool with no public surface.
