# Contract: account resolution — `lib/passkey/accountLookup.js`

The seam every caller uses to answer "which account does this passkey control?". It replaces the
derive-then-check logic inside `connectors/passkey.js#resolveAccountForCredential`.

---

## 1. `resolveAccounts({ ownerBytes, chainIds, deadlineMs, deps })`

Searches for accounts the key currently controls and confirms each one.

**Returns** a `Resolution` ([data-model.md](../data-model.md)) — never throws for a search or read
failure. A thrown error means a programming fault, not a chain condition.

### Invariants a caller may rely on

1. **An address appears in the result only in `outcome: 'resolved'`.** The other three carry no
   address to open a session on. This is the contract's reason for existing.
2. **Every returned account was confirmed against its CURRENT owner set**, not against history and
   not against a derivation. A rotated-off key never appears.
3. **`ownerIndex` is the slot the chain reported.** Never 0 by assumption — signatures depend on the
   real index (spec 045 FR-009).
4. **`unverified` is returned when the chain could not be read**, and never conflated with
   `none-found`. Callers must not treat them alike.
5. **The search is bounded by `deadlineMs`** and resolves `unverified` on expiry. It does not hang.
   (Spec 103's lesson, made structural: an unbounded wait on an external system is how a sign-in
   becomes a lockout.)
6. **Reads go through the spec-069 read-provider seam**, so a member's own RPC endpoints and
   failover apply.
7. **`chainIds` are cohort-bounded by the caller** (`cohortChainIds()`); the resolver never widens
   them. A mainnet build must not search testnet chains (constitution III).

### Search legs

Attempted cheapest-first; results are unioned, then every candidate is confirmed.

| leg | shipped | cost | finds |
|---|---|---|---|
| nonce enumeration | Release 2 | N × `getCode` | accounts this key created at a non-zero nonce |
| `AccountCreated` scan | Release 2 | chunked `getLogs` over the factory | accounts this key was an **initial** owner of |
| `AddOwner` discovery | deferred | topic-only scan / index | keys added **after** creation |

A leg that fails does not fail the resolution: it contributes nothing and is named in the reason if
the overall outcome is `unverified`. A leg that is not yet implemented is simply absent — the
resolver never reports `none-found` on the strength of legs it did not run, so while
`AddOwner` discovery is deferred the honest answer for that shape is `none-found` **with a reason
that says the search cannot see keys added after creation**, and the member is offered US3.

---

## 2. `verifyAccountForKey({ ownerBytes, address, chainId, deps })`

Confirms one named address — the primitive behind both the confirmation step above and the
member-supplied address in US3.

**Returns** `Resolution` narrowed to `resolved` (exactly one account), `not-controller`, or
`unverified`.

### Invariants

1. **The address is a hint, never a claim.** Where it came from — a search leg or the member's
   keyboard — changes nothing about the check performed.
2. **`not-controller` is returned only when the chain positively said so**: the account is deployed
   and its current owner set does not include the key. An unreadable chain is `unverified`.
3. **An address with no code is `not-controller`**, with a reason distinguishing "nothing is
   deployed there" from "deployed, but this passkey is not an owner". A member who mistypes an
   address and one whose passkey was rotated off need different next steps.

---

## 3. What `resolveAccountForCredential` may do afterwards

The connector keeps ownership of the session, and gains one prohibition.

- On `resolved` with **one** account: open the session, write the credential record.
- On `resolved` with **more than one**: return them for the member to choose (FR-007). The connector
  does not pick.
- On `none-found`, `unverified`, or `not-controller`: **do not open a session.** Surface the outcome
  and the recovery entry points.

> **The removed behaviour, stated explicitly so it is not reintroduced:** the connector must no
> longer return a derived address when the chain did not confirm it. Today an undeployed derived
> address is returned as the member's account, which signs a lost-device member into a brand-new
> empty account with nothing said. Derivation survives only for *creating* an account the member
> explicitly asked for.

---

## 4. Errors and reasons

Every non-`resolved` outcome carries a member-renderable `reason`. Reasons name what the app could
not do, never what the member did wrong, and never imply a fact the app does not have:

| outcome | reason says |
|---|---|
| `none-found` | no account on the searched chains lists this passkey — and, while `AddOwner` discovery is deferred, that a passkey added to an existing account cannot be found this way |
| `unverified` | the chain could not be read, and that this is not the same as having no account |
| `not-controller` | whether the address holds no contract at all, or holds one whose owners do not include this passkey |

A `reason` is never a raw RPC error string.
