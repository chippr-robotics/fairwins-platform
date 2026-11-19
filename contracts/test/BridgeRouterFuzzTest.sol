// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../mocks/MockERC20.sol";
import {MockAcrossSpokePool} from "../mocks/MockAcrossSpokePool.sol";
import {MockLyingFeeRouter} from "../mocks/MockLyingFeeRouter.sol";
import {FeeRouter} from "../fees/FeeRouter.sol";
import {IFeeRouter} from "../fees/IFeeRouter.sol";
import {BridgeRouter} from "../bridge/BridgeRouter.sol";
import {IBridgeRouter} from "../bridge/IBridgeRouter.sol";
import {FuzzCheats} from "./FuzzActor.sol";

/// @title BridgeRouterFuzzTest
/// @notice Medusa property harness for the spec-067 `BridgeRouter` (spec 112 FR-010, issue #1679).
/// @dev    The harness IS the member: it bridges ERC-20 and native value through the real router (UUPS
///         proxy) into `MockAcrossSpokePool`, which pulls exactly like Across does. The fee source is
///         either the real `FeeRouter` (proxy, service registered ConfigOnly with a cap ABOVE the
///         router's own 250 bps so the router's ceiling is exercised) or a `MockLyingFeeRouter` that
///         misreports its rate and/or short-splits — the hostile-admin case the AMOUNT bound exists for.
///
///         Properties: the router never holds a token, a wei, or a dangling allowance after any call;
///         the fee taken never exceeds MAX_FEE_BPS of the input (whatever the fee router claims); with
///         the honest FeeRouter it never exceeds the member's `maxFeeBps` either; and value is conserved
///         (member debit = treasury fee + amount handed to Across, with the member as depositor).
contract BridgeRouterFuzzTest {
    using FuzzCheats for uint256;

    address public constant TREASURY = address(0x40000);
    address public constant RECIPIENT = address(0x50000);
    uint256 internal constant DEST_CHAIN = 424242;
    bytes32 internal constant SERVICE = keccak256("bridge.transfer");
    uint16 internal constant ROUTER_MAX_BPS = 250;

    MockERC20 public token;
    MockERC20 public wrappedNative; // address-only stand-in: Across wraps native value itself
    MockERC20 public outToken;
    MockAcrossSpokePool public spoke;
    FeeRouter public feeRouter;
    BridgeRouter public router;
    bytes32 public erc20Route;
    bytes32 public nativeRoute;

    bool public feeAboveCap;
    bool public feeAboveConsent;
    bool public valueNotConserved;
    bool public depositorNotMember;
    uint256 public bridgesSucceeded;

    constructor() {
        FuzzCheats.deal(address(this), 1e30);
        token = new MockERC20("FuzzUSDC", "fUSDC", 1e30);
        wrappedNative = new MockERC20("FuzzWETH", "fWETH", 0);
        outToken = new MockERC20("FuzzOut", "fOUT", 0);
        spoke = new MockAcrossSpokePool();

        FeeRouter frImpl = new FeeRouter();
        feeRouter = FeeRouter(
            address(new ERC1967Proxy(address(frImpl), abi.encodeCall(FeeRouter.initialize, (address(this), TREASURY))))
        );
        // ConfigOnly with a 500 bps cap: the FeeRouter itself would allow a rate the BridgeRouter must refuse.
        feeRouter.registerService(SERVICE, 500, IFeeRouter.ServiceKind.ConfigOnly);

        BridgeRouter impl = new BridgeRouter();
        router = BridgeRouter(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(BridgeRouter.initialize, (address(this), address(feeRouter), address(spoke), address(0)))
                )
            )
        );
        router.setRoute(
            IBridgeRouter.Route({
                inputToken: address(token),
                enabled: true,
                nativeInput: false,
                expectedFillSeconds: 3600,
                outputToken: address(outToken),
                destinationChainId: DEST_CHAIN,
                maxAmount: 0
            })
        );
        router.setRoute(
            IBridgeRouter.Route({
                inputToken: address(wrappedNative),
                enabled: true,
                nativeInput: true,
                expectedFillSeconds: 3600,
                outputToken: address(outToken),
                destinationChainId: DEST_CHAIN,
                maxAmount: 0
            })
        );
        erc20Route = router.computeRouteId(address(token), address(outToken), DEST_CHAIN);
        nativeRoute = router.computeRouteId(address(wrappedNative), address(outToken), DEST_CHAIN);
        token.approve(address(router), type(uint256).max);
    }

    receive() external payable {}

    // =====================================================================
    //  Handlers
    // =====================================================================

    /// @notice Set the honest FeeRouter's live rate (anything up to ITS 500 bps cap succeeds).
    function setFeeBps(uint16 bps) public {
        try feeRouter.setFeeBps(SERVICE, uint16(uint256(bps).bound(0, 600))) {} catch {}
    }

    /// @notice Point the router at a FeeRouter that misreports (`reported`) what it takes (`actual`).
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

    function togglePause(bool paused) public {
        if (paused && !router.paused()) router.pause();
        if (!paused && router.paused()) router.unpause();
    }

    function bridgeErc20(uint96 amountSeed, uint16 maxFeeBps) public {
        uint256 amount = uint256(amountSeed).bound(0, 1e24);
        bool honest = router.feeRouter() == address(feeRouter);
        uint256 memberBefore = token.balanceOf(address(this));
        uint256 treasuryBefore = token.balanceOf(TREASURY);
        uint256 spokeBefore = token.balanceOf(address(spoke));
        try router.bridgeWithFee(
            erc20Route, amount, amount, RECIPIENT, uint32(block.timestamp), uint32(block.timestamp + 3600), 0, address(0), maxFeeBps
        ) {
            uint256 fee = token.balanceOf(TREASURY) - treasuryBefore;
            uint256 forwarded = token.balanceOf(address(spoke)) - spokeBefore;
            _check(amount, fee, forwarded, memberBefore - token.balanceOf(address(this)), maxFeeBps, honest);
        } catch {}
    }

    function bridgeNative(uint96 amountSeed, uint16 maxFeeBps) public {
        uint256 amount = uint256(amountSeed).bound(0, 1e24);
        if (address(this).balance < amount) return;
        bool honest = router.feeRouter() == address(feeRouter);
        uint256 memberBefore = address(this).balance;
        uint256 treasuryBefore = TREASURY.balance;
        uint256 spokeBefore = address(spoke).balance;
        try router.bridgeWithFee{value: amount}(
            nativeRoute, amount, amount, RECIPIENT, uint32(block.timestamp), uint32(block.timestamp + 3600), 0, address(0), maxFeeBps
        ) {
            uint256 fee = TREASURY.balance - treasuryBefore;
            uint256 forwarded = address(spoke).balance - spokeBefore;
            _check(amount, fee, forwarded, memberBefore - address(this).balance, maxFeeBps, honest);
        } catch {}
    }

    function _check(uint256 amount, uint256 fee, uint256 forwarded, uint256 debited, uint16 maxFeeBps, bool honest)
        internal
    {
        bridgesSucceeded++;
        if (fee > (amount * ROUTER_MAX_BPS) / 10_000) feeAboveCap = true;
        if (honest && fee > (amount * maxFeeBps) / 10_000) feeAboveConsent = true;
        if (debited != amount || fee + forwarded != amount) valueNotConserved = true;
        if (spoke.lastDepositor() != address(this)) depositorNotMember = true;
    }

    // =====================================================================
    //  Properties
    // =====================================================================

    /// @notice The router never retains a token, a wei, or an allowance to the SpokePool.
    function property_router_holds_nothing() public view returns (bool) {
        return token.balanceOf(address(router)) == 0 && wrappedNative.balanceOf(address(router)) == 0
            && address(router).balance == 0 && token.allowance(address(router), address(spoke)) == 0;
    }

    /// @notice The fee AMOUNT never exceeds MAX_FEE_BPS of the input, whatever the fee router reports.
    function property_fee_never_exceeds_cap() public view returns (bool) {
        return !feeAboveCap;
    }

    /// @notice With the honest FeeRouter, the fee never exceeds the member's quoted `maxFeeBps`.
    function property_fee_never_exceeds_member_consent() public view returns (bool) {
        return !feeAboveConsent;
    }

    /// @notice Member debit == input == fee + amount handed to Across; the member is the depositor.
    function property_value_conserved_member_is_depositor() public view returns (bool) {
        return !valueNotConserved && !depositorNotMember;
    }
}
