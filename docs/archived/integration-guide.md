# CTF 1155 and PredictionMarketExchange Integration Guide

## Overview

This guide demonstrates how to integrate the CTF 1155 conditional tokens with the PredictionMarketExchange for gas-efficient, permissionless prediction market trading on Polygon.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     User Applications                     │
│  (Trading Bots, Market Makers, Arbitrageurs, Frontends)  │
└─────────────────────┬────────────────────────────────────┘
                      │
                      ├─── EIP-712 Signed Orders ───┐
                      │                               │
           ┌──────────▼──────────┐      ┌───────────▼────────────┐
           │  PMKT/1 DevP2P     │      │  Direct On-Chain      │
           │  Order Gossip       │      │  Trading              │
           └──────────┬──────────┘      └───────────┬───────────┘
                      │                              │
                      └─────────────┬────────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │  PredictionMarketExchange   │
                     │  (Order Matching)            │
                     └──────────────┬───────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │  CTF1155                     │
                     │  (Conditional Tokens)        │
                     └──────────────┬───────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │  ERC20 Collateral Tokens     │
                     └──────────────────────────────┘
```

## Quick Start

### 1. Deploy Contracts

```javascript
const { ethers } = require("hardhat");

async function deployContracts() {
  const [deployer, feeRecipient] = await ethers.getSigners();
  
  // Deploy CTF1155
  const CTF1155 = await ethers.getContractFactory("CTF1155");
  const ctf = await CTF1155.deploy();
  await ctf.waitForDeployment();
  console.log("CTF1155 deployed at:", await ctf.getAddress());
  
  // Deploy Exchange
  const Exchange = await ethers.getContractFactory("PredictionMarketExchange");
  const exchange = await Exchange.deploy(feeRecipient.address);
  await exchange.waitForDeployment();
  console.log("Exchange deployed at:", await exchange.getAddress());
  
  return { ctf, exchange };
}
```

### 2. Create a Prediction Market

```javascript
async function createMarket(ctf, oracle, collateralToken) {
  // Prepare a binary outcome condition
  const questionId = ethers.encodeBytes32String("Will it rain tomorrow?");
  
  const tx = await ctf.prepareCondition(
    oracle.address,
    questionId,
    2  // Binary outcome: YES/NO
  );
  await tx.wait();
  
  // Get condition ID
  const conditionId = await ctf.getConditionId(oracle.address, questionId, 2);
  console.log("Condition ID:", conditionId);
  
  return { questionId, conditionId };
}
```

### 3. Split Collateral into Conditional Tokens

```javascript
async function splitCollateral(ctf, user, collateralToken, conditionId, amount) {
  // Approve collateral
  await collateralToken.connect(user).approve(
    await ctf.getAddress(),
    amount
  );
  
  // Split into YES (index 1) and NO (index 2) positions
  const partition = [1, 2]; // Binary: 01 and 10
  const parentCollectionId = ethers.ZeroHash;
  
  await ctf.connect(user).splitPosition(
    await collateralToken.getAddress(),
    parentCollectionId,
    conditionId,
    partition,
    amount
  );
  
  // Get position IDs
  const yesCollectionId = await ctf.getCollectionId(parentCollectionId, conditionId, 1);
  const noCollectionId = await ctf.getCollectionId(parentCollectionId, conditionId, 2);
  
  const yesPositionId = await ctf.getPositionId(await collateralToken.getAddress(), yesCollectionId);
  const noPositionId = await ctf.getPositionId(await collateralToken.getAddress(), noCollectionId);
  
  console.log("YES position ID:", yesPositionId);
  console.log("NO position ID:", noPositionId);
  
  return { yesPositionId, noPositionId };
}
```

### 4. Create and Sign an Order (EIP-712)

```javascript
async function createSignedOrder(maker, exchange, ctf, makerTokenId, takerTokenId, amount) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  
  // Create order
  const order = {
    maker: maker.address,
    makerAsset: await ctf.getAddress(),
    takerAsset: await ctf.getAddress(),
    makerAmount: amount,
    takerAmount: amount,
    nonce: Date.now(),  // Use timestamp as nonce
    expiration: Math.floor(Date.now() / 1000) + 3600,  // 1 hour from now
    salt: ethers.randomBytes(32),
    isMakerERC1155: true,
    isTakerERC1155: true,
    makerTokenId: makerTokenId,
    takerTokenId: takerTokenId
  };
  
  // EIP-712 domain
  const domain = {
    name: "PredictionMarketExchange",
    version: "1",
    chainId: chainId,
    verifyingContract: await exchange.getAddress()
  };
  
  // EIP-712 types
  const types = {
    Order: [
      { name: "maker", type: "address" },
      { name: "makerAsset", type: "address" },
      { name: "takerAsset", type: "address" },
      { name: "makerAmount", type: "uint256" },
      { name: "takerAmount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "expiration", type: "uint256" },
      { name: "salt", type: "bytes32" },
      { name: "isMakerERC1155", type: "bool" },
      { name: "isTakerERC1155", type: "bool" },
      { name: "makerTokenId", type: "uint256" },
      { name: "takerTokenId", type: "uint256" }
    ]
  };
  
  // Sign order
  const signature = await maker.signTypedData(domain, types, order);
  
  console.log("Order created and signed");
  console.log("Order hash:", await exchange.getOrderHash(order));
  
  return { order, signature };
}
```

### 5. Fill an Order

```javascript
async function fillOrder(exchange, ctf, taker, order, signature, amount) {
  // Approve exchange to spend taker's tokens
  await ctf.connect(taker).setApprovalForAll(await exchange.getAddress(), true);
  
  // Fill order
  const tx = await exchange.connect(taker).fillOrder(
    order,
    signature,
    amount
  );
  
  const receipt = await tx.wait();
  console.log("Order filled!");
  console.log("Gas used:", receipt.gasUsed.toString());
  
  return receipt;
}
```

### 6. Batch Fill Orders

```javascript
async function batchFillOrders(exchange, taker, orders, signatures, amounts) {
  const tx = await exchange.connect(taker).batchFillOrders(
    orders,
    signatures,
    amounts
  );
  
  const receipt = await tx.wait();
  console.log("Batch filled!");
  console.log("Gas used:", receipt.gasUsed.toString());
  
  return receipt;
}
```

### 7. Resolve Market and Redeem Positions

```javascript
async function resolveAndRedeem(ctf, oracle, user, questionId, conditionId, collateralToken, positionIds) {
  // Oracle reports outcome: YES wins
  await ctf.connect(oracle).reportPayouts(questionId, [1, 0]);
  console.log("Market resolved");
  
  // User redeems winning positions
  await ctf.connect(user).redeemPositions(
    await collateralToken.getAddress(),
    ethers.ZeroHash,
    conditionId,
    [1]  // Redeem YES position
  );
  
  console.log("Positions redeemed");
}
```

## Complete End-to-End Example

```javascript
async function completeExample() {
  // 1. Setup
  const [deployer, oracle, maker, taker, feeRecipient] = await ethers.getSigners();
  
  // Deploy collateral token
  const MockERC20 = await ethers.getContractFactory("ConditionalToken");
  const collateral = await MockERC20.deploy("USDC", "USDC");
  await collateral.waitForDeployment();
  
  // Mint collateral
  await collateral.mint(maker.address, ethers.parseEther("1000"));
  await collateral.mint(taker.address, ethers.parseEther("1000"));
  
  // Deploy contracts
  const { ctf, exchange } = await deployContracts();
  
  // 2. Create market
  const { questionId, conditionId } = await createMarket(ctf, oracle, collateral);
  
  // 3. Maker splits collateral into YES/NO positions
  const { yesPositionId, noPositionId } = await splitCollateral(
    ctf,
    maker,
    collateral,
    conditionId,
    ethers.parseEther("100")
  );
  
  // 4. Taker splits collateral into YES/NO positions
  await splitCollateral(
    ctf,
    taker,
    collateral,
    conditionId,
    ethers.parseEther("100")
  );
  
  // 5. Maker creates order: Sell YES for NO
  await ctf.connect(maker).setApprovalForAll(await exchange.getAddress(), true);
  await ctf.connect(taker).setApprovalForAll(await exchange.getAddress(), true);
  
  const { order, signature } = await createSignedOrder(
    maker,
    exchange,
    ctf,
    yesPositionId,  // Maker selling YES
    noPositionId,   // Maker wants NO
    ethers.parseEther("50")
  );
  
  // 6. Taker fills order
  await fillOrder(exchange, ctf, taker, order, signature, ethers.parseEther("50"));
  
  // 7. Oracle resolves market
  await resolveAndRedeem(ctf, oracle, maker, questionId, conditionId, collateral, [noPositionId]);
  await resolveAndRedeem(ctf, oracle, taker, questionId, conditionId, collateral, [yesPositionId]);
  
  console.log("Complete example finished!");
}
```

## Advanced: Matcher/Arbitrage Bot

```javascript
class OrderMatcher {
  constructor(exchange, ctf) {
    this.exchange = exchange;
    this.ctf = ctf;
    this.orderBook = new Map();
  }
  
