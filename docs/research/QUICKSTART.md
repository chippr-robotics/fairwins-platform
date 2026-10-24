# Quick Start Guide

## Prerequisites
- Node.js v18+ 
- MetaMask browser extension
- Git

## Installation

```bash
# Clone the repository
git clone https://github.com/chippr-robotics/fairwins-platform.git
cd fairwins-platform

# Install dependencies
npm install

# Install frontend dependencies
cd frontend
npm install
cd ..
```

## Running Locally

### 1. Start Local Blockchain

```bash
# Terminal 1: Start Hardhat node
npm run node
```

This will start a local Ethereum network at `http://127.0.0.1:8545` with 20 test accounts.

### 2. Deploy Contracts

```bash
# Terminal 2: Deploy contracts to local network
npm run deploy:local
```

Save the contract addresses that are output for frontend configuration.

### 3. Start Frontend

```bash
# Terminal 3: Start React development server
npm run frontend
```

The frontend will be available at `http://localhost:5173`

### 4. Connect MetaMask

1. Open MetaMask
2. Add a new network:
   - Network Name: Hardhat Local
   - RPC URL: http://127.0.0.1:8545
   - Chain ID: 1337
   - Currency Symbol: ETH
3. Import one of the test accounts using a private key from the Hardhat node output
4. Connect wallet in the application

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test test/WelfareMetricRegistry.test.js

# Run with coverage
npm run test:coverage
```

## Project Structure

```
fairwins-platform/
├── contracts/              # Solidity smart contracts
│   ├── FutarchyGovernor.sol           # Main coordinator
│   ├── WelfareMetricRegistry.sol      # Metrics management
│   ├── ProposalRegistry.sol           # Proposal handling
│   ├── ConditionalMarketFactory.sol   # Market creation
│   ├── PrivacyCoordinator.sol         # ZK privacy + MACI
│   ├── OracleResolver.sol             # Oracle resolution
│   └── RagequitModule.sol             # Minority exit
├── test/                   # Contract tests
├── scripts/                # Deployment scripts
├── frontend/              # React application
│   ├── src/
│   │   ├── components/   # UI components
│   │   ├── App.jsx       # Main app
│   │   └── App.css       # Styles
│   └── package.json
├── hardhat.config.js      # Hardhat configuration
└── package.json           # Project dependencies
```

## Common Tasks

### Submit a Proposal

1. Connect wallet in frontend
2. Navigate to "Submit Proposal" section
3. Fill in:
   - Title (max 100 characters)
   - Description
   - Funding amount (max 50,000)
   - Recipient address
   - Welfare metric
4. Ensure you have 50  for bond
5. Click "Submit Proposal"

### Trade on Markets

1. Navigate to "Prediction Markets" section
2. Select a market by clicking on a proposal
3. Choose PASS (if you think proposal increases welfare) or FAIL (if you think it decreases)
4. Enter trade amount
5. Click "Execute Trade"
6. Your position will be encrypted with zero-knowledge proofs

### View Welfare Metrics

Navigate to "Welfare Metrics" section to see:
- Treasury Value (Primary metric)
- Network Activity (Secondary)
- Hash Rate Security (Tertiary)
- Developer Activity (Quaternary)

## Key Concepts

### Futarchy
"Vote on values, bet on beliefs" - Democratic voting sets goals (welfare metrics), prediction markets determine how to achieve them.

### Privacy Mechanisms
- **Nightmarket**: Zero-knowledge position encryption using Poseidon hashes and zkSNARKs
- **MACI**: Key-change messages prevent vote buying and collusion

### Conditional Tokens
- **PASS tokens**: Redeemable if proposal passes and increases welfare metric
- **FAIL tokens**: Redeemable if proposal fails or decreases welfare metric

### Ragequit
Minority protection allowing token holders to exit with proportional treasury share if they disagree with a proposal.

## Troubleshooting

### "Incorrect network" error
- Ensure MetaMask is connected to Hardhat Local (Chain ID: 1337)
- If using a different network, update the network settings

### "Insufficient funds" error
- Ensure your test account has enough ETH
- Import a funded account from Hardhat node

### Contract deployment fails
- Ensure Hardhat node is running (`npm run node`)
- Check for any compilation errors (`npm run compile`)

### Tests fail
- Clear cache: `npm run clean`
- Reinstall dependencies: `rm -rf node_modules && npm install`
- Ensure you're using Node.js v18+

## Next Steps

1. **Read the full README** for detailed architecture information
2. **Explore the contracts** to understand the implementation
3. **Run the tests** to see the system in action
4. **Try the frontend** to interact with the contracts
5. **Review security features** before considering production use

## Security Notice

This is research and demonstration code. Before deploying to mainnet:
1. Complete professional security audits (minimum 2)
2. Run bug bounty program
3. Community review period (30+ days)
4. Formal verification of critical functions
5. Progressive decentralization of guardian powers

## Support

For questions or issues:
- Check the main README.md
- Review contract documentation
- Check test files for usage examples
- Refer to the gist: https://gist.github.com/realcodywburns/8c89419db5c7797b678afe5ee66cc02b

## License

Apache License 2.0
