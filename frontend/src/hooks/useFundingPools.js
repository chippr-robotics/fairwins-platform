/**
 * useFundingPools — data hook for funding pools (spec 103). Encapsulates every contract read/write so
 * pages stay presentational and testable (the pages mock this hook). Same shape and rails as
 * `usePools` (spec 034): a plain self-submitted EOA transaction when a signer exists, the passkey
 * account's `sendCalls` rail otherwise. The contracts carry `…WithSig` / EIP-3009 twins for a relayer;
 * that rail is a follow-up (research R8), so nothing here signs an intent.
 *
 * Honest state (Principle III): every number the page shows comes from `getSummary` (state reads) or
 * `getActivity` (the clone's own event log, bounded at its creation block). A failed read throws — it
 * never resolves to zeros.
 */
import { useCallback, useState } from 'react'
import { encodeFunctionData, decodeEventLog } from 'viem'
import { parseUnits } from '../lib/evm/units'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { getPublicClient } from '../lib/chains/publicClient'
import { eventScanHandle } from '../lib/chains/eventScan'
import { getLogsRange } from '../lib/chains/logRange'
import { getAddress } from '../lib/evm/address'
import { useWeb3 } from './useWeb3'
import { getContractAddressForChain } from '../config/contracts'
import {
  ERC20_ABI,
  readFundingFactory,
  readFundingPool,
  encodeFactoryCall,
  encodePoolCall,
  FUNDING_POOL_FACTORY_ABI,
  FUNDING_POOL_ABI,
  getFundingFactoryAddress,
  isFundingAvailable,
  fundingStateDisplay,
  REFUND_REASON,
} from '../lib/funding/fundingContracts'
import { phraseToIndices, indicesToPhrase, resolvePool } from '../lib/pools/gateway'
import { SUPPORTED_BIP39_LANGS, isLangAvailable } from '../lib/pools/bip39Lists'
import { getWordListLang } from '../utils/wordListLanguage'
import { deriveNickname } from '../lib/pools/nickname'
import { recordFundingPool } from '../lib/funding/myFundingPools'
import { progressPct, refundVotesNeeded, formatAmount, deadlinesFor } from '../lib/funding/progress'

const MAX_FEED = 200

/**
 * The one method `resolvePool` (lib/pools/gateway.js) calls, backed by the chain seam.
 *
 * `resolvePool` is SHARED with the wager pools, whose contract module is still deferred, so its
 * signature is left alone and this satisfies the duck type instead — the same move `getLogsRange`
 * and `scanLogs` take with their readers.
 */
const factoryReaderFor = (chainId) => ({
  poolByPhrase: (indices) => readFundingFactory(chainId, 'poolByPhrase', [indices]),
})

/** Fetch a receipt by hash, retrying briefly for RPC lag. */
async function waitReceipt(runner, txHash, tries = 8, delayMs = 1500) {
  if (!txHash) return null
  const reader =
    runner && typeof runner.getTransactionReceipt === 'function'
      ? runner
      : runner?.provider && typeof runner.provider.getTransactionReceipt === 'function'
        ? runner.provider
        : null
  if (!reader) return null
  for (let i = 0; i < tries; i += 1) {
    const r = await reader.getTransactionReceipt(txHash)
    if (r) return r
    await new Promise((res) => setTimeout(res, delayMs))
  }
  return null
}

const FACTORY_ABI_PARSED = normalizeAbi(FUNDING_POOL_FACTORY_ABI)

function parsePoolCreated(receipt) {
  const ev = (receipt?.logs || [])
    .map((l) => {
      try {
        const { eventName, args } = decodeEventLog({
          abi: FACTORY_ABI_PARSED,
          topics: l.topics,
          data: l.data,
        })
        return { name: eventName, args }
      } catch {
        return null
      }
    })
    .find((e) => e && e.name === 'PoolCreated')
  if (!ev) return { pool: null, poolId: null, wordIndices: null, phrase: null }
  const wordIndices = [...ev.args.wordIndices].map((x) => Number(x))
  return {
    pool: ev.args.pool,
    poolId: ev.args.poolId,
    wordIndices,
    phrase: safePhrase(wordIndices),
  }
}

function safePhrase(wordIndices, lang = getWordListLang()) {
  try {
    return indicesToPhrase(wordIndices, isLangAvailable(lang) ? lang : 'en')
  } catch {
    return null
  }
}

