# Claude subagents — FairWins

Project-scoped Claude Code subagents. The **main session is the orchestrator**:
subagents cannot spawn subagents, so the main thread picks the specialist, in
order, and reads every report as a claim (constitution §Development Workflow 5)
until `witness` has run the gates.

These sit beside — not in place of — the Copilot review agents in
`.github/agents/` (the constitution names `smart-contract-security.agent.md`
as the contract merge gate) and the Spec Kit / ops skills in `.claude/skills/`.

## Roster

| Agent | Owns | Model | Edits? | Consult |
|-------|------|-------|--------|---------|
| `keel` | Value-bearing contracts: wagers, pools, staking, liquidity, bridge, clearpath, tokens, naming, FeeRouter mechanics, MembershipManager fund paths, `upgradeable/`. Default owner of any unclaimed `contracts/` path | opus | yes (+Write) | **Before** the edit |
| `augur` | Oracle adapters + resolution paths (`autoResolveFrom*`, draws, open challenges), oracle subgraph handlers, pending-resolution UI logic | opus | yes (+Write) | **Before** the edit |
| `custos` | Custody guards, SafeProposalHub, all role/authority wiring, SanctionsGuard, MiniAppRegistry curation, `lib/custody`, `lib/screening` (incl. estate reads feeding a verdict), `lib/chains/writeRail.js`, admin gate matrix | opus | yes | **Before** the edit |
| `latch` | ERC-4337 account + paymaster contract, `contracts/privacy`, passkeys/account lookup, hardware signers + Sigil bridge, recovery, backup, app-lock, verify | opus | yes | **Before** the edit |
| `relay` | `services/relay-gateway`, oz-relayer, alto-bundler, mcp-server; `packages/intent-types`, `assistant-contract`, `abi`; subgraph (except resolution mappings → `augur`) | sonnet | yes | On the change |
| `teller` | FeeRouter rates/caps, fee disclosure, membership pricing, third-party revenue config, FinOps catalogue/exporter/dashboards | sonnet | yes | On the change |
| `mark` | Tenants, deployments, deploy scripts, sync artifacts, infra/, secrets registry, CI workflows, release train, native shells, lockfile | sonnet | yes | On the change |
| `satchel` | Bitcoin, Solana, string-id venues; cohort/estate read layer (the read, not the verdict or the render); portfolio aggregation; wrapped-native | sonnet | yes | On the change |
| `glass` | React/Vite UI, mini-app host + packages, a11y, brand tokens, tenant theming, Cypress/Vitest for surfaces | sonnet | yes | On the change |
| `witness` | Diff-vs-invariant read + narrowest real gates; verdict with exact commands | sonnet | **no** | **After** every change |

Colors: the four opus agents each have their own color, because color is how a
session tells who spoke. With 8 colors for 10 agents, the two shares sit on the
watch and the screen: `teller` shares pink with `witness`, `satchel` shares
blue with `glass`.

Opus = can lose member funds or keys if wrong. Sonnet = can mislead or break,
but the value-bearing specialist or a gate stands behind it.

## Routing

- **Value moves on-chain** (escrow, payout, refund, fee charge) → `keel`. If
  *who won / when final* is in question → `augur` too. If *who may* → `custos`.
- **A key, account, signer or secret is involved** → `latch`.
- **Gasless, intents, gateway, MCP, subgraph** → `relay`, with three carve-outs:
  a subgraph mapping that says a wager resolved → `augur`; an MCP tool or
  gateway route that asks the member for a signature → `latch`; anything that
  could move funds without a member signature → stop → `keel`.
- **An estate read** → `satchel` owns the read; if it feeds a screening
  verdict → `custos`; how its total renders (a missing chain is never zero)
  → `glass`.
- **A number the member pays or the platform earns** → `teller`.
- **How bytes reach an origin/chain/cloud** → `mark`. `mark` authors; a human
  operator runs live deploys, `terraform apply`, and tag pushes.
- **Not EVM, or crosses a cohort boundary** → `satchel`.
- **Pixels, words, a11y** → `glass`, calling the seam owner for any logic change.
- **Then always `witness`.**

Several specialists in sequence is normal: e.g. a new fee on Supply =
`teller` (service + cap + disclosure) → `keel` (charging path) → `glass`
(confirm UI) → `witness`.

## Shared rules (every agent)

- Branch from `staging`; delegated work gets a **sub-issue**
  (`docs/developer-guide/multi-agent-workflow.md`).
- Never log, print, commit or transmit key material, tokens, or `.env` values.
- Never import from or deploy `contracts-archive/` / `test-archive/`.
- Never fabricate a value: unreadable is not zero, absent is not empty.
- Never run the unscoped frontend Vitest suite locally (it OOMs here).
- Report with `VERIFY: ran <exact command> — result: PASS | FAIL | DID NOT RUN`.

## Left out on purpose

- **A general refactor agent** — that is how custody bugs get restyled.
- **A copy of the Copilot security reviewer** — the constitution already names
  that file as the merge gate; Claude agents defer the security writeup to it.
- **Spec Kit as agents** — those stay skills.

Note: `witness` is read-only by tool grant (no `Edit`/`Write`) but has `Bash`,
so "does not edit" is also a stated rule in its prompt. The Copilot agent's
tooling is configured by GitHub, not by these files.
