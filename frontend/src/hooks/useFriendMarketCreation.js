import { useCallback } from 'react'
import {
  decodeEventLog, encodeFunctionData, keccak256, stringToHex, maxUint256, zeroAddress, zeroHash,
} from 'viem'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { formatUnits, parseUnits } from '../lib/evm/units'
import { isAddress, getAddress } from '../lib/evm/address'
import { useWeb3 } from './useWeb3'
import { useActiveAccount } from './useActiveAccount'
import { useGaslessWrite } from '../lib/relay/useGaslessWrite'
import { getContractAddress, getContractAddressForChain } from '../config/contracts'
import { WAGER_REGISTRY_ABI } from '../abis/WagerRegistry'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'
import { ResolutionType, ORACLE_RESOLUTION_TYPES, WAGER_DEFAULTS } from '../constants/wagerDefaults'
import {
  uploadEncryptedEnvelope,
  buildEncryptedIpfsReference
} from '../utils/ipfsService'
import { getFeeOverrides } from '../utils/feeOverrides'
import { getCurrentDocument } from '../utils/legalDocs'
import { revertReasonFrom, screenedActorMessage } from '../lib/wagers/sanctionsRevert'

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

export { ResolutionType, ORACLE_RESOLUTION_TYPES }

const WAGER_PARTICIPANT_ROLE = keccak256(stringToHex('WAGER_PARTICIPANT_ROLE'))

const REGISTRY_ABI_PARSED = normalizeAbi(WAGER_REGISTRY_ABI)
const ERC20_ABI_PARSED = normalizeAbi(ERC20_ABI)
const registryCall = (functionName, args) =>
  encodeFunctionData({ abi: REGISTRY_ABI_PARSED, functionName, args })
const erc20Call = (functionName, args) =>
  encodeFunctionData({ abi: ERC20_ABI_PARSED, functionName, args })
const registryHasFunction = (name) =>
  REGISTRY_ABI_PARSED.some((f) => f?.type === 'function' && f.name === name)

/**
 * Clear Open wagers whose accept deadline has passed, so they stop counting toward the tier's
 * concurrent limit.
 *
 * Spec 110: takes the CHAIN and the signer rather than an ethers `Contract` it digs a provider out
 * of (`registry.runner?.provider || registry.provider`) — that dig was the fusion of "where" with
 * "who" this task exists to remove, and it is what decided which network the membership manager
 * was resolved on. The chain is now the caller's, stated.
 */
async function expireStaleWagers(chainId, signer, registryAddress, userAddress, onProgress) {
  try {
    const membershipManagerAddr =
      (chainId != null ? getContractAddressForChain('membershipManager', chainId) : null) ||
      getContractAddress('membershipManager')
    if (!membershipManagerAddr) return

    const askManager = (functionName, args) =>
      readContract(chainId, { address: membershipManagerAddr, abi: MEMBERSHIP_MANAGER_ABI, functionName, args })
    const askRegistry = (functionName, args) =>
      readContract(chainId, { address: registryAddress, abi: WAGER_REGISTRY_ABI, functionName, args })

    const who = getAddress(String(userAddress))
    const membership = await askManager('getMembership', [who, WAGER_PARTICIPANT_ROLE])
    const tierNum = Number(membership.tier)
    if (tierNum === 0) return

    const cfg = await askManager('getTierConfig', [WAGER_PARTICIPANT_ROLE, tierNum])
    const concurrentLimit = Number(cfg.limits.maxConcurrentMarkets)
    const activeCount = Number(membership.activeCount)
    if (concurrentLimit === 0 || activeCount < concurrentLimit) return

    const count = await askRegistry('getUserWagerCount', [who])
    if (count === 0n) return

    const wagers = await askRegistry('getUserWagers', [who, 0n, count])
    const ids = await askRegistry('getUserWagerIds', [who, 0n, count])
    const now = Math.floor(Date.now() / 1000)
    const expiredIds = []

    for (let i = 0; i < wagers.length; i++) {
      if (Number(wagers[i].status) === 1 && Number(wagers[i].acceptDeadline) < now) {
        expiredIds.push(ids[i])
      }
    }
    if (expiredIds.length === 0) return

    onProgress({ step: 'cleanup', message: `Cleaning up ${expiredIds.length} expired wager(s)...` })
    const tx = await signer.sendTransaction({
      to: registryAddress,
      data: registryCall('batchExpireOpen', [expiredIds]),
    })
    await tx.wait()
  } catch (e) {
    console.debug('[expireStaleWagers] cleanup skipped:', e.message)
  }
}

// localStorage helpers — preserved for backward-compat with FriendMarketsModal callers
const PENDING_TX_KEY = 'pendingFriendMarketTx'

const savePendingTransaction = (txData) => {
  try {
    localStorage.setItem(PENDING_TX_KEY, JSON.stringify({ ...txData, timestamp: Date.now() }))
  } catch { /* localStorage may be unavailable; ignore */ }
}