  // Subscribe to new orders via PMKT/1
  async handleNewOrder(order, signature) {
    // Validate signature
    const orderHash = await this.exchange.getOrderHash(order);
    // TODO: Verify signature against orderHash
    
    // Add to order book
    this.orderBook.set(orderHash, { order, signature });
    
    // Try to match with existing orders
    await this.matchOrders();
  }
  
  async matchOrders() {
    const orders = Array.from(this.orderBook.values());
    
    for (let i = 0; i < orders.length; i++) {
      for (let j = i + 1; j < orders.length; j++) {
        const order1 = orders[i].order;
        const order2 = orders[j].order;
        
        // Check if orders are compatible
        if (this.areOrdersCompatible(order1, order2)) {
          console.log("Found matching orders!");
          
          // Calculate profitable fill amount
          const fillAmount = this.calculateOptimalFill(order1, order2);
          
          if (fillAmount > 0) {
            // Submit matched orders on-chain
            await this.exchange.matchOrders(
              order1,
              orders[i].signature,
              order2,
              orders[j].signature,
              fillAmount
            );
          }
        }
      }
    }
  }
  
  areOrdersCompatible(order1, order2) {
    return (
      order1.makerAsset === order2.takerAsset &&
      order1.takerAsset === order2.makerAsset &&
      order1.makerTokenId === order2.takerTokenId &&
      order1.takerTokenId === order2.makerTokenId
    );
  }
  
