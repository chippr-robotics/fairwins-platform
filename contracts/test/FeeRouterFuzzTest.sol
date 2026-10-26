// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../mocks/MockERC20.sol";
import {MockERC4626Vault} from "../mocks/MockERC4626Vault.sol";
import {FeeRouter} from "../fees/FeeRouter.sol";
import {IFeeRouter} from "../fees/IFeeRouter.sol";
import {FuzzCheats} from "./FuzzActor.sol";

/// @title FeeRouterFuzzTest
/// @notice Medusa property harness for the spec-060 `FeeRouter` wrapped path (spec 112 FR-010, issue #1679).
/// @dev    The harness is both the fee admin and the member. It registers one Wrapped service (cap 250)
///         and one ConfigOnly service (cap 1000), lets the fuzzer move rates (including above the cap,
///         which must revert), try to register out-of-bounds services, and deposit through
///         `depositToVaultWithFee` into a `MockERC4626Vault` whose deposit can be made to revert or mint
///         zero shares.
///
///         Properties: the router never holds the asset or a dangling vault allowance; every service's live
///         rate stays within its cap and Wrapped caps stay within MAX_WRAPPED_FEE_BPS; the fee never
///         exceeds the cap or the member's `maxFeeBps`; value is conserved (member debit = fee + vault
///         deposit) and the receiver always gets non-zero shares.
contract FeeRouterFuzzTest {
    using FuzzCheats for uint256;

    address public constant TREASURY = address(0x40000);
    address public constant RECEIVER = address(0x50000);
    bytes32 internal constant WRAPPED = keccak256("earn.lend");
    bytes32 internal constant CONFIG = keccak256("polymarket.taker");
    uint16 internal constant WRAPPED_CAP = 250;

    MockERC20 public asset;
    MockERC4626Vault public vault;
    FeeRouter public feeRouter;

    bool public feeAboveCap;
    bool public feeAboveConsent;
    bool public valueNotConserved;
    bool public rateAboveCapAccepted;
    bool public badServiceAccepted;
    uint256 public depositsSucceeded;
    uint256 internal _salt;

    constructor() {
        asset = new MockERC20("FuzzUSDC", "fUSDC", 1e30);
        vault = new MockERC4626Vault(IERC20(address(asset)));
        FeeRouter impl = new FeeRouter();
        feeRouter = FeeRouter(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(FeeRouter.initialize, (address(this), TREASURY))))
        );
        feeRouter.registerService(WRAPPED, WRAPPED_CAP, IFeeRouter.ServiceKind.Wrapped);
        feeRouter.registerService(CONFIG, 1000, IFeeRouter.ServiceKind.ConfigOnly);
        asset.approve(address(feeRouter), type(uint256).max);
    }

    // =====================================================================
    //  Handlers
    // =====================================================================

    function setFeeBps(bool wrapped, uint16 bps) public {
        bytes32 id = wrapped ? WRAPPED : CONFIG;
        uint16 cap = feeRouter.getService(id).capBps;
        try feeRouter.setFeeBps(id, bps) {
            if (bps > cap) rateAboveCapAccepted = true;
        } catch {}
    }

    /// @notice Try to register a fresh service with an arbitrary cap/kind; out-of-bounds must revert.
    function registerService(uint16 capBps, uint8 kindSeed) public {
        _salt++;
        IFeeRouter.ServiceKind kind = IFeeRouter.ServiceKind(kindSeed % 3);
        bytes32 id = keccak256(abi.encode("fuzz.service", _salt));
        try feeRouter.registerService(id, capBps, kind) {
            if (kind == IFeeRouter.ServiceKind.Unregistered || capBps == 0) badServiceAccepted = true;
            if (kind == IFeeRouter.ServiceKind.Wrapped && capBps > feeRouter.MAX_WRAPPED_FEE_BPS()) {
                badServiceAccepted = true;
            }
        } catch {}
    }

    function setVaultMode(bool revertOnDeposit, bool zeroShares) public {
        vault.setRevertOnDeposit(revertOnDeposit);
        vault.setZeroShares(zeroShares);
    }

    function deposit(uint96 amountSeed, uint16 maxFeeBps, bool wrapped) public {
        uint256 amount = uint256(amountSeed).bound(0, 1e24);
        bytes32 id = wrapped ? WRAPPED : CONFIG; // ConfigOnly must revert ServiceNotWrapped
        uint16 cap = feeRouter.getService(id).capBps;
        uint256 memberBefore = asset.balanceOf(address(this));
        uint256 treasuryBefore = asset.balanceOf(TREASURY);
        uint256 vaultBefore = asset.balanceOf(address(vault));
        uint256 sharesBefore = vault.balanceOf(RECEIVER);
        try feeRouter.depositToVaultWithFee(id, address(vault), amount, RECEIVER, maxFeeBps) returns (uint256 shares) {
            depositsSucceeded++;
            uint256 fee = asset.balanceOf(TREASURY) - treasuryBefore;
            uint256 deposited = asset.balanceOf(address(vault)) - vaultBefore;
            if (!wrapped) valueNotConserved = true;
            if (fee > (amount * cap) / 10_000) feeAboveCap = true;
            if (fee > (amount * maxFeeBps) / 10_000) feeAboveConsent = true;
            if (memberBefore - asset.balanceOf(address(this)) != amount || fee + deposited != amount) {
                valueNotConserved = true;
            }
            if (shares == 0 || vault.balanceOf(RECEIVER) - sharesBefore != shares) valueNotConserved = true;
        } catch {}
    }

    // =====================================================================
    //  Properties
    // =====================================================================

    function property_router_holds_nothing() public view returns (bool) {
        return asset.balanceOf(address(feeRouter)) == 0 && asset.allowance(address(feeRouter), address(vault)) == 0
            && address(feeRouter).balance == 0;
    }

    /// @notice Every registered service's live rate is within its cap; Wrapped caps never exceed 250.
    function property_rates_within_caps() public view returns (bool) {
        if (rateAboveCapAccepted || badServiceAccepted) return false;
        uint256 n = feeRouter.serviceCount();
        for (uint256 i = 0; i < n; i++) {
            IFeeRouter.Service memory s = feeRouter.getService(feeRouter.serviceAt(i));
            if (s.feeBps > s.capBps) return false;
            if (s.kind == IFeeRouter.ServiceKind.Wrapped && s.capBps > feeRouter.MAX_WRAPPED_FEE_BPS()) return false;
        }
        return true;
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
