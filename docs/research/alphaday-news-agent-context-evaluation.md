# Token news + external data as agent context — estate evaluation

**Status**: Evaluation — input to a `/speckit-specify` for issue #1465
**Date**: 2026-09-06
**Scope**: Issue #1465 asks for asset news on the portfolio and trade surfaces, proposing the
[Alphaday](https://alphaday.com) API. The operator extended the scope with a second question: should
the external data be tokenized and stored in a **graph database** so it can be injected into the
context window of assistant/agent calls? This document evaluates both halves against the estate as
it stands (specs 057, 082, 089, 095, 096, 097, 104) and recommends a shape. It is an evaluation,
not a spec: it reserves no number and commits to no requirements.

Sources: Alphaday's public positioning as served on 2026-09-06 ("The Crypto Data Layer for Humans,
Apps & AI Agents"; "free API & MCP, no signup required" — **unverified, JS-rendered site; probe at
spec time**); a read of the relay-gateway read-proxy modules (`src/perps/`, `src/polymarket/`),
`@fairwins/assistant-contract`, `docs/developer-guide/agentic-chat.md`, the FinOps gate (spec 089),
and the deployed infrastructure (`infra/vm/`, `infra/terraform/`).

---

## 1. What is actually being asked

Two features are folded into one issue, and they have very different estate footprints:

| Half | Ask | Estate footprint |
|---|---|---|
| **A. Member news surfaces** | News panel on a selected portfolio token; news feed under the amount entry on a selected trade pair | A fourth instance of an existing, well-worn pattern |
| **B. Agent context store** | Tokenize external data, persist it in a graph DB, retrieve it into assistant context | The estate's **first persistent database**, a new data class, and a change to the assistant's context architecture |

Half A is a P3 frontend feature that the estate already knows how to build. Half B is an
architecture decision wearing a feature's clothes. They should not ship as one spec.

## 2. Half A: the estate already has the shape

### 2.1 The read-proxy pattern (specs 057, 082) is the template

`services/relay-gateway/src/perps/` is the closest precedent and nearly a drop-in template: a
READ-ONLY optional module proxying public venue APIs, pipeline per request
`killswitch → enabled check → param validation → quota → cached fetch`, per-venue failure isolation
(`read | degraded`, a degraded source NAMED and its rows omitted — never zeros, never
stale-as-live), TTL cache with a `STALE_FACTOR` beyond which stale is treated as gone, and a
single-flight global cache for feeds whose cost is per-platform rather than per-member.

A news module (`services/relay-gateway/src/news/`, `NEWS_ENABLED`, default off) is the same thing
with one venue. Off ⇒ `503 news_unconfigured`, SPA hides the surface — the perps/bitcoin/member-API
degradation contract verbatim.

Two perps lessons transfer directly:

- **The gateway is ONE IP for every member.** Hyperliquid's per-IP rate limit is why the perps
  module budgets request weight and slows the global feed rather than the member-specific one.
  Whatever Alphaday's limits are, they are paid from one bucket; news is a global-per-asset feed,
  so a single-flight cache per asset id (TTL on the order of minutes — news does not change
  per-member) makes the cost fixed rather than per-member. This must be measured at spec time, not
  assumed.
- **Normalizer provenance.** Perps documents every scale decision in `normalize.js` because a
  mis-scaled number is a fabricated fact. The news equivalent is **asset identity**: mapping our
  `(chainId, tokenAddress)` portfolio entries and trade-pair symbols to Alphaday's asset ids.
  Rendering the wrong token's news under a ticker collision (there are dozens of "ARB"s) is the
  same class of defect as a mis-scaled funding rate. The mapping is a first-class contract artifact,
  not an implementation detail.

### 2.2 Frontend surfaces follow the honesty rules as-is

