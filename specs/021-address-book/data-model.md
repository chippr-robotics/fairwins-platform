# Phase 1 Data Model: Address Book

All data is client-side (browser `localStorage`), scoped to the connected wallet.
No on-chain or server schema is introduced. Restriction status is **derived** at
runtime from screening and is never persisted (so it can never go stale on disk).

## Entities

### AddressBook (root, persisted)

The full collection for one owner (one connected wallet). One JSON document per
wallet under `fw_user_<ownerAddressLowercase>_addressBook`.

| Field | Type | Notes |
|-------|------|-------|
| `schemaVersion` | number | Storage schema version (starts at `1`) for forward migration. |
| `contacts` | `Contact[]` | The member's contacts. |
| `updatedAt` | number (epoch ms) | Last local mutation time. |

Owner is implied by the storage key (not stored in the body), matching
`userStorage.js` conventions and preventing cross-member leakage (FR-009).

### Contact (persisted)

A named person/entity. One nickname, many addresses (FR-001, FR-002).

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | string (uuid) | Stable local identifier. |
| `nickname` | string | Required; 1–60 chars after trim; not unique (two people may share a display name, though discouraged). |
| `addresses` | `SavedAddress[]` | ≥1 in normal use; a contact with zero addresses is allowed transiently during edit but pruned on save. |
| `createdAt` | number (epoch ms) | |
| `updatedAt` | number (epoch ms) | |

### SavedAddress (persisted)

A single wallet address used by a contact on a specific network.

| Field | Type | Constraints |
|-------|------|-------------|
| `address` | string | Required; valid EVM address; stored checksummed for display, compared lowercased. |
| `chainId` | number | **Required**; defaults to the active chain on entry (clarified Q3). |
| `notes` | string | Optional; ≤500 chars. |
| `addedAt` | number (epoch ms) | |

**Identity / uniqueness**: A SavedAddress is uniquely identified by
`(lowercase(address), chainId)` (clarified Q3). The same address on two chains is
two distinct entries (FR-007, edge case). Duplicate detection compares on this key
regardless of capitalisation/checksum formatting.

### RestrictionStatus (derived, NOT persisted)

Computed by `useAddressScreening` per `(chainId, lowercase(address))`.

| Value | Meaning | Source |
|-------|---------|--------|
| `clear` | Screened and allowed | `available && allowed` |
| `restricted` | Screened and disallowed | `available && !allowed` |
| `uncertain` | Could not screen (guard unconfigured/unreachable) | `!available` (fail-closed, FR-011) |

A `Contact` is "contains-restricted" if any of its addresses (on their respective
chains) resolves to `restricted` (FR-012). Status is always tagged to the chain it
was screened on and never shown as applying to another chain (FR-014).

## Relationships

```text
AddressBook (1) ──< Contact (N) ──< SavedAddress (N)
                                        │
                                        └─ (chainId, address) ──> RestrictionStatus  (derived at runtime)
```

## Validation rules (enforced in addressBookStore)

| Rule | Requirement |
|------|-------------|
| Address format | Must match a valid EVM address (reuse existing address validation / ethers `getAddress`). Reject before save (FR-005). |
| Nickname | Non-empty after trim; trimmed; length-capped. |
| Network required | Every SavedAddress must have a `chainId`; UI defaults it to the active chain (FR-003). |
| Duplicate within book | Adding `(address, chainId)` that already exists anywhere is flagged; the member may consolidate or proceed (edge case). Same `address` on a different `chainId` is always allowed. |
| Notes length | ≤500 chars; optional. |
| Normalisation | Persist checksummed address; index/compare on lowercase. |

## State transitions

Contacts and addresses are simple CRUD (no lifecycle state machine). The only
"state" of interest is the derived RestrictionStatus, recomputed on book open and on
selection with a short-lived session cache (clarified Q5); it is never written to
storage.

## Import / merge semantics (clarified Q2 — additive merge keyed on address)

Given an imported `AddressBook` and the current one:

1. For each imported SavedAddress, key on `(lowercase(address), chainId)`:
   - **Not present locally** → add it (attaching to the imported contact's nickname,
     creating the contact if needed).
   - **Present locally** → keep the existing entry; do not duplicate.
2. When an imported entry's contact `nickname`/`notes` differ from the stored values
   for the same address, surface a per-conflict choice: **keep existing** or **take
   imported** (FR-022). Never silently overwrite or delete.
3. Existing local-only contacts/addresses are always preserved.

## Export file (plain text — issue #1550)

The whole file; there is no envelope around it any more (see
`contracts/export-format.md`). Each address may also carry an informational
`network` label, which is written for the reader and ignored on import:

```json
{
  "type": "fairwins-address-book",
  "schemaVersion": 1,
  "exportedAt": 1750000000000,
  "contacts": [
    {
      "nickname": "Alex",
      "addresses": [
        { "address": "0xAbc…", "chainId": 137, "notes": "main" },
        { "address": "0xDef…", "chainId": 63, "notes": "" }
      ]
    }
  ]
}
```

Local-only fields (`id`, timestamps) are regenerated on import and are not relied
upon across devices.
