# ADR 002: Batch Operations & Market Discovery API Integration

**Status**: Accepted

**Date**: 2025-12-23

**Deciders**: Development Team

**Technical Story**: [Issue: Scalable Architecture & Batch Market Updates for High-Traffic Scenarios](https://github.com/chippr-robotics/fairwins-platform/issues/)

## Overview

This guide provides practical examples for integrating with the enhanced scalability features of the ClearPath & FairWins prediction market platform, including batch operations, event indexing, and market discovery APIs.

## Context

Following the architectural decisions in ADR 001, this document provides implementation guidance and integration examples for developers building on the platform. It addresses the practical concerns of:
- How to use batch operations efficiently
- How to index events for market discovery
- How to query markets and positions at scale
- How to set up off-chain infrastructure

This ADR serves as the technical integration guide for the scalability architecture.

## Table of Contents

1. [Batch Market Creation](#batch-market-creation)
2. [Batch Position Submission](#batch-position-submission)
3. [Batch Market Resolution](#batch-market-resolution)
4. [Event Indexing](#event-indexing)
5. [Market Discovery & Querying](#market-discovery--querying)
6. [Off-Chain Indexer Setup](#off-chain-indexer-setup)
7. [Performance Best Practices](#performance-best-practices)

---

## Batch Market Creation

### Use Case

Create multiple prediction markets efficiently in a single transaction, reducing gas costs by up to 50%.

### Smart Contract Interface

```solidity
struct MarketCreationParams {
    uint256 proposalId;
    address collateralToken;
    uint256 liquidityAmount;
    uint256 liquidityParameter;
    uint256 tradingPeriod;
}

function batchDeployMarkets(
    MarketCreationParams[] calldata params
) external onlyOwner returns (uint256[] memory marketIds);
```

### JavaScript/TypeScript Integration

```javascript
const { ethers } = require('ethers');

// Connect to contract
const contractAddress = '0x...';
const contractABI = [...]; // ConditionalMarketFactory ABI
const contract = new ethers.Contract(contractAddress, contractABI, signer);

// Prepare batch market parameters
const marketParams = [
  {
    proposalId: 1,
    collateralToken: ethers.constants.AddressZero, // ETH
    liquidityAmount: ethers.utils.parseEther('1000'),
    liquidityParameter: ethers.utils.parseEther('100'),
    tradingPeriod: 7 * 24 * 60 * 60 // 7 days
  },
  {
    proposalId: 2,
    collateralToken: ethers.constants.AddressZero,
    liquidityAmount: ethers.utils.parseEther('2000'),
    liquidityParameter: ethers.utils.parseEther('200'),
    tradingPeriod: 10 * 24 * 60 * 60 // 10 days
  },
  {
    proposalId: 3,
    collateralToken: ethers.constants.AddressZero,
    liquidityAmount: ethers.utils.parseEther('1500'),
    liquidityParameter: ethers.utils.parseEther('150'),
    tradingPeriod: 14 * 24 * 60 * 60 // 14 days
  }
];

// Execute batch creation
try {
  const tx = await contract.batchDeployMarkets(marketParams);
  const receipt = await tx.wait();
  
  console.log(`Created ${marketParams.length} markets in transaction ${receipt.transactionHash}`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
  
  // Extract market IDs from events
  const createdEvents = receipt.logs
    .map(log => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(event => event && event.name === 'MarketCreated');
  
  const marketIds = createdEvents.map(event => event.args.marketId);
  console.log('Created market IDs:', marketIds);
  
} catch (error) {
  console.error('Batch market creation failed:', error.message);
}
```

### Python Integration (web3.py)

```python
from web3 import Web3
from eth_account import Account
import json

# Connect to network
w3 = Web3(Web3.HTTPProvider('https://rpc-amoy.polygon.technology'))
account = Account.from_key('your_private_key')

# Load contract
with open('ConditionalMarketFactory.json') as f:
    contract_abi = json.load(f)['abi']

contract = w3.eth.contract(
    address='0x...',
    abi=contract_abi
)

# Prepare batch parameters
market_params = [
    {
        'proposalId': 1,
        'collateralToken': '0x0000000000000000000000000000000000000000',
        'liquidityAmount': w3.to_wei(1000, 'ether'),
        'liquidityParameter': w3.to_wei(100, 'ether'),
        'tradingPeriod': 7 * 24 * 60 * 60
    },
    {
        'proposalId': 2,
        'collateralToken': '0x0000000000000000000000000000000000000000',
        'liquidityAmount': w3.to_wei(2000, 'ether'),
        'liquidityParameter': w3.to_wei(200, 'ether'),
        'tradingPeriod': 10 * 24 * 60 * 60
    }
]

# Build transaction
tx = contract.functions.batchDeployMarkets(market_params).build_transaction({
    'from': account.address,
    'nonce': w3.eth.get_transaction_count(account.address),
    'gas': 2000000,
    'gasPrice': w3.eth.gas_price
})

# Sign and send
signed_tx = account.sign_transaction(tx)
tx_hash = w3.eth.send_raw_transaction(signed_tx.rawTransaction)
receipt = w3.eth.wait_for_transaction_receipt(tx_hash)

print(f'Markets created in transaction: {tx_hash.hex()}')
print(f'Gas used: {receipt["gasUsed"]}')

# Parse events
market_created_event = contract.events.MarketCreated()
events = market_created_event.process_receipt(receipt)
market_ids = [event['args']['marketId'] for event in events]
print(f'Created market IDs: {market_ids}')
```

---

## Batch Position Submission

### Use Case

Submit multiple encrypted positions efficiently, reducing transaction costs by up to 75% for large batches.

### Smart Contract Interface

```solidity
function batchSubmitPositions(
    bytes32[] calldata commitments,
    bytes[] calldata zkProofs,
    uint256[] calldata marketIds
) external returns (uint256[] memory positionIds);
```

### JavaScript/TypeScript Integration

```javascript
const { ethers } = require('ethers');
const { poseidon } = require('circomlibjs'); // For Poseidon hash

// Connect to PrivacyCoordinator contract
const privacyCoordinator = new ethers.Contract(
  privacyCoordinatorAddress,
  privacyCoordinatorABI,
  signer
);

// First, register public key if not already done
const publicKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('user-public-key'));
await privacyCoordinator.registerPublicKey(publicKey);

// Prepare multiple position commitments
async function createPositionCommitment(amount, direction, price, nonce) {
  // In production, use actual Poseidon hash
  const data = ethers.utils.solidityPack(
    ['uint256', 'bool', 'uint256', 'uint256'],
    [amount, direction, price, nonce]
  );
  return ethers.utils.keccak256(data);
}

async function generateZKProof(commitment) {
  // In production, generate actual Groth16 zkSNARK proof
  // This is a simplified example
  return ethers.utils.toUtf8Bytes('mock-zk-proof-' + commitment);
}

// Create batch of positions
const positions = [
  { amount: 100, direction: true, price: 50, marketId: 1 },
  { amount: 200, direction: false, price: 45, marketId: 2 },
  { amount: 150, direction: true, price: 55, marketId: 3 }
];

const commitments = [];
const zkProofs = [];
const marketIds = [];

for (let i = 0; i < positions.length; i++) {
  const nonce = Math.floor(Math.random() * 1000000);
  const commitment = await createPositionCommitment(
    positions[i].amount,
    positions[i].direction,
    positions[i].price,
    nonce
  );
  const proof = await generateZKProof(commitment);
  
  commitments.push(commitment);
  zkProofs.push(proof);
  marketIds.push(positions[i].marketId);
}

// Submit batch
try {
  const tx = await privacyCoordinator.batchSubmitPositions(
    commitments,
    zkProofs,
    marketIds
  );
  const receipt = await tx.wait();
  
  console.log(`Submitted ${positions.length} positions`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
  console.log(`Average gas per position: ${receipt.gasUsed.div(positions.length).toString()}`);
  
  // Get position IDs from return value
  const positionSubmittedEvents = receipt.logs
    .map(log => {
      try {
        return privacyCoordinator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(event => event && event.name === 'EncryptedPositionSubmitted');
  
  const positionIds = positionSubmittedEvents.map(event => event.args.positionId);
  console.log('Position IDs:', positionIds);
  
} catch (error) {
  console.error('Batch position submission failed:', error.message);
}
```

### React Hook Example

```typescript
import { useState } from 'react';
import { useContract, useSigner } from 'wagmi';

interface Position {
  amount: number;
  direction: boolean;
  price: number;
  marketId: number;
}

function useBatchPositionSubmission(contractAddress: string, contractABI: any) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { data: signer } = useSigner();
  const contract = useContract({
    address: contractAddress,
    abi: contractABI,
    signerOrProvider: signer
  });

  const submitBatch = async (positions: Position[]) => {
    if (!contract) throw new Error('Contract not initialized');
    
    setLoading(true);
    setError(null);
    
    try {
      // Prepare commitments and proofs (simplified)
      const commitments = positions.map((p, i) => 
        ethers.utils.keccak256(
          ethers.utils.solidityPack(
            ['uint256', 'bool', 'uint256'],
            [p.amount, p.direction, p.price]
          )
        )
      );
      
      const zkProofs = commitments.map(c => 
        ethers.utils.toUtf8Bytes('mock-proof-' + c)
      );
      
      const marketIds = positions.map(p => p.marketId);
      
      // Submit batch
      const tx = await contract.batchSubmitPositions(
        commitments,
        zkProofs,
        marketIds
      );
      
      const receipt = await tx.wait();
      
      setLoading(false);
      return {
        success: true,
        transactionHash: receipt.transactionHash,
        gasUsed: receipt.gasUsed.toString()
      };
      
    } catch (err) {
      setError(err as Error);
      setLoading(false);
      return { success: false, error: (err as Error).message };
    }
  };

  return { submitBatch, loading, error };
}

// Usage in component
function PositionSubmissionForm() {
  const { submitBatch, loading } = useBatchPositionSubmission(
    PRIVACY_COORDINATOR_ADDRESS,
    PRIVACY_COORDINATOR_ABI
  );

  const handleSubmit = async () => {
    const positions = [
      { amount: 100, direction: true, price: 50, marketId: 1 },
      { amount: 200, direction: false, price: 45, marketId: 2 }
    ];
    
    const result = await submitBatch(positions);
    
    if (result.success) {
      console.log('Positions submitted:', result.transactionHash);
    }
  };

  return (
    <button onClick={handleSubmit} disabled={loading}>
      {loading ? 'Submitting...' : 'Submit Positions'}
    </button>
  );
}
```

---

## Batch Market Resolution

### Use Case

Resolve multiple markets simultaneously, improving coordinator efficiency.

### Smart Contract Interface

```solidity
struct MarketResolutionParams {
    uint256 marketId;
    uint256 passValue;
    uint256 failValue;
}

function batchResolveMarkets(
    MarketResolutionParams[] calldata params
) external onlyOwner returns (bool[] memory results);
```

### JavaScript Integration

```javascript
// Prepare resolution data
const resolutions = [
  { marketId: 0, passValue: ethers.utils.parseEther('100'), failValue: ethers.utils.parseEther('80') },
  { marketId: 1, passValue: ethers.utils.parseEther('120'), failValue: ethers.utils.parseEther('110') },
  { marketId: 2, passValue: ethers.utils.parseEther('90'), failValue: ethers.utils.parseEther('95') }
];

// Execute batch resolution
const tx = await marketFactory.batchResolveMarkets(resolutions);
const receipt = await tx.wait();

console.log(`Resolved ${resolutions.length} markets`);
console.log(`Transaction: ${receipt.transactionHash}`);

// Check which markets resolved successfully
const resolvedEvents = receipt.logs
  .map(log => {
    try {
      return marketFactory.interface.parseLog(log);
    } catch {
      return null;
    }
  })
  .filter(event => event && event.name === 'MarketResolved');

console.log(`Successfully resolved ${resolvedEvents.length} markets`);

// Get resolution details
for (const event of resolvedEvents) {
  console.log(`Market ${event.args.marketId}: ${event.args.approved ? 'APPROVED' : 'REJECTED'}`);
  console.log(`  Pass value: ${ethers.utils.formatEther(event.args.passValue)}`);
  console.log(`  Fail value: ${ethers.utils.formatEther(event.args.failValue)}`);
}
```

---

## Event Indexing

### Enhanced Event Structure

All events now include comprehensive indexing for efficient filtering and querying.

### Market Lifecycle Events

```solidity
event MarketCreated(
    uint256 indexed marketId,
    uint256 indexed proposalId,
    address indexed collateralToken,
    address passToken,
    address failToken,
    uint256 tradingEndTime,
    uint256 liquidityParameter,
    uint256 createdAt,
    address creator
);

event MarketStatusChanged(
    uint256 indexed marketId,
    MarketStatus indexed previousStatus,
    MarketStatus indexed newStatus,
    uint256 changedAt
);

event MarketResolved(
    uint256 indexed marketId,
    uint256 indexed proposalId,
    uint256 passValue,
    uint256 failValue,
    bool indexed approved,
    uint256 resolvedAt
);
```

### Listening to Events (JavaScript)

```javascript
// Listen to MarketCreated events
marketFactory.on('MarketCreated', (marketId, proposalId, collateralToken, passToken, failToken, tradingEndTime, liquidityParameter, createdAt, creator) => {
  console.log('New market created:', {
    marketId: marketId.toString(),
    proposalId: proposalId.toString(),
    tradingEndTime: new Date(tradingEndTime.toNumber() * 1000),
    creator
  });
});

// Listen to MarketResolved events
marketFactory.on('MarketResolved', (marketId, proposalId, passValue, failValue, approved, resolvedAt) => {
  console.log('Market resolved:', {
    marketId: marketId.toString(),
    proposalId: proposalId.toString(),
    approved,
    passValue: ethers.utils.formatEther(passValue),
    failValue: ethers.utils.formatEther(failValue)
  });
});

// Query historical events
const filter = marketFactory.filters.MarketCreated(null, null, null);
const fromBlock = 0;
const toBlock = 'latest';

const events = await marketFactory.queryFilter(filter, fromBlock, toBlock);

for (const event of events) {
  console.log('Historical market:', {
    marketId: event.args.marketId.toString(),
    proposalId: event.args.proposalId.toString(),
    createdAt: new Date(event.args.createdAt.toNumber() * 1000)
  });
}
```

### Event Filtering Examples

```javascript
// Get all markets for a specific proposal
const proposalId = 42;
const filter = marketFactory.filters.MarketCreated(null, proposalId, null);
const events = await marketFactory.queryFilter(filter);

// Get all resolved markets
const resolvedFilter = marketFactory.filters.MarketResolved(null, null, null, null, null, null);
const resolvedEvents = await marketFactory.queryFilter(resolvedFilter);

// Get approved markets only
const approvedFilter = marketFactory.filters.MarketResolved(null, null, null, null, true, null);
const approvedMarkets = await marketFactory.queryFilter(approvedFilter);

// Get markets using specific collateral token
const collateralToken = '0x...';
const collateralFilter = marketFactory.filters.MarketCreated(null, null, collateralToken);
const collateralMarkets = await marketFactory.queryFilter(collateralFilter);
```

---

## Market Discovery & Querying

### On-Chain Query Functions

The smart contracts provide efficient on-chain query functions for market discovery.

### Query Active Markets

```javascript
// Get active markets with pagination
const offset = 0;
const limit = 20;

const [marketIds, hasMore] = await marketFactory.getActiveMarkets(offset, limit);

console.log(`Found ${marketIds.length} active markets`);
console.log('Market IDs:', marketIds.map(id => id.toString()));

if (hasMore) {
  console.log('More markets available. Increase offset to fetch next page.');
}

// Fetch market details
for (const marketId of marketIds) {
  const market = await marketFactory.getMarket(marketId);
  console.log(`Market ${marketId}:`);
  console.log(`  Proposal: ${market.proposalId}`);
  console.log(`  Trading ends: ${new Date(market.tradingEndTime.toNumber() * 1000)}`);
  console.log(`  Status: ${market.status}`);
}
```

### Query Markets by Status

```javascript
// Market statuses: 0=Active, 1=TradingEnded, 2=Resolved, 3=Cancelled
const MARKET_STATUS = {
  ACTIVE: 0,
  TRADING_ENDED: 1,
  RESOLVED: 2,
  CANCELLED: 3
};

// Get resolved markets
const [resolvedMarketIds, hasMore] = await marketFactory.getMarketsByStatus(
  MARKET_STATUS.RESOLVED,
  0,  // offset
  50  // limit
);

console.log(`Found ${resolvedMarketIds.length} resolved markets`);

// Get market count by status
const activeCount = await marketFactory.getMarketCountByStatus(MARKET_STATUS.ACTIVE);
const resolvedCount = await marketFactory.getMarketCountByStatus(MARKET_STATUS.RESOLVED);

console.log(`Active markets: ${activeCount.toString()}`);
console.log(`Resolved markets: ${resolvedCount.toString()}`);
```

### Query Markets by Date Range

```javascript
// Get markets created in the last 7 days
const now = Math.floor(Date.now() / 1000);
const sevenDaysAgo = now - (7 * 24 * 60 * 60);

const [marketIds, hasMore] = await marketFactory.getMarketsByDateRange(
  sevenDaysAgo,
  now,
  0,   // offset
  100  // limit
);

console.log(`Markets created in last 7 days: ${marketIds.length}`);
```

### Query User Positions

```javascript
// Get all positions for a user
const userAddress = '0x...';
const [positionIds, hasMore] = await privacyCoordinator.getUserPositions(
  userAddress,
  0,   // offset
  20   // limit
);

console.log(`User has ${positionIds.length} positions`);

// Get total position count
const totalPositions = await privacyCoordinator.getUserPositionCount(userAddress);
console.log(`Total positions: ${totalPositions.toString()}`);

// Fetch position details
for (const positionId of positionIds) {
  const position = await privacyCoordinator.getPosition(positionId);
  console.log(`Position ${positionId}:`);
  console.log(`  Market: ${position.marketId}`);
  console.log(`  Commitment: ${position.commitment}`);
  console.log(`  Processed: ${position.processed}`);
}
```

### Query Market Positions

```javascript
// Get all positions for a specific market
const marketId = 1;
const [positionIds, hasMore] = await privacyCoordinator.getMarketPositions(
  marketId,
  0,   // offset
  100  // limit
);

console.log(`Market has ${positionIds.length} positions`);

// Get total position count for market
const totalMarketPositions = await privacyCoordinator.getMarketPositionCount(marketId);
console.log(`Total positions in market: ${totalMarketPositions.toString()}`);
```

### Pagination Helper Function

```javascript
async function fetchAllMarkets(marketFactory, status) {
  const limit = 100; // Fetch 100 at a time
  let offset = 0;
  let hasMore = true;
  const allMarkets = [];

  while (hasMore) {
    const [marketIds, more] = await marketFactory.getMarketsByStatus(
      status,
      offset,
      limit
    );
    
    allMarkets.push(...marketIds);
    hasMore = more;
    offset += limit;
    
    console.log(`Fetched ${marketIds.length} markets (total: ${allMarkets.length})`);
  }

  return allMarkets;
}

// Usage
const allActiveMarkets = await fetchAllMarkets(marketFactory, 0); // 0 = Active
console.log(`Total active markets: ${allActiveMarkets.length}`);
```

---

## Off-Chain Indexer Setup

For production applications, set up an off-chain indexer for fast queries and analytics.

### Example: The Graph Subgraph

#### Schema Definition (schema.graphql)

```graphql
type Market @entity {
  id: ID!
  marketId: BigInt!
  proposalId: BigInt!
  collateralToken: Bytes!
  passToken: Bytes!
  failToken: Bytes!
  tradingEndTime: BigInt!
  liquidityParameter: BigInt!
  status: MarketStatus!
  resolved: Boolean!
  passValue: BigInt
  failValue: BigInt
  approved: Boolean
  createdAt: BigInt!
  resolvedAt: BigInt
  creator: Bytes!
  positions: [Position!]! @derivedFrom(field: "market")
}

enum MarketStatus {
  ACTIVE
  TRADING_ENDED
  RESOLVED
  CANCELLED
}

type Position @entity {
  id: ID!
  positionId: BigInt!
  user: Bytes!
  market: Market!
  commitment: Bytes!
  epoch: BigInt!
  processed: Boolean!
  submittedAt: BigInt!
}

type DailyStats @entity {
  id: ID! # Format: YYYY-MM-DD
  date: String!
  marketsCreated: Int!
  marketsResolved: Int!
  positionsSubmitted: Int!
  uniqueTraders: Int!
}
```

#### Event Handlers (mapping.ts)

```typescript
import { MarketCreated, MarketResolved, MarketStatusChanged } from '../generated/ConditionalMarketFactory/ConditionalMarketFactory';
import { Market, DailyStats } from '../generated/schema';

export function handleMarketCreated(event: MarketCreated): void {
  let market = new Market(event.params.marketId.toString());
  
  market.marketId = event.params.marketId;
  market.proposalId = event.params.proposalId;
  market.collateralToken = event.params.collateralToken;
  market.passToken = event.params.passToken;
  market.failToken = event.params.failToken;
  market.tradingEndTime = event.params.tradingEndTime;
  market.liquidityParameter = event.params.liquidityParameter;
  market.status = 'ACTIVE';
  market.resolved = false;
  market.createdAt = event.params.createdAt;
  market.creator = event.params.creator;
  
  market.save();
  
  // Update daily stats
  let date = new Date(event.params.createdAt.toI64() * 1000).toISOString().split('T')[0];
  let stats = DailyStats.load(date);
  
  if (stats == null) {
    stats = new DailyStats(date);
    stats.date = date;
    stats.marketsCreated = 0;
    stats.marketsResolved = 0;
    stats.positionsSubmitted = 0;
    stats.uniqueTraders = 0;
  }
  
  stats.marketsCreated = stats.marketsCreated + 1;
  stats.save();
}

export function handleMarketResolved(event: MarketResolved): void {
  let market = Market.load(event.params.marketId.toString());
  
  if (market != null) {
    market.resolved = true;
    market.passValue = event.params.passValue;
    market.failValue = event.params.failValue;
    market.approved = event.params.approved;
    market.resolvedAt = event.params.resolvedAt;
    market.status = 'RESOLVED';
    
    market.save();
  }
}
```

### Query Examples (GraphQL)

```graphql
# Get active markets with details
query GetActiveMarkets {
  markets(
    where: { status: ACTIVE }
    orderBy: createdAt
    orderDirection: desc
    first: 20
  ) {
    id
    marketId
    proposalId
    tradingEndTime
    liquidityParameter
    creator
    positions {
      id
      positionId
      user
    }
  }
}

# Get market statistics
query GetMarketStats($marketId: String!) {
  market(id: $marketId) {
    id
    marketId
    status
    resolved
    approved
    positions {
      id
      user
      processed
    }
  }
}

# Get daily statistics
query GetDailyStats {
  dailyStats(
    orderBy: date
    orderDirection: desc
    first: 30
  ) {
    date
    marketsCreated
    marketsResolved
    positionsSubmitted
    uniqueTraders
  }
}

# Get user positions across all markets
query GetUserPositions($user: Bytes!) {
  positions(
    where: { user: $user }
    orderBy: submittedAt
    orderDirection: desc
  ) {
    id
    positionId
    market {
      marketId
      status
      resolved
      approved
    }
    commitment
    processed
    submittedAt
  }
}
```

---

## Performance Best Practices

### 1. Batch Size Optimization

```javascript
// Test different batch sizes to find optimal gas efficiency
const batchSizes = [1, 5, 10, 25, 50];

for (const size of batchSizes) {
  const params = generateMarketParams(size);
  const tx = await marketFactory.batchDeployMarkets(params);
  const receipt = await tx.wait();
  
  const avgGas = receipt.gasUsed.div(size);
  console.log(`Batch size ${size}: ${avgGas.toString()} gas per market`);
}

// Output example:
// Batch size 1: 200000 gas per market
// Batch size 5: 160000 gas per market (20% savings)
// Batch size 10: 140000 gas per market (30% savings)
// Batch size 25: 125000 gas per market (37.5% savings)
// Batch size 50: 110000 gas per market (45% savings)
```

### 2. Pagination Strategy

```javascript
// Implement efficient pagination with caching
class MarketCache {
  constructor(marketFactory) {
    this.factory = marketFactory;
    this.cache = new Map();
    this.pageSize = 50;
  }

  async getPage(status, page) {
    const cacheKey = `${status}-${page}`;
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const offset = page * this.pageSize;
    const [marketIds, hasMore] = await this.factory.getMarketsByStatus(
      status,
      offset,
      this.pageSize
    );

    const result = { marketIds, hasMore, page };
    this.cache.set(cacheKey, result);
    
    return result;
  }

  invalidate(status) {
    // Clear cache for specific status when markets are created/updated
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${status}-`)) {
        this.cache.delete(key);
      }
    }
  }
}

// Usage
const cache = new MarketCache(marketFactory);
const page1 = await cache.getPage(0, 0); // Active markets, page 0
const page2 = await cache.getPage(0, 1); // Active markets, page 1
```

### 3. Event Filtering Optimization

```javascript
// Use indexed parameters for efficient filtering
// GOOD: Uses indexed parameters
const filter = marketFactory.filters.MarketCreated(null, proposalId, null);

// AVOID: Fetching all events and filtering in JavaScript
// This is inefficient for large datasets
const allEvents = await marketFactory.queryFilter(marketFactory.filters.MarketCreated());
const filtered = allEvents.filter(e => e.args.proposalId.eq(proposalId));
```

### 4. Batch Operations vs Individual Transactions

```javascript
// Decision matrix for when to use batch operations

function shouldUseBatch(itemCount) {
  // Use batch when:
  // - 5+ items: Worthwhile gas savings
  // - Network congestion: Reduce transaction count
  // - Time-critical: Atomic execution important
  
  if (itemCount >= 5) return true;
  if (await isNetworkCongested()) return true;
  if (requiresAtomicity) return true;
  
  return false;
}

async function isNetworkCongested() {
  const gasPrice = await provider.getGasPrice();
  const threshold = ethers.utils.parseUnits('50', 'gwei');
  return gasPrice.gt(threshold);
}
```

### 5. Error Handling for Batch Operations

```javascript
// Implement robust error handling for batch operations
async function safeBatchDeployMarkets(params) {
  try {
    // Validate parameters before submission
    for (const param of params) {
      if (!param.proposalId || param.proposalId <= 0) {
        throw new Error(`Invalid proposal ID: ${param.proposalId}`);
      }
      if (param.tradingPeriod < 7 * 24 * 60 * 60) {
        throw new Error('Trading period too short');
      }
    }

    // Submit batch
    const tx = await marketFactory.batchDeployMarkets(params);
    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
      marketsCreated: params.length
    };

  } catch (error) {
    console.error('Batch deployment failed:', error);
    
    if (error.code === 'INSUFFICIENT_FUNDS') {
      return { success: false, error: 'Insufficient funds for gas' };
    }
    
    if (error.message.includes('Market already exists')) {
      // Handle duplicate market error
      // Could retry with filtered params
      return { success: false, error: 'Duplicate market detected' };
    }
    
    if (error.message.includes('Batch too large')) {
      // Split into smaller batches
      const maxBatchSize = await marketFactory.MAX_BATCH_SIZE();
      return { success: false, error: `Reduce batch size to ${maxBatchSize}` };
    }

    return { success: false, error: error.message };
  }
}
```

---

## Monitoring & Analytics

### Track Gas Savings

```javascript
class GasAnalytics {
  constructor() {
    this.batchMetrics = [];
    this.individualMetrics = [];
  }

  recordBatch(itemCount, gasUsed) {
    this.batchMetrics.push({
      itemCount,
      gasUsed,
      gasPerItem: gasUsed / itemCount,
      timestamp: Date.now()
    });
  }

  recordIndividual(gasUsed) {
    this.individualMetrics.push({
      gasUsed,
      timestamp: Date.now()
    });
  }

  calculateSavings() {
    const avgBatchGasPerItem = this.batchMetrics.reduce(
      (sum, m) => sum + m.gasPerItem,
      0
    ) / this.batchMetrics.length;

    const avgIndividualGas = this.individualMetrics.reduce(
      (sum, m) => sum + m.gasUsed,
      0
    ) / this.individualMetrics.length;

    const savingsPercent = ((avgIndividualGas - avgBatchGasPerItem) / avgIndividualGas) * 100;

    return {
      avgBatchGasPerItem,
      avgIndividualGas,
      savingsPercent,
      totalBatches: this.batchMetrics.length,
      totalIndividual: this.individualMetrics.length
    };
  }
}

// Usage
const analytics = new GasAnalytics();

// Record batch operations
const tx = await marketFactory.batchDeployMarkets(params);
const receipt = await tx.wait();
analytics.recordBatch(params.length, receipt.gasUsed.toNumber());

// Generate report
const savings = analytics.calculateSavings();
console.log(`Gas savings: ${savings.savingsPercent.toFixed(2)}%`);
console.log(`Avg batch gas per item: ${savings.avgBatchGasPerItem.toFixed(0)}`);
console.log(`Avg individual gas: ${savings.avgIndividualGas.toFixed(0)}`);
```

---

## Conclusion

This integration guide provides the foundation for efficiently using batch operations and market discovery features. Key takeaways:

1. **Use batch operations** when handling 5+ items for significant gas savings
2. **Implement pagination** for all query operations to handle scale
3. **Set up event indexing** for production applications using The Graph or similar
4. **Cache query results** to minimize on-chain calls
5. **Monitor gas usage** to optimize batch sizes for your specific use case

For questions or support, please refer to the main [SCALABILITY_ARCHITECTURE.md](./SCALABILITY_ARCHITECTURE.md) document or reach out to the development team.
