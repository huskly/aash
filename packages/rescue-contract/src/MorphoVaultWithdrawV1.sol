// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface IERC4626 {
    function asset() external view returns (address);
    function maxWithdraw(address owner) external view returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares);
}

contract MorphoVaultWithdrawV1 {
    struct WithdrawParams {
        address user;
        address vault;
        uint256 assets;
        uint256 deadline;
    }

    error NotOwner();
    error NotExecutor();
    error DeadlineExpired();
    error VaultNotSupported();
    error InvalidAddress();
    error InvalidAmount();
    error UserNotOwner();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);
    event VaultSupportUpdated(address indexed vault, bool enabled);
    event VaultWithdrawExecuted(
        address indexed user, address indexed vault, uint256 assets, uint256 shares
    );

    address public owner;
    address public executor;

    mapping(address => bool) public supportedVault;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(address owner_, address executor_) {
        if (owner_ == address(0) || executor_ == address(0)) revert InvalidAddress();
        owner = owner_;
        executor = executor_;
        emit OwnershipTransferred(address(0), owner_);
        emit ExecutorUpdated(address(0), executor_);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert InvalidAddress();
        emit ExecutorUpdated(executor, newExecutor);
        executor = newExecutor;
    }

    function setSupportedVault(address vault, bool enabled) external onlyOwner {
        if (vault == address(0)) revert InvalidAddress();
        supportedVault[vault] = enabled;
        emit VaultSupportUpdated(vault, enabled);
    }

    /// @notice Redeem `assets` units of the vault's underlying from `user`'s shares
    /// and send them directly to `user`. The contract never custodies funds; it
    /// only orchestrates an ERC-4626 withdraw on behalf of the owner.
    /// Requires `user` to have approved this contract on the vault's share token.
    function withdraw(WithdrawParams calldata params) external onlyExecutor {
        if (params.user != owner) revert UserNotOwner();
        if (params.deadline < block.timestamp) revert DeadlineExpired();
        if (params.assets == 0) revert InvalidAmount();
        if (!supportedVault[params.vault]) revert VaultNotSupported();

        uint256 shares = IERC4626(params.vault).withdraw(params.assets, params.user, params.user);

        emit VaultWithdrawExecuted(params.user, params.vault, params.assets, shares);
    }

    function previewMaxWithdraw(address vault, address user) external view returns (uint256) {
        return IERC4626(vault).maxWithdraw(user);
    }
}
