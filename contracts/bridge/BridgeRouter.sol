// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {UUPSManaged} from "../upgradeable/UUPSManaged.sol";
import {IFeeRouter} from "../fees/IFeeRouter.sol";
import {ISanctionsGuard} from "../interfaces/ISanctionsGuard.sol";
import {IAcrossSpokePool} from "../interfaces/external/IAcrossSpokePool.sol";
import {IBridgeRouter} from "./IBridgeRouter.sol";

/// @title BridgeRouter
/// @notice Per-network on-chain control surface for the spec-067 cross-chain bridge, and the path a
///         member's bridge takes so the spec-060 `bridge.transfer` platform fee reaches the treasury.
///         It holds the curated route registry (asset + destination chain, with per-transaction
///         limits), the Across SpokePool address, and a per-network emergency pause; and it charges
///         the fee by reading the FeeRouter (the single fee source of truth), skimming to the
///         treasury and forwarding the net to Across atomically.
/// @dev    Value-bearing but TRANSIENT-custody only: the fund-moving entrypoint is `nonReentrant`,
///         follows checks-effects-interactions, resets approvals to 0, and asserts no residual member
///         funds remain (FR-013). Config is gated by LIQUIDITY_ADMIN_ROLE; the emergency pause by
///         GUARDIAN_ROLE. Storage is append-only with a trailing `__gap` for in-place UUPS upgrades.
///
///         ── THE SAFETY PROPERTY THIS CONTRACT EXISTS TO GET RIGHT ─────────────────────────────
///         Across refunds a deposit no relayer fills by `fillDeadline` to the **`depositor` address
///         on the origin chain**. `depositor` is an ordinary parameter, independent of `msg.sender`.
///         This router therefore passes **`msg.sender` — the member** — as `depositor`, never
///         `address(this)`.
///
///         Naming the router would send every unfilled bridge into this contract, which has no
///         per-member accounting and no withdrawal path, permanently stranding funds on the one path
///         that is supposed to be the safety net. The failure is silent: the happy path is unaffected,
///         so it would only surface in production, on the unhappy path, with real money. See
///         `specs/067-bridge-pool-liquidity/research.md` R2 and the merge-blocking fork test T038.
///         ──────────────────────────────────────────────────────────────────────────────────────
///
///         The router is NEVER in the exit path: fills and refunds settle directly to the member, so
///         a pause or upgrade here can never trap an in-flight bridge (FR-043). There is deliberately
///         no rescue/claim function — see IBridgeRouter.///
///         NON-STANDARD TOKENS (traced, not merely asserted): the residual checks make this contract
///         fail CLOSED rather than lose funds. A fee-on-transfer token delivers less than
///         `inputAmount`, so the SpokePool's own pull of `net` reverts for insufficient balance; a
///         rebasing token that moves the balance mid-call trips `ResidualFunds`. Neither can silently
///         under-deliver or leave value behind. Such tokens are simply not curatable as routes.
contract BridgeRouter is IBridgeRouter, UUPSManaged, ReentrancyGuardUpgradeable, PausableUpgradeable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Holders may curate routes, limits, and the protocol/guard addresses (config).
    bytes32 public constant LIQUIDITY_ADMIN_ROLE = keccak256("LIQUIDITY_ADMIN_ROLE");
    /// @notice Holders may pause/unpause NEW bridges on this network (emergency lever).
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice FeeRouter service id for the bridge fee. Read at submit time for the live rate.
    bytes32 public constant bridgeTransferServiceId = keccak256("bridge.transfer");

    /// @notice Hard ceiling this router will charge, whatever the FeeRouter reports.
    /// @dev See the twin constant on LiquidityRouter: `bridge.transfer` is registered `ConfigOnly`,
    ///      and FeeRouter applies its own MAX_WRAPPED_FEE_BPS only to `Wrapped` services. Enforcing
    ///      the cap here makes 250 bps a property of the charging contract rather than of a
    ///      registration argument.
    uint16 public constant MAX_FEE_BPS = 250;

    /// @dev Bounds on a route's advisory delivery window: one minute to one day.
    uint32 private constant MIN_FILL_SECONDS = 60;
    uint32 private constant MAX_FILL_SECONDS = 86_400;

    // ---------------------------------------------------------------- storage (append-only)

    /// @notice Reference to the spec-060 FeeRouter (rate + treasury source of truth). Never cached.
    address public feeRouter;
    /// @notice Across SpokePool on this network.
    address public spokePool;
    /// @notice Sanctions/deny-list guard. Zero ⇒ screening disabled (mirrors the platform pattern).
    address public sanctionsGuard;
    /// @notice Curated routes by id, plus their enumerable id set (no indexer needed).
    mapping(bytes32 => Route) private _routes;
    EnumerableSet.Bytes32Set private _routeIds;

    uint256[44] private __gap;

    // ---------------------------------------------------------------- init

    /// @param admin Granted DEFAULT_ADMIN_ROLE + UPGRADER_ROLE (UUPSManaged) and LIQUIDITY_ADMIN_ROLE
    ///        + GUARDIAN_ROLE. A multisig in production.
    /// @param feeRouter_ The spec-060 FeeRouter (must be non-zero — the fee path must never silently
    ///        no-op; an unset router reverts the bridge rather than assuming a zero rate).
    /// @param spokePool_ Across SpokePool on this network (must be non-zero).
    /// @param sanctionsGuard_ Optional; zero disables screening.
    function initialize(
        address admin,
        address feeRouter_,
        address spokePool_,
        address sanctionsGuard_
    ) external initializer {
        if (admin == address(0) || feeRouter_ == address(0) || spokePool_ == address(0)) revert ZeroAddress();
        __UUPSManaged_init(admin);
        __ReentrancyGuard_init();
        __Pausable_init();
        _grantRole(LIQUIDITY_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);

        feeRouter = feeRouter_;
        spokePool = spokePool_;
        sanctionsGuard = sanctionsGuard_;
    }

    // ---------------------------------------------------------------- route id

    /// @notice Deterministic route id.
    /// @dev Includes THIS chain so the same (asset, destination) pair on a different origin chain is
    ///      a different id — ids are never portable across deployments.
    ///
    ///      `outputToken` is part of the identity too, and that is deliberate. It was originally
    ///      omitted, which meant re-running `setRoute` with a different delivered asset overwrote the
    ///      existing route IN PLACE under the same id: a member's quote and confirmation could name
    ///      one asset while the deposit delivered another, with no new route appearing anywhere an
    ///      operator or indexer would notice. Binding it to the id turns that silent substitution
    ///      into a visibly different route (adversarial review, reproduced on a Polygon fork).
    function computeRouteId(address inputToken, address outputToken, uint256 destinationChainId)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(inputToken, outputToken, block.chainid, destinationChainId));
    }

    // ---------------------------------------------------------------- config (LIQUIDITY_ADMIN_ROLE)

    /// @notice Create or update a route. Validation runs BEFORE any state change (FR-042).
    function setRoute(Route calldata route) external onlyRole(LIQUIDITY_ADMIN_ROLE) {
        if (route.inputToken == address(0) || route.outputToken == address(0)) revert ZeroAddress();
        if (route.destinationChainId == 0 || route.destinationChainId == block.chainid) {
            revert InvalidDestinationChain();
        }
        if (route.expectedFillSeconds < MIN_FILL_SECONDS || route.expectedFillSeconds > MAX_FILL_SECONDS) {
            revert InvalidFillWindow();
        }

        bytes32 routeId = computeRouteId(route.inputToken, route.outputToken, route.destinationChainId);
        _routes[routeId] = route;
        _routeIds.add(routeId); // idempotent: re-setting an existing route updates it in place

        emit RouteSet(
            routeId,
            route.inputToken,
            route.destinationChainId,
            route.outputToken,
            route.maxAmount,
            route.expectedFillSeconds,
            route.nativeInput,
            route.enabled,
            msg.sender
        );
    }

    function setRouteEnabled(bytes32 routeId, bool enabled) external onlyRole(LIQUIDITY_ADMIN_ROLE) {
        if (!_routeIds.contains(routeId)) revert RouteUnknown();
        _routes[routeId].enabled = enabled;
        emit RouteEnabledChanged(routeId, enabled, msg.sender);
    }

    function setRouteLimit(bytes32 routeId, uint256 maxAmount) external onlyRole(LIQUIDITY_ADMIN_ROLE) {
        if (!_routeIds.contains(routeId)) revert RouteUnknown();
        uint256 old = _routes[routeId].maxAmount;
        _routes[routeId].maxAmount = maxAmount;
        emit RouteLimitChanged(routeId, old, maxAmount, msg.sender);
    }

    /// @notice Remove a route entirely.
    /// @dev Safe here in a way pool removal is NOT on `LiquidityRouter`: a route holds no member
    ///      position. Removing it only stops NEW bridges — in-flight deposits live in the SpokePool
    ///      and settle or refund regardless of this contract's state.
    function removeRoute(bytes32 routeId) external onlyRole(LIQUIDITY_ADMIN_ROLE) {
        if (!_routeIds.remove(routeId)) revert RouteUnknown();
        delete _routes[routeId];
        emit RouteRemoved(routeId, msg.sender);
    }

    // ------------------------------------------- protocol wiring (DEFAULT_ADMIN_ROLE)
    //
    // These three are NOT curation, and deliberately sit a role above it.
    //
    // `spokePool` is approved and handed the member's net amount; `feeRouter` names both the rate and
    // the `treasury()` the fee is transferred to; `sanctionsGuard` is the compliance gate. Whoever can
    // write them can redirect where member funds go, so they are DEFAULT_ADMIN_ROLE while
    // LIQUIDITY_ADMIN_ROLE stays what its name says — which routes are offered, at what ceiling.
    // Curating a route badly is recoverable by toggling it; pointing the router at a hostile contract
    // is not. The amount-bound in `bridgeWithFee` is the second half of this: even an admin cannot
    // configure a FeeRouter that takes more than MAX_FEE_BPS of a member's principal.

    function setSpokePool(address newSpokePool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newSpokePool == address(0)) revert ZeroAddress();
        emit SpokePoolUpdated(spokePool, newSpokePool, msg.sender);
        spokePool = newSpokePool;
    }

    function setFeeRouter(address newFeeRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeRouter == address(0)) revert ZeroAddress();
        emit FeeRouterUpdated(feeRouter, newFeeRouter, msg.sender);
        feeRouter = newFeeRouter;
    }

    /// @notice Set or clear (zero) the sanctions guard.
    function setSanctionsGuard(address newGuard) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit SanctionsGuardUpdated(sanctionsGuard, newGuard, msg.sender);
        sanctionsGuard = newGuard;
    }

    // ---------------------------------------------------------------- reads

    function getRoute(bytes32 routeId) external view returns (Route memory) {
        return _routes[routeId];
    }

    function routeCount() external view returns (uint256) {
        return _routeIds.length();
    }

    function routeAt(uint256 index) external view returns (bytes32) {
        return _routeIds.at(index);
    }

    // ---------------------------------------------------------------- emergency pause (GUARDIAN_ROLE)

    /// @dev Pausing blocks NEW bridges only. In-flight deposits are held by the SpokePool and settle
    ///      or refund to the member regardless — a pause can never trap member value (FR-043).
    ///      Deliberately depends on nothing but this contract's own state, so it remains exercisable
    ///      while every optional service (gateway, quoting) is degraded (FR-044).
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- member action

    /// @notice Bridge `inputAmount` of a route's asset to `recipient` on the route's destination
    ///         chain, net of the platform fee. Atomic and `nonReentrant`.
    /// @param maxFeeBps The rate the member was shown; a live rate above it reverts (FR-028).
    /// @dev Ordering is checks → effects → interactions. No persistent state is written, so the only
    ///      "effect" is the event; funds move strictly in the interactions phase.
    function bridgeWithFee(
        bytes32 routeId,
        uint256 inputAmount,
        uint256 outputAmount,
        address recipient,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        address exclusiveRelayer,
        uint16 maxFeeBps
    ) external payable nonReentrant whenNotPaused {
        // ---------------- checks ----------------
        Route memory route = _routes[routeId];
        if (route.inputToken == address(0)) revert RouteUnknown();
        if (!route.enabled) revert RouteDisabled();
        if (inputAmount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (route.maxAmount != 0 && inputAmount > route.maxAmount) revert AmountAboveRouteLimit();
        if (fillDeadline <= block.timestamp) revert DeadlineInPast();

        if (route.nativeInput) {
            if (msg.value != inputAmount) revert NativeValueMismatch();
        } else if (msg.value != 0) {
            // An ERC-20 route must not receive native value: it would be unrecoverable here.
            revert UnexpectedNativeValue();
        }

        _screen(msg.sender);
        // The recipient is screened too: the README's "screening at the contract layer" must hold for a
        // direct call, not only for the app (which always bridges to the sender). Issue #1667.
        if (recipient != msg.sender) _screen(recipient);

        IFeeRouter router = IFeeRouter(feeRouter);
        (uint256 fee, uint256 net) = router.quoteFee(bridgeTransferServiceId, inputAmount);
        // Consent ceiling. Only bites when a fee is actually charged: a treasury-unset network quotes
        // fee 0, so a zero-fee bridge is never blocked by a stale configured rate (mirrors spec 066).
        uint16 liveBps = router.feeBps(bridgeTransferServiceId);
        if (liveBps > MAX_FEE_BPS) revert FeeAboveCap();
        if (fee > 0 && liveBps > maxFeeBps) revert FeeAboveQuoted();
        // THE CAP BINDS THE FEE ACTUALLY TAKEN, NOT ONLY THE RATE THE ROUTER REPORTS ABOUT ITSELF.
        // Both checks above read `feeBps()`, which is the FeeRouter's own claim. A FeeRouter reporting
        // feeBps() = 0 while quoteFee() hands back most of the amount satisfies both — the rate is
        // under the ceiling and `liveBps > maxFeeBps` is false — and the transfer below would then
        // send that "fee" to its treasury. Bounding the AMOUNT makes MAX_FEE_BPS true regardless of
        // what the router says, so pointing this contract at a hostile FeeRouter cannot redirect a
        // member's principal. Exact-split is required for the same reason: `net` is what reaches
        // Across, so a router that under-reports `net` would strand the difference here.
        if (fee + net != inputAmount) revert FeeSplitMismatch();
        if (fee > (inputAmount * MAX_FEE_BPS) / 10_000) revert FeeAboveCap();

        // ---------------- effects ----------------
        // `depositor` is msg.sender — see the contract-level note. Recorded in the event so the
        // property is externally auditable without decoding the SpokePool's own log.
        emit BridgeInitiated(
            routeId,
            msg.sender,
            recipient,
            route.destinationChainId,
            inputAmount,
            fee,
            net,
            msg.sender
        );

        // ---------------- interactions ----------------
        if (route.nativeInput) {
            _bridgeNative(route, inputAmount, net, fee, outputAmount, recipient, router.treasury(), quoteTimestamp, fillDeadline, exclusivityDeadline, exclusiveRelayer);
        } else {
            _bridgeErc20(route, inputAmount, net, fee, outputAmount, recipient, router.treasury(), quoteTimestamp, fillDeadline, exclusivityDeadline, exclusiveRelayer);
        }
    }

    // ---------------------------------------------------------------- internals

    /// @dev Split out to keep `bridgeWithFee` under the stack limit. Both legs assert the router
    ///      retains none of the member's funds afterwards (FR-013).
    function _bridgeErc20(
        Route memory route,
        uint256 inputAmount,
        uint256 net,
        uint256 fee,
        uint256 outputAmount,
        address recipient,
        address treasury,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        address exclusiveRelayer
    ) private {
        IERC20 token = IERC20(route.inputToken);
        uint256 startBalance = token.balanceOf(address(this));

        token.safeTransferFrom(msg.sender, address(this), inputAmount);
        if (fee > 0) token.safeTransfer(treasury, fee);

        token.forceApprove(spokePool, net);
        _deposit(route, net, outputAmount, recipient, quoteTimestamp, fillDeadline, exclusivityDeadline, exclusiveRelayer, 0);
        token.forceApprove(spokePool, 0);

        if (token.balanceOf(address(this)) != startBalance) revert ResidualFunds();
    }

    function _bridgeNative(
        Route memory route,
        uint256 inputAmount,
        uint256 net,
        uint256 fee,
        uint256 outputAmount,
        address recipient,
        address treasury,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        address exclusiveRelayer
    ) private {
        // Robust against force-sent ETH: we assert we consume exactly `inputAmount`.
        uint256 startBalance = address(this).balance - inputAmount;

        if (fee > 0) {
            (bool ok, ) = treasury.call{value: fee}("");
            // NOT `ResidualFunds` — that error means this router is holding value it should not be,
            // and a treasury that cannot receive ETH is a fact about a DIFFERENT contract. Conflating
            // them sends an operator to read the wrong source during an incident.
            if (!ok) revert TreasuryTransferFailed();
        }
        // Across wraps the native value itself when `inputToken` is the wrapped native token.
        _deposit(route, net, outputAmount, recipient, quoteTimestamp, fillDeadline, exclusivityDeadline, exclusiveRelayer, net);

        if (address(this).balance != startBalance) revert ResidualFunds();
    }

    /// @dev The single call site of `depositV3`. `depositor` is `msg.sender` — the member — so an
    ///      expired deposit refunds to THEM on this chain, not into this contract. Changing this
    ///      argument is a fund-stranding bug; see the contract-level note and fork test T038.
    function _deposit(
        Route memory route,
        uint256 net,
        uint256 outputAmount,
        address recipient,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        address exclusiveRelayer,
        uint256 nativeValue
    ) private {
        IAcrossSpokePool(spokePool).depositV3{value: nativeValue}(
            msg.sender, // depositor — THE MEMBER. Never address(this).
            recipient,
            route.inputToken,
            route.outputToken,
            net,
            outputAmount,
            route.destinationChainId,
            exclusiveRelayer,
            quoteTimestamp,
            fillDeadline,
            exclusivityDeadline,
            ""
        );
    }

    /// @dev Sanctions screen (spec 007 pattern). No-op when unset; otherwise reverts
    ///      ISanctionsGuard.SanctionedAddress. Read-only, during the checks phase — so a wallet
    ///      deny-listed between quote and submission is still refused (FR-032).
    function _screen(address account) private view {
        address guard = sanctionsGuard;
        if (guard != address(0)) ISanctionsGuard(guard).checkBlocked(account);
    }
}
