import { useState, useEffect, useCallback } from 'react'
import { encodeFunctionData, zeroAddress } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { formatUnits } from '../../lib/evm/units'
import { getAddress } from '../../lib/evm/address'
import { useWallet, useWeb3 } from '../../hooks'
import { useActiveAccount } from '../../hooks/useActiveAccount'
import { useGaslessWrite } from '../../lib/relay/useGaslessWrite'
import { revertReasonFrom, sanctionedAddressFrom, screenedPartyMessage } from '../../lib/wagers/sanctionsRevert'
import { useEncryption } from '../../hooks/useEncryption'
import { fetchEncryptedEnvelope } from '../../utils/ipfsService'
import {
  deriveXWingKeyPairFromSignature,
  decryptEnvelopeXWing,
  decryptEnvelope as decryptEnvelopeX25519,
  deriveKeyPairFromSignature,
  isXWingEnvelope,
} from '../../utils/crypto/envelopeEncryption'
import { DEX_ADDRESSES } from '../../constants/dex'
import { WAGER_DEFAULTS } from '../../constants/wagerDefaults'
import { getTransactionUrl } from '../../config/blockExplorer'
import { getFeeOverrides } from '../../utils/feeOverrides'
import './MarketAcceptanceModal.css'

// Helper to format stake amount as USD (rounded to nearest cent)
const formatUSD = (amount, symbol) => {
  const num = parseFloat(amount) || 0
  // Only show USD formatting for stablecoins
  const isStablecoin = symbol === 'USC' || symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI'

  if (isStablecoin) {
    if (num === 0) return '$0.00'
    if (num < 0.01) return '< $0.01'
    return `$${num.toFixed(2)}`
  }
  // For non-stablecoins, show raw amount with symbol
  return `${num} ${symbol || 'tokens'}`
}

// Helper to get human-readable resolution type label
const getResolutionLabel = (resolutionType) => {
  switch (resolutionType) {
    case 0: return 'Either Party'
    case 1: return 'Creator Only'
    case 2: return 'Opponent Only'
    case 3: return 'Third Party Arbitrator'
    case 4: return 'Linked Wager (Auto)'
    default: return 'Either Party'
  }
}

// Helper to get human-readable wager type label
const getWagerTypeLabel = (marketType) => {
  switch (marketType) {
    case 'oneVsOne': return '1v1'
    case 'smallGroup': return 'Group'
    case 'eventTracking': return 'Event'
    case 'offer': return 'Offer'
    case 'propBet': return 'Prop Bet'
    default: return marketType || 'Friend Wager'
  }
}

/**
 * MarketAcceptanceModal Component
 *
 * Displays offer terms for counterparty/arbitrator to review and accept.
 * Accessible via QR code scan or deep link.
 *
 * Features:
 * - Offer terms display with full details
 * - Time remaining countdown
 * - Acceptance progress
 * - Accept/Decline actions
 * - Transaction processing states
 */
const STAKE_TOKEN_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]
const STAKE_TOKEN_ABI_PARSED = normalizeAbi(STAKE_TOKEN_ABI)
const stakeTokenCall = (functionName, args) =>
  encodeFunctionData({ abi: STAKE_TOKEN_ABI_PARSED, functionName, args })

