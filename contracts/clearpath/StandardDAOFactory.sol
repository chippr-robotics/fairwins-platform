// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuardUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {UUPSManaged} from "../upgradeable/UUPSManaged.sol";
import {IMembershipManager} from "../interfaces/IMembershipManager.sol";
import {ISanctionsGuard} from "../interfaces/ISanctionsGuard.sol";
import {IStandardDAOFactory} from "./interfaces/IStandardDAOFactory.sol";
import {StandardDAOGovernor} from "./StandardDAOGovernor.sol";
import {
    StandardDAOGovernorDeployer,
    StandardDAOTimelockDeployer,
    StandardDAOTokenDeployer
} from "./StandardDAODeployers.sol";

/// @title StandardDAOFactory (ClearPath spec 030, pillar A)
/// @notice One call deploys a member's standard DAO: an OpenZeppelin `TimelockController` (the DAO's
///         treasury), a stock {StandardDAOGovernor}, and — unless the member brings their own `IVotes`
///         token — a fixed-supply {StandardDAOToken}. The factory records the result for discovery and
///         indexing, and then has NO authority over it: the timelock admin role is renounced inside the
///         same transaction that grants the governor its proposer rights.
///
/// @dev    WHAT IS UPGRADEABLE AND WHAT IS NOT, and why they differ (spec 030 FR-018, amended
///         2026-08-30 / issue #1268):
///
///           - THE FACTORY IS UUPS. It holds state (the DAO index) and authority (the membership +
///             sanctions wiring), which is exactly what FR-018 requires the pattern for, and the
///             mini-app resolves it by a stable deployment key. This mirrors `WagerPoolFactory`
///             (spec 034): an upgradeable factory minting immutable products.
///
///           - THE CREATED DAO IS NOT. A platform-held upgrade key over a member's governor or
///             timelock is a key over their treasury — the timelock's entire guarantee is that only
///             its own governance can move funds, and an implementation slot we control silently
///             outranks it. This is the `SafePolicyGuard` reasoning applied to governance: a new
///             template ships as a NEW factory, never as a swap under a live DAO.
///
///         THE FACTORY HOLDS NO FUNDS. There is no `receive`, no `fallback`, and no rescue function;
///         value sent to it reverts. A created DAO's treasury is its own timelock and was never here.
///
///         Cancun-only. The OZ 5.4.0 Governor closure reaches `utils/Bytes.sol`, which uses `mcopy`, so
///         this contract cannot be compiled or deployed for pre-Cancun ETC 61 / Mordor 63. Those chains
///         are excluded from native DAO creation BY DECISION (#1268), not deferred; pillar B's
///         paris-safe `ExternalDAORegistry` keeps serving them unchanged.
///
///         UUPS (UUPSManaged); append-only storage with a trailing `__gap`; registered in
///         `npm run check:storage-layout`.
contract StandardDAOFactory is IStandardDAOFactory, UUPSManaged, ReentrancyGuardUpgradeable {
    /// @notice The membership role creation is measured against — the SAME role pillar B's
    ///         `ExternalDAORegistry` uses, so a member who can register a DAO can also launch one.
    bytes32 public constant DAO_MEMBER_ROLE = keccak256("DAO_MEMBER_ROLE");

    /// @notice Minimum membership tier to create a DAO. Deliberately identical to the registry's gate
    ///         rather than a new policy invented here.
    IMembershipManager.Tier public constant MIN_TIER = IMembershipManager.Tier.Silver;

    /// @notice Upper bound on a created DAO's timelock delay. A bound, not a policy: a member who fat-
    ///         fingers a delay of "10000000" seconds would otherwise lock their own treasury for four
    ///         months with no way back, since changing the delay is itself a timelocked proposal.
    uint256 public constant MAX_TIMELOCK_DELAY = 30 days;

    // ---- Append-only storage (never insert/reorder/remove above __gap) ----
    IMembershipManager public membershipManager;
    ISanctionsGuard public sanctionsGuard;
    uint256 public daoCount;
    mapping(uint256 => DAORecord) private _daos;
    mapping(address => uint256) private _idByGovernor; // 0 = not created here (ids start at 1)
    mapping(address => uint256[]) private _byCreator;
    /// @notice The three creation-code modules (see {StandardDAODeployers}). They are addresses rather
    ///         than inlined `new` expressions because inlining put this contract at 44,706 bytes
    ///         against EIP-170's 24,576 — undeployable on every real chain.
    StandardDAOTimelockDeployer public timelockDeployer;
    StandardDAOTokenDeployer public tokenDeployer;
    StandardDAOGovernorDeployer public governorDeployer;

    uint256[41] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // UUPSManaged's constructor already calls _disableInitializers().
    }

    function initialize(
        address admin,
        address membershipManager_,
        address sanctionsGuard_,
        address timelockDeployer_,
        address tokenDeployer_,
        address governorDeployer_
    ) external initializer {
        if (
            admin == address(0) || membershipManager_ == address(0) || sanctionsGuard_ == address(0)
                || timelockDeployer_ == address(0) || tokenDeployer_ == address(0)
                || governorDeployer_ == address(0)
        ) {
            revert ZeroAddress();
        }
        __UUPSManaged_init(admin);
        __ReentrancyGuard_init();
        membershipManager = IMembershipManager(membershipManager_);
        sanctionsGuard = ISanctionsGuard(sanctionsGuard_);
        timelockDeployer = StandardDAOTimelockDeployer(timelockDeployer_);
        tokenDeployer = StandardDAOTokenDeployer(tokenDeployer_);
        governorDeployer = StandardDAOGovernorDeployer(governorDeployer_);
    }

    /// @notice Admin may rotate the membership integration (append-only, UUPS-gated).
    function setMembershipManager(address manager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (manager == address(0)) revert ZeroAddress();
        membershipManager = IMembershipManager(manager);
    }

    /// @notice Admin may rotate the sanctions integration (append-only, UUPS-gated).
    function setSanctionsGuard(address guard) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (guard == address(0)) revert ZeroAddress();
        sanctionsGuard = ISanctionsGuard(guard);
    }

    /// @notice Admin may repoint the creation-code modules — how a corrected DAO TEMPLATE reaches new
    ///         DAOs. It never touches an existing one: deployed governors, timelocks and tokens are
    ///         immutable and are not re-pointed by anything here.
    /// @dev    This grants the admin no authority it did not already hold: `DEFAULT_ADMIN_ROLE` on this
    ///         proxy also holds `UPGRADER_ROLE`, i.e. the whole implementation. `createDAO` still
    ///         verifies the governor it is handed reports the token and timelock it asked for, so a
    ///         mis-set module fails creation loudly rather than producing a mis-wired DAO.
    function setDeployers(address timelockDeployer_, address tokenDeployer_, address governorDeployer_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (
            timelockDeployer_ == address(0) || tokenDeployer_ == address(0)
                || governorDeployer_ == address(0)
        ) revert ZeroAddress();
        timelockDeployer = StandardDAOTimelockDeployer(timelockDeployer_);
        tokenDeployer = StandardDAOTokenDeployer(tokenDeployer_);
        governorDeployer = StandardDAOGovernorDeployer(governorDeployer_);
        emit DeployersUpdated(timelockDeployer_, tokenDeployer_, governorDeployer_);
    }

    /// @inheritdoc IStandardDAOFactory
    function createDAO(DAOParams calldata params)
        external
        nonReentrant
        returns (uint256 id, address governor, address timelock, address token)
    {
        _checkAuthorized();
        _validate(params);

        // ---- Deploy, via the creation-code modules (see {StandardDAODeployers}) ----
        // The timelock is created with NO proposers and NO executors and this factory as its temporary
        // admin, purely so the roles below can be wired. It is renounced before this call returns.
        TimelockController lock =
            TimelockController(payable(timelockDeployer.deployTimelock(params.timelockDelay, address(this))));

        address votes = params.votesToken;
        bool tokenDeployed = votes == address(0);
        if (tokenDeployed) {
            votes = tokenDeployer.deployToken(
                params.tokenName, params.tokenSymbol, msg.sender, params.initialSupply
            );
        }

        StandardDAOGovernor gov = StandardDAOGovernor(
            payable(
                governorDeployer.deployGovernor(
                    params.name,
                    votes,
                    payable(address(lock)),
                    params.votingDelay,
                    params.votingPeriod,
                    params.proposalThreshold,
                    params.quorumPercent
                )
            )
        );

        // The governor's own views are the only trustworthy statement about what it is bound to, and
        // the modules above are storage-configured. Asking it fails a mis-set module here rather than
        // shipping a DAO whose treasury belongs to some other timelock.
        if (address(gov.token()) != votes || gov.timelock() != address(lock)) revert InvalidParams();

        governor = address(gov);
        timelock = address(lock);
        token = votes;

        // ---- Effects (recorded before the external role wiring below) ----
        id = ++daoCount;
        _daos[id] = DAORecord({
            governor: governor,
            timelock: timelock,
            token: token,
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            tokenDeployed: tokenDeployed,
            name: params.name
        });
        _idByGovernor[governor] = id;
        _byCreator[msg.sender].push(id);

        // ---- Interactions: hand the DAO to itself ----
        _wireAndRelinquish(lock, governor);

        emit StandardDAOCreated(id, msg.sender, governor, timelock, token, tokenDeployed, params.name);
        if (bytes(params.purpose).length != 0) emit StandardDAOPurpose(id, params.purpose);
    }

    // ---- Views ----

    function getDAO(uint256 id) external view returns (DAORecord memory) {
        return _daos[id];
    }

    function getDAOsByCreator(address creator) external view returns (uint256[] memory) {
        return _byCreator[creator];
    }

    function isDAO(address governor) external view returns (bool) {
        return _idByGovernor[governor] != 0;
    }

    // ---- Internals ----

    /// @dev Tier gate + sanctions screen, in that order. `checkBlocked` is fail-closed by contract: an
    ///      unreachable or erroring oracle means NOT allowed, so a screening outage refuses a creation
    ///      rather than waving it through.
    function _checkAuthorized() private view {
        if (
            uint8(membershipManager.getActiveTier(msg.sender, DAO_MEMBER_ROLE)) < uint8(MIN_TIER)
        ) revert InsufficientMembershipTier();
        sanctionsGuard.checkBlocked(msg.sender);
    }

    function _validate(DAOParams calldata params) private view {
        if (bytes(params.name).length == 0) revert InvalidParams();
        if (params.votingPeriod == 0) revert InvalidParams();
        if (params.quorumPercent == 0 || params.quorumPercent > 100) revert InvalidParams();
        if (params.timelockDelay > MAX_TIMELOCK_DELAY) revert InvalidParams();

        if (params.votesToken == address(0)) {
            // New-token mode: a token with no symbol is unusable in every wallet that would display it.
            if (bytes(params.tokenName).length == 0 || bytes(params.tokenSymbol).length == 0) {
                revert InvalidParams();
            }
        } else {
            _requireVotesToken(params.votesToken);
        }
    }

    /// @dev A governor whose token is not an `IVotes` is a DAO in which nobody can ever vote. Probing is
    ///      the only way to know: `IVotes` carries no ERC-165 id. An EOA is rejected outright — `try` on
    ///      an address with no code succeeds with empty returndata on some paths, which would let a typo
    ///      through.
    function _requireVotesToken(address token) private view {
        if (token.code.length == 0) revert NotAVotesToken(token);
        try IVotes(token).getVotes(address(0)) returns (uint256) {
            return;
        } catch {
            revert NotAVotesToken(token);
        }
    }

    /// @dev The security core of this contract, in five lines.
    ///
    ///      proposer  = the governor, and only the governor — a passed proposal is the only way to
    ///                  schedule anything against the treasury.
    ///      canceller = the governor, so `Governor._cancel` can withdraw a scheduled operation.
    ///      executor  = address(0), i.e. OPEN. Anyone may execute an already-scheduled, already-elapsed
    ///                  operation. This adds no authority (what executes was fixed at queue time) and
    ///                  removes a way for a DAO to strand a passed proposal behind an absent executor.
    ///      admin     = renounced. After this call the ONLY holder of the timelock's admin role is the
    ///                  timelock itself, so changing these roles is a governance proposal like any other.
    ///                  If this renounce were ever removed, this factory would hold root over every
    ///                  treasury it had ever created.
    function _wireAndRelinquish(TimelockController lock, address governor) private {
        lock.grantRole(lock.PROPOSER_ROLE(), governor);
        lock.grantRole(lock.CANCELLER_ROLE(), governor);
        lock.grantRole(lock.EXECUTOR_ROLE(), address(0));
        lock.renounceRole(lock.DEFAULT_ADMIN_ROLE(), address(this));
    }
}
