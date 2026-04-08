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

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }

    function repay(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata data
    ) external returns (uint256, uint256);

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

interface IIrm {
    function borrowRateView(IMorpho.MarketParams memory marketParams, IMorpho.Market memory market)
        external
        view
        returns (uint256);
}

interface IOracle {
    function price() external view returns (uint256);
}

contract MorphoAtomicRepayV1 {
    struct RescueParams {
        address user;
        IMorpho.MarketParams marketParams;
        uint256 amount;
        uint256 minResultingHf;
        uint256 deadline;
    }

    error NotOwner();
    error DeadlineExpired();
    error MarketNotSupported();
    error InvalidAddress();
    error InvalidAmount();
    error UserNotOwner();
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
        uint256 minRequiredHf
    );

    uint256 private constant WAD = 1e18;
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;

    address public owner;
    IMorpho public immutable MORPHO;

    mapping(bytes32 => bool) public supportedMarket;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    constructor(address owner_, address morpho_) {
        if (owner_ == address(0) || morpho_ == address(0)) {
            revert InvalidAddress();
        }

        owner = owner_;
        MORPHO = IMorpho(morpho_);

        emit OwnershipTransferred(address(0), owner_);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSupportedMarket(IMorpho.MarketParams calldata marketParams, bool enabled)
        external
        onlyOwner
    {
        bytes32 id = _marketId(marketParams);
        supportedMarket[id] = enabled;
        emit MarketSupportUpdated(id, enabled);
    }

    function rescue(RescueParams calldata params) external onlyOwner {
        if (params.user != owner) revert UserNotOwner();
        if (params.deadline < block.timestamp) revert DeadlineExpired();
        if (params.amount == 0) revert InvalidAmount();

        bytes32 id = _marketId(params.marketParams);
        if (!supportedMarket[id]) revert MarketNotSupported();

        uint256 hfBefore = _computeHf(params.marketParams, id, params.user, 0);

        _transferIn(params.marketParams.loanToken, params.user, params.amount);
        _forceApprove(params.marketParams.loanToken, address(MORPHO));

        MORPHO.repay(params.marketParams, params.amount, 0, params.user, "");

        uint256 hfAfter = _computeHf(params.marketParams, id, params.user, 0);
        if (hfAfter < params.minResultingHf) {
            revert ResultingHFTooLow(hfAfter, params.minResultingHf);
        }

        emit RescueExecuted(
            params.user, id, params.amount, hfBefore, hfAfter, params.minResultingHf
        );
    }

    function previewResultingHf(
        IMorpho.MarketParams calldata marketParams,
        address user,
        uint256 debtReduction
    ) external view returns (uint256) {
        bytes32 id = _marketId(marketParams);
        if (!supportedMarket[id]) revert MarketNotSupported();
        return _computeHf(marketParams, id, user, debtReduction);
    }

    function _computeHf(
        IMorpho.MarketParams calldata marketParams,
        bytes32 marketId,
        address user,
        uint256 debtReduction
    ) internal view returns (uint256) {
        (, uint128 borrowShares, uint128 collateral) = MORPHO.position(marketId, user);

        if (borrowShares == 0) return type(uint256).max;

        IMorpho.Market memory marketState = _marketState(marketId);
        uint256 borrowAssets =
            _expectedBorrowAssets(marketParams, marketState, uint256(borrowShares));

        uint256 effectiveBorrow = borrowAssets > debtReduction ? borrowAssets - debtReduction : 0;
        if (effectiveBorrow == 0) return type(uint256).max;

        uint256 oraclePrice = IOracle(marketParams.oracle).price();
        uint256 maxBorrow = _wMulDown(
            _mulDivDown(uint256(collateral), oraclePrice, ORACLE_PRICE_SCALE), marketParams.lltv
        );
        return _wDivDown(maxBorrow, effectiveBorrow);
    }

    function _marketId(IMorpho.MarketParams calldata marketParams)
        internal
        pure
        returns (bytes32)
    {
        bytes32 marketId;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, calldataload(marketParams))
            mstore(add(ptr, 0x20), calldataload(add(marketParams, 0x20)))
            mstore(add(ptr, 0x40), calldataload(add(marketParams, 0x40)))
            mstore(add(ptr, 0x60), calldataload(add(marketParams, 0x60)))
            mstore(add(ptr, 0x80), calldataload(add(marketParams, 0x80)))
            marketId := keccak256(ptr, 0xa0)
        }
        return marketId;
    }

    function _marketState(bytes32 marketId)
        internal
        view
        returns (IMorpho.Market memory marketState)
    {
        (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        ) = MORPHO.market(marketId);

        marketState = IMorpho.Market({
            totalSupplyAssets: totalSupplyAssets,
            totalSupplyShares: totalSupplyShares,
            totalBorrowAssets: totalBorrowAssets,
            totalBorrowShares: totalBorrowShares,
            lastUpdate: lastUpdate,
            fee: fee
        });
    }

    function _expectedBorrowAssets(
        IMorpho.MarketParams calldata marketParams,
        IMorpho.Market memory marketState,
        uint256 borrowShares
    ) internal view returns (uint256) {
        uint256 totalBorrowAssets = uint256(marketState.totalBorrowAssets);
        uint256 elapsed = block.timestamp - uint256(marketState.lastUpdate);

        if (elapsed != 0 && marketParams.irm != address(0)) {
            uint256 borrowRate =
                IIrm(marketParams.irm).borrowRateView(marketParams, marketState);
            uint256 interest =
                _wMulDown(totalBorrowAssets, _wTaylorCompounded(borrowRate, elapsed));
            totalBorrowAssets += interest;
        }

        return _toAssetsUp(borrowShares, totalBorrowAssets, uint256(marketState.totalBorrowShares));
    }

    function _toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return _mulDivUp(shares, totalAssets + 1, totalShares + 1e6);
    }

    function _wMulDown(uint256 x, uint256 y) internal pure returns (uint256) {
        return _mulDivDown(x, y, WAD);
    }

    function _wDivDown(uint256 x, uint256 y) internal pure returns (uint256) {
        return _mulDivDown(x, WAD, y);
    }

    function _mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y) / d;
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y + (d - 1)) / d;
    }

    function _wTaylorCompounded(uint256 x, uint256 n) internal pure returns (uint256) {
        uint256 firstTerm = x * n;
        uint256 secondTerm = _mulDivDown(firstTerm, firstTerm, 2 * WAD);
        uint256 thirdTerm = _mulDivDown(secondTerm, firstTerm, 3 * WAD);
        return firstTerm + secondTerm + thirdTerm;
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