async function readToken(tokenAddr, chainId) {
  let decimals = 6
  let symbol = 'USDC'
  try {
    const ask = (functionName) =>
      readContract(chainId, { address: tokenAddr, abi: ERC20_ABI, functionName })
    decimals = Number(await ask('decimals'))
    symbol = await ask('symbol')
  } catch {
    /* USDC defaults */
  }
  return { decimals, symbol }
}

/** Assemble the PoolSummary (data-model.md) from state reads. Throws if the pool cannot be read. */
/**
 * The chain's own clock, from the latest block. Deadline decisions (contribution open, settle passed)
 * are enforced by the contract against `block.timestamp`, so the UI judges them by the same clock
 * rather than the device's — a wrong device clock must not offer a "Start refunds" the contract
 * would revert, or hide a contribute window that is still open. Falls back to the device clock only
 * when the chain cannot answer (no endpoint for it, or the read fails).
 *
 * Takes a CHAIN rather than a contract (spec 110): the clock is a property of the chain, and it
 * used to be reached by digging `contract.runner.provider` out of an ethers Contract — which is
 * the fusion of "where" with "who" this migration exists to remove.
 */
export async function chainNow(chainId) {
  try {
    const client = getPublicClient(chainId)
    if (client) {
      const block = await client.getBlock({ blockTag: 'latest' })
      const ts = Number(block?.timestamp)
      if (Number.isFinite(ts) && ts > 0) return ts
    }
  } catch {
    /* fall through to the device clock */
  }
  return Math.floor(Date.now() / 1000)
}

/**
 * @param {object} args
 * @param {number} args.chainId    the chain the pool lives on — an ARGUMENT now, not something
 *   fished out of a Contract's runner (spec 110)
 * @param {string} args.address    the pool clone
 * @param {boolean} args.hasFactory whether the factory is deployed here (the phrase is the only
 *   thing that needs it, and it is display-only)
 */
export async function summarizeFundingPool({ chainId, address, hasFactory, account, nowOverride = null }) {
  const now = nowOverride ?? (await chainNow(chainId))
  const ask = (functionName, args = []) => readFundingPool(chainId, address, functionName, args)
  const [
    stateNum, organizer, goal, purpose, tokenAddr, contributeDeadline, settleDeadline, createdBlock,
    totalRaised, contributorCount, refundVotes, refundedCount, refundReasonNum, closedAt,
  ] = await Promise.all([
    ask('state'), ask('organizer'), ask('goal'), ask('purpose'), ask('token'), ask('contributeDeadline'),
    ask('settleDeadline'), ask('createdBlock'), ask('totalRaised'), ask('contributorCount'),
    ask('refundVotes'), ask('refundedCount'), ask('refundReason'), ask('closedAt'),
  ])
  const { decimals, symbol } = await readToken(tokenAddr, chainId)
  const state = Number(stateNum)
  const raised = BigInt(totalRaised)
  const goalBn = BigInt(goal)
  const me = { contributed: 0n, contributedFormatted: '0', hasContributed: false, voted: false, refunded: false, canVote: false, canClaimRefund: false }
  if (account) {
    const [contributed, voted, refunded] = await Promise.all([
      ask('contributed', [getAddress(account)]),
      ask('votedRefund', [getAddress(account)]),
      ask('refunded', [getAddress(account)]),
    ])
    me.contributed = BigInt(contributed)
    me.contributedFormatted = formatAmount(me.contributed, decimals)
    me.hasContributed = me.contributed > 0n
    me.voted = Boolean(voted)
    me.refunded = Boolean(refunded)
    me.canVote = state === 0 && me.hasContributed && !me.voted
    me.canClaimRefund = state === 2 && me.hasContributed && !me.refunded
  }
  let wordIndices = null
  let phrase = null
  if (hasFactory) {
    try {
      wordIndices = [...(await readFundingFactory(chainId, 'phraseOfPool', [address]))].map((x) => Number(x))
      phrase = safePhrase(wordIndices)
    } catch {
      /* phrase is display-only */
    }
  }
  const isOrganizer = Boolean(account) && String(organizer).toLowerCase() === String(account).toLowerCase()
  const cd = Number(contributeDeadline)
  const sd = Number(settleDeadline)
  const contributionOpen = state === 0 && now < cd
  return {
    address,
    chainId,
    organizer,
    organizerAlias: deriveNickname(organizer, address).label,
    isOrganizer,
    purpose,
    goal: goalBn,
    goalFormatted: formatAmount(goalBn, decimals),
    totalRaised: raised,
    raisedFormatted: formatAmount(raised, decimals),
    progressPct: progressPct(raised, goalBn),
    goalMet: goalBn > 0n && raised >= goalBn,
    tokenAddress: tokenAddr,
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    contributorCount: Number(contributorCount),
    refundVotes: Number(refundVotes),
    refundVotesNeeded: refundVotesNeeded(Number(contributorCount)),
    refundedCount: Number(refundedCount),
    refundReason: REFUND_REASON[Number(refundReasonNum)] ?? null,
    state,
    stateLabel: fundingStateDisplay(state),
    contributeDeadline: cd,
    settleDeadline: sd,
    createdBlock: Number(createdBlock),
    closedAt: Number(closedAt),
    contributionOpen,
    canClose: isOrganizer && state === 0,
    canCancel: isOrganizer && state === 0,
    canPokeDeadline: state === 0 && now >= sd,
    now,
    me,
    wordIndices,
    phrase,
  }
}

