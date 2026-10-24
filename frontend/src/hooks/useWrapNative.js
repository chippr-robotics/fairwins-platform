import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { parseUnits } from '../lib/evm/units'
import { getAddress } from '../lib/evm/address'
import { useWallet } from './useWalletManagement'
import { useActiveAccount } from './useActiveAccount'
import { getNetwork, NETWORKS } from '../config/networks'
import { getWrappedNative } from '../config/wrappedNative'
import { isPasskeySupported, getPasskeySupport } from '../config/passkeySupport'
import { WNATIVE_ABI } from '../abis/WNative'
import { getReadProvider } from '../utils/rpcProvider'
import { useEndpointsRevision } from './useRpcEndpoints'
import { settleWalletOn } from '../lib/chains/submitOn'

/**
 * useWrapNative — wrap the connected network's coin into its canonical wrapped form,
 * and unwrap it back.
 *
 * Wrapping is NOT a swap and NOT a bridge: `deposit()` mints exactly what you send and
 * `withdraw(wad)` burns exactly what you ask for, against the network's own WETH9-shaped
 * contract (config/wrappedNative.js). There is no price, no slippage, no counterparty and
 * no quote to expire — so this hook deliberately exposes none of those, and the view must
 * not invent them. The only cost is the network fee.
 *
 * Routing mirrors useTransfer, because "who is acting" is the same question here:
 *
 *   vault    → a threshold-gated proposal (nothing moves until the signers approve)
 *   legacy   → signed by the unlocked recovered key, never the connected wallet
 *   hardware → signed on the device via the deferred ceremony (spec 088), never the connected wallet
 *   passkey  → one smart-account call (sponsored where the chain runs a paymaster)
 *   classic  → a plain transaction, sender pays the network fee
 *
 * Gas honesty: unwrapping costs native coin the member is about to receive, and wrapping
 * costs native coin out of the same balance being wrapped — so `maxWrappable` holds back a
 * reserve rather than offering the whole balance and letting the wallet reject it. The
 * reserve is quoted from the chain's own fee data, not a constant.
 *
 * Spec 108 — the hook takes an explicit TARGET chain (`useWrapNative({ chainId })`), so the
 * asset is the entry point rather than the connected network. Every read re-binds to the
 * target (wrapper, provider, fee reserve, sponsorship, on-chain label); the write retargets
 * per rail:
 *
 *   classic, same chain   → plain transaction, as ever
 *   classic, other chain  → switch-then-settle FIRST (the spec-102 `settleOnVaultChain` /
 *                           `useEarnSend.sendOnChain` device: awaited switch, then a 150 ms
 *                           poll on a render-updated snapshot until the chain matches and the
 *                           chain-scoped signer exists, 20 s deadline). A refusal names BOTH
 *                           chains and sends nothing.
 *   passkey               → the batch is chain-targeted BY PARAMETER
 *                           (`sendCalls(calls, { chainId })`) — no switch ceremony exists or
 *                           is needed — offered only where `isPasskeySupported(target)`;
 *                           elsewhere the rail is stated as unavailable BEFORE the tap, with
 *                           the support seam's own reason (the write-rail rule).
 *   vault/legacy/hardware → unchanged acting-account refusals; the view pins the picker to
 *                           the acting account's own chain, so a foreign target never
 *                           reaches these rails.
 *
 * Callers that pass no target get the wallet's chain — byte-compatible with every
 * pre-108 caller.
 */

const chainName = (chainId) => NETWORKS[chainId]?.name || `chain ${chainId}`

export const WRAP_DIRECTION = Object.freeze({ WRAP: 'wrap', UNWRAP: 'unwrap' })

// Honest passkey-UserOp lifecycle states (mirrors LIFECYCLE in lib/passkey/submission.js —
// kept as literals so this hook doesn't pull the relay graph in, same as useTransfer).
const OP_STATE = Object.freeze({ SUBMITTED: 'submitted', INCLUDED: 'included', FAILED: 'failed' })

const WNATIVE_ABI_PARSED = normalizeAbi(WNATIVE_ABI)
const SYMBOL_ABI = ['function symbol() view returns (string)']
const wnativeCall = (functionName, args = []) =>
  encodeFunctionData({ abi: WNATIVE_ABI_PARSED, functionName, args })

// WETH9's deposit/withdraw are small, fixed-shape calls; 100k covers both with room for
// the L2 variants that charge more for the same work. Used only to SIZE the gas reserve
// held back from MAX — never as a gas limit on the transaction itself, which the wallet
// estimates for real.
const WRAP_GAS_LIMIT = 100_000n
// The reserve is doubled against the quoted fee so a MAX wrap survives a fee tick between
// the quote and the signature — the alternative is a transaction that reverts for gas
// after the member has already signed it.
const RESERVE_MULTIPLIER = 2n

