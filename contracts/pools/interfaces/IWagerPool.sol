// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Pool lifecycle (FR-007a/FR-016/FR-019/FR-023).
enum PoolState {
    JoiningOpen,
    JoiningClosed,
    Resolved,
    Cancelled
}

/// @notice One row of the payout matrix (FR-018). A winner is identified by their **public wallet
///         address** — the address itself is the "claim code", derivable by every party from the public
///         roster, so no off-chain secret is exchanged. The matrix preimage hashes to the locked outcome.
struct PayoutEntry {
    address winner;
    uint256 amount;
}

/// @title IWagerPool
/// @notice Surface for an isolated, immutable group-wager pool clone (spec 034, address-based redesign).
///         Members buy in with USDC with their real wallet; the creator proposes a payout outcome that
///         members approve to a fraction-of-joined threshold; winners claim to any address.
/// @dev    Security-critical invariants: no escrow release outside {claim} (Resolved) or
///         {refund}/{cancel} (FR-022); the creator cannot force a payout (FR-020b); funds are never
///         stuck (FR-019). Timing mirrors the 1v1/oracle {WagerRegistry}: two absolute deadlines
///         (`acceptDeadline`, `resolveDeadline`). Nicknames are client-side only (FR-009).
interface IWagerPool {
    // ---- Refs ----
    function factory() external view returns (address);
    function token() external view returns (address);

    // ---- Seeded / bounded state ----
    function creator() external view returns (address);
    function state() external view returns (PoolState);
    function memberCount() external view returns (uint32);
    function maxMembers() external view returns (uint32);
    function frozenDenominator() external view returns (uint32);
    function thresholdBips() external view returns (uint16);
    function acceptDeadline() external view returns (uint64);
    function resolveDeadline() external view returns (uint64);
    function lockedOutcome() external view returns (bytes32);

    // ---- Join (P1: caller pays gas; requires prior ERC-20 approve) ----
    function join() external;

    // ---- Join (P2: gasless via EIP-3009; relayer pays gas) ----
    function joinWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    // ---- Close joining (FR-007a) ----
    function closeJoining() external; // creator-initiated; also auto on full
    function pokeDeadline() external; // anyone: closes if acceptDeadline passed

    // ---- Resolution (FR-020: creator proposes the full validated matrix, members approve) ----
    function proposeOutcome(PayoutEntry[] calldata entries) external; // onlyCreator, while JoiningClosed
    function approve(bytes32 proposalId) external; // must equal currentProposalId

    // ---- Payout / refund ----
    /// @notice Claim a winning share to any `recipient`. `msg.sender` must equal
    ///         `entries[index].winner`; the payout-matrix preimage `entries` MUST hash to
    ///         `lockedOutcome` and allocate the full escrow. Pays to any address the winner chooses.
    function claim(PayoutEntry[] calldata entries, uint256 index, address recipient) external;

    function refund() external;
    function cancel() external; // onlyCreator, while JoiningOpen

    // ---- Relayer twins (spec 035): authorize the recovered EOA `signer`, submittable by anyone.
    //      join is relayable via {joinWithAuthorization} (EIP-3009); pokeDeadline is permissionless.
    function closeJoiningWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;
    function proposeOutcomeWithSig(
        PayoutEntry[] calldata entries,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;
    function approveWithSig(
        bytes32 proposalId,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;
    function claimWithSig(
        PayoutEntry[] calldata entries,
        uint256 index,
        address recipient,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;
    function refundWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;
    function cancelWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external;

    // ---- Events ----
    event Joined(address indexed member); // nickname is client-side only, never on-chain (FR-009)
    event JoiningClosedEvent(uint32 frozenDenominator);
    event OutcomeProposed(bytes32 indexed proposalId, PayoutEntry[] entries);
    event Approved(bytes32 indexed proposalId, address indexed member);
    event OutcomeLocked(bytes32 indexed proposalId);
    event Claimed(address indexed winner, address recipient, uint256 amount);
    event Refunded(address indexed member, uint256 amount);
    event PoolCancelled();
}
