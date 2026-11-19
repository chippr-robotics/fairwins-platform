// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../mocks/MockERC20.sol";
import {FundingPool} from "../pools/FundingPool.sol";
import {FundingPoolFactory} from "../pools/FundingPoolFactory.sol";
import {IFundingPoolFactory} from "../pools/interfaces/IFundingPoolFactory.sol";
import {FundingState} from "../pools/interfaces/IFundingPool.sol";
import {FuzzActor, FuzzCheats} from "./FuzzActor.sol";

/// @title FundingPoolFuzzTest
/// @notice Medusa property harness for the spec-103 funding pools (spec 112 FR-010, issue #1679).
/// @dev    Deploys the REAL `FundingPoolFactory` behind an ERC1967 proxy and the REAL immutable
///         `FundingPool` template it clones. Contributors, the organizer and strangers are distinct
///         {FuzzActor}s. A shadow ledger records what each actor contributed and was refunded and what the
///         organizer was paid; the `property_*` functions compare it to chain truth. Handlers never assert —
///         an impossible success raises a sticky flag that a property reports.
contract FundingPoolFuzzTest {
    using FuzzCheats for uint256;

    uint256 internal constant N_ACTORS = 5;
    uint256 internal constant MAX_POOLS = 12;
    uint256 internal constant ACTOR_FUNDS = 1e30;

    MockERC20 public token;
    FundingPoolFactory public factory;
    FundingPool public template;
    FuzzActor[] public actors;
    address[] public pools;

    // ---- shadow ledger ----
    mapping(address => uint256) public shadowContributed; // per pool
    mapping(address => uint256) public shadowRefunded; // per pool
    mapping(address => uint256) public shadowPaidOnClose; // per pool
    mapping(address => mapping(address => uint256)) internal _contributedBy;
    mapping(address => mapping(address => bool)) internal _refundedBy;
    mapping(address => uint8) internal _lastState;

    // ---- sticky violation flags ----
    bool public refundWrongAmount;
    bool public refundTwice;
    bool public closePaidNonOrganizer;
    bool public closeWrongAmount;
    bool public nonOrganizerControlled;
    bool public contributeWrongAmount;

    constructor() {
        token = new MockERC20("FuzzUSDC", "fUSDC", 0);
        template = new FundingPool();
        FundingPoolFactory impl = new FundingPoolFactory();
        bytes memory init = abi.encodeCall(
            FundingPoolFactory.initialize, (address(this), address(template), address(0), address(0), false)
        );
        factory = FundingPoolFactory(address(new ERC1967Proxy(address(impl), init)));

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

    function _pool(uint256 seed) internal view returns (FundingPool p, bool ok) {
        if (pools.length == 0) return (FundingPool(address(0)), false);
        return (FundingPool(pools[seed % pools.length]), true);
    }

    // =====================================================================
    //  Handlers
    // =====================================================================

    function createPool(uint8 organizerSeed, uint96 goalSeed, uint32 contributeSeed, uint32 settleSeed) public {
        uint64 cIn = uint64(uint256(contributeSeed).bound(1, 30 days));
        uint64 sIn = cIn + uint64(uint256(settleSeed).bound(1, 180 days - cIn));
        _createPool(organizerSeed, goalSeed, cIn, sIn);
    }

    function _createPool(uint8 organizerSeed, uint96 goalSeed, uint64 cIn, uint64 sIn) internal returns (FundingPool) {
        if (pools.length >= MAX_POOLS) return FundingPool(address(0));
        IFundingPoolFactory.CreateFundingPoolParams memory p = IFundingPoolFactory.CreateFundingPoolParams({
            token: address(token),
            goal: uint256(goalSeed).bound(1, 1e24),
            purpose: "fuzz",
            contributeDeadline: uint64(block.timestamp) + cIn,
            settleDeadline: uint64(block.timestamp) + sIn
        });
        (bool ok, bytes memory ret) =
            _actor(organizerSeed).exec(address(factory), abi.encodeCall(FundingPoolFactory.createPool, (p)));
        if (!ok) return FundingPool(address(0));
        (, address pool) = abi.decode(ret, (uint256, address));
        pools.push(pool);
        return FundingPool(pool);
    }

    /// @notice Composite scenario: create a pool and take contributions from the actors in
    ///         `contributorMask` in ONE transaction (Medusa jumps the clock up to 7 days per call).
    function createFundedPool(uint8 organizerSeed, uint96 goalSeed, uint8 contributorMask, uint96 amountSeed)
        public
    {
        FundingPool pool = _createPool(organizerSeed, goalSeed, 30 days, 180 days);
        if (address(pool) == address(0)) return;
        for (uint256 k = 0; k < N_ACTORS; k++) {
            if ((contributorMask >> k) & 1 == 1) {
                _contribute(pool, actors[k], uint256(keccak256(abi.encode(amountSeed, k))) % 1e24 + 1);
            }
        }
    }

    function contribute(uint8 poolSeed, uint8 actorSeed, uint96 amountSeed) public {
        (FundingPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        // amount 0 is kept reachable (must revert ZeroAmount).
        _contribute(pool, _actor(actorSeed), uint256(amountSeed) % 1e24);
    }

    function _contribute(FundingPool pool, FuzzActor a, uint256 amount) internal {
        a.exec(address(token), abi.encodeCall(token.approve, (address(pool), type(uint256).max)));
        uint256 before = token.balanceOf(address(a));
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(FundingPool.contribute, (amount)));
        if (!ok) return;
        if (amount == 0 || before - token.balanceOf(address(a)) != amount) contributeWrongAmount = true;
        shadowContributed[address(pool)] += amount;
        _contributedBy[address(pool)][address(a)] += amount;
    }

    /// @notice Any actor attempts to close. Only the organizer may succeed, and the ENTIRE pot must reach
    ///         the organizer's own address — no actor, and nothing else, gains a unit.
    function close(uint8 poolSeed, uint8 actorSeed) public {
        (FundingPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        FuzzActor a = _actor(actorSeed);
        address organizer = pool.organizer();
        uint256 raised = pool.totalRaised();
        uint256[] memory before = new uint256[](N_ACTORS);
        for (uint256 i = 0; i < N_ACTORS; i++) {
            before[i] = token.balanceOf(address(actors[i]));
        }
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(FundingPool.close, ()));
        if (!ok) return;
        if (address(a) != organizer) nonOrganizerControlled = true;
        for (uint256 i = 0; i < N_ACTORS; i++) {
            uint256 afterBal = token.balanceOf(address(actors[i]));
            if (address(actors[i]) == organizer) {
                if (afterBal - before[i] != raised) closeWrongAmount = true;
            } else if (afterBal != before[i]) {
                closePaidNonOrganizer = true;
            }
        }
        if (token.balanceOf(address(pool)) != 0) closeWrongAmount = true;
        shadowPaidOnClose[address(pool)] += raised;
    }

    function cancel(uint8 poolSeed, uint8 actorSeed) public {
        (FundingPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        FuzzActor a = _actor(actorSeed);
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(FundingPool.cancel, ()));
        if (ok && address(a) != pool.organizer()) nonOrganizerControlled = true;
    }

    function voteRefund(uint8 poolSeed, uint8 actorSeed) public {
        (FundingPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        _actor(actorSeed).exec(address(pool), abi.encodeCall(FundingPool.voteRefund, ()));
    }

    function claimRefund(uint8 poolSeed, uint8 actorSeed) public {
        (FundingPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        FuzzActor a = _actor(actorSeed);
        uint256 before = token.balanceOf(address(a));
        (bool ok, ) = a.exec(address(pool), abi.encodeCall(FundingPool.claimRefund, ()));
        if (!ok) return;
        if (_refundedBy[address(pool)][address(a)]) refundTwice = true;
        _refundedBy[address(pool)][address(a)] = true;
        uint256 expected = _contributedBy[address(pool)][address(a)];
        if (token.balanceOf(address(a)) - before != expected) refundWrongAmount = true;
        shadowRefunded[address(pool)] += expected;
    }

    function pokeDeadline(uint8 poolSeed) public {
        (FundingPool pool, bool has) = _pool(poolSeed);
        if (!has) return;
        try pool.pokeDeadline() {} catch {}
    }

    function warp(uint32 secondsSeed) public {
        FuzzCheats.warp(block.timestamp + uint256(secondsSeed).bound(1, 200 days));
    }

    // =====================================================================
    //  Properties
    // =====================================================================

    /// @notice Contributions are conserved: an Open/Refunding pool holds Σcontributed − refunded; a Closed
    ///         pool holds 0 because the organizer was paid exactly what was raised.
    function property_contributions_conserved() public view returns (bool) {
        for (uint256 i = 0; i < pools.length; i++) {
            FundingPool pool = FundingPool(pools[i]);
            address p = address(pool);
            uint256 bal = token.balanceOf(p);
            if (pool.totalRaised() != shadowContributed[p]) return false;
            if (shadowRefunded[p] > shadowContributed[p]) return false;
            FundingState st = pool.state();
            if (st == FundingState.Closed) {
                if (bal != 0) return false;
                if (shadowPaidOnClose[p] != shadowContributed[p]) return false;
                if (shadowRefunded[p] != 0) return false;
            } else {
                if (bal != shadowContributed[p] - shadowRefunded[p]) return false;
                if (shadowPaidOnClose[p] != 0) return false;
            }
        }
        return true;
    }

    /// @notice A refund pays exactly `contributed[addr]`, and only once; the pool's per-address ledger
    ///         agrees with the harness's.
    function property_refund_exact_once() public view returns (bool) {
        if (refundWrongAmount || refundTwice || contributeWrongAmount) return false;
        for (uint256 i = 0; i < pools.length; i++) {
            FundingPool pool = FundingPool(pools[i]);
            for (uint256 k = 0; k < N_ACTORS; k++) {
                address a = address(actors[k]);
                if (pool.contributed(a) != _contributedBy[address(pool)][a]) return false;
                if (pool.refunded(a) != _refundedBy[address(pool)][a]) return false;
            }
        }
        return true;
    }

    /// @notice No path pays a non-organizer on close, and only the organizer can close or cancel.
    function property_close_pays_only_organizer() public view returns (bool) {
        return !closePaidNonOrganizer && !closeWrongAmount && !nonOrganizerControlled;
    }

    /// @notice State is monotonic: Open → Closed | Refunding; Closed and Refunding are terminal; a
    ///         Refunding pool always names its reason, and a MAJORITY reason really had a majority.
    function property_state_monotonic() public returns (bool) {
        bool okAll = true;
        for (uint256 i = 0; i < pools.length; i++) {
            FundingPool pool = FundingPool(pools[i]);
            uint8 cur = uint8(pool.state());
            uint8 prev = _lastState[address(pool)];
            _lastState[address(pool)] = cur;
            if (prev != cur && prev != uint8(FundingState.Open)) okAll = false;
            if (cur == uint8(FundingState.Refunding)) {
                uint8 reason = pool.refundReason();
                if (reason < 1 || reason > 3) okAll = false;
                if (reason == pool.REFUND_REASON_MAJORITY() && pool.refundVotes() < pool.contributorCount() / 2 + 1) {
                    okAll = false;
                }
            } else if (cur == uint8(FundingState.Open) && pool.refundReason() != 0) {
                okAll = false;
            }
        }
        return okAll;
    }

    function property_cannot_reinitialize() public returns (bool) {
        try template.initialize(address(token), address(this), 1, "x", 1, 2) {
            return false;
        } catch {}
        for (uint256 i = 0; i < pools.length; i++) {
            try FundingPool(pools[i]).initialize(address(token), address(this), 1, "x", 1, 2) {
                return false;
            } catch {}
        }
        return true;
    }

    function poolCount() external view returns (uint256) {
        return pools.length;
    }
}
