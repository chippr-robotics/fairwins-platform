/**
 * The ethers import ratchet (spec 110, Phase 0 — issue #1591).
 *
 * Every file listed here still imports 'ethers' and is EXEMPT from the no-restricted-imports
 * ban in eslint.config.js. The list only ever SHRINKS: converting a file to the viem seams
 * (Phases 1-2) removes its line, and a PR that adds a line is reintroducing the dependency
 * this migration exists to remove. src/test/lint/ethersRatchet.test.js fails on a stale
 * entry (a listed file that no longer imports ethers), so the list cannot rot upward.
 *
 * THREE ENTRIES ARE NOT A CONVERSION, THEY ARE A DECISION, and are called out so nobody
 * spends an afternoon rediscovering it:
 *
 *   - `lib/pools/bip39Lists.js`, `lib/recovery/bip39Suggest.js`, `utils/claimCode/wordlist.js`
 *     import ethers' bundled BIP-39 `wordlists`. viem bundles none, so these cannot move
 *     without adding a wordlist dependency (`@scure/bip39`) — a lockfile change, which under
 *     spec 075 is the one that drops the platform rolldown binary. That is a deliberate,
 *     separately-reviewed step, not a mechanical swap.
 *   - `lib/miniapps/hostScope.js` hands ethers to third-party mini-app packages as a shared
 *     module. That is the spec-073 host API contract (hostApi 2), not an internal dependency:
 *     removing it breaks published packages, so it belongs to Phase 5 (#1596).
 *   - `utils/rpcProvider.js` is the seam being replaced; it leaves last, when its final
 *     caller does (T014).
 */
export const ETHERS_ALLOWLIST = [
  'src/components/account/CallsignPanel.jsx',
  'src/components/account/RecoverAccountPanel.jsx',
  'src/components/account/__tests__/CallsignPanel.passkey.test.jsx',
  'src/components/admin/BridgeTab.jsx',
  'src/components/admin/CallsignRegistryAdmin.jsx',
  'src/components/admin/DenyListAdmin.jsx',
  'src/components/admin/FeesTab.jsx',
  'src/components/admin/MaintenanceTab.jsx',
  'src/components/admin/MiniAppReviewTab.jsx',
  'src/components/admin/OracleAdaptersTab.jsx',
  'src/components/admin/PaymasterOpsCard.jsx',
  'src/components/admin/PerpsFeesPanel.jsx',
  'src/components/admin/ProtocolConfigTab.jsx',
  'src/components/admin/StakingTab.jsx',
  'src/components/admin/SupplyTab.jsx',
  'src/components/admin/apps/AccessControlApp.jsx',
  'src/components/admin/apps/IncidentResponseApp.jsx',
  'src/components/admin/apps/LiquidityApp.jsx',
  'src/components/admin/apps/MembershipRevenueApp.jsx',
  'src/components/admin/perpsFeeRails.js',
  'src/components/admin/useAdminTx.js',
  'src/components/earn/SupplyView.jsx',
  'src/components/fairwins/MarketAcceptanceModal.jsx',
  'src/components/fairwins/MyMarketsModal.jsx',
  'src/components/miniapps/SubmitAppPanel.jsx',
  'src/contexts/DexContext.jsx',
  'src/contexts/WalletContext.jsx',
  'src/contexts/Web3Context.jsx',
  'src/data/wagers/EventsSource.js',
  'src/hooks/useFriendMarketCreation.js',
  'src/hooks/useFundingPools.js',
  'src/hooks/useNullifierContracts.js',
  'src/hooks/useOpenChallengeAccept.js',
  'src/hooks/useOpenChallengeCreate.js',
  'src/hooks/useOracleConditions.js',
  'src/hooks/usePools.js',
  'src/hooks/useTransfer.js',
  'src/hooks/useTreasuryVault.js',
  'src/hooks/useVaultProposals.js',
  'src/hooks/useVaultQueueAcrossChains.js',
  'src/hooks/useVouchers.js',
  'src/hooks/useWrapNative.js',
  'src/lib/apiAccess/apiKeys.js',
  'src/lib/backup/backupRegistry.js',
  'src/lib/bridge/__tests__/bridgeRouter.test.js',
  'src/lib/bridge/bridgeStatus.js',
  'src/lib/clearpath/connectors/governorBravo.js',
  'src/lib/clearpath/connectors/ozGovernor.js',
  'src/lib/custody/policy.js',
  'src/lib/custody/policyV2.js',
  'src/lib/custody/proposalHub.js',
  'src/lib/custody/safeVault.js',
  'src/lib/custody/submitAsActiveAccount.js',
  'src/lib/custody/vaultDeployment.js',
  'src/lib/custody/vaultTransaction.js',
  'src/lib/earn/vaultActions.js',
  'src/lib/funding/fundingContracts.js',
  'src/lib/hardware/hardwareSigner.js',
  'src/lib/liquidity/__tests__/acrossLpPositions.test.js',
  'src/lib/liquidity/__tests__/liquidityRouter.test.js',
  'src/lib/liquidity/__tests__/uniswapPositions.test.js',
  'src/lib/miniapps/hostScope.js',
  'src/lib/passkey/intentSigner.js',
  'src/lib/payments/__tests__/paymentRequest.test.js',
  'src/lib/perps/venues/gmx.js',
  'src/lib/pools/bip39Lists.js',
  'src/lib/pools/gasless.js',
  'src/lib/pools/poolContracts.js',
  'src/lib/recovery/bip39Suggest.js',
  'src/lib/recovery/legacyKeys.js',
  'src/lib/relay/__tests__/intentClient.test.js',
  'src/lib/relay/__tests__/poolIntents.test.js',
  'src/lib/relay/intentClient.js',
  'src/lib/transfer/eip3009Transfer.js',
  'src/lib/uniswap/__tests__/quote.test.js',
  'src/lib/verify/verifyMessage.js',
  'src/pages/MarketAcceptancePage.jsx',
  'src/utils/blockchainService.js',
  'src/utils/claimCode/deriveFromCode.js',
  'src/utils/claimCode/wordlist.js',
  'src/utils/encryption.js',
  'src/utils/keyRegistryService.js',
  'src/utils/rpcProvider.js',
]
