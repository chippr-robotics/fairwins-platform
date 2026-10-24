// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockWNative
 * @notice Test-only wrapped-native coin (spec 108). The local chain's recorded `wmatic`
 *         used to be a plain MockERC20 — a "wrapped native" that could not wrap, so the
 *         Wrap surface's on-chain coverage had nothing real to run against. This is the
 *         WETH9 shape (payable `deposit()` mints 1:1, `withdraw(wad)` burns and returns
 *         the coin, plus the canonical events), kept a STRICT SUPERSET of MockERC20's
 *         test API (`mint`/`burn`) so every swap/portfolio fixture that mints the wrapped
 *         token keeps working unchanged.
 */
contract MockWNative is ERC20 {
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply
    ) ERC20(name, symbol) {
        _mint(msg.sender, initialSupply);
    }

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        _burn(msg.sender, wad);
        emit Withdrawal(msg.sender, wad);
        (bool ok, ) = msg.sender.call{value: wad}("");
        require(ok, "MockWNative: native send failed");
    }

    // MockERC20 test API, unchanged — fixtures that mint the wrapped token keep working.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
