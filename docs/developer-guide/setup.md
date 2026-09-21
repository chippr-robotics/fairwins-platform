# Developer Setup

This guide will help you set up your development environment for contributing to Prediction DAO Research.

## Prerequisites

Before you begin, ensure you have the following installed:

### Required Software

- **Node.js** v18 or higher ([download](https://nodejs.org/))
- **npm** or **yarn** package manager
- **Git** version control ([download](https://git-scm.com/))
- **MetaMask** browser extension for testing

### Recommended Tools

- **VS Code** or your preferred IDE
- **Hardhat** for Solidity development
- **Solidity** language support for your IDE
- **Git GUI** (optional, e.g., GitKraken, SourceTree)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/chippr-robotics/fairwins-platform.git
cd prediction-dao-research
```

### 2. Install Dependencies

One install, from the repo root, covers every workspace (spec 075 — one lockfile, 8 members):

```bash
npm install
```

**Do not run `npm install` inside `frontend/` (or any other workspace).** An incremental install in
a child silently drops optional platform binaries — currently `@rolldown/binding-linux-x64-gnu` — from
BOTH `node_modules` and `package-lock.json` (npm/cli#4828). Every Vite build then dies with
a missing-native-binding error, including the mini-app release path whose output
bytes are committed on-chain. Re-running `npm install` does not fix it: the lockfile is already
wrong, so npm reports "up to date".

If it happens, recover with a full re-resolve:

```bash
npm run deps:reinstall
```

The binary's name tracks the build toolchain (it was rollup's until Vite 8 moved to rolldown). The
authoritative list is `REQUIRED_OPTIONAL` in `scripts/deps/check-dependency-hygiene.js` — `npm run
check:deps` fails when one is missing, so you do not have to know the name to catch it.

### 3. Verify Installation

Check that everything is installed correctly:

```bash
# Verify Hardhat installation
npx hardhat --version

# Verify compilation works
npx hardhat compile
```

## Project Structure

```
prediction-dao-research/
├── contracts/              # Active Solidity smart contracts
│   ├── wagers/
│   │   └── WagerRegistry.sol            # escrow + open challenges (UUPS proxy)
│   ├── access/
│   │   ├── MembershipManager.sol        # tiers + voucher redemption (UUPS proxy)
│   │   ├── MembershipVoucher.sol        # transferable ERC-721 voucher (immutable)
│   │   └── SanctionsGuard.sol           # compliance screening
│   ├── privacy/
│   │   └── KeyRegistry.sol              # encryption public keys
│   ├── oracles/                         # Polymarket / Chainlink (×2) / UMA adapters
│   └── upgradeable/
│       └── UUPSManaged.sol              # shared UUPS + AccessControl base
│   # (contracts-archive/ holds superseded research — reference-only)
├── test/                   # Hardhat tests: unit (*.test.js), integration/, fork/, oracles/, upgradeable/
├── scripts/                # Deployment and utility scripts
│   └── deploy/             # deploy + lib/upgradeable.js (deployProxy/upgradeProxy)
├── frontend/              # React frontend application
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── App.jsx       # Main application
│   │   └── App.css       # Styles
│   ├── public/           # Static assets
│   └── package.json
├── hardhat.config.js      # Hardhat configuration
├── package.json           # Project dependencies
└── README.md             # Project documentation
```

## Local Development Workflow

### 1. Start Local Blockchain

Open a terminal and start the Hardhat network:

```bash
npm run node
```

This will:

- Start a local Ethereum node at `http://127.0.0.1:8545`
- Create 20 test accounts with 10,000 ETH each
- Display account addresses and private keys
- Keep running in the background

!!! tip "Keep This Terminal Open"
    Keep this terminal running throughout your development session. The blockchain state resets when you stop it.

### 2. Deploy Contracts

In a new terminal, deploy contracts to the local network:

```bash
npm run deploy:local
```

This will:

- Compile all smart contracts
- Deploy them to the local network
- Display contract addresses
- Save deployment artifacts

**Save the contract addresses** for frontend configuration.

### 3. Run Tests

Run the test suite:

```bash
# Run all tests
npm test

# Run specific test file
npx hardhat test test/WelfareMetricRegistry.test.js

# Run with coverage
npm run test:coverage

# Run with gas reporting
npx hardhat test --gas-reporter
```

### 4. Start Frontend

In a third terminal, start the frontend development server:

```bash
npm run frontend
```

Or navigate to the frontend directory:

```bash
cd frontend
npm run dev
```

The frontend will be available at `http://localhost:5173`

### 5. Seed Wallets & End-to-End Testing

`deploy:local` deploys the contracts but does **not** fund any wallet. To exercise the
full create → accept → resolve wager lifecycle locally you also need two wallets that
hold the test stake token, an active `WAGER_PARTICIPANT` membership, and an allowance to
the WagerRegistry. Bring the whole environment up with one command (with the node from
step 1 already running):

```bash
npm run setup:local
```

`setup:local` runs three steps in order:

1. `deploy:local` — deploys the v2 contract set and writes
   `deployments/localhost-chain1337-v2.json`.
2. `sync:frontend-contracts:local` — writes the local addresses into the frontend's
   `HARDHAT_CONTRACTS` block (generated, never hand-edited).
3. `seed:local` — for the two developer wallets below: mints the test ERC20 stake token
   (USDC + WMATIC), grants an active `WAGER_PARTICIPANT` membership, and approves the
   WagerRegistry. Re-runnable on its own after a redeploy (idempotent).

You can also run any step individually (e.g. `npm run seed:local` after a fresh deploy).
Seed amounts are overridable via `SEED_USDC_AMOUNT`, `SEED_WMATIC_AMOUNT`, and
`SEED_MEMBERSHIP_DAYS`.

#### The two funded wallets

These are the first two default Hardhat accounts — deterministic, **local-only**, no real
value:

| Role | Address | Hardhat account |
|------|---------|-----------------|
| Wallet #0 (creator / deployer) | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Account #0 |
| Wallet #1 (acceptor) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | Account #1 |

`npm run node` prints all 20 accounts **with their private keys** on startup. Import
Account #0 and Account #1 into MetaMask using the keys from that console output — this
repo intentionally does not store any private key. These keys are for the local chain
only and must never be used on a real network.

#### Run the app end-to-end

```bash
VITE_NETWORK_ID=1337 npm run frontend
```

Then, in the app: connect **Wallet #0** and create + fund a wager; connect **Wallet #1**
and accept + fund it; resolve it and confirm the winner's payout. No remote network calls
are required. The automated invariant check (no browser needed) is:

```bash
npx hardhat test test/integration/seed-local.test.js
```

#### Reset to a clean state

The local chain is ephemeral. Stop `npm run node` (Ctrl-C), start it again, then re-run
`npm run setup:local` to return to a fresh, fully funded state.

> **Note:** `setup:local` targets the `localhost` network at `http://127.0.0.1:8545`. If
> another node already occupies port 8545, stop it (or free the port) before running
> `npm run node`, since the contracts must deploy to the same chain the frontend and
> wallets point at.

The full runbook lives at
[`specs/006-local-dev-environment/quickstart.md`](../../specs/006-local-dev-environment/quickstart.md).

## Configuration

### Configure MetaMask for Local Development

1. Open MetaMask
2. Click on network dropdown
3. Select "Add Network" → "Add a network manually"
4. Enter:
   - **Network Name**: Hardhat Local
   - **RPC URL**: http://127.0.0.1:8545
   - **Chain ID**: 1337
   - **Currency Symbol**: ETH

5. Import a test account:
   - Copy a private key from Hardhat node output
   - MetaMask → Account menu → Import Account
   - Paste private key

### Configure Frontend

Update contract addresses in the frontend:

```javascript
// frontend/src/config.js
export const contracts = {
  FutarchyGovernor: "0x...",
  WelfareMetricRegistry: "0x...",
  ProposalRegistry: "0x...",
  // ... other contracts
};
```

### Environment Variables

Create a `.env` file in the root directory (never commit this!):

```bash
# For testnet/mainnet deployment
PRIVATE_KEY=your_private_key_here
INFURA_KEY=your_infura_key_here
ETHERSCAN_API_KEY=your_etherscan_key_here

# For production frontend
VITE_CONTRACT_ADDRESS_GOVERNOR=0x...
VITE_CONTRACT_ADDRESS_REGISTRY=0x...
```

## Development Commands

### Smart Contract Commands

```bash
# Compile contracts
npm run compile
npx hardhat compile

# Run tests
npm test
npx hardhat test

# Test specific file
npx hardhat test test/ProposalRegistry.test.js

# Generate coverage report
npm run test:coverage
npx hardhat coverage

# Clean artifacts
npm run clean
npx hardhat clean

# Deploy to local network
npm run deploy:local

# Deploy to testnet
npx hardhat run scripts/deploy.js --network amoy
```

### Frontend Commands

```bash
# Start development server
cd frontend
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run linting
npm run lint
```

## Testing

### Writing Tests

Tests use Mocha and Chai:

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProposalRegistry", function () {
  let proposalRegistry;
  let owner, proposer;

  beforeEach(async function () {
    [owner, proposer] = await ethers.getSigners();
    
    const ProposalRegistry = await ethers.getContractFactory("ProposalRegistry");
    proposalRegistry = await ProposalRegistry.deploy();
    await proposalRegistry.waitForDeployment();
  });

  it("Should submit a proposal", async function () {
    const tx = await proposalRegistry.connect(proposer).submitProposal(
      "Test Proposal",
      "Description",
      ethers.parseEther("100"),
      proposer.address,
      1, // welfare metric
      { value: ethers.parseEther("50") } // bond
    );
    
    await expect(tx)
      .to.emit(proposalRegistry, "ProposalSubmitted")
      .withArgs(0, proposer.address);
  });
});
```

### Test Coverage

Aim for high test coverage:

- **Unit Tests**: Test individual functions
- **Integration Tests**: Test contract interactions
- **Edge Cases**: Test boundary conditions
- **Error Cases**: Test failure scenarios

Run coverage:

```bash
npm run test:coverage
```

## Code Style

### Solidity Style Guide

Follow the [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html):

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title ProposalRegistry
 * @notice Manages proposal submission and lifecycle
 */
contract ProposalRegistry {
    // State variables
    uint256 public proposalCount;
    
    // Events
    event ProposalSubmitted(uint256 indexed proposalId, address indexed proposer);
    
    // Modifiers
    modifier onlyProposer(uint256 proposalId) {
        require(proposals[proposalId].proposer == msg.sender, "Not proposer");
        _;
    }
    
    // Functions (grouped by visibility)
    function submitProposal(
        string memory title,
        string memory description,
        uint256 fundingAmount,
        address recipient,
        uint256 welfareMetricId
    ) external payable returns (uint256) {
        // Implementation
    }
}
```

### JavaScript/React Style

Use ESLint with appropriate config:

```javascript
// Use arrow functions
const MyComponent = ({ prop1, prop2 }) => {
  // Use hooks
  const [state, setState] = useState(initialState);
  
  useEffect(() => {
    // Side effects
  }, [dependencies]);
  
  return (
    <div className="my-component">
      {/* JSX */}
    </div>
  );
};

export default MyComponent;
```

## Debugging

### Hardhat Console

Debug contracts interactively:

```bash
npx hardhat console --network localhost
```

```javascript
> const ProposalRegistry = await ethers.getContractFactory("ProposalRegistry");
> const registry = await ProposalRegistry.attach("0x...");
> await registry.proposalCount();
BigNumber { value: "5" }
```

### Console Logging in Contracts

Use Hardhat's `console.log`:

```solidity
import "hardhat/console.sol";

contract MyContract {
    function debug() public {
        console.log("Debug value:", someValue);
    }
}
```

### Frontend Debugging

Use browser developer tools:

```javascript
// Add debug logging
console.log("Contract address:", contractAddress);
console.log("Transaction hash:", tx.hash);

// Inspect transaction details
const receipt = await tx.wait();
console.log("Transaction receipt:", receipt);
```

## Common Issues

### Contract Deployment Fails

**Problem**: `Error: insufficient funds`

**Solution**: Ensure your account has enough ETH for gas fees

---

**Problem**: `Error: nonce too low`

**Solution**: Reset MetaMask account or clear transaction history

---

**Problem**: Contract verification fails

**Solution**: Ensure you're using the correct compiler version

### Frontend Connection Issues

**Problem**: MetaMask doesn't connect

**Solutions**:

- Check network (should be Hardhat Local)
- Verify RPC URL is correct
- Clear MetaMask cache
- Reload the page

---

**Problem**: Contract calls fail

**Solutions**:

- Verify contract addresses are correct
- Check if contracts are deployed
- Ensure ABI is up to date
- Verify you're on the correct network

## Best Practices

### Development Workflow

1. **Branch**: Create feature branch from `main`
2. **Code**: Implement changes with tests
3. **Test**: Ensure all tests pass
4. **Commit**: Make atomic, well-described commits
5. **Push**: Push to your fork
6. **PR**: Create pull request with description

### Git Commits

Write clear commit messages:

```bash
# Good commits
git commit -m "Add proposal submission validation"
git commit -m "Fix oracle bond requirement check"
git commit -m "Update ProposalList component styling"

# Bad commits
git commit -m "fixes"
git commit -m "update"
git commit -m "WIP"
```

### Testing Before Committing

Always run tests before committing:

```bash
# Run all checks
npm run compile
npm test
cd frontend && npm run lint && npm run build
```

## Next Steps

Now that your environment is set up:

- [Learn about the architecture](architecture.md)
- [Explore the smart contracts](smart-contracts.md)
- [Understand testing practices](testing.md)
- [Read the contributing guidelines](contributing.md)
- [Check out the frontend development guide](frontend.md)

## Getting Help

If you encounter issues:

- Check the [FAQ](../user-guide/faq.md)
- Review existing [GitHub issues](https://github.com/chippr-robotics/fairwins-platform/issues)
- Ask in community channels
- Create a new issue with details
