// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Script} from "forge-std/Script.sol";
import {MorphoVaultWithdrawV1} from "../src/MorphoVaultWithdrawV1.sol";

contract DeployMorphoVaultWithdrawV1 is Script {
    error NoVaultsConfigured();
    error InvalidVaultAddress();

    function run() external {
        address owner = vm.envAddress("RESCUE_OWNER");
        address initialOwner = vm.envOr("INITIAL_OWNER", owner);
        address executor = vm.envOr("RESCUE_EXECUTOR", initialOwner);
        address[] memory vaults = _configuredVaults();

        if (vaults.length == 0) revert NoVaultsConfigured();

        vm.startBroadcast();

        MorphoVaultWithdrawV1 helper = new MorphoVaultWithdrawV1(initialOwner, executor);
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] == address(0)) revert InvalidVaultAddress();
            helper.setSupportedVault(vaults[i], true);
        }
        if (initialOwner != owner) {
            helper.setOwner(owner);
        }

        vm.stopBroadcast();
    }

    function _configuredVaults() private view returns (address[] memory) {
        if (vm.envExists("MORPHO_VAULTS")) {
            return vm.envAddress("MORPHO_VAULTS", ",");
        }

        address[] memory vaults = new address[](1);
        vaults[0] = vm.envAddress("MORPHO_VAULT");
        return vaults;
    }
}
