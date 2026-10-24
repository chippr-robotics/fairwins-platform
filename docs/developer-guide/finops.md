# FinOps: revenue and cost observability

Spec 089. Real-time financial telemetry for the platform — every revenue stream and every cost
centre, in Grafana Cloud, with alerting on the things that cost money when they break.

## The shape of it

```
packages/finops-catalogue     THE list of every revenue and cost source
        │
        ├─→ services/finops-exporter    polls each source, emits Prometheus metrics on loopback
        │        └─→ Grafana Alloy (sidecar) ─→ Grafana Cloud
        │
        ├─→ scripts/finops/generate-dashboards.js  →  infra/grafana/  (committed)
        │
        └─→ scripts/finops/check-finops-coverage.js  →  npm run check:finops  (CI gate)
```

The service is not the interesting part. **The catalogue is.** One file declares every source, and
the exporter, the dashboards and a CI gate all derive from it — which is what turns "remember to
update the dashboard" into a build failure.

## Five rules

### 1. A value exists only in state `read`

Every source resolves to exactly one of `read` / `not-configured` / `unreadable`, and
`services/finops-exporter/src/reading.js` is where that is enforced: three constructors, and only one
of them accepts a number. There is no code path that produces "zero because the read failed".

This matters more here than anywhere else in the codebase. On a cost dashboard, a source that failed
to load and a source that cost nothing are the difference between *"we are fine"* and *"we are
bleeding and blind"* — and they render identically the moment a zero is allowed to stand in for an
absence.

The metrics express it in PromQL alone:

```
read            source_configured == 1  and  source_up == 1
unreadable      source_configured == 1  and  source_up == 0
not-configured  source_configured == 0
```

`not-configured` is a first-class state, not a soft failure. It says "we have not wired this up",
which somebody can act on. `$0` says "we wired it up and it earns nothing", which would be false.
Three of the four referral sources are `not-configured` in production today, correctly.

### 2. `billed` and `modelled` are different kinds of number

**Neither Cloudflare nor QuickNode publishes a dollar figure on our plan** (research R1). Cloudflare's
GraphQL API returns requests and bytes; QuickNode's Admin API returns API credits. Only GCP's
BigQuery billing export says what we were actually charged.

So every cost metric carries a mandatory `basis` label:

- `basis="billed"` — from a billing record. GCP only.
- `basis="modelled"` — usage × a rate we typed into config, or a declared flat subscription.

Panels label modelled figures as modelled, totals break out by basis, and vendor **usage** is
exported separately as `vendor_usage` because usage is a fact even when the dollar figure is a model.

Never collapse the two. Presenting our own arithmetic as an invoice is the specific dishonesty this
label exists to prevent.

A unit with no rate yields **no USD figure at all** — `rateFor` returns `null`, and `aggregate`
suppresses the roll-up and names the unit that blocked it. It deliberately does not return `0` for a
testnet unit: that would make the unit look convertible (silently contributing $0 to a total) and,
because the rate is keyed on the unit rather than the network, would price Ethereum Classic *mainnet*
gas at nothing. Understating a cost is the one direction this system must never fail in.

### 3. Alert on runway, not on balance

The paymaster deposit and the executor EOAs are prepaid pools. When one empties, sponsorship or
relaying **stops**. A static balance floor is only correct at the burn rate it was chosen for — at
10× traffic a "safe" floor is minutes of warning — so alerts fire on `balance / burn_rate`.

Two subtleties in `burnRate.js`, both of which fail toward *looking healthy*:

- Only **decreases** count as burn. A top-up inside the window would otherwise produce negative burn,
  which divides into infinite runway.
- When burn is zero or unknown, runway is **`null` and the metric is absent** — never `+Inf`, which
  every alert rule reads as a pool in perfect health.

Staleness alerts are separate and never resolve a runway alert. A balance that cannot be read is not
a healthy balance.

### 4. Labels come from bounded enumerations

`source`, `kind`, `status`, `unit`, `chain`, `basis`, `pool`, `gcp_service` — all declared in
`packages/finops-catalogue/src/schema.js`. Roughly 250 active series, and that number is a constant
rather than a function of member count.

Never label by member address, wager id, or transaction hash. Any of them exhausts the Grafana Cloud
tier within days and turns the observability system into a cost centre bigger than what it observes.
Alloy carries a relabel rule that drops address-shaped label values as a last line of defence; the
primary defence is that the exporter never emits one.

