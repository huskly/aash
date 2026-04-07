// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {MorphoAtomicRepayV1, IMorpho} from "../src/MorphoAtomicRepayV1.sol";

contract MockToken {
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockMorphoOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }
}

contract MockMorphoIrm {
    function borrowRateView(IMorpho.MarketParams memory, IMorpho.Market memory)
        external
        pure
        returns (uint256)
    {
        return 0;
    }
}

contract MockMorpho {
    struct PositionData {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    struct MarketData {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }

    mapping(bytes32 => mapping(address => PositionData)) public positionData;
    mapping(bytes32 => MarketData) public marketData;

    function setPosition(bytes32 id, address user, PositionData memory data) external {
        positionData[id][user] = data;
    }

    function setMarket(bytes32 id, MarketData memory data) external {
        marketData[id] = data;
    }

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)
    {
        PositionData memory data = positionData[id][user];
        return (data.supplyShares, data.borrowShares, data.collateral);
    }

    function market(bytes32 id)
        external
        view
        returns (uint128, uint128, uint128, uint128, uint128, uint128)
    {
        MarketData memory data = marketData[id];
        return (
            data.totalSupplyAssets,
            data.totalSupplyShares,
            data.totalBorrowAssets,
            data.totalBorrowShares,
            data.lastUpdate,
            data.fee
        );
    }

    function repay(
        IMorpho.MarketParams calldata marketParams,
        uint256 assets,
        uint256,
        address onBehalf,
        bytes calldata
    ) external returns (uint256, uint256) {
        bytes32 id = keccak256(abi.encode(marketParams));
        PositionData storage pos = positionData[id][onBehalf];
        MarketData storage mkt = marketData[id];

        uint256 sharesToReduce =
            (uint256(pos.borrowShares) * assets) / uint256(mkt.totalBorrowAssets);
        if (sharesToReduce > uint256(pos.borrowShares)) {
            sharesToReduce = uint256(pos.borrowShares);
        }
        pos.borrowShares -= uint128(sharesToReduce);
        mkt.totalBorrowAssets -= uint128(assets);
        mkt.totalBorrowShares -= uint128(sharesToReduce);

        return (assets, sharesToReduce);
    }
}

contract MorphoAtomicRepayV1Test is Test {
    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");

    MockToken internal loanToken;
    MockToken internal collateralToken;
    MockMorphoOracle internal oracle;
    MockMorphoIrm internal irm;
    MockMorpho internal morpho;
    MorphoAtomicRepayV1 internal rescue;

    IMorpho.MarketParams internal marketParams;
    bytes32 internal marketId;

    function setUp() external {
        loanToken = new MockToken();
        collateralToken = new MockToken();
        oracle = new MockMorphoOracle(1e36); // 1:1 price
        irm = new MockMorphoIrm();
        morpho = new MockMorpho();

        rescue = new MorphoAtomicRepayV1(owner, address(morpho));

        marketParams = IMorpho.MarketParams({
            loanToken: address(loanToken),
            collateralToken: address(collateralToken),
            oracle: address(oracle),
            irm: address(irm),
            lltv: 0.85e18
        });

        marketId = keccak256(abi.encode(marketParams));

        vm.prank(owner);
        rescue.setSupportedMarket(marketParams, true);

        loanToken.mint(owner, 1_000_000_000);
        vm.prank(owner);
        loanToken.approve(address(rescue), type(uint256).max);

        morpho.setPosition(
            marketId,
            owner,
            MockMorpho.PositionData({supplyShares: 0, borrowShares: 70_000_000, collateral: 100_000_000})
        );

        morpho.setMarket(
            marketId,
            MockMorpho.MarketData({
                totalSupplyAssets: 200_000_000,
                totalSupplyShares: 200_000_000,
                totalBorrowAssets: 70_000_000,
                totalBorrowShares: 70_000_000,
                lastUpdate: uint128(block.timestamp),
                fee: 0
            })
        );
    }

    function test_owner_only() external {
        MorphoAtomicRepayV1.RescueParams memory params = MorphoAtomicRepayV1.RescueParams({
            user: owner,
            marketParams: marketParams,
            amount: 10_000_000,
            minResultingHF: 1.0e18,
            deadline: block.timestamp + 1
        });

        vm.prank(attacker);
        vm.expectRevert(MorphoAtomicRepayV1.NotOwner.selector);
        rescue.rescue(params);
    }

    function test_reverts_if_user_not_owner() external {
        MorphoAtomicRepayV1.RescueParams memory params = MorphoAtomicRepayV1.RescueParams({
            user: attacker,
            marketParams: marketParams,
            amount: 10_000_000,
            minResultingHF: 1.0e18,
            deadline: block.timestamp + 1
        });

        vm.prank(owner);
        vm.expectRevert(MorphoAtomicRepayV1.UserNotOwner.selector);
        rescue.rescue(params);
    }

    function test_reverts_if_deadline_expired() external {
        MorphoAtomicRepayV1.RescueParams memory params = MorphoAtomicRepayV1.RescueParams({
            user: owner,
            marketParams: marketParams,
            amount: 10_000_000,
            minResultingHF: 1.0e18,
            deadline: block.timestamp - 1
        });

        vm.prank(owner);
        vm.expectRevert(MorphoAtomicRepayV1.DeadlineExpired.selector);
        rescue.rescue(params);
    }

    function test_executes_rescue_and_reduces_debt() external {
        MorphoAtomicRepayV1.RescueParams memory params = MorphoAtomicRepayV1.RescueParams({
            user: owner,
            marketParams: marketParams,
            amount: 10_000_000,
            minResultingHF: 1.0e18,
            deadline: block.timestamp + 10
        });

        vm.prank(owner);
        rescue.rescue(params);

        (, uint128 borrowSharesAfter,) = morpho.position(marketId, owner);
        assertLt(uint256(borrowSharesAfter), 70_000_000);
    }

    function test_preview_increases_with_repay_amount() external view {
        uint256 hf0 = rescue.previewResultingHF(marketParams, owner, 0);
        uint256 hf1 = rescue.previewResultingHF(marketParams, owner, 10_000_000);
        assertGt(hf1, hf0);
    }

    function test_preview_returns_max_when_debt_fully_repaid() external view {
        uint256 hf = rescue.previewResultingHF(marketParams, owner, 70_000_000);
        assertEq(hf, type(uint256).max);
    }
}
