# Passkey account recovery

*Spec 104. See also [`specs/104-passkey-account-recovery/`](../../specs/104-passkey-account-recovery/).*

## The bug this replaced

A passkey does not carry its account address. To sign a member in, the app has to answer "which
account does this key control?" — and until spec 104 it **computed** the answer instead of looking
it up.

`resolveAccountForCredential` derived an address from the recovered public key on the assumption
that the key was the account's **sole initial owner at nonce 0**, read the chain to sanity-check
that guess, and — when the guess landed on an address with no contract — returned it anyway.

For most members the assumption holds and nothing looks wrong. For a member whose passkey was
added to an existing account as a second controller, or who had more than one account, it does not:
the derived address is somewhere they have never been. The app signed them into that brand-new
empty account, showed a zero balance, and said nothing. A member reads that as their money being
gone.

The fix is not a better guess. It is to stop returning unconfirmed addresses.

## The shape of an answer

`frontend/src/lib/passkey/accountLookup.js` returns one of four things, and **a value exists in
exactly one of them**:

```js
resolved(accounts)                 // 1..n confirmed accounts — the only shape carrying an address
noneFound(reason)                  // the chain was read; nothing on it lists this key
unverified(reason)                 // the chain could NOT be read
notController(reason, address)     // a NAMED account exists; the key is not among its owners
```

Three of the four constructors take no address at all. That is deliberate and structural: it makes
"return the derived one anyway" impossible rather than merely discouraged — the same device as
spec 089's `reading.js` (one of three constructors takes a number) and spec 071's estate reads.

### `unverified` is not `none-found`

An unreachable chain is not evidence of absence. Collapsing the two tells a member with a perfectly
good account that they have none — the identity equivalent of rendering an unreadable balance as
`$0`, which constitution III already forbids. The precedents run through the codebase: spec 095
keeps `auth_unverifiable` a retryable 503 rather than a denial, spec 071 keeps `unreadable` out of
the zero path, spec 084 keeps `unverifiable` as a third message-signing verdict.

They also lead to different member actions — **retry** versus **recover** — which is why the
recovery screen leads with "Try again" for one and the address field for the other.

## The rules

1. **A session opens only on `resolved`, or on a counterfactual the member accepted.** The
   connector returns a confirmed address only when the chain confirmed it; everything else raises
   `AccountUnresolved`, which carries the outcome so the surface can offer the right next step.

   The one deliberate exception is worth stating in full, because the blunt version of this rule
   was wrong. `none-found` also describes a member who signed up on another device and has not yet
   spent: their account is real and simply holds no code. Refusing them locks out every member who
   signs up and does not immediately transact, and they cannot type an address nobody has shown
   them. So the derived address is **offered, labelled as not-yet-used, and opened only when they
   press it** (`acceptCounterfactual`). That is safe because the address is a deterministic
   function of the key — the same address their first device showed — and it satisfies US2, whose
   rule is that an unverified address is never presented *as though the app had confirmed it*.

   `unverified` gets no such offer: an unreachable chain says nothing about whether an account
   exists, so inviting the member onward would invite them to walk away from a real one.
2. **Verification is against the CURRENT owner set, not history.** A key that once owned an account
   and was rotated off does not control it; offering it would send the member somewhere they can no
   longer sign for.
3. **`ownerIndex` is whatever the chain reported.** Never 0 by assumption — signatures depend on
   the real slot (spec 045 FR-009), and an account that gained controllers does not put this key
   first.
4. **An address is a hint, never a claim.** Where it came from — a search leg or the member's
   keyboard — changes nothing about the check performed. This is what stops "type any address" from
   being a way into somebody else's account.
5. **Every leg is deadline-bounded and expires to `unverified`.** This is not a borrowed principle:
   v1.16.1 shipped because an unbounded wait on an external system turned a single failure into a
   permanent lockout. A log scan across a busy chain is the same shape of risk.
6. **Derivation survives only where it is truthful** — creating a *new* account, which the member
   asks for explicitly (`mode: 'sign-up'`). It is no longer an answer to "where is my account?".
7. **Reads go through the spec-069 seam.** Recovery is read-heavy and so the flow most likely to be
   rate-limited off a shared default endpoint — and the cost there is not a slow screen, it is an
   `unverified` verdict on a member's own account.

## What is covered, and what is not

Release 1 confirms **one** candidate: the address the key would own as sole initial owner at nonce
0. Members outside that shape recover by entering their account address (US3), which reaches
accounts no derivation could find.

Discovery — nonce enumeration and an `AccountCreated` scan — is Release 2 (issue #1432), and it is
**blocked on recording `deployBlocks.accountFactory`**. The factory has no recorded deploy block on
any chain, and every consumer in this repo reads `record.deployBlocks?.X || 0`, so a missing entry
does not fail: it starts the scan at block 0 and hangs. `CLAUDE.md` records the identical
degradation for `safeProposalHub`.

Keys added to an account **after** creation cannot be discovered at all: `AddOwner` carries no
address to filter on, and the subgraph indexes no account entities (research R3/R4). That shape is
covered by the address path, and `none-found` says so in as many words rather than implying no
account exists.

## Files

| file | role |
|---|---|
| `frontend/src/lib/passkey/accountLookup.js` | the resolver: outcomes, verification, search |
| `frontend/src/connectors/passkey.js` | consumes it; raises `AccountUnresolved` |
| `frontend/src/components/wallet/RecoverAccount.jsx` | the member surface |
| `frontend/src/lib/passkey/smartAccount.js` | `defaultPublicClient` on the spec-069 seam |
