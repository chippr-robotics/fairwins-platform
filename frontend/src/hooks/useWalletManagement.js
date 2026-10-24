import { useContext } from 'react'
import { WalletContext } from '../contexts/WalletContext'

/**
 * Primary hook for accessing unified wallet management
 * 
 * Provides complete wallet functionality including:
 * - Address and connection state
 * - Balances (native, wrapped-native, tokens)
 * - Transaction signing and sending
 * - RVAC role management
 * - Network state and switching
 * 
 * @returns {Object} Wallet context with all wallet functionality
 * @throws {Error} If used outside WalletProvider
 * 
 * @example
 * ```jsx
 * function MyComponent() {
 *   const { 
 *     address, 
 *     isConnected, 
 *     connectWallet,
 *     balances,
 *     hasRole,
 *     sendTransaction 
 *   } = useWallet()
 *   
 *   return (
 *     <div>
 *       {isConnected ? (
 *         <div>
 *           <p>Address: {address}</p>
 *           <p>Balance: {balances.native} POL</p>
 *           {hasRole('WAGER_PARTICIPANT') && <p>Wager Access</p>}
 *         </div>
 *       ) : (
 *         <button onClick={connectWallet}>Connect</button>
 *       )}
 *     </div>
 *   )
 * }
 * ```
 */
export function useWallet() {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}

/**
 * Hook to access only wallet address and connection state
 * Use this when you only need basic connection info
 * 
 * @returns {Object} Address and connection state
 * 
 * @example
 * ```jsx
 * function AddressDisplay() {
 *   const { address, isConnected } = useWalletAddress()
 *   return <div>{isConnected ? address : 'Not connected'}</div>
 * }
 * ```
 */
export function useWalletAddress() {
  const { address, account, isConnected } = useWallet()
  return { address, account, isConnected }
}

/**
 * Hook to access wallet balances
 * Use this for components that display or check balances
 * 
 * @returns {Object} Balances and loading state
 * 
 * @example
 * ```jsx
 * function BalanceDisplay() {
 *   const { balances, balancesLoading, refreshBalances } = useWalletBalances()
 *   
 *   return (
 *     <div>
 *       <p>Native: {balances.native}</p>
 *       <button onClick={refreshBalances}>Refresh</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useWalletBalances() {
  const { balances, balancesLoading, refreshBalances } = useWallet()
  return { balances, balancesLoading, refreshBalances }
}

/**
 * Hook to access transaction methods
 * Use this for components that send transactions
 * 
 * @returns {Object} Transaction methods and signer
 * 
 * @example
 * ```jsx
 * function SendTransaction() {
 *   const { sendTransaction, signMessage, signer } = useWalletTransactions()
 *   
 *   const handleSend = async () => {
 *     const tx = await sendTransaction({
 *       to: '0x...',
 *       value: ethers.parseEther('1.0')
 *     })
 *     await tx.wait()
 *   }
 * }
 * ```
 */
export function useWalletTransactions() {
  const { provider, signer, sendTransaction, signMessage } = useWallet()
  return { provider, signer, sendTransaction, signMessage }
}

/**
 * Hook to access RVAC role management
 * Use this for role-gated features and role purchases
 * 
 * @returns {Object} Role state and management methods
 * 
 * @example
 * ```jsx
 * function RoleGatedFeature() {
 *   const { roles, hasRole, grantRole } = useWalletRoles()
 *   
 *   if (!hasRole('WAGER_PARTICIPANT')) {
 *     return <div>Access denied</div>
 *   }
 *
 *   return <WagerPanel />
 * }
 * ```
 */
export function useWalletRoles() {
  const {
    roles,
    rolesLoading,
    blockchainSynced,
    refreshRoles,
    hasRole,
    hasAnyRole,
    hasAllRoles,
    grantRole,
    revokeRole
  } = useWallet()

  return {
    roles,
    rolesLoading,
    blockchainSynced,
    refreshRoles,
    hasRole,
    hasAnyRole,
    hasAllRoles,
    grantRole,
    revokeRole
  }
}

/**
 * Hook to access network state and switching
 * Use this for network-dependent features
 * 
 * @returns {Object} Network state and switch function
 * 
 * @example
 * ```jsx
 * function NetworkCheck() {
 *   const { chainId, isCorrectNetwork, networkError, switchNetwork } = useWalletNetwork()
 *   
 *   if (networkError) {
 *     return (
 *       <div>
 *         <p>{networkError}</p>
 *         <button onClick={switchNetwork}>Switch Network</button>
 *       </div>
 *     )
 *   }
 * }
 * ```
 */
export function useWalletNetwork() {
  const { chainId, networkError, isCorrectNetwork, switchNetwork } = useWallet()
  return { chainId, networkError, isCorrectNetwork, switchNetwork }
}

/**
 * Hook to access wallet connection methods
 * Use this for connect/disconnect buttons
 * 
 * @returns {Object} Connection methods and state
 * 
 * @example
 * ```jsx
 * function ConnectButton() {
 *   const { isConnected, connectWallet, disconnectWallet, connectors } = useWalletConnection()
 *   
 *   return (
 *     <button onClick={isConnected ? disconnectWallet : connectWallet}>
 *       {isConnected ? 'Disconnect' : 'Connect'}
 *     </button>
 *   )
 * }
 * ```
 */
export function useWalletConnection() {
  const { isConnected, connectWallet, disconnectWallet, connectors } = useWallet()
  return { isConnected, connectWallet, disconnectWallet, connectors }
}
