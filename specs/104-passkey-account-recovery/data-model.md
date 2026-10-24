# Data model: passkey account recovery

No persisted schema changes. The credential book
(`fairwins.passkey.credentials.v1`, `lib/passkey/credentials.js`) stays the only client-side record,
and gains no new fields beyond what a successful recovery already writes.

What this document defines is the **shape of an answer**, because the bug this feature fixes is a
shape problem: today's resolver returns an address whether or not it verified one.

---

## Resolution outcome

The single return type of the resolver. **A value exists only in `resolved`** — the other three
carry a reason and no address, so `?? derivedAddress` has nowhere to live.

```
Resolution =
  | { outcome: 'resolved',       accounts: VerifiedAccount[] }   // 1..n, member picks if n > 1
  | { outcome: 'none-found',     reason }                        // the chain was read; nothing lists this key
  | { outcome: 'unverified',     reason }                        // the chain could not be read
  | { outcome: 'not-controller', reason, address }               // a NAMED account exists, key is not an owner
```

Three constructors take no address at all, which is what makes the constitution III property
structural rather than remembered — the same device as spec 089's `reading.js` (only one of its
three constructors takes a number) and spec 071's estate reads.

`not-controller` carries an address because the member supplied it: naming it back is what makes the
refusal legible ("that account exists, this passkey does not control it") rather than a bare no.

### Why `unverified` is not `none-found`

An unreachable chain is not evidence of absence. Collapsing the two tells a member with a perfectly
good account that they have none — the identity equivalent of rendering an unreadable balance as
`$0`, which constitution III already forbids. Precedent in this repo: spec 095 keeps
`auth_unverifiable` a retryable 503 rather than a denial; spec 071 keeps `unreadable` out of the
zero path; spec 084 keeps `unverifiable` as a third message-signing verdict.

---

## Entities

### RecoveredKey

The P-256 public key recovered from the member's assertion, as owner bytes. The only identity the
chain can be asked about.

| field | type | notes |
|---|---|---|
| `ownerBytes` | `0x` + 128 hex | `publicKeyToOwnerBytes({x, y})` — 64 bytes, compared lowercased |
| `publicKey` | `{ x, y }` | needed to write the credential record on success |
| `credentialId` | base64url | the ceremony's credential, for the record |

### CandidateAccount

An address a search leg associates with the key, **before** confirmation. Never surfaced to the
member and never sessioned on.

| field | type | notes |
|---|---|---|
| `address` | address | |
| `origin` | `'nonce'` \| `'created'` \| `'add-owner'` \| `'member-supplied'` | which leg produced it; carried for diagnosis, not for trust |

A candidate from any origin, including `member-supplied`, must pass the same confirmation. The
origin never shortens the check.

### VerifiedAccount

A candidate whose **current** owner set includes the recovered key. The only thing a session may
open on.

| field | type | notes |
|---|---|---|
| `address` | address | |
| `ownerIndex` | number | the slot the chain reports — signatures need the real index (spec 045 FR-009), never a hardcoded 0 |
| `chainId` | number | which chain confirmed it |

**Verification is against the current set, not history.** A key that once owned an account and was
rotated off does not control it, and offering it would send the member somewhere they can no longer
sign for.

---

## State transitions

```
                    ceremony completes, local book has no record
                                    │
                                    ▼
                          ┌──────────────────┐
                          │ search (bounded) │──── deadline ────▶ unverified
                          └──────────────────┘
                                    │
                   candidates       │        no candidates, chain read OK
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
      confirm each against                            none-found
      the CURRENT owner set                                │
              │                                            │ member offers an address
      ┌───────┴────────┐                                   ▼
      ▼                ▼                          confirm that address
  ≥1 verified      0 verified                   ┌──────────┴──────────┐
      │                │                        ▼                     ▼
      ▼                ▼                   verified            not-controller
   resolved        none-found                   │
      │                                         │
      ▼                                         ▼
  n = 1 → open session          n > 1 → member picks, then open session
      │
      ▼
  write the credential record (address, publicKey, ownerIndex)
```

Two edges are the whole point:

- **No edge from any non-`resolved` state to an open session.** The current code has exactly that
  edge — an undeployed derived address is returned as the member's account — and removing it is
  US2.
- **`unverified` never merges into `none-found`.** They are reached by different causes and lead to
  different member actions: retry versus recover.

---

## What is written on success

Unchanged in shape from today's successful sign-in, via `upsertCredential`:

| field | source |
|---|---|
| `credentialId` | the assertion |
| `publicKey` | recovered from the assertion, or the local record |
| `address` | the **verified** account |
| `ownerIndex` | the chain's reported slot |
| `userId` | the assertion's user handle (spec 104 inherits this from #1425's naming work) |

Writing the record is what makes recovery a one-time cost: the next sign-in on this browser resolves
locally and runs no search at all.
