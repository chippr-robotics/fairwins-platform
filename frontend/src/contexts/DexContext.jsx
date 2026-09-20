import { useState, useEffect, useCallback, useMemo } from 'react'
import { encodeFunctionData } from 'viem'
import { useWalletChainId } from '../hooks/useWalletChainId'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { formatEther, formatUnits, parseEther, parseUnits } from '../lib/evm/units'
import { getAddress } from '../lib/evm/address'
import { useWallet } from '../hooks/useWalletManagement'
import { useEffectiveAccount } from '../hooks/useEffectiveAccount'
import { useActiveAccount } from '../hooks/useActiveAccount'
import { FEE_TIERS, DEFAULT_SLIPPAGE } from '../constants/dex'
import { NETWORKS, getNetwork, getCurrentChainId } from '../config/networks'
import { ERC20_ABI } from '../abis/ERC20'
import { WNATIVE_ABI } from '../abis/WNative'
import { SWAP_ROUTER_02_ABI } from '../abis/SwapRouter02'
import { QUOTER_V2_ABI } from '../abis/QuoterV2'
import { DexContext } from './DexContext'
import { quoteBestRoute } from '../lib/uniswap/quote'
import {
  getSwapAddresses,
  getSwapTokenMeta,
  getSwapTokens,
  isSwapChain,
} from '../lib/uniswap/swapUniverse'
import { makeReadProvider } from '../utils/rpcProvider'
import logger from '../utils/logger'

const ERC20_ABI_PARSED = normalizeAbi(ERC20_ABI)
const WNATIVE_ABI_PARSED = normalizeAbi(WNATIVE_ABI)
const SWAP_ROUTER_ABI_PARSED = normalizeAbi(SWAP_ROUTER_02_ABI)
const erc20Call = (functionName, args) =>
  encodeFunctionData({ abi: ERC20_ABI_PARSED, functionName, args })
const wnativeCall = (functionName, args) =>
  encodeFunctionData({ abi: WNATIVE_ABI_PARSED, functionName, args })
const swapRouterCall = (functionName, args) =>
  encodeFunctionData({ abi: SWAP_ROUTER_ABI_PARSED, functionName, args })

/**
 * A QuoterV2 for `chainId`, shaped the way `lib/uniswap/quote.js` duck-types it
 * (`quoter.quoteExactInputSingle.staticCall(params)`).
 *
 * The quote module is already off ethers and takes the quoter as an argument precisely so a
 * cross-chain quote and a local one are the same computation; satisfying its duck type from the
 * read seam keeps that true without touching it — the same move `resolvePool` and `getLogsRange`
 * take with their readers.
 */
const quoterOn = (chainId, address) => ({
  // The quoter names the chain and address it will read — so a caller (and a test) can check WHERE
  // a quote comes from, not merely that some provider was constructed somewhere.
  chainId,
  address,
  quoteExactInputSingle: {
    staticCall: (params) =>
      readContract(chainId, {
        address,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        // Checksummed HERE, at the boundary, because this is where a caller's struct meets the
        // encoder. `quoteBestRoute` builds the struct from whatever addresses it was handed and
        // has no encoder of its own to answer for — and viem refuses an all-uppercase address
        // ethers accepted (divergence 16). Normalising inside the adapter keeps the duck type
        // honest for every caller rather than asking each one to remember.
        args: [{
          ...params,
          tokenIn: getAddress(String(params.tokenIn)),
          tokenOut: getAddress(String(params.tokenOut)),
        }],
      }),
  },
})

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Per-chain DEX wiring. Reads the active chain at runtime so switching networks
 * (wagmi.switchChain) transparently re-targets the right DEX deployment — Uniswap
 * on Polygon-family chains, ETCswap on the Ethereum Classic family (Spec 033).
 * Components that surface swap UI should branch on `isDexAvailable` and name the
 * provider via `dexProvider` from the returned context.
 */
