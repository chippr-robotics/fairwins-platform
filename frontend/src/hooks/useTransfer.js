import { useCallback, useEffect, useMemo, useState } from 'react'
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { formatUnits, parseUnits } from '../lib/evm/units'
import { isAddress, getAddress } from '../lib/evm/address'
import { useWallet } from './useWalletManagement'
import { useActiveAccount } from './useActiveAccount'
import { useChainTokens } from './useChainTokens'
import { getNetwork } from '../config/networks'
import { makeReadProvider } from '../utils/rpcProvider'
import { useEndpointsRevision } from './useRpcEndpoints'
import {
  TRANSFER_ABI,
  signTransferAuthorization,
  getTransferRelayer,
  relayGaslessTransfer,
} from '../lib/transfer/eip3009Transfer'
import { recordTransfer, updateTransfer, TRANSFER_STATUS } from '../lib/transfer/transferStore'
import { appendClientRecord } from '../data/ledger'
import { transferRecordToEntry } from '../data/ledger/sources/transferLedgerSource'

/**
 * Mirror a transfer record (or a status transition) into the append-only
 * client ledger (spec 051 FR-008/FR-010): the initial record keeps its
 * `cl:<id>` identity; each transition appends a superseding record instead
 * of mutating. Deterministic suffixes make re-mirroring a no-op. Best-effort:
 * the ledger must never break a transfer.
 */
function mirrorToLedger(account, record, patch = null, suffix = null) {
  try {
    const entry = transferRecordToEntry({ ...record, ...(patch || {}) }, { account })
    if (!suffix) {
      appendClientRecord(account, entry)
      return
    }
    appendClientRecord(account, {
      ...entry,
      entryId: `${entry.entryId}:${suffix}`,
      recordedAt: Date.now(),
      refs: { ...entry.refs, supersedes: entry.entryId },
    })
  } catch {
    /* capture is best-effort */
  }
}

/**
 * useTransfer — the send engine behind the Pay & Transfer wallet section.
 *
 * Two asset kinds, one honest routing table:
 *
 *   stablecoin, passkey session   → gasless via the smart-account batch (sendCalls → ERC-4337 UserOp/relay)
 *   stablecoin, classic + relayer → gasless via EIP-3009 transferWithAuthorization (token-native)
 *   stablecoin, classic, no relay → self-submit token.transfer (sender pays gas)  [never-stranded fallback]
 *   native, passkey session       → gasless via the smart-account batch
 *   native, classic               → standard network-fee transfer
 *
 * "All stablecoin transfers are gasless" holds wherever the rails exist (a live relayer, or a passkey smart
 * account); where they don't, the transfer still goes through by self-submit rather than being blocked — and
 * the UI says so truthfully via `quoteGasless`.
 */

export const TRANSFER_KIND = Object.freeze({ NATIVE: 'native', STABLE: 'stable' })

// Honest passkey-UserOp lifecycle states as returned by sendCalls (mirrors LIFECYCLE in
// lib/passkey/submission.js — kept as literals here to avoid pulling the relay graph into this hook).
const OP_STATE = Object.freeze({ SUBMITTED: 'submitted', INCLUDED: 'included', FAILED: 'failed' })

const TRANSFER_ABI_PARSED = normalizeAbi(TRANSFER_ABI)
/** ERC-20 `transfer` calldata. The recipient is checksummed first (spec 110 divergence 16: viem's
 *  encoder refuses an all-uppercase address our own `isAddress` — like ethers' — accepts). */
const transferCall = (to, value) =>
  encodeFunctionData({
    abi: TRANSFER_ABI_PARSED,
    functionName: 'transfer',
    args: [getAddress(String(to)), value],
  })

