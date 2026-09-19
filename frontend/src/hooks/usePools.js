/**
 * usePools — data hook for Wager Pools (spec 034, address-based — Semaphore removed). Encapsulates all
 * contract reads/writes so pages stay presentational and testable (the pages mock this hook). Membership,
 * voting, and claims are by PUBLIC WALLET ADDRESS: the roster comes from `Joined(address)` events, a
 * member's nickname is derived deterministically from their address, and the winner's address is the
 * "claim code". Timing mirrors WagerRegistry — two absolute deadlines, `acceptDeadline`/`resolveDeadline`.
 *
 * Relayer path (spec 035/036): every write below is a plain self-submitted EOA transaction today. The
 * contracts additionally expose EIP-712 `…WithSig` twins (approveWithSig/claimWithSig/…) and an EIP-3009
 * gasless join, so this layer can later route submissions through a relayer without changing the pages —
 * the action set here maps 1:1 to those twins.
 */
import { useCallback, useState } from 'react'
import { encodeFunctionData, decodeEventLog, zeroHash } from 'viem'
import { formatUnits, parseUnits } from '../lib/evm/units'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { eventScanHandle } from '../lib/chains/eventScan'
import { getAddress } from '../lib/evm/address'
import { useWeb3 } from './useWeb3'
import { getContractAddressForChain, getDeploymentBlockForChain } from '../config/contracts'
import {
  ERC20_ABI,
  WAGER_POOL_ABI,
  WAGER_POOL_FACTORY_ABI,
  encodeFactoryCall,
  encodePoolCall,
  getFactoryAddress,
  readPool,
  readPoolFactory,
  POOL_STATE,
  poolStateDisplay,
} from '../lib/pools/poolContracts'
import { phraseToIndices, resolvePool, indicesToPhrase } from '../lib/pools/gateway'
import { deriveNickname } from '../lib/pools/nickname'
import { payoutMatrixHash } from '../lib/pools/payout'
import { recordJoinedPool } from '../lib/lookup/myWagersSources'
import { useGaslessWrite } from '../lib/relay/useGaslessWrite'

/** Fetch a receipt by hash, retrying briefly for relay/RPC lag (self-submit resolves on the first try). */
async function waitReceipt(runner, txHash, tries = 8, delayMs = 1500) {
  if (!txHash) return null
  const receiptReader =
    runner && typeof runner.getTransactionReceipt === 'function'
      ? runner
      : runner?.provider && typeof runner.provider.getTransactionReceipt === 'function'
        ? runner.provider
        : null
  if (!receiptReader) return null
  for (let i = 0; i < tries; i += 1) {
    const r = await receiptReader.getTransactionReceipt(txHash)
    if (r) return r
    await new Promise((res) => setTimeout(res, delayMs))
  }
  return null
}

const FACTORY_ABI_PARSED = normalizeAbi(WAGER_POOL_FACTORY_ABI)

/** Parse the PoolCreated event from a create receipt into the hook's return shape. */
function parsePoolCreated(receipt, account) {
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
  const wordIndices = ev ? ev.args.wordIndices.map((x) => Number(x)) : null
  // Record the pool device-locally so My Wagers can always list it, even when the subgraph for this
  // chain is lagging or absent (tester feedback: pools must be easy to locate again).
  if (ev && account) recordJoinedPool(account, ev.args.pool)
  return {
    poolId: ev ? ev.args.poolId : null,
    pool: ev ? ev.args.pool : null,
    wordIndices,
    phrase: wordIndices ? indicesToPhrase(wordIndices) : null,
    txHash: receipt?.hash ?? null,
  }
}

/**
 * `resolvePool` is duck-typed on one method, so the gateway's signature is left alone and this
 * satisfies it from the read seam (the same move `useFundingPools` makes).
 */
const factoryReaderFor = (chainId) => ({
  poolByPhrase: (indices) => readPoolFactory(chainId, 'poolByPhrase', [indices]),
})