export function useWrapNative({ chainId: targetChainId } = {}) {
  const { address, chainId, signer, provider, loginMethod, sendCalls, switchNetwork } = useWallet()
  const {
    identity, isVault, isLegacy, isHardware, canActAsVault, canActAsLegacy, canActAsHardware,
    submit: submitAsActive,
  } = useActiveAccount()
  const isPasskey = loginMethod === 'passkey'

  // The TARGET chain — where the wrap runs. Defaults to the wallet's chain, which keeps
  // every caller that passes nothing byte-compatible with the pre-108 hook.
  const target = Number(targetChainId ?? chainId)
  const onTargetChain = Number(chainId) === target

  const [status, setStatus] = useState('idle') // idle | signing | submitting | pending | success | error
  const [error, setError] = useState(null)
  const [nativeBalance, setNativeBalance] = useState(null) // bigint | null (null = not read yet)
  const [wrappedBalance, setWrappedBalance] = useState(null)
  const [onChainSymbol, setOnChainSymbol] = useState(null)
  const [gasReserve, setGasReserve] = useState(null)

  const net = getNetwork(target)
  const token = useMemo(() => getWrappedNative(target), [target])
  const endpointRevision = useEndpointsRevision()

  // The settle loop below polls a snapshot the RENDER updates, because the switch lands as
  // new context values, not as a resolved promise (spec 102's device, verbatim).
  const latestRef = useRef({})
  useEffect(() => {
    latestRef.current = { chainId, signer }
  }, [chainId, signer])

  // Reads bind to the TARGET. On the wallet's own chain a classic session may read through
  // the wallet provider as before; anywhere else — and always for passkey — the spec-069
  // resolved endpoint for the target chain is the only honest source.
  const readProvider = useMemo(() => {
    const rpcProvider = getReadProvider(target)
    if (!onTargetChain || isPasskey) return rpcProvider || provider
    return provider || rpcProvider
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, onTargetChain, isPasskey, provider, endpointRevision])

  // Balances belong to whoever is ACTING — a vault holds its own coin, and so does a
  // recovered legacy or hardware account (spec 088 FR-001). Reading the connected wallet's
  // balance while operating as any of them would offer a MAX the acting account cannot cover.
  const actingAddress =
    (isVault && identity?.vaultAddress) ||
    ((isLegacy || isHardware) && identity?.address) ||
    address || null

  const nativeSymbol = net?.nativeCurrency?.symbol || ''
  const wrappedSymbol = onChainSymbol || token?.symbol || ''
  const decimals = token?.decimals ?? net?.nativeCurrency?.decimals ?? 18

  // Sponsored only where the chain actually runs a FairWins paymaster for passkey UserOps
  // (spec 050). Everything else pays the network fee, and the view must say so.
  const sponsored = isPasskey && Boolean(net?.passkey?.sponsorPaymasterUrl)

  const refresh = useCallback(async () => {
    if (!readProvider || !actingAddress || !token) {
      setNativeBalance(null)
      setWrappedBalance(null)
      return
    }
    try {
      setNativeBalance(await readProvider.getBalance(actingAddress))
    } catch {
      setNativeBalance(null) // unread, NOT zero — the view renders "—" for this
    }
    try {
      setWrappedBalance(
        await readContract(target, {
          address: token.address,
          abi: WNATIVE_ABI,
          functionName: 'balanceOf',
          args: [getAddress(String(actingAddress))],
        }),
      )
    } catch {
      setWrappedBalance(null)
    }
  }, [readProvider, actingAddress, token, target])

  useEffect(() => { refresh() }, [refresh])

  // What the wrapper calls itself. The config label is a derivation from the coin's name and
  // can lag a rename (Polygon's contract now answers WPOL while the app's config still says
  // POL), so prefer the contract's own answer where the chain gives one.
  useEffect(() => {
    let cancelled = false
    setOnChainSymbol(null)
    if (!readProvider || !token) return undefined
    readContract(target, { address: token.address, abi: SYMBOL_ABI, functionName: 'symbol' })
      .then((s) => { if (!cancelled && typeof s === 'string' && s) setOnChainSymbol(s) })
      .catch(() => { /* label falls back to the derived one — never blocks wrapping */ })
    return () => { cancelled = true }
  }, [readProvider, token, target])

  // Gas reserve, quoted from the chain rather than assumed. An unreadable fee leaves the
  // reserve null and MAX falls back to a balance-minus-nothing offer only when there is
  // genuinely nothing to reserve against (see maxWrappable).
  useEffect(() => {
    let cancelled = false
    if (!readProvider) { setGasReserve(null); return undefined }
    readProvider.getFeeData()
      .then((fee) => {
        if (cancelled) return
        const price = fee?.maxFeePerGas ?? fee?.gasPrice ?? null
        setGasReserve(price == null ? null : WRAP_GAS_LIMIT * BigInt(price) * RESERVE_MULTIPLIER)
      })
      .catch(() => { if (!cancelled) setGasReserve(null) })
    return () => { cancelled = true }
  }, [readProvider, target])

  /**
   * The write rail for THIS target, stated before the tap (the writeRail rule: an
   * unavailable rail renders its reason in place of a control that would throw).
   * `acting-account` keeps the existing vault/legacy/hardware refusal wording — the view
   * pins the picker to the acting account's chain, so those rails never see a foreign
   * target.
   */
  const writeRail = useMemo(() => {
    if (isVault || isLegacy || isHardware) return { kind: 'acting-account' }
    if (isPasskey) {
      if (isPasskeySupported(target)) return { kind: 'passkey' }
      return {
        kind: 'unavailable',
        reason: getPasskeySupport(target)?.reason
          || `Passkey transactions are not available on ${chainName(target)}.`,
      }
    }
    return onTargetChain ? { kind: 'signer-same-chain' } : { kind: 'signer-switch' }
  }, [isVault, isLegacy, isHardware, isPasskey, target, onTargetChain])

  /**
   * Land the wallet on the target chain, then hand back the SETTLED signer. Same-chain: the
   * current signer, untouched. A refusal (or a switch that never settles) throws with BOTH chains
   * named and nothing sent.
   *
   * Spec 110 T026/T028 — this WAS a fourth private copy of the switch-then-settle loop, and it was
   * the best of the four: it alone verified that the settled signer's OWN provider reports the
   * target chain, because pairing the new chainId with the pre-switch signer is a race this hook
   * had actually met (ethers reports `network changed: A => B` only AFTER broadcasting). That
   * check has been moved INTO the shared `settleWalletOn`, so the three hooks that had not met the
   * race now carry the fix too, and this one stops maintaining its own.
   */
  const settleOnTargetChain = useCallback(async () => {
    if (onTargetChain && signer) return signer
    const settled = await settleWalletOn(target, {
      readWallet: () => latestRef.current,
      switchNetwork,
      chainName,
      needsSigner: true,
      subject: 'This wrap',
    })
    return settled.signer
  }, [onTargetChain, signer, target, switchNetwork])

  /**
   * The most that can be wrapped: the balance less a gas reserve, because the fee is paid in
   * the same coin being wrapped. A sponsored passkey op pays no fee, so nothing is held back.
   * Returns null while the balance is unknown — an unread balance is not a zero one.
   */
  const maxWrappable = useMemo(() => {
    if (nativeBalance == null) return null
    if (sponsored) return nativeBalance
    const reserve = gasReserve ?? 0n
    return nativeBalance > reserve ? nativeBalance - reserve : 0n
  }, [nativeBalance, gasReserve, sponsored])

  const reset = useCallback(() => { setStatus('idle'); setError(null) }, [])

  /**
   * Wrap or unwrap `amount` (a human-readable decimal string).
   *
   * @returns {Promise<{ txHash: string|null, proposed?: boolean, safeTxHash?: string,
   *   pending?: boolean, userOpHash?: string|null, sponsored: boolean }>}
   */
  const execute = useCallback(
    async (direction, amount) => {
      if (!token) throw new Error('This network has no wrapped coin configured.')
      if (!signer && !isPasskey && !isVault && !isLegacy && !isHardware) throw new Error('Wallet not connected.')

      let value
      try {
        // The seam refuses a value the unit cannot represent EXACTLY (spec 110 divergence 20:
        // viem rounds half-up where ethers threw). On this path that refusal is the whole point —
        // what gets wrapped must be what the member typed, never a rounded neighbour of it.
        value = parseUnits(String(amount), decimals)
      } catch {
        throw new Error('Enter a valid amount.')
      }
      if (value <= 0n) throw new Error('Enter an amount greater than zero.')

      const wrapping = direction === WRAP_DIRECTION.WRAP
      const held = wrapping ? nativeBalance : wrappedBalance
      if (held != null && value > held) {
        throw new Error(`Not enough ${wrapping ? nativeSymbol : wrappedSymbol}.`)
      }

      // One call, two shapes: deposit carries the coin as msg.value, withdraw names the amount.
      const call = wrapping
        ? { to: token.address, value, data: wnativeCall('deposit') }
        : { to: token.address, value: 0n, data: wnativeCall('withdraw', [value]) }

      setError(null)

      try {
        // Vault: a proposal, not a transaction. Nothing moves until the signers approve it.
        if (isVault) {
          if (!canActAsVault) throw new Error("Switch to the vault's network to wrap from it.")
          setStatus('submitting')
          const res = await submitAsActive(call)
          setStatus('success')
          await refresh()
          return { txHash: null, proposed: true, safeTxHash: res.safeTxHash, sponsored: false }
        }

        // Recovered legacy / hardware account: signed by THAT account's signer via the
        // active-account seam (spec 088 FR-002) — the deferred unlock / device ceremony runs
        // on demand. Never falls through to the connected signer below.
        if (isLegacy || isHardware) {
          if (isLegacy && !canActAsLegacy) throw new Error('Unlock the recovered account on its network to wrap from it.')
          if (isHardware && !canActAsHardware) throw new Error('Connect the hardware account on its network to wrap from it.')
          setStatus('submitting')
          const res = await submitAsActive(call)
          setStatus('success')
          await refresh()
          return { txHash: res.txHash ?? null, sponsored: false }
        }

        setStatus('signing')

        if (isPasskey) {
          // Stated before the tap by `writeRail`; restated here so a caller that skipped the
          // UI still fails with the same sentence (the requireWriteRail convention).
          if (writeRail.kind === 'unavailable') throw new Error(writeRail.reason)
          setStatus('submitting')
          // A UserOp is chain-targeted by parameter — the batch pins the TARGET chain
          // instead of the session's current one (WalletContext sendCalls override).
          const res = await sendCalls(
            [{ target: call.to, data: call.data, value: call.value }],
            {
              chainId: target,
              onState: (s) => { if (s?.state === OP_STATE.SUBMITTED) setStatus('pending') },
            },
          )
          // Trust what the batch reports, not what the config promised: sendCalls falls back to
          // a self-funded UserOp when sponsorship is unavailable (spec 050).
          const wasSponsored = res?.sponsored === true || (res?.sponsored !== false && sponsored)
          if (res?.state === OP_STATE.FAILED) {
            throw new Error(res.reason || 'The transaction reverted on-chain.')
          }
          if (res?.state && res.state !== OP_STATE.INCLUDED) {
            // Submitted but not included. A userOpHash is NOT a transaction hash and no explorer
            // resolves one, so it is never returned as `txHash` (Constitution III).
            setStatus('pending')
            await refresh()
            return {
              txHash: null,
              pending: true,
              userOpHash: res.userOpHash ?? res.intentId ?? null,
              sponsored: wasSponsored,
            }
          }
          setStatus('success')
          await refresh()
          return { txHash: res?.txHash ?? null, sponsored: wasSponsored }
        }

        // Classic wallet: a plain transaction, confirmed before it is reported as done.
        // Cross-chain, the wallet is switched-then-settled FIRST — the settled signer is the
        // one that sends, never a stale one bound to the previous chain.
        const settledSigner = await settleOnTargetChain()
        setStatus('submitting')
        const tx = await settledSigner.sendTransaction({ to: call.to, value: call.value, data: call.data })
        const receipt = await tx.wait()
        setStatus('success')
        await refresh()
        return { txHash: receipt?.hash ?? tx.hash, sponsored: false }
      } catch (err) {
        const message = err?.shortMessage || err?.message || 'The transaction failed.'
        setError(message)
        setStatus('error')
        throw err
      }
    },
    [
      token, signer, isPasskey, isVault, isLegacy, isHardware, canActAsVault, canActAsLegacy,
      canActAsHardware, submitAsActive, settleOnTargetChain, writeRail, target,
      sendCalls, decimals, nativeBalance, wrappedBalance, nativeSymbol, wrappedSymbol, sponsored, refresh,
    ],
  )

  const wrap = useCallback((amount) => execute(WRAP_DIRECTION.WRAP, amount), [execute])
  const unwrap = useCallback((amount) => execute(WRAP_DIRECTION.UNWRAP, amount), [execute])

  // A plain object, like the other settle-loop hooks (useEarnSend, useActiveAccount): the
  // spec-108 switch device reads `latestRef.current` inside the action callbacks, and wrapping
  // the return in useMemo puts that (handler-only) read into a render-scoped call graph the
  // react-hooks/refs rule rejects. No consumer depends on the object's identity — the view
  // destructures — so nothing is lost.
  return {
    token,
    available: Boolean(token),
    networkName: net?.name || '',
    // The TARGET chain — where the wrap runs and where the receipt's explorer lives.
    // Identical to the wallet's chain for callers that passed no target.
    chainId: Number.isFinite(target) ? target : null,
    // Stated-before-the-tap facts for the view (spec 108).
    needsSwitch: !isPasskey && !isVault && !isLegacy && !isHardware && !onTargetChain,
    writeRail,
    nativeSymbol,
    wrappedSymbol,
    decimals,
    nativeBalance,
    wrappedBalance,
    maxWrappable,
    gasReserve,
    sponsored,
    isVault,
    status,
    error,
    busy: status === 'signing' || status === 'submitting' || status === 'pending',
    wrap,
    unwrap,
    refresh,
    reset,
  }
}

export default useWrapNative
