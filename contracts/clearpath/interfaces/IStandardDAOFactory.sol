// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStandardDAOFactory (ClearPath spec 030, pillar A)
/// @notice The member-facing surface of the native standard-DAO factory: one call deploys an
///         OpenZeppelin `Governor` + `TimelockController` (+ optionally a fresh `ERC20Votes`) and
///         records the result for discovery/indexing.
/// @dev    Errors and the creation event live here so the frontend, the subgraph and the mini-app
///         package read ONE declaration rather than three copies of the same ABI fragment.
interface IStandardDAOFactory {
    /// @notice Everything a member chooses at creation time (spec 030 FR-001).
    /// @param name           Governor name; also the DAO's display name. Required.
    /// @param purpose        Free text recorded in the creation event only — never stored.
    /// @param votesToken     An EXISTING `IVotes` token (`ERC20Votes` or an `ERC721Votes`/soulbound
    ///                       membership NFT). `address(0)` ⇒ the factory deploys a fresh
    ///                       {StandardDAOToken} instead.
    /// @param tokenName      New-token mode only: ERC-20 name.
    /// @param tokenSymbol    New-token mode only: ERC-20 symbol.
    /// @param initialSupply  New-token mode only: minted to the creator and self-delegated.
    /// @param votingDelay    Delay before voting opens, in the token's clock units.
    /// @param votingPeriod   Voting window, in the token's clock units. Must be non-zero.
    /// @param proposalThreshold Votes required to submit a proposal.
    /// @param quorumPercent  Quorum as a percentage of past total supply, 1..100.
    /// @param timelockDelay  Minimum delay between queue and execute, in seconds.
    struct DAOParams {
        string name;
        string purpose;
        address votesToken;
        string tokenName;
        string tokenSymbol;
        uint256 initialSupply;
        uint48 votingDelay;
        uint32 votingPeriod;
        uint256 proposalThreshold;
        uint8 quorumPercent;
        uint256 timelockDelay;
    }

    /// @notice A created DAO as the factory records it.
    struct DAORecord {
        address governor;
        address timelock;
        address token;
        address creator;
        uint64 createdAt;
        bool tokenDeployed;
        string name;
    }

    /// @notice A native standard DAO was deployed. The single event an indexer needs.
    /// @dev `purpose` is deliberately NOT indexed and NOT stored — it is descriptive text, and putting
    ///      it in a topic would only make it unreadable.
    event StandardDAOCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed governor,
        address timelock,
        address token,
        bool tokenDeployed,
        string name
    );

    /// @notice Descriptive text supplied at creation, emitted separately so the primary event keeps a
    ///         fixed, cheap shape.
    event StandardDAOPurpose(uint256 indexed id, string purpose);

    /// @notice The creation-code modules were repointed. Affects FUTURE DAOs only — every already
    ///         created governor, timelock and token is immutable and untouched.
    event DeployersUpdated(address timelockDeployer, address tokenDeployer, address governorDeployer);

    error ZeroAddress();
    error InvalidParams();
    error NotAVotesToken(address token);
    error InsufficientMembershipTier();

    /// @notice Deploy a standard DAO and record it. Reverts unless the caller passes the membership
    ///         tier gate and the sanctions screen.
    function createDAO(DAOParams calldata params)
        external
        returns (uint256 id, address governor, address timelock, address token);

    function daoCount() external view returns (uint256);

    function getDAO(uint256 id) external view returns (DAORecord memory);

    function getDAOsByCreator(address creator) external view returns (uint256[] memory);

    function isDAO(address governor) external view returns (bool);
}