/** Decode the clone's event log into feed entries (data-model.md ActivityEntry), newest first. */
export function decodeActivity(events, poolAddress) {
  const entries = []
  for (const e of events) {
    // `name` rather than ethers' `fragment.name` (spec 110): the scan seam decodes a log to
    // `{ name, args }`, and a shape this function accepted but the scan never produces would be a
    // fixture answering a question the chain no longer answers.
    if (!e || !e.name || !e.args) continue
    const base = { blockNumber: e.blockNumber, logIndex: e.index ?? e.logIndex ?? 0, txHash: e.transactionHash }
    switch (e.name) {
      case 'Contributed':
        entries.push({ ...base, kind: 'contribute', actor: e.args.contributor, amount: BigInt(e.args.amount) })
        break
      case 'PoolClosed':
        entries.push({ ...base, kind: 'close', actor: e.args.organizer, amount: BigInt(e.args.amount) })
        break
      case 'RefundVoted':
        entries.push({ ...base, kind: 'vote', actor: e.args.contributor, votes: Number(e.args.votes), needed: Number(e.args.needed) })
        break
      case 'RefundingStarted':
        entries.push({ ...base, kind: 'refunding', actor: null, reason: REFUND_REASON[Number(e.args.reason)] ?? null })
        break
      case 'RefundClaimed':
        entries.push({ ...base, kind: 'refund', actor: e.args.contributor, amount: BigInt(e.args.amount) })
        break
      default:
        break
    }
  }
  entries.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex))
  return entries.slice(0, MAX_FEED).map((en) => ({
    ...en,
    alias: en.actor ? deriveNickname(en.actor, poolAddress).label : null,
  }))
}

