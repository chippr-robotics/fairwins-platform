/**
 * The ethers import ratchet (spec 110, Phase 0 — issue #1591).
 *
 * Every file listed here still imports 'ethers' and is EXEMPT from the no-restricted-imports
 * ban in eslint.config.js. The list only ever SHRINKS: converting a file to the viem seams
 * (Phases 1-2) removes its line, and a PR that adds a line is reintroducing the dependency
 * this migration exists to remove. src/test/lint/ethersRatchet.test.js fails on a stale
 * entry (a listed file that no longer imports ethers), so the list cannot rot upward.
 *
 * FIVE ENTRIES ARE NOT A CONVERSION, THEY ARE A DECISION — three reasons over five files — and
 * are called out so nobody spends an afternoon rediscovering it:
 *
 *   - (RETIRED) `lib/pools/bip39Lists.js` was listed here TWICE on a wrong premise, and is now
 *     converted. The first note said viem bundles no wordlists; the second said ethers bundles ten
 *     and viem only English, so converting would silently drop nine languages. Both were checked
 *     and both were false: `@scure/bip39` is ALREADY A DIRECT DEPENDENCY (2.4.0) and ships all ten,
 *     each one identical to ethers' word for word — 2048 entries, same order, in cz/en/es/fr/it/
 *     ja/ko/pt/zh_cn/zh_tw, verified before the swap because a pool's phrase is stored as INDICES
 *     and a list differing anywhere would rename every pool ever created, in one language only.
 *     `src/test/pools/bip39Lists.test.js` pins that comparison so the claim stays checkable.
 *     THE LESSON THIS ENTRY EARNED TWICE: a stated blocker here is a claim, not a fact. Verify it
 *     before trusting it, and especially before writing a NEW reason on top of a wrong one.
 *   - `lib/miniapps/hostScope.js` hands ethers to third-party mini-app packages as a shared
 *     module. That is the spec-073 host API contract (hostApi 2), not an internal dependency:
 *     removing it breaks published packages, so it belongs to Phase 5 (#1596).
 *   - `utils/rpcProvider.js` is the seam being replaced; it leaves last, when its final
 *     caller does (T014).
 *   - `lib/bridge/__tests__/bridgeRouter.test.js`, `lib/liquidity/__tests__/liquidityRouter.test.js`
 *     and `components/account/__tests__/CallsignPanel.passkey.test.jsx`
 *     decode or encode viem-BUILT calldata with an ethers `Interface`, on purpose: that is a live
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
  'src/components/account/RecoverAccountPanel.jsx',
  'src/components/account/__tests__/CallsignPanel.passkey.test.jsx',
  'src/components/fairwins/MarketAcceptanceModal.jsx',
  'src/components/fairwins/MyMarketsModal.jsx',
  'src/contexts/DexContext.jsx',
  'src/contexts/WalletContext.jsx',
  'src/contexts/Web3Context.jsx',
  'src/hooks/useFriendMarketCreation.js',
  'src/hooks/useOpenChallengeAccept.js',
  'src/hooks/useOpenChallengeCreate.js',
  'src/hooks/useOracleConditions.js',
  'src/hooks/useTreasuryVault.js',
  'src/lib/bridge/__tests__/bridgeRouter.test.js',
  'src/lib/clearpath/connectors/governorBravo.js',
  'src/lib/clearpath/connectors/ozGovernor.js',
  'src/lib/custody/safeVault.js',
  'src/lib/custody/submitAsActiveAccount.js',
  'src/lib/earn/vaultActions.js',
  'src/lib/hardware/hardwareSigner.js',
  'src/lib/liquidity/__tests__/liquidityRouter.test.js',
  'src/lib/miniapps/hostScope.js',
  'src/lib/payments/__tests__/paymentRequest.test.js',
  'src/lib/recovery/legacyKeys.js',
  'src/lib/relay/__tests__/intentClient.test.js',
  'src/lib/relay/__tests__/poolIntents.test.js',
  'src/utils/blockchainService.js',
  'src/utils/keyRegistryService.js',
  'src/utils/rpcProvider.js',
]
