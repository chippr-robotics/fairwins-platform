# Quickstart: Address Book — validation guide

How to run and validate the Address Book feature end-to-end. Implementation details
live in `contracts/`, `data-model.md`, and (later) `tasks.md`.

## Prerequisites

- Repo set up; from repo root: `npm install` (and `cd frontend && npm install` if the
  frontend has its own lockfile).
- A wallet with at least one supported network configured (the active chain defaults
  from `VITE_NETWORK_ID`).
- For sanctions tags against a real guard, a network where `sanctionsGuard` is
  deployed (see `config/contracts.js`); otherwise addresses show the **uncertain**
  tag (fail-closed), which is itself a valid thing to verify.

## Run

```bash
npm run frontend            # start the dev server (Vite)
npm run test:frontend       # run the Vitest suite (unit + component + axe)
```

## Validation scenarios (map to spec user stories)

### US1 — Manage contacts (P1)

1. Connect a wallet, open **My Account** → **Address Book**.
2. Add a contact "Alex" with one address, the network prefilled to the active chain,
   and a note. → Appears in the list.
3. Add a second address (different network) under "Alex". → Both grouped under the
   one contact (FR-002).
4. Edit the nickname/notes; reload the page. → Changes persist (localStorage,
   FR-006).
5. Delete one address, then the whole contact. → Only the targeted data is removed
   (FR-004).
6. Try to save `not-an-address`. → Field-level validation error; nothing saved
   (FR-005).

**Expected**: All of the above succeed; data survives reload; invalid input rejected.

### US2 — Sanctions/compliance warnings (P1)

1. Save an address known-restricted by the guard and one known-clear (or use a mock
   in tests). → Restricted shows a warning tag (icon + text); clear shows none
   (FR-010).
2. On a network where the guard is not configured, view an address. → Shows
   **Unscreened/uncertain**, NOT clear (FR-011).
3. Give a contact two addresses, one restricted. → That address is flagged and the
   contact is marked as containing a restricted address (FR-012).

**Expected**: Warnings are accurate, fail-closed, network-scoped, and conveyed by
more than colour.

### US3 — Select a contact anywhere an address is required (P2)

1. With ≥1 saved contact, open **Create/Accept Wager** (FriendMarketsModal).
2. In the opponent address field, search by nickname or partial address. → Matches
   shown (FR-015).
3. Select one. → Field populates with that exact address; a restricted selection
   surfaces its warning in-flow (FR-016).
4. With an empty book, the field still works for manual entry (edge case).

**Expected**: Selection populates the field; warnings travel with the selection; no
regression to manual entry.

### US4 — Save prompt after a successful action (P2)

1. Enter a brand-new (unsaved) opponent address and complete a wager create/accept so
   it confirms on-chain.
2. → A dismissible, non-blocking toast offers to save it (nickname required, network
   prefilled, optional notes) (FR-017).
3. Dismiss it. → Address not saved; the completed action is unaffected (FR-018).
4. Repeat with an already-saved address. → No toast (FR-017).

**Expected**: Toast appears only for new addresses, never blocks the flow.

### US5 / US7 — Plain-text export/import (P3, amended by issue #1550)

Run this signed in with a **passkey** at least once: that session has no ethers
signer, and it is the session the encrypted design refused.

1. Populate a book, click **Export**. → A `.json` file downloads with **no signature
   prompt**; opening it in a text editor shows the nicknames, addresses and notes as
   readable text (FR-019). Nothing says "Wallet not connected" (SC-012).
2. Before exporting, read the note beside the buttons. → It says the file is readable
   by anyone who opens it (FR-031).
3. In a second browser profile (or after clearing local data), on **any** account —
   including a different member — **Import** the file. → All
   contacts/addresses/networks/notes restored (FR-020).
4. Hand-edit the file (rename a contact, add one) and import it. → The edits arrive;
   editing is a supported use of a plain-text file.
5. Import a corrupted or non-address-book file. → Clear error naming what was wrong;
   existing book unchanged (FR-021).
6. Import a **pre-#1550 encrypted** backup with no signer. → Refused with a message
   naming the file as an older encrypted export and how to proceed — never "wrong
   wallet", "different wallet", or "not connected" (SC-014). With the original
   wallet connected, the same file still opens.
7. Import a file that overlaps existing contacts. → New addresses added, existing
   kept (no duplicates); differing nickname/notes prompt keep/take per conflict
   (FR-022).
8. Export with an empty book. → "There are no contacts to export yet"; no file is
   written.

**Expected**: round-trip restores 100% on every account type with zero signature
prompts; corrupt and legacy files fail safely with an honest reason; overlap merges
additively.

## Accessibility & quality gates

```bash
npm run test:frontend       # includes vitest-axe checks (expect no violations)
cd frontend && npm run lint  # ESLint must be clean
```

- Verify keyboard operability of the panel, picker, and toast.
- Verify tags are distinguishable without colour (icon + text).

## Done / acceptance

- All five scenario groups pass manually and via Vitest.
- `npm run test:frontend` green (unit + component + axe).
- ESLint clean; no `continue-on-error` added to CI.
- No contract/subgraph/backend changes in the diff.
