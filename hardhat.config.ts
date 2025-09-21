import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-verify";
import "@matterlabs/hardhat-zksync-node";

const config: HardhatUserConfig = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 20_000 } } },
  zksolc: {
    version: "1.5.15",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      enableEraVMExtensions: true,
      codegen:  "yul"
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      zksync: false,
    },
    abstractTestnet: {
      url: "https://api.testnet.abs.xyz",
      ethNetwork: "sepolia",
      zksync: true,
      chainId: 11124,
    },
    mainnet: {
      url: "https://api.mainnet.abs.xyz",
      ethNetwork: "mainnet",
      zksync: true,
      chainId: 2741,
    },
  },
  etherscan: {
    // apiKey: "Q7VEE9P3WYCFV24QZ55R9UYCWQ56EKAKGR",
    apiKey: "TACK2D1RGYX9U7MC31SZWWQ7FCWRYQ96AD",
    // {
    //   // abstractTestnet: "TACK2D1RGYX9U7MC31SZWWQ7FCWRYQ96AD",
    //   "abstractMainnet": "Q7VEE9P3WYCFV24QZ55R9UYCWQ56EKAKGR",
    // },
    customChains: [
      {
        network: "abstractTestnet",
        chainId: 11124,
        urls: {
          apiURL: "https://api-sepolia.abscan.org/api",
          browserURL: "https://sepolia.abscan.org/",
        },
      },
      {
        network: "mainnet",
        chainId: 2741,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=2741",
          browserURL: "https://abscan.org/",
        },
      },
    ],
  },
};
export default config;