Portfolio token detail and the trade pair view get a news card behind a tenant feature flag
(spec 072, e.g. `news`, off for tenants that don't want third-party content). Three states —
`read` / `unreadable` / `not-configured` — with unreadable rendering a sentence + retry, never an
empty feed pretending to be "no news". Every item links out with attribution and is rendered as
**text, never HTML** (headline, source, timestamp): news bodies are arbitrary third-party content
and the CSP/`replyLinks` posture applies to them exactly as it does to assistant replies.

### 2.3 The assistant gets news as a TOOL, and that is the whole of half B it needs

Spec 104's tool table already contains the pattern: `get_prediction_markets` and `get_perps_pairs`
are **public tools that proxy gateway reads**. `get_token_news` is a third: one entry in
`@fairwins/assistant-contract` (the ONE source), available on both rails, executed in the browser
under the existing ≤4-round loop, with the MCP server picking it up through the
`toolDefs.snapshot.json` parity mechanism at zero extra cost. External agents (the member's own
Claude, etc.) then reach token news through the existing member API / MCP server / x402 rails with
**no new authentication surface and no new infrastructure**.

The injection posture is already written down and it is the binding constraint
(`agentic-chat.md`: "Prompt injection is the design constraint. Tool results carry text other
people wrote"). News is **100 % counterparty-authored text** — the purest case the assistant will
ever handle. The existing rules hold unchanged: a tool result never makes the app do anything, no
`navigate`, no `build_intent` in-app, `replyLinks.js` stays the only path from model text to a
click, and the honest-result wording in `assistant-contract` should label news content as reported,
third-party, and not advice.

### 2.4 Cross-cutting gates this touches (all mechanical)

- **FinOps (spec 089)**: a new vendor is a catalogue entry or C2 fails CI. If Alphaday is genuinely
  free/keyless, it enters as a cost source with `basis: modelled` at $0 / `not-configured` —
  "free tier we depend on" is itself a fact worth a runway-style eye. No revenue path, no C2b
  namespace.
- **Secrets (spec 097)**: only if a key materializes — registry entry + both tfvars lists. If the
  API is keyless at MVP, there is deliberately nothing to add.
- **E2E matrix (spec 094)**: the reservation PR carries the `matrix.json` row; the flows are
  no-chain tier (news is validatable without a chain, so the admission rule *forbids* the on-chain
  tier).
- **MCP**: `services/mcp-server` is dependency-free and stays so; it consumes the gateway route
  like every other tool. We do **not** embed Alphaday's own MCP server anywhere — a member's
  external agent that wants deep Alphaday access can mount Alphaday's MCP directly, off our estate.

## 3. Half B: the graph database — evaluated, and recommended against *for this feature*

The goal — external context available to assistant calls — is right. The proposed mechanism fights
four deliberate properties of the estate:

**1. The estate has no persistent database, on purpose.** The only datastore deployed anywhere is
an *ephemeral* redis inside the engine's network namespace with persistence explicitly disabled
(`--save "" --appendonly no`). The gateway is stateless by construction — spec 060 says so about
fee config, spec 095's revocation is in-process *because* there is nothing durable to write to, and
spec 089's exporter is read-only by construction. A graph DB is the first stateful service in the
estate: Terraform on the shared GCP project (spec 087), backups, an attack surface holding data,
a new cost line, and a new class of operational failure — bought for a P3 news feed.

**2. News decays faster than a graph pays back.** The value of a news item to a trading decision
has a half-life of hours; entity extraction, embedding and graph maintenance are costs paid up
front for retrieval value that mostly expires before it is queried. The TTL-cache pattern already
delivers the fresh slice — which is the only slice half A needs. A knowledge graph earns its keep
on *stable* relationships (protocol ↔ token ↔ chain ↔ category), and that is exactly the layer
**Alphaday itself is selling** ("structures every crypto data type into one queryable layer").
Building our own graph over their feed rebuilds their product, one step staler, with our
operational budget.

**3. Context-push breaks the assistant's cache and widens the injection surface.** Spec 104
freezes the system prompt per thread as a cache prefix; even the member's current surface path
rides as a trailing block rather than entering the prompt. Injecting retrieved news into context
ahead of the model's turn (a) invalidates that design, and (b) moves counterparty-authored text
from **tool-result position** — where the injection posture is enforced and the model knows the
provenance — into **prompt position**, where it reads as instruction. Tool-pull is not just
cheaper; it is the estate's security model. The model asking `get_token_news("PEPE")` when the
member asks about PEPE *is* retrieval-augmented generation, with provenance intact and zero
infrastructure.

**4. A server-side store keyed to member interest is a new data class.** Whatever the graph
indexes, retrieval keyed by a member's portfolio creates a server-side record of member holdings
and attention. The estate keeps exactly this device-local everywhere it appears (assistant memory,
address book, RPC credentials, GutterToken key — all deliberately absent from `syncedObjects.js` or
gateway state). Crossing that line for a news cache needs its own privacy/legal review, not a rider
on a feed.

**Where a graph WOULD earn its place** — so the idea is parked, not dismissed: relationship queries
over *FairWins' own* data (wagers ↔ markets ↔ pools ↔ members — the subgraph already indexes part
of this and is the natural substrate), or entity resolution across *multiple* external vendors once
there are multiple. Either is its own spec with its own security lifecycle, sized against a
demonstrated retrieval need the tool-pull path failed to meet. Today there is no such demonstrated
need: the assistant has never yet been able to see news at all.

## 4. What must be verified at spec time (the GutterToken-doc discipline)

Probe and record, before `/speckit-plan`:

| Question | Why it gates |
|---|---|
| Auth: genuinely keyless? Key tier? | Decides whether spec 097 registry work exists at all |
| Rate limits, and their unit (IP? key?) | The gateway is one IP for all members — the HL lesson |
| Endpoint shapes: news by asset id; the asset catalog/lookup | The `(chainId, address) → asset id` mapping is the correctness-critical contract |
| Coverage: do our long-tail assets (ETC-cohort tokens) resolve at all? | An unmapped asset must render honest absence, not silence |
| Redistribution/display terms | We are re-displaying third-party headlines in a product; caching terms too |
| Uptime/SLA posture on the free tier | A free dependency with no SLA argues for generous degraded states, not against shipping |

## 5. Recommendation

1. **Split the issue.** #1465 proceeds as **half A only** (news surfaces + gateway proxy + one
   assistant tool). The graph/agent-context store becomes its own backlog issue, explicitly framed
   as "persistent retrieval layer" with this document as prior art, to be picked up if and when
   tool-pull demonstrably falls short.
2. **Half A is spec-worthy** (new member surface + new gateway module ⇒ reserved number per the
   triage rules): reservation PR to `staging`, then `/speckit-specify` with roughly this shape —
   optional keyless gateway module on the perps template; single-flight per-asset cache; explicit
   asset-identity mapping contract; tenant-flagged frontend cards on portfolio token + trade pair
   with three-state honesty and link-out attribution; one `get_token_news` public tool in
   `assistant-contract` (+ MCP snapshot regen); FinOps catalogue entry; no database, no new secret
   unless probing finds a key tier.
3. **No graph database ships in this feature.** The assistant gets external context the way the
   estate already grants it: as a tool the model calls, returning bounded, attributed,
   provenance-labelled text.