### 5. The exporter must be readable before it is complete

**Availability of the reporting surface outranks completeness of any figure on it.** The listener
comes up first; the first collection runs behind it. A source nobody has reached yet reports
`unreadable`, which is an honest state the dashboards can render — a closed port is not a state at
all, and it takes every healthy source down with the broken one.

Three mechanisms hold that, and each closes a hole the others cannot see:

| Mechanism | Where | What it stops |
|---|---|---|
| `app.listen()` before `scheduler.collectAll()` | `src/server.js` | one slow collector keeping every panel blank |
| 120s deadline per collection | `reading.js#attempt` | a vendor that never answers holding its in-flight slot forever, so that source is never polled again |
| 50,000-entry cap per log scan | `chain/logs.js#scanLogs` | a filter that forgot to narrow exhausting the container instead of failing |

This is not defensive theatre. Ordering `collectAll()` ahead of `listen()` is what took this system
off the air entirely: the x402 collector asked Polygon USDC for every `Transfer` and filtered
client-side — ~1.1M logs, ~635 MB of JSON, in a 192 MB container — so the process was OOM-killed
5,966 consecutive times, always before the port opened. The exporter never served one scrape, and
every dashboard read "no data" for **twenty-five sources that were fine**.

Note what the FR-001 honesty rules could and could not do about that. They worked exactly as
designed *within* a scrape: no zero was ever fabricated. But they are rules about what a **served**
metric may say, and they have nothing to say about a metric that is never served. "Absent means
unknown" is only readable as unknown when something is there to be absent *from*.

The corollary for filters: **narrow on chain, not in JS.** Every indexed parameter the RPC can match
is one it should match, because the memory cost lives in what you ask for and no assertion about the
returned value can see it. That is why `test/x402Collector.test.js` asserts on the *request* — its
provider fake honours the filter, and the previous one (`getLogs: async () => logs`) could not
distinguish a treasury-scoped scan from a chain-wide one, which is precisely how this shipped green.

## Adding a source — the rule the brief made a MUST

```bash
# 1. declare it
$EDITOR packages/finops-catalogue/src/sources.js

# 2. collect it (skip if an existing collector covers it)
$EDITOR services/finops-exporter/src/collectors/<name>.js

# 3. regenerate + verify
npm run finops:generate
npm run check:finops
```

`check:finops` runs in CI and fails on:

| Check | Fails when |
|---|---|
| C1 | a catalogue entry is malformed |
| C2a | a `FeeRouter` service exists in the platform with no catalogue entry (or vice versa) |
| C2b | the relay gateway configures a platform payee no catalogue entry claims |
| C3 | a catalogued metric is one no collector emits |
| C4 | a catalogued source has no dashboard panel |
| C5 | the committed `infra/grafana/` tree is stale |

Every failure names the file and the edit that resolves it. C2a reads the fee services out of
`frontend/src/lib/fees/feeQuote.js` and `services/relay-gateway/src/fees/onchain.js`, both of which
are themselves checked against the contracts by the spec-060 suite — so the loop closes at the chain.

### C2b: money paths that are not FeeRouter services

C2a is a complete answer for one kind of revenue and a blind spot for every other. Its whole
discovery surface is `keccakId('x.y')` over two files, so it enumerates FeeRouter services and
nothing else — and the x402 rail (spec 096) takes USDC straight to the platform treasury without
registering a service id. It was invisible to this gate *by construction*: the catalogue could stay
silent about it forever and CI would stay green. **A gate that cannot see the source is not
protection.**

C2b widens the question from "is every fee service catalogued" to "is every place the platform is
named as a recipient of funds catalogued". The gateway holds no key and hardcodes no address, so a
recipient we control arrives as configuration — an env var, read from the environment, whose name
ends in a payee suffix (`_PAY_TO`, `_TREASURY`, `_REFERRAL_ADDRESS`, `_REF_CODE`, …). A payee
written into source as a literal address is caught too, so skipping the env var does not skip the
gate.

Each discovered namespace must be claimed by a catalogue entry:

```js
moneyPath: { namespace: 'x402', payeeEnv: 'X402_PAY_TO', enableEnv: 'X402_ENABLED' },
```