export const loadPendingTransaction = () => {
  try {
    const stored = localStorage.getItem(PENDING_TX_KEY)
    if (!stored) return null
    const data = JSON.parse(stored)
    if (Date.now() - data.timestamp > 60 * 60 * 1000) {
      clearPendingTransaction()
      return null
    }
    return data
  } catch { return null }
}

export const clearPendingTransaction = () => {
  try { localStorage.removeItem(PENDING_TX_KEY) } catch { /* ignore */ }
}

/**
 * v2 friend market creation: drives WagerRegistry.createWager.
 *
 * Differences from v1:
 *  - ERC20-only stakes (USDC or WPOL); native POL not supported.
 *  - No proposalId / no ConditionalMarketFactory dependency.
 *  - Resolution types: Either/Creator/Opponent/ThirdParty/Polymarket.
 *  - On-chain only stores a 32-byte metadataHash; the description/envelope
 *    lives off-chain (IPFS or app-local).
 *  - Membership checks are delegated to the contract — if `MembershipDenied`
 *    reverts, the UI surfaces a buy-tier prompt.
 */
export function useFriendMarketCreation({ onMarketCreated } = {}) {
  const { signer, sendCalls, loginMethod, provider, address, chainId } = useWeb3()
  const isPasskey = loginMethod === 'passkey'
  // Spec 043 (US3): when operating as a vault, wager creation becomes a threshold-gated vault proposal.
  // Spec 088 FR-001/FR-002: a recovered (legacy) or hardware acting account creates the wager AS
  // ITSELF — its address is the creator, its balance is checked, and ITS signer signs, obtained on
  // demand by the deferred ceremony. Before this, those kinds fell past the vault branch into the
  // gasless/self-submit legs below and silently created the wager from the CONNECTED wallet.
  const {
    identity: activeIdentity,
    isVault: operatingAsVault,
    isLegacy: operatingAsLegacy,
    isHardware: operatingAsHardware,
    canActAsVault,
    submit: submitAsActive,
  } = useActiveAccount()
  const actingAsSigner = operatingAsLegacy || operatingAsHardware

  // Gasless createWager (spec 035/036): relayed where the relayer serves the chain and the stake token
  // supports EIP-3009 (Polygon USDC); transparent self-submit otherwise (Mordor USC → auto self-submit).
  // run() takes one context object carrying the exact values the self-submit flow already computed. The
  // payment leg authorizes the creator's stake via EIP-3009, so the gasless path skips the approve the
  // self-submit closure (ctx.performSelfSubmit) performs. Params mirror the CreateWagerIntent struct
  // (creator is auto-filled from the signer).
  const createWagerTx = useGaslessWrite('createWager', {
    params: (ctx) => ({
      opponent: ctx.opponent,
      arbitrator: ctx.arbitrator,
      token: ctx.stakeTokenAddress,
      creatorStake: ctx.creatorStakeWei,
      opponentStake: ctx.opponentStakeWei,
      acceptDeadline: ctx.acceptDeadline,
      resolveDeadline: ctx.resolveDeadline,
      resolutionType: ctx.resolutionType,
      conditionId: ctx.polymarketConditionId,
      creatorIsYes: ctx.creatorIsYes,
      metadataHash: ctx.metadataHash,
      metadataUri: ctx.metadataReference,
      termsVersionHash: ctx.termsVersionHash,
    }),
    payment: (ctx) => ({ value: ctx.creatorStakeWei }),
    selfSubmit: (ctx) => ctx.performSelfSubmit(),
  })

  const createFriendMarket = useCallback(async (data, modalSigner) => {
    const activeSigner = modalSigner || signer
    if (!isPasskey && !activeSigner) throw new Error('Please connect your wallet to create a wager')
    // Passkey sessions have no signer: reads go through the spec-110 chain seam (named by the
    // execution chain, below) and the write goes out as one sponsored UserOp (approve+create) via
    // sendCalls further down. `provider` is still the receipt reader on the relayed path.

    const onProgress = data.data?.onProgress || (() => {})
    savePendingTransaction({
      step: 'verify',
      data: {
        description: data.data?.description,
        opponent: data.data?.opponent,
        stakeAmount: data.data?.stakeAmount,
        stakeTokenId: data.data?.stakeTokenId,
      },
    })

    try {
      onProgress({ step: 'verify', message: 'Validating wager...' })

      // Resolve contracts for the chain the signer will execute on, so the
      // registry + stake token always match the transaction's network (display
      // ↔ execution parity). Falls back to the build-time chain only if the
      // signer can't report its network.
      let executionChainId
      try {
        executionChainId = activeSigner
          ? Number((await activeSigner.provider.getNetwork()).chainId)
          : chainId
      } catch {
        executionChainId = chainId
      }
      const resolve = (name) =>
        executionChainId != null ? getContractAddressForChain(name, executionChainId) : getContractAddress(name)

      const wagerRegistryAddress = resolve('wagerRegistry')
      if (!wagerRegistryAddress) {
        throw new Error('WagerRegistry not deployed on this network. Run scripts/deploy/deploy.js first.')
      }

      // Resolve stake token. v2 is ERC20-only; default to paymentToken (USDC).
      const requestedToken = data.data?.collateralToken
      const stakeTokenAddress = (requestedToken && requestedToken !== zeroAddress)
        ? requestedToken
        : resolve('paymentToken')
      if (!stakeTokenAddress || stakeTokenAddress === zeroAddress) {
        throw new Error('A stake token (USDC or WPOL) is required. Native POL is not supported.')
      }

      // Spec 088 FR-001 — the creator is whoever is ACTING. Everything keyed off this address
      // (the stake balance check, the allowance, the self-wager guard, the simulated `from`, and
      // the recorded creator) must describe the account the switcher shows, not the wallet that
      // happens to hold the session.
      const userAddress = actingAsSigner
        ? activeIdentity.address
        : activeSigner
          ? await activeSigner.getAddress()
          : address
      // Named chain, not the signer's runner (spec 110 read-routing decision). `executionChainId`
      // is already the chain the transaction will execute on, so display and execution still agree.
      const askRegistry = (functionName, args, account) =>
        readContract(executionChainId, {
          address: wagerRegistryAddress,
          abi: WAGER_REGISTRY_ABI,
          functionName,
          args,
          ...(account ? { account } : {}),
        })
      const askToken = (functionName, args) =>
        readContract(executionChainId, { address: stakeTokenAddress, abi: ERC20_ABI, functionName, args })
      const tokenDecimals = Number(await askToken('decimals'))
      const tokenSymbol = await askToken('symbol').catch(() => 'tokens')

      // Stakes
      const stakeAmountRaw = data.data.stakeAmount || '10'
      // The seam refuses a stake this token cannot represent exactly (spec 110 divergence 20:
      // viem rounds half-up where ethers threw) — the escrow must be what the member entered.
      const stakeWei = parseUnits(String(stakeAmountRaw), tokenDecimals)
      const isOffer = data.marketType === 'offer'
      // Same NaN-only-fallback fix as resolutionType below, and for a similar reason: `|| 100`
      // silently turns a missing/unparseable value into 100% odds, which computes a zero
      // majorityStakeWei and throws "Offer odds (100%) would result in zero or negative majority
      // stake" — the fallback should be the declared default (200%), not an arbitrary 100.
      const rawOddsMultiplier = parseInt(data.data.oddsMultiplier, 10)
      const oddsMultiplier = Number.isNaN(rawOddsMultiplier) ? WAGER_DEFAULTS.ODDS_MULTIPLIER : rawOddsMultiplier
      /*
       * NOT `|| ResolutionType.Creator`: Either is 0, and `0 || x` is `x` in JS — that fallback
       * silently turned every "Either of Us" selection into "Creator Only" the instant the
       * resolution-type field held a real, valid 0. Caught by 07-manual-resolution's RES-02
       * (#1231): a UI-created Either-Party wager reverted NotAuthorized when the opponent, who
       * is supposed to be able to resolve it too, tried to. Preserve a genuine 0; fall back only
       * when the field is actually missing/unparseable (NaN).
       */
      const rawOfferResolutionType = parseInt(data.data.resolutionType, 10)
      const offerResolutionType = Number.isNaN(rawOfferResolutionType) ? ResolutionType.Creator : rawOfferResolutionType

      let creatorStakeWei = stakeWei
      let opponentStakeWei = stakeWei
      if (isOffer) {
        // Offer: one side puts up the majority (insurer) stake, the other risks
        // the smaller headline stake to win the whole pot. The *settler* carries
        // the majority stake (skin in the game): when the opponent settles
        // ("Them") they're the insurer, otherwise the creator is.
        //   majorityStake = headlineStake * (odds - 100) / 100
        const majorityStakeWei = (stakeWei * BigInt(oddsMultiplier - 100)) / 100n
        if (majorityStakeWei <= 0n) {
          throw new Error(`Offer odds (${oddsMultiplier}%) would result in zero or negative majority stake.`)
        }
        if (offerResolutionType === ResolutionType.Opponent) {
          // "Them" settles → opponent is the insurer (majority); creator risks the headline.
          opponentStakeWei = majorityStakeWei
          creatorStakeWei = stakeWei
        } else {
          // "Me" / "Friend" / "Oracle" → creator is the insurer (majority); opponent risks the headline.
          creatorStakeWei = majorityStakeWei
          opponentStakeWei = stakeWei
        }
      }

      // Balance check
      const balance = BigInt(await askToken('balanceOf', [getAddress(String(userAddress))]))
      if (balance < creatorStakeWei) {
        throw new Error(
          `Insufficient ${tokenSymbol} balance. ` +
          `Have ${formatUnits(balance, tokenDecimals)}, ` +
          `need ${formatUnits(creatorStakeWei, tokenDecimals)}.`
        )
      }

      // Deadlines
      const tradingPeriodSeconds = parseInt(data.data.tradingPeriodSeconds, 10) || (parseInt(data.data.tradingPeriod, 10) || 7) * 86400
      const raw = data.data.acceptanceDeadline
      let acceptDeadline
      if (typeof raw === 'string' && raw.includes('-')) {
        const parsed = new Date(raw)
        acceptDeadline = isNaN(parsed.getTime())
          ? Math.floor(Date.now() / 1000) + 48 * 3600
          : Math.floor(parsed.getTime() / 1000)
      } else if (typeof raw === 'number' && raw > 1e12) {
        acceptDeadline = Math.floor(raw / 1000)
      } else if (typeof raw === 'number' && raw > 1e9) {
        acceptDeadline = Math.floor(raw)
      } else {
        const hours = parseInt(raw, 10) || 48
        acceptDeadline = Math.floor(Date.now() / 1000) + hours * 3600
      }
      // Timing model: a single user-chosen end time `E` (tradingEnd) drives everything.
      //   - acceptDeadline  = midpoint(now, E)            (set upstream by the form)
      //   - tradingEnd      = E   → resolution opens here
      //   - resolveDeadline = E + 48h → resolution closes; after this stakes are refundable
      // Anchor resolveDeadline to E directly. The previous formula
      // (acceptDeadline + tradingPeriodSeconds + 48h) overshot to ~1.5*E + 48h because
      // acceptDeadline is the midpoint, which broke the resolve-window gate downstream.
      const RESOLUTION_WINDOW = WAGER_DEFAULTS.RESOLUTION_WINDOW_SECONDS || 48 * 3600
      const parsedEnd = data.data.endDateTime ? new Date(data.data.endDateTime) : null
      const tradingEnd = (parsedEnd && !Number.isNaN(parsedEnd.getTime()))
        ? Math.floor(parsedEnd.getTime() / 1000)
        : acceptDeadline + tradingPeriodSeconds // fallback when no explicit end time
      let resolveDeadline = tradingEnd + RESOLUTION_WINDOW

      // Clamp deadlines to the contract's accept/resolve windows so a far-future
      // end (e.g. a Polymarket-linked market whose own end is months out, which
      // bypasses the modal's 21-day bound) can't push past the on-chain caps and
      // revert with BadDeadlines. We keep now < acceptDeadline < resolveDeadline.
      const nowSec = Math.floor(Date.now() / 1000)
      const SAFETY_BUFFER = 5 * 60 // 5 min, to absorb block-time skew
      const maxAccept = nowSec + (WAGER_DEFAULTS.MAX_ACCEPT_WINDOW_SECONDS || 30 * 86400) - SAFETY_BUFFER
      const maxResolve = nowSec + (WAGER_DEFAULTS.MAX_RESOLVE_WINDOW_SECONDS || 180 * 86400) - SAFETY_BUFFER
      if (acceptDeadline > maxAccept) acceptDeadline = maxAccept
      if (resolveDeadline > maxResolve) resolveDeadline = maxResolve
      // Guarantee strict ordering even after clamping.
      if (acceptDeadline <= nowSec) acceptDeadline = nowSec + 60
      if (resolveDeadline <= acceptDeadline) resolveDeadline = acceptDeadline + RESOLUTION_WINDOW

      // Participants
      const opponent = data.data.opponent || data.data.participants?.[0]
      if (!opponent || !isAddress(opponent)) {
        throw new Error('Valid opponent address required for 1v1 wager')
      }
      if (opponent.toLowerCase() === userAddress.toLowerCase()) {
        throw new Error('Cannot wager against yourself')
      }

      // Resolution
      // NOT `|| ResolutionType.Creator` — see the note beside offerResolutionType above; Either
      // is 0, and `0 || x` discards it.
      const rawResolutionType = parseInt(data.data.resolutionType, 10)
      const resolutionType = Number.isNaN(rawResolutionType) ? ResolutionType.Creator : rawResolutionType
      // The form field is `oracleConditionId` (future-proof: same slot serves Polymarket
      // and the upcoming ChainlinkDataFeed / ChainlinkFunctions / UMA adapters). The
      // contract param is still named `polymarketConditionId` for legacy reasons; we
      // rebind here so the contract call is unambiguous.
      // Fall back to the legacy key for any external callers that still set it.
      const oracleConditionId = data.data.oracleConditionId ?? data.data.polymarketConditionId ?? ''
      const polymarketConditionId = oracleConditionId || zeroHash
      const creatorIsYes = Boolean(data.data.creatorIsYes ?? true)
      // ThirdParty resolution names a neutral arbitrator (Spec Kit 005); every
      // other resolution type submits the zero address, which is exactly what
      // WagerRegistry requires (a non-zero arbitrator on a non-ThirdParty wager
      // reverts ArbitratorDisallowed; a zero arbitrator on ThirdParty reverts
      // ArbitratorRequired).
      let arbitrator = zeroAddress
      if (resolutionType === ResolutionType.ThirdParty) {
        const arb = (data.data.arbitrator || '').trim()
        if (!isAddress(arb) || arb === zeroAddress) {
          throw new Error('ThirdParty resolution requires a valid arbitrator address.')
        }
        arbitrator = arb
      }

      // Defense-in-depth: the modal's validateForm should have caught these
      // mismatches before submit. If something slipped through (e.g. a future
      // caller invokes the hook directly), surface a clear error rather than
      // let the contract revert with a cryptic custom error.
      const oracleResolved = ORACLE_RESOLUTION_TYPES.has(resolutionType)
      if (oracleResolved && polymarketConditionId === zeroHash) {
        throw new Error(
          'Oracle-resolved wagers require a conditionId. ' +
          'Pick a Polymarket market (or other oracle condition) before submitting.'
        )
      }
      if (!oracleResolved && polymarketConditionId !== zeroHash) {
        throw new Error(
          'A conditionId was supplied for a non-oracle resolution type. ' +
          'Either change the resolution type or clear the conditionId.'
        )
      }
      // "Either side submits the outcome" is only allowed on a level peer-to-peer
      // wager (equal stakes). An asymmetric Offer must use a single named resolver,
      // a third party, or an oracle — never mutual-trust self-resolution. Mirror the
      // contract's EitherRequiresEqualStakes guard so the user gets a clear message.
      if (resolutionType === ResolutionType.Either && creatorStakeWei !== opponentStakeWei) {
        throw new Error(
          'Letting either side submit the outcome is only available on equal-stakes ' +
          '(non-leveraged) peer-to-peer wagers. Use a single resolver, a third-party ' +
          'arbitrator, or an oracle for an Offer with uneven stakes.'
        )
      }

      // Metadata (encrypted envelope → IPFS, or plaintext)
      let metadataReference
      let ipfsCid = null
      if (data.data.isEncrypted && data.data.encryptedMetadata) {
        onProgress({ step: 'upload', message: 'Uploading encrypted metadata to IPFS...' })
        try {
          const uploaded = await uploadEncryptedEnvelope(data.data.encryptedMetadata, {
            marketType: data.marketType || 'oneVsOne',
          })
          ipfsCid = uploaded.cid
          metadataReference = buildEncryptedIpfsReference(ipfsCid)
        } catch (e) {
          throw new Error(`Failed to upload encrypted metadata: ${e.message}`, { cause: e })
        }
      } else {
        metadataReference = data.data.description || 'Friend Wager'
      }
      const metadataHash = keccak256(stringToHex(metadataReference))

      // Spec 007 (FR-056/FR-058): bind the in-force T&C version hash on-chain when the
      // registry supports it. legalDocs hashes are bare 64-hex → normalize to bytes32.
      // Falls back to plain createWager on older registries lacking the overload.
      const termsHashHex = getCurrentDocument('terms')?.hash
      const termsBytes32 = termsHashHex && /^[0-9a-fA-F]{64}$/.test(termsHashHex) ? '0x' + termsHashHex : null
      const useTerms = Boolean(termsBytes32) && registryHasFunction('createWagerWithTerms')
      const createMethod = useTerms ? 'createWagerWithTerms' : 'createWager'
      const createArgs = [
        // Checksummed before the encoder (divergence 16); arbitrator may be the zero address.
        getAddress(String(opponent)), getAddress(String(arbitrator)), getAddress(String(stakeTokenAddress)),
        creatorStakeWei, opponentStakeWei,
        acceptDeadline, resolveDeadline,
        resolutionType, polymarketConditionId, creatorIsYes,
        metadataHash, metadataReference,
        ...(useTerms ? [termsBytes32] : []),
      ]

      // Spec 043 (US3, FR-021): operating as a vault → create the wager AS the vault. Batch
      // [approve(registry, stake), createWager(...)] into one MultiSend and propose it as a threshold-gated
      // vault transaction; the Safe becomes the creator and the stake is pulled from the vault. The wager
      // surfaces only in the vault queue until co-owners approve + execute (FR-022b) — no self-submit/gasless.
      if (operatingAsVault) {
        if (!canActAsVault) throw new Error("Switch to the vault's network to create a wager as the vault.")
        const approveData = erc20Call('approve', [getAddress(String(wagerRegistryAddress)), creatorStakeWei])
        const createData = registryCall(createMethod, createArgs)
        onProgress({ step: 'create', message: 'Creating a vault proposal for co-owner approval…' })
        const res = await submitAsActive({
          batch: [
            { to: stakeTokenAddress, value: 0n, data: approveData },
            { to: wagerRegistryAddress, value: 0n, data: createData },
          ],
        })
        return { proposed: true, safeTxHash: res.safeTxHash, marketType: data.marketType }
      }

      // Self-submit leg: the existing approve → cleanup → simulate → estimate → send flow verbatim.
      // The gasless path skips ALL of this — EIP-3009 pulls the stake (no approve) and the relayer
      // estimates/pays gas. Captures the mined receipt so the shared code below can read WagerCreated.
      let minedReceipt = null
      const performSelfSubmit = async () => {
        // Approve stake token if needed. We approve the full uint256 max rather
        // than the exact stake so (a) subsequent wagers don't need a fresh
        // approval each time (the exact-stake approval left allowance at 0 after
        // every wager) and (b) a stale read on a load-balanced RPC node can't
        // under-approve. After approving we poll the allowance until the freshly
        // mined approval is actually visible to the RPC — otherwise createWager's
        // gas estimation can land on a node that still sees allowance 0, and the
        // transferFrom reverts ("transfer amount exceeds allowance", surfaced as
        // an opaque "missing revert data" by some wallet RPCs).
        let currentAllowance = BigInt(await askToken('allowance', [getAddress(String(userAddress)), getAddress(String(wagerRegistryAddress))]))
        if (currentAllowance < creatorStakeWei) {
          onProgress({ step: 'approve', message: 'Approving token spend...' })
          const approveTx = await activeSigner.sendTransaction({
            to: stakeTokenAddress,
            data: erc20Call('approve', [getAddress(String(wagerRegistryAddress)), maxUint256]),
          })
          onProgress({ step: 'approve', message: 'Waiting for approval confirmation...', txHash: approveTx.hash })
          await approveTx.wait()

          // Wait until the approval is observable before continuing. Public RPCs
          // are often load-balanced, so the node answering the next read/estimate
          // may briefly lag the node that mined the approval.
          for (let attempt = 0; attempt < 6; attempt++) {
            currentAllowance = BigInt(await askToken('allowance', [getAddress(String(userAddress)), getAddress(String(wagerRegistryAddress))]))
            if (currentAllowance >= creatorStakeWei) break
            await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
          }
          if (currentAllowance < creatorStakeWei) {
            throw new Error(
              'Your token approval has not been confirmed yet. Please wait a few ' +
              'seconds for it to finalize, then try creating the wager again.'
            )
          }
        }

        // Auto-cleanup expired Open wagers that still count toward the
        // concurrent limit. Without this, acceptDeadline-expired wagers
        // inflate activeCount and block new creation even when the user
        // has fewer truly-active wagers than their tier allows.
        await expireStaleWagers(executionChainId, activeSigner, wagerRegistryAddress, userAddress, onProgress)

        // Simulate to catch reverts pre-wallet-prompt
        try {
          onProgress({ step: 'create', message: 'Validating transaction...' })
          // The caller is named explicitly; ethers took it from the signer bound to the contract.
          await askRegistry(createMethod, createArgs, getAddress(String(userAddress)))
        } catch (simError) {
          throw new Error(translateRevert(revertReasonFrom(simError)), { cause: simError })
        }

        onProgress({ step: 'create', message: 'Please confirm in your wallet...' })
        const feeOverrides = await getFeeOverrides(activeSigner.provider)

        // Estimate gas explicitly with a short retry so a transient stale read on
        // a load-balanced RPC doesn't surface a raw "missing revert data" error.
        // The staticCall above already validated the args, so a failure here is
        // almost always RPC lag rather than a genuine revert; fall back to a fixed
        // limit after exhausting retries.
        let gasLimit
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const estimate = await activeSigner.estimateGas({
              to: wagerRegistryAddress,
              data: registryCall(createMethod, createArgs),
            })
            gasLimit = (estimate * 120n) / 100n // +20% headroom
            break
          } catch {
            if (attempt === 2) {
              gasLimit = 800000n // generous fallback; the staticCall already passed
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
          }
        }

        const tx = await activeSigner.sendTransaction({
          to: wagerRegistryAddress,
          data: registryCall(createMethod, createArgs),
          ...feeOverrides,
          gasLimit,
        })
        onProgress({ step: 'create', message: 'Waiting for confirmation...', txHash: tx.hash })
        savePendingTransaction({ step: 'create', txHash: tx.hash, data: data.data })

        minedReceipt = await tx.wait()
        return minedReceipt
      }

      // Passkey rail (spec 041/050): batch [approve?(exact stake), createWager] into ONE sponsored
      // UserOp via sendCalls. Mirrors the vault batch above but self-executed (not a Safe proposal).
      // Flows into the shared receipt/WagerCreated parsing below via a txHash-only runResult.
      let runResult
      if (actingAsSigner) {
        // Spec 088 FR-002 — acting as a recovered or hardware account. Same [approve?, create]
        // batch the vault branch builds, but executed rather than proposed: an EOA cannot batch
        // atomically, so `submitAsActiveAccount` sends them SEQUENTIALLY, each awaited to
        // inclusion, signed by the acting account's own signer (the unlock / device ceremony runs
        // on demand). Deliberately NOT the gasless leg below: a relayed intent is signed against
        // the connected wallet's rail, and there is no acting-account twin of it — self-submit is
        // the never-stranded fallback the gasless rails already promise.
        const calls = []
        const currentAllowance = BigInt(await askToken('allowance', [getAddress(String(userAddress)), getAddress(String(wagerRegistryAddress))]))
        if (currentAllowance < creatorStakeWei) {
          calls.push({
            to: stakeTokenAddress,
            value: 0n,
            data: erc20Call('approve', [getAddress(String(wagerRegistryAddress)), creatorStakeWei]),
          })
        }
        // Simulate AS the acting account, so a membership/screening refusal is reported before
        // the member is asked to unlock a key or confirm on a device.
        try {
          onProgress({ step: 'create', message: 'Validating transaction...' })
          await askRegistry(createMethod, createArgs, getAddress(String(userAddress)))
        } catch (simError) {
          throw new Error(translateRevert(revertReasonFrom(simError)), { cause: simError })
        }
        calls.push({
          to: wagerRegistryAddress,
          value: 0n,
          data: registryCall(createMethod, createArgs),
        })
        onProgress({
          step: 'create',
          message: operatingAsHardware
            ? 'Confirm on your hardware device…'
            : 'Confirm with the recovered account…',
        })
        const res = await submitAsActive({ batch: calls })
        runResult = { txHash: res?.txHash ?? null, via: 'acting' }
      } else if (isPasskey) {
        if (typeof sendCalls !== 'function') {
          throw new Error('This wallet cannot create a wager on the current transaction rail.')
        }
        const calls = []
        const currentAllowance = BigInt(await askToken('allowance', [getAddress(String(userAddress)), getAddress(String(wagerRegistryAddress))]))
        if (currentAllowance < creatorStakeWei) {
          calls.push({
            target: stakeTokenAddress,
            data: erc20Call('approve', [getAddress(String(wagerRegistryAddress)), creatorStakeWei]),
            value: 0n,
          })
        }
        try {
          onProgress({ step: 'create', message: 'Validating transaction...' })
          await askRegistry(createMethod, createArgs, getAddress(String(userAddress)))
        } catch (simError) {
          throw new Error(translateRevert(revertReasonFrom(simError)), { cause: simError })
        }
        calls.push({
          target: wagerRegistryAddress,
          data: registryCall(createMethod, createArgs),
          value: 0n,
        })
        onProgress({ step: 'create', message: 'Confirm with your passkey…' })
        const sent = await sendCalls(calls)
        runResult = { txHash: sent?.txHash ?? sent?.userOpHash ?? sent?.intentId, via: 'userop' }
      } else {
        // Gasless-or-self-submit send (spec 035/036). Params mirror the CreateWagerIntent struct; the
        // creator is auto-filled from the signer. The relayer only serves EIP-3009 chains — everywhere
        // else this transparently self-submits with identical on-chain effect.
        runResult = await createWagerTx.run({
          opponent, arbitrator, stakeTokenAddress, creatorStakeWei, opponentStakeWei,
          acceptDeadline, resolveDeadline, resolutionType, polymarketConditionId,
          creatorIsYes, metadataHash, metadataReference,
          termsVersionHash: termsBytes32 || zeroHash,
          performSelfSubmit,
        })
      }
      if (runResult?.error) throw runResult.error

      // Only the self-submit leg guarantees a mined receipt in hand; treat a missing/failed one as a
      // revert exactly as before. A relayed intent may still be pending (no receipt yet) — not a failure.
      const selfSubmitted = runResult?.via === 'self-submit'
      if (selfSubmitted && (!minedReceipt || minedReceipt.status === 0)) {
        clearPendingTransaction()
        throw new Error('Transaction reverted on-chain. The wager was not created.')
      }
      clearPendingTransaction()

      // Resolve the receipt to read WagerCreated: self-submit captured it directly; the relayed path
      // exposes only a txHash, so fetch it when available (still-queued intents have none yet).
      let receipt = minedReceipt
      if (!receipt && runResult?.txHash) {
        try {
          receipt = await (activeSigner?.provider || provider).getTransactionReceipt(runResult.txHash)
        } catch { /* relayer/bundler still landing it; wager id resolves once mined */ }
      }

      // Parse WagerCreated event
      let wagerId = null
      if (receipt) {
        for (const log of receipt.logs || []) {
          try {
            const parsed = decodeEventLog({
              abi: REGISTRY_ABI_PARSED,
              topics: log.topics,
              data: log.data,
            })
            if (parsed?.eventName === 'WagerCreated') {
              wagerId = parsed.args.wagerId.toString()
              break
            }
          } catch { /* not a WagerRegistry log; ignore */ }
        }
      }

      const txHash = receipt?.hash || runResult?.txHash || null
      onProgress({ step: 'complete', message: 'Wager created!', txHash })

      const newMarket = {
        id: wagerId || `wager-${Date.now()}`,
        type: data.marketType || 'oneVsOne',
        description: data.data.description || 'Friend Wager',
        isEncrypted: Boolean(data.data.isEncrypted),
        encryptedMetadata: data.data.encryptedMetadata || null,
        ipfsCid,
        metadataReference,
        metadataHash,
        creatorStake: formatUnits(creatorStakeWei, tokenDecimals),
        opponentStake: formatUnits(opponentStakeWei, tokenDecimals),
        stakeAmount: stakeAmountRaw,
        stakeTokenAddress,
        stakeTokenSymbol: tokenSymbol,
        oddsMultiplier,
        resolutionType,
        polymarketConditionId,
        creatorIsYes,
        participants: [userAddress, opponent],
        opponent,
        arbitrator,
        creator: userAddress,
        acceptanceDeadline: new Date(acceptDeadline * 1000).toISOString(),
        endDate: new Date(tradingEnd * 1000).toISOString(),
        tradingPeriod: Math.max(1, Math.ceil(tradingPeriodSeconds / 86400)).toString(),
        createdAt: new Date().toISOString(),
        status: 'pending',
        txHash,
      }

      if (onMarketCreated) onMarketCreated(newMarket)

      return { id: wagerId, txHash, status: 'pending', ipfsCid, metadataHash }
    } catch (error) {
      console.error('Error creating wager:', error)
      if (error.code === 'ACTION_REJECTED' || error.code === 4001) {
        throw new Error('Transaction was rejected in your wallet.', { cause: error })
      }
      if (error.code === 'INSUFFICIENT_FUNDS') {
        throw new Error('Insufficient funds to cover the stake and gas.', { cause: error })
      }
      throw error
    }
  }, [signer, isPasskey, sendCalls, provider, address, chainId, onMarketCreated, createWagerTx, operatingAsVault, canActAsVault, submitAsActive, actingAsSigner, operatingAsHardware, activeIdentity])

  return { createFriendMarket, loadPendingTransaction, clearPendingTransaction }
}