export function useFundingPools() {
  const { signer, provider, address, account, chainId, sendCalls } = useWeb3()
  const activeAddress = address || account
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

  const requireContext = useCallback(async ({ needAccount = true } = {}) => {
    const runner = signer || provider
    if (!runner) throw new Error('Connect your wallet to use pools.')
    if (needAccount && !activeAddress) throw new Error('Connect your wallet to use pools.')
    const net =
      chainId != null
        ? { chainId }
        : typeof runner.getNetwork === 'function'
          ? await runner.getNetwork()
          : runner.provider && typeof runner.provider.getNetwork === 'function'
            ? await runner.provider.getNetwork()
            : null
    const activeChainId = Number(net?.chainId)
    if (!activeChainId) throw new Error('Could not determine the active network.')
    return { runner, signer, chainId: activeChainId, account: activeAddress }
  }, [signer, provider, activeAddress, chainId])

  const requireSendCalls = useCallback(() => {
    if (typeof sendCalls !== 'function') {
      throw new Error('This wallet cannot submit pool transactions on the current transaction rail.')
    }
    return sendCalls
  }, [sendCalls])

  /** Submit one or more contract calls on whichever rail the wallet has. Returns a txHash-ish id. */
  const submit = useCallback(async (calls) => {
    const { signer: s } = await requireContext()
    if (s) {
      let last = null
      for (const c of calls) {
        const tx = await s.sendTransaction({ to: c.target, data: c.data, value: c.value ?? 0n })
        last = await tx.wait()
      }
      return last?.hash ?? null
    }
    const send = requireSendCalls()
    const submitted = await send(calls.map((c) => ({ target: c.target, data: c.data, value: c.value ?? 0n })))
    const id = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
    if (!id) throw new Error('Submitted, but no transaction reference was returned.')
    return id
  }, [requireContext, requireSendCalls])

  const wrap = useCallback(async (label, fn) => {
    setStatus(label)
    setError(null)
    try {
      const out = await fn()
      setStatus('idle')
      return out
    } catch (e) {
      setStatus('error')
      setError(e?.shortMessage || e?.message || String(e))
      throw e
    }
  }, [])

  /** Is the factory deployed on the active chain? (Read-only, never throws.) */
  const available = useCallback(() => isFundingAvailable(chainId), [chainId])

  /**
   * Create a pool. `form`: { purpose, goal (decimal string), windowId, token? }.
   * Returns { pool, poolId, wordIndices, phrase, txHash }.
   */
  const createPool = useCallback(async (form) => wrap('creating', async () => {
    const { runner, chainId: activeChainId, account: activeAccount } = await requireContext()
    const factoryAddress = getFundingFactoryAddress(activeChainId)
    if (!factoryAddress) {
      throw new Error(`Funding pools are not available on this network (chain ${activeChainId}).`)
    }
    const tokenAddr = form.token || getContractAddressForChain('paymentToken', activeChainId)
    if (!tokenAddr) throw new Error('No escrow token configured for this network.')
    const { decimals } = await readToken(tokenAddr, activeChainId)
    const { contributeDeadline, settleDeadline } = deadlinesFor(form.windowId)
    const params = {
      // `getAddress` and the `String(...)` wrapper are both load-bearing (spec 110, divergences 16
      // and 9): viem's encoder REFUSES an all-uppercase address that our validators accept, and it
      // STRINGIFIES a non-string into a `string` parameter — and `purpose` is the pool's PUBLIC
      // on-chain purpose, the sentence members read before deciding to contribute. A `null` would
      // be committed as the four characters "null".
      token: getAddress(String(tokenAddr).trim()),
      goal: parseUnits(String(form.goal), decimals),
      purpose: String(form.purpose).trim(),
      contributeDeadline,
      settleDeadline,
    }
    const data = encodeFactoryCall('createPool', [params])
    const txHash = await submit([{ target: factoryAddress, data }])
    const receipt = await waitReceipt(runner, txHash, 45, 2000)
    const parsed = parsePoolCreated(receipt)
    if (parsed.pool && activeAccount) recordFundingPool(activeAccount, parsed.pool, 'organizer')
    return { ...parsed, txHash }
  }), [requireContext, submit, wrap])

  /** Resolve a route ref ({ address } | { words }) to a pool address, or null. Tries every language. */
  const resolveRef = useCallback(async (ref) => {
    if (!ref) return null
    if (ref.address) return ref.address
    const { chainId: activeChainId } = await requireContext({ needAccount: false })
    const preferred = getWordListLang()
    const langs = [preferred, ...SUPPORTED_BIP39_LANGS.filter((l) => l !== preferred)].filter(isLangAvailable)
    const phrase = ref.words.join(' ')
    for (const lang of langs) {
      const indices = phraseToIndices(phrase, lang)
      if (!indices) continue
      const addr = await resolvePool(factoryReaderFor(activeChainId), indices)
      if (addr) return addr
    }
    return null
  }, [requireContext])

  /** Resolve four words to a pool summary for the unified lookup: { summary } | { notFound, reason }. */
  const resolvePhrase = useCallback(async (phrase, lang = getWordListLang()) => {
    const { chainId: activeChainId, account: activeAccount } = await requireContext({ needAccount: false })
    if (!isFundingAvailable(activeChainId)) return { notFound: true, reason: 'unavailable' }
    const indices = phraseToIndices(phrase, lang)
    if (!indices) return { notFound: true, reason: 'invalid' }
    const addr = await resolvePool(factoryReaderFor(activeChainId), indices)
    if (!addr) return { notFound: true, reason: 'unknown' }
    const summary = await summarizeFundingPool({
      chainId: activeChainId,
      address: addr,
      hasFactory: true,
      account: activeAccount,
    })
    return { summary }
  }, [requireContext])

  const getSummary = useCallback(async (poolAddress) => {
    const { chainId: activeChainId, account: activeAccount } = await requireContext({ needAccount: false })
    // Not deployed here — the summary still reads; only the phrase is unavailable.
    return summarizeFundingPool({
      chainId: activeChainId,
      address: poolAddress,
      hasFactory: isFundingAvailable(activeChainId),
      account: activeAccount,
    })
  }, [requireContext])

  /** The pool's activity feed from its own event log (research R7). Throws if logs cannot be read. */
  const getActivity = useCallback(async (poolAddress, createdBlock) => {
    const { chainId: activeChainId } = await requireContext({ needAccount: false })
    const handle = eventScanHandle(activeChainId, { address: poolAddress, abi: FUNDING_POOL_ABI })
    const client = getPublicClient(activeChainId)
    if (!handle || !client) throw new Error('No read connection for this network.')
    const fromBlock = Number(createdBlock) > 0 ? Number(createdBlock) : 0
    const latest = Number(await handle.provider.getBlockNumber())
    // `queryFilter('*')` — EVERY event this clone emitted, so no topic filter. It bisects on
    // refusal, which the single unbounded call it replaces did not: a range-capping RPC used to
    // make the whole feed throw.
    const logs = await getLogsRange(handle.provider, poolAddress, fromBlock, latest, 2000, [])
    const events = logs
      .map((log) => {
        // An undecodable log is SKIPPED, exactly as ethers' queryFilter left it undecoded and
        // `decodeActivity` dropped it — a clone can emit an event this ABI does not know.
        try {
          const { name, args } = handle.interface.parseLog(log)
          return { ...log, name, args }
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const entries = decodeActivity(events, poolAddress)
    // Timestamps: one getBlock per distinct block, bounded by the feed cap.
    const blocks = [...new Set(entries.map((e) => e.blockNumber))]
    const stamps = new Map()
    await Promise.all(blocks.map(async (bn) => {
      try {
        const b = await client.getBlock({ blockNumber: BigInt(bn) })
        if (b) stamps.set(bn, Number(b.timestamp))
      } catch {
        /* leave undefined */
      }
    }))
    return entries.map((e) => ({ ...e, timestamp: stamps.get(e.blockNumber) ?? null }))
  }, [requireContext])

  /** Contribute `amountText` (decimal string) to a pool: approve if needed, then contribute. */
  const contribute = useCallback(async (poolAddress, amountText, summary) => wrap('contributing', async () => {
    const { chainId: activeChainId, account: activeAccount } = await requireContext()
    const amount = parseUnits(String(amountText), summary.tokenDecimals)
    if (amount <= 0n) throw new Error('Enter an amount above zero.')
    const calls = []
    const allowance = await readContract(activeChainId, {
      address: summary.tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [getAddress(activeAccount), getAddress(poolAddress)],
    })
    if (BigInt(allowance) < amount) {
      calls.push({
        target: summary.tokenAddress,
        data: encodeFunctionData({
          abi: normalizeAbi(ERC20_ABI),
          functionName: 'approve',
          args: [getAddress(poolAddress), amount],
        }),
      })
    }
    calls.push({ target: poolAddress, data: encodePoolCall('contribute', [amount]) })
    const txHash = await submit(calls)
    recordFundingPool(activeAccount, poolAddress, 'contributor')
    return { txHash, amount }
  }), [requireContext, submit, wrap])

  const runSimple = useCallback(async (label, fn, poolAddress) => wrap(label, async () => {
    await requireContext()
    const txHash = await submit([{ target: poolAddress, data: encodePoolCall(fn, []) }])
    return { txHash }
  }), [wrap, requireContext, submit])

  const closePool = useCallback((poolAddress) => runSimple('closing', 'close', poolAddress), [runSimple])
  const cancelPool = useCallback((poolAddress) => runSimple('cancelling', 'cancel', poolAddress), [runSimple])
  const voteRefund = useCallback((poolAddress) => runSimple('voting', 'voteRefund', poolAddress), [runSimple])
  const claimRefund = useCallback((poolAddress) => runSimple('refunding', 'claimRefund', poolAddress), [runSimple])
  const pokeDeadline = useCallback((poolAddress) => runSimple('poking', 'pokeDeadline', poolAddress), [runSimple])

  return {
    status,
    error,
    available,
    createPool,
    resolveRef,
    resolvePhrase,
    getSummary,
    getActivity,
    contribute,
    closePool,
    cancelPool,
    voteRefund,
    claimRefund,
    pokeDeadline,
  }
}

export default useFundingPools