export function DexProvider({ children }) {
  const { provider, address, isConnected, sendCalls } = useWallet()
  // Spec 043 (US3): swapping while operating as a vault becomes a threshold-gated vault proposal.
  const {
    isVault: operatingAsVault, canActAsVault,
    isLegacy: operatingAsLegacy,
    isHardware: operatingAsHardware,
    identity: activeIdentity, submit: submitAsActive,
  } = useActiveAccount()
  // Spec 088: the shared acting-address seam covers every kind (legacy, hardware, derived).
  const { address: effectiveTradingAddress, isActingAccount: actingForTrade } = useEffectiveAccount()
  const wagmiChainId = useWalletChainId()
  const chainId = wagmiChainId || getCurrentChainId()
  const network = getNetwork(chainId)

  // Reads must not depend on a wallet signer-provider: passkey sessions have
  // none (WalletContext leaves provider/signer null), yet they still need
  // balances and quotes. Fall back to the chain's public read provider, the
  // same pattern Portfolio and Earn use.
  const readProvider = useMemo(() => {
    if (provider) return provider
    if (!network?.rpcUrl) return null
    return makeReadProvider(network.rpcUrl, chainId)
  }, [provider, network?.rpcUrl, chainId])

  // The account whose funds the trade ticket represents: the vault when the
  // member operates as one (on the vault's own network), else the connected
  // wallet. Balances and swap recipients follow this address so "available to
  // trade" is accurate for the selected account (Spec 043).
  const tradingAddress = operatingAsVault
    ? (canActAsVault ? activeIdentity.vaultAddress : address)
    : actingForTrade && effectiveTradingAddress
      ? effectiveTradingAddress
      : address

  const dexConfig = network?.dex || null
  const stableConfig = network?.stablecoin || null
  const nativeConfig = network?.nativeCurrency || null

  const isDexAvailable = Boolean(dexConfig)

  // Provider identity for the active chain (ETC family → ETCswap; else Uniswap).
  // Independent of `dexConfig` so the swap UI can name the provider even when the
  // DEX is unconfigured on this network (Spec 033).
  const dexProvider = network?.dexProvider || null

  const addresses = useMemo(() => ({
    FACTORY: dexConfig?.factory || ZERO,
    SWAP_ROUTER_02: dexConfig?.swapRouter || ZERO,
    NONFUNGIBLE_TOKEN_POSITION_MANAGER: dexConfig?.positionManager || ZERO,
    QUOTER_V2: dexConfig?.quoter || ZERO,
    PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    WNATIVE: dexConfig?.wnative || ZERO,
    STABLECOIN: stableConfig?.address || ZERO,
  }), [dexConfig, stableConfig])

  const tokens = useMemo(() => ({
    WNATIVE: {
      address: addresses.WNATIVE,
      symbol: nativeConfig?.symbol ? `W${nativeConfig.symbol}` : 'WNATIVE',
      name: nativeConfig?.name ? `Wrapped ${nativeConfig.name}` : 'Wrapped Native',
      decimals: 18,
      icon: '🌐',
    },
    STABLE: stableConfig
      ? {
          address: stableConfig.address || ZERO,
          symbol: stableConfig.symbol,
          name: stableConfig.name,
          decimals: stableConfig.decimals,
          icon: '💵',
        }
      : {
          address: ZERO,
          symbol: 'STABLE',
          name: 'Stablecoin',
          decimals: 6,
          icon: '💵',
        },
    NATIVE: {
      address: 'native',
      symbol: nativeConfig?.symbol || 'POL',
      name: nativeConfig?.name || 'POL',
      decimals: nativeConfig?.decimals || 18,
      icon: '💎',
    },
  }), [addresses, stableConfig, nativeConfig])

  // The tradeable universe for the active chain: every fungible ERC-20 the
  // portfolio registry knows about on this network (wrapped native + stablecoin
  // from app-config, plus curated commodities/tools/stables) — i.e. the
  // portfolio assets that have a routeable pair on a chain we support. Native
  // coins (must be wrapped first) and NFT credentials are excluded.
  //
  // This is `getSwapTokens(chainId)` — the SAME derivation the multi-network
  // ticket applies to every other chain, deliberately not a second copy of it:
  // the connected chain's list must not be able to drift from the rest.
  const tradeTokens = useMemo(() => getSwapTokens(chainId), [chainId])

  // Address → metadata lookup so quote/swap math uses the right decimals and
  // ticker for any tradeable token, not just wrapped-native and the stablecoin.
  const tokenMeta = useMemo(() => {
    const map = new Map()
    for (const t of tradeTokens) map.set(t.address.toLowerCase(), t)
    return map
  }, [tradeTokens])

  const [balances, setBalances] = useState({
    native: '0',
    wnative: '0',
    stable: '0',
    tokens: {},
  })

  const [balanceHistory, setBalanceHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [quotingPrice, setQuotingPrice] = useState(false)
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE)

  /**
   * Spec 110: these were four `new Contract(addr, abi, readProvider)` instances. They are now the
   * ADDRESSES plus the chain they live on — the reads name the chain (`readContract(chainId, …)`)
   * and the encoders are module-level, because neither ever needed a provider.
   *
   * `readProvider` stays in the gate, not the read: it is what answers "is there anything to read
   * with", and `fetchBalances` still uses it for the NATIVE balance, which is a provider call and
   * not a contract call.
   */
  const stableTokenAddress = useMemo(
    () => (readProvider && stableConfig?.address ? stableConfig.address : null),
    [readProvider, stableConfig],
  )

  const contracts = useMemo(() => {
    if (!readProvider || !isDexAvailable) return null
    return {
      wnative: addresses.WNATIVE,
      stable: addresses.STABLECOIN,
      swapRouter: addresses.SWAP_ROUTER_02,
      quoter: addresses.QUOTER_V2,
    }
  }, [readProvider, isDexAvailable, addresses])

  const fetchBalances = useCallback(async () => {
    if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
      return
    }

    if (!readProvider || !tradingAddress) return
    // Need at least the stablecoin or the full DEX set to fetch anything useful
    if (!stableTokenAddress && !contracts) return

    try {
      setLoading(true)

      const nativeBalance = await readProvider.getBalance(tradingAddress)
      const holder = getAddress(String(tradingAddress))
      const balanceOfOn = (address) =>
        readContract(chainId, { address, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] })

      // Fetch wnative only when the DEX set is available
      const wnativeBalance = contracts ? await balanceOfOn(contracts.wnative) : 0n

      // Fetch the stable balance from the DEX set if available, otherwise from the
      // standalone stablecoin address
      const stableAddress = contracts?.stable || stableTokenAddress
      const stableBalance = stableAddress ? await balanceOfOn(stableAddress) : 0n

      const newBalances = {
        native: formatEther(nativeBalance),
        wnative: formatEther(wnativeBalance),
        stable: formatUnits(stableBalance, tokens.STABLE.decimals),
      }

      // Balances for the rest of the tradeable set (curated commodities/tools/
      // stables) so the ticket's "available to trade" line is accurate for any
      // selected asset, not just wrapped-native/stablecoin. Read-only, a handful
      // of tokens per chain, tolerant of per-token failure.
      const wnativeLower = addresses.WNATIVE.toLowerCase()
      const stableLower = addresses.STABLECOIN.toLowerCase()
      const tokenBalances = {
        [wnativeLower]: newBalances.wnative,
        [stableLower]: newBalances.stable,
      }
      const extraTokens = tradeTokens.filter((t) => {
        const lower = t.address.toLowerCase()
        return lower !== wnativeLower && lower !== stableLower
      })
      await Promise.all(
        extraTokens.map(async (t) => {
          try {
            const bal = await balanceOfOn(t.address)
            tokenBalances[t.address.toLowerCase()] = formatUnits(bal, t.decimals)
          } catch {
            tokenBalances[t.address.toLowerCase()] = '0'
          }
        }),
      )
      newBalances.tokens = tokenBalances

      setBalances(newBalances)

      setBalanceHistory(prev => [
        ...prev,
        {
          timestamp: Date.now(),
          ...newBalances,
        },
      ].slice(-100))
    } catch (error) {
      logger.error('Error fetching balances:', error)
    } finally {
      setLoading(false)
    }
  }, [readProvider, chainId, tradingAddress, contracts, stableTokenAddress, tokens.STABLE.decimals, tradeTokens, addresses])

  // Reset balances when the chain or the active account changes so the user
  // doesn't see stale numbers (e.g. personal balances while operating as a vault).
  useEffect(() => {
    setBalances({ native: '0', wnative: '0', stable: '0', tokens: {} })
    setBalanceHistory([])
  }, [chainId, tradingAddress])

  useEffect(() => {
    if (isConnected) {
      fetchBalances()
      const interval = setInterval(fetchBalances, 300000)
      return () => clearInterval(interval)
    }
  }, [isConnected, fetchBalances])

  // Wrap/unwrap ride the unified spec-041 write rail (WalletContext.sendCalls)
  // so BOTH session kinds work: passkey sessions authorize with one WebAuthn
  // ceremony (they have no ethers signer), classic wallets sign per call.
  // Operating as a vault turns the action into a threshold-gated proposal.
  const wrapNative = useCallback(async (amount) => {
    if (!contracts) {
      throw new Error('DEX is not available on the current network')
    }

    try {
      setLoading(true)
      const amountWei = parseEther(amount)
      const data = wnativeCall('deposit', [])
      const call = { to: addresses.WNATIVE, value: amountWei, data }

      if (operatingAsVault) {
        if (!canActAsVault) throw new Error("Switch to the vault's network to act as the vault.")
        const res = await submitAsActive({ batch: [call] })
        return { proposed: true, safeTxHash: res.safeTxHash }
      }

      // Spec 062: as a recovered legacy account, sign with its unlocked key (via
      // the active-account seam), executing immediately — never the connected wallet.
      if (operatingAsLegacy || operatingAsHardware) {
        // Spec 088: submitAsActive obtains the acting signer on demand (unlock / device
        // ceremony via the global host) — no pre-gate, and never the connected wallet.
        const res = await submitAsActive({ batch: [call] })
        await fetchBalances()
        return { sent: true, txHash: res.txHash }
      }

      if (typeof sendCalls !== 'function') throw new Error('Wallet not connected')
      const res = await sendCalls([call])
      if (res?.state === 'failed') throw new Error(res.reason || 'Transaction failed')

      await fetchBalances()
      return res
    } catch (error) {
      console.error('Error wrapping native:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }, [contracts, addresses, operatingAsVault, canActAsVault, operatingAsLegacy, operatingAsHardware, submitAsActive, sendCalls, fetchBalances])

  const unwrapNative = useCallback(async (amount) => {
    if (!contracts) {
      throw new Error('DEX is not available on the current network')
    }

    try {
      setLoading(true)
      const amountWei = parseEther(amount)
      const data = wnativeCall('withdraw', [amountWei])
      const call = { to: addresses.WNATIVE, value: 0n, data }

      if (operatingAsVault) {
        if (!canActAsVault) throw new Error("Switch to the vault's network to act as the vault.")
        const res = await submitAsActive({ batch: [call] })
        return { proposed: true, safeTxHash: res.safeTxHash }
      }

      if (operatingAsLegacy || operatingAsHardware) {
        // Spec 088: submitAsActive obtains the acting signer on demand (unlock / device
        // ceremony via the global host) — no pre-gate, and never the connected wallet.
        const res = await submitAsActive({ batch: [call] })
        await fetchBalances()
        return { sent: true, txHash: res.txHash }
      }

      if (typeof sendCalls !== 'function') throw new Error('Wallet not connected')
      const res = await sendCalls([call])
      if (res?.state === 'failed') throw new Error(res.reason || 'Transaction failed')

      await fetchBalances()
      return res
    } catch (error) {
      console.error('Error unwrapping native:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }, [contracts, addresses, operatingAsVault, canActAsVault, operatingAsLegacy, operatingAsHardware, submitAsActive, sendCalls, fetchBalances])

  // Decimals lookup for a token by address used in quote/swap calls below.
  // Defaults to 18 (native/wrapped) when the token isn't in our known set.
  const decimalsOf = useCallback((tokenAddress) => {
    const lower = tokenAddress?.toLowerCase?.()
    if (lower === addresses.STABLECOIN.toLowerCase()) return tokens.STABLE.decimals
    if (lower === addresses.WNATIVE.toLowerCase()) return 18
    return tokenMeta.get(lower)?.decimals ?? 18
  }, [addresses, tokens.STABLE.decimals, tokenMeta])

  // Symbol lookup for a token by address, used to label SDK Token instances so
  // the trade surface reads the right ticker on every chain.
  const symbolOf = useCallback((tokenAddress) => {
    const lower = tokenAddress?.toLowerCase?.()
    if (lower === addresses.STABLECOIN.toLowerCase()) return tokens.STABLE.symbol
    if (lower === addresses.WNATIVE.toLowerCase()) return tokens.WNATIVE.symbol
    return tokenMeta.get(lower)?.symbol ?? 'TOKEN'
  }, [addresses, tokens.STABLE.symbol, tokens.WNATIVE.symbol, tokenMeta])

  const getQuote = useCallback(async (tokenIn, tokenOut, amountIn, feeTier = FEE_TIERS.MEDIUM) => {
    if (!contracts) {
      throw new Error('DEX is not available on the current network')
    }

    try {
      setQuotingPrice(true)
      const decIn = decimalsOf(tokenIn)
      const decOut = decimalsOf(tokenOut)
      const amountInWei = parseUnits(amountIn, decIn)

      const params = {
        tokenIn: getAddress(String(tokenIn)),
        tokenOut: getAddress(String(tokenOut)),
        amountIn: amountInWei,
        fee: feeTier,
        sqrtPriceLimitX96: 0,
      }

      const result = await quoterOn(chainId, contracts.quoter).quoteExactInputSingle.staticCall(params)
      return formatUnits(result[0], decOut)
    } catch (error) {
      console.error('Error getting quote:', error)
      throw error
    } finally {
      setQuotingPrice(false)
    }
  }, [contracts, chainId, decimalsOf])

  /**
   * Quote a pair on ANY swap-capable network — the read half of multi-network
   * trading. The connected chain goes through the wallet/read provider already
   * wired above; every other chain gets its own read provider and its own
   * QuoterV2 (strictly per-chain addresses — a router or quoter borrowed from
   * another network would quote a pool that does not exist, or worse, price
   * against the wrong one). Leg decimals/symbols come from that chain's registry.
   *
   * Routing + SDK math live in lib/uniswap/quote.js, so a cross-chain quote and a
   * local one are the same computation, not two that can drift apart.
   */
  const getBestQuoteOn = useCallback(async (targetChainId, tokenIn, tokenOut, amountIn) => {
    const target = Number(targetChainId)
    const isActive = target === Number(chainId)

    if (isActive && !contracts) {
      throw new Error('DEX is not available on the current network')
    }
    if (!isActive && !isSwapChain(target)) {
      throw new Error(`Swapping is not available on ${NETWORKS[target]?.name || 'that network'}`)
    }

    let quoter = contracts ? quoterOn(chainId, contracts.quoter) : null
    let decIn = decimalsOf(tokenIn)
    let decOut = decimalsOf(tokenOut)
    let symIn = symbolOf(tokenIn)
    let symOut = symbolOf(tokenOut)

    if (!isActive) {
      const targetAddresses = getSwapAddresses(target)
      // The seam resolves the endpoint for `target` (spec 069 precedence: member override →
      // issued → build default). The line it replaces hand-built a provider from
      // `NETWORKS[target].rpcUrl`, which spec 069 forbids in as many words — so a member who had
      // repointed that network was quoted through the build default anyway.
      quoter = quoterOn(target, targetAddresses.quoter)
      const metaIn = getSwapTokenMeta(target, tokenIn)
      const metaOut = getSwapTokenMeta(target, tokenOut)
      decIn = metaIn?.decimals ?? 18
      decOut = metaOut?.decimals ?? 18
      symIn = metaIn?.symbol ?? 'TOKEN'
      symOut = metaOut?.symbol ?? 'TOKEN'
    }

    setQuotingPrice(true)
    try {
      return await quoteBestRoute({
        quoter,
        chainId: target,
        tokenIn,
        tokenOut,
        amountIn,
        decimalsIn: decIn,
        decimalsOut: decOut,
        symbolIn: symIn,
        symbolOut: symOut,
        slippageBps: slippage,
      })
    } finally {
      setQuotingPrice(false)
    }
  }, [contracts, decimalsOf, symbolOf, chainId, slippage])

  // Route a quote across the common V3 fee tiers on the CONNECTED chain.
  const getBestQuote = useCallback(
    (tokenIn, tokenOut, amountIn) => getBestQuoteOn(chainId, tokenIn, tokenOut, amountIn),
    [getBestQuoteOn, chainId],
  )

  /**
   * Execute (or, as a vault, propose) a swap.
   *
   * `opts.limitMinOutWei` — a Limit order's floor: the member's limit price
   * expressed as the minimum output amount. Uniswap V3 enforces it on-chain
   * via `amountOutMinimum`, making the order immediate-or-cancel — it fills at
   * the limit or better, or not at all. We pre-check against the fresh quote
   * so an unfillable limit fails with a plain reason before any wallet prompt.
   *
   * `opts.chainId` — the network the CALLER believes the pair lives on. Quotes
   * are cross-chain (getBestQuoteOn) but a swap is not: it uses THIS chain's
   * router and approves THIS chain's addresses. Passing the pair's chain makes a
   * mismatch fail here, before any signature, instead of approving a foreign
   * address that happens to be a contract on the connected chain.
   */
  const swap = useCallback(async (tokenIn, tokenOut, amountIn, opts = {}) => {
    if (!contracts || !tradingAddress) {
      throw new Error('Wallet not connected')
    }
    if (opts.chainId != null && Number(opts.chainId) !== Number(chainId)) {
      throw new Error(
        `This pair trades on ${NETWORKS[Number(opts.chainId)]?.name || 'another network'} — switch your wallet to that network to place the order.`,
      )
    }

    try {
      setLoading(true)

      // Re-quote at execution time so the route and minimum-received we enforce
      // on-chain match the freshest price, not a stale on-screen figure.
      const quote = await getBestQuote(tokenIn, tokenOut, amountIn)

      const decIn = decimalsOf(tokenIn)
      const amountInWei = parseUnits(amountIn, decIn)
      const isLimit = opts.limitMinOutWei != null
      const minAmountOutWei = isLimit ? BigInt(opts.limitMinOutWei) : quote.minimumReceivedWei

      if (isLimit && quote.amountOutWei < minAmountOutWei) {
        throw new Error(
          'The market is below your limit price right now — the order was not placed. Nothing was moved.'
        )
      }

      // Every address is checksummed before it reaches the encoder (divergence 16); the router
      // and the recipient decide where the member's money goes, so the validator and the encoder
      // have to agree about what an address is.
      const routerAddress = getAddress(String(addresses.SWAP_ROUTER_02))
      const swapParams = (recipient) => ({
        tokenIn: getAddress(String(tokenIn)),
        tokenOut: getAddress(String(tokenOut)),
        fee: quote.feeTier,
        recipient: getAddress(String(recipient)),
        amountIn: amountInWei,
        amountOutMinimum: minAmountOutWei,
        sqrtPriceLimitX96: 0,
      })
      const allowanceOf = (owner) =>
        readContract(chainId, {
          address: tokenIn,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [getAddress(String(owner)), routerAddress],
        })

      // Spec 043 (US3, FR-022a): swap AS a vault → batch [approve, exactInputSingle] with recipient = the
      // vault, proposed as a threshold-gated vault transaction. Only in the vault queue until executed.
      if (operatingAsVault) {
        if (!canActAsVault) throw new Error("Switch to the vault's network to swap as the vault.")
        const approveData = erc20Call('approve', [routerAddress, amountInWei])
        const swapData = swapRouterCall('exactInputSingle', [swapParams(activeIdentity.vaultAddress)])
        const res = await submitAsActive({
          batch: [
            { to: tokenIn, value: 0n, data: approveData },
            { to: addresses.SWAP_ROUTER_02, value: 0n, data: swapData },
          ],
        })
        return { proposed: true, safeTxHash: res.safeTxHash }
      }

      // Spec 062: swap AS a recovered legacy account. Same [approve?, swap] batch,
      // recipient = the legacy account, signed by its unlocked key via the
      // active-account seam (sequential txs for an EOA), executed immediately.
      // Approve is included only when the current allowance is short.
      if (operatingAsLegacy || operatingAsHardware) {
        // Spec 088: acting signer obtained on demand by submitAsActive — see wrapNative.
        const legacyAllowance = BigInt(await allowanceOf(tradingAddress))
        const batch = []
        if (legacyAllowance < amountInWei) {
          batch.push({ to: tokenIn, value: 0n, data: erc20Call('approve', [routerAddress, amountInWei]) })
        }
        batch.push({
          to: addresses.SWAP_ROUTER_02,
          value: 0n,
          data: swapRouterCall('exactInputSingle', [swapParams(tradingAddress)]),
        })
        const res = await submitAsActive({ batch })
        await fetchBalances()
        return { sent: true, txHash: res.txHash }
      }

      // Personal mode rides the unified spec-041 write rail: one batch through
      // sendCalls covers approval (only when needed, for the exact amount) and
      // the swap — a single WebAuthn ceremony for passkey sessions, sequential
      // signed transactions for classic wallets.
      if (typeof sendCalls !== 'function') throw new Error('Wallet not connected')

      const allowance = BigInt(await allowanceOf(tradingAddress))

      const calls = []
      if (allowance < amountInWei) {
        calls.push({
          to: tokenIn,
          value: 0n,
          data: erc20Call('approve', [routerAddress, amountInWei]),
        })
      }
      calls.push({
        to: addresses.SWAP_ROUTER_02,
        value: 0n,
        data: swapRouterCall('exactInputSingle', [swapParams(tradingAddress)]),
      })

      const res = await sendCalls(calls)
      if (res?.state === 'failed') throw new Error(res.reason || 'Transaction failed')

      await fetchBalances()
      return res
    } catch (error) {
      console.error('Error performing swap:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }, [contracts, chainId, tradingAddress, getBestQuote, fetchBalances, decimalsOf, addresses, operatingAsVault, canActAsVault, operatingAsLegacy, operatingAsHardware, activeIdentity, submitAsActive, sendCalls])

  const value = {
    balances,
    balanceHistory,
    loading,
    quotingPrice,
    slippage,

    fetchBalances,
    wrapNative,
    unwrapNative,
    getQuote,
    getBestQuote,
    getBestQuoteOn,
    swap,
    setSlippage,

    tokens,
    tradeTokens,
    addresses,
    isDexAvailable,
    dexProvider,
    chainId,
    network,
    tradingAddress,
  }

  return (
    <DexContext.Provider value={value}>
      {children}
    </DexContext.Provider>
  )
}
