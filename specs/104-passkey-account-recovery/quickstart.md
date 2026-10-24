# Quickstart: validating passkey account recovery

How to prove each release works. Per-release, because the releases ship independently and each is
worth validating on its own.

Prerequisites: `npm ci` at the repo root; a local chain and seeded accounts via `npm run setup:e2e`
for the on-chain checks.

---

## Release 1 — honest outcomes and address recovery

### Unit

```bash
cd frontend
npx vitest run src/lib/passkey/__tests__/accountLookup.test.js
npx vitest run src/lib/passkey/ src/connectors/
```

**Expected** — the cases that carry the feature:

| case | expected |
|---|---|
| address whose current owners include the key | `resolved`, one account, `ownerIndex` from the chain |
| address that is deployed but does not list the key | `not-controller`, reason distinguishes it from an empty address |
| address with no code | `not-controller`, reason says nothing is deployed there |
| chain read throws | `unverified` — **not** `none-found`, and no address in the result |
| key that once owned the account and was rotated off | **not** `resolved` |

The refusal cases are the ones that matter. US3's security property is a negative — that an address
a member names cannot open a session unless the chain agrees — so a suite where only the happy path
is asserted has not tested this feature.

### The removed behaviour

```bash
npx vitest run src/connectors/__tests__/passkey.test.js
```

**Expected**: with an empty credential book and a key whose derived address is **undeployed**, the
connector does **not** return that address. Before this release it did, silently. This is the single
most important regression test in the feature — it is the failure a member reads as "my money is
gone".

### By hand

1. Open the app with an empty credential book (fresh profile, or clear `localStorage`).
2. Sign in with a passkey whose account this browser has never seen.
3. On a non-`resolved` outcome, confirm the message names what could not be confirmed and that
   every other sign-in method is still reachable without restarting the app.
4. Enter a known-good account address → signed in, and the credential record is written (the next
   sign-in runs no search).
5. Enter an address you do not control → refused, with a reason that distinguishes the two cases.

---

## Release 2 — discovery for initial owners

### The prerequisite, first

```bash
node -e "const d=require('./deployments/polygon-chain137-v2.json');console.log(d.deployBlocks?.accountFactory)"
```

**Expected**: a block number, not `undefined`. Until this prints a number, the scan starts at block
0 and never completes — and it will not fail loudly, it will simply hang, exactly as
`find-safe-proposals.js` and `register-fee-service.js` degrade today (research R2).

Verify the recorded block is not *later* than the factory's first `AccountCreated`: a too-late block
silently misses the earliest accounts, which are precisely the oldest members' accounts.

### Unit

```bash
cd frontend && npx vitest run src/lib/passkey/__tests__/accountLookup.test.js
```

**Expected**: the scan is chunked; a leg that throws contributes nothing rather than failing the
resolution; expiry of the deadline yields `unverified`; multiple verified accounts are returned for
the member to choose and the resolver picks none of them.

### On-chain

```bash
npm run setup:e2e
npx cypress run --spec 'frontend/cypress/e2e/full/*passkey-recovery*'
```

**Expected**: a passkey that created its account at a non-zero nonce resolves to it; a passkey that
was an initial owner alongside another owner resolves to the real account, not to the address
derived from it alone.

---

## What is deliberately not validated here

**Keys added to an account after creation.** `AddOwner` carries no address to filter on and the
subgraph indexes no account entities, so discovery for that shape is deferred to its own spec
(research R3/R4). Until it exists, that member recovers through the address path in Release 1, and
the `none-found` reason says the search cannot see keys added after creation rather than implying no
account exists.

Do not write a test that asserts this shape is found. It is not, by design, and a test that passed
would mean the resolver was claiming something it cannot know.
