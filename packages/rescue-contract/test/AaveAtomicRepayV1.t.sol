// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {AaveAtomicRepayV1} from "../src/AaveAtomicRepayV1.sol";

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

contract MockPool {
    struct AccountData {
        uint256 totalCollateralBase;
        uint256 totalDebtBase;
        uint256 availableBorrowsBase;
        uint256 currentLiquidationThreshold;
        uint256 ltv;
        uint256 healthFactor;
    }

    mapping(address => AccountData) public accountData;

    function setUserAccountData(address user, AccountData memory data) external {
        accountData[user] = data;
    }

    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        AccountData memory data = accountData[user];
        return (
            data.totalCollateralBase,
            data.totalDebtBase,
            data.availableBorrowsBase,
            data.currentLiquidationThreshold,
            data.ltv,
            data.healthFactor
        );
    }

    function repay(address, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        AccountData storage data = accountData[onBehalfOf];
        // Simplified: reduce debt and increase HF proportionally
        uint256 reduction = amount / 100; // test-only simplified conversion
        if (reduction > data.totalDebtBase) {
            data.totalDebtBase = 0;
        } else {
            data.totalDebtBase -= reduction;
        }
        // Recalculate HF: (collateral * lt / 10000) * 1e18 / debt
        if (data.totalDebtBase == 0) {
            data.healthFactor = type(uint256).max;
        } else {
            data.healthFactor = (
                data.totalCollateralBase * data.currentLiquidationThreshold * 1e18
            ) / (data.totalDebtBase * 10_000);
        }
        return amount;
    }
}

contract MockAddressesProvider {
    address public oracle;

    constructor(address oracle_) {
        oracle = oracle_;
    }

    function getPriceOracle() external view returns (address) {
        return oracle;
    }
}

contract MockOracle {
    uint256 public price;

    constructor(uint256 price_) {
        price = price_;
    }

    function getAssetPrice(address) external view returns (uint256) {
        return price;
    }
}

contract AaveAtomicRepayV1Test is Test {
    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal attacker = makeAddr("attacker");

    MockToken internal token;
    MockPool internal pool;
    MockOracle internal oracle;
    MockAddressesProvider internal addressesProvider;
    AaveAtomicRepayV1 internal rescue;

    function setUp() external {
        token = new MockToken();
        pool = new MockPool();
        oracle = new MockOracle(100_000_000); // 1.0 in base (8-decimal oracle)
        addressesProvider = new MockAddressesProvider(address(oracle));

        rescue = new AaveAtomicRepayV1(owner, executor, address(pool), address(addressesProvider));

        vm.prank(owner);
        rescue.setSupportedAsset(address(token), true);

        token.mint(owner, 1_000_000_000); // 1000 USDC
        vm.prank(owner);
        token.approve(address(rescue), type(uint256).max);

        // collateral=1_000_000, debt=750_000, lt=7500 → HF = (1_000_000 * 7500) / (750_000 * 10000) = 1.0
        // We set HF=1.2e18 for a slightly healthier starting point
        pool.setUserAccountData(
            owner,
            MockPool.AccountData({
                totalCollateralBase: 1_000_000,
                totalDebtBase: 750_000,
                availableBorrowsBase: 0,
                currentLiquidationThreshold: 7_500,
                ltv: 7_000,
                healthFactor: 1.2e18
            })
        );
    }

    function test_executor_only() external {
        AaveAtomicRepayV1.RescueParams memory params = AaveAtomicRepayV1.RescueParams({
            user: owner,
            asset: address(token),
            amount: 10_000_000,
            minResultingHf: 1.1e18,
            deadline: block.timestamp + 1
        });

        vm.prank(attacker);
        vm.expectRevert(AaveAtomicRepayV1.NotExecutor.selector);
        rescue.rescue(params);
    }

    function test_reverts_if_user_not_owner() external {
        AaveAtomicRepayV1.RescueParams memory params = AaveAtomicRepayV1.RescueParams({
            user: attacker,
            asset: address(token),
            amount: 10_000_000,
            minResultingHf: 1.1e18,
            deadline: block.timestamp + 1
        });

        vm.prank(executor);
        vm.expectRevert(AaveAtomicRepayV1.UserNotOwner.selector);
        rescue.rescue(params);
    }

    function test_reverts_if_deadline_expired() external {
        AaveAtomicRepayV1.RescueParams memory params = AaveAtomicRepayV1.RescueParams({
            user: owner,
            asset: address(token),
            amount: 10_000_000,
            minResultingHf: 1.1e18,
            deadline: block.timestamp - 1
        });

        vm.prank(executor);
        vm.expectRevert(AaveAtomicRepayV1.DeadlineExpired.selector);
        rescue.rescue(params);
    }

    function test_executes_rescue_and_reduces_debt() external {
        AaveAtomicRepayV1.RescueParams memory params = AaveAtomicRepayV1.RescueParams({
            user: owner,
            asset: address(token),
            amount: 10_000_000, // 10 USDC
            minResultingHf: 1.1e18,
            deadline: block.timestamp + 10
        });

        vm.prank(executor);
        rescue.rescue(params);

        (, uint256 debtAfter, , , , uint256 hfAfter) = pool.getUserAccountData(owner);
        assertLt(debtAfter, 750_000);
        assertGe(hfAfter, 1.1e18);
    }

    function test_reverts_if_resulting_hf_too_low() external {
        AaveAtomicRepayV1.RescueParams memory params = AaveAtomicRepayV1.RescueParams({
            user: owner,
            asset: address(token),
            amount: 100, // tiny repay, won't move HF much
            minResultingHf: 5.0e18,
            deadline: block.timestamp + 10
        });

        vm.prank(executor);
        vm.expectRevert(); // ResultingHFTooLow
        rescue.rescue(params);
    }

    function test_reverts_if_asset_not_supported() external {
        MockToken unsupported = new MockToken();
        unsupported.mint(owner, 1_000_000_000);
        vm.prank(owner);
        unsupported.approve(address(rescue), type(uint256).max);

        AaveAtomicRepayV1.RescueParams memory params = AaveAtomicRepayV1.RescueParams({
            user: owner,
            asset: address(unsupported),
            amount: 10_000_000,
            minResultingHf: 1.1e18,
            deadline: block.timestamp + 10
        });

        vm.prank(executor);
        vm.expectRevert(AaveAtomicRepayV1.AssetNotSupported.selector);
        rescue.rescue(params);
    }

    function test_preview_increases_with_repay_amount() external view {
        uint256 hf0 = rescue.previewResultingHf(owner, address(token), 0);
        uint256 hf1 = rescue.previewResultingHf(owner, address(token), 10_000_000);
        assertGt(hf1, hf0);
    }

    function test_preview_returns_max_when_debt_fully_repaid() external view {
        // Repay enough to wipe all debt: 750_000 debt base, oracle price 100_000_000 (1e8),
        // 6 decimals → repayValueBase = amount * 1e8 / 1e6 = amount * 100
        // Need repayValueBase >= 750_000 → amount >= 7_500
        uint256 hf = rescue.previewResultingHf(owner, address(token), 10_000_000);
        assertEq(hf, type(uint256).max);
    }

    function test_owner_can_update_executor() external {
        address newExecutor = makeAddr("newExecutor");

        vm.prank(owner);
        rescue.setExecutor(newExecutor);

        assertEq(rescue.executor(), newExecutor);
    }

    function test_non_owner_cannot_set_executor() external {
        vm.prank(attacker);
        vm.expectRevert(AaveAtomicRepayV1.NotOwner.selector);
        rescue.setExecutor(attacker);
    }
}
