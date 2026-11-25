// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IERC20Trade
 * @notice The ERC-20 surface TrencherVault needs.
 *
 * Return values are declared `bool` here but every call site decodes
 * defensively, because a memecoin's token contract is whatever its creator
 * wrote and plenty return nothing at all.
 */
interface IERC20Trade {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