/**
 * What a screened member is told on the create path. `_createWager` screens the CREATOR only
 * (contracts/wagers/WagerRegistryCore.sol) — the acting member — so "your account" is unambiguous
 * here in a way it is not on the accept paths, which screen both parties.
 *
 * The outcome clause deliberately does NOT say "nothing was submitted on-chain": the guard screens
 * `_createWager` only, so on the self-submit leg the stake-token approval and the stale-wager cleanup
 * (`batchExpireOpen`) are real transactions already sent, confirmed and PAID FOR by the time this
 * simulation reverts. "The wager was not created" is the strongest claim true on every leg.
 */
export const SCREENED_ADDRESS_MESSAGE = screenedActorMessage('the wager was not created')

export function translateRevert(reason) {
  if (!reason) return 'Unknown contract error.'
  if (reason.includes('insufficient allowance') || reason.includes('exceeds allowance')) {
    return 'Your USDC approval has not been confirmed yet. Wait a few seconds for the approval to finalize, then try creating the wager again.'
  }
  if (reason.includes('insufficient balance') || reason.includes('exceeds balance')) {
    return 'Insufficient token balance to cover your stake.'
  }
  // Compliance screening (spec 007 FR-054) — the first Check in `_createWager`. Name it: the
  // member is otherwise told only that the transaction will fail. See SCREENED_ADDRESS_MESSAGE.
  if (reason.includes('SanctionedAddress')) return SCREENED_ADDRESS_MESSAGE
  if (reason.includes('MembershipDenied')) return 'Your membership is inactive or you have reached your wager limit. If you have expired wagers, try again — they will be cleaned up automatically. Otherwise, upgrade your tier for higher limits.'
  if (reason.includes('SelfWager')) return 'Cannot wager against yourself.'
  if (reason.includes('NotAllowedToken')) return 'Stake token is not on the allowlist. Use USDC or WPOL.'
  if (reason.includes('BadDeadlines')) return 'Invalid deadlines. Accept window must be within 30 days; resolve window within 180 days.'
  if (reason.includes('ZeroStake')) return 'Stakes must be greater than zero.'
  if (reason.includes('ConditionAlreadyResolved')) return 'That Polymarket condition is already resolved. Pick an unresolved one.'
  if (reason.includes('PolymarketRequired')) return 'Polymarket resolution requires a non-zero conditionId.'
  if (reason.includes('PolymarketDisallowed')) return 'Polymarket conditionId must be zero unless resolutionType=Polymarket.'
  // Order: the new oracle-extensible reverts must check BEFORE the legacy
  // `AdapterNotSet`, since substring matching would otherwise route
  // `OracleAdapterNotSet` to the legacy "Polymarket adapter" message.
  if (reason.includes('OracleConditionRequired')) return 'Oracle-resolved wagers require a non-zero conditionId.'
  if (reason.includes('OracleAdapterNotSet')) return 'No oracle adapter is configured on-chain for this resolution type.'
  if (reason.includes('UnsupportedOracleResolutionType')) return 'This resolution type is not supported by the registry.'
  if (reason.includes('AdapterNotSet')) return 'Polymarket adapter not configured on-chain.'
  if (reason.includes('EitherRequiresEqualStakes')) return 'Letting either side submit the outcome is only allowed on equal-stakes (non-leveraged) peer-to-peer wagers. For an Offer with uneven stakes, use a single resolver, a third-party arbitrator, or an oracle.'
  if (reason.includes('ArbitratorRequired')) return 'ThirdParty resolution requires an arbitrator.'
  if (reason.includes('ArbitratorDisallowed')) return 'Only ThirdParty resolution allows an arbitrator.'
  if (reason.includes('ZeroAddress')) return 'Invalid address (zero address not allowed).'
  if (reason.includes('EnforcedPause')) return 'Wager creation is paused. Please try again later.'
  return `Transaction will fail: ${reason}`
}

export default useFriendMarketCreation
