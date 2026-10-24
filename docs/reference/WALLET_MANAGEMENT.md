# Unified Wallet Management System

## Overview

The Prediction DAO frontend now features a harmonized wallet management system that provides a single, cohesive interface for all wallet-related operations throughout the application. This system consolidates wallet connection, transaction signing, balance management, and RVAC (Role-Based Access Control) into a unified context.

## Wallet Connection Options

The application supports multiple wallet connection methods:

1. **MetaMask / Browser Wallet** - Using injected provider (MetaMask, Brave, etc.)
2. **WalletConnect** - Mobile wallets and other WalletConnect-compatible wallets

### WalletConnect Setup

WalletConnect is always available in the wallet connection modal, enabling hardware wallet support out of the box. The application uses a fallback project ID for development and testing purposes.

**For Production Use:**

1. **Get a Project ID**:
   - Visit [WalletConnect Cloud](https://cloud.walletconnect.com)
   - Create a new project
   - Copy your Project ID

2. **Configure Environment**:
   Add the Project ID to your `.env` file:
   ```bash
   VITE_WALLETCONNECT_PROJECT_ID=your_project_id_here
   ```

3. **Whitelist Your Domain**:
   - In WalletConnect Cloud dashboard
   - Add your domain(s) to the allowed origins
   - Include both production and development URLs

4. **Test Connection**:
   - Click the profile icon (👤) when not connected
   - Select "WalletConnect" from the connector options
   - Scan QR code with your mobile wallet
   - Approve the connection request

**Note**: If `VITE_WALLETCONNECT_PROJECT_ID` is not set, a fallback demo project ID will be used. This is suitable for development and testing, but for production deployments, you should configure your own project ID for better reliability and to avoid rate limiting.

## Architecture

### WalletContext (`src/contexts/WalletContext.jsx`)

The `WalletContext` is the central hub for all wallet-related state and operations. It provides:

- **Wallet Connection**: Connect/disconnect wallet with automatic provider setup
- **Multiple Connectors**: Support for injected wallets and WalletConnect
- **Address Management**: Current wallet address and connection state
- **Provider & Signer**: Ethers.js provider and signer instances for transactions
- **Balance Tracking**: Native token, wrapped native token, and other token balances
- **Network Management**: Network detection, validation, and switching
- **RVAC Integration**: Role management tied directly to wallet address
- **Transaction Helpers**: Utilities for sending transactions and signing messages

### Key Features

1. **Single Source of Truth**: All wallet state is managed in one place
2. **Multiple Wallet Support**: Injected wallets (MetaMask) and WalletConnect
3. **RVAC Integration**: User roles are automatically loaded and managed based on wallet address
4. **Balance Caching**: Token balances are cached to reduce RPC calls
5. **Network Validation**: Automatic detection of wrong network with switch capability
6. **Transaction Support**: Helper methods for common transaction operations

## Usage

### Primary Hook: `useWallet()`

The main hook that provides access to all wallet functionality:

```jsx
import { useWallet } from '../hooks'

function MyComponent() {
  const { 
    address,           // Current wallet address
    isConnected,       // Connection state
    balances,          // { native, wnative, tokens }
    provider,          // Ethers provider
    signer,            // Ethers signer
    connectWallet,     // Connect function
    disconnectWallet,  // Disconnect function
    sendTransaction,   // Send transaction helper
    hasRole,           // Check if user has RVAC role
    grantRole,         // Grant RVAC role (for purchase flows)
  } = useWallet()
  
  // Use wallet functionality...
}
```

### Specialized Hooks

For components that only need specific wallet functionality, use the specialized hooks:

#### `useWalletAddress()`
For components that only need address and connection state:

```jsx
import { useWalletAddress } from '../hooks'

function AddressDisplay() {
  const { address, isConnected } = useWalletAddress()
  return <div>{isConnected ? address : 'Not connected'}</div>
}
```

#### `useWalletBalances()`
For components that display or check balances:

```jsx
import { useWalletBalances } from '../hooks'

function BalanceDisplay() {
  const { balances, refreshBalances } = useWalletBalances()
  
  return (
    <div>
      <p>MATIC Balance: {balances.native}</p>
      <button onClick={refreshBalances}>Refresh</button>
    </div>
  )
}
```

#### `useWalletTransactions()`
For components that send transactions:

```jsx
import { useWalletTransactions } from '../hooks'
import { ethers } from 'ethers'

function SendTransaction() {
  const { sendTransaction, signMessage } = useWalletTransactions()
  
  const handleSend = async () => {
    const tx = await sendTransaction({
      to: '0x...',
      value: ethers.parseEther('1.0')
    })
    await tx.wait()
  }
  
  return <button onClick={handleSend}>Send</button>
}
```

#### `useWalletRoles()`
For RVAC role-gated features:

```jsx
import { useWalletRoles } from '../hooks'

function RoleGatedFeature() {
  const { hasRole, roles } = useWalletRoles()
  
  if (!hasRole('MARKET_MAKER')) {
    return <div>You need Market Maker access</div>
  }
  
  return <MarketMakerPanel />
}
```

#### `useWalletNetwork()`
For network-dependent features:

```jsx
import { useWalletNetwork } from '../hooks'

function NetworkCheck() {
  const { isCorrectNetwork, networkError, switchNetwork } = useWalletNetwork()
  
  if (networkError) {
    return (
      <div>
        <p>{networkError}</p>
        <button onClick={switchNetwork}>Switch Network</button>
      </div>
    )
  }
  
  return <div>Connected to correct network</div>
}
```

#### `useWalletConnection()`
For connect/disconnect buttons:

```jsx
import { useWalletConnection } from '../hooks'

function ConnectButton() {
  const { isConnected, connectWallet, disconnectWallet } = useWalletConnection()
  
  return (
    <button onClick={isConnected ? disconnectWallet : connectWallet}>
      {isConnected ? 'Disconnect' : 'Connect Wallet'}
    </button>
  )
}
```

## RVAC Integration

The wallet system integrates RVAC (Role-Based Access Control) management directly with the wallet address. This means:

1. **Automatic Loading**: When a wallet connects, user roles are automatically loaded
2. **Address-Tied Roles**: Roles are stored and retrieved based on wallet address
3. **Purchase Flow**: Role purchases use the wallet system for both payment and role assignment
4. **Role Checking**: Components can easily check roles without separate context

### Example: Role Purchase Flow

```jsx
import { useWallet, useWalletRoles } from '../hooks'

function RolePurchase() {
  const { address, isConnected, sendTransaction } = useWallet()
  const { hasRole, grantRole } = useWalletRoles()
  
  const handlePurchase = async (role, price) => {
    if (!isConnected) {
      alert('Please connect wallet')
      return
    }
    
    // Send payment transaction
    const tx = await sendTransaction({
      to: PAYMENT_ADDRESS,
      value: ethers.parseEther(price.toString())
    })
    await tx.wait()
    
    // Grant role to user
    grantRole(role)
  }
  
  return (
    <button onClick={() => handlePurchase('MARKET_MAKER', 100)}>
      Purchase Market Maker Role (100)
    </button>
  )
}
```

## Transaction Flow

The wallet system provides helpers for common transaction operations:

### 1. Sending Transactions

```jsx
const { sendTransaction } = useWallet()

const tx = await sendTransaction({
  to: recipientAddress,
  value: ethers.parseEther('1.0'),
  data: '0x...' // optional
})

const receipt = await tx.wait()
```

### 2. Signing Messages

```jsx
const { signMessage } = useWallet()

const signature = await signMessage('Hello World')
```

### 3. Contract Interactions

```jsx
const { signer } = useWallet()

const contract = new ethers.Contract(address, abi, signer)
const tx = await contract.someMethod(params)
await tx.wait()
```

## Balance Management

The wallet system automatically tracks and caches balances:

### Native Balance (MATIC)
Automatically loaded when wallet connects and can be refreshed:

```jsx
const { balances, refreshBalances } = useWallet()

console.log(`MATIC Balance: ${balances.native}`)
await refreshBalances() // Manually refresh
```

### Token Balances

`getTokenBalance` was removed in spec 110. It had no caller, nothing read the
`balances.tokens` cache it wrote, and it formatted every token with 18 decimals — so a USDC
balance came back a million million times too small. Read a named token where its decimals are
known:

```jsx
import { readContract } from '../lib/chains/readContract'
import { formatUnits } from '../lib/evm/units'

const raw = await readContract(chainId, {
  address: tokenAddress,
  abi: ['function balanceOf(address) view returns (uint256)'],
  functionName: 'balanceOf',
  args: [account],
})
const shown = formatUnits(raw, decimals)  // the TOKEN's decimals, not 18
```

## Network Management

The wallet system handles network validation and switching:

```jsx
const { 
  isCorrectNetwork,  // Boolean: on expected network?
  networkError,      // String: error message if wrong network
  switchNetwork      // Function: switch to correct network
} = useWallet()

if (!isCorrectNetwork) {
  return (
    <div>
      <p>{networkError}</p>
      <button onClick={switchNetwork}>Switch Network</button>
    </div>
  )
}
```

## Migration Guide

### From Old Pattern

**Before:**
```jsx
import { useWeb3 } from '../hooks/useWeb3'
import { useRoles } from '../hooks/useRoles'

function MyComponent() {
  const { account, provider, signer } = useWeb3()
  const { hasRole } = useRoles()
  
  // Component logic...
}
```

**After:**
```jsx
import { useWallet } from '../hooks'

function MyComponent() {
  const { address, provider, signer, hasRole } = useWallet()
  
  // Component logic...
  // Note: 'account' is now 'address' (though 'account' still works as alias)
}
```

### Backwards Compatibility

The old hooks (`useWeb3`, `useRoles`) are still available for backwards compatibility during migration. New code should use the unified `useWallet` hook.

## Provider Hierarchy

The wallet system is integrated into the app's provider hierarchy:

```jsx
<WagmiProvider>
  <QueryClientProvider>
    <ThemeProvider>
      <WalletProvider>          {/* the unified blockchain context - single source of truth */}
        <CustodyProvider>
          <UserPreferencesProvider>
            <PrivacyProvider>
              <FriendMarketsProvider>
                <DexProvider>
                  <UIProvider>
                    <PriceProvider>
                      <App />
                    </PriceProvider>
                  </UIProvider>
                </DexProvider>
              </FriendMarketsProvider>
            </PrivacyProvider>
          </UserPreferencesProvider>
        </CustodyProvider>
      </WalletProvider>
    </ThemeProvider>
  </QueryClientProvider>
</WagmiProvider>
```

This tree used to be drawn with `Web3Provider` and `RoleProvider` in it, marked "legacy -
backwards compatibility". **Neither was ever mounted.** `useWeb3()` and `useRoles()` both read
`WalletContext`; `RoleContext` exports only constants, and `Web3Context`'s provider was deleted
in spec 110 as dead code. A doc that draws a provider the app does not render is worse than one
that omits it, because a reader trusts it and debugs the wrong thing.

## Best Practices

1. **Use Specialized Hooks**: Use `useWalletRoles()`, `useWalletBalances()`, etc. when you only need specific functionality to avoid unnecessary re-renders

2. **Check Connection State**: Always check `isConnected` before performing wallet operations

3. **Handle Errors**: Wrap wallet operations in try-catch blocks and provide user feedback

4. **Refresh Balances**: Call `refreshBalances()` after transactions that change balances

5. **Role Gating**: Use `hasRole()` to gate features that require specific RVAC roles

## Examples

### Complete Wallet Integration Example

```jsx
import { useWallet, useWalletRoles } from '../hooks'
import { useNotification } from '../hooks/useUI'
import { ethers } from 'ethers'

function CompleteExample() {
  const { 
    address, 
    isConnected, 
    balances,
    connectWallet,
    sendTransaction,
    isCorrectNetwork,
    switchNetwork
  } = useWallet()
  
  const { hasRole, grantRole } = useWalletRoles()
  const { showNotification } = useNotification()
  
  const handlePurchaseRole = async () => {
    try {
      // Check connection
      if (!isConnected) {
        await connectWallet()
      }
      
      // Check network
      if (!isCorrectNetwork) {
        await switchNetwork()
      }
      
      // Send payment
      const tx = await sendTransaction({
        to: PAYMENT_ADDRESS,
        value: ethers.parseEther('100')
      })
      
      showNotification('Transaction submitted...', 'info')
      await tx.wait()
      
      // Grant role
      grantRole('MARKET_MAKER')
      showNotification('Role purchased successfully!', 'success')
      
    } catch (error) {
      console.error(error)
      showNotification('Purchase failed: ' + error.message, 'error')
    }
  }
  
  return (
    <div>
      {isConnected ? (
        <div>
          <p>Address: {address}</p>
          <p>Balance: {balances.native} MATIC</p>
          {hasRole('MARKET_MAKER') ? (
            <p>You have Market Maker access!</p>
          ) : (
            <button onClick={handlePurchaseRole}>
              Purchase Market Maker Role (100)
            </button>
          )}
        </div>
      ) : (
        <button onClick={connectWallet}>Connect Wallet</button>
      )}
    </div>
  )
}
```

## API Reference

### WalletContext Value

```typescript
{
  // Connection State
  address: string | null              // Current wallet address
  account: string | null              // Alias for address (backwards compat)
  isConnected: boolean                // Wallet connected?
  chainId: number | undefined         // Current chain ID
  
  // Provider & Signer
  provider: BrowserProvider | null    // Ethers provider instance
  signer: Signer | null              // Ethers signer instance
  
  // Network State
  networkError: string | null         // Network error message
  isCorrectNetwork: boolean           // On correct network?
  
  // Balances
  balances: {
    native: string                    // Native token balance
    wnative: string                   // Wrapped native balance
    tokens: Record<string, string>    // Token address -> balance
  }
  balancesLoading: boolean            // Loading balances?
  
  // RVAC Roles
  roles: string[]                     // Current user roles
  rolesLoading: boolean               // Loading roles?
  
  // Wallet Actions
  connectWallet: () => Promise<boolean>
  disconnectWallet: () => void
  switchNetwork: () => Promise<boolean>
  
  // Transaction Methods
  sendTransaction: (tx: TransactionRequest) => Promise<TransactionResponse>
  signMessage: (message: string) => Promise<string>
  
  // Balance Methods
  refreshBalances: () => Promise<void>
  
  // RVAC Role Methods
  hasRole: (role: string) => boolean
  hasAnyRole: (roles: string[]) => boolean
  hasAllRoles: (roles: string[]) => boolean
  grantRole: (role: string) => boolean
  revokeRole: (role: string) => boolean
}
```

## Troubleshooting

### Issue: Wallet not connecting

**Solution**: Ensure MetaMask is installed and the user approves the connection request.

### Issue: Wrong network error

**Solution**: Use the `switchNetwork()` function or manually switch in MetaMask.

### Issue: Balances not updating

**Solution**: Call `refreshBalances()` after transactions that change balances.

### Issue: Roles not loading

**Solution**: Roles are tied to wallet address. Ensure wallet is connected and roles are stored in localStorage.

## Future Enhancements

- Multi-wallet support
- Transaction history tracking
- Gas estimation helpers
- Smart contract interaction helpers
- ENS name resolution
- Hardware wallet support
