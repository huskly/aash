// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {MorphoAtomicRescueV1, IMorpho} from "../src/MorphoAtomicRescueV1.sol";

contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 8;

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

    function setPrice(uint256 price_) external {
        price = price_;
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

    mapping(bytes32 => mapping(address => PositionData)) public positions;
    mapping(bytes32 => MarketData) public markets;
    // Track supply calls for test assertions
    uint256 public lastSupplyAmount;
    address public lastSupplyOnBehalf;

    function setPosition(bytes32 id, address user, PositionData memory data) external {
        positions[id][user] = data;
    }

    function setMarket(bytes32 id, MarketData memory data) external {
        markets[id] = data;
    }

    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)
    {
        PositionData memory p = positions[id][user];
        return (p.supplyShares, p.borrowShares, p.collateral);
    }

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
        )
    {
        MarketData memory m = markets[id];
        return (
            m.totalSupplyAssets,
            m.totalSupplyShares,
            m.totalBorrowAssets,
            m.totalBorrowShares,
            m.lastUpdate,
            m.fee
        );
    }

    function supplyCollateral(
        IMorpho.MarketParams calldata,
        uint256 assets,
        address onBehalf,
        bytes calldata
    ) external {
        lastSupplyAmount = assets;
        lastSupplyOnBehalf = onBehalf;

        // The test setUp pre-configures the post-rescue position state directly
        // since MockMorpho can't easily hash calldata params.
    }
}

