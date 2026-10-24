# Implementation Plan: GutterToken assistant rail and client-side tools

**Branch**: `claude/guttertoken-fairwins-integration-9iytem` | **Date**: 2026-09-05 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` + `docs/research/guttertoken-assistant-integration.md` (Phase 0 research, Parts I–II).

## Summary

Add a second, member-paid rail to the spec-095 assistant (bring-your-own GutterToken key, browser-direct),
let paid members choose between the rails, move the agent controls to a Tools tab, and give the assistant
read tools on both rails through a client-side loop over a shared tool table that the MCP server also
ships. No contract changes; one new workspace package; one new gateway env var.

## Technical Context

**Language/Version**: JavaScript (React 19 + Vite 8 frontend; Node 22 ESM gateway and MCP server)
**Primary Dependencies**: none added. `@fairwins/assistant-contract` is a zero-dependency workspace package.
**Storage**: wallet-scoped `userStorage` (localStorage) for the provider preference and the key; module memory for the session grant.
**Testing**: Vitest (scoped runs), `node:test` (gateway, MCP), Cypress no-chain tier (both viewport profiles), Playwright capture harness for the actor-critic loop.
**Target Platform**: web/PWA + Capacitor shells (CSP is derived from nginx; `connect-src https:` already admits GutterToken).
**Project Type**: web application (frontend + gateway service + shared package).
**Constraints**: no key or message content in logs; no fabricated replies; tools read-only; lockfile change limited to the new workspace link.

## Constitution Check

- **I. Security-first contracts** — no `contracts/` change. N/A.
- **II. Test-first** — unit tests per module (lib, components, gateway, MCP parity), E2E rows in the coverage matrix with real assertion depth.
- **III. Honest state** — three-state membership preserved (unreadable never a denial); tool results keep the per-chain envelope; GutterToken failures are named; no rendered credit balance because none is readable.
- **IV. Fail loudly in CI** — new gates (`assistantContract`, `mcpToolParity`) fail the build; no `continue-on-error`.
- **V. Accessible, consistent frontend** — tokens only, axe checks light + dark, 36 px targets, actor-critic screenshots.
- **Key management** — the GutterToken key is a member credential on the member's device; the platform never holds it.

Complexity tracking: the new workspace package is justified by spec 075 rule 3 (one source for prompt + tools consumed by Node ESM and Vite); the MCP snapshot is the accepted cost of the MCP server's zero-dependency rule (spec 095 R4).

## Project Structure

### Documentation (this feature)

```text
specs/104-guttertoken-assistant-rail/
├── spec.md
├── plan.md
├── tasks.md
└── screenshots/          # actor-critic record (README.md + PNGs)
```

### Source Code

```text
packages/assistant-contract/src/{index,prompt,tools,results}.js
services/relay-gateway/src/memberApi/{assistant.js,openapi.js}  services/relay-gateway/src/config/index.js
services/relay-gateway/test/{assistantContract,mcpToolParity,memberApi…}.test.js
services/mcp-server/src/{tools.js,toolDefs.snapshot.json}
frontend/src/lib/assistant/{assistantPrefs,guttertokenKeyStore,resolveProvider,conversation,assistantClient}.js
frontend/src/lib/assistant/providers/guttertoken.js  frontend/src/lib/assistant/tools/{executor,toolLoop}.js
frontend/src/components/assistant/{AssistantToolsPanel,GutterTokenKeySheet,AssistantPanel,AssistantLauncher}.jsx
frontend/src/pages/WalletPage.jsx  frontend/src/config/{appNav,navSearchIndex}.js
frontend/src/legal/*.md  packages/finops-catalogue/src/sources.js  tenants/**
frontend/cypress/e2e/fast/{38-assistant,47-assistant-rails}.cy.js  frontend/cypress/coverage/matrix.json
scripts/ui/capture-assistant-rail.mjs
```

## Design decisions (from research, binding)

1. **P1 browser-direct BYOK** for the GutterToken rail; gateway passthrough, a FairWins-owned upstream and a mini-app are rejected (research §3).
2. **T3 client-side tool loop on both rails**; the gateway attaches server-owned tool definitions on the FairWins rail and accepts content blocks; tool executions are ordinary member-API calls (research §8.2, §8.6).
3. **One source** for prompt + tools in `@fairwins/assistant-contract`; MCP server keeps a vendored snapshot + parity test; `build_intent` stays MCP-only (research §8.3, §8.4).
4. **Provider resolution**: pref `guttertoken` + key → GutterToken; pref `fairwins` + active membership → FairWins; non-member + key → GutterToken; pending/unreadable → nothing (never a denial). Paid members with a key may choose.
5. **Surface out of the system prompt**: appended as a trailing text block on the last user message (cache prefix).
6. **Agent controls in Tools**: tab id `assistant`, label "Assistant"; Assistant + API access cards move; Settings hashes redirect.
7. **Model on the GutterToken rail**: `claude-opus-5` default, `max_tokens` 1024, `tool_choice: auto`; rates are never rendered, GutterToken is linked.

## Phases

- **Phase 1 (parallel)**: A package + gateway + MCP; B frontend lib; C frontend UI + nav; D legal/FinOps/tenant/docs.
- **Phase 2**: E Cypress no-chain specs + matrix; F actor-critic screenshot loop.
- **Phase 3**: gates (`check:deps`, lint, scoped Vitest, gateway + MCP tests, `check:finops`, `tenants:validate`, `e2e:matrix` diff), commit, push, PR update.
