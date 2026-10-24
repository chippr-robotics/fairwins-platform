// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFundingPoolFactory
/// @notice Surface for the upgradeable factory that clones isolated funding pools (spec 103). Each pool
///         is an immutable ERC-1167 clone; the factory screens the organizer (sanctions +
///         `POOL_PARTICIPANT_ROLE` membership), assigns a unique 4-word BIP-39 index tuple in its OWN
///         phrase namespace (distinct from the wager-pool factory's), and records the pool in a
///         network-scoped registry. Same view names as {IWagerPoolFactory} so the frontend's phrase
///         gateway (`lib/pools/gateway.js#resolvePool`) works against either factory unchanged.
interface IFundingPoolFactory {
    /// @param token              Allow-listed stablecoin for the network (on value-bearing networks).
    /// @param goal               Target amount in token base units (> 0). Informational — never a cap.
    /// @param purpose            Public, plain-text purpose, 1..MAX_PURPOSE_BYTES bytes.
    /// @param contributeDeadline Absolute unix time contributions close (> now, <= now + 30 days).
    /// @param settleDeadline     Absolute unix time by which the organizer must have closed
    ///                           (> contributeDeadline, <= now + 180 days). After it, anyone may move
    ///                           the pool to refunding.
    struct CreateFundingPoolParams {
        address token;
        uint256 goal;
        string purpose;
        uint64 contributeDeadline;
        uint64 settleDeadline;
    }

    event PoolCreated(
        uint256 indexed poolId,
        address indexed pool,
        address indexed organizer,
        uint32[4] wordIndices,
        address token,
        uint256 goal,
        string purpose,
        uint64 contributeDeadline,
        uint64 settleDeadline
    );

    event TemplateUpdated(address indexed newPoolImpl);
    event SanctionsGuardUpdated(address indexed guard);
    event TokenAllowed(address indexed token, bool allowed);

    function createPool(CreateFundingPoolParams calldata p) external returns (uint256 poolId, address pool);

    // ---- Gateway resolution, both directions ----
    function poolByPhrase(uint32[4] calldata wordIndices) external view returns (address pool);
    function phraseOfPool(address pool) external view returns (uint32[4] memory wordIndices);

    // ---- Registry views ----
    function poolById(uint256 poolId) external view returns (address pool);
    function poolCount() external view returns (uint256);
    function poolAddressToId(address pool) external view returns (uint256);

    // ---- Admin ----
    function setTemplate(address newPoolImpl) external;
    function setSanctionsGuard(address guard) external;
    function setAllowedToken(address token, bool allowed) external;
}
