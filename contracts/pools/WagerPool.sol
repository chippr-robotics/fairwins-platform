// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SignerIntentBase} from "../upgradeable/SignerIntentBase.sol";
import {IWagerPool, PoolState, PayoutEntry} from "./interfaces/IWagerPool.sol";

/// @notice Compliance hooks the pool calls back into its factory (single configured guard +
///         membership manager, screening the real wallet — FR-021).
interface IPoolFactoryHooks {
    function screen(address account) external view;
    function requireMembership(address account) external view;
}

/// @notice EIP-3009 receive authorization used by the gasless join path.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title WagerPool
/// @notice A non-anonymous, address-based group-wager pool (spec 034, address-based redesign — the
///         Semaphore/ZK design was dropped after testers rejected the private "claim code"). Deployed as
///         an immutable ERC-1167 clone by {WagerPoolFactory}. Members `join()` / `approve()` / `claim()`
///         with their real wallet; the payout matrix keys on the winner's public address (the address is
///         the "claim code"), so the creator builds the payout straight from the roster and every party
///         derives the same claim identity with no off-chain code exchange.
///
/// @dev    Timing mirrors the 1v1/oracle {WagerRegistry} so pools look and feel identical: two ABSOLUTE
///         deadlines seeded at init — `acceptDeadline` (joining/acceptance closes) and `resolveDeadline`
///         (resolution must complete by). Bounds + ordering are enforced by the factory
///         ({WagerPoolFactory._checkDeadlines}), matching `WagerRegistry`.
///
///         Relayer-ready (spec 035/036): every actor-attributed action has a `…WithSig` twin
///         ({approveWithSig}/{claimWithSig}/{proposeOutcomeWithSig}/{closeJoiningWithSig}/{cancelWithSig}/
///         {refundWithSig}) that authorizes the recovered EOA `signer` instead of `msg.sender`, so a
///         relayer can submit on the member's behalf. Because clones are IMMUTABLE, these are baked into
///         the template at deploy time. The money-in join has its own relayable form ({joinWithAuthorization},
///         EIP-3009). Self-submit entrypoints remain the primary path (FR-014).
///
///         Security posture: checks-effects-interactions + a reentrancy guard on every value-moving
///         path; the ONLY escrow exits are {claim} (Resolved) and {refund}/{cancel}; the creator cannot
///         force a payout (members approve to a fraction-of-joined threshold); the resolveDeadline refund
///         path guarantees funds are never stuck. The master calls `_disableInitializers()`; clones
///         initialize exactly once.
///
///         Payout-matrix trust model (for the security review): the resolved outcome is committed as a
///         `keccak256(entries)` hash at approve/lock time; the entries (winners + amounts) are revealed
///         only at {claim}. {claim} enforces `sum(entries) == escrowTotal` and per-INDEX single-claim, so
///         a matrix that sums to escrow is fully claimable even if the same winner appears in multiple
///         rows. A malformed *approved* matrix (sum != escrow, or a zero-address winner row) can strand
///         funds; that is inherent to the commit-hash design (members approve the off-chain-revealed
///         matrix, verified against this hash) and is unchanged from the prior design.
///
///         SECURITY REVIEW REQUIRED before this template is set live on any value-bearing network
///         (`.github/agents/smart-contract-security`); see specs/034-zk-wager-pools/implementation-notes.md.
contract WagerPool is Initializable, ReentrancyGuardUpgradeable, SignerIntentBase {
    using SafeERC20 for IERC20;

    // ---- EIP-712 intent typehashes (spec 035 twins) ----
    bytes32 private constant APPROVE_TYPEHASH =
        keccak256("ApproveOutcome(address member,bytes32 proposalId,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("ClaimShare(address winner,uint256 index,address recipient,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant PROPOSE_TYPEHASH =
        keccak256("ProposeOutcome(address creator,bytes32 proposalId,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant CLOSE_TYPEHASH =
        keccak256("CloseJoining(address creator,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant CANCEL_TYPEHASH =
        keccak256("Cancel(address creator,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant REFUND_TYPEHASH =
        keccak256("Refund(address member,bytes32 nonce,uint256 validAfter,uint256 validBefore)");

    // ---- Refs (seeded at init; immutable for the pool's life) ----
    address public factory;
    IERC20 private _token;

    // ---- Config (seeded at init) ----
    address public creator;
    uint256 public buyIn;
    uint32 public maxMembers;
    uint16 public thresholdBips;
    /// @notice Absolute unix time joining/acceptance closes (mirrors WagerRegistry.acceptDeadline).
    uint64 public acceptDeadline;
    /// @notice Absolute unix time by which resolution must complete; after it the pool is refund-only
    ///         (mirrors WagerRegistry.resolveDeadline).
    uint64 public resolveDeadline;

    // ---- Bounded mutable state ----
    PoolState public state;
    uint32 public memberCount;
    uint32 public frozenDenominator;
    uint64 public closedAt;
    uint256 public escrowTotal;
    bytes32 public currentProposalId;
    bytes32 public lockedOutcome;

    mapping(address => bool) public hasJoined;
    mapping(address => bool) public refunded;
    /// @notice Payout-matrix row index => whether it has been claimed. Keyed by index (not winner
    ///         address) so a matrix listing the same winner in multiple rows is fully claimable and never
    ///         strands escrow.
    mapping(uint256 => bool) public claimedIndex;
    /// @notice proposalId => approval count.
    mapping(bytes32 => uint32) public proposalApprovals;
    /// @notice proposalId => member => whether they already approved it (one vote per member per proposal).
    mapping(bytes32 => mapping(address => bool)) public approvedBy;

    error NotCreator();
    error NotMember();
    error WrongState();
    error JoinClosed();
    error PoolFull();
    error AlreadyJoined();
    error DeadlineNotPassed();
    error NoProposal();
    error AlreadyApproved();
    error ResolutionWindowClosed();
    error OutcomeMismatch();
    error IndexOOB();
    error NotWinner();
    error AlreadyClaimed();
    error MatrixSumMismatch();
    error ZeroWinner();
    error EmptyMatrix();
    error BadValue();
    error NothingToRefund();

    event Joined(address indexed member);
    event JoiningClosedEvent(uint32 frozenDenominator);
    /// @notice The proposed outcome, with the FULL validated payout matrix inlined so every member can
    ///         read the exact split on-chain before approving (no off-chain trust). `proposalId` =
    ///         keccak256(abi.encode(entries)).
    event OutcomeProposed(bytes32 indexed proposalId, PayoutEntry[] entries);
    event Approved(bytes32 indexed proposalId, address indexed member);
    event OutcomeLocked(bytes32 indexed proposalId);
    event Claimed(address indexed winner, address recipient, uint256 amount);
    event Refunded(address indexed member, uint256 amount);
    event PoolCancelled();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initialization by the factory (the clone deployer). Deadline bounds/ordering are
    ///         validated by the factory before this is called ({WagerPoolFactory._checkDeadlines}).
    function initialize(
        address token_,
        address creator_,
        uint256 buyIn_,
        uint32 maxMembers_,
        uint16 thresholdBips_,
        uint64 acceptDeadline_,
        uint64 resolveDeadline_
    ) external initializer {
        __ReentrancyGuard_init();
        __EIP712_init("FairWins WagerPool", "1");
        factory = msg.sender;
        _token = IERC20(token_);
        creator = creator_;
        buyIn = buyIn_;
        maxMembers = maxMembers_;
        thresholdBips = thresholdBips_;
        acceptDeadline = acceptDeadline_;
        resolveDeadline = resolveDeadline_;
        state = PoolState.JoiningOpen;
    }

    /// @notice The buy-in token.
    function token() external view returns (address) {
        return address(_token);
    }

    // ---------------------------------------------------------------------
    // Join
    // ---------------------------------------------------------------------

    /// @notice Join the pool by paying the buy-in (requires a prior ERC-20 approve).
    function join() external nonReentrant {
        _preJoin(msg.sender);
        _recordMember(msg.sender);
        _token.safeTransferFrom(msg.sender, address(this), buyIn);
        _maybeAutoClose();
    }

    /// @notice Gasless join via EIP-3009 (a relayer submits; the member signs the authorization).
    function joinWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (value != buyIn) revert BadValue();
        _preJoin(from);
        _recordMember(from);
        IERC3009(address(_token)).receiveWithAuthorization(
            from, address(this), value, validAfter, validBefore, nonce, v, r, s
        );
        _maybeAutoClose();
    }

    function _preJoin(address member) internal view {
        if (state != PoolState.JoiningOpen) revert JoinClosed();
        if (block.timestamp >= acceptDeadline) revert JoinClosed();
        if (memberCount >= maxMembers) revert PoolFull();
        if (hasJoined[member]) revert AlreadyJoined();
        // Compliance on the real wallet (FR-021).
        IPoolFactoryHooks(factory).screen(member);
        IPoolFactoryHooks(factory).requireMembership(member);
    }

    function _recordMember(address member) internal {
        hasJoined[member] = true;
        memberCount += 1;
        emit Joined(member);
    }

    function _maybeAutoClose() internal {
        if (memberCount >= maxMembers) _close();
    }

    // ---------------------------------------------------------------------
    // Close joining (freeze the denominator)
    // ---------------------------------------------------------------------

    function closeJoining() external {
        _closeJoiningBy(msg.sender);
    }

    /// @notice Relayer twin of {closeJoining}: the creator signs; anyone submits.
    function closeJoiningWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        bytes32 structHash = keccak256(abi.encode(CLOSE_TYPEHASH, signer, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _closeJoiningBy(signer);
    }

    function _closeJoiningBy(address actor) internal {
        if (actor != creator) revert NotCreator();
        if (state != PoolState.JoiningOpen) revert WrongState();
        _close();
    }

    /// @notice Permissionless: close joining once the accept deadline has passed (already relayable).
    function pokeDeadline() external {
        if (state != PoolState.JoiningOpen) revert WrongState();
        if (block.timestamp < acceptDeadline) revert DeadlineNotPassed();
        _close();
    }

    function _close() internal {
        state = PoolState.JoiningClosed;
        frozenDenominator = memberCount;
        closedAt = uint64(block.timestamp);
        escrowTotal = uint256(memberCount) * buyIn;
        emit JoiningClosedEvent(frozenDenominator);
    }

    // ---------------------------------------------------------------------
    // Resolution — creator proposes, members approve
    // ---------------------------------------------------------------------

    /// @notice Creator proposes (or revises) the payout outcome by committing the FULL payout matrix.
    ///         It is validated on-chain — non-empty, every winner non-zero, and the amounts sum to the
    ///         exact escrow — so a locked outcome is ALWAYS fully claimable and escrow can never be
    ///         stranded. `proposalId` = keccak256(abi.encode(entries)); revising restarts approvals
    ///         (they are keyed by id). The matrix is emitted so members read the split on-chain.
    function proposeOutcome(PayoutEntry[] calldata entries) external {
        _proposeOutcomeBy(msg.sender, entries);
    }

    /// @notice Relayer twin of {proposeOutcome}: the creator signs an intent bound to the matrix hash;
    ///         anyone submits (passing the full matrix, re-validated + re-hashed on-chain).
    function proposeOutcomeWithSig(
        PayoutEntry[] calldata entries,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        bytes32 proposalId = keccak256(abi.encode(entries));
        bytes32 structHash =
            keccak256(abi.encode(PROPOSE_TYPEHASH, signer, proposalId, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _proposeOutcomeBy(signer, entries);
    }

    function _proposeOutcomeBy(address actor, PayoutEntry[] calldata entries) internal {
        if (actor != creator) revert NotCreator();
        _requireResolving();
        if (entries.length == 0) revert EmptyMatrix();
        uint256 total;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].winner == address(0)) revert ZeroWinner();
            total += entries[i].amount;
        }
        if (total != escrowTotal) revert MatrixSumMismatch();
        bytes32 proposalId = keccak256(abi.encode(entries));
        currentProposalId = proposalId;
        emit OutcomeProposed(proposalId, entries);
    }

    /// @notice A joined member approves `proposalId` (one approval per member per proposal). The pool
    ///         resolves once approvals reach the fraction-of-joined threshold.
    /// @dev `proposalId` MUST equal `currentProposalId`, exactly as in {approveWithSig}. Approving
    ///      "whatever is current at execution" let a creator re-propose a self-dealing matrix (that
    ///      already held their own approval) ahead of a member's pending approve, so the member's vote
    ///      landed on — and locked — a matrix they never saw (issue #1667).
    function approve(bytes32 proposalId) external {
        if (currentProposalId != proposalId) revert OutcomeMismatch();
        _approveBy(msg.sender);
    }

    /// @notice Relayer twin of {approve}: the member signs an approval bound to `proposalId` (so a
    ///         relayer cannot retarget it if the creator revises); anyone submits.
    function approveWithSig(
        bytes32 proposalId,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        bytes32 structHash =
            keccak256(abi.encode(APPROVE_TYPEHASH, signer, proposalId, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        if (currentProposalId != proposalId) revert OutcomeMismatch();
        _approveBy(signer);
    }

    function _approveBy(address member) internal {
        _requireResolving();
        if (!hasJoined[member]) revert NotMember();
        bytes32 pid = currentProposalId;
        if (pid == bytes32(0)) revert NoProposal();
        if (approvedBy[pid][member]) revert AlreadyApproved();
        approvedBy[pid][member] = true;
        uint32 count = proposalApprovals[pid] + 1;
        proposalApprovals[pid] = count;
        emit Approved(pid, member);
        if (count >= _requiredApprovals()) {
            state = PoolState.Resolved;
            lockedOutcome = pid;
            emit OutcomeLocked(pid);
        }
    }

    /// @dev Approvals required = ceil(frozenDenominator * thresholdBips / 10000). A multi-member pool
    ///      requires at least 2 approvals so no single member — the creator/proposer included — can
    ///      unilaterally lock a self-dealing payout (FR-020b: the creator cannot force a payout).
    function _requiredApprovals() internal view returns (uint32) {
        uint256 num = uint256(frozenDenominator) * thresholdBips;
        uint256 req = (num + 9999) / 10000;
        if (req == 0) req = 1;
        if (frozenDenominator >= 2 && req < 2) req = 2;
        return uint32(req);
    }

    /// @dev Resolution actions are valid only while closed AND on/before the resolve deadline; after it
    ///      the pool is refund-only.
    function _requireResolving() internal view {
        if (state != PoolState.JoiningClosed) revert WrongState();
        if (block.timestamp >= resolveDeadline) revert ResolutionWindowClosed();
    }

    // ---------------------------------------------------------------------
    // Payout / refund / cancel — the ONLY escrow exits
    // ---------------------------------------------------------------------

    /// @notice Claim a winning share. `msg.sender` must be `entries[index].winner`; funds go to
    ///         `recipient` (any address the winner chooses). The matrix preimage must hash to the locked
    ///         outcome and allocate the full escrow. Claims are tracked per row index, so a winner listed
    ///         in multiple rows claims each once and nothing is ever stuck.
    function claim(PayoutEntry[] calldata entries, uint256 index, address recipient) external nonReentrant {
        _claimBy(entries, index, recipient, msg.sender);
    }

    /// @notice Relayer twin of {claim}: the winner signs an intent bound to `index` + `recipient`; anyone
    ///         submits. The full `entries` preimage is passed by the submitter and re-checked on-chain.
    function claimWithSig(
        PayoutEntry[] calldata entries,
        uint256 index,
        address recipient,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external nonReentrant {
        bytes32 structHash =
            keccak256(abi.encode(CLAIM_TYPEHASH, signer, index, recipient, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _claimBy(entries, index, recipient, signer);
    }

    function _claimBy(PayoutEntry[] calldata entries, uint256 index, address recipient, address claimant) internal {
        if (state != PoolState.Resolved) revert WrongState();
        if (keccak256(abi.encode(entries)) != lockedOutcome) revert OutcomeMismatch();
        if (index >= entries.length) revert IndexOOB();
        if (entries[index].winner != claimant) revert NotWinner();
        if (claimedIndex[index]) revert AlreadyClaimed();
        if (_sum(entries) != escrowTotal) revert MatrixSumMismatch();

        claimedIndex[index] = true;
        uint256 amount = entries[index].amount;
        emit Claimed(claimant, recipient, amount);
        _token.safeTransfer(recipient, amount);
    }

    /// @notice Recover the buy-in after cancellation or an elapsed resolve deadline with no outcome.
    function refund() external nonReentrant {
        _refundBy(msg.sender);
    }

    /// @notice Relayer twin of {refund}: the member signs; anyone submits; funds go to the signer.
    function refundWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external nonReentrant {
        bytes32 structHash = keccak256(abi.encode(REFUND_TYPEHASH, signer, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _refundBy(signer);
    }

    function _refundBy(address member) internal {
        bool windowElapsed = state == PoolState.JoiningClosed && block.timestamp >= resolveDeadline;
        if (state != PoolState.Cancelled && !windowElapsed) revert WrongState();
        if (!hasJoined[member] || refunded[member]) revert NothingToRefund();
        refunded[member] = true;
        emit Refunded(member, buyIn);
        _token.safeTransfer(member, buyIn);
    }

    /// @notice Creator cancels a pool before joining closes (members can then refund).
    function cancel() external {
        _cancelBy(msg.sender);
    }

    /// @notice Relayer twin of {cancel}: the creator signs; anyone submits.
    function cancelWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, signer, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _cancelBy(signer);
    }

    function _cancelBy(address actor) internal {
        if (actor != creator) revert NotCreator();
        if (state != PoolState.JoiningOpen) revert WrongState();
        state = PoolState.Cancelled;
        emit PoolCancelled();
    }

    function _sum(PayoutEntry[] calldata entries) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < entries.length; i++) {
            total += entries[i].amount;
        }
    }
}
