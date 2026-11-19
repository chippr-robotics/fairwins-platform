// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MockLidoStETH, MockWstETH, MockSpolController, MintableToken} from "../mocks/MockStakingProviders.sol";
import {FeeRouter} from "../fees/FeeRouter.sol";
import {IFeeRouter} from "../fees/IFeeRouter.sol";
import {StakingRouter} from "../staking/StakingRouter.sol";
import {FuzzCheats} from "./FuzzActor.sol";

/// @title StakingRouterFuzzTest
/// @notice Medusa property harness for the spec-066 `StakingRouter` LIQUID paths (spec 112 FR-010,
///         issue #1679).
/// @dev    The harness IS the member: it stakes ETH (Lido → wstETH) and POL (→ sPOL) through the real
///         router (UUPS proxy) against the existing Lido/sPOL mocks, with the real `FeeRouter` (services
///         registered ConfigOnly at 250 bps, as the unit suite and deploy scripts do) as the fee source.
///
///         Unlike Bridge/Liquidity, `StakingRouter` has NO amount bound of its own — it trusts
///         `FeeRouter.quoteFee`. A hostile/lying fee router is therefore deliberately NOT wired here: the
///         properties below are what holds with the real FeeRouter, and the missing amount bound is
///         reported separately as a finding rather than encoded as a failing property.
///
///         Properties: the router never holds ETH, stETH, wstETH, POL or sPOL after any call; the fee
///         never exceeds the FeeRouter cap or the member's `maxFeeBps`; value is conserved (member debit
///         = fee + net; the member receives exactly net in the liquid token).
contract StakingRouterFuzzTest {
    using FuzzCheats for uint256;

    address public constant TREASURY = address(0x40000);
    bytes32 internal constant LIDO = keccak256("stake.lido");
    bytes32 internal constant SPOL = keccak256("stake.polygon");
    uint16 internal constant CAP_BPS = 250;

    MockLidoStETH public steth;
    MockWstETH public wsteth;
    MintableToken public pol;
    MintableToken public spol;
    MockSpolController public spolController;
    FeeRouter public feeRouter;
    StakingRouter public router;

    bool public feeAboveCap;
    bool public feeAboveConsent;
    bool public valueNotConserved;
    uint256 public stakesSucceeded;

    constructor() {
        FuzzCheats.deal(address(this), 1e30);
        steth = new MockLidoStETH();
        wsteth = new MockWstETH(address(steth));
        pol = new MintableToken("FuzzPOL", "fPOL");
        spol = new MintableToken("FuzzSPOL", "fsPOL");
        spolController = new MockSpolController(address(pol), address(spol));
        pol.mint(address(this), 1e30);

        FeeRouter frImpl = new FeeRouter();
        feeRouter = FeeRouter(
            address(new ERC1967Proxy(address(frImpl), abi.encodeCall(FeeRouter.initialize, (address(this), TREASURY))))
        );
        feeRouter.registerService(LIDO, CAP_BPS, IFeeRouter.ServiceKind.ConfigOnly);
        feeRouter.registerService(SPOL, CAP_BPS, IFeeRouter.ServiceKind.ConfigOnly);

        StakingRouter impl = new StakingRouter();
        router = StakingRouter(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        StakingRouter.initialize,
                        (
                            address(this),
                            address(feeRouter),
                            address(steth),
                            address(wsteth),
                            address(spolController),
                            address(spol),
                            address(pol),
                            address(0x60000)
                        )
                    )
                )
            )
        );
        pol.approve(address(router), type(uint256).max);
    }

    receive() external payable {}

    // =====================================================================
    //  Handlers
    // =====================================================================

    function setFeeBps(bool lido, uint16 bps) public {
        try feeRouter.setFeeBps(lido ? LIDO : SPOL, uint16(uint256(bps).bound(0, 400))) {} catch {}
    }

    function togglePause(bool paused) public {
        if (paused && !router.paused()) router.pause();
        if (!paused && router.paused()) router.unpause();
    }

    function stakeLido(uint96 amountSeed, uint16 maxFeeBps) public {
        uint256 amount = uint256(amountSeed).bound(0, 1e24);
        if (address(this).balance < amount) return;
        uint256 ethBefore = address(this).balance;
        uint256 treasuryBefore = TREASURY.balance;
        uint256 wstBefore = wsteth.balanceOf(address(this));
        uint256 stBefore = steth.balanceOf(address(this));
        try router.stakeLido{value: amount}(maxFeeBps) returns (uint256 wstOut) {
            stakesSucceeded++;
            uint256 fee = TREASURY.balance - treasuryBefore;
            uint256 received = wsteth.balanceOf(address(this)) - wstBefore + steth.balanceOf(address(this)) - stBefore;
            _checkFee(amount, fee, maxFeeBps);
            if (ethBefore - address(this).balance != amount || fee + received != amount || wstOut == 0) {
                valueNotConserved = true;
            }
        } catch {}
    }

    function stakeSpol(uint96 amountSeed, uint16 maxFeeBps) public {
        uint256 amount = uint256(amountSeed).bound(0, 1e24);
        uint256 polBefore = pol.balanceOf(address(this));
        uint256 treasuryBefore = pol.balanceOf(TREASURY);
        uint256 spolBefore = spol.balanceOf(address(this));
        try router.stakeSpol(amount, maxFeeBps) returns (uint256 spolOut) {
            stakesSucceeded++;
            uint256 fee = pol.balanceOf(TREASURY) - treasuryBefore;
            uint256 received = spol.balanceOf(address(this)) - spolBefore;
            _checkFee(amount, fee, maxFeeBps);
            if (polBefore - pol.balanceOf(address(this)) != amount || fee + received != amount || spolOut != received) {
                valueNotConserved = true;
            }
        } catch {}
    }

    function _checkFee(uint256 amount, uint256 fee, uint16 maxFeeBps) internal {
        if (fee > (amount * CAP_BPS) / 10_000) feeAboveCap = true;
        if (fee > (amount * maxFeeBps) / 10_000) feeAboveConsent = true;
    }

    // =====================================================================
    //  Properties
    // =====================================================================

    function property_router_holds_nothing() public view returns (bool) {
        address r = address(router);
        return r.balance == 0 && steth.balanceOf(r) == 0 && wsteth.balanceOf(r) == 0 && pol.balanceOf(r) == 0
            && spol.balanceOf(r) == 0 && steth.allowance(r, address(wsteth)) == 0
            && pol.allowance(r, address(spolController)) == 0;
    }

    function property_fee_never_exceeds_cap() public view returns (bool) {
        return !feeAboveCap;
    }

    function property_fee_never_exceeds_member_consent() public view returns (bool) {
        return !feeAboveConsent;
    }

    function property_value_conserved() public view returns (bool) {
        return !valueNotConserved;
    }
}
