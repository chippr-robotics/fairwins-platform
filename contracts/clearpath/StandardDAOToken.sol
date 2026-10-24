// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title StandardDAOToken (ClearPath spec 030, pillar A)
/// @notice The governance token {StandardDAOFactory} deploys when a member does not bring their own:
///         a fixed-supply `ERC20Votes` with `ERC20Permit`. Minted once, in the constructor; there is
///         deliberately NO mint function and NO owner, so nobody — including FairWins — can dilute a
///         DAO's electorate after creation.
/// @dev    IMMUTABLE BY DESIGN. Deployed instances belong to their DAO; the platform holds no key over
///         them (see specs/030-clearpath-standard-daos/security-notes-pillar-a.md).
///
///         Cancun-only: this file is part of the spec-030 pillar-A closure, which reaches OpenZeppelin's
///         `utils/Bytes.sol` (`mcopy`) through `Governor` → `SignatureChecker`. See the cancun override
///         block in hardhat.config.js and the 2026-08-30 amendment (issue #1268).
contract StandardDAOToken is ERC20, ERC20Permit, ERC20Votes {
    /// @param name_          ERC-20 name (also the EIP-712 domain name for permit).
    /// @param symbol_        ERC-20 symbol.
    /// @param mintTo         Receives the entire initial supply.
    /// @param initialSupply  Total supply, minted once. Zero mints nothing.
    constructor(string memory name_, string memory symbol_, address mintTo, uint256 initialSupply)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        if (initialSupply > 0) {
            _mint(mintTo, initialSupply);
            // SELF-DELEGATION AT MINT, and it is not a convenience.
            //
            // `ERC20Votes` weight is zero until a holder delegates. A freshly created DAO whose only
            // holder has not delegated has zero total voting supply, so quorum is unreachable and the
            // DAO cannot pass its own first proposal — a dead DAO that looks alive. Delegating the
            // initial mint to its recipient makes the created DAO immediately governable, which is
            // what "the DAO is created" has to mean.
            //
            // It changes nothing afterwards: later transfers do not auto-delegate, and the recipient
            // may re-delegate or undelegate at will.
            _delegate(mintTo, mintTo);
        }
    }

    // ---- Required multiple-inheritance overrides ----

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
