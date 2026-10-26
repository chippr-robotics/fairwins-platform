// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../mocks/MockERC20.sol";
import {WagerPool} from "../pools/WagerPool.sol";
import {WagerPoolFactory} from "../pools/WagerPoolFactory.sol";
import {IWagerPoolFactory} from "../pools/interfaces/IWagerPoolFactory.sol";
import {PoolState, PayoutEntry} from "../pools/interfaces/IWagerPool.sol";
import {FuzzActor, FuzzCheats} from "./FuzzActor.sol";

/// @title WagerPoolFuzzTest
/// @notice Medusa property harness for the spec-034 group wager pools (spec 112 FR-010, issue #1679).
/// @dev    Deploys the REAL `WagerPoolFactory` behind an ERC1967 proxy (initialized exactly as production
///         does, compliance hooks unset) and the REAL immutable `WagerPool` template it clones. Every
///         member action goes through a {FuzzActor} so the pool sees distinct wallets; actor 0 creates
///         most pools but any actor may (so "creator only" is exercised from both sides).
///
///         The harness keeps a SHADOW ledger per pool — what was deposited, claimed and refunded, which
///         matrix rows and members were paid, and which actor approved which proposalId — and the
///         `property_*` functions compare the pool's on-chain truth against it after arbitrary sequences.
///         A handler never asserts; a success that should have been impossible raises a sticky
///         violation flag that a property reports, so a failure names the invariant it broke.
contract WagerPoolFuzzTest {
    using FuzzCheats for uint256;

    uint256 internal constant N_ACTORS = 5;
    uint256 internal constant MAX_POOLS = 8;
    uint256 internal constant ACTOR_FUNDS = 1e30;

    MockERC20 public token;
    WagerPoolFactory public factory;
    WagerPool public template;
    FuzzActor[] public actors;

    address[] public pools;

    // ---- shadow ledger ----
    struct Shadow {
        uint256 deposited;
        uint256 claimed;
        uint256 refunded;
    }

    mapping(address => Shadow) public shadow;
    mapping(address => mapping(uint256 => bool)) internal _shadowClaimedIdx;
    mapping(address => mapping(address => bool)) internal _shadowRefunded;
    mapping(address => mapping(bytes32 => PayoutEntry[])) internal _matrix;
    mapping(address => bytes32[]) internal _proposalIds;
    mapping(address => mapping(bytes32 => mapping(address => bool))) internal _shadowApproved;
    mapping(address => mapping(bytes32 => uint32)) internal _shadowApprovalCount;

    // ---- forward-only state tracking ----
    mapping(address => uint8) internal _lastState;

    // ---- sticky violation flags (set by handlers, reported by properties) ----
    bool public doubleClaimPaid;
    bool public doubleRefundPaid;
    bool public wrongAmountPaid;
    bool public nonWinnerClaimed;
    bool public nonCreatorControlled;
    bool public invalidMatrixAccepted;
    bool public staleApprovalCounted;
    bool public nonMemberApproved;

    constructor() {
        token = new MockERC20("FuzzUSDC", "fUSDC", 0);
        template = new WagerPool();
        WagerPoolFactory impl = new WagerPoolFactory();
        bytes memory init = abi.encodeCall(
            WagerPoolFactory.initialize, (address(this), address(template), address(0), address(0), false)
        );
        factory = WagerPoolFactory(address(new ERC1967Proxy(address(impl), init)));

        for (uint256 i = 0; i < N_ACTORS; i++) {
            FuzzActor a = new FuzzActor();
            actors.push(a);
            token.mint(address(a), ACTOR_FUNDS);
        }
    }

    // =====================================================================
    //  Helpers
    // =====================================================================

    function _actor(uint256 seed) internal view returns (FuzzActor) {
        return actors[seed % N_ACTORS];
    }

    function _pool(uint256 seed) internal view returns (WagerPool p, bool ok) {
        if (pools.length == 0) return (WagerPool(address(0)), false);
        return (WagerPool(pools[seed % pools.length]), true);
    }

    // =====================================================================
    //  Handlers (the fuzzer's actions)
    // =====================================================================

    function createPool(
        uint8 creatorSeed,
        uint8 maxSeed,
        uint16 thresholdSeed,
        uint32 acceptSeed,
        uint32 resolveSeed,
        uint96 buyInSeed
    ) public {
        uint64 acceptIn = uint64(uint256(acceptSeed).bound(1, 30 days));
        uint64 resolveIn = acceptIn + uint64(uint256(resolveSeed).bound(1, 180 days - acceptIn));
        _createPool(creatorSeed, maxSeed, thresholdSeed, acceptIn, resolveIn, buyInSeed);
    }

    function _createPool(
        uint8 creatorSeed,
        uint8 maxSeed,
        uint16 thresholdSeed,
        uint64 acceptIn,
        uint64 resolveIn,
        uint96 buyInSeed
    ) internal returns (WagerPool) {
        if (pools.length >= MAX_POOLS) return WagerPool(address(0));
        IWagerPoolFactory.CreatePoolParams memory p = IWagerPoolFactory.CreatePoolParams({
            token: address(token),
            buyIn: uint256(buyInSeed).bound(1, 1e24),
            maxMembers: uint32(uint256(maxSeed).bound(2, N_ACTORS)),
            thresholdBips: uint16(uint256(thresholdSeed).bound(1, 10000)),
            acceptDeadline: uint64(block.timestamp) + acceptIn,
            resolveDeadline: uint64(block.timestamp) + resolveIn
        });
        (bool ok, bytes memory ret) =
            _actor(creatorSeed).exec(address(factory), abi.encodeCall(WagerPoolFactory.createPool, (p)));
        if (!ok) return WagerPool(address(0));
        (, address pool) = abi.decode(ret, (uint256, address));
        pools.push(pool);
        return WagerPool(pool);
    }

    /// @notice Composite scenario: create a pool and fill it with up to `joiners` members (optionally
    ///         closing joining) in ONE transaction. Medusa advances the clock up to 7 days between calls,
    ///         so without this the join/resolve paths would mostly see expired deadlines.
    function createJoinedPool(
        uint8 creatorSeed,
        uint8 maxSeed,
        uint16 thresholdSeed,
        uint96 buyInSeed,
        uint8 joiners,
        bool closeNow
    ) public {
        WagerPool pool = _createPool(creatorSeed, maxSeed, thresholdSeed, 30 days, 180 days, buyInSeed);
        if (address(pool) == address(0)) return;
        uint256 n = uint256(joiners) % (N_ACTORS + 1);
        for (uint256 i = 0; i < n; i++) {
            _join(pool, actors[(uint256(creatorSeed) + i) % N_ACTORS]);
        }
        if (closeNow) _closeJoining(pool, _creatorActor(pool));
    }

    /// @notice Composite scenario: create → fill → close → propose → approve(mask), all in one
    ///         transaction, so the Resolved state (and therefore claim) is routinely reachable.
    function fullLifecycle(
        uint8 creatorSeed,
        uint8 maxSeed,
        uint16 thresholdSeed,
        uint96 buyInSeed,
        uint8 rowsSeed,
        uint256 splitSeed,
        uint8 approverMask
    ) public {
        WagerPool pool = _createPool(creatorSeed, maxSeed, thresholdSeed, 30 days, 180 days, buyInSeed);
        if (address(pool) == address(0)) return;
        for (uint256 i = 0; i < N_ACTORS; i++) {
            _join(pool, actors[i]);
        }
        FuzzActor creator = _creatorActor(pool);
        if (pool.state() == PoolState.JoiningOpen) _closeJoining(pool, creator);
        bytes32 pid = _propose(pool, creator, rowsSeed, splitSeed, 0);
        if (pid == bytes32(0)) return;
        for (uint256 k = 0; k < N_ACTORS; k++) {
            if ((approverMask >> k) & 1 == 1) _approve(pool, actors[k], pid);
        }
    }

    /// @notice Composite scenario: the creator proposes a VALID matrix and the actors in `approverMask`
    ///         approve it by id, in one transaction (reaches Resolved despite Medusa's clock jumps).
    function proposeAndApprove(uint8 poolSeed, uint8 rowsSeed, uint256 splitSeed, uint8 approverMask) public {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        bytes32 pid = _propose(pool, _creatorActor(pool), rowsSeed, splitSeed, 0);
        if (pid == bytes32(0)) return;
        for (uint256 k = 0; k < N_ACTORS; k++) {
            if ((approverMask >> k) & 1 == 1) _approve(pool, actors[k], pid);
        }
    }

    /// @notice Composite #1667 race, self-contained: a full, closed pool; the creator proposes A, then
    ///         re-proposes B ahead of the members' pending approvals of A. Every stale approve(A) MUST
    ///         revert (it must never land on — and lock — B); approvals of B then proceed by id.
    function reproposeRace(uint8 creatorSeed, uint16 thresholdSeed, uint256 splitA, uint256 splitB, uint8 approverMask)
        public
    {
        WagerPool pool =
            _createPool(creatorSeed, 3 /* bound(3, 2, 5) == 5 members */, thresholdSeed, 30 days, 180 days, uint96(splitA));
        if (address(pool) == address(0)) return;
        for (uint256 i = 0; i < N_ACTORS; i++) {
            _join(pool, actors[i]);
        }
        FuzzActor creator = _creatorActor(pool);
        bytes32 a = _propose(pool, creator, 2, splitA, 0);
        bytes32 b = _propose(pool, creator, 3, splitB, 1);
        if (a == bytes32(0) || b == bytes32(0) || a == b) return;
        for (uint256 k = 0; k < N_ACTORS; k++) {
            if ((approverMask >> k) & 1 == 1) _approve(pool, actors[k], a); // stale: must not count
        }
        for (uint256 k = 0; k < N_ACTORS; k++) {
            if ((approverMask >> k) & 1 == 1) _approve(pool, actors[k], b);
        }
    }

    function _creatorActor(WagerPool pool) internal view returns (FuzzActor c) {
        for (uint256 k = 0; k < N_ACTORS; k++) {
            if (address(actors[k]) == pool.creator()) return actors[k];
        }
    }

    function join(uint8 poolSeed, uint8 actorSeed) public {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        _join(pool, _actor(actorSeed));
    }

    function _join(WagerPool pool, FuzzActor a) internal {
        a.exec(address(token), abi.encodeCall(token.approve, (address(pool), type(uint256).max)));
        uint256 before = token.balanceOf(address(a));
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(WagerPool.join, ()));
        if (!ok) return;
        uint256 buyIn = pool.buyIn();
        if (before - token.balanceOf(address(a)) != buyIn) wrongAmountPaid = true;
        shadow[address(pool)].deposited += buyIn;
    }

    function closeJoining(uint8 poolSeed, uint8 actorSeed) public {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        _closeJoining(pool, _actor(actorSeed));
    }

    function _closeJoining(WagerPool pool, FuzzActor a) internal {
        if (address(a) == address(0)) return;
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(WagerPool.closeJoining, ()));
        if (ok && address(a) != pool.creator()) nonCreatorControlled = true;
    }

    function pokeDeadline(uint8 poolSeed) public {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        try pool.pokeDeadline() {} catch {}
    }

    function cancel(uint8 poolSeed, uint8 actorSeed) public {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        FuzzActor a = _actor(actorSeed);
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(WagerPool.cancel, ()));
        if (ok && address(a) != pool.creator()) nonCreatorControlled = true;
    }

    /// @notice Propose a payout matrix. Valid matrices split the exact escrow across 1..4 actor rows
    ///         (duplicates allowed — claims are per row index). `corrupt` deliberately breaks the matrix
    ///         (sum off by one, or a zero winner) so the on-chain validation is exercised; a corrupt
    ///         matrix that is ACCEPTED is a violation.
    function proposeOutcome(uint8 poolSeed, uint8 actorSeed, uint8 rowsSeed, uint256 splitSeed, uint8 corrupt)
        public
    {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        _propose(pool, _actor(actorSeed), rowsSeed, splitSeed, corrupt);
    }

    function _propose(WagerPool pool, FuzzActor a, uint8 rowsSeed, uint256 splitSeed, uint8 corrupt)
        internal
        returns (bytes32 pid)
    {
        if (address(a) == address(0)) return bytes32(0);
        uint256 escrow = pool.escrowTotal();
        uint256 rows = uint256(rowsSeed).bound(1, 4);
        PayoutEntry[] memory entries = new PayoutEntry[](rows);
        uint256 remaining = escrow;
        for (uint256 i = 0; i < rows; i++) {
            uint256 amt = i == rows - 1 ? remaining : uint256(keccak256(abi.encode(splitSeed, i))) % (remaining + 1);
            remaining -= amt;
            entries[i] = PayoutEntry({winner: address(_actor(uint256(keccak256(abi.encode(splitSeed, i, "w"))))), amount: amt});
        }
        uint8 mode = corrupt % 4; // 0,1 = valid; 2 = sum+1; 3 = zero winner
        if (mode == 2) entries[rows - 1].amount += 1;
        if (mode == 3) entries[0].winner = address(0);

        (bool ok, ) =
            a.exec(address(pool), abi.encodeWithSelector(WagerPool.proposeOutcome.selector, entries));
        if (!ok) return bytes32(0);
        if (address(a) != pool.creator()) nonCreatorControlled = true;
        if (mode >= 2) invalidMatrixAccepted = true;

        pid = keccak256(abi.encode(entries));
        if (pool.currentProposalId() != pid) invalidMatrixAccepted = true;
        if (_matrix[address(pool)][pid].length == 0) {
            for (uint256 i = 0; i < rows; i++) {
                _matrix[address(pool)][pid].push(entries[i]);
            }
            _proposalIds[address(pool)].push(pid);
        }
    }

    /// @notice Approve a proposalId the harness has seen proposed for this pool — the CURRENT one or a
    ///         stale earlier one (`pidSeed` chooses). Issue #1667: a stale id must never be counted
    ///         toward (or lock) a different, current matrix.
    function approve(uint8 poolSeed, uint8 actorSeed, uint8 pidSeed) public {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        bytes32[] storage ids = _proposalIds[address(pool)];
        bytes32 pid = ids.length == 0 ? bytes32(0) : ids[pidSeed % ids.length];
        _approve(pool, _actor(actorSeed), pid);
    }

    function _approve(WagerPool pool, FuzzActor a, bytes32 pid) internal {
        bytes32 currentBefore = pool.currentProposalId();
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(WagerPool.approve, (pid)));
        if (!ok) return;
        if (pid != currentBefore) staleApprovalCounted = true;
        if (!pool.hasJoined(address(a))) nonMemberApproved = true;
        _shadowApproved[address(pool)][pid][address(a)] = true;
        _shadowApprovalCount[address(pool)][pid] += 1;
    }

    /// @notice Claim one row of the locked matrix. Half the time the TRUE winner claims; otherwise a
    ///         random actor tries (must fail unless it happens to be that row's winner).
    function claim(uint8 poolSeed, uint8 idxSeed, uint8 actorSeed, uint8 recipientSeed, bool trueWinner) public {
        // Prefer a Resolved pool (scan from the seed) so the claim path is actually reached.
        if (pools.length == 0) return;
        WagerPool pool = WagerPool(pools[poolSeed % pools.length]);
        for (uint256 j = 0; j < pools.length; j++) {
            WagerPool cand = WagerPool(pools[(uint256(poolSeed) + j) % pools.length]);
            if (cand.state() == PoolState.Resolved) {
                pool = cand;
                break;
            }
        }
        bytes32 locked = pool.lockedOutcome();
        PayoutEntry[] storage stored = _matrix[address(pool)][locked];
        if (locked == bytes32(0) || stored.length == 0) return;
        PayoutEntry[] memory entries = new PayoutEntry[](stored.length);
        for (uint256 i = 0; i < stored.length; i++) {
            entries[i] = stored[i];
        }
        uint256 idx = idxSeed % (entries.length + 1); // one past the end exercises IndexOOB
        FuzzActor claimant = _actor(actorSeed);
        if (trueWinner && idx < entries.length) {
            for (uint256 i = 0; i < N_ACTORS; i++) {
                if (address(actors[i]) == entries[idx].winner) claimant = actors[i];
            }
        }
        address recipient = address(_actor(recipientSeed));
        uint256 before = token.balanceOf(recipient);
        (bool ok, ) = claimant.exec(
            address(pool), abi.encodeWithSelector(WagerPool.claim.selector, entries, idx, recipient)
        );
        if (!ok) return;
        if (idx >= entries.length || entries[idx].winner != address(claimant)) {
            nonWinnerClaimed = true;
            return;
        }
        if (_shadowClaimedIdx[address(pool)][idx]) doubleClaimPaid = true;
        _shadowClaimedIdx[address(pool)][idx] = true;
        uint256 paid = token.balanceOf(recipient) - before;
        if (paid != entries[idx].amount) wrongAmountPaid = true;
        shadow[address(pool)].claimed += entries[idx].amount;
    }

    function refund(uint8 poolSeed, uint8 actorSeed) public {
        (WagerPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        FuzzActor a = _actor(actorSeed);
        uint256 before = token.balanceOf(address(a));
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(WagerPool.refund, ()));
        if (!ok) return;
        if (_shadowRefunded[address(pool)][address(a)]) doubleRefundPaid = true;
        _shadowRefunded[address(pool)][address(a)] = true;
        uint256 buyIn = pool.buyIn();
        if (token.balanceOf(address(a)) - before != buyIn) wrongAmountPaid = true;
        shadow[address(pool)].refunded += buyIn;
    }

    /// @notice Move time forward (Medusa also delays blocks on its own; this reaches the deadlines fast).
    function warp(uint32 secondsSeed) public {
        FuzzCheats.warp(block.timestamp + uint256(secondsSeed).bound(1, 200 days));
    }

    // =====================================================================
    //  Properties
    // =====================================================================

    /// @notice Escrow conservation: each pool holds exactly deposited − claimed − refunded, and neither
    ///         exit ever exceeds what went in.
    function property_escrow_conserved() public view returns (bool) {
        for (uint256 i = 0; i < pools.length; i++) {
            WagerPool pool = WagerPool(pools[i]);
            Shadow memory s = shadow[address(pool)];
            if (s.claimed + s.refunded > s.deposited) return false;
            if (token.balanceOf(address(pool)) != s.deposited - s.claimed - s.refunded) return false;
            if (uint256(pool.memberCount()) * pool.buyIn() != s.deposited) return false;
            PoolState st = pool.state();
            if (st == PoolState.JoiningClosed || st == PoolState.Resolved) {
                if (pool.escrowTotal() != s.deposited) return false;
            }
            if (s.claimed > pool.escrowTotal()) return false;
        }
        return true;
    }

    /// @notice A matrix row is paid at most once, and only to that row's winner, for that row's amount.
    function property_no_double_claim() public view returns (bool) {
        if (doubleClaimPaid || nonWinnerClaimed) return false;
        for (uint256 i = 0; i < pools.length; i++) {
            WagerPool pool = WagerPool(pools[i]);
            for (uint256 r = 0; r < 4; r++) {
                if (pool.claimedIndex(r) != _shadowClaimedIdx[address(pool)][r]) return false;
            }
        }
        return true;
    }

    /// @notice A member is refunded at most once, exactly the buy-in.
    function property_no_double_refund() public view returns (bool) {
        if (doubleRefundPaid) return false;
        for (uint256 i = 0; i < pools.length; i++) {
            WagerPool pool = WagerPool(pools[i]);
            for (uint256 k = 0; k < N_ACTORS; k++) {
                if (pool.refunded(address(actors[k])) != _shadowRefunded[address(pool)][address(actors[k])]) {
                    return false;
                }
            }
        }
        return true;
    }

    /// @notice Every value transfer the harness observed moved exactly the expected amount.
    function property_exact_amounts_moved() public view returns (bool) {
        return !wrongAmountPaid;
    }

    /// @notice Regression guard for #1667: a locked outcome is a proposalId that was actually proposed,
    ///         and every approval counted toward it was cast BY THAT ID, by a member, enough of them to
    ///         meet the threshold. An approval naming a stale id never succeeds.
    function property_locked_outcome_approved_by_id() public view returns (bool) {
        if (staleApprovalCounted || nonMemberApproved) return false;
        for (uint256 i = 0; i < pools.length; i++) {
            WagerPool pool = WagerPool(pools[i]);
            bytes32 locked = pool.lockedOutcome();
            if (pool.state() != PoolState.Resolved) {
                if (locked != bytes32(0)) return false;
                continue;
            }
            if (locked == bytes32(0)) return false;
            if (_matrix[address(pool)][locked].length == 0) return false; // never proposed
            uint32 counted;
            for (uint256 k = 0; k < N_ACTORS; k++) {
                address a = address(actors[k]);
                if (pool.approvedBy(locked, a)) {
                    if (!_shadowApproved[address(pool)][locked][a]) return false;
                    if (!pool.hasJoined(a)) return false;
                    counted++;
                }
            }
            if (pool.proposalApprovals(locked) != counted) return false;
            if (counted != _shadowApprovalCount[address(pool)][locked]) return false;
            if (counted < _requiredApprovals(pool)) return false;
        }
        return true;
    }

    /// @notice Only the creator closes, cancels or proposes; every accepted matrix is non-empty, has no
    ///         zero winner and sums to the escrow.
    function property_creator_only_and_matrix_valid() public view returns (bool) {
        return !nonCreatorControlled && !invalidMatrixAccepted;
    }

    /// @notice State only moves forward: JoiningOpen → JoiningClosed → Resolved, or JoiningOpen →
    ///         Cancelled. Resolved and Cancelled are terminal.
    function property_state_only_moves_forward() public returns (bool) {
        bool okAll = true;
        for (uint256 i = 0; i < pools.length; i++) {
            address p = pools[i];
            uint8 cur = uint8(WagerPool(p).state());
            uint8 prev = _lastState[p];
            _lastState[p] = cur;
            if (prev == cur) continue;
            if (prev == uint8(PoolState.Resolved) || prev == uint8(PoolState.Cancelled)) okAll = false;
            else if (prev == uint8(PoolState.JoiningClosed) && cur != uint8(PoolState.Resolved)) okAll = false;
            // prev == JoiningOpen may move to any later state across a sequence.
        }
        return okAll;
    }

    /// @notice Resolved and Cancelled are terminal: no join, close, propose, approve or cancel succeeds on
    ///         them (probed live), and a Cancelled pool never locked an outcome.
    function property_resolved_and_cancelled_terminal() public returns (bool) {
        for (uint256 i = 0; i < pools.length; i++) {
            WagerPool pool = WagerPool(pools[i]);
            PoolState st = pool.state();
            if (st != PoolState.Resolved && st != PoolState.Cancelled) continue;
            if (st == PoolState.Cancelled && pool.lockedOutcome() != bytes32(0)) return false;
            FuzzActor creator;
            for (uint256 k = 0; k < N_ACTORS; k++) {
                if (address(actors[k]) == pool.creator()) creator = actors[k];
            }
            if (address(creator) == address(0)) continue;
            (bool c1, ) = creator.exec(address(pool), abi.encodeCall(WagerPool.cancel, ()));
            (bool c2, ) = creator.exec(address(pool), abi.encodeCall(WagerPool.closeJoining, ()));
            (bool c3, ) = creator.exec(address(pool), abi.encodeCall(WagerPool.join, ()));
            if (c1 || c2 || c3) return false;
            if (pool.state() != st) return false;
        }
        return true;
    }

    /// @notice The template and every clone can never be re-initialized (seizing creator/token).
    function property_cannot_reinitialize() public returns (bool) {
        try template.initialize(address(token), address(this), 1, 2, 1, 1, 2) {
            return false;
        } catch {}
        for (uint256 i = 0; i < pools.length; i++) {
            try WagerPool(pools[i]).initialize(address(token), address(this), 1, 2, 1, 1, 2) {
                return false;
            } catch {}
        }
        return true;
    }

    function _requiredApprovals(WagerPool pool) internal view returns (uint32) {
        uint256 denom = pool.frozenDenominator();
        uint256 req = (denom * pool.thresholdBips() + 9999) / 10000;
        if (req == 0) req = 1;
        if (denom >= 2 && req < 2) req = 2;
        return uint32(req);
    }

    /// @notice Number of pools created (Hardhat replay helper).
    function poolCount() external view returns (uint256) {
        return pools.length;
    }
}