Five namespaces exist today (`opensea`, `polymarket`, `perps-gains`, `perps-gmx`, `x402`); four were
catalogued long before this rule, which is what says it is a general rule rather than a plug for one
hole. C2b also refuses to let a **`planned`** entry keep claiming there is nothing to read once a
committed deployment file sets its payee or its enable flag — see
[planned-sources](../runbooks/finops-operations.md#planned-sources).

What C2b deliberately does **not** match is a bare `recipient`: the gateway is full of them (Across
quotes, intent structs, Seaport orders) and every one is the *member's* address. The discriminator is
not "an address is named" but "an address we control is named".

Discovery is one-sided, and the header of `check-finops-coverage.js` says so at length: a new vendor
**cost** leaves no mechanical trace, because `fetch(vendor)` is identical whether the vendor meters
the call or serves free public data. The cost side is held by C1's mandatory `basis` and by review.

`npm run test:finops-gate` drives every C2b rule against a fixture that must be rejected — including
the catalogue with the x402 entry removed, which is the state this gate was green in.

**Never hand-edit `infra/grafana/`.** It is generated, and C5 will tell you so.

## What is deliberately not live

A planned source declares **no metric**, emits no value, and is excluded from every total. It renders
as *NOT YET LIVE*. The alternative — showing `$0` — is indistinguishable from a shipped source
earning nothing, and would quietly close a question that is still open.

Four sources are `status: 'planned'`, in three groups:

**Does not exist anywhere.** `miniapp-licenses` and `wager-platform-fee` were named in the brief as
revenue streams and neither exists on chain: `MiniAppRegistry` has no fee, price or `payable`
function, and `WagerRegistry` takes no platform cut.

**Built, offered nowhere.** `assistant-model-api` (cost) is complete, tested code behind a flag that
is commented out in the only production deployment, so not one billed token exists. `planned` is
still the honest status — reporting `$0` would say "offered, and nobody used it" — but because
enabling it is a *config* change rather than a code change, it declares a `moneyPath` and C2b turns
that enable into a build failure. That is the point: switching on a revenue rail is precisely the
moment nobody remembers the dashboard. (`x402-agent-payments` was in this group until it was promoted
to `live` together with the deployment that switched it on — the sequence C2b exists to force.)

**Readable by nobody, and not cash.** `referral-guttertoken` (spec 104) is GutterToken's referral
credit on FairWins' own GutterToken account when a member funds one through the Assistant tab's
signup link — in-kind, non-cashable, spendable only on model calls. Unlike the other referral
entries it can never move to `read` by setting an env var: GutterToken exposes no balance, usage or
referral endpoint, so no collector could read it, and the code lives in the tenant manifest rather
than in gateway config, so C2b cannot see it either. It is catalogued on purpose, to be visible, and
if P3 is adopted it is an offset against `assistant-model-api`, never a revenue line.

`assistant-model-api` declares `basis: 'modelled'` now, while nothing is at stake. This exporter
holds no Anthropic billing credential, so any dollar figure it ever publishes will be token counts
times a rate typed into a config file. Only GCP is `billed`.

## Deployment

The exporter and Alloy run as two more containers in the **gateway VM's network namespace**
(`infra/vm/gateway/docker-compose.yml`), the same pattern the engine and redis use — so Alloy reaches
`localhost:9464` verbatim.

- The exporter binds **127.0.0.1** and declares no `ports:`. nginx does not proxy it; it has no
  member-facing surface.
- It holds **read-only vendor credentials only**, in their own tmpfs env file.
  `fetch-secrets.sh` refuses to boot if key material lands there — it reports on money and must never
  be able to move any.
- Secrets are fetched at boot. After rotating one, restart the **whole stack**
  (`systemctl restart fairwins-stack@gateway`), never a single container.

GCP access is `roles/bigquery.jobUser` at project level plus **dataset-scoped**
`roles/bigquery.dataViewer` on the billing export. Project-level dataViewer is deliberately not
granted: `chippr-bots-site-wp` is shared with unrelated Chippr workloads.

## Local development

```bash
npm test --workspace fairwins-finops-exporter   # 46 tests; the honesty suite is the load-bearing one
node services/finops-exporter/src/server.js     # boots with everything not-configured, honestly
curl -s localhost:9464/metrics
curl -s localhost:9464/status | jq              # per-source states, credential PRESENCE only
curl -s localhost:9464/v1/finops/summary | jq   # totals with completeness verdicts
```

With no configuration at all the exporter starts and reports every source as `not-configured`. That
is the correct output, and it is worth looking at once — it is the shape every panel takes before a
credential lands.

See also `docs/runbooks/finops-operations.md` and `specs/089-finops-dashboard/`.
