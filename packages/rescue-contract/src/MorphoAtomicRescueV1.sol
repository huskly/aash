// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function supplyCollateral(
        MarketParams calldata marketParams,
        uint256 assets,
        address onBehalf,
        bytes calldata data
    ) external;

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );
}

interface IOracle {
    function price() external view returns (uint256);
}

contract MorphoAtomicRescueV1 {
    struct RescueParams {
        address user;
        IMorpho.MarketParams marketParams;
        uint256 amount;
        uint256 minResultingHF;
        uint256 deadline;
    }

    error NotOwner();
    error DeadlineExpired();
    error MarketNotSupported();
    error InvalidAddress();
    error InvalidAmount();
    error NoBorrowPosition();
    error ResultingHFTooLow(uint256 actual, uint256 minimum);
    error TokenTransferFailed();
    error TokenApproveFailed();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MarketSupportUpdated(bytes32 indexed marketId, bool enabled);
    event RescueExecuted(
        address indexed user,
        bytes32 indexed marketId,
        uint256 amount,
        uint256 hfBefore,
        uint256 hfAfter,
        uint256 minRequiredHF
    );

    uint256 private constant WAD = 1e18;
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;

    address public owner;
    IMorpho public immutable morpho;

    mapping(bytes32 => bool) public supportedMarket;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address morpho_) {
        if (owner_ == address(0) || morpho_ == address(0)) {
            revert InvalidAddress();
        }

        owner = owner_;
        morpho = IMorpho(morpho_);

        emit OwnershipTransferred(address(0), owner_);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSupportedMarket(IMorpho.MarketParams calldata marketParams, bool enabled) external onlyOwner {
        bytes32 id = _marketId(marketParams);
        supportedMarket[id] = enabled;
        emit MarketSupportUpdated(id, enabled);
    }

    function rescue(RescueParams calldata params) external onlyOwner {
        if (params.deadline < block.timestamp) revert DeadlineExpired();
        if (params.user == address(0)) revert InvalidAddress();
        if (params.amount == 0) revert InvalidAmount();

        bytes32 id = _marketId(params.marketParams);
        if (!supportedMarket[id]) revert MarketNotSupported();

        uint256 hfBefore = _computeHF(params.marketParams, id, params.user, 0);

        _transferIn(params.marketParams.collateralToken, params.user, params.amount);
        _forceApprove(params.marketParams.collateralToken, address(morpho));

        morpho.supplyCollateral(params.marketParams, params.amount, params.user, "");

        uint256 hfAfter = _computeHF(params.marketParams, id, params.user, 0);
        if (hfAfter < params.minResultingHF) {
            revert ResultingHFTooLow(hfAfter, params.minResultingHF);
        }

        emit RescueExecuted(
            params.user,
            id,
            params.amount,
            hfBefore,
            hfAfter,
            params.minResultingHF
        );
    }

    function previewResultingHF(
        IMorpho.MarketParams calldata marketParams,
        address user,
        uint256 additionalCollateral
    ) external view returns (uint256) {
        bytes32 id = _marketId(marketParams);
        if (!supportedMarket[id]) revert MarketNotSupported();
        return _computeHF(marketParams, id, user, additionalCollateral);
    }

    function _computeHF(
        IMorpho.MarketParams calldata marketParams,
        bytes32 marketId,
        address user,
        uint256 additionalCollateral
    ) internal view returns (uint256) {
        (, uint128 borrowShares, uint128 collateral) = morpho.position(marketId, user);

        if (borrowShares == 0) return type(uint256).max;

        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = morpho.market(marketId);

        // Convert borrow shares to assets, rounding up
        uint256 borrowAssets = totalBorrowShares == 0
            ? 0
            : (uint256(borrowShares) * uint256(totalBorrowAssets) + uint256(totalBorrowShares) - 1)
                / uint256(totalBorrowShares);

        if (borrowAssets == 0) return type(uint256).max;

        uint256 oraclePrice = IOracle(marketParams.oracle).price();

        // HF = (collateral + additionalCollateral) * oraclePrice * lltv / (borrowAssets * ORACLE_PRICE_SCALE)
        // oraclePrice is scaled to 1e36, lltv is scaled to 1e18, result is in WAD (1e18)
        uint256 totalCollateral = uint256(collateral) + additionalCollateral;
        return (totalCollateral * oraclePrice * marketParams.lltv) / (borrowAssets * ORACLE_PRICE_SCALE);
    }

    function _marketId(IMorpho.MarketParams calldata marketParams) internal pure returns (bytes32) {
        return keccak256(abi.encode(marketParams));
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
}
