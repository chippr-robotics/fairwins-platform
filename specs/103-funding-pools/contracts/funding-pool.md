# Contract: FundingPool + FundingPoolFactory (spec 103)

Solidity 0.8.24. Both live in `contracts/pools/`. Naming deliberately parallels spec 034 so a
reader of one can read the other.

## FundingPoolFactory (UUPS proxy, `UUPSManaged` + `ReentrancyGuardUpgradeable` + `SignerIntentBase`)

```solidity
struct CreateFundingPoolParams {
    address token;              // allow-listed on value-bearing networks (screeningRequired)
    uint256 goal;               // > 0, token base units
    string  purpose;            // 1..MAX_PURPOSE_BYTES (200)
    uint64  contributeDeadline; // > now, <= now + 30 days
    uint64  settleDeadline;     // > contributeDeadline, <= now + 180 days
}

function initialize(address admin, address poolImpl, address sanctionsGuard, address membershipManager, bool screeningRequired) initializer
function createPool(CreateFundingPoolParams calldata p) returns (uint256 poolId, address pool)
function createPoolWithSig(CreateFundingPoolParams calldata p, address signer, bytes32 nonce, uint256 validAfter, uint256 validBefore, bytes calldata sig) returns (uint256, address)
    // struct: CreateFundingPool(address organizer,address token,uint256 goal,bytes32 purposeHash,
    //         uint64 contributeDeadline,uint64 settleDeadline,bytes32 nonce,uint256 validAfter,uint256 validBefore)
    // purposeHash = keccak256(bytes(p.purpose)); domain "FairWins FundingPoolFactory"/"1"

// gateway + registry (same names as WagerPoolFactory so lib/pools/gateway.js#resolvePool works unchanged)
function poolByPhrase(uint32[4] calldata wordIndices) view returns (address)
function phraseOfPool(address pool) view returns (uint32[4] memory)
function poolById(uint256 poolId) view returns (address)
function poolCount() view returns (uint256)
function poolAddressToId(address) view returns (uint256)   // 0 == unknown

// compliance callbacks used by clones (real wallet)
function screen(address account) view
function requireMembership(address account) view           // POOL_PARTICIPANT_ROLE via checkCanCreate

// relayer forwarders — provenance-gated (`poolAddressToId[pool] != 0`), pure pass-through
function closeWithSigFor(address pool, address signer, bytes32 nonce, uint256 validAfter, uint256 validBefore, bytes calldata sig)
function cancelWithSigFor(address pool, ...same)
function voteRefundWithSigFor(address pool, ...same)
function claimRefundWithSigFor(address pool, ...same)
function contributeWithAuthorizationFor(address pool, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
function pokeDeadlineFor(address pool)
function invalidateNonceWithSigFor(address pool, address signer, bytes32 nonce, uint256 validBefore, bytes calldata sig)

// admin (DEFAULT_ADMIN_ROLE)
function setTemplate(address newPoolImpl)
function setSanctionsGuard(address guard)
function setMembershipManager(address manager)
function setAllowedToken(address token, bool allowed)

event PoolCreated(uint256 indexed poolId, address indexed pool, address indexed organizer, uint32[4] wordIndices,
                  address token, uint256 goal, string purpose, uint64 contributeDeadline, uint64 settleDeadline)
event TemplateUpdated(address indexed newPoolImpl); event SanctionsGuardUpdated(address indexed guard); event TokenAllowed(address indexed token, bool allowed)

error InvalidParams(); error BadDeadlines(); error PurposeLength(); error TokenNotAllowed();
error ScreeningNotConfigured(); error MembershipNotConfigured(); error MembershipDenied(); error UnknownPool();
```

Storage is append-only with `uint256[49] __gap` after `allowedToken`. Registered in
`scripts/deploy/check-storage-layout.js` under deployments key `fundingPoolFactory`.

## FundingPool (immutable clone, `Initializable` + `ReentrancyGuardUpgradeable` + `SignerIntentBase`)

