// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../mocks/MockERC20.sol";
import {MockPositionManager} from "../mocks/MockPositionManager.sol";
import {MockUniswapV3Pool} from "../mocks/MockUniswapV3Pool.sol";
import {MockLyingFeeRouter} from "../mocks/MockLyingFeeRouter.sol";
import {FeeRouter} from "../fees/FeeRouter.sol";
import {IFeeRouter} from "../fees/IFeeRouter.sol";
import {LiquidityRouter} from "../liquidity/LiquidityRouter.sol";
import {ILiquidityRouter} from "../liquidity/ILiquidityRouter.sol";
import {FuzzCheats} from "./FuzzActor.sol";

/// @title LiquidityRouterFuzzTest
/// @notice Medusa property harness for the spec-067 `LiquidityRouter` (spec 112 FR-010, issue #1679).
/// @dev    The harness IS the member and supplies a curated Uniswap V3 pair through the real router (UUPS
///         proxy) into `MockPositionManager`, whose `consumeBps` the fuzzer moves so partial consumption
///         (and therefore the refund leg and fee-on-consumed-capital rule) is exercised. Fee source is the
///         real `FeeRouter` (ConfigOnly, cap 500 > router's 250) or a `MockLyingFeeRouter`.
///
///         Properties: the router never holds either token or a dangling allowance; the fee on each leg
///         never exceeds MAX_FEE_BPS of the capital the position ACTUALLY consumed; with the honest
///         FeeRouter it never exceeds the member's `maxFeeBps` of that capital; value is conserved
///         (member debit = consumed + fee, per leg) and the position NFT is owned by the member.
contract LiquidityRouterFuzzTest {
    using FuzzCheats for uint256;

    address public constant TREASURY = address(0x40000);
    bytes32 internal constant SERVICE = keccak256("liquidity.deposit");
    uint16 internal constant ROUTER_MAX_BPS = 250;
    uint24 internal constant FEE_TIER = 3000;

    MockERC20 public token0;
    MockERC20 public token1;
    MockUniswapV3Pool public uniPool;
    MockPositionManager public nfpm;
    FeeRouter public feeRouter;
    LiquidityRouter public router;
    bytes32 public poolId;

    bool public feeAboveCap;
    bool public feeAboveConsent;
    bool public valueNotConserved;
    bool public positionNotMembers;
    uint256 public suppliesSucceeded;

    constructor() {
        MockERC20 a = new MockERC20("FuzzA", "fA", 1e30);
        MockERC20 b = new MockERC20("FuzzB", "fB", 1e30);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        uniPool = new MockUniswapV3Pool(address(token0), address(token1), FEE_TIER, 60);
        nfpm = new MockPositionManager();

        FeeRouter frImpl = new FeeRouter();
        feeRouter = FeeRouter(
            address(new ERC1967Proxy(address(frImpl), abi.encodeCall(FeeRouter.initialize, (address(this), TREASURY))))
        );
        feeRouter.registerService(SERVICE, 500, IFeeRouter.ServiceKind.ConfigOnly);

        LiquidityRouter impl = new LiquidityRouter();
        router = LiquidityRouter(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(LiquidityRouter.initialize, (address(this), address(feeRouter), address(nfpm), address(0)))
                )
            )
        );
        ILiquidityRouter.PoolListing memory listing = ILiquidityRouter.PoolListing({
            kind: ILiquidityRouter.PoolKind.TradingLp,
            enabled: true,
            feeTier: FEE_TIER,
            token0: address(token0),
            token1: address(token1),
            poolAddress: address(uniPool),
            maxDeposit0PerTx: 0,
            maxDeposit1PerTx: 0
        });
        router.listPool(listing);
        poolId = router.computePoolId(ILiquidityRouter.PoolKind.TradingLp, address(uniPool), address(token0), address(token1));
        token0.approve(address(router), type(uint256).max);
        token1.approve(address(router), type(uint256).max);
    }

    // =====================================================================
    //  Handlers
    // =====================================================================

    function setFeeBps(uint16 bps) public {
        try feeRouter.setFeeBps(SERVICE, uint16(uint256(bps).bound(0, 600))) {} catch {}
    }

    function useLyingFeeRouter(uint16 reported, uint16 actual, bool splitShort) public {
        MockLyingFeeRouter lying = new MockLyingFeeRouter(
            TREASURY, uint16(uint256(reported).bound(0, 600)), uint16(uint256(actual).bound(0, 10_000))
        );
        lying.setSplitShort(splitShort);
        router.setFeeRouter(address(lying));
    }

    function useHonestFeeRouter() public {
        router.setFeeRouter(address(feeRouter));
    }

    /// @notice How much of the desired amounts the mock position manager consumes (partial fills).
    function setConsumeBps(uint16 bps) public {
        nfpm.setConsumeBps(uint16(uint256(bps).bound(0, 10_000)));
    }

    function togglePause(bool paused) public {
        if (paused && !router.paused()) router.pause();
        if (!paused && router.paused()) router.unpause();
    }

    function supply(uint96 amount0Seed, uint96 amount1Seed, uint16 maxFeeBps) public {
        uint256 a0 = uint256(amount0Seed).bound(0, 1e24);
        uint256 a1 = uint256(amount1Seed).bound(0, 1e24);
        bool honest = router.feeRouter() == address(feeRouter);
        uint256[6] memory before = [
            token0.balanceOf(address(this)),
            token1.balanceOf(address(this)),
            token0.balanceOf(TREASURY),
            token1.balanceOf(TREASURY),
            token0.balanceOf(address(nfpm)),
            token1.balanceOf(address(nfpm))
        ];
        try router.mintFullRangeWithFee(poolId, a0, a1, 0, 0, block.timestamp + 1, maxFeeBps) returns (
            uint256 tokenId, uint128, uint256, uint256
        ) {
            suppliesSucceeded++;
            uint256 fee0 = token0.balanceOf(TREASURY) - before[2];
            uint256 fee1 = token1.balanceOf(TREASURY) - before[3];
            uint256 used0 = token0.balanceOf(address(nfpm)) - before[4];
            uint256 used1 = token1.balanceOf(address(nfpm)) - before[5];
            uint256 debit0 = before[0] - token0.balanceOf(address(this));
            uint256 debit1 = before[1] - token1.balanceOf(address(this));
            if (fee0 > (used0 * ROUTER_MAX_BPS) / 10_000 || fee1 > (used1 * ROUTER_MAX_BPS) / 10_000) feeAboveCap = true;
            if (honest && (fee0 > (used0 * maxFeeBps) / 10_000 || fee1 > (used1 * maxFeeBps) / 10_000)) {
                feeAboveConsent = true;
            }
            if (debit0 != used0 + fee0 || debit1 != used1 + fee1) valueNotConserved = true;
            if (nfpm.ownerOf(tokenId) != address(this)) positionNotMembers = true;
        } catch {}
    }

    // =====================================================================
    //  Properties
    // =====================================================================

    function property_router_holds_nothing() public view returns (bool) {
        return token0.balanceOf(address(router)) == 0 && token1.balanceOf(address(router)) == 0
            && address(router).balance == 0 && token0.allowance(address(router), address(nfpm)) == 0
            && token1.allowance(address(router), address(nfpm)) == 0 && nfpm.balanceOf(address(router)) == 0;
    }

    function property_fee_never_exceeds_cap() public view returns (bool) {
        return !feeAboveCap;
    }

    function property_fee_never_exceeds_member_consent() public view returns (bool) {
        return !feeAboveConsent;
    }

    function property_value_conserved_member_owns_position() public view returns (bool) {
        return !valueNotConserved && !positionNotMembers;
    }
}
