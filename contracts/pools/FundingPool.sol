// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SignerIntentBase} from "../upgradeable/SignerIntentBase.sol";
import {IFundingPool, FundingState} from "./interfaces/IFundingPool.sol";

/// @notice Compliance hooks the pool calls back into its factory (single configured guard +
///         membership manager, screening the real wallet — same contract as the wager pools).
interface IFundingFactoryHooks {
    function screen(address account) external view;
    function requireMembership(address account) external view;
}

/// @notice EIP-3009 receive authorization used by the gasless contribute path.
interface IERC3009Receive {
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

/// @title FundingPool
/// @notice A group funding pool (spec 103): the spec-034 {WagerPool} architecture with the wager removed.
///         Deployed as an immutable ERC-1167 clone by {FundingPoolFactory}. Contributors put in ANY amount
///         (any number of times) while contributions are open; the organizer closes to collect the whole
///         pot at any time, goal met or not; the organizer, a strict majority of contributors, or the
///         settlement deadline flip the pool to refunding, where each contributor pulls back exactly what
///         they put in.
///
/// @dev    Timing mirrors {WagerPool}/{WagerRegistry}: two ABSOLUTE deadlines seeded at init —
///         `contributeDeadline` (money-in closes) and `settleDeadline` (organizer must have closed by;
///         after it the pool is refund-only via the permissionless {pokeDeadline}). Bounds + ordering are
///         enforced by the factory ({FundingPoolFactory._checkDeadlines}).
///
///         Relayer-ready (spec 035/036 pattern): every actor-attributed action has a `…WithSig` twin
///         ({closeWithSig}/{cancelWithSig}/{voteRefundWithSig}/{claimRefundWithSig}) that authorizes the
///         recovered `signer` instead of `msg.sender`; the money-in has its EIP-3009 form
///         ({contributeWithAuthorization}). Clones are IMMUTABLE, so these are baked into the template.
///         Self-submit entrypoints are the primary path.
///
///         Security posture: checks-effects-interactions + a reentrancy guard on every value-moving path;
///         the ONLY escrow exits are {close} (→ `organizer`, the whole pot) and {claimRefund} (→ the
///         claimant, exactly `contributed[claimant]`); `Closed`/`Refunding` are terminal; refunds are
///         PULL-based so an unbounded contributor set can never block the transition; the settle-deadline
///         poke guarantees funds are never stuck behind an absent organizer. There is deliberately no
///         `recipient` on {close} (a relayable field a compromised relayer/UI could fill in) and no
///         admin sweep. `totalRaised == balance` holds only for a well-behaved (non fee-on-transfer,
///         non-rebasing) token, which is why the factory curates the token allow-list.
///
///         SECURITY REVIEW REQUIRED before this template is set live on any value-bearing network
///         (`.github/agents/smart-contract-security`); see specs/103-funding-pools/implementation-notes.md.
contract FundingPool is Initializable, ReentrancyGuardUpgradeable, SignerIntentBase, IFundingPool {
    using SafeERC20 for IERC20;

    // ---- EIP-712 intent typehashes (relayer twins). Names are unique across the repo: the parity gate
    //      rejects a struct NAME reused with a different string. ----
    bytes32 private constant CLOSE_TYPEHASH =
        keccak256("CloseFundingPool(address organizer,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant CANCEL_TYPEHASH =
        keccak256("CancelFundingPool(address organizer,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant VOTE_REFUND_TYPEHASH =
        keccak256("VoteRefund(address contributor,bytes32 nonce,uint256 validAfter,uint256 validBefore)");
    bytes32 private constant CLAIM_REFUND_TYPEHASH =
        keccak256("ClaimRefund(address contributor,bytes32 nonce,uint256 validAfter,uint256 validBefore)");

    uint8 public constant REFUND_REASON_ORGANIZER = 1;
    uint8 public constant REFUND_REASON_MAJORITY = 2;
    uint8 public constant REFUND_REASON_DEADLINE = 3;

    // ---- Refs (seeded at init; immutable for the pool's life) ----
    address public factory;
    IERC20 private _token;

    // ---- Config (seeded at init) ----
    address public organizer;
    uint256 public goal;
    string public purpose;
    /// @notice Absolute unix time contributions close (mirrors WagerPool.acceptDeadline).
    uint64 public contributeDeadline;
    /// @notice Absolute unix time by which the organizer must have closed; after it the pool is
    ///         refund-only (mirrors WagerPool.resolveDeadline).
    uint64 public settleDeadline;
    /// @notice Block the clone was initialized in — the lower bound for event scans (never genesis).
    uint64 public createdBlock;

    // ---- Bounded mutable state ----
    FundingState public state;
    uint256 public totalRaised;
    uint32 public contributorCount;
    uint32 public refundVotes;
    uint32 public refundedCount;
    uint8 public refundReason;
    uint64 public closedAt;

    mapping(address => uint256) public contributed;
    mapping(address => bool) public votedRefund;
    mapping(address => bool) public refunded;

    error NotOrganizer();
    error NotContributor();
    error WrongState();
    error ContributionsClosed();
    error ZeroAmount();
    error AlreadyVoted();
    error NothingToRefund();
    error DeadlineNotPassed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time initialization by the factory (the clone deployer). Purpose length, goal and
    ///         deadline bounds/ordering are validated by the factory before this is called.
    function initialize(
        address token_,
        address organizer_,
        uint256 goal_,
        string calldata purpose_,
        uint64 contributeDeadline_,
        uint64 settleDeadline_
    ) external initializer {
        __ReentrancyGuard_init();
        __EIP712_init("FairWins FundingPool", "1");
        factory = msg.sender;
        _token = IERC20(token_);
        organizer = organizer_;
        goal = goal_;
        purpose = purpose_;
        contributeDeadline = contributeDeadline_;
        settleDeadline = settleDeadline_;
        createdBlock = uint64(block.number);
        state = FundingState.Open;
    }

    /// @notice The escrow token.
    function token() external view returns (address) {
        return address(_token);
    }

    /// @notice Votes required to flip the pool to refunding: a STRICT majority of distinct contributors
    ///         (⌊N/2⌋ + 1). Zero while nobody has contributed.
    function refundVotesNeeded() public view returns (uint32) {
        uint32 n = contributorCount;
        if (n == 0) return 0;
        return n / 2 + 1;
    }

    /// @notice True while contributions are accepted.
    function contributionOpen() public view returns (bool) {
        return state == FundingState.Open && block.timestamp < contributeDeadline;
    }

    // ---------------------------------------------------------------------
    // Money in
    // ---------------------------------------------------------------------

    /// @notice Contribute `amount` (requires a prior ERC-20 approve). Any amount > 0, any number of times.
    function contribute(uint256 amount) external nonReentrant {
        _preContribute(msg.sender, amount);
        _recordContribution(msg.sender, amount);
        _token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Gasless contribute via EIP-3009: the contributor signs a receive authorization to THIS pool
    ///         and anyone submits it. The token enforces `to == msg.sender == this clone`, so a relayer can
    ///         never redirect the funds.
    function contributeWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _preContribute(from, value);
        _recordContribution(from, value);
        IERC3009Receive(address(_token)).receiveWithAuthorization(
            from, address(this), value, validAfter, validBefore, nonce, v, r, s
        );
    }

    function _preContribute(address from, uint256 amount) internal view {
        if (state != FundingState.Open) revert WrongState();
        if (block.timestamp >= contributeDeadline) revert ContributionsClosed();
        if (amount == 0) revert ZeroAmount();
        // Compliance on the real wallet, every contribution (same posture as WagerPool.join).
        IFundingFactoryHooks(factory).screen(from);
        IFundingFactoryHooks(factory).requireMembership(from);
    }

    function _recordContribution(address from, uint256 amount) internal {
        uint256 prior = contributed[from];
        if (prior == 0) contributorCount += 1;
        uint256 next = prior + amount;
        contributed[from] = next;
        totalRaised += amount;
        emit Contributed(from, amount, next, totalRaised);
    }

    // ---------------------------------------------------------------------
    // Organizer: close (collect) / cancel (refund everyone)
    // ---------------------------------------------------------------------

    /// @notice Close the pool and collect the whole pot — at ANY time while open, goal met or not
    ///         (including after contributions closed, up to the settlement deadline). Final.
    function close() external nonReentrant {
        _closeBy(msg.sender);
    }

    /// @notice Relayer twin of {close}: the organizer signs; anyone submits. Funds go to the organizer.
    function closeWithSig(address signer, bytes32 nonce, uint256 validAfter, uint256 validBefore, bytes calldata sig)
        external
        nonReentrant
    {
        bytes32 structHash = keccak256(abi.encode(CLOSE_TYPEHASH, signer, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _closeBy(signer);
    }

    function _closeBy(address actor) internal {
        if (actor != organizer) revert NotOrganizer();
        if (state != FundingState.Open) revert WrongState();
        uint256 amount = totalRaised;
        state = FundingState.Closed;
        closedAt = uint64(block.timestamp);
        emit PoolClosed(organizer, amount);
        if (amount > 0) _token.safeTransfer(organizer, amount);
    }

    /// @notice Organizer hands everything back: the pool becomes refunding and each contributor collects.
    function cancel() external {
        _cancelBy(msg.sender);
    }

    /// @notice Relayer twin of {cancel}: the organizer signs; anyone submits.
    function cancelWithSig(address signer, bytes32 nonce, uint256 validAfter, uint256 validBefore, bytes calldata sig)
        external
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, signer, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _cancelBy(signer);
    }

    function _cancelBy(address actor) internal {
        if (actor != organizer) revert NotOrganizer();
        if (state != FundingState.Open) revert WrongState();
        _startRefunding(REFUND_REASON_ORGANIZER);
    }

    // ---------------------------------------------------------------------
    // Contributors: vote to refund / collect refund
    // ---------------------------------------------------------------------

    /// @notice A contributor votes to refund (one vote per contributor). The pool flips to refunding the
    ///         moment votes reach a strict majority of the CURRENT contributor count.
    function voteRefund() external {
        _voteRefundBy(msg.sender);
    }

    /// @notice Relayer twin of {voteRefund}: the contributor signs; anyone submits.
    function voteRefundWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        bytes32 structHash = keccak256(abi.encode(VOTE_REFUND_TYPEHASH, signer, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _voteRefundBy(signer);
    }

    function _voteRefundBy(address actor) internal {
        if (state != FundingState.Open) revert WrongState();
        if (contributed[actor] == 0) revert NotContributor();
        if (votedRefund[actor]) revert AlreadyVoted();
        votedRefund[actor] = true;
        uint32 votes = refundVotes + 1;
        refundVotes = votes;
        uint32 needed = refundVotesNeeded();
        emit RefundVoted(actor, votes, needed);
        if (votes >= needed) _startRefunding(REFUND_REASON_MAJORITY);
    }

    /// @notice Collect exactly what you contributed, once, while the pool is refunding.
    function claimRefund() external nonReentrant {
        _claimRefundBy(msg.sender);
    }

    /// @notice Relayer twin of {claimRefund}: the contributor signs; anyone submits; funds go to the signer.
    function claimRefundWithSig(
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external nonReentrant {
        bytes32 structHash = keccak256(abi.encode(CLAIM_REFUND_TYPEHASH, signer, nonce, validAfter, validBefore));
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        _claimRefundBy(signer);
    }

    function _claimRefundBy(address actor) internal {
        if (state != FundingState.Refunding) revert WrongState();
        uint256 amount = contributed[actor];
        if (amount == 0 || refunded[actor]) revert NothingToRefund();
        refunded[actor] = true;
        refundedCount += 1;
        emit RefundClaimed(actor, amount);
        _token.safeTransfer(actor, amount);
    }

    // ---------------------------------------------------------------------
    // Anyone: the never-stranded fallback
    // ---------------------------------------------------------------------

    /// @notice Permissionless: once the settlement deadline has passed with the pool still open, move it
    ///         to refunding so contributors can collect. An absent organizer can never trap funds.
    function pokeDeadline() external {
        if (state != FundingState.Open) revert WrongState();
        if (block.timestamp < settleDeadline) revert DeadlineNotPassed();
        _startRefunding(REFUND_REASON_DEADLINE);
    }

    function _startRefunding(uint8 reason) internal {
        state = FundingState.Refunding;
        refundReason = reason;
        closedAt = uint64(block.timestamp);
        emit RefundingStarted(reason);
    }
}
