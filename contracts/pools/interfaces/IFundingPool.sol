// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Funding-pool lifecycle (spec 103). `Closed` and `Refunding` are terminal.
enum FundingState {
    Open,
    Closed,
    Refunding
}

/// @title IFundingPool
/// @notice Surface for an isolated, immutable funding-pool clone (spec 103). A sibling of the spec-034
///         {IWagerPool} with the wager removed: contributors put in ANY amount, the organizer closes to
///         collect the whole pot at any time (goal met or not), and the organizer / a strict majority of
///         contributors / the settlement deadline flip the pool to refunding, where each contributor
///         collects exactly what they put in.
/// @dev    Security-critical invariants: the ONLY escrow exits are {close} (→ organizer) and
///         {claimRefund} (→ the claimant's own recorded contribution); `Closed`/`Refunding` are terminal;
///         after `settleDeadline` anyone can move an `Open` pool to `Refunding` (never-stranded). Timing
///         mirrors {IWagerPool}: two absolute deadlines, bounded/ordered by the factory.
interface IFundingPool {
    // ---- Refs ----
    function factory() external view returns (address);
    function token() external view returns (address);

    // ---- Seeded config ----
    function organizer() external view returns (address);
    function goal() external view returns (uint256);
    function purpose() external view returns (string memory);
    function contributeDeadline() external view returns (uint64);
    function settleDeadline() external view returns (uint64);
    function createdBlock() external view returns (uint64);

    // ---- Bounded mutable state ----
    function state() external view returns (FundingState);
    function totalRaised() external view returns (uint256);
    function contributorCount() external view returns (uint32);
    function refundVotes() external view returns (uint32);
    function refundedCount() external view returns (uint32);
    function refundReason() external view returns (uint8);
    function closedAt() external view returns (uint64);
    function contributed(address account) external view returns (uint256);
    function votedRefund(address account) external view returns (bool);
    function refunded(address account) external view returns (bool);
    function refundVotesNeeded() external view returns (uint32);
    function contributionOpen() external view returns (bool);

    // ---- Money in ----
    function contribute(uint256 amount) external;
    function contributeWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    // ---- Organizer ----
    function close() external;
    function cancel() external;

    // ---- Contributors ----
    function voteRefund() external;
    function claimRefund() external;

    // ---- Anyone ----
    function pokeDeadline() external;

    // ---- Relayer twins (spec 035 pattern): authorize the recovered `signer`, submittable by anyone ----
    function closeWithSig(address signer, bytes32 nonce, uint256 validAfter, uint256 validBefore, bytes calldata sig)
        external;
    function cancelWithSig(address signer, bytes32 nonce, uint256 validAfter, uint256 validBefore, bytes calldata sig)
        external;
    function voteRefundWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;
    function claimRefundWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;

    // ---- Events (the activity feed's vocabulary) ----
    event Contributed(address indexed contributor, uint256 amount, uint256 contributedTotal, uint256 totalRaised);
    event PoolClosed(address indexed organizer, uint256 amount);
    event RefundVoted(address indexed contributor, uint32 votes, uint32 needed);
    /// @param reason 1 = organizer cancelled, 2 = contributor majority, 3 = settlement deadline passed.
    event RefundingStarted(uint8 reason);
    event RefundClaimed(address indexed contributor, uint256 amount);
}
