// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {MorphoVaultWithdrawV1} from "../src/MorphoVaultWithdrawV1.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function mint(
        address to,
        uint256 amount
    ) external {
        balanceOf[to] += amount;
    }

    function transfer(
        address to,
        uint256 amount
    ) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Minimal ERC-4626-ish vault used for testing the withdraw helper. It
///      requires the helper to be approved on `shares` to spend on behalf of
///      `owner`, and pays out underlying directly to `receiver`.
contract MockVault {
    MockUSDC public immutable UNDERLYING;

    mapping(address => uint256) public shares;
    mapping(address => mapping(address => uint256)) public shareAllowance;
    uint256 public maxWithdrawOverride;
    bool public withdrawShouldRevert;

    constructor(
        address underlying_
    ) {
        UNDERLYING = MockUSDC(underlying_);
    }

    function depositForOwner(
        address owner,
        uint256 assets
    ) external {
        UNDERLYING.mint(address(this), assets);
        shares[owner] += assets; // 1:1 for simplicity
    }

    function approveShares(
        address spender,
        uint256 amount
    ) external {
        shareAllowance[msg.sender][spender] = amount;
    }

    function setMaxWithdraw(
        uint256 value
    ) external {
        maxWithdrawOverride = value;
    }

    function setWithdrawShouldRevert(
        bool value
    ) external {
        withdrawShouldRevert = value;
    }

    function maxWithdraw(
        address owner
    ) external view returns (uint256) {
        if (maxWithdrawOverride != 0) return maxWithdrawOverride;
        return shares[owner];
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) external returns (uint256) {
        require(!withdrawShouldRevert, "vault: withdraw disabled");
        if (msg.sender != owner) {
            uint256 allowed = shareAllowance[owner][msg.sender];
            require(allowed >= assets, "vault: insufficient share allowance");
            shareAllowance[owner][msg.sender] = allowed - assets;
        }
        require(shares[owner] >= assets, "vault: insufficient shares");
        shares[owner] -= assets;
        require(UNDERLYING.transfer(receiver, assets), "vault: transfer failed");
        return assets;
    }
}

contract MorphoVaultWithdrawV1Test is Test {
    MockUSDC internal usdc;
    MockVault internal vault;
    MorphoVaultWithdrawV1 internal helper;

    address internal owner = address(0xA11CE);
    address internal executor = address(0xB0B);
    address internal stranger = address(0xCAFE);

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(address(usdc));
        helper = new MorphoVaultWithdrawV1(owner, executor);

        vault.depositForOwner(owner, 1000e6);
        vm.prank(owner);
        vault.approveShares(address(helper), type(uint256).max);

        vm.prank(owner);
        helper.setSupportedVault(address(vault), true);
    }

    function _params(
        uint256 assets,
        uint256 deadline
    ) internal view returns (MorphoVaultWithdrawV1.WithdrawParams memory) {
        return MorphoVaultWithdrawV1.WithdrawParams({
            user: owner, vault: address(vault), assets: assets, deadline: deadline
        });
    }

    function test_constructorRejectsZeroAddress() public {
        vm.expectRevert(MorphoVaultWithdrawV1.InvalidAddress.selector);
        new MorphoVaultWithdrawV1(address(0), executor);
        vm.expectRevert(MorphoVaultWithdrawV1.InvalidAddress.selector);
        new MorphoVaultWithdrawV1(owner, address(0));
    }

    function test_withdrawHappyPath() public {
        vm.prank(executor);
        helper.withdraw(_params(200e6, block.timestamp + 60));

        assertEq(usdc.balanceOf(owner), 200e6, "owner should receive underlying");
        assertEq(vault.shares(owner), 800e6, "shares debited");
        assertEq(usdc.balanceOf(address(helper)), 0, "helper holds no funds");
    }

    function test_onlyExecutorCanWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert(MorphoVaultWithdrawV1.NotExecutor.selector);
        helper.withdraw(_params(100e6, block.timestamp + 60));
    }

    function test_userMustEqualOwner() public {
        MorphoVaultWithdrawV1.WithdrawParams memory p = _params(100e6, block.timestamp + 60);
        p.user = stranger;
        vm.prank(executor);
        vm.expectRevert(MorphoVaultWithdrawV1.UserNotOwner.selector);
        helper.withdraw(p);
    }

    function test_deadlineEnforced() public {
        vm.warp(1000);
        vm.prank(executor);
        vm.expectRevert(MorphoVaultWithdrawV1.DeadlineExpired.selector);
        helper.withdraw(_params(100e6, 999));
    }

    function test_zeroAmountReverts() public {
        vm.prank(executor);
        vm.expectRevert(MorphoVaultWithdrawV1.InvalidAmount.selector);
        helper.withdraw(_params(0, block.timestamp + 60));
    }

    function test_unsupportedVaultReverts() public {
        vm.prank(owner);
        helper.setSupportedVault(address(vault), false);
        vm.prank(executor);
        vm.expectRevert(MorphoVaultWithdrawV1.VaultNotSupported.selector);
        helper.withdraw(_params(100e6, block.timestamp + 60));
    }

    function test_setSupportedVaultOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(MorphoVaultWithdrawV1.NotOwner.selector);
        helper.setSupportedVault(address(vault), false);
    }

    function test_setExecutorOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(MorphoVaultWithdrawV1.NotOwner.selector);
        helper.setExecutor(address(0xDEAD));
    }

    function test_rotateExecutor() public {
        address newExecutor = address(0xDEAD);
        vm.prank(owner);
        helper.setExecutor(newExecutor);

        vm.prank(executor);
        vm.expectRevert(MorphoVaultWithdrawV1.NotExecutor.selector);
        helper.withdraw(_params(50e6, block.timestamp + 60));

        vm.prank(newExecutor);
        helper.withdraw(_params(50e6, block.timestamp + 60));
        assertEq(usdc.balanceOf(owner), 50e6);
    }

    function test_previewMaxWithdrawReflectsVault() public {
        assertEq(helper.previewMaxWithdraw(address(vault), owner), 1000e6);
        vault.setMaxWithdraw(123e6);
        assertEq(helper.previewMaxWithdraw(address(vault), owner), 123e6);
    }

    function test_withdrawPropagatesVaultRevert() public {
        vault.setWithdrawShouldRevert(true);
        vm.prank(executor);
        vm.expectRevert(bytes("vault: withdraw disabled"));
        helper.withdraw(_params(100e6, block.timestamp + 60));
    }
}