/**
 * One `eth_getLogs` for one event on a pool clone — the exact shape `queryFilter(filter, from)` had.
 *
 * Deliberately NOT `getLogsRange`: `queryFilter` made a SINGLE request that either answered or
 * threw, and these scans start at the factory's deploy block — 0 on a chain where none is recorded.
 * Bisecting that range on a refusal would turn one honest failure into thousands of requests.
 *
 * `fromBlock` is the factory's deploy block rather than genesis. A clone cannot emit before the
 * factory that created it existed, so this can drop no event; it is the bound `fetchProposedMatrix`
 * already applied, now applied to the roster scan too.
 */
async function scanPoolEvent(chainId, poolAddress, eventName) {
  const handle = eventScanHandle(chainId, { address: poolAddress, abi: WAGER_POOL_ABI })
  if (!handle) throw new Error('No read connection for this network.')
  const fromBlock = getDeploymentBlockForChain('wagerPoolFactory', chainId) || 0
  const toBlock = Number(await handle.provider.getBlockNumber())
  const topics = handle.filters[eventName]().getTopicFilter()
  const logs = await handle.provider.getLogs({ address: poolAddress, topics, fromBlock, toBlock })
  return logs
    .map((log) => {
      try {
        const { name, args } = handle.interface.parseLog(log)
        return { ...log, name, args }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function requiredApprovals(frozenDenominator, thresholdBips) {
  if (frozenDenominator <= 0) return 0
  return Math.max(1, Math.ceil((frozenDenominator * thresholdBips) / 10000))
}

/**
 * Checksum every winner before the matrix is ENCODED (spec 110 divergence 16).
 *
 * `payoutMatrixHash` already normalises its rows with `getAddress` and hashes BYTES, so the hash
 * accepts an all-uppercase winner. viem's encoder does not. Without this the id a creator commits
 * to and the calldata that carries the matrix would disagree about what is acceptable — the hash
 * would compute and the send would throw.
 */
const normEntries = (entries) =>
  entries.map((e) => ({ winner: getAddress(String(e.winner)), amount: BigInt(e.amount) }))

async function summarizePool(chainId, address, account) {
  const ask = (functionName, args = []) => readPool(chainId, address, functionName, args)
  const [
    stateNum, buyIn, tokenAddr, memberCount, maxMembers, thresholdBips,
    acceptDeadline, creator, frozenDenominator, closedAt, resolveDeadline, currentProposalId,
  ] = await Promise.all([
    ask('state'), ask('buyIn'), ask('token'), ask('memberCount'), ask('maxMembers'),
    ask('thresholdBips'), ask('acceptDeadline'), ask('creator'), ask('frozenDenominator'),
    ask('closedAt'), ask('resolveDeadline'), ask('currentProposalId'),
  ])
  let decimals = 6
  let symbol = 'USDC'
  try {
    const askToken = (functionName) =>
      readContract(chainId, { address: tokenAddr, abi: ERC20_ABI, functionName })
    decimals = Number(await askToken('decimals'))
    symbol = await askToken('symbol')
  } catch {
    /* fall back to USDC defaults */
  }

  const state = Number(stateNum)
  const denom = Number(frozenDenominator)
  const bips = Number(thresholdBips)
  const now = Math.floor(Date.now() / 1000)
  // Resolution is valid until the ABSOLUTE resolve deadline (no drift — matches WagerRegistry).
  const windowEnd = Number(resolveDeadline)
  const hasProposal = currentProposalId && currentProposalId !== zeroHash

  let hasJoined = false
  let alreadyRefunded = false
  let approvalCount = 0
  let alreadyApproved = false
  if (account) {
    const who = getAddress(account)
    hasJoined = await ask('hasJoined', [who])
    alreadyRefunded = await ask('refunded', [who])
    if (hasProposal) alreadyApproved = await ask('approvedBy', [currentProposalId, who])
  }
  if (hasProposal) approvalCount = Number(await ask('proposalApprovals', [currentProposalId]))

  const withinResolutionWindow = state === 1 && now < windowEnd
  const refundEligible =
    (state === 3 || (state === 1 && now >= windowEnd)) && hasJoined && !alreadyRefunded

  return {
    address,
    state,
    stateLabel: POOL_STATE[state] ?? 'Unknown',
    stateDisplay: poolStateDisplay(state),
    buyIn,
    buyInFormatted: formatUnits(buyIn, decimals),
    tokenAddress: tokenAddr,
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    memberCount: Number(memberCount),
    maxMembers: Number(maxMembers),
    slotsRemaining: Number(maxMembers) - Number(memberCount),
    thresholdBips: bips,
    thresholdPct: bips / 100,
    acceptDeadline: Number(acceptDeadline),
    resolveDeadline: Number(resolveDeadline),
    closedAt: Number(closedAt),
    creator,
    isCreator: account ? creator.toLowerCase() === account.toLowerCase() : false,
    hasJoined,
    alreadyApproved,
    frozenDenominator: denom,
    currentProposalId: hasProposal ? currentProposalId : null,
    approvalCount,
    requiredApprovals: requiredApprovals(denom, bips),
    withinResolutionWindow,
    refundEligible,
  }
}

export function usePools() {
  const { signer, provider, address, account, chainId, sendCalls } = useWeb3()
  const activeAddress = address || account
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

  const requireContext = useCallback(async () => {
    const runner = signer || provider
    if (!runner) throw new Error('Connect your wallet to use group pools.')
    if (!activeAddress) throw new Error('Connect your wallet to use group pools.')
    const net =
      chainId != null
        ? { chainId }
        : typeof runner.getNetwork === 'function'
          ? await runner.getNetwork()
          : runner.provider && typeof runner.provider.getNetwork === 'function'
            ? await runner.provider.getNetwork()
            : null
    const activeChainId = Number(net?.chainId)
    if (!activeChainId) throw new Error('Could not determine the active network for group pools.')
    return { runner, signer, chainId: activeChainId, account: activeAddress }
  }, [signer, provider, activeAddress, chainId])

  const requireSendCalls = useCallback(() => {
    if (typeof sendCalls !== 'function') {
      throw new Error('This wallet cannot submit pool transactions on the current transaction rail.')
    }
    return sendCalls
  }, [sendCalls])

  // ---- Gasless seams (spec 035/036 Tier 2, factory-forwarder) ----
  // Each pool write routes through the relayer when one is live and transparently self-submits otherwise
  // (never-stranded, FR-014). The `selfSubmit` closure IS the original EOA path; `params` shapes the
  // signed intent. Target resolves to the WagerPoolFactory (the action verifier key); the pool clone
  // rides in params and — for the six actor twins — is the EIP-712 verifyingContract (domain/target
  // split), so only the factory is ever the tx target. Behaviour-neutral on chains the relayer doesn't
  // serve (Mordor's stablecoin lacks EIP-3009 → join self-submits; unset relayer → all self-submit).
  const poolCreateTx = useGaslessWrite('poolCreate', {
    params: (form, ctx) => ({
      token: ctx.params.token,
      buyIn: ctx.params.buyIn,
      maxMembers: ctx.params.maxMembers,
      thresholdBips: ctx.params.thresholdBips,
      acceptDeadline: ctx.params.acceptDeadline,
      resolveDeadline: ctx.params.resolveDeadline,
    }),
    selfSubmit: async (form, ctx) => {
      const { signer: s } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted pool creation.')
      return (
        await s.sendTransaction({
          to: ctx.factoryAddress,
          data: encodeFactoryCall('createPool', [ctx.params]),
        })
      ).wait()
    },
  })
  const joinTx = useGaslessWrite('poolJoin', {
    params: (poolAddress) => ({ pool: poolAddress }),
    payment: (poolAddress, summary) => ({ value: summary.buyIn }),
    selfSubmit: async (poolAddress, summary, account) => {
      const { signer: s, chainId: activeChainId } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted join.')
      const allowance = await readContract(activeChainId, {
        address: summary.tokenAddress,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [getAddress(String(account)), getAddress(String(poolAddress))],
      })
      if (BigInt(allowance) < summary.buyIn) {
        await (
          await s.sendTransaction({
            to: summary.tokenAddress,
            data: encodeFunctionData({
              abi: normalizeAbi(ERC20_ABI),
              functionName: 'approve',
              args: [getAddress(String(poolAddress)), summary.buyIn],
            }),
          })
        ).wait()
      }
      return (await s.sendTransaction({ to: poolAddress, data: encodePoolCall('join', []) })).wait()
    },
  })
  const closeJoiningTx = useGaslessWrite('poolCloseJoining', {
    params: (poolAddress) => ({ pool: poolAddress }),
    selfSubmit: async (poolAddress) => {
      const { signer: s } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted close.')
      return (await s.sendTransaction({ to: poolAddress, data: encodePoolCall('closeJoining', []) })).wait()
    },
  })
  const cancelTx = useGaslessWrite('poolCancel', {
    params: (poolAddress) => ({ pool: poolAddress }),
    selfSubmit: async (poolAddress) => {
      const { signer: s } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted cancel.')
      return (await s.sendTransaction({ to: poolAddress, data: encodePoolCall('cancel', []) })).wait()
    },
  })
  const proposeTx = useGaslessWrite('poolProposeOutcome', {
    params: (poolAddress, entries) => ({ pool: poolAddress, entries, proposalId: payoutMatrixHash(entries) }),
    selfSubmit: async (poolAddress, entries) => {
      const { signer: s } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted proposal.')
      return (
        await s.sendTransaction({
          to: poolAddress,
          data: encodePoolCall('proposeOutcome', [normEntries(entries)]),
        })
      ).wait()
    },
  })
  const approveTx = useGaslessWrite('poolApprove', {
    params: (poolAddress, proposalId) => ({ pool: poolAddress, proposalId }),
    selfSubmit: async (poolAddress, proposalId, step) => {
      const { signer: s } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted approval.')
      step?.('Confirm the approval in your wallet…')
      const tx = await s.sendTransaction({ to: poolAddress, data: encodePoolCall('approve', []) })
      step?.('Submitting your approval on-chain…')
      return tx.wait()
    },
  })
  const claimTx = useGaslessWrite('poolClaim', {
    params: (poolAddress, entries, index, recipient) => ({ pool: poolAddress, entries, index, recipient }),
    selfSubmit: async (poolAddress, entries, index, recipient) => {
      const { signer: s } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted claim.')
      return (
        await s.sendTransaction({
          to: poolAddress,
          data: encodePoolCall('claim', [normEntries(entries), index, getAddress(String(recipient))]),
        })
      ).wait()
    },
  })
  const refundTx = useGaslessWrite('poolRefund', {
    params: (poolAddress) => ({ pool: poolAddress }),
    selfSubmit: async (poolAddress) => {
      const { signer: s } = await requireContext()
      if (!s) throw new Error('No signer available for self-submitted refund.')
      return (await s.sendTransaction({ to: poolAddress, data: encodePoolCall('refund', []) })).wait()
    },
  })

  /**
   * Create a pool. `form`: { buyIn, maxMembers, thresholdPct, token?, acceptDeadline, resolveDeadline,
   * joinDays?, resolutionDays? }. The create UI passes exact instants from the shared DeadlineTimeline —
   * `acceptDeadline` and `resolveDeadline` (unix seconds), identical to the 1v1/open-challenge flow; the
   * older day-count fields remain as a fallback.
   */
  const createPool = useCallback(async (form) => {
    setStatus('creating')
    setError(null)
    try {
      const { runner, signer: writeSigner, chainId: activeChainId, account: activeAccount } = await requireContext()
      const factoryAddress = getFactoryAddress(activeChainId)
      if (!factoryAddress) {
        throw new Error(`Wager pools are not available on this network (chain ${activeChainId}).`)
      }
      const tokenAddr = form.token || getContractAddressForChain('paymentToken', activeChainId)
      if (!tokenAddr) throw new Error('No buy-in token configured for this network.')
      let decimals = 6
      try {
        decimals = Number(
          await readContract(activeChainId, {
            address: tokenAddr,
            abi: ERC20_ABI,
            functionName: 'decimals',
          }),
        )
      } catch {
        /* default USDC */
      }
      const now = Math.floor(Date.now() / 1000)
      const acceptDeadline =
        form.acceptDeadline != null ? Number(form.acceptDeadline) : now + Number(form.joinDays) * 86400
      const resolveDeadline =
        form.resolveDeadline != null
          ? Number(form.resolveDeadline)
          : acceptDeadline + Number(form.resolutionDays) * 86400
      const params = {
        // Checksummed before it reaches the encoder (spec 110 divergence 16: viem refuses an
        // all-uppercase address ethers accepted). EIP-712 encodes an address as 20 bytes, so the
        // relayed intent signs identically either way — the calldata is the half that cares.
        token: getAddress(String(tokenAddr)),
        buyIn: parseUnits(String(form.buyIn), decimals),
        maxMembers: Number(form.maxMembers),
        thresholdBips: Math.round(Number(form.thresholdPct) * 100),
        acceptDeadline,
        resolveDeadline,
      }
      let txHash
      if (writeSigner) {
        // Gasless when a relayer is live (createPoolWithSig, attributed to the signer), else self-submit.
        const result = await poolCreateTx.run(form, { factoryAddress, params, account: activeAccount })
        if (result?.error) throw result.error
        txHash = result.txHash
      } else {
        const send = requireSendCalls()
        const data = encodeFactoryCall('createPool', [params])
        const submitted = await send([{ target: factoryAddress, data, value: 0n }])
        txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
        if (!txHash) throw new Error('Pool creation submitted but no transaction hash was returned.')
      }
      // run() surfaces only a txHash; re-read the receipt to recover the pool address + share phrase
      // (the PoolCreated event) uniformly across the relay and self-submit paths. A relayed tx can lag
      // well behind its ACK, so poll generously (~90s) — losing the receipt means losing the pool's
      // address + share phrase + the device-local record, while the escrow has already succeeded.
      const receipt = await waitReceipt(runner, txHash, 45, 2000)
      setStatus('idle')
      const parsed = parsePoolCreated(receipt, activeAccount)
      // Never drop the txHash even if the receipt hasn't landed in time — the UI needs it to show a
      // pending pool the user can recover, not an all-null result that reads as a failure.
      return { ...parsed, txHash: parsed.txHash ?? txHash ?? null }
    } catch (e) {
      setStatus('error')
      setError(e?.shortMessage || e?.message || String(e))
      throw e
    }
  }, [requireContext, poolCreateTx, requireSendCalls])

  /** Resolve a four-word phrase to a pool summary, or null if it maps to no pool. */
  const resolvePhrase = useCallback(async (phrase, lang = 'en') => {
    setError(null)
    const indices = phraseToIndices(phrase, lang)
    if (!indices) return { notFound: true, reason: 'invalid' }
    const { chainId: activeChainId, account: activeAccount } = await requireContext()
    const addr = await resolvePool(factoryReaderFor(activeChainId), indices)
    if (!addr) return { notFound: true, reason: 'unknown' }
    const summary = await summarizePool(activeChainId, addr, activeAccount)
    return { summary }
  }, [requireContext])

  /** Read a pool summary by address. */
  const getPoolSummary = useCallback(async (address) => {
    const { chainId: activeChainId, account: activeAccount } = await requireContext()
    return summarizePool(activeChainId, address, activeAccount)
  }, [requireContext])

  /**
   * Join a pool. Gasless via EIP-3009 (joinWithAuthorization → the factory forwarder) where the chain's
   * stablecoin supports it AND a relayer is live; otherwise the classic approve-then-join self-submit
   * (also the fallback on Mordor, whose stablecoin lacks EIP-3009). One signature vs two txs when gasless.
   */
  const joinPool = useCallback(async (poolAddress) => {
    setStatus('joining')
    setError(null)
    try {
      const { signer: writeSigner, chainId: activeChainId, account: activeAccount } = await requireContext()
      const summary = await summarizePool(activeChainId, poolAddress, activeAccount)
      let txHash
      if (writeSigner) {
        const result = await joinTx.run(poolAddress, summary, activeAccount)
        if (result?.error) throw result.error
        txHash = result.txHash
      } else {
        const send = requireSendCalls()
        const allowance = await readContract(activeChainId, {
          address: summary.tokenAddress,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [getAddress(String(activeAccount)), getAddress(String(poolAddress))],
        })
        const calls = []
        if (BigInt(allowance) < summary.buyIn) {
          calls.push({
            target: summary.tokenAddress,
            data: encodeFunctionData({
              abi: normalizeAbi(ERC20_ABI),
              functionName: 'approve',
              args: [getAddress(String(poolAddress)), summary.buyIn],
            }),
            value: 0n,
          })
        }
        calls.push({ target: poolAddress, data: encodePoolCall('join', []), value: 0n })
        const submitted = await send(calls)
        txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
        if (!txHash) throw new Error('Join submitted but no transaction hash was returned.')
      }
      // Record the join device-locally so EVERY join path makes the pool findable in My Wagers.
      recordJoinedPool(activeAccount, poolAddress)
      setStatus('idle')
      return { txHash }
    } catch (e) {
      setStatus('error')
      setError(e?.shortMessage || e?.message || String(e))
      throw e
    }
  }, [requireContext, joinTx, requireSendCalls])

  /**
   * The pool roster: member wallet addresses from `Joined(address)` events, each with a deterministic
   * nickname derived from the public address. Read directly from chain so the roster does NOT depend on
   * the subgraph (the subgraph is for discovery/listing only).
   */
  const getMembers = useCallback(async (poolAddress) => {
    const { chainId: activeChainId } = await requireContext()
    const events = await scanPoolEvent(activeChainId, poolAddress, 'Joined')
    return events.map((e) => {
      const address = e.args.member
      return { address, nickname: deriveNickname(address, poolAddress) }
    })
  }, [requireContext])

  /** The connected member's deterministic nickname for a pool (derived from their public address). */
  const getMyNickname = useCallback(async (poolAddress) => {
    const { account: activeAccount } = await requireContext()
    return deriveNickname(activeAccount, poolAddress)
  }, [requireContext])

  /**
   * Read the creator's proposed payout matrix straight from the chain. `proposeOutcome` now commits AND
   * EMITS the full `PayoutEntry[]` (event `OutcomeProposed`), so any member can read the split without the
   * creator sharing it off-chain. Returns the CURRENT proposal's rows as `[{ winner, amount: bigint }]`,
   * VERIFIED to hash back to the on-chain proposalId, or null when there is no proposal / the RPC can't
   * serve logs (in which case the off-chain paste in proposalStore stays as the fallback).
   */
  const fetchProposedMatrix = useCallback(async (poolAddress) => {
    try {
      const { chainId: activeChainId } = await requireContext()
      const onChainId = await readPool(activeChainId, poolAddress, 'currentProposalId')
      const targetId = onChainId && onChainId !== zeroHash ? onChainId : null
      // The scan is bounded to the factory's deploy block (never genesis) inside `scanPoolEvent`; a
      // provider that still rejects the range throws below and we return null so the off-chain
      // fallback takes over.
      const events = await scanPoolEvent(activeChainId, poolAddress, 'OutcomeProposed')
      if (!events.length) return null
      // Prefer the event matching the current on-chain proposalId (the latest one if the creator revised);
      // fall back to the most recent event otherwise (e.g. a resolved pool whose id is no longer exposed).
      const match =
        (targetId && [...events].reverse().find((e) => e.args.proposalId === targetId)) ||
        events[events.length - 1]
      const entries = (match.args.entries || []).map((e) => ({ winner: e.winner, amount: BigInt(e.amount) }))
      if (!entries.length) return null
      // Trust the decoded matrix only if it hashes to the id it claims (guards against a bad decode).
      if (payoutMatrixHash(entries) !== (targetId || match.args.proposalId)) return null
      return entries
    } catch {
      return null
    }
  }, [requireContext])

  /** Creator: close joining early (freezes the denominator). Gasless when a relayer is live. */
  const closeJoining = useCallback(async (poolAddress) => {
    if (signer) {
      const result = await closeJoiningTx.run(poolAddress)
      if (result?.error) throw result.error
      return result.txHash
    }
    await requireContext()
    const send = requireSendCalls()
    const submitted = await send([{ target: poolAddress, data: encodePoolCall('closeJoining', []), value: 0n }])
    const txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
    if (!txHash) throw new Error('Close submitted but no transaction hash was returned.')
    return txHash
  }, [signer, closeJoiningTx, requireContext, requireSendCalls])

  /** Anyone: close joining once the accept deadline has passed (permissionless keeper — self-submit). */
  const pokeDeadline = useCallback(async (poolAddress) => {
    const { signer: writeSigner } = await requireContext()
    if (writeSigner) {
      const tx = await writeSigner.sendTransaction({
        to: poolAddress,
        data: encodePoolCall('pokeDeadline', []),
      })
      return (await tx.wait()).hash
    }
    const send = requireSendCalls()
    const submitted = await send([{ target: poolAddress, data: encodePoolCall('pokeDeadline', []), value: 0n }])
    const txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
    if (!txHash) throw new Error('Deadline poke submitted but no transaction hash was returned.')
    return txHash
  }, [requireContext, requireSendCalls])

  /** Creator: cancel a pool before it fills (members can then refund). Gasless when a relayer is live. */
  const cancelPool = useCallback(async (poolAddress) => {
    if (signer) {
      const result = await cancelTx.run(poolAddress)
      if (result?.error) throw result.error
      return result.txHash
    }
    await requireContext()
    const send = requireSendCalls()
    const submitted = await send([{ target: poolAddress, data: encodePoolCall('cancel', []), value: 0n }])
    const txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
    if (!txHash) throw new Error('Cancellation submitted but no transaction hash was returned.')
    return txHash
  }, [signer, cancelTx, requireContext, requireSendCalls])

  /**
   * Creator: propose (or revise) the payout outcome by committing the FULL payout matrix. The contract
   * validates it on-chain (non-empty, non-zero winners, amounts sum to the exact escrow) and emits it, so
   * every member can read the split from the chain before approving. `entries` is a `{winner, amount}[]`
   * array; the on-chain `proposalId` = keccak256(abi.encode(entries)). Gasless when a relayer is live.
   */
  const proposeOutcome = useCallback(async (poolAddress, entries) => {
    if (signer) {
      const result = await proposeTx.run(poolAddress, entries)
      if (result?.error) throw result.error
      return result.txHash
    }
    await requireContext()
    const send = requireSendCalls()
    const submitted = await send([
      { target: poolAddress, data: encodePoolCall('proposeOutcome', [normEntries(entries)]), value: 0n },
    ])
    const txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
    if (!txHash) throw new Error('Proposal submitted but no transaction hash was returned.')
    return txHash
  }, [signer, proposeTx, requireContext, requireSendCalls])

  /**
   * Member: approve the current proposal with your wallet (one approval per member per proposal). Plain
   * transaction — no ZK proof, no WASM. `onProgress(message)` reports the submission phase.
   */
  const vote = useCallback(async (poolAddress, onProgress) => {
    const step = (m) => { try { onProgress?.(m) } catch { /* ignore */ } }
    setStatus('voting')
    setError(null)
    try {
      const { signer: writeSigner, chainId: activeChainId } = await requireContext()
      // Pin the CURRENT proposalId the member is approving — approveWithSig binds it so a relayer can
      // never retarget the approval to a matrix the member never saw (anti-rug).
      const proposalId = await readPool(activeChainId, poolAddress, 'currentProposalId')
      if (!proposalId || proposalId === zeroHash) {
        throw new Error('There is no proposed payout to approve yet.')
      }
      let txHash
      if (writeSigner) {
        const result = await approveTx.run(poolAddress, proposalId, step)
        if (result?.error) throw result.error
        txHash = result.txHash
      } else {
        const send = requireSendCalls()
        step('Confirm the approval in your wallet…')
        const submitted = await send([{ target: poolAddress, data: encodePoolCall('approve', []), value: 0n }])
        txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
        if (!txHash) throw new Error('Approval submitted but no transaction hash was returned.')
      }
      setStatus('idle')
      return txHash
    } catch (e) {
      setStatus('error')
      setError(e?.shortMessage || e?.message || String(e))
      throw e
    }
  }, [requireContext, approveTx, requireSendCalls])

  /**
   * Winner: claim a share to `recipient`. `entries` is the payout-matrix preimage (shared by the creator);
   * the connected wallet must equal `entries[index].winner`.
   */
  const claimWinnings = useCallback(async (poolAddress, { entries, index, recipient }) => {
    setStatus('claiming')
    setError(null)
    try {
      // Strongest gasless case: a winner holding zero gas. claimWithSig binds (index, recipient) to the
      // signer, so the relayer can never redirect the payout to itself.
      let txHash
      if (signer) {
        const result = await claimTx.run(poolAddress, entries, index, recipient)
        if (result?.error) throw result.error
        txHash = result.txHash
      } else {
        await requireContext()
        const send = requireSendCalls()
        const submitted = await send([
          {
            target: poolAddress,
            data: encodePoolCall('claim', [normEntries(entries), index, getAddress(String(recipient))]),
            value: 0n,
          },
        ])
        txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
        if (!txHash) throw new Error('Claim submitted but no transaction hash was returned.')
      }
      setStatus('idle')
      return txHash
    } catch (e) {
      setStatus('error')
      setError(e?.shortMessage || e?.message || String(e))
      throw e
    }
  }, [signer, claimTx, requireContext, requireSendCalls])

  /** Member: recover the buy-in after a timeout or cancellation. Gasless (a stranded member has no gas). */
  const refund = useCallback(async (poolAddress) => {
    setStatus('refunding')
    setError(null)
    try {
      let txHash
      if (signer) {
        const result = await refundTx.run(poolAddress)
        if (result?.error) throw result.error
        txHash = result.txHash
      } else {
        await requireContext()
        const send = requireSendCalls()
        const submitted = await send([{ target: poolAddress, data: encodePoolCall('refund', []), value: 0n }])
        txHash = submitted?.txHash ?? submitted?.userOpHash ?? submitted?.intentId
        if (!txHash) throw new Error('Refund submitted but no transaction hash was returned.')
      }
      setStatus('idle')
      return txHash
    } catch (e) {
      setStatus('error')
      setError(e?.shortMessage || e?.message || String(e))
      throw e
    }
  }, [signer, refundTx, requireContext, requireSendCalls])

  return {
    status,
    error,
    createPool,
    resolvePhrase,
    getPoolSummary,
    joinPool,
    getMembers,
    getMyNickname,
    fetchProposedMatrix,
    closeJoining,
    pokeDeadline,
    cancelPool,
    proposeOutcome,
    vote,
    claimWinnings,
    refund,
  }
}