```solidity
enum FundingState { Open, Closed, Refunding }

function initialize(address token, address organizer, uint256 goal, string calldata purpose, uint64 contributeDeadline, uint64 settleDeadline) initializer
    // factory-only (msg.sender recorded as `factory`); domain "FairWins FundingPool"/"1"; createdBlock = block.number

// views
factory(), token(), organizer(), goal(), purpose(), contributeDeadline(), settleDeadline(), createdBlock(),
state(), totalRaised(), contributorCount(), refundVotes(), refundedCount(), refundReason(), closedAt(),
contributed(address), votedRefund(address), refunded(address)
function refundVotesNeeded() view returns (uint32)   // contributorCount / 2 + 1 (0 when no contributors)
function contributionOpen() view returns (bool)      // state == Open && now < contributeDeadline

// money in
function contribute(uint256 amount)                                       // requires prior ERC-20 approve
function contributeWithAuthorization(address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)   // EIP-3009 receiveWithAuthorization to this clone

// organizer
function close()          / closeWithSig(address signer, bytes32 nonce, uint256 validAfter, uint256 validBefore, bytes calldata sig)
    // struct CloseFundingPool(address organizer,bytes32 nonce,uint256 validAfter,uint256 validBefore)
function cancel()         / cancelWithSig(...)
    // struct CancelFundingPool(address organizer,bytes32 nonce,uint256 validAfter,uint256 validBefore)

// contributors
function voteRefund()     / voteRefundWithSig(...)
    // struct VoteRefund(address contributor,bytes32 nonce,uint256 validAfter,uint256 validBefore)
function claimRefund()    / claimRefundWithSig(...)
    // struct ClaimRefund(address contributor,bytes32 nonce,uint256 validAfter,uint256 validBefore)

// anyone
function pokeDeadline()   // Open && now >= settleDeadline → Refunding(reason 3)

event Contributed(address indexed contributor, uint256 amount, uint256 contributedTotal, uint256 totalRaised)
event PoolClosed(address indexed organizer, uint256 amount)
event RefundVoted(address indexed contributor, uint32 votes, uint32 needed)
event RefundingStarted(uint8 reason)              // 1 organizer, 2 majority, 3 deadline
event RefundClaimed(address indexed contributor, uint256 amount)

error NotOrganizer(); error NotContributor(); error WrongState(); error ContributionsClosed(); error ZeroAmount();
error AlreadyVoted(); error NothingToRefund(); error DeadlineNotPassed(); error BadValue();
```

### Rules (checked in this order, checks → effects → interactions)

- `contribute`: `state == Open`, `now < contributeDeadline`, `amount > 0`, `factory.screen(from)`,
  `factory.requireMembership(from)`; effects: first-time → `contributorCount++`;
  `contributed[from] += amount`; `totalRaised += amount`; emit; then `safeTransferFrom` (or
  `receiveWithAuthorization`). `nonReentrant`.
- `close`: actor == organizer, `state == Open` (any time up to and including after
  `contributeDeadline`; `settleDeadline` is not checked — after it the pool may already have been
  poked, in which case `state != Open` refuses); effects: `state = Closed`, `closedAt`; emit; then
  `safeTransfer(organizer, totalRaised)` if > 0. `nonReentrant`.
- `cancel`: actor == organizer, `state == Open` → `Refunding`, reason 1.
- `voteRefund`: `state == Open`, `contributed[actor] > 0`, `!votedRefund[actor]`; effects:
  `votedRefund = true`, `refundVotes++`; emit `RefundVoted(actor, votes, needed)`; if
  `votes >= needed` → `Refunding`, reason 2.
- `claimRefund`: `state == Refunding`, `contributed[actor] > 0`, `!refunded[actor]`; effects:
  `refunded = true`, `refundedCount++`; emit; then `safeTransfer(actor, contributed[actor])`.
  `nonReentrant`.
- `pokeDeadline`: `state == Open`, `now >= settleDeadline` → `Refunding`, reason 3.
- Every `…WithSig` twin: `_verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig)`
  (burns the nonce) then the same internal `_xBy(signer)`.

### Explicitly absent

- No `recipient` on `close`; no admin sweep / rescue; no `setGoal` / `setPurpose` (immutable after
  create); no automatic close on reaching the goal.