  calculateOptimalFill(order1, order2) {
    // Simple implementation: fill minimum available
    const available1 = order1.makerAmount;
    const available2 = order2.makerAmount;
    return available1 < available2 ? available1 : available2;
  }
}
```

## Gas Optimization Tips

### 1. Use Batch Operations

```javascript
// Instead of multiple single fills:
for (const order of orders) {
  await exchange.fillOrder(order, signature, amount);  // ~141k gas each
}

// Use batch fill:
await exchange.batchFillOrders(orders, signatures, amounts);  // ~120k gas per order
```

### 2. Approve Once

```javascript
// Approve exchange for all future trades
await ctf.setApprovalForAll(await exchange.getAddress(), true);
```

### 3. Use Maker-to-Maker Matching

```javascript
// Direct maker-to-maker (no intermediary)
await exchange.matchOrders(orderA, sigA, orderB, sigB, amount);
// Saves gas by eliminating transfer to/from taker
```

## Security Best Practices

### 1. Validate Orders Off-Chain

```javascript
// Check order validity before submitting
function isOrderValid(order) {
  return (
    order.expiration > Math.floor(Date.now() / 1000) &&
    order.makerAmount > 0 &&
    order.takerAmount > 0 &&
    order.maker !== ethers.ZeroAddress
  );
}
```

### 2. Set Reasonable Expiration

```javascript
// Use short expiration for active trading
const order = {
  ...
  expiration: Math.floor(Date.now() / 1000) + 300  // 5 minutes
};
```

### 3. Monitor For Front-Running

```javascript
// Use flashbots or private mempools for large orders
// Or submit with higher gas price for faster inclusion
const tx = await exchange.fillOrder(order, signature, amount, {
  gasPrice: ethers.parseUnits("10", "gwei")
});
```

## Deployment Checklist

- [ ] Deploy CTF1155 contract
- [ ] Deploy PredictionMarketExchange contract
- [ ] Set fee recipient
- [ ] Configure fee percentage (if not using default 0.1%)
- [ ] Deploy or identify collateral token contracts
- [ ] Test on testnet (Amoy) first
- [ ] Verify contracts on block explorer
- [ ] Set up PMKT/1 nodes for order propagation
- [ ] Deploy monitoring and analytics
- [ ] Create frontend interface
- [ ] Write integration tests
- [ ] Conduct security audit
- [ ] Prepare incident response plan

## Troubleshooting

### Order Signature Invalid

- Verify EIP-712 domain parameters match
- Check chainId is correct (137 for Polygon mainnet)
- Ensure order fields match exactly
- Verify signer has proper permissions

### Insufficient Balance

- Check user has approved exchange contract
- Verify user has sufficient token balance
- Ensure tokens are not already committed to other orders

### Transaction Reverts

- Check gas limit is sufficient
- Verify order hasn't expired
- Ensure order hasn't been cancelled
- Check if order is already filled

## References

- [CTF1155 Contract](../contracts/CTF1155.sol)
- [PredictionMarketExchange Contract](../contracts/PredictionMarketExchange.sol)
- [PMKT/1 Protocol Spec](./pmkt-protocol-spec.md)
- [EIP-712 Specification](https://eips.ethereum.org/EIPS/eip-712)
- [Gnosis CTF Documentation](https://docs.gnosis.io/conditionaltokens/)

## Support

For questions or issues:
- GitHub Issues: [chippr-robotics/prediction-dao-research](https://github.com/chippr-robotics/fairwins-platform/issues)
- Email: howdy@FairWins.app
