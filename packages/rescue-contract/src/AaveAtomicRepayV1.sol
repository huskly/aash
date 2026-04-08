// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

interface IAavePool {
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface IAaveAddressesProvider {
    function getPriceOracle() external view returns (address);
}

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

contract AaveAtomicRepayV1 {
    struct RescueParams {
        address user;
        address asset;
        uint256 amount;
        uint256 minResultingHf;
        uint256 deadline;
    }

    error NotOwner();
    error DeadlineExpired();
    error AssetNotSupported();
    error InvalidAddress();
    error InvalidAmount();
    error UserNotOwner();
    error ResultingHFTooLow(uint256 actual, uint256 minimum);
    error TokenTransferFailed();
    error TokenApproveFailed();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AssetSupportUpdated(address indexed asset, bool enabled);
    event RescueExecuted(
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 hfBefore,
        uint256 hfAfter,
        uint256 minRequiredHf
    );

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant VARIABLE_RATE_MODE = 2;

    address public owner;
    IAavePool public immutable POOL;
    IAaveOracle public immutable ORACLE;

    mapping(address => bool) public supportedAsset;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    constructor(address owner_, address pool_, address addressesProvider_) {
        if (owner_ == address(0) || pool_ == address(0) || addressesProvider_ == address(0)) {
            revert InvalidAddress();
        }

        owner = owner_;
        POOL = IAavePool(pool_);
        ORACLE = IAaveOracle(IAaveAddressesProvider(addressesProvider_).getPriceOracle());

        emit OwnershipTransferred(address(0), owner_);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSupportedAsset(address asset, bool enabled) external onlyOwner {
        if (asset == address(0)) revert InvalidAddress();
        supportedAsset[asset] = enabled;
        emit AssetSupportUpdated(asset, enabled);
    }

    function rescue(RescueParams calldata params) external onlyOwner {
        if (params.user != owner) revert UserNotOwner();
        if (params.deadline < block.timestamp) revert DeadlineExpired();
        if (!supportedAsset[params.asset]) revert AssetNotSupported();
        if (params.amount == 0) revert InvalidAmount();

        (, , , , , uint256 hfBefore) = POOL.getUserAccountData(params.user);

        _transferIn(params.asset, params.user, params.amount);
        _forceApprove(params.asset, address(POOL));

        POOL.repay(params.asset, params.amount, VARIABLE_RATE_MODE, params.user);

        (, , , , , uint256 hfAfter) = POOL.getUserAccountData(params.user);
        if (hfAfter < params.minResultingHf) {
            revert ResultingHFTooLow(hfAfter, params.minResultingHf);
        }

        emit RescueExecuted(
            params.user,
            params.asset,
            params.amount,
            hfBefore,
            hfAfter,
            params.minResultingHf
        );
    }

    function previewResultingHf(address user, address asset, uint256 repayAmount)
        external
        view
        returns (uint256)
    {
        if (!supportedAsset[asset]) revert AssetNotSupported();

        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            ,
            uint256 currentLiquidationThreshold,
            ,
            uint256 currentHf
        ) = POOL.getUserAccountData(user);

        if (totalDebtBase == 0) {
            return type(uint256).max;
        }

        if (repayAmount == 0) {
            return currentHf;
        }

        uint256 assetPrice = ORACLE.getAssetPrice(asset);
        uint8 assetDecimals = IERC20Metadata(asset).decimals();

        uint256 repayValueBase = (repayAmount * assetPrice) / (10 ** assetDecimals);
        uint256 newDebtBase = totalDebtBase > repayValueBase ? totalDebtBase - repayValueBase : 0;

        if (newDebtBase == 0) {
            return type(uint256).max;
        }

        uint256 weightedCollateral =
            (totalCollateralBase * currentLiquidationThreshold) / BPS_DENOMINATOR;

        return (weightedCollateral * WAD) / newDebtBase;
    }

    function _transferIn(address asset, address from, uint256 amount) internal {
        bool ok = IERC20(asset).transferFrom(from, address(this), amount);
        if (!ok) revert TokenTransferFailed();
    }

    function _forceApprove(address asset, address spender) internal {
        uint256 current = IERC20(asset).allowance(address(this), spender);
        if (current < type(uint256).max) {
            if (current != 0) {
                bool resetOk = IERC20(asset).approve(spender, 0);
                if (!resetOk) revert TokenApproveFailed();
            }
            bool ok = IERC20(asset).approve(spender, type(uint256).max);
            if (!ok) revert TokenApproveFailed();
        }
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }
}