contract MorphoAtomicRescueV1Test is Test {
    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");

    MockToken internal collateralToken;
    MockToken internal loanToken;
    MockMorpho internal mockMorpho;
    MockMorphoOracle internal mockOracle;
    MorphoAtomicRescueV1 internal rescue;

    IMorpho.MarketParams internal marketParams;
    bytes32 internal marketId;

    function setUp() external {
        collateralToken = new MockToken();
        loanToken = new MockToken();
        mockMorpho = new MockMorpho();
        // Oracle price: 1 collateral = 30000 loan tokens (e.g., WBTC/USDC), scaled to 1e36
        // For 8-decimal collateral and 6-decimal loan: price = 30000 * 1e36 * 1e6 / 1e8 = 30000e34
        // Actually, Morpho oracle price is: price of 1 unit of collateral (in loan token base units)
        // scaled by 1e36. So for WBTC ($30k) collateral and USDC ($1) loan:
        // price = 30000 * 10^6 / 10^8 * 10^36 = 30000 * 10^34 = 3e38
        mockOracle = new MockMorphoOracle(3e38);

        marketParams = IMorpho.MarketParams({
            loanToken: address(loanToken),
            collateralToken: address(collateralToken),
            oracle: address(mockOracle),
            irm: address(0x1), // dummy IRM
            lltv: 0.86e18 // 86% LLTV
        });

        marketId = keccak256(abi.encode(marketParams));

        rescue = new MorphoAtomicRescueV1(owner, address(mockMorpho));

        vm.prank(owner);
        rescue.setSupportedMarket(marketParams, true);

        // Give user collateral tokens and approve rescue contract
        collateralToken.mint(user, 100e8); // 100 WBTC
        vm.prank(user);
        collateralToken.approve(address(rescue), type(uint256).max);

        // Set up a position: 1 WBTC collateral, 20000 USDC borrow
        // HF = 1e8 * 3e38 * 0.86e18 / (20000e6 * 1e36) = 2.58e64 / 2e46 = 1.29e18
        mockMorpho.setPosition(
            marketId,
            user,
            MockMorpho.PositionData({
                supplyShares: 0,
                borrowShares: 20000e6, // 1:1 with assets for simplicity
                collateral: 1e8 // 1 WBTC (8 decimals)
            })
        );

        mockMorpho.setMarket(
            marketId,
            MockMorpho.MarketData({
                totalSupplyAssets: 1000000e6,
                totalSupplyShares: 1000000e6,
                totalBorrowAssets: 500000e6,
                totalBorrowShares: 500000e6, // 1:1 ratio
                lastUpdate: uint128(block.timestamp),
                fee: 0
            })
        );
    }

    function test_owner_only() external {
        MorphoAtomicRescueV1.RescueParams memory params = MorphoAtomicRescueV1.RescueParams({
            user: user,
            marketParams: marketParams,
            amount: 1e8,
            minResultingHF: 1.1e18,
            deadline: block.timestamp + 1
        });

        vm.prank(user);
        vm.expectRevert(MorphoAtomicRescueV1.NotOwner.selector);
        rescue.rescue(params);
    }

    function test_reverts_if_deadline_expired() external {
        MorphoAtomicRescueV1.RescueParams memory params = MorphoAtomicRescueV1.RescueParams({
            user: user,
            marketParams: marketParams,
            amount: 1e8,
            minResultingHF: 1.1e18,
            deadline: block.timestamp - 1
        });

        vm.prank(owner);
        vm.expectRevert(MorphoAtomicRescueV1.DeadlineExpired.selector);
        rescue.rescue(params);
    }

    function test_executes_rescue_when_result_hf_is_sufficient() external {
        // After rescue, simulate that collateral increased by updating position
        // Pre-rescue HF with 1 WBTC: ~1.29
        // After adding 0.5 WBTC (total 1.5 WBTC):
        // HF = 1.5e8 * 3e38 * 0.86e18 / (20000e6 * 1e36) = 1.935e18
        // Update the position to reflect post-supply state
        mockMorpho.setPosition(
            marketId,
            user,
            MockMorpho.PositionData({
                supplyShares: 0,
                borrowShares: 20000e6,
                collateral: 1.5e8 // 1.5 WBTC after rescue
            })
        );

        MorphoAtomicRescueV1.RescueParams memory params = MorphoAtomicRescueV1.RescueParams({
            user: user,
            marketParams: marketParams,
            amount: 0.5e8,
            minResultingHF: 1.9e18,
            deadline: block.timestamp + 10
        });

        vm.prank(owner);
        rescue.rescue(params);

        // Verify token was transferred
        assertEq(mockMorpho.lastSupplyAmount(), 0.5e8);
        assertEq(mockMorpho.lastSupplyOnBehalf(), user);
    }

    function test_reverts_if_resulting_hf_too_low() external {
        // Don't update the position — HF stays at ~1.29 after "rescue"
        // (mock doesn't actually change state on supplyCollateral)
        MorphoAtomicRescueV1.RescueParams memory params = MorphoAtomicRescueV1.RescueParams({
            user: user,
            marketParams: marketParams,
            amount: 0.1e8,
            minResultingHF: 2.0e18,
            deadline: block.timestamp + 10
        });

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MorphoAtomicRescueV1.ResultingHFTooLow.selector, 1.29e18, 2.0e18)
        );
        rescue.rescue(params);
    }

    function test_reverts_if_market_not_supported() external {
        IMorpho.MarketParams memory unsupportedMarket = IMorpho.MarketParams({
            loanToken: address(loanToken),
            collateralToken: address(collateralToken),
            oracle: address(mockOracle),
            irm: address(0x2), // different IRM
            lltv: 0.90e18
        });

        MorphoAtomicRescueV1.RescueParams memory params = MorphoAtomicRescueV1.RescueParams({
            user: user,
            marketParams: unsupportedMarket,
            amount: 1e8,
            minResultingHF: 1.1e18,
            deadline: block.timestamp + 10
        });

        vm.prank(owner);
        vm.expectRevert(MorphoAtomicRescueV1.MarketNotSupported.selector);
        rescue.rescue(params);
    }

    function test_preview_increases_with_amount() external view {
        uint256 hf0 = rescue.previewResultingHF(marketParams, user, 0);
        uint256 hf1 = rescue.previewResultingHF(marketParams, user, 1e8);
        assertGt(hf1, hf0);
    }

    function test_preview_returns_max_when_no_debt() external {
        // Create a position with no borrow
        mockMorpho.setPosition(
            marketId,
            user,
            MockMorpho.PositionData({
                supplyShares: 0,
                borrowShares: 0,
                collateral: 1e8
            })
        );

        uint256 hf = rescue.previewResultingHF(marketParams, user, 0);
        assertEq(hf, type(uint256).max);
    }

    function test_preview_math_correctness() external view {
        // 1 WBTC collateral (1e8), 20000 USDC borrow (20000e6)
        // Oracle: 3e38 (1 WBTC = 30000 USDC in oracle terms)
        // LLTV: 0.86e18
        // HF = 1e8 * 3e38 * 0.86e18 / (20000e6 * 1e36)
        //    = 2.58e64 / 2e46 = 1.29e18
        uint256 hf = rescue.previewResultingHF(marketParams, user, 0);
        assertEq(hf, 1.29e18);
    }

    function test_preview_with_additional_collateral() external view {
        // Adding 1 WBTC (total 2 WBTC):
        // HF = 2e8 * 3e38 * 0.86e18 / (20000e6 * 1e36)
        //    = 5.16e64 / 2e46 = 2.58e18
        uint256 hf = rescue.previewResultingHF(marketParams, user, 1e8);
        assertEq(hf, 2.58e18);
    }
}
