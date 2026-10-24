# Data Model: Funding Pools (spec 103)

## On-chain

### FundingPool (immutable ERC-1167 clone)

| Field | Type | Set | Meaning |
|---|---|---|---|
| `factory` | address | init | Compliance callbacks + provenance anchor |
| `token` | IERC20 | init | Allow-listed stablecoin |
| `organizer` | address | init | The only party who can `close` / `cancel` |
| `goal` | uint256 | init | Target in token base units (> 0); informational |
| `purpose` | string | init | 1..200 bytes, public |
| `contributeDeadline` | uint64 | init | Contributions accepted while `now < contributeDeadline` |
| `settleDeadline` | uint64 | init | After it, `pokeDeadline` → Refunding |
| `createdBlock` | uint64 | init | Lower bound for event scans |
| `state` | enum {Open, Closed, Refunding} | mutable | Lifecycle |
| `totalRaised` | uint256 | mutable | Σ contributions; equals escrow while Open |
| `contributorCount` | uint32 | mutable | Distinct contributors |
| `refundVotes` | uint32 | mutable | Distinct contributors who voted |
| `refundedCount` | uint32 | mutable | Contributors who collected |
| `refundReason` | uint8 {0 none, 1 organizer, 2 majority, 3 deadline} | mutable | Why refunding |
| `closedAt` | uint64 | mutable | Timestamp of close / refunding start |
| `contributed[addr]` | uint256 | mutable | Recorded contribution (refund amount) |
| `votedRefund[addr]` | bool | mutable | One vote per contributor |
| `refunded[addr]` | bool | mutable | Collected once |

**State transitions**

```
Open ──close() [organizer]──────────────────────────────▶ Closed   (pays totalRaised → organizer)
Open ──cancel() [organizer]─────────────────────────────▶ Refunding (reason 1)
Open ──voteRefund() [contributor, votes > count/2]──────▶ Refunding (reason 2)
Open ──pokeDeadline() [anyone, now ≥ settleDeadline]────▶ Refunding (reason 3)
Refunding ──claimRefund() [each contributor once]        (pays contributed[addr] → addr)
```

**Invariants** (asserted in `FundingPool.security.test.js`)

- I1 `token.balanceOf(pool) == totalRaised` while `Open`; `== totalRaised − Σ refunded amounts`
  while `Refunding`; `== 0` after `Closed` (given a well-behaved token — the factory allow-list).
- I2 Value leaves the pool only via `close` (to `organizer`) or `claimRefund` (to the claimant,
  exactly `contributed[claimant]`).
- I3 `Closed` and `Refunding` are terminal; no function changes state out of them.
- I4 A pool that is `Open` at `settleDeadline` can always be moved to `Refunding` by anyone.
- I5 `refundVotes ≤ contributorCount`; `refundedCount ≤ contributorCount`.

### FundingPoolFactory (UUPS proxy) — append-only storage

`poolImpl`, `sanctionsGuard`, `membershipManager`, `screeningRequired`, `poolCount`, `_pools`,
`poolAddressToId`, `_phraseToPool`, `_poolToPhrase`, `allowedToken`, `__gap[49]` — the wager
factory's layout, so the two gates read alike. Constants: `POOL_PARTICIPANT_ROLE`,
`MAX_PURPOSE_BYTES = 200`, `MAX_CONTRIBUTE_WINDOW = 30 days`, `MAX_SETTLE_WINDOW = 180 days`.

### Events (the activity feed's vocabulary)

| Event | Emitted by | Feed entry |
|---|---|---|
| `PoolCreated(id, pool, organizer, wordIndices, token, goal, purpose, contributeDeadline, settleDeadline)` | factory | (discovery only) |
| `Contributed(contributor, amount, contributedTotal, totalRaised)` | pool | "A contributed X" |
| `PoolClosed(organizer, amount)` | pool | "Organizer closed — X collected" |
| `RefundVoted(contributor, votes, needed)` | pool | "A voted to refund (v/n)" |
| `RefundingStarted(reason)` | pool | "Refunding — by organizer / by majority / after deadline" |
| `RefundClaimed(contributor, amount)` | pool | "A collected X back" |

## Frontend

### PoolSummary (hook return, one object per read)

`address, chainId, organizer, isOrganizer, purpose, goal, goalFormatted, totalRaised,
raisedFormatted, progressPct (0..100 capped) , goalMet, tokenAddress, tokenSymbol, tokenDecimals,
contributorCount, refundVotes, refundVotesNeeded, refundedCount, refundReason, state, stateLabel,
contributeDeadline, settleDeadline, contributionOpen, canClose, canCancel, canPokeDeadline,
me: { contributed, contributedFormatted, hasContributed, voted, refunded, canVote, canClaimRefund },
phrase (words, if resolvable), wordIndices`

### ActivityEntry

`{ kind: 'contribute'|'close'|'vote'|'refunding'|'refund', actor, amount?, votes?, needed?,
reason?, blockNumber, logIndex, txHash, timestamp? }` — sorted by `(blockNumber, logIndex)`.

### MyPoolsItem

`{ address, purpose, role: 'organizer'|'contributor'|'both', state, bucket: 'active'|'finished',
progressPct, raisedFormatted, goalFormatted, nextAction: 'share'|'close'|'contribute'|'vote'|
'collect'|null, route }`

### Device storage

- `fairwins_funding_pools_v1_<account>` → `[{ address, role }]` (addresses only; idempotent add).
- Share-phrase language: the existing spec-034 preference (`WordListLanguageSelector`).