function MarketAcceptanceModal({
  isOpen,
  onClose,
  marketId,
  marketData,
  onAccepted,
  contractAddress,
  contractABI
}) {
  const { isConnected, account } = useWallet()
  const { signer, isCorrectNetwork, switchNetwork, chainId, sendCalls, loginMethod } = useWeb3()
  const isPasskey = loginMethod === 'passkey'
  // Spec 043 (US3): accepting a wager while operating as a vault becomes a threshold-gated vault proposal.
  // Spec 088 FR-001/FR-002: a recovered (legacy) or hardware acting account accepts AS ITSELF — its
  // balance is what is checked and ITS signer signs. Before this those kinds fell past the vault
  // branch into the passkey/gasless legs and silently staked the CONNECTED wallet's money.
  const {
    identity: activeIdentity,
    isVault: operatingAsVault,
    isLegacy: operatingAsLegacy,
    isHardware: operatingAsHardware,
    canActAsVault,
    submit: submitAsActive,
  } = useActiveAccount()
  const actingAsSigner = operatingAsLegacy || operatingAsHardware
  // The account that will actually be the taker — the switcher's answer, never the session's.
  const takerAddress = actingAsSigner ? activeIdentity?.address : account
  const {
    decryptMetadata,
    canUserDecrypt,
    isInitialized: encryptionInitialized,
    isInitializing: encryptionInitializing,
    initializeKeys
  } = useEncryption()

  const [step, setStep] = useState('review') // 'review', 'confirm', 'confirmDecline', 'processing', 'success', 'declined', 'error'
  const [error, setError] = useState(null)
  const [txHash, setTxHash] = useState(null)
  const [timeRemaining, setTimeRemaining] = useState(0)

  // Decryption state for encrypted wagers
  const [decryptedDescription, setDecryptedDescription] = useState(null)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [decryptionError, setDecryptionError] = useState(null)

  // If the opener already decrypted the wager (e.g. the My Wagers list, which
  // runs lazy decryption), use that plaintext directly so the acceptance screen
  // shows the real terms — and the user isn't asked to sign again just to read
  // what they're already looking at one screen back.
  useEffect(() => {
    if (marketData?.decryptedDescription) {
      setDecryptedDescription(marketData.decryptedDescription)
    }
  }, [marketData?.decryptedDescription])

  // Determine user's role
  const isArbitrator = marketData?.arbitrator?.toLowerCase() === account?.toLowerCase()
  const isParticipant = marketData?.participants?.some(
    p => p.toLowerCase() === account?.toLowerCase()
  )
  const isCreator = marketData?.creator?.toLowerCase() === account?.toLowerCase()
  // Creator's acceptance is automatically recorded at creation
  const hasAlreadyAccepted = isCreator || marketData?.acceptances?.[account?.toLowerCase()]?.hasAccepted

  // Calculate time remaining
  useEffect(() => {
    if (!marketData?.acceptanceDeadline) return

    const updateTimeRemaining = () => {
      const remaining = Math.max(0, marketData.acceptanceDeadline - Date.now())
      setTimeRemaining(remaining)
    }

    updateTimeRemaining()
    const interval = setInterval(updateTimeRemaining, 1000)

    return () => clearInterval(interval)
  }, [marketData?.acceptanceDeadline])

  // Resolve the encrypted envelope (from inline JSON or IPFS)
  const [resolvedEnvelope, setResolvedEnvelope] = useState(null)
  const [envelopeLoading, setEnvelopeLoading] = useState(false)

  useEffect(() => {
    // Guard against setState-after-unmount: navigating away (e.g. Back from a
    // notification-launched accept screen) can unmount this modal while the IPFS
    // fetch is still in flight. `alive` is cleared on cleanup so the awaited
    // result is dropped instead of writing into a torn-down component.
    let alive = true
    const resolveEnvelope = async () => {
      if (!marketData?.isEncrypted) return

      // Try inline JSON first (rawDescription contains the envelope)
      if (marketData.rawDescription) {
        try {
          const parsed = JSON.parse(marketData.rawDescription)
          if (parsed.version && parsed.algorithm && parsed.content) {
            if (alive) setResolvedEnvelope(parsed)
            return
          }
        } catch {
          // Not inline JSON, try IPFS
        }
      }

      // Fetch from IPFS if we have a CID
      const cid = marketData.ipfsCid
      if (cid) {
        try {
          if (alive) setEnvelopeLoading(true)
          const envelope = await fetchEncryptedEnvelope(cid)
          if (alive) setResolvedEnvelope(envelope)
        } catch (err) {
          console.error('Failed to fetch encrypted envelope from IPFS:', err)
        } finally {
          if (alive) setEnvelopeLoading(false)
        }
      }
    }

    setResolvedEnvelope(null)
    resolveEnvelope()
    return () => { alive = false }
  }, [marketData?.isEncrypted, marketData?.rawDescription, marketData?.ipfsCid])

  // Legacy fallback: decrypt using shared creator signature from old invitation URLs
  const decryptWithSharedSignature = useCallback((envelope) => {
    const sig = marketData?.sharedSignature
    if (!sig || !marketData?.creator) return null

    try {
      if (isXWingEnvelope(envelope)) {
        const { secretKey } = deriveXWingKeyPairFromSignature(sig)
        return decryptEnvelopeXWing(envelope, marketData.creator, secretKey)
      } else {
        const { privateKey } = deriveKeyPairFromSignature(sig)
        return decryptEnvelopeX25519(envelope, marketData.creator, privateKey)
      }
    } catch (err) {
      console.warn('[acceptance] Legacy shared signature decryption failed:', err.message)
      return null
    }
  }, [marketData?.sharedSignature, marketData?.creator])

  // Attempt to decrypt once we have the envelope
  useEffect(() => {
    const tryDecrypt = async () => {
      if (!marketData?.isEncrypted || !resolvedEnvelope) return

      setDecryptedDescription(null)
      setDecryptionError(null)

      if (!account) {
        setDecryptionError('Connect wallet to view encrypted wager details')
        return
      }

      try {
        // Primary path: user's own key is in the envelope (on-chain key registry flow)
        if (canUserDecrypt(resolvedEnvelope) && encryptionInitialized) {
          setIsDecrypting(true)
          const decrypted = await decryptMetadata(resolvedEnvelope)
          setDecryptedDescription(decrypted.description || decrypted.name || 'Wager Details')
          setIsDecrypting(false)
          return
        }

        // Legacy fallback: old wagers created with shared signature in URL
        if (marketData?.sharedSignature) {
          const sharedResult = decryptWithSharedSignature(resolvedEnvelope)
          if (sharedResult) {
            setDecryptedDescription(sharedResult.description || sharedResult.name || 'Wager Details')
            return
          }
        }

        // No decryption method available
        if (!canUserDecrypt(resolvedEnvelope)) {
          setDecryptionError('Your encryption key is not registered for this wager. Register your key and ask the creator to re-share.')
        }
      } catch (err) {
        console.error('Failed to decrypt wager:', err)
        setDecryptionError('Failed to decrypt wager content')
        setIsDecrypting(false)
      }
    }

    tryDecrypt()
  }, [marketData?.isEncrypted, resolvedEnvelope, account, encryptionInitialized, canUserDecrypt, decryptMetadata, decryptWithSharedSignature, marketData?.sharedSignature])

  // Handler to manually trigger decryption (requires wallet signature or shared key)
  const handleDecrypt = async () => {
    try {
      setIsDecrypting(true)
      setDecryptionError(null)

      // Use already-resolved envelope, or fetch from IPFS if needed
      let envelope = resolvedEnvelope
      if (!envelope && marketData?.ipfsCid) {
        envelope = await fetchEncryptedEnvelope(marketData.ipfsCid)
        setResolvedEnvelope(envelope)
      }
      if (!envelope && marketData?.rawDescription) {
        envelope = JSON.parse(marketData.rawDescription)
      }
      if (!envelope) {
        throw new Error('No encrypted envelope available')
      }

      // Try 1: shared signature from invitation URL (no wallet interaction needed)
      const sharedResult = decryptWithSharedSignature(envelope)
      if (sharedResult) {
        setDecryptedDescription(sharedResult.description || sharedResult.name || 'Wager Details')
        return
      }

      // Try 2: user's own keys (requires wallet signature if not cached)
      if (!encryptionInitialized) {
        await initializeKeys()
      }
      const decrypted = await decryptMetadata(envelope)
      setDecryptedDescription(decrypted.description || decrypted.name || 'Wager Details')
    } catch (err) {
      console.error('Failed to decrypt wager:', err)
      setDecryptionError(err.message || 'Failed to decrypt')
    } finally {
      setIsDecrypting(false)
    }
  }

  // Format time remaining
  const formatTimeRemaining = useCallback(() => {
    if (timeRemaining <= 0) return 'Expired'

    const hours = Math.floor(timeRemaining / (1000 * 60 * 60))
    const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60))
    const seconds = Math.floor((timeRemaining % (1000 * 60)) / 1000)

    if (hours > 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h remaining`
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m remaining`
    }
    return `${minutes}m ${seconds}s remaining`
  }, [timeRemaining])

  // Format address for display
  const formatAddress = (address) => {
    if (!address) return ''
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }

  const handleAccept = async () => {
    if (!isPasskey && !signer) {
      setError('Please connect your wallet')
      return
    }

    if (!isCorrectNetwork) {
      try {
        await switchNetwork()
      } catch {
        setError('Please switch to the correct network')
        return
      }
    }

    setStep('processing')
    setError(null)

    try {
      // Check deadline hasn't passed BEFORE calling contract
      if (marketData?.acceptanceDeadline && Date.now() >= marketData.acceptanceDeadline) {
        throw new Error('The acceptance deadline has passed. This offer can no longer be accepted.')
      }

      // Named chain, not "whatever the signer is bound to" (spec 110 read-routing decision).
      // Calldata encoding needs no signer and never did.
      const registryCall = (functionName, args) =>
        encodeFunctionData({ abi: normalizeAbi(contractABI), functionName, args })
      const askRegistry = (functionName, args) =>
        readContract(chainId, { address: contractAddress, abi: contractABI, functionName, args })

      // v2: ERC20-only stakes. Pull on-chain wager to get authoritative stake amounts.
      const w = await askRegistry('getWager', [marketId])
      const stakeAmount = w.opponentStake
      const stakeTokenAddress = w.token

      if (!stakeTokenAddress || stakeTokenAddress === zeroAddress) {
        throw new Error('Wager has no stake token configured. (Native stakes are not supported in v2.)')
      }

      const askToken = (functionName, args) =>
        readContract(chainId, { address: stakeTokenAddress, abi: STAKE_TOKEN_ABI, functionName, args })

      // Spec 043 (US3, FR-021): accepting AS a vault → batch [approve, acceptWager] as a threshold-gated
      // vault proposal (the Safe is the opponent; stake pulled from the vault). Only in the vault queue until
      // co-owners approve + execute (FR-022b). Skips the personal balance check — execution enforces it.
      if (operatingAsVault) {
        if (!canActAsVault) throw new Error("Switch to the vault's network to accept as the vault.")
        const approveData = stakeTokenCall('approve', [getAddress(String(contractAddress)), stakeAmount])
        const acceptData = registryCall('acceptWager', [marketId])
        const res = await submitAsActive({
          batch: [
            { to: stakeTokenAddress, value: 0n, data: approveData },
            { to: contractAddress, value: 0n, data: acceptData },
          ],
        })
        if (res?.safeTxHash) setTxHash(res.safeTxHash)
        setStep('success')
        if (onAccepted) onAccepted(marketId)
        return
      }

      // Spec 088 FR-001 — the stake comes out of the ACTING account, so that is the balance the
      // check has to be about. Checking the connected wallet's balance would clear an accept the
      // acting account cannot cover, and reject one it can.
      const balance = BigInt(await askToken('balanceOf', [getAddress(String(takerAddress))]))
      let tokenSymbol = marketData?.stakeTokenSymbol || 'tokens'
      let tokenDecimals = marketData?.stakeTokenDecimals || 18
      try { tokenSymbol = await askToken('symbol') } catch { /* fall back to default */ }
      try { tokenDecimals = Number(await askToken('decimals')) } catch { /* fall back to default */ }

      if (balance < stakeAmount) {
        throw new Error(
          `Insufficient ${tokenSymbol} balance. ` +
          `Have ${formatUnits(balance, tokenDecimals)}, ` +
          `need ${formatUnits(stakeAmount, tokenDecimals)}.`
        )
      }

      // Spec 088 FR-002 — acting as a recovered or hardware account. Same [approve?, acceptWager]
      // batch as the vault branch, but executed rather than proposed: an EOA cannot batch
      // atomically, so `submitAsActiveAccount` sends the calls SEQUENTIALLY, each awaited to
      // inclusion, signed by the acting account's own signer (the unlock / device ceremony runs on
      // demand). Deliberately NOT the gasless leg below: a relayed intent is signed on the
      // connected wallet's rail and has no acting-account twin, and self-submit is the
      // never-stranded fallback those rails already promise.
      if (actingAsSigner) {
        const calls = []
        const allowance = BigInt(
          await askToken('allowance', [getAddress(String(takerAddress)), getAddress(String(contractAddress))]),
        )
        if (allowance < stakeAmount) {
          calls.push({
            to: stakeTokenAddress,
            value: 0n,
            data: stakeTokenCall('approve', [getAddress(String(contractAddress)), stakeAmount]),
          })
        }
        calls.push({
          to: contractAddress,
          value: 0n,
          data: registryCall('acceptWager', [marketId]),
        })
        const res = await submitAsActive({ batch: calls })
        if (res?.txHash) setTxHash(res.txHash)
        setStep('success')
        if (onAccepted) onAccepted(marketId)
        return
      }

      // Passkey rail (spec 041/050): batch [approve?(exact stake), acceptWager] into ONE sponsored
      // UserOp via sendCalls (no signer). Mirrors the useOpenChallengeAccept template.
      if (isPasskey) {
        if (typeof sendCalls !== 'function') {
          throw new Error('This wallet cannot accept on the current transaction rail.')
        }
        const calls = []
        const allowance = BigInt(
          await askToken('allowance', [getAddress(String(account)), getAddress(String(contractAddress))]),
        )
        if (allowance < stakeAmount) {
          calls.push({
            target: stakeTokenAddress,
            data: stakeTokenCall('approve', [getAddress(String(contractAddress)), stakeAmount]),
            value: 0n,
          })
        }
        calls.push({
          target: contractAddress,
          data: registryCall('acceptWager', [marketId]),
          value: 0n,
        })
        const sent = await sendCalls(calls)
        const txHash = sent?.txHash ?? sent?.userOpHash ?? sent?.intentId
        if (txHash) setTxHash(txHash)
        setStep('success')
        if (onAccepted) onAccepted(marketId)
        return
      }

      // Gasless-or-self-submit acceptance: the self-submit closure keeps the existing
      // approve → acceptWager flow; the gasless path skips the approve (EIP-3009 pulls the
      // acceptor's stake) and lets the relayer pay gas. Stake + token come from getWager above.
      const result = await acceptWagerTx.run(marketId, stakeAmount, stakeTokenAddress)
      if (result?.error) throw result.error
      if (result?.txHash) setTxHash(result.txHash)

      setStep('success')
      if (onAccepted) onAccepted(marketId)

    } catch (err) {
      console.error('Error accepting offer:', err)

      // v2 WagerRegistry custom-error string matches. These used to read `err.reason`, which ethers
      // populated with the DECODED custom error name; viem puts that name in no message at all
      // (spec 110 divergence 23), so the reads here route through `revertReasonFrom`, which knows
      // both shapes. Without it every one of these five would fall through to the generic sentence
      // the moment a revert came back from the chain seam instead of an ethers contract.
      const knownRevertReasons = {
        'NotOpen': 'Wager is not open. It may have already been accepted or cancelled.',
        'NotOpponent': 'You are not the named opponent for this wager.',
        'AcceptExpired': 'Acceptance deadline has passed; this offer has expired.',
        'EnforcedPause': 'The wager system is paused. Try again later.',
        'NotAllowedToken': 'The wager stake token is not on the allowlist.',
      }

      let errorMessage = revertReasonFrom(err) || err.message || 'Failed to accept offer'

      // The sanctions guard is the one revert ethers cannot name: ISanctionsGuard's errors are NOT in
      // the registry ABI the frontend ships (they bubble up *through* the registry call), so a screened
      // member saw "unknown custom error" and fell through to "check your balance and allowance" —
      // two things that are both fine (#1292). Recognize it from the selector, ahead of the message
      // patterns below, and decode WHICH party it stopped on rather than assuming: `_runAcceptGuard`
      // screens BOTH (`_screen(taker); _screen(creator);` in WagerRegistryCore.sol), so a creator
      // listed after their wager was created reverts every accept with the CREATOR's address, and
      // blaming the acceptor's own clean account would be a false compliance accusation.
      const screenedAddress = sanctionedAddressFrom(err)
      if (screenedAddress || errorMessage.includes('SanctionedAddress')) {
        errorMessage = screenedPartyMessage({
          // Stops at "not accepted": a stake approval may already have been sent and paid for.
          outcome: 'the wager was not accepted',
          sanctioned: screenedAddress,
          // Acting as a vault, the screened taker is the Safe, not this address — say nothing about
          // whose account it was rather than comparing against the wrong one. Acting as a recovered
          // or hardware account the taker IS known (spec 088), so name that address, not the
          // session's.
          account: operatingAsVault ? null : takerAddress,
        })
      } else {
        // Check for known revert reason strings (from staticCall or revert data)
        for (const [pattern, friendlyMessage] of Object.entries(knownRevertReasons)) {
          if (errorMessage.includes(pattern)) {
            errorMessage = friendlyMessage
            break
          }
        }

        // Check for common error patterns in the message
        if (errorMessage.includes('missing revert data') || errorMessage.includes('unknown custom error')) {
          errorMessage = 'Transaction failed. Please check your balance and allowance, then try again.'
        }
      }

      // Strip verbose ethers v6 error details for cleaner UI display
      if (errorMessage.includes('transaction execution reverted')) {
        // The detailed ethers error is too verbose for the UI; use a friendlier version
        errorMessage = 'Transaction reverted on-chain. The wager acceptance could not be completed. Please try again or check your wallet and network connection if the issue persists.'
      }

      setError(errorMessage)
      setStep('error')
    }
  }

  // Gasless acceptWager (spec 035/036): relayed where the relayer serves the chain and the stake
  // token supports EIP-3009 (Polygon USDC), transparent self-submit otherwise (Mordor USC →
  // auto self-submit). The payment leg authorizes the acceptor's stake via EIP-3009, so the gasless
  // path skips the approve the self-submit closure performs. targetContract is pinned to this modal's
  // own registry address so the relayed target can never diverge from the self-submit one.
  const acceptWagerTx = useGaslessWrite('acceptWager', {
    targetContract: contractAddress,
    params: (wagerId) => ({ wagerId }),
    payment: (wagerId, stakeAmount) => ({ value: stakeAmount }),
    selfSubmit: async (wagerId, stakeAmount, stakeTokenAddress) => {
      const currentAllowance = BigInt(
        await readContract(chainId, {
          address: stakeTokenAddress,
          abi: STAKE_TOKEN_ABI,
          functionName: 'allowance',
          args: [getAddress(String(account)), getAddress(String(contractAddress))],
        }),
      )
      if (currentAllowance < stakeAmount) {
        console.log('Approving stake token for WagerRegistry...')
        const approveTx = await signer.sendTransaction({
          to: stakeTokenAddress,
          data: stakeTokenCall('approve', [getAddress(String(contractAddress)), stakeAmount]),
        })
        await approveTx.wait()
      }
      console.log('Sending acceptWager transaction...')
      const feeOverrides = await getFeeOverrides(signer.provider)
      const tx = await signer.sendTransaction({
        to: contractAddress,
        data: encodeFunctionData({ abi: normalizeAbi(contractABI), functionName: 'acceptWager', args: [wagerId] }),
        ...feeOverrides,
      })
      setTxHash(tx.hash)
      return tx.wait()
    },
  })

  // Gasless declineWager (spec 035/036): relayed where the relayer serves the chain, transparent
  // self-submit otherwise. targetContract is pinned to this modal's own registry address so the
  // relayed target can never diverge from the self-submit one.
  const declineWagerTx = useGaslessWrite('declineWager', {
    targetContract: contractAddress,
    params: (wagerId) => ({ wagerId }),
    selfSubmit: async (wagerId) => {
      const tx = await signer.sendTransaction({
        to: contractAddress,
        data: encodeFunctionData({ abi: normalizeAbi(contractABI), functionName: 'declineWager', args: [wagerId] }),
      })
      setTxHash(tx.hash)
      return tx.wait()
    },
  })

  const handleDecline = async () => {
    if (!isPasskey && !signer) {
      setError('Please connect your wallet')
      return
    }

    if (!isCorrectNetwork) {
      try {
        await switchNetwork()
      } catch {
        setError('Please switch to the correct network')
        return
      }
    }

    setStep('processing')
    setError(null)

    try {
      let result
      if (isPasskey) {
        if (typeof sendCalls !== 'function') {
          throw new Error('This wallet cannot decline on the current transaction rail.')
        }
        const data = encodeFunctionData({
          abi: normalizeAbi(contractABI),
          functionName: 'declineWager',
          args: [marketId],
        })
        const sent = await sendCalls([{ target: contractAddress, data, value: 0n }])
        result = { txHash: sent?.txHash ?? sent?.userOpHash ?? sent?.intentId }
      } else {
        result = await declineWagerTx.run(marketId)
      }
      if (result?.error) throw result.error
      if (result?.txHash) setTxHash(result.txHash)
      setStep('declined')
    } catch (err) {
      let errorMessage = 'Failed to decline the offer.'
      // Same divergence-23 reason as the accept path above: a decoded custom error's name is not
      // in any viem message, so it is read through the shared helper rather than off `.reason`.
      const reason = revertReasonFrom(err) || err?.data?.message || err?.message || ''
      if (reason.includes('NotOpen')) {
        errorMessage = 'This wager is no longer open. It may have been cancelled or already accepted.'
      } else if (reason.includes('NotOpponent')) {
        errorMessage = 'Only the invited participant can decline this offer.'
      } else if (reason.includes('AccountFrozenError')) {
        errorMessage = 'Your account is currently frozen. Please contact support.'
      } else if (reason.includes('user rejected') || reason.includes('ACTION_REJECTED')) {
        errorMessage = 'Transaction was cancelled in your wallet.'
      }
      setError(errorMessage)
      setStep('error')
    }
  }

  const handleRetry = () => {
    setStep('review')
    setError(null)
    setTxHash(null)
  }

  if (!isOpen) return null

  const isExpired = timeRemaining <= 0
  // Require decryption before accepting encrypted wagers (proper consideration)
  const needsDecryption = marketData?.isEncrypted && !decryptedDescription
  const canAccept = isConnected && !hasAlreadyAccepted && !isExpired && (isParticipant || isArbitrator) && !needsDecryption

  // Calculate total pot for display
  const participantCount = marketData?.participants?.length || 0
  const stakePerPerson = parseFloat(marketData?.stakePerParticipant || 0)
  const totalPot = stakePerPerson * participantCount

  return (
    <div
      className="ma-modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ma-title"
    >
      <div className="ma-modal">
        <header className="ma-header">
          <h2 id="ma-title">
            {isArbitrator ? 'Accept Arbitrator Role' : 'Review Offer'}
          </h2>
          <button
            className="ma-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </header>

        <div className="ma-content">
          {step === 'review' && (
            <>
              {/* Wager Description */}
              <div className="ma-market-info">
                {marketData?.isEncrypted ? (
                  <div className="ma-encrypted-section">
                    <div className="ma-encrypted-badge">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0110 0v4"/>
                      </svg>
                      <span>Private Wager</span>
                    </div>
                    {decryptedDescription ? (
                      <h3 className="ma-description">{decryptedDescription}</h3>
                    ) : isDecrypting || encryptionInitializing || envelopeLoading ? (
                      <div className="ma-decrypting">
                        <span className="ma-spinner-small"></span>
                        <span>{envelopeLoading ? 'Loading encrypted data...' : 'Decrypting...'}</span>
                      </div>
                    ) : decryptionError ? (
                      <div className="ma-decrypt-error">
                        <p>{decryptionError}</p>
                        {(isParticipant || isArbitrator) && !encryptionInitialized && (
                          <button
                            type="button"
                            className="ma-btn-decrypt"
                            onClick={handleDecrypt}
                          >
                            Unlock to View Details
                          </button>
                        )}
                      </div>
                    ) : (isParticipant || isArbitrator) ? (
                      <div className="ma-decrypt-prompt">
                        <p>Sign a message to decrypt and view the wager details before accepting</p>
                        <button
                          type="button"
                          className="ma-btn-decrypt"
                          onClick={handleDecrypt}
                        >
                          Decrypt Wager Details
                        </button>
                      </div>
                    ) : (
                      <p className="ma-encrypted-hint">Only participants can view encrypted wager details</p>
                    )}
                  </div>
                ) : (
                  <h3 className="ma-description">{marketData?.description}</h3>
                )}
                <div className={`ma-deadline-warning ${isExpired ? 'expired' : ''}`}>
                  <span className="ma-clock-icon">&#9200;</span>
                  <span>Accept by: {formatTimeRemaining()}</span>
                </div>
              </div>

              {/* Offer Details Section */}
              <div className="ma-offer-details">
                <h4>Offer Details</h4>
                <div className="ma-details-list">
                  <div className="ma-detail-row">
                    <span className="ma-detail-label">Wager Type</span>
                    <span className="ma-detail-value">{getWagerTypeLabel(marketData?.marketType)}</span>
                  </div>
                  <div className="ma-detail-row">
                    <span className="ma-detail-label">Created By</span>
                    <span className="ma-detail-value ma-address">{formatAddress(marketData?.creator)}</span>
                  </div>
                  <div className="ma-detail-row">
                    <span className="ma-detail-label">Resolution</span>
                    <span className="ma-detail-value">{getResolutionLabel(marketData?.resolutionType)}</span>
                  </div>
                  {marketData?.arbitrator && (
                    <div className="ma-detail-row">
                      <span className="ma-detail-label">Arbitrator</span>
                      <span className="ma-detail-value ma-address">{formatAddress(marketData.arbitrator)}</span>
                    </div>
                  )}
                  <div className="ma-detail-row">
                    <span className="ma-detail-label">Token</span>
                    <span className="ma-detail-value">{marketData?.stakeTokenSymbol || 'tokens'}</span>
                  </div>
                  <div className="ma-detail-row">
                    <span className="ma-detail-label">Participants</span>
                    <span className="ma-detail-value">
                      {marketData?.acceptedCount || 0} / {participantCount} accepted
                    </span>
                  </div>
                  {marketData?.estimatedMarketEndDate && (
                    <div className="ma-detail-row">
                      <span className="ma-detail-label">Wager Ends</span>
                      <span className="ma-detail-value">
                        {new Date(marketData.estimatedMarketEndDate).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Financial Summary */}
              {!isArbitrator && (
                <div className="ma-financial-summary">
                  <h4>What You Are Agreeing To</h4>
                  <div className="ma-financial-grid">
                    <div className="ma-financial-item ma-financial-stake">
                      <span className="ma-financial-label">Your Stake</span>
                      <span className="ma-financial-value">
                        {formatUSD(marketData?.stakePerParticipant, marketData?.stakeTokenSymbol)}
                      </span>
                    </div>
                    {marketData?.opponentOddsMultiplier && marketData?.opponentOddsMultiplier !== 200 && (
                      <div className="ma-financial-item">
                        <span className="ma-financial-label">Your Odds</span>
                        <span className="ma-financial-value ma-odds-value">
                          {marketData.opponentOddsMultiplier / 100}x
                        </span>
                      </div>
                    )}
                    <div className="ma-financial-item ma-financial-win">
                      <span className="ma-financial-label">If You Win</span>
                      <span className="ma-financial-value">
                        {formatUSD(
                          stakePerPerson * ((marketData?.opponentOddsMultiplier || WAGER_DEFAULTS.ODDS_MULTIPLIER) / 100),
                          marketData?.stakeTokenSymbol
                        )}
                      </span>
                    </div>
                    <div className="ma-financial-item ma-financial-lose">
                      <span className="ma-financial-label">If You Lose</span>
                      <span className="ma-financial-value">
                        -{formatUSD(marketData?.stakePerParticipant, marketData?.stakeTokenSymbol)}
                      </span>
                    </div>
                    {participantCount > 2 && (
                      <div className="ma-financial-item">
                        <span className="ma-financial-label">Total Pot</span>
                        <span className="ma-financial-value">
                          {formatUSD(totalPot, marketData?.stakeTokenSymbol)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {isArbitrator && (
                <div className="ma-financial-summary">
                  <h4>What You Are Agreeing To</h4>
                  <div className="ma-term ma-term-info">
                    <label>Role</label>
                    <span className="ma-value">Arbitrator (No Stake Required)</span>
                  </div>
                  <p className="ma-arbitrator-note">
                    You will be responsible for fairly resolving this wager when participants cannot agree.
                  </p>
                </div>
              )}

              {/* Participants List */}
              <div className="ma-participants">
                <h4>Participants</h4>
                <ul className="ma-participants-list">
                  {marketData?.participants?.map((p, i) => {
                    const isAccepted = marketData?.acceptances?.[p.toLowerCase()]?.hasAccepted
                    const isCreatorAddr = p.toLowerCase() === marketData?.creator?.toLowerCase()
                    const isYou = p.toLowerCase() === account?.toLowerCase()

                    return (
                      <li key={i} className={isAccepted ? 'accepted' : 'pending'}>
                        <span className="ma-participant-addr">
                          {formatAddress(p)}
                          {isCreatorAddr && <span className="ma-badge creator">Creator</span>}
                          {isYou && <span className="ma-badge you">You</span>}
                        </span>
                        <span className="ma-participant-status">
                          {isAccepted ? '✓ Accepted' : '⏳ Pending'}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>

              {/* Already accepted message */}
              {hasAlreadyAccepted && (
                <div className="ma-already-accepted">
                  <span>&#10003;</span>
                  {isCreator
                    ? 'You created this offer. Waiting for participants to consider and accept.'
                    : 'You have already accepted this offer'}
                </div>
              )}

              {/* Expired message */}
              {isExpired && !hasAlreadyAccepted && (
                <div className="ma-expired">
                  <span>&#9888;</span>
                  This offer has expired
                </div>
              )}

              {/* Not invited message */}
              {!isParticipant && !isArbitrator && (
                <div className="ma-not-invited">
                  <span>&#9888;</span>
                  You are not invited to this wager
                </div>
              )}

              {/* Action buttons */}
              {canAccept && (
                <div className="ma-actions">
                  <button className="ma-btn-secondary" onClick={() => setStep('confirmDecline')}>
                    Decline Offer
                  </button>
                  <button
                    className="ma-btn-primary"
                    onClick={() => setStep('confirm')}
                  >
                    {isArbitrator ? 'Accept Role' : 'Accept Offer'}
                  </button>
                </div>
              )}

              {/* Prompt to decrypt before accepting */}
              {needsDecryption && isConnected && !hasAlreadyAccepted && !isExpired && (isParticipant || isArbitrator) && (
                <div className="ma-decrypt-required">
                  <span>&#128274;</span>
                  You must decrypt and review the wager details before you can accept this offer.
                </div>
              )}

              {!isConnected && (
                <div className="ma-connect-prompt">
                  Please connect your wallet to respond to this offer
                </div>
              )}
            </>
          )}

          {step === 'confirm' && (
            <div className="ma-confirmation">
              <h3>Confirm Offer Acceptance</h3>

              {/* Safety Warning Section */}
              <div className="ma-safety-warning">
                <div className="ma-safety-header">
                  <span className="ma-safety-icon">&#9888;</span>
                  <strong>Important Safety Information</strong>
                </div>
                <ul className="ma-safety-list">
                  <li>
                    <span className="ma-check-icon">&#10004;</span>
                    <span><strong>Only accept offers from people you know and trust.</strong> Never accept invitations from strangers.</span>
                  </li>
                  <li>
                    <span className="ma-check-icon">&#10004;</span>
                    <span><strong>This action is permanent and cannot be undone.</strong> Your stake will be locked until the wager resolves.</span>
                  </li>
                  <li>
                    <span className="ma-check-icon">&#10004;</span>
                    <span><strong>Do not include personal information (PII)</strong> in any wager descriptions or communications.</span>
                  </li>
                  <li>
                    <span className="ma-check-icon">&#10004;</span>
                    <span><strong>Verify the offer terms carefully</strong> before accepting. You are agreeing to these exact terms.</span>
                  </li>
                </ul>
              </div>

              {!isArbitrator && (
                <p className="ma-stake-notice">
                  You are about to stake <strong>{formatUSD(marketData?.stakePerParticipant, marketData?.stakeTokenSymbol)}</strong> to join this wager.
                  {marketData?.opponentOddsMultiplier && marketData?.opponentOddsMultiplier !== 200 && (
                    <> At <strong>{marketData.opponentOddsMultiplier / 100}x odds</strong>, you could win <strong>{formatUSD(parseFloat(marketData?.stakePerParticipant || 0) * marketData.opponentOddsMultiplier / 100, marketData?.stakeTokenSymbol)}</strong>.</>
                  )}
                  {(!marketData?.opponentOddsMultiplier || marketData?.opponentOddsMultiplier === 200) && (
                    <> If you win, you&apos;ll receive <strong>{formatUSD(parseFloat(marketData?.stakePerParticipant || 0) * 2, marketData?.stakeTokenSymbol)}</strong>.</>
                  )}
                </p>
              )}
              {isArbitrator && (
                <p className="ma-stake-notice">
                  You are accepting the role of arbitrator for this wager.
                  You will be responsible for resolving disputes fairly.
                </p>
              )}
              <div className="ma-confirm-details">
                <div className="ma-confirm-row">
                  <span>Wager:</span>
                  <span>
                    {(decryptedDescription || marketData?.description)?.slice(0, 50)}
                    {(decryptedDescription || marketData?.description)?.length > 50 ? '...' : ''}
                  </span>
                </div>
                <div className="ma-confirm-row">
                  <span>Created By:</span>
                  <span className="ma-address">{formatAddress(marketData?.creator)}</span>
                </div>
                <div className="ma-confirm-row">
                  <span>Resolution:</span>
                  <span>{getResolutionLabel(marketData?.resolutionType)}</span>
                </div>
                {!isArbitrator && (
                  <>
                    <div className="ma-confirm-row">
                      <span>Your Stake:</span>
                      <span>{formatUSD(marketData?.stakePerParticipant, marketData?.stakeTokenSymbol)}</span>
                    </div>
                    <div className="ma-confirm-row">
                      <span>Potential Win:</span>
                      <span className="ma-potential-win">
                        {formatUSD(
                          parseFloat(marketData?.stakePerParticipant || 0) * (marketData?.opponentOddsMultiplier || WAGER_DEFAULTS.ODDS_MULTIPLIER) / 100,
                          marketData?.stakeTokenSymbol
                        )}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <div className="ma-actions">
                <button className="ma-btn-secondary" onClick={() => setStep('review')}>
                  Back
                </button>
                <button className="ma-btn-primary" onClick={handleAccept}>
                  I Understand, Accept Offer
                </button>
              </div>
            </div>
          )}

          {step === 'confirmDecline' && (
            <div className="ma-confirmation">
              <h3>Decline This Offer?</h3>
              <p className="ma-stake-notice">
                This will permanently decline the wager and return the creator&apos;s stake.
                This action cannot be undone.
              </p>
              <div className="ma-confirm-details">
                <div className="ma-confirm-row">
                  <span>Wager:</span>
                  <span>
                    {(decryptedDescription || marketData?.description)?.slice(0, 50)}
                    {(decryptedDescription || marketData?.description)?.length > 50 ? '...' : ''}
                  </span>
                </div>
                <div className="ma-confirm-row">
                  <span>Created By:</span>
                  <span className="ma-address">{formatAddress(marketData?.creator)}</span>
                </div>
              </div>
              <div className="ma-actions">
                <button className="ma-btn-secondary" onClick={() => setStep('review')}>
                  Back
                </button>
                <button className="ma-btn-danger" onClick={handleDecline}>
                  Confirm Decline
                </button>
              </div>
            </div>
          )}

          {step === 'declined' && (
            <div className="ma-success">
              <div className="ma-success-icon" style={{ background: 'var(--color-warning, #f59e0b)' }}>&#10003;</div>
              <h3>Offer Declined</h3>
              <p>The creator&apos;s funds have been returned. This wager has been removed.</p>
              {txHash && (
                <a
                  href={getTransactionUrl(chainId, txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ma-tx-link"
                >
                  View Transaction
                </a>
              )}
              <button className="ma-btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}

          {step === 'processing' && (
            <div className="ma-processing">
              <div className="ma-spinner"></div>
              <h3>Processing...</h3>
              <p>Please confirm the transaction in your wallet</p>
            </div>
          )}

          {step === 'success' && (
            <div className="ma-success">
              <div className="ma-success-icon">&#10003;</div>
              <h3>Offer Accepted!</h3>
              <p>
                {isArbitrator
                  ? 'You are now the arbitrator for this wager.'
                  : 'Your stake has been deposited. The wager will activate when all participants have accepted the offer.'}
              </p>
              {txHash && (
                <a
                  href={getTransactionUrl(chainId, txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ma-tx-link"
                >
                  View Transaction
                </a>
              )}
              <button className="ma-btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}

          {step === 'error' && (
            <div className="ma-error">
              <div className="ma-error-icon">&times;</div>
              <h3>Transaction Failed</h3>
              <p className="ma-error-message">{error}</p>
              <div className="ma-actions">
                <button className="ma-btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button className="ma-btn-primary" onClick={handleRetry}>
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default MarketAcceptanceModal
