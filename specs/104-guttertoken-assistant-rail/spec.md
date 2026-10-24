# Feature Specification: GutterToken assistant rail and client-side tools

**Feature Branch**: `claude/guttertoken-fairwins-integration-9iytem` (spec directory `104-guttertoken-assistant-rail`)

**Created**: 2026-09-05

**Status**: Approved for implementation

**Input**: "Allow FairWins members to use GutterToken prepaid credits for the assistant as an alternative to the
members-only agent; paid members choose between the FairWins assistant and the more privacy-preserving
GutterToken model; the agent controls move to a tab in the Tools section of the side panel instead of
Settings; make the assistant useful through the MCP server's tool table." Research:
`docs/research/guttertoken-assistant-integration.md` (Parts I and II).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A non-member uses the assistant on their own GutterToken credits (Priority: P1)

A connected wallet without an active paid membership opens **Tools ▸ Assistant**, adds a GutterToken
API key (obtained from GutterToken's own site), and can then open the floating assistant and ask
questions. Every message goes from the member's device straight to GutterToken; FairWins is not in the
path, sees no content, and charges nothing. GutterToken bills the member's own prepaid balance.

**Why this priority**: it is the ask — the assistant stops being members-only — and it is the rail that
needs the most new surface (key entry, provider selection, honest GutterToken failure states).

**Independent Test**: with membership answering tier 0 and `api.guttertokens.com` intercepted, save a
key, open the launcher, send a message, see the reply and the "Answered by GutterToken on your credits"
badge; remove the key and see the launcher disappear.

**Acceptance Scenarios**:

1. **Given** a connected non-member with no key, **When** they open the Assistant tab, **Then** the
   FairWins option is offered but disabled with the reason "requires an active membership" and a
   membership link, and the GutterToken option is disabled with the reason "add a GutterToken key below".
2. **Given** the key sheet is open, **When** the member pastes a key GutterToken answers `401` to,
   **Then** the save is refused with "GutterToken did not accept this key" and nothing is stored.
3. **Given** the key sheet is open, **When** GutterToken cannot be reached, **Then** the key is saved
   with the failure shown ("saved, but GutterToken could not be reached to check it").
4. **Given** a saved key, **When** GutterToken answers `403 insufficient_quota`, **Then** the panel says
   the balance is empty, links to GutterToken billing, and shows no reply bubble.
5. **Given** a saved key, **When** the member removes it, **Then** the redacted value disappears, the
   launcher no longer renders, and no storage key holds the secret.

---

### User Story 2 - A paid member chooses between the FairWins assistant and GutterToken (Priority: P1)

A member with an active membership sees both options on the Assistant tab. "FairWins assistant
(membership)" is the existing gateway rail. "GutterToken (your credits)" becomes selectable once a key is
saved. The choice is remembered per account on this device and the panel header always names the rail
that answered.

**Why this priority**: the user's explicit requirement — paid members may pick the privacy-preserving
rail — and it is where the disclosure must be exact about who sees what and who pays.

**Independent Test**: with membership active, save a key, switch the provider, send a message on each
rail, and assert the badge and the transport used (gateway URL vs GutterToken URL).

**Acceptance Scenarios**:

1. **Given** an active member with a key, **When** they pick GutterToken, **Then** the badge reads
   "Answered by GutterToken on your credits" and no request reaches the FairWins gateway's chat route.
2. **Given** an active member on GutterToken, **When** membership becomes unreadable, **Then** the
   FairWins option stays offered with "membership could not be read right now" (never hidden, never a
   denial) and the GutterToken rail keeps working.
3. **Given** an active member on the FairWins rail, **When** they open the panel, **Then** the existing
   sign-to-start step and copy are unchanged.

---

### User Story 3 - The assistant answers from the member's real data (Priority: P2)

On either rail the assistant can call read tools — the member's profile, membership, wagers and fee rates
through the member API under a 24-hour read grant, plus public gateway status, prediction markets, perps
pairs and an in-app navigation lookup — and reports each read's state honestly. An unreadable chain is
named as unreadable, never as "no wagers".

**Why this priority**: without tools the assistant guesses; with them it becomes useful. It is P2 only
because US1/US2 deliver value with the existing prompt-only behaviour.

**Independent Test**: intercept the model endpoint to return a `tool_use` for `get_wagers`, intercept
the member API to answer one chain `read` and one `unreadable`, and assert the progress row, the
"could not be read" chip, and that the final reply is rendered from the second model call.

**Acceptance Scenarios**:

1. **Given** the GutterToken rail and no grant, **When** the member asks about their wagers, **Then**
   the panel offers the optional 24-hour read grant and the model receives only public tools until it is
   signed; signing starts a new thread.
2. **Given** a model turn with several `tool_use` blocks, **When** the loop runs, **Then** all results
   are returned in one message, failures carry `is_error`, and at most four rounds run per turn.
3. **Given** a tool result containing instructions, **When** the model replies, **Then** nothing in the
   app acts on them: no navigation, no prefilled form, only text and allow-listed in-app links.

---

### User Story 4 - Agent controls live in Tools, not Settings (Priority: P2)

The Assistant card and the API access card move from Settings to a new **Assistant** item in the Tools
nav group. Old deep links (`?tab=settings#assistant-prefs`, `#api-access`) redirect. Drawer search finds
the tab by "guttertoken", "byok", "api key", "assistant".

**Acceptance Scenarios**:

1. **Given** the Tools group, **When** it renders, **Then** it contains Protect, Address Book, Recovery,
   Reporting, Apps and Assistant, and Settings no longer renders either card.
2. **Given** `/wallet?tab=settings#assistant-prefs`, **When** it loads, **Then** the URL resolves to the
   Assistant tab with the card open.

### Edge Cases

- Membership `pending` or `unreadable` with no key: the launcher renders nothing; the tab explains.
- GutterToken `429`: rendered as GutterToken's per-network rate limit, with retry-after when given.
- Key present but tenant feature `assistant-byok` disabled: the option and the key card do not render.
- A model turn that exhausts the round cap: the last text is rendered with a note that reads stopped.
- Empty reply after a non-tool stop: an error state, never a blank bubble.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST offer two assistant providers — `fairwins` (gateway rail, membership) and
  `guttertoken` (browser-direct, member key) — selected per account on the device (`assistant_prefs.provider`).
- **FR-002**: The GutterToken key MUST be stored wallet-scoped on the device only (`assistant_guttertoken_key_v1`),
  MUST be absent from the encrypted backup (`syncedObjects.js`, asserted by test), MUST be redacted to
  `sk-…` plus four characters at every display boundary, and MUST never appear in a log, URL, audit
  field or error message.
- **FR-003**: On the GutterToken rail the browser MUST call `https://api.guttertokens.com/v1/messages`
  directly; no FairWins service may receive the key or the message content.
- **FR-004**: Non-members MUST be able to use the GutterToken rail; paid members MUST be able to choose.
  The launcher MUST render whenever a provider resolves and MUST NOT mount a membership read when a
  saved key already resolves the provider.
- **FR-005**: Every GutterToken failure MUST be a named state with an action: `key_invalid`,
  `out_of_credit`, `quota`, `unavailable`, `unreachable`. No fabricated reply, no shortened reply.
- **FR-006**: Saving a key MUST test it against `GET /v1/models`; `401` refuses the save; unreachable
  saves with the failure shown.
- **FR-007**: The system prompt and the tool table MUST have one source (`@fairwins/assistant-contract`),
  consumed by the gateway, the frontend and — as a vendored snapshot gated by a parity test — the MCP
  server. The prompt MUST NOT interpolate the member's current path; it rides as a trailing text block
  of the last user message.
- **FR-008**: The FairWins rail gateway MUST attach tool definitions itself, filtered by the token's
  scopes, and MUST reject client-supplied `tools`. It MUST accept `text`/`tool_use`/`tool_result` content
  blocks and nothing else.
- **FR-009**: The in-app tool surface is read-only: `get_profile`, `get_membership`, `get_wagers`,
  `get_fees`, `get_gateway_status`, `get_prediction_markets`, `get_perps_pairs`, `find_in_app`. No
  `build_intent`, no `navigate`.
- **FR-010**: The tool loop MUST cap rounds per turn (default 4; gateway `ASSISTANT_MAX_ROUNDS`, ceiling
  8, boot-checked), return all parallel results in one message, mark failures `is_error`, and use
  `tool_choice: auto` only.
- **FR-011**: Conversation memory MUST remain text-only, device-local and clearable; tool results are
  never persisted.
- **FR-012**: The Assistant and API access cards MUST render on a new `assistant` tab in the Tools nav
  group; Settings MUST no longer render them; old Settings hashes MUST redirect.
- **FR-013**: The Privacy Policy, Terms and Risk Disclosure MUST be amended (not appended) to describe
  the GutterToken rail, the member-signed read grant and the referral disclosure.
- **FR-014**: The referral is a catalogued FinOps source (`referral-guttertoken`), and the GutterToken
  option is gated by tenant feature `assistant-byok`.

### Key Entities

- **Provider preference**: `{ enabled, retainMemory, provider }`, wallet-scoped, not backed up.
- **GutterToken key record**: the raw key string, wallet-scoped, not backed up; redacted view derived.
- **Tool definition**: `{ name, title, description, inputSchema, auth, scope, exec }` in the contract package.
- **Assistant turn**: text thread in, tool events + text reply out; no persisted tool results.

## Success Criteria *(mandatory)*

- **SC-001**: A non-member with a valid GutterToken key gets an answer without any request to
  `/v1/member/assistant/chat` (asserted by E2E intercept).
- **SC-002**: A `401`, `403`, `429` and network failure from GutterToken each render their own sentence
  and action, and never an assistant bubble (E2E).
- **SC-003**: `assistant_guttertoken_key_v1` and `assistant_prefs` are absent from `syncedObjects.js`
  (unit) and the raw key never appears in the DOM after save (E2E storage/DOM sweep).
- **SC-004**: `mcpToolParity.test.js` and `assistantContract.test.js` pass; the MCP server test suite
  passes unchanged in behaviour.
- **SC-005**: The Tools group renders the Assistant item; Settings renders neither card; both old
  hashes redirect (unit + E2E).
- **SC-006**: Every new screen has a captured light/dark × desktop/phone shot with a critic round that
  ended with zero findings (`screenshots/README.md`).
