// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Script} from "forge-std/Script.sol";
import {MorphoAtomicRescueV1, IMorpho} from "../src/MorphoAtomicRescueV1.sol";

contract DeployMorphoAtomicRescueV1 is Script {
    function run() external {
        address owner = vm.envAddress("RESCUE_OWNER");
        address morphoBlue = vm.envOr("MORPHO_BLUE", address(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb));
        address loanToken = vm.envAddress("MORPHO_LOAN_TOKEN");
        address collateralToken = vm.envAddress("MORPHO_COLLATERAL_TOKEN");
        address oracle = vm.envAddress("MORPHO_ORACLE");
        address irm = vm.envAddress("MORPHO_IRM");
        uint256 lltv = vm.envUint("MORPHO_LLTV");

        vm.startBroadcast();

        MorphoAtomicRescueV1 rescue = new MorphoAtomicRescueV1(owner, morphoBlue);
        rescue.setSupportedMarket(
            IMorpho.MarketParams({
                loanToken: loanToken,
                collateralToken: collateralToken,
                oracle: oracle,
                irm: irm,
                lltv: lltv
            }),
            true
        );

        vm.stopBroadcast();
    }
}
