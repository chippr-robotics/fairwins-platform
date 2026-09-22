// Web3 hooks (legacy)
export { 
  useWeb3, 
  useAccount, 
  useNetwork, 
  useEthers 
} from './useWeb3'

// Unified Wallet Management hooks (primary)
export {
  useWallet,
  useWalletAddress,
  useWalletBalances,
  useWalletTransactions,
  useWalletRoles,
  useWalletNetwork,
  useWalletConnection
} from './useWalletManagement'

// The chain the WALLET is on (issue #1030) — the ONLY answer to that question. wagmi's
// `useChainId()` is banned outright (spec 110 Phase 3, #1594): it can only ever report a chain
// this build configures, so it named the wrong one whenever the wallet was somewhere else.
export { useWalletChainId } from './useWalletChainId'

// DEX hooks
export { useDex } from './useDex'

// UI hooks
export { 
  useUI, 
  useNotification, 
  useAnnouncement, 
  useModal, 
  useError 
} from './useUI'

// Theme hooks
export { useTheme } from './useTheme'

// Blockchain event hooks
export {
  useContractEvent,
  useContractEvents,
  useAccountChange,
  useChainChange
} from './useBlockchainEvents'

// Responsive hooks
export {
  useMediaQuery,
  useIsMobile,
  useIsTablet,
  useOrientation,
  useDeviceInfo
} from './useMediaQuery'

// Scroll hooks
export {
  useScrollDirection,
  useScrollPast
} from './useScrollDirection'

// Role hooks
export { useRoles } from './useRoles'
export {
  useRoleDetails,
  MembershipTier,
  TIER_NAMES,
  TIER_COLORS,
  ROLE_BYTES32
} from './useRoleDetails'

// ENS Resolution hooks
export {
  useEnsResolution,
  useEnsReverseLookup,
  useAddressInput
} from './useEnsResolution'

// Encryption hooks (for friend market privacy)
export {
  useEncryption,
  useDecryptedMarkets,
  useLazyMarketDecryption
} from './useEncryption'

// Friend market creation hook
export { useFriendMarketCreation } from './useFriendMarketCreation'

// Friend market notification hooks
export { useFriendMarketNotifications } from './useFriendMarketNotifications'
export { createUnreadMarketTracker } from './useUnreadMarketTracker'

// Paginated My Wagers query
export { useMyWagers } from './useMyWagers'

// Testnet/Mainnet toggle
export { useNetworkMode } from './useNetworkMode'

// Polymarket Gamma API event search
export { usePolymarketSearch } from './usePolymarketSearch'

// IPFS hooks (for decentralized storage)
export {
  useIpfs,
  useTokenMetadata,
  useMarketData,
  useMarketMetadata,
  useIpfsByCid,
  useBatchIpfs,
  useIpfsCache,
  useLazyIpfsEnvelope,
  useLazyMarketMetadata
} from './useIpfs'


// Pay & Transfer (wallet stablecoin/native send + activity)
export { useTransfer, TRANSFER_KIND } from './useTransfer'
export { useTransferActivity } from './useTransferActivity'

// Privacy (tilt-to-hide) live viewing state (spec 047)
export { usePrivacy } from './usePrivacy'