export function useTransfer() {
  const { address, chainId, signer, provider, loginMethod, sendCalls } = useWallet()
  const {
    isVault: operatingAsVault, canActAsVault,
    isLegacy: operatingAsLegacy,
    isHardware: operatingAsHardware,
    submit: submitAsActive,
  } = useActiveAccount()
  const tokens = useChainTokens()
  const isPasskey = loginMethod === 'passkey'

  const [status, setStatus] = useState('idle') // idle | signing | submitting | pending | success | error
  const [error, setError] = useState(null)
  const [lastResult, setLastResult] = useState(null)
  const [nativeBalance, setNativeBalance] = useState(null)
  const [stableBalance, setStableBalance] = useState(null)

  const stableDomainVersion = getNetwork(chainId)?.stablecoin?.domainVersion ?? null
  const endpointRevision = useEndpointsRevision()
  // Rebuilt when the member repoints this network (spec 069).
  const readProvider = useMemo(() => {
    const net = getNetwork(chainId)
    const rpcProvider = net?.rpcUrl ? makeReadProvider(net.rpcUrl, chainId) : null
    return isPasskey ? (rpcProvider || provider) : (provider || rpcProvider)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, isPasskey, provider, endpointRevision])
  // A transfer is gasless when a passkey smart account's UserOp is FairWins-sponsored (spec 050: a
  // sponsor paymaster is configured for this chain), or — for classic wallets — when the token
  // supports EIP-3009 AND a relayer is configured. Without a sponsor paymaster a passkey UserOp
  // self-funds native gas (NOT gasless), so the badge must not claim "sponsored" (honest-state,
  // Constitution III; this is the fix for the previously-unconditional passkey badge).
  const hasRelayer = Boolean(getTransferRelayer())
  const passkeySponsored = isPasskey && Boolean(getNetwork(chainId)?.passkey?.sponsorPaymasterUrl)
  const stableGasless = passkeySponsored || (!isPasskey && stableDomainVersion != null && hasRelayer)

  /** Whether a given kind will be gasless for the current session (drives the UI badge, honestly). */
  const quoteGasless = useCallback(
    (kind) => (kind === TRANSFER_KIND.STABLE ? stableGasless : passkeySponsored),
    [stableGasless, passkeySponsored]
  )

  // Whether a given portfolio asset is the connected network's configured stablecoin (the only token
  // that has an EIP-3009 gasless rail). Compared by address on the connected chain.
  const isNetworkStableAsset = useCallback(
    (asset) => {
      if (!asset || asset.kind === 'native' || !asset.address || !tokens.stableAddress) return false
      return asset.address.toLowerCase() === tokens.stableAddress.toLowerCase()
    },
    [tokens.stableAddress]
  )

  /**
   * Per-asset gasless quote for the flexible asset picker (drives the UI badge honestly, FR "gasless only
   * on networks configured for it"). This reflects the asset's OWN network capability — independent of the
   * currently-connected chain — so the badge is truthful for every row in a cross-network portfolio: a
   * passkey session is gasless where that network runs a sponsor paymaster (any asset); a classic wallet is
   * gasless only for that network's stablecoin (EIP-3009) when a relayer is configured. (Actual routing at
   * send time still requires being connected to the asset's chain; the form gates that with a switch.)
   */
  const quoteGaslessForAsset = useCallback(
    (asset) => {
      if (!asset) return false
      const net = getNetwork(asset.chainId ?? chainId)
      if (!net) return false
      if (isPasskey) return Boolean(net.passkey?.sponsorPaymasterUrl)
      const isStable =
        asset.kind !== 'native' &&
        asset.address &&
        net.stablecoin?.address &&
        asset.address.toLowerCase() === net.stablecoin.address.toLowerCase()
      return Boolean(isStable && net.stablecoin?.domainVersion != null && hasRelayer)
    },
    [chainId, isPasskey, hasRelayer]
  )

  const meta = useCallback(
    (kind) =>
      kind === TRANSFER_KIND.STABLE
        ? { symbol: tokens.stable, name: tokens.stableName, decimals: tokens.stableDecimals, address: tokens.stableAddress }
        : { symbol: tokens.native, name: tokens.nativeName, decimals: tokens.nativeDecimals, address: null },
    [tokens]
  )

  // Balances for the two supported assets. Reads use the wallet provider when available, but passkey
  // sessions (and provider-less cases) fall back to direct chain RPC reads.
  const refreshBalances = useCallback(async () => {
    if (!readProvider || !address) {
      setNativeBalance(null)
      setStableBalance(null)
      return
    }
    try {
      const nat = await readProvider.getBalance(address)
      setNativeBalance(formatUnits(nat, tokens.nativeDecimals))
    } catch {
      setNativeBalance(null)
    }
    if (tokens.stableAddress) {
      try {
        // Named chain, not the wallet's provider (spec 110 read-routing decision): the member's
        // own endpoint (spec 069) applies to this read, and an unreachable chain fails honestly
        // instead of quietly answering with the home network's state.
        const bal = await readContract(chainId, {
          address: tokens.stableAddress,
          abi: TRANSFER_ABI,
          functionName: 'balanceOf',
          args: [getAddress(String(address))],
        })
        setStableBalance(formatUnits(bal, tokens.stableDecimals))
      } catch {
        setStableBalance(null)
      }
    } else {
      setStableBalance(null)
    }
  }, [readProvider, chainId, address, tokens.stableAddress, tokens.stableDecimals, tokens.nativeDecimals])

  useEffect(() => {
    refreshBalances()
  }, [refreshBalances])

  const balanceOf = useCallback(
    (kind) => (kind === TRANSFER_KIND.STABLE ? stableBalance : nativeBalance),
    [stableBalance, nativeBalance]
  )

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setLastResult(null)
  }, [])

  /**
   * Send a transfer. `to` must be a resolved 0x address; `amount` is a human-readable decimal string.
   * Returns { txHash?, route } on success and records the attempt to the Activity log with truthful status.
   */
  const send = useCallback(
    async ({ kind, asset, to, amount }) => {
      if (!signer && !isPasskey) throw new Error('Wallet not connected.')
      if (!isAddress(to)) throw new Error('Enter a valid recipient address.')

      // Normalize either a legacy `kind` (native/stable) or an explicit portfolio `asset` descriptor into a
      // single token shape the routing table below understands. Arbitrary ERC-20s from the portfolio picker
      // are self-submit transfers on the connected chain; only the network stablecoin keeps the EIP-3009
      // gasless rail. `recordKind` stays 'stable' ONLY for that token so the ledger values it at par — any
      // other ERC-20 records as 'token' and is honestly left unvalued (transferLedgerSource).
      const a = (() => {
        if (asset) {
          const isNative = asset.kind === 'native' || !asset.address
          const isNetworkStable = isNetworkStableAsset(asset)
          return {
            isNative,
            address: isNative ? null : asset.address,
            symbol: asset.symbol,
            name: asset.name || (isNetworkStable ? tokens.stableName : asset.symbol) || 'Token',
            decimals: asset.decimals ?? (isNative ? tokens.nativeDecimals : 18),
            isNetworkStable,
            recordKind: isNative ? TRANSFER_KIND.NATIVE : isNetworkStable ? TRANSFER_KIND.STABLE : 'token',
          }
        }
        const m = meta(kind)
        const isNative = kind !== TRANSFER_KIND.STABLE
        return {
          isNative,
          address: isNative ? null : m.address,
          symbol: m.symbol,
          name: m.name,
          decimals: m.decimals,
          isNetworkStable: !isNative,
          recordKind: isNative ? TRANSFER_KIND.NATIVE : TRANSFER_KIND.STABLE,
        }
      })()

      // A selected asset must live on the connected chain — the transfer is signed there. The UI gates this
      // with a network switch, but guard here too so a stale selection can never sign against the wrong chain.
      if (asset?.chainId != null && Number(asset.chainId) !== Number(chainId)) {
        throw new Error(`Switch to this asset's network before sending.`)
      }

      let value
      try {
        // The seam refuses a value this token cannot represent exactly (spec 110 divergence 20 —
        // viem rounds half-up where ethers threw). What is SENT must be what was typed.
        value = parseUnits(String(amount), a.decimals)
      } catch {
        throw new Error('Enter a valid amount.')
      }
      if (value <= 0n) throw new Error('Enter an amount greater than zero.')
      if (!a.isNative && !a.address) {
        throw new Error(`No ${a.symbol || 'token'} is configured on this network.`)
      }

      // Spec 043 (US3, FR-022): when operating as a vault, a transfer becomes a threshold-gated vault
      // proposal instead of an immediate send. It surfaces only in the vault queue (FR-022b) until executed.
      if (operatingAsVault) {
        if (!canActAsVault) throw new Error("Switch to the vault's network to send from it.")
        const payload = a.isNative
          ? { to, value, data: '0x' }
          : { to: a.address, value: 0n, data: transferCall(to, value) }
        setError(null)
        setStatus('submitting')
        try {
          const res = await submitAsActive(payload)
          setStatus('success')
          const result = { proposed: true, safeTxHash: res.safeTxHash, route: 'vault', id: null }
          setLastResult(result)
          return result
        } catch (err) {
          const message = err?.shortMessage || err?.message || 'Could not create the vault proposal.'
          setError(message)
          setStatus('error')
          throw err
        }
      }

      // Spec 062/085/088: when acting as a recovered or hardware account, the transfer must be
      // signed by THAT account's signer — NOT the connected wallet. Route it through the
      // active-account seam, which obtains the signer on demand (the deferred unlock / device
      // ceremony renders via the global SignerRequestHost). Never falls through to the
      // connected signer below.
      if (operatingAsLegacy || operatingAsHardware) {
        const payload = a.isNative
          ? { to, value, data: '0x' }
          : { to: a.address, value: 0n, data: transferCall(to, value) }
        setError(null)
        setStatus('submitting')
        try {
          const res = await submitAsActive(payload)
          setStatus('success')
          const result = { sent: true, txHash: res.txHash, route: operatingAsLegacy ? 'legacy' : 'hardware', id: null }
          setLastResult(result)
          return result
        } catch (err) {
          const message = err?.shortMessage || err?.message || (operatingAsLegacy ? 'Could not send from the recovered account.' : 'Could not send from the hardware account.')
          setError(message)
          setStatus('error')
          throw err
        }
      }

      const gasless = passkeySponsored || (a.isNetworkStable && stableDomainVersion != null && hasRelayer)
      const entry = recordTransfer(address, {
        chainId,
        kind: a.recordKind,
        symbol: a.symbol,
        decimals: a.decimals,
        amount: String(amount),
        from: address,
        to,
        route: gasless ? 'gasless' : a.isNative ? 'direct' : 'self',
      })
      mirrorToLedger(address, entry)

      setError(null)
      setStatus('signing')
      try {
        let txHash = null
        let route = entry.route

        if (isPasskey) {
          // One ceremony via the smart-account batch. Native = value move; token = ERC-20 transfer call.
          const calls = a.isNative
            ? [{ target: to, data: '0x', value }]
            : [{ target: a.address, data: transferCall(to, value), value: 0n }]
          setStatus('submitting')
          // Reflect the honest lifecycle while the batch is tracked to inclusion (spec 041 FR-017):
          // a passkey UserOp is "submitted" for up to ~90s before it is "included", so flip the button
          // to a truthful pending state instead of a frozen "Sending…".
          const res = await sendCalls(calls, {
            onState: (s) => {
              if (s?.state === OP_STATE.SUBMITTED) setStatus('pending')
            },
          })
          // Honest route: reflect whether the batch was ACTUALLY sponsored. sendCalls falls back to a
          // self-funded UserOp when sponsorship is unavailable (spec 050), so trust its `sponsored`
          // flag rather than assuming gasless.
          route = res?.sponsored === false ? 'self' : res?.sponsored === true || passkeySponsored ? 'gasless' : 'self'

          // A passkey batch resolves to an honest terminal state — included | failed | stalled — and
          // sendCalls NEVER throws on a stalled/never-included UserOp (submission.js#trackToInclusion).
          // We MUST branch on that state: only an on-chain inclusion is a real transfer, and a
          // userOpHash is NOT a transaction hash (block explorers cannot resolve it), so it must never
          // be recorded or displayed as one (Constitution III, honest-state). This is the fix for a
          // stalled sponsored UserOp being force-marked "complete" with its userOpHash as the txHash.
          if (res?.state === OP_STATE.FAILED) {
            throw new Error(res.reason || 'The transfer reverted on-chain and was not sent.')
          }
          if (res?.state && res.state !== OP_STATE.INCLUDED) {
            // Submitted but not yet confirmed (stalled): keep it truthfully "in process" with the
            // UserOp reference for later reconciliation — do NOT mark complete or fabricate a txHash.
            const ref = res.userOpHash ?? res.intentId ?? null
            updateTransfer(address, entry.id, { status: TRANSFER_STATUS.IN_PROCESS, route, userOpHash: ref })
            mirrorToLedger(address, entry, { status: TRANSFER_STATUS.IN_PROCESS, route }, 'submitted')
            setStatus('pending')
            const pending = { txHash: null, userOpHash: ref, route, id: entry.id, pending: true }
            setLastResult(pending)
            refreshBalances()
            return pending
          }
          // Included: use the REAL on-chain transaction hash only.
          txHash = res?.txHash ?? null
        } else if (!a.isNative && a.isNetworkStable && stableDomainVersion != null && hasRelayer) {
          // Classic EOA, gasless: sign an EIP-3009 authorization; a relayer submits + pays gas.
          const auth = await signTransferAuthorization({
            signer,
            token: a.address,
            tokenName: a.name || 'USD Coin',
            tokenVersion: stableDomainVersion,
            chainId,
            to,
            value,
          })
          setStatus('submitting')
          try {
            const relayed = await relayGaslessTransfer(getTransferRelayer(), auth, { token: a.address, chainId })
            txHash = relayed.txHash
            route = 'gasless'
          } catch (relayErr) {
            // Never stranded: fall back to a self-submitted transfer (sender pays gas).
            console.warn('[useTransfer] relayer failed, self-submitting:', relayErr?.message)
            const tx = await signer.sendTransaction({ to: a.address, data: transferCall(to, value) })
            const receipt = await tx.wait()
            txHash = receipt?.hash ?? tx.hash
            route = 'self'
          }
        } else if (!a.isNative) {
          // Classic EOA ERC-20 (network stablecoin without a rail, or any other portfolio token):
          // a plain token transfer where the sender pays gas.
          setStatus('submitting')
          const tx = await signer.sendTransaction({ to: a.address, data: transferCall(to, value) })
          const receipt = await tx.wait()
          txHash = receipt?.hash ?? tx.hash
          route = 'self'
        } else {
          // Native, classic EOA: standard network-fee transfer.
          setStatus('submitting')
          const tx = await signer.sendTransaction({ to, value })
          const receipt = await tx.wait()
          txHash = receipt?.hash ?? tx.hash
          route = 'direct'
        }

        updateTransfer(address, entry.id, { status: TRANSFER_STATUS.COMPLETE, txHash, route })
        mirrorToLedger(address, entry, { status: TRANSFER_STATUS.COMPLETE, txHash, route }, 'done')
        setStatus('success')
        const result = { txHash, route, id: entry.id }
        setLastResult(result)
        refreshBalances()
        return result
      } catch (err) {
        const message = err?.shortMessage || err?.message || 'Transfer failed.'
        updateTransfer(address, entry.id, { status: TRANSFER_STATUS.FAILED, error: message })
        mirrorToLedger(address, entry, { status: TRANSFER_STATUS.FAILED, error: message }, 'fail')
        setError(message)
        setStatus('error')
        throw err
      }
    },
    [signer, isPasskey, meta, isNetworkStableAsset, tokens.stableName, tokens.nativeDecimals, passkeySponsored, address, chainId, sendCalls, stableDomainVersion, hasRelayer, refreshBalances, operatingAsVault, canActAsVault, operatingAsLegacy, operatingAsHardware, submitAsActive]
  )

  return useMemo(
    () => ({
      status,
      error,
      lastResult,
      send,
      reset,
      quoteGasless,
      quoteGaslessForAsset,
      meta,
      balanceOf,
      refreshBalances,
      nativeBalance,
      stableBalance,
      tokens,
      isPasskey,
    }),
    [status, error, lastResult, send, reset, quoteGasless, quoteGaslessForAsset, meta, balanceOf, refreshBalances, nativeBalance, stableBalance, tokens, isPasskey]
  )
}

export default useTransfer
