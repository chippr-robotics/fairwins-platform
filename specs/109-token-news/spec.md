# Feature Specification: Token news on portfolio and trade surfaces

**Feature Branch**: `109-token-news`

**Created**: 2026-09-06

**Status**: Draft

**Input**: User description: "Token news on portfolio and trade surfaces (spec 109, issue #1465).
Members see recent news for a selected portfolio token and for the selected trade pair, with
three-state honesty (read/unreadable/not-configured), link-out attribution, text-only rendering;
the assistant gains one public get_token_news tool; retrieval is tool-pull only — no persistent
datastore, no context-push. Out of scope: graph database (parked as #1504/#1513 lineage), article
bodies, any assistant prompt injection of news. Prior art: the merged estate evaluation
`docs/research/alphaday-news-agent-context-evaluation.md`."

## User Scenarios & Testing *(mandatory)*

> Story priorities below (P1–P3) rank the user stories **within this feature** — P1 is the story
> that must ship for the feature to be a viable MVP. They do not re-triage issue #1465's product
> priority, which remains as its issue fields state (Priority: Medium; the issue body's
> "P3 — nice to have"): this whole feature is nice-to-have relative to the platform, and its P1
> story is simply its most essential slice.

### User Story 1 - News for a selected portfolio token (Priority: P1)

A member holding an asset opens it in their portfolio and sees a short feed of that asset's most
recent news — headline, source name, and how recently it was published — each item opening the
original article at its source in a new context. The member uses this to decide whether to hold,
sell, or investigate further, without leaving the app to search for the asset by name.

**Why this priority**: This is the issue's primary acceptance scenario and the highest-traffic
surface: a member checking their portfolio is already asking "should I be worried or pleased about
this holding?", and news is the missing input. It is independently shippable — the trade surface
and the assistant tool add distribution, not capability.

**Independent Test**: Can be fully tested by selecting a known, mapped token in the portfolio view
and confirming a news feed renders with attributed, dated items linking out to their sources — and
by selecting an unmapped token and confirming honest absence.

**Acceptance Scenarios**:

1. **Given** a member viewing a portfolio token the news source recognizes, **When** the token's
   detail is shown, **Then** a news card renders that asset's recent items, each with headline,
   source attribution, and age, and each item opens the original article externally.
2. **Given** a token the news source does not recognize (or whose identity cannot be confirmed
   unambiguously), **When** its detail is shown, **Then** the card states that no news source
   covers this asset — it never shows another asset's news under a colliding symbol.
3. **Given** the news feed cannot be reached, **When** the token's detail is shown, **Then** the
   card says the feed could not be read and offers retry — it is visually and verbally distinct
   from "no recent news", which is itself a valid, honest state.
4. **Given** the news capability is not configured for this deployment or tenant, **When** the
   member browses the portfolio, **Then** no news surface appears at all — no empty card, no
   broken affordance.

---

### User Story 2 - News under a selected trade pair (Priority: P2)

A member preparing a swap selects a trading pair and sees, below the amount entry, the latest news
for the tokens in that pair. The member reads a headline that changes their mind — or confirms
their intent — before committing an amount.

**Why this priority**: The issue's second acceptance scenario. Same capability as Story 1 on a
second surface; it ranks below the portfolio card because the trade screen already carries more
decision context (price, balances) and because Story 1 proves the pipeline.

**Independent Test**: Select a pair on the trade surface and confirm the feed renders below the
amount entry for the pair's mapped tokens, with the same honest states as Story 1.

**Acceptance Scenarios**:

1. **Given** a selected trade pair whose tokens are mapped, **When** the trade form is shown,
   **Then** a news feed renders below the amount entry with the latest items for those tokens,
   attributed and linking out.
2. **Given** one token of the pair is mapped and the other is not, **When** the feed renders,
   **Then** it shows the mapped token's news and states that the other is not covered — a partial
   answer is labelled, never silently completed.
3. **Given** the feed is unreadable, **When** the trade form is shown, **Then** the amount entry
   and the trade itself are entirely unaffected — news is advisory and never gates or delays a
   trade.

---

### User Story 3 - The assistant answers "what's the news on X?" (Priority: P3)

A member (or an external agent acting with the member's own credentials) asks the assistant about
an asset, and the assistant fetches that asset's current news on demand and answers with attributed
summaries, labelling the content as third-party reporting. Nothing is fetched until asked; nothing
is retained afterwards beyond the member's device-local conversation.

**Why this priority**: This is the "agents need information" half of the issue, delivered the way
the estate already grants external context — as a tool the model calls, with provenance intact.
It depends on the same retrieval capability as Stories 1–2 and inherits their honesty rules.

**Independent Test**: Ask the assistant for news on a mapped asset and confirm the reply cites
fetched items with sources; ask about an unmapped asset and confirm the assistant reports that no
source covers it rather than inventing coverage; disable the capability and confirm the tool
reports it is unavailable.

**Acceptance Scenarios**:

1. **Given** an assistant conversation on either rail, **When** the member asks about an asset's
   news, **Then** the assistant retrieves current items for that asset and answers with source
   attribution, describing the content as reported, third-party, and not advice.
2. **Given** the feed is unreachable or the capability unconfigured, **When** the member asks,
   **Then** the assistant says the news source could not be read / is not offered — it never
   fabricates a summary.
3. **Given** any assistant conversation, **When** no one has asked about news, **Then** no news
   content enters the conversation — retrieval happens only on an explicit tool call, never as
   pre-loaded context.

---

### Edge Cases

- **Symbol collision**: many unrelated tokens share a ticker. The mapping from the member's
  concrete asset (its network and contract identity) to the news source's asset identity must be
  exact; when it cannot be established unambiguously, the surface reports no coverage rather than
  guessing. Wrong-token news presented as right-token news is a fabricated fact.
- **"No news" vs "could not read"**: an asset with genuinely no recent items shows an honest empty
  state; a failed read shows a failure and a retry. The two must never look alike.
- **Long-tail assets**: cohort assets the vendor does not index (e.g. ETC-ecosystem tokens) render
  honest absence, not an error and not silence.
- **Hostile content**: headlines are text authored by third parties. They render as plain text
  only — never as markup — and the only interaction an item offers is opening its source
  externally with clear attribution. This applies identically to assistant tool results, which the
  estate already treats as counterparty-authored (prompt-injection posture).
- **Stale content**: an item's age is always shown; content older than the feed's freshness window
  is not presented as current.
- **Shared upstream budget**: every member's request reaches the vendor from one platform origin.
  News for an asset is the same for every member, so the platform must not multiply vendor load
  per member viewing the same asset.
- **Testnet cohort**: a testnet build must not display mainnet-asset news as if it described the
  member's testnet holdings; if news cannot be honestly scoped, the surface states it (mainnet
  precedent: the perps testnet notice).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The portfolio token detail MUST offer a news card for the selected asset showing
  recent items with headline, source name, publication age, and a link that opens the original
  article externally.
- **FR-002**: The trade surface MUST offer a news feed below the amount entry for the selected
  pair's tokens, with the same item shape and states as FR-001.
- **FR-003**: Every news surface MUST resolve one of three states — content read, feed unreadable
  (with retry), or capability not configured (surface absent) — and an unreadable feed MUST never
  render as an empty feed. "No recent items" is a fourth, honest content state distinct from all
  failure states.
- **FR-004**: Asset identity MUST be established from the asset's concrete identity (network +
  contract identity, or the platform's canonical asset record), never from a bare display symbol;
  an asset whose news-source identity cannot be confirmed MUST render as not covered.
- **FR-005**: All third-party content MUST render as plain text with visible source attribution;
  no third-party markup, media, or scripts are ever rendered, and article bodies are not shown
  in-app.
- **FR-006**: News MUST be advisory only: no value path (trade submission, transfer, wager) may be
  gated, delayed, or altered by the presence, absence, or content of news.
- **FR-007**: The assistant MUST gain exactly one public news tool that fetches an asset's current
  items on demand; it MUST be available on both assistant rails and to external agents through the
  platform's existing agent access paths, under those paths' existing authentication and pricing
  rules and with no new credential surface.
- **FR-008**: News MUST reach the assistant ONLY as the result of an explicit tool call within a
  conversation. It MUST never be inserted into the assistant's standing instructions or pre-loaded
  into a conversation, and tool results MUST carry the platform's existing third-party-content
  labelling (reported, not advice; a result never makes the app act).
- **FR-009**: The platform MUST NOT persist news content or member news-interest in any durable
  server-side store. Short-lived caching to bound upstream load is permitted; a member's viewing
  or asking about an asset MUST NOT create a lasting record keyed to that member.
- **FR-010**: Requests for the same asset's news MUST be coalesced platform-side so vendor load
  scales with distinct assets viewed, not with members viewing them, and the platform MUST respect
  the vendor's published usage limits.
- **FR-011**: The capability MUST be individually switchable per deployment and per tenant; off
  means every news surface (including the assistant tool) is absent or reports itself not offered
  — never a broken or empty-looking surface.
- **FR-012**: The vendor dependency MUST be declared in the platform's cost catalogue at
  introduction, including its zero-cost status if the free tier is confirmed, so the dependency is
  visible to financial operations from day one.
- **FR-013**: If the vendor relationship requires credentials at any tier, they MUST be held
  platform-side only under the platform's secret-management rules and never reach the client; if
  the confirmed integration is keyless, no credential surface is introduced.

### Key Entities

- **News item**: headline (plain text), source name, publication time, canonical external URL.
  Third-party authored; displayed, never stored durably, never interpreted as instruction.
- **Asset identity mapping**: the correspondence between a platform asset (network + contract
  identity or canonical asset record) and the news source's asset identifier. Correctness-critical:
  its failure mode is showing the wrong asset's news, so absence of a confident mapping is a
  first-class "not covered" outcome.
- **Feed reading**: the three-state result (read / unreadable / not-configured) plus the read
  state's "no recent items" content case; the only shape any news surface consumes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member viewing a covered portfolio token sees its news card populated within 3
  seconds on a typical connection, without any interaction beyond selecting the token.
- **SC-002**: Zero instances of one asset's news rendering under a different asset: every rendered
  item's asset identity matches the selected asset's confirmed mapping (verifiable by fixture
  assets with colliding symbols).
- **SC-003**: In every failure drill (feed unreachable, asset unmapped, capability off), the
  member-visible outcome is one of the defined honest states — no blank cards, no spinners without
  resolution, no fabricated "no news".
- **SC-004**: The assistant answers an asset-news question with at least one attributed item when
  coverage exists, and states non-coverage or unreadability otherwise, in 100% of scripted
  evaluation prompts; it never volunteers news in conversations where none was requested.
- **SC-005**: Upstream (vendor) requests for a given asset number at most one per refresh
  interval — the platform's configurable cache window, floor 5 minutes — regardless of how many
  members view that asset concurrently (verifiable in a load drill: N concurrent viewers of one
  asset within one interval produce exactly 1 upstream request; the bound holds for any
  configured interval ≥ the floor).
- **SC-006**: Disabling the capability removes every news affordance from the product with no
  other member-visible change.

## Assumptions

- **Vendor**: Alphaday is the intended source (issue #1465's proposal), publicly positioned as a
  free API with no signup. This is **unverified** — the evaluation's §4 probe list (auth model,
  rate limits and their unit, asset-catalog/lookup shapes, coverage of long-tail cohort assets,
  redistribution and caching terms, free-tier reliability posture) is research that gates the
  plan, not the spec. If probing invalidates the keyless assumption, FR-013 governs; if it
  invalidates the vendor entirely, the requirements above are vendor-neutral by construction.
- **Architecture direction (input to planning, not binding here)**: the merged estate evaluation
  recommends a read-only optional gateway module on the spec-082 perps template, tenant-flagged
  frontend cards, one `get_token_news` entry in the assistant's single tool table (which reaches
  the MCP/external-agent paths through existing parity mechanisms), and a single-flight per-asset
  cache in place of any datastore.
- **Deliberately out of scope**: any persistent retrieval layer or graph store for agent context
  (parked as issue #1504's successor line and issue #1513, with re-entry conditions recorded in
  the evaluation); article bodies or reader mode; news notifications/alerts; sentiment scoring or
  any platform-authored interpretation of news; any revenue path (no fee, no referral — if one
  appears later it is its own catalogued change).
- **No new data class**: nothing in this feature records which assets a member looks at or asks
  about beyond existing, device-local conversation memory.
- **Localization**: items render in the language the vendor supplies; translation is out of scope.
