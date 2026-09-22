# Treasury Vault Deployment Guide: Safe Singleton Pattern

## Overview

This guide provides step-by-step instructions for deploying the TreasuryVault and MarketVault contracts using the Safe Singleton Factory pattern on Linux CLI. This method ensures deterministic addresses across multiple EVM-compatible chains.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Setup](#environment-setup)
- [Understanding Safe Singleton Factory](#understanding-safe-singleton-factory)
- [Deployment Process](#deployment-process)
  - [Step 1: Prepare Environment](#step-1-prepare-environment)
  - [Step 2: Compile Contracts](#step-2-compile-contracts)
  - [Step 3: Compute Deterministic Addresses](#step-3-compute-deterministic-addresses)
  - [Step 4: Deploy Implementation Contracts](#step-4-deploy-implementation-contracts)
  - [Step 5: Deploy Vault Instances](#step-5-deploy-vault-instances)
  - [Step 6: Initialize Vaults](#step-6-initialize-vaults)
  - [Step 7: Configure Vault Settings](#step-7-configure-vault-settings)
  - [Step 8: Verify Deployments](#step-8-verify-deployments)
- [Multi-Chain Deployment](#multi-chain-deployment)
- [Security Checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software

1. **Node.js** (v18 or higher)
   ```bash
   node --version  # Should be >= 18.0.0
   ```

2. **npm** or **yarn**
   ```bash
   npm --version   # or yarn --version
   ```

3. **Git**
   ```bash
   git --version
   ```

4. **Hardhat** (will be installed via npm)

### Required Access

- Private key with sufficient the chain native token for deployment gas
- RPC endpoint for target network(s)
- Block explorer API key (optional, for verification)

### Network Requirements

The target network must support:
- CREATE2 opcode (post-Constantinople upgrade)
- Safe Singleton Factory deployment at `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`

---

## Environment Setup

### 1. Clone Repository

```bash
# Clone the repository
git clone https://github.com/chippr-robotics/fairwins-platform.git
cd fairwins-platform

# Install dependencies
npm install

# Verify installation
npx hardhat --version
```

### 2. Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Create .env file
cat > .env << 'EOF'
# Network RPC URLs
ETHEREUM_RPC=https://mainnet.infura.io/v3/YOUR_INFURA_KEY
AMOY_RPC=https://rpc-amoy.polygon.technology
POLYGON_RPC=https://polygon-rpc.com
ARBITRUM_RPC=https://arb1.arbitrum.io/rpc
OPTIMISM_RPC=https://mainnet.optimism.io

# Deployer private key (NEVER commit this!)
DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Block explorer API keys (for verification)
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY
POLYGONSCAN_API_KEY=YOUR_POLYGONSCAN_API_KEY

# Safe Singleton Factory address (same across all chains)
SINGLETON_FACTORY=0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7

# Salt prefix for deterministic deployments
SALT_PREFIX=PredictionDAO.Vaults.v1
EOF

# Secure the .env file
chmod 600 .env

# Verify it's in .gitignore
grep -q "^\.env$" .gitignore || echo ".env" >> .gitignore
```

### 3. Verify Network Configuration

Check if Safe Singleton Factory is deployed on your target network:

```bash
# Create a verification script
cat > scripts/check-factory.js << 'EOF'
const { ethers } = require("hardhat");

const FACTORY_ADDRESS = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";

async function main() {
    const provider = ethers.provider;
    const network = await provider.getNetwork();
    
    console.log(`\nChecking network: ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`Factory address: ${FACTORY_ADDRESS}`);
    
    const code = await provider.getCode(FACTORY_ADDRESS);
    
    if (code === "0x") {
        console.log("❌ Safe Singleton Factory NOT deployed on this network");
        console.log("\nYou need to deploy it first using the Safe Factory deployment transaction.");
        console.log("See: https://github.com/safe-global/safe-singleton-factory");
        process.exit(1);
    } else {
        console.log("✅ Safe Singleton Factory is deployed");
        console.log(`   Bytecode length: ${code.length} bytes`);
        
        // Check if we can call it
        const factory = await ethers.getContractAt(
            ["function deploy(bytes memory _initCode, bytes32 _salt) public returns (address)"],
            FACTORY_ADDRESS
        );
        console.log("✅ Factory interface accessible");
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

# Run the check
npx hardhat run scripts/check-factory.js --network amoy
```

---

## Understanding Safe Singleton Factory

### What is Safe Singleton Factory?

The Safe Singleton Factory is a contract deployed at the same address across multiple chains that uses CREATE2 to deploy contracts at deterministic addresses.

**Key Properties:**
- **Factory Address**: `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` (same on all chains)
- **Deployment Method**: CREATE2 opcode
- **Address Formula**: `keccak256(0xff ++ factoryAddress ++ salt ++ keccak256(initCode))`

### Benefits

1. **Cross-chain consistency**: Same contract address on all supported chains
2. **Transparency**: Anyone can verify the deployment
3. **No key management**: Doesn't depend on specific deployer key
4. **Immutability**: Once deployed, address cannot change

---

## Deployment Process

### Step 1: Prepare Environment

Ensure you have sufficient balance for gas costs:

```bash
# Check deployer balance
cat > scripts/check-balance.js << 'EOF'
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);
    const network = await ethers.provider.getNetwork();
    
    console.log(`\nNetwork: ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
    
    const estimatedGas = ethers.parseEther("0.1"); // Rough estimate
    if (balance < estimatedGas) {
        console.log(`\n⚠️  Warning: Balance may be insufficient for deployment`);
        console.log(`   Estimated needed: ${ethers.formatEther(estimatedGas)} ETH`);
    } else {
        console.log(`\n✅ Balance sufficient for deployment`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

npx hardhat run scripts/check-balance.js --network amoy
```

### Step 2: Compile Contracts

```bash
# Clean previous builds
npx hardhat clean

# Compile contracts
npx hardhat compile

# Verify compilation succeeded
if [ -d "artifacts/contracts/TreasuryVault.sol" ]; then
    echo "✅ TreasuryVault compiled successfully"
else
    echo "❌ TreasuryVault compilation failed"
    exit 1
fi

if [ -d "artifacts/contracts/MarketVault.sol" ]; then
    echo "✅ MarketVault compiled successfully"
else
    echo "❌ MarketVault compilation failed"
    exit 1
fi

# Check artifact sizes
echo ""
echo "Contract sizes:"
ls -lh artifacts/contracts/TreasuryVault.sol/TreasuryVault.json
ls -lh artifacts/contracts/MarketVault.sol/MarketVault.json
```

### Step 3: Compute Deterministic Addresses

Create a script to pre-compute all deployment addresses:

```bash
cat > scripts/compute-addresses.js << 'EOF'
const { ethers } = require("hardhat");

const SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const SALT_PREFIX = process.env.SALT_PREFIX || "PredictionDAO.Vaults.v1";

async function computeCreate2Address(initCode, saltString) {
    const salt = ethers.id(saltString);
    const initCodeHash = ethers.keccak256(initCode);
    
    const address = ethers.getCreate2Address(
        SINGLETON_FACTORY,
        salt,
        initCodeHash
    );
    
    return { address, salt, initCodeHash };
}

async function main() {
    console.log("\n" + "=".repeat(70));
    console.log("COMPUTING DETERMINISTIC ADDRESSES");
    console.log("=".repeat(70));
    
    console.log(`\nFactory: ${SINGLETON_FACTORY}`);
    console.log(`Salt Prefix: ${SALT_PREFIX}`);
    
    // Get contract factories
    const TreasuryVault = await ethers.getContractFactory("TreasuryVault");
    const MarketVault = await ethers.getContractFactory("MarketVault");
    
    // Compute TreasuryVault implementation address
    const treasuryInitCode = TreasuryVault.bytecode;
    const treasurySalt = `${SALT_PREFIX}.TreasuryVault.Implementation`;
    const treasuryResult = await computeCreate2Address(treasuryInitCode, treasurySalt);
    
    console.log("\n--- TreasuryVault Implementation ---");
    console.log(`Address: ${treasuryResult.address}`);
    console.log(`Salt: ${treasuryResult.salt}`);
    console.log(`Init Code Hash: ${treasuryResult.initCodeHash}`);
    
    // Compute MarketVault implementation address
    const marketInitCode = MarketVault.bytecode;
    const marketSalt = `${SALT_PREFIX}.MarketVault.Implementation`;
    const marketResult = await computeCreate2Address(marketInitCode, marketSalt);
    
    console.log("\n--- MarketVault Implementation ---");
    console.log(`Address: ${marketResult.address}`);
    console.log(`Salt: ${marketResult.salt}`);
    console.log(`Init Code Hash: ${marketResult.initCodeHash}`);
    
    // Save to file
    const addresses = {
        factory: SINGLETON_FACTORY,
        saltPrefix: SALT_PREFIX,
        treasuryVault: {
            implementation: treasuryResult.address,
            salt: treasuryResult.salt,
            initCodeHash: treasuryResult.initCodeHash
        },
        marketVault: {
            implementation: marketResult.address,
            salt: marketResult.salt,
            initCodeHash: marketResult.initCodeHash
        }
    };
    
    const fs = require('fs');
    fs.writeFileSync(
        'deployment-addresses.json',
        JSON.stringify(addresses, null, 2)
    );
    
    console.log("\n✅ Addresses saved to deployment-addresses.json");
    console.log("=".repeat(70) + "\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

# Run the script
npx hardhat run scripts/compute-addresses.js

# Display the addresses
cat deployment-addresses.json | jq '.'
```

### Step 4: Deploy Implementation Contracts

Create the main deployment script:

```bash
cat > scripts/deploy-vaults.js << 'EOF'
const { ethers } = require("hardhat");
const fs = require('fs');

const SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7";
const SALT_PREFIX = process.env.SALT_PREFIX || "PredictionDAO.Vaults.v1";

async function deployWithFactory(contractName, saltString) {
    console.log(`\n--- Deploying ${contractName} ---`);
    
    const Contract = await ethers.getContractFactory(contractName);
    const initCode = Contract.bytecode;
    const salt = ethers.id(saltString);
    
    // Compute expected address
    const expectedAddress = ethers.getCreate2Address(
        SINGLETON_FACTORY,
        salt,
        ethers.keccak256(initCode)
    );
    
    console.log(`Expected address: ${expectedAddress}`);
    
    // Check if already deployed
    const existingCode = await ethers.provider.getCode(expectedAddress);
    if (existingCode !== "0x") {
        console.log(`✅ Already deployed at ${expectedAddress}`);
        return expectedAddress;
    }
    
    // Deploy via factory
    console.log(`Deploying via Safe Singleton Factory...`);
    const factory = await ethers.getContractAt(
        ["function deploy(bytes memory _initCode, bytes32 _salt) public returns (address)"],
        SINGLETON_FACTORY
    );
    
    const tx = await factory.deploy(initCode, salt);
    console.log(`Transaction hash: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`✅ Deployed in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    
    // Verify deployment
    const deployedCode = await ethers.provider.getCode(expectedAddress);
    if (deployedCode === "0x") {
        throw new Error("Deployment failed: no code at expected address");
    }
    
    console.log(`✅ Verified deployment at ${expectedAddress}`);
    return expectedAddress;
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    
    console.log("\n" + "=".repeat(70));
    console.log("VAULT IMPLEMENTATION DEPLOYMENT");
    console.log("=".repeat(70));
    console.log(`\nNetwork: ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Factory: ${SINGLETON_FACTORY}\n`);
    
    const results = {
        network: network.name,
        chainId: Number(network.chainId),
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {}
    };
    
    try {
        // Deploy TreasuryVault implementation
        const treasuryAddress = await deployWithFactory(
            "TreasuryVault",
            `${SALT_PREFIX}.TreasuryVault.Implementation`
        );
        results.contracts.TreasuryVault = {
            implementation: treasuryAddress
        };
        
        // Deploy MarketVault implementation
        const marketAddress = await deployWithFactory(
            "MarketVault",
            `${SALT_PREFIX}.MarketVault.Implementation`
        );
        results.contracts.MarketVault = {
            implementation: marketAddress
        };
        
        // Save deployment results
        const filename = `deployment-${network.name}-${Date.now()}.json`;
        fs.writeFileSync(filename, JSON.stringify(results, null, 2));
        
        console.log("\n" + "=".repeat(70));
        console.log("DEPLOYMENT SUMMARY");
        console.log("=".repeat(70));
        console.log(`\nTreasuryVault: ${treasuryAddress}`);
        console.log(`MarketVault: ${marketAddress}`);
        console.log(`\nResults saved to: ${filename}`);
        console.log("=".repeat(70) + "\n");
        
    } catch (error) {
        console.error("\n❌ Deployment failed:", error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

# Deploy to network
npx hardhat run scripts/deploy-vaults.js --network amoy
```

### Step 5: Deploy Vault Instances

Now deploy actual vault instances (clones or proxies) that users will interact with:

```bash
cat > scripts/deploy-vault-instance.js << 'EOF'
const { ethers } = require("hardhat");
const fs = require('fs');

async function main() {
    const [deployer] = await ethers.getSigners();
    
    // Read implementation addresses
    const deploymentFiles = fs.readdirSync('.')
        .filter(f => f.startsWith('deployment-') && f.endsWith('.json'));
    
    if (deploymentFiles.length === 0) {
        throw new Error("No deployment file found. Run deploy-vaults.js first.");
    }
    
    const latestDeployment = deploymentFiles.sort().reverse()[0];
    const deployment = JSON.parse(fs.readFileSync(latestDeployment));
    
    console.log(`\nUsing deployment: ${latestDeployment}`);
    console.log(`TreasuryVault implementation: ${deployment.contracts.TreasuryVault.implementation}`);
    
    // Deploy a TreasuryVault instance for a DAO
    const TreasuryVault = await ethers.getContractFactory("TreasuryVault");
    const treasuryVault = await TreasuryVault.deploy();
    await treasuryVault.waitForDeployment();
    
    const treasuryAddress = await treasuryVault.getAddress();
    console.log(`\n✅ TreasuryVault instance deployed at: ${treasuryAddress}`);
    
    // Initialize the vault
    const daoOwner = deployer.address; // In production, this would be the DAO address
    const initTx = await treasuryVault.initialize(daoOwner);
    await initTx.wait();
    
    console.log(`✅ TreasuryVault initialized with owner: ${daoOwner}`);
    
    // Save instance info
    const instanceInfo = {
        timestamp: new Date().toISOString(),
        treasuryVault: treasuryAddress,
        owner: daoOwner,
        implementation: deployment.contracts.TreasuryVault.implementation
    };
    
    fs.writeFileSync(
        `vault-instance-${Date.now()}.json`,
        JSON.stringify(instanceInfo, null, 2)
    );
    
    console.log("\n✅ Vault instance deployed and initialized");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

# Deploy vault instance
npx hardhat run scripts/deploy-vault-instance.js --network amoy
```

### Step 6: Initialize Vaults

If you haven't initialized in the previous step:

```bash
cat > scripts/initialize-vault.js << 'EOF'
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    
    // Vault address (update this)
    const VAULT_ADDRESS = process.env.VAULT_ADDRESS || "<VAULT_ADDRESS_HERE>";
    
    if (VAULT_ADDRESS === "<VAULT_ADDRESS_HERE>") {
        throw new Error("Set VAULT_ADDRESS environment variable");
    }
    
    console.log(`\nInitializing vault at: ${VAULT_ADDRESS}`);
    
    const vault = await ethers.getContractAt("TreasuryVault", VAULT_ADDRESS);
    
    // Check if already initialized
    try {
        const owner = await vault.owner();
        console.log(`✅ Vault already initialized with owner: ${owner}`);
        return;
    } catch (error) {
        // Not initialized yet
    }
    
    // Initialize with deployer as owner
    const tx = await vault.initialize(deployer.address);
    console.log(`Transaction hash: ${tx.hash}`);
    
    await tx.wait();
    console.log(`✅ Vault initialized successfully`);
    
    const owner = await vault.owner();
    console.log(`   Owner: ${owner}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

# Initialize (if needed)
VAULT_ADDRESS=0x... npx hardhat run scripts/initialize-vault.js --network amoy
```

### Step 7: Configure Vault Settings

```bash
cat > scripts/configure-vault.js << 'EOF'
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    
    const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
    const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS;
    
    if (!VAULT_ADDRESS || !GOVERNOR_ADDRESS) {
        throw new Error("Set VAULT_ADDRESS and GOVERNOR_ADDRESS environment variables");
    }
    
    console.log(`\nConfiguring vault at: ${VAULT_ADDRESS}`);
    
    const vault = await ethers.getContractAt("TreasuryVault", VAULT_ADDRESS);
    
    // 1. Authorize the governor as a spender
    console.log(`\n1. Authorizing governor: ${GOVERNOR_ADDRESS}`);
    let tx = await vault.authorizeSpender(GOVERNOR_ADDRESS);
    await tx.wait();
    console.log(`   ✅ Governor authorized`);
    
    // 2. Set transaction limit (e.g., max 100 ETH per transaction)
    console.log(`\n2. Setting transaction limit...`);
    tx = await vault.setTransactionLimit(
        ethers.ZeroAddress, // ETH
        ethers.parseEther("100") // 100 ETH
    );
    await tx.wait();
    console.log(`   ✅ Transaction limit set to 100 ETH`);
    
    // 3. Set rate limit (e.g., max 500 ETH per day)
    console.log(`\n3. Setting rate limit...`);
    tx = await vault.setRateLimit(
        ethers.ZeroAddress, // ETH
        24 * 60 * 60, // 1 day in seconds
        ethers.parseEther("500") // 500 ETH
    );
    await tx.wait();
    console.log(`   ✅ Rate limit set to 500 ETH per day`);
    
    // 4. Set guardian (optional)
    if (process.env.GUARDIAN_ADDRESS) {
        console.log(`\n4. Setting guardian: ${process.env.GUARDIAN_ADDRESS}`);
        tx = await vault.updateGuardian(process.env.GUARDIAN_ADDRESS);
        await tx.wait();
        console.log(`   ✅ Guardian set`);
    }
    
    console.log(`\n✅ Vault configuration complete`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

# Configure vault
VAULT_ADDRESS=0x... GOVERNOR_ADDRESS=0x... npx hardhat run scripts/configure-vault.js --network amoy
```

### Step 8: Verify Deployments

```bash
cat > scripts/verify-deployment.js << 'EOF'
const { ethers } = require("hardhat");

async function main() {
    const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
    
    if (!VAULT_ADDRESS) {
        throw new Error("Set VAULT_ADDRESS environment variable");
    }
    
    console.log("\n" + "=".repeat(70));
    console.log("VAULT DEPLOYMENT VERIFICATION");
    console.log("=".repeat(70));
    
    const vault = await ethers.getContractAt("TreasuryVault", VAULT_ADDRESS);
    
    // Check deployment
    const code = await ethers.provider.getCode(VAULT_ADDRESS);
    console.log(`\n✅ Contract deployed at: ${VAULT_ADDRESS}`);
    console.log(`   Bytecode length: ${code.length} bytes`);
    
    // Check initialization
    try {
        const owner = await vault.owner();
        console.log(`\n✅ Vault initialized`);
        console.log(`   Owner: ${owner}`);
        
        const guardian = await vault.guardian();
        console.log(`   Guardian: ${guardian}`);
        
        const paused = await vault.paused();
        console.log(`   Paused: ${paused}`);
        
        // Check limits
        const txLimit = await vault.transactionLimit(ethers.ZeroAddress);
        console.log(`\n💰 Transaction limit (ETH): ${ethers.formatEther(txLimit)} ETH`);
        
        const ratePeriod = await vault.rateLimitPeriod(ethers.ZeroAddress);
        const periodLimit = await vault.periodLimit(ethers.ZeroAddress);
        if (ratePeriod > 0) {
            console.log(`   Rate limit: ${ethers.formatEther(periodLimit)} ETH per ${ratePeriod / 3600} hours`);
        } else {
            console.log(`   Rate limit: Not set`);
        }
        
        // Check balance
        const balance = await ethers.provider.getBalance(VAULT_ADDRESS);
        console.log(`\n💵 Vault balance: ${ethers.formatEther(balance)} ETH`);
        
    } catch (error) {
        console.log(`\n❌ Error checking vault state: ${error.message}`);
    }
    
    console.log("\n" + "=".repeat(70) + "\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF

# Verify deployment
VAULT_ADDRESS=0x... npx hardhat run scripts/verify-deployment.js --network amoy
```

---

## Multi-Chain Deployment

To deploy on multiple chains with the same addresses:

```bash
# Create multi-chain deployment script
cat > scripts/deploy-multi-chain.sh << 'EOF'
#!/bin/bash

# Networks to deploy to
NETWORKS=("ethereum" "amoy" "polygon" "arbitrum" "optimism")

# Track results
SUCCESS=0
FAILED=0

echo "=========================================="
echo "MULTI-CHAIN VAULT DEPLOYMENT"
echo "=========================================="
echo ""

# Deploy to each network
for NETWORK in "${NETWORKS[@]}"; do
    echo "----------------------------------------"
    echo "Deploying to: $NETWORK"
    echo "----------------------------------------"
    
    if npx hardhat run scripts/deploy-vaults.js --network $NETWORK; then
        echo "✅ $NETWORK: SUCCESS"
        ((SUCCESS++))
    else
        echo "❌ $NETWORK: FAILED"
        ((FAILED++))
    fi
    
    echo ""
    sleep 5  # Rate limit
done

echo "=========================================="
echo "DEPLOYMENT SUMMARY"
echo "=========================================="
echo "Successful: $SUCCESS"
echo "Failed: $FAILED"
echo ""

# Verify address consistency
echo "Verifying address consistency..."
npx hardhat run scripts/verify-consistency.js

exit $FAILED
EOF

chmod +x scripts/deploy-multi-chain.sh

# Run multi-chain deployment
./scripts/deploy-multi-chain.sh
```

Create address consistency checker:

```bash
cat > scripts/verify-consistency.js << 'EOF'
const fs = require('fs');

async function main() {
    const deploymentFiles = fs.readdirSync('.')
        .filter(f => f.startsWith('deployment-') && f.endsWith('.json'))
        .sort();
    
    if (deploymentFiles.length < 2) {
        console.log("Need at least 2 deployments to verify consistency");
        return;
    }
    
    console.log("\n" + "=".repeat(70));
    console.log("ADDRESS CONSISTENCY VERIFICATION");
    console.log("=".repeat(70) + "\n");
    
    const deployments = deploymentFiles.map(f => JSON.parse(fs.readFileSync(f)));
    
    // Check TreasuryVault addresses
    const treasuryAddresses = new Set(
        deployments.map(d => d.contracts?.TreasuryVault?.implementation).filter(Boolean)
    );
    
    if (treasuryAddresses.size === 1) {
        console.log(`✅ TreasuryVault: ${[...treasuryAddresses][0]}`);
        console.log(`   Consistent across ${deployments.length} networks`);
    } else {
        console.log(`❌ TreasuryVault: INCONSISTENT`);
        deployments.forEach(d => {
            console.log(`   ${d.network}: ${d.contracts?.TreasuryVault?.implementation}`);
        });
    }
    
    // Check MarketVault addresses
    const marketAddresses = new Set(
        deployments.map(d => d.contracts?.MarketVault?.implementation).filter(Boolean)
    );
    
    if (marketAddresses.size === 1) {
        console.log(`\n✅ MarketVault: ${[...marketAddresses][0]}`);
        console.log(`   Consistent across ${deployments.length} networks`);
    } else {
        console.log(`\n❌ MarketVault: INCONSISTENT`);
        deployments.forEach(d => {
            console.log(`   ${d.network}: ${d.contracts?.MarketVault?.implementation}`);
        });
    }
    
    console.log("\n" + "=".repeat(70) + "\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
EOF
```

---

## Security Checklist

Before deploying to mainnet, verify:

### Pre-Deployment

- [ ] All contracts compiled successfully
- [ ] Unit tests passing (929/929)
- [ ] Security audit completed
- [ ] Safe Singleton Factory verified on target network
- [ ] Deployer has sufficient balance
- [ ] .env file secured (chmod 600)
- [ ] Private keys never committed to git
- [ ] Addresses pre-computed and documented

### During Deployment

- [ ] Deploy to testnet first
- [ ] Verify deterministic addresses match pre-computed values
- [ ] Test initialization with non-critical account
- [ ] Verify ownership transfer works correctly
- [ ] Test authorization and revocation
- [ ] Test spending limits enforcement
- [ ] Test emergency pause/unpause

### Post-Deployment

- [ ] Verify contract bytecode on block explorer
- [ ] Transfer ownership to multi-sig or DAO
- [ ] Configure appropriate spending limits
- [ ] Set up guardian for emergency controls
- [ ] Document all addresses in README
- [ ] Set up monitoring/alerts
- [ ] Test withdrawal functionality
- [ ] Verify events are emitted correctly

---

## Troubleshooting

### Issue: Factory not deployed

**Error**: "Safe Singleton Factory NOT deployed on this network"

**Solution**:
```bash
# Deploy the factory using the official deployment transaction
# See: https://github.com/safe-global/safe-singleton-factory

# For testnets, you can use this pre-signed transaction:
# Transaction data available in the Safe Singleton Factory repo
```

### Issue: Insufficient balance

**Error**: "insufficient funds for gas * price + value"

**Solution**:
```bash
# Check balance
npx hardhat run scripts/check-balance.js --network amoy

# Send more ETH to deployer address
# Estimated cost: 0.05-0.1 ETH per deployment
```

### Issue: Contract already deployed

**Error**: "contract already deployed at this address"

**Solution**:
This is expected behavior with CREATE2. If you want to deploy a different version:
```bash
# Change the salt prefix in .env
SALT_PREFIX=PredictionDAO.Vaults.v2

# Recompute addresses
npx hardhat run scripts/compute-addresses.js
```

### Issue: Initialization fails

**Error**: "Already initialized"

**Solution**:
```bash
# Check current state
VAULT_ADDRESS=0x... npx hardhat run scripts/verify-deployment.js --network amoy

# The vault can only be initialized once
# If needed, deploy a new instance
```

### Issue: Address mismatch across chains

**Error**: "MarketVault: INCONSISTENT"

**Solution**:
```bash
# Ensure exact same:
# 1. Contract bytecode (compiler version, optimization settings)
# 2. Salt value
# 3. Factory address

# Check compiler settings in hardhat.config.js
npx hardhat compile --show-stack-traces

# Verify factory addresses match
npx hardhat run scripts/check-factory.js --network <each-network>
```

### Issue: Transaction fails silently

**Error**: Transaction succeeds but contract not deployed

**Solution**:
```bash
# Check transaction receipt
npx hardhat console --network amoy

# In console:
const tx = await ethers.provider.getTransaction("0x...");
const receipt = await ethers.provider.getTransactionReceipt("0x...");
console.log(receipt);

# Look for revert reason in logs
```

---

## Complete Deployment Example

Here's a complete end-to-end deployment on Polygon Amoy (Polymarket testnet):

```bash
# 1. Setup
cd fairwins-platform
npm install
cp .env.example .env
# Edit .env with your settings

# 2. Verify environment
npx hardhat run scripts/check-factory.js --network amoy
npx hardhat run scripts/check-balance.js --network amoy

# 3. Compile
npx hardhat clean
npx hardhat compile

# 4. Compute addresses
npx hardhat run scripts/compute-addresses.js

# 5. Deploy implementations
npx hardhat run scripts/deploy-vaults.js --network amoy

# 6. Deploy instance
npx hardhat run scripts/deploy-vault-instance.js --network amoy

# 7. Configure vault
VAULT_ADDRESS=0x... GOVERNOR_ADDRESS=0x... \
  npx hardhat run scripts/configure-vault.js --network amoy

# 8. Verify
VAULT_ADDRESS=0x... \
  npx hardhat run scripts/verify-deployment.js --network amoy

# 9. (Optional) Verify on block explorer
npx hardhat verify --network amoy 0x... arg1 arg2

echo "✅ Deployment complete!"
```

---

## Additional Resources

- [Safe Singleton Factory](https://github.com/safe-global/safe-singleton-factory)
- [CREATE2 Documentation](https://docs.soliditylang.org/en/latest/control-structures.html#salted-contract-creations-create2)
- [Hardhat Documentation](https://hardhat.org/docs)
- [Vault Contracts Documentation](./VAULT_CONTRACTS.md)
- [Singleton Deployment Patterns](./developer-guide/singleton-deployment-patterns.md)

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/chippr-robotics/fairwins-platform/issues
- Documentation: https://github.com/chippr-robotics/fairwins-platform/tree/main/docs

---

**Last Updated**: 2026-01-03  
**Version**: 1.0.0  
**Author**: Prediction DAO Team
