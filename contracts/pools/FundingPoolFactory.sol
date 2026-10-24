// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {UUPSManaged} from "../upgradeable/UUPSManaged.sol";
import {SignerIntentBase} from "../upgradeable/SignerIntentBase.sol";
import {ISanctionsGuard} from "../interfaces/ISanctionsGuard.sol";
import {IMembershipManager} from "../interfaces/IMembershipManager.sol";
import {IFundingPoolFactory} from "./interfaces/IFundingPoolFactory.sol";
import {IFundingPool} from "./interfaces/IFundingPool.sol";
import {FundingPool} from "./FundingPool.sol";

/// @notice Minimal surface for the pool's inherited {SignerIntentBase.invalidateNonceWithSig}, which
///         {IFundingPool} does not re-declare (same shape as the wager-pool factory's forwarder).
interface IFundingPoolIntentCancel {
    function invalidateNonceWithSig(address signer, bytes32 nonce, uint256 validBefore, bytes calldata sig) external;
}

/// @title FundingPoolFactory — authority & registry for group funding pools (spec 103)
/// @notice A SIBLING of the spec-034 {WagerPoolFactory}, deliberately not an extension of it: the live
///         wager factory holds escrow-bearing state behind a UUPS proxy, and a funding pool shares no
///         lifecycle state with a wager. This factory copies the proven mechanics — screen the organizer
///         on the real wallet (sanctions + `POOL_PARTICIPANT_ROLE` membership), assign a unique
///         language-independent 4-word BIP-39 index tuple in its OWN namespace, deploy the pool as an
///         immutable ERC-1167 clone of {FundingPool}, record it in a network-scoped registry, and route
///         relayer twins through this stable address — and drops the payout matrix entirely.
/// @dev    Inherits {UUPSManaged} (UUPS + AccessControl + non-brickable upgrade gate + impl-init lockout)
///         and {ReentrancyGuardUpgradeable}. Storage is append-only with a trailing `__gap` (registered
///         in `npm run check:storage-layout` under `fundingPoolFactory`). Pools are IMMUTABLE clones —
///         only this factory is upgradeable. When `screeningRequired` is set (value-bearing networks) a
///         sanctions guard AND membership manager MUST be configured and the token MUST be allow-listed.
contract FundingPoolFactory is IFundingPoolFactory, UUPSManaged, ReentrancyGuardUpgradeable, SignerIntentBase {
    /// @notice Membership role gating pool participation — the SAME role wager pools use, so one tier
    ///         configuration covers both pool kinds.
    bytes32 public constant POOL_PARTICIPANT_ROLE = keccak256("POOL_PARTICIPANT_ROLE");

    /// @notice Upper bound on the public purpose string (bytes).
    uint256 public constant MAX_PURPOSE_BYTES = 200;

    /// @notice Deadline bounds, mirroring {WagerPoolFactory}/{WagerRegistry} (30-day contribution
    ///         horizon, 180-day settlement horizon).
    uint64 public constant MAX_CONTRIBUTE_WINDOW = 30 days;
    uint64 public constant MAX_SETTLE_WINDOW = 180 days;

    /// @notice EIP-712 typehash for the gasless {createPoolWithSig} intent, verified against this
    ///         factory's OWN domain ("FairWins FundingPoolFactory"/"1"). The purpose rides as its hash so
    ///         the struct stays fixed-size; the calldata string is re-hashed on-chain.
    bytes32 private constant CREATE_TYPEHASH = keccak256(
        "CreateFundingPool(address organizer,address token,uint256 goal,bytes32 purposeHash,uint64 contributeDeadline,uint64 settleDeadline,bytes32 nonce,uint256 validAfter,uint256 validBefore)"
    );

    // ---- Append-only storage (never insert/reorder/remove above __gap) ----

    /// @notice Immutable pool implementation cloned per pool (replaceable by admin via {setTemplate}).
    address public poolImpl;

    /// @notice Sanctions screen for organizers + contributors. address(0) disables (only allowed when
    ///         `screeningRequired` is false — local/dev/test).
    ISanctionsGuard public sanctionsGuard;

    /// @notice Membership gate (`POOL_PARTICIPANT_ROLE`). address(0) disables under the same rule.
    IMembershipManager public membershipManager;

    /// @notice When true (value-bearing networks), both guards MUST be configured; create/contribute
    ///         revert if screening cannot be performed.
    bool public screeningRequired;

    /// @notice Monotonic id allocator. Ids start at 1 so `poolAddressToId == 0` means "unknown".
    uint256 public poolCount;

    mapping(uint256 => address) private _pools;

    /// @notice Reverse lookup: pool address -> registry id (0 == unknown).
    mapping(address => uint256) public poolAddressToId;

    /// @notice keccak256(wordIndices) -> pool, for gateway resolution + uniqueness.
    mapping(bytes32 => address) private _phraseToPool;
    mapping(address => uint32[4]) private _poolToPhrase;

    /// @notice Escrow token allow-list. Enforced only when `screeningRequired` (value-bearing networks);
    ///         on local/dev/test any token is accepted so fixtures can use a mock stablecoin.
    mapping(address => bool) public allowedToken;

    uint256[49] private __gap;

    error InvalidParams();
    error BadDeadlines();
    error PurposeLength();
    error TokenNotAllowed();
    error ScreeningNotConfigured();
    error MembershipNotConfigured();
    error MembershipDenied();
    /// @notice A relayer forwarder was called with a `pool` this factory did not create.
    error UnknownPool();

    /// @notice Initialize the factory proxy.
    function initialize(
        address admin,
        address poolImpl_,
        address sanctionsGuard_,
        address membershipManager_,
        bool screeningRequired_
    ) external initializer {
        __UUPSManaged_init(admin);
        __ReentrancyGuard_init();
        __EIP712_init("FairWins FundingPoolFactory", "1");
        if (poolImpl_ == address(0)) revert InvalidParams();
        if (screeningRequired_ && (sanctionsGuard_ == address(0) || membershipManager_ == address(0))) {
            revert InvalidParams();
        }
        poolImpl = poolImpl_;
        sanctionsGuard = ISanctionsGuard(sanctionsGuard_);
        membershipManager = IMembershipManager(membershipManager_);
        screeningRequired = screeningRequired_;
    }

    // ---------------------------------------------------------------------
    // Create
    // ---------------------------------------------------------------------

    /// @inheritdoc IFundingPoolFactory
    function createPool(CreateFundingPoolParams calldata p)
        external
        nonReentrant
        returns (uint256 poolId, address pool)
    {
        return _createPool(p, msg.sender);
    }

    /// @notice Gasless {createPool}: the pool is created for and attributed to the recovered EIP-712
    ///         `signer` — screened as the organizer — never the relayer that submits it. The factory
    ///         verifies the intent against its OWN domain and burns the single-use nonce before any pool
    ///         exists; a bad/expired/replayed intent creates nothing.
    function createPoolWithSig(
        CreateFundingPoolParams calldata p,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external nonReentrant returns (uint256 poolId, address pool) {
        bytes32 structHash = keccak256(
            abi.encode(
                CREATE_TYPEHASH,
                signer,
                p.token,
                p.goal,
                keccak256(bytes(p.purpose)),
                p.contributeDeadline,
                p.settleDeadline,
                nonce,
                validAfter,
                validBefore
            )
        );
        _verifyIntent(structHash, signer, nonce, validAfter, validBefore, sig);
        return _createPool(p, signer);
    }

    /// @dev Shared create path. `organizer` is `msg.sender` for self-submit and the recovered signer for
    ///      the gasless twin; screening/attribution/events all key on it.
    function _createPool(CreateFundingPoolParams calldata p, address organizer)
        internal
        returns (uint256 poolId, address pool)
    {
        // Screen the organizer on the real wallet, before any pool exists.
        screen(organizer);
        requireMembership(organizer);

        if (p.token == address(0) || p.goal == 0) revert InvalidParams();
        uint256 len = bytes(p.purpose).length;
        if (len == 0 || len > MAX_PURPOSE_BYTES) revert PurposeLength();
        // `totalRaised == balance` is the escrow invariant, which only holds for a well-behaved token —
        // so on value-bearing networks the token set is curated by the admin, not organizer-chosen.
        if (screeningRequired && !allowedToken[p.token]) revert TokenNotAllowed();
        _checkDeadlines(p.contributeDeadline, p.settleDeadline);

        poolId = ++poolCount;
        pool = Clones.clone(poolImpl);
        FundingPool(pool).initialize(p.token, organizer, p.goal, p.purpose, p.contributeDeadline, p.settleDeadline);

        uint32[4] memory wordIndices = _assignPhrase(poolId, pool);

        _pools[poolId] = pool;
        poolAddressToId[pool] = poolId;

        emit PoolCreated(
            poolId, pool, organizer, wordIndices, p.token, p.goal, p.purpose, p.contributeDeadline, p.settleDeadline
        );
    }

    /// @dev Deadline bounds + ordering, mirroring {WagerPoolFactory._checkDeadlines}: contributions close
    ///      in the future and within 30 days; settlement strictly after that and within 180 days.
    function _checkDeadlines(uint64 contributeDeadline, uint64 settleDeadline) internal view {
        if (contributeDeadline <= block.timestamp) revert BadDeadlines();
        if (settleDeadline <= contributeDeadline) revert BadDeadlines();
        if (contributeDeadline > block.timestamp + MAX_CONTRIBUTE_WINDOW) revert BadDeadlines();
        if (settleDeadline > block.timestamp + MAX_SETTLE_WINDOW) revert BadDeadlines();
    }

    /// @dev Derive a unique 4-word BIP-39 index tuple (each 0..2047) for `poolId`, collision-checked
    ///      against this factory's pools. The tuple is the language-independent identity; the frontend
    ///      renders it through the active language's wordlist. The derivation salts with the contract
    ///      address so the wager-pool and funding-pool phrase spaces are decorrelated.
    function _assignPhrase(uint256 poolId, address pool) internal returns (uint32[4] memory idx) {
        uint256 nonce;
        bytes32 key;
        while (true) {
            uint256 h = uint256(keccak256(abi.encode(address(this), poolId, nonce)));
            idx[0] = uint32(h % 2048);
            idx[1] = uint32((h >> 11) % 2048);
            idx[2] = uint32((h >> 22) % 2048);
            idx[3] = uint32((h >> 33) % 2048);
            key = _phraseKey(idx);
            if (_phraseToPool[key] == address(0)) break;
            unchecked {
                nonce++;
            }
        }
        _phraseToPool[key] = pool;
        _poolToPhrase[pool] = idx;
    }

    function _phraseKey(uint32[4] memory idx) internal pure returns (bytes32) {
        return keccak256(abi.encode(idx[0], idx[1], idx[2], idx[3]));
    }

    // ---------------------------------------------------------------------
    // Gateway resolution + registry views
    // ---------------------------------------------------------------------

    /// @inheritdoc IFundingPoolFactory
    function poolByPhrase(uint32[4] calldata wordIndices) external view returns (address pool) {
        uint32[4] memory idx = wordIndices;
        return _phraseToPool[_phraseKey(idx)];
    }

    /// @inheritdoc IFundingPoolFactory
    function phraseOfPool(address pool) external view returns (uint32[4] memory wordIndices) {
        return _poolToPhrase[pool];
    }

    /// @inheritdoc IFundingPoolFactory
    function poolById(uint256 poolId) external view returns (address pool) {
        return _pools[poolId];
    }

    // ---------------------------------------------------------------------
    // Compliance callbacks (used by pools, on the real wallet)
    // ---------------------------------------------------------------------

    /// @notice Reverts if `account` fails sanctions screening; reverts if screening is required but
    ///         unconfigured. No-op when disabled on local/dev/test.
    function screen(address account) public view {
        ISanctionsGuard g = sanctionsGuard;
        if (address(g) == address(0)) {
            if (screeningRequired) revert ScreeningNotConfigured();
            return;
        }
        g.checkBlocked(account);
    }

    /// @notice Reverts if `account` is not an allowed `POOL_PARTICIPANT_ROLE` member; reverts if
    ///         membership is required but unconfigured.
    function requireMembership(address account) public view {
        IMembershipManager m = membershipManager;
        if (address(m) == address(0)) {
            if (screeningRequired) revert MembershipNotConfigured();
            return;
        }
        if (!m.checkCanCreate(account, POOL_PARTICIPANT_ROLE)) revert MembershipDenied();
    }

    // ---------------------------------------------------------------------
    // Relayer forwarders — route a clone's gasless twin through the STABLE factory address so ONLY the
    // factory ever needs whitelisting at a relayer engine. Each enforces pool provenance ON-CHAIN
    // (`poolAddressToId[pool] != 0`) and is otherwise a PURE PASS-THROUGH: the clone verifies the
    // member's EIP-712 signature against its own per-clone domain. The self-submit + direct-to-clone
    // paths remain available (never-stranded).
    // ---------------------------------------------------------------------

    function _requirePool(address pool) internal view {
        if (poolAddressToId[pool] == 0) revert UnknownPool();
    }

    /// @notice Forward the organizer's gasless close intent to `pool`. Funds go to the organizer.
    function closeWithSigFor(
        address pool,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        _requirePool(pool);
        IFundingPool(pool).closeWithSig(signer, nonce, validAfter, validBefore, sig);
    }

    /// @notice Forward the organizer's gasless cancel (refund everyone) intent to `pool`.
    function cancelWithSigFor(
        address pool,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        _requirePool(pool);
        IFundingPool(pool).cancelWithSig(signer, nonce, validAfter, validBefore, sig);
    }

    /// @notice Forward a contributor's gasless refund vote to `pool`.
    function voteRefundWithSigFor(
        address pool,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        _requirePool(pool);
        IFundingPool(pool).voteRefundWithSig(signer, nonce, validAfter, validBefore, sig);
    }

    /// @notice Forward a contributor's gasless refund claim to `pool`. Funds go to the signer, never the
    ///         relayer.
    function claimRefundWithSigFor(
        address pool,
        address signer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        _requirePool(pool);
        IFundingPool(pool).claimRefundWithSig(signer, nonce, validAfter, validBefore, sig);
    }

    /// @notice Forward a gasless contribution (EIP-3009 receive authorization) to `pool`. The token itself
    ///         enforces the authorization's `to` is the caller — the pool clone — so the funds move from
    ///         `from` into the pool escrow; the factory never custodies funds.
    function contributeWithAuthorizationFor(
        address pool,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _requirePool(pool);
        IFundingPool(pool).contributeWithAuthorization(from, value, validAfter, validBefore, nonce, v, r, s);
    }

    /// @notice Forward the permissionless settle-deadline poke to `pool`.
    function pokeDeadlineFor(address pool) external {
        _requirePool(pool);
        IFundingPool(pool).pokeDeadline();
    }

    /// @notice Forward a member's gasless nonce cancellation to `pool`, so a signed-but-unsubmitted pool
    ///         intent can be revoked without holding gas.
    function invalidateNonceWithSigFor(
        address pool,
        address signer,
        bytes32 nonce,
        uint256 validBefore,
        bytes calldata sig
    ) external {
        _requirePool(pool);
        IFundingPoolIntentCancel(pool).invalidateNonceWithSig(signer, nonce, validBefore, sig);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @inheritdoc IFundingPoolFactory
    function setTemplate(address newPoolImpl) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPoolImpl == address(0)) revert InvalidParams();
        poolImpl = newPoolImpl;
        emit TemplateUpdated(newPoolImpl);
    }

    /// @inheritdoc IFundingPoolFactory
    function setSanctionsGuard(address guard) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (screeningRequired && guard == address(0)) revert ScreeningNotConfigured();
        sanctionsGuard = ISanctionsGuard(guard);
        emit SanctionsGuardUpdated(guard);
    }

    /// @notice Set/replace the membership manager. When `screeningRequired`, address(0) is rejected.
    function setMembershipManager(address manager) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (screeningRequired && manager == address(0)) revert MembershipNotConfigured();
        membershipManager = IMembershipManager(manager);
    }

    /// @notice Allow/deny an escrow token. Curate the canonical stablecoin per network here; on
    ///         value-bearing networks {createPool} rejects any token not on this list.
    function setAllowedToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }
}
