/**
 * The ethers import ratchet (spec 110, Phase 0 — issue #1591).
 *
 * Every file listed here still imports 'ethers' and is EXEMPT from the no-restricted-imports
 * ban in eslint.config.js. The list only ever SHRINKS: converting a file to the viem seams
 * (Phases 1-2) removes its line, and a PR that adds a line is reintroducing the dependency
 * this migration exists to remove. src/test/lint/ethersRatchet.test.js fails on a stale
 * entry (a listed file that no longer imports ethers), so the list cannot rot upward.
 *
 * FIVE ENTRIES ARE NOT A CONVERSION, THEY ARE A DECISION — four reasons over five files — and
 * are called out so nobody spends an afternoon rediscovering it:
 *
 *   - `lib/pools/bip39Lists.js` is the MULTI-LANGUAGE BIP-39 registry (spec 034 SC-008: the same
 *     pool resolves whatever language the member reads it in). ethers bundles TEN wordlists —
 *     cz, en, es, fr, it, pt, ja, ko, zh_cn, zh_tw — and viem exports only English, so converting
 *     this one would silently drop nine languages. That is a product decision, not a refactor.
 *
 *     An earlier version of this note claimed all three BIP-39 files were stuck because "viem
 *     bundles none", and that was simply WRONG: `viem/accounts` exports `english`, and it is
 *     identical to ethers' `en` word for word, 2048 entries in the same order (checked before the
 *     swap — a claim code is derived from word INDICES, so a list differing anywhere would change
 *     every code generated afterwards and invalidate every one issued before). No lockfile change
 *     was ever needed, so no spec-075 rolldown hazard applied. `lib/recovery/bip39Suggest.js` and
 *     `utils/claimCode/wordlist.js` used `wordlists.en` ONLY and have been converted. A wrong
 *     reason on this list is worse than an open task: it retires work permanently.
 *   - `lib/miniapps/hostScope.js` hands ethers to third-party mini-app packages as a shared
 *     module. That is the spec-073 host API contract (hostApi 2), not an internal dependency:
 *     removing it breaks published packages, so it belongs to Phase 5 (#1596).
 *   - `utils/rpcProvider.js` is the seam being replaced; it leaves last, when its final
 *     caller does (T014).
 *   - `lib/bridge/__tests__/bridgeRouter.test.js` and `lib/liquidity/__tests__/liquidityRouter.test.js`
 *     decode viem-BUILT calldata with an ethers `Interface`, on purpose: that is a live
 *     cross-library byte-compatibility assertion over the exact code this migration is changing,
 *     and it fails loudly if the two encoders ever disagree. Each file says so at its import.
 *     Converting them to viem would make the check tautological — it would be asserting that
 *     viem agrees with itself — so it deletes the test while appearing to modernise it.
 *
 * Adding a NEW line is always wrong, including in a test. When a fixture needs something ethers
 * had and viem does not (`Interface.encodeEventLog`), write the viem version once — see
 * `src/test/helpers/encodeEventLog.js` — rather than reaching back for ethers.
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
  'src/components/fairwins/MarketAcceptanceModal.jsx',
  'src/components/fairwins/MyMarketsModal.jsx',
  'src/components/miniapps/SubmitAppPanel.jsx',
  'src/contexts/DexContext.jsx',
  'src/contexts/WalletContext.jsx',
  'src/contexts/Web3Context.jsx',
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
  'src/hooks/useVouchers.js',
  'src/hooks/useWrapNative.js',
  'src/lib/bridge/__tests__/bridgeRouter.test.js',
  'src/lib/clearpath/connectors/governorBravo.js',
  'src/lib/clearpath/connectors/ozGovernor.js',
  'src/lib/custody/safeVault.js',
  'src/lib/custody/submitAsActiveAccount.js',
  'src/lib/earn/vaultActions.js',
  'src/lib/funding/fundingContracts.js',
  'src/lib/hardware/hardwareSigner.js',
  'src/lib/liquidity/__tests__/liquidityRouter.test.js',
  'src/lib/miniapps/hostScope.js',
  'src/lib/payments/__tests__/paymentRequest.test.js',
  'src/lib/pools/bip39Lists.js',
  'src/lib/pools/poolContracts.js',
  'src/lib/recovery/legacyKeys.js',
  'src/lib/relay/__tests__/intentClient.test.js',
  'src/lib/relay/__tests__/poolIntents.test.js',
  'src/utils/blockchainService.js',
  'src/utils/keyRegistryService.js',
  'src/utils/rpcProvider.js',
]
