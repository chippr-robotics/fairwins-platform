import { useCallback, useState } from 'react'
import {
  decodeEventLog, encodeFunctionData, keccak256, stringToHex, maxUint256, zeroAddress, zeroHash,
} from 'viem'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { parseUnits } from '../lib/evm/units'
import { getAddress } from '../lib/evm/address'
import { useWeb3 } from './useWeb3'
import { WAGER_REGISTRY_ABI } from '../abis/WagerRegistry'
import { getContractAddressForChain, getContractAddress } from '../config/contracts'
import { uploadEncryptedEnvelope, buildEncryptedIpfsReference } from '../utils/ipfsService'
import { generateCode, normalizeCode } from '../utils/claimCode/wordlist.js'
import { deriveFromCode } from '../utils/claimCode/deriveFromCode.js'
import { encryptEnvelopeCode } from '../utils/crypto/envelopeEncryption.js'
import { getCurrentDocument } from '../utils/legalDocs'
import { revertReasonFrom, screenedActorMessage } from '../lib/wagers/sanctionsRevert'

// Honest passkey-UserOp lifecycle states as returned by sendCalls (mirrors LIFECYCLE in
// lib/passkey/submission.js — kept as literals here to avoid pulling the relay graph into this hook).
const OP_STATE = Object.freeze({ SUBMITTED: 'submitted', INCLUDED: 'included', FAILED: 'failed' })

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

const REGISTRY_ABI_PARSED = normalizeAbi(WAGER_REGISTRY_ABI)
const ERC20_ABI_PARSED = normalizeAbi(ERC20_ABI)
const registryCall = (functionName, args) =>
  encodeFunctionData({ abi: REGISTRY_ABI_PARSED, functionName, args })
const erc20Call = (functionName, args) =>
  encodeFunctionData({ abi: ERC20_ABI_PARSED, functionName, args })

// Resolution types permitted for an open challenge (FR-016a): NOT Creator(1)/Opponent(2).
export const OPEN_RESOLUTION_TYPES = { Either: 0, ThirdParty: 3, Polymarket: 4, ChainlinkDataFeed: 5, ChainlinkFunctions: 6, UMA: 7 }

/**
 * Create-an-open-challenge flow (feature 024). Generates a four-word claim code, derives the on-chain
 * commitment (claimAuthority) and the symmetric terms key, seals the terms under a code-keyed envelope to
 * IPFS, and calls createOpenWager. Silver+ membership is enforced on-chain (surfaced as a friendly revert).
 *
 * Returns { code, wagerId, txHash } — the code is shown ONCE for the creator to save/share out-of-band; it
 * is never sent anywhere.
 */
export function useOpenChallengeCreate() {
  const { signer, provider, chainId, address, account, sendCalls, loginMethod } = useWeb3()
  const isPasskey = loginMethod === 'passkey'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const createOpenChallenge = useCallback(async (form, onProgress = () => {}) => {
    setError(null)
    setBusy(true)
    try {
      const actor = address || account
      const readProvider = provider || signer?.provider
      if (!actor || !readProvider) throw new Error('Connect your wallet to create an open challenge.')

      const net = chainId != null ? { chainId } : await readProvider.getNetwork()
      const execChainId = Number(net.chainId)
      const resolve = (n) => getContractAddressForChain(n, execChainId) || getContractAddress(n)

      const registryAddr = resolve('wagerRegistry')
      if (!registryAddr) throw new Error('WagerRegistry is not deployed on this network.')
      const tokenAddr = (form.token && form.token !== zeroAddress) ? form.token : resolve('paymentToken')
      if (!tokenAddr) throw new Error('A stake token (USDC) is required.')

      const askToken = (functionName, args) =>
        readContract(execChainId, { address: tokenAddr, abi: ERC20_ABI, functionName, args })
      const decimals = Number(await askToken('decimals'))
      // The seam refuses a stake this token cannot represent exactly (spec 110 divergence 20:
      // viem rounds half-up where ethers threw) — the escrowed amount must be what was entered.
      const stakeWei = parseUnits(String(form.stake || '10'), decimals)

      const balance = await askToken('balanceOf', [getAddress(String(actor))])
      if (BigInt(balance) < stakeWei) throw new Error('Insufficient token balance for this stake.')

      // 1. Generate the claim code + derive the on-chain commitment and the terms key.
      onProgress({ step: 'code', message: 'Generating your claim code…' })
      const code = generateCode()
      const { claimAddress, symKey } = deriveFromCode(code)

      // 2. Seal the private terms under the code-derived key and pin to IPFS.
      onProgress({ step: 'upload', message: 'Encrypting and uploading terms…' })
      const termsDoc = getCurrentDocument('terms')
      const termsVersion = termsDoc ? { id: termsDoc.id, hash: termsDoc.hash } : null
      // Oracle-settled challenges (spec 041) seal the market metadata alongside the
      // description so a code-holder can read the bet (question, outcome labels, side)
      // even when live market data is unreachable. The on-chain fields
      // (resolutionType / polymarketConditionId / creatorIsYes) stay authoritative —
      // the claimant view cross-checks this block against them. Never on-chain plaintext:
      // a public market reference would break code-gated indistinguishability (spec 024).
      const envelope = encryptEnvelopeCode(
        {
          description: form.description || 'Open challenge',
          createdAt: new Date().toISOString(),
          ...(form.oracleMeta ? { oracle: form.oracleMeta } : {}),
        },
        symKey,
        termsVersion
      )
      const { cid } = await uploadEncryptedEnvelope(envelope, { marketType: 'openChallenge' })
      const metadataReference = buildEncryptedIpfsReference(cid)
      const metadataHash = keccak256(stringToHex(metadataReference))

      // 3. Approve the stake token (max) if needed.
      const allowance = BigInt(
        await askToken('allowance', [getAddress(String(actor)), getAddress(String(registryAddr))]),
      )

      // 4. Deadlines.
      const now = Math.floor(Date.now() / 1000)
      const acceptDeadline = form.acceptDeadline || (now + 48 * 3600)
      const resolveDeadline = form.resolveDeadline || (acceptDeadline + 7 * 86400)

      const resolutionType = Number(form.resolutionType ?? OPEN_RESOLUTION_TYPES.Either)
      const arbitrator = resolutionType === OPEN_RESOLUTION_TYPES.ThirdParty
        ? form.arbitrator
        : zeroAddress
      const oracleConditionId = form.oracleConditionId || zeroHash
      const creatorIsYes = Boolean(form.creatorIsYes)

      const args = [
        // Checksummed before the encoder (divergence 16); the arbitrator may be the zero address.
        getAddress(String(claimAddress)), getAddress(String(arbitrator)), getAddress(String(tokenAddr)), stakeWei,
        acceptDeadline, resolveDeadline, resolutionType,
        oracleConditionId, creatorIsYes, metadataHash, metadataReference,
      ]

      // Pre-flight to surface a clear revert (e.g. Silver-tier gate) before the wallet prompt.
      // The stake is pulled with transferFrom, so simulating createOpenWager in isolation also
      // exercises the token allowance. When the stake token isn't approved yet the approve leg
      // runs first — batched atomically for passkey/smart accounts, sequential for EOAs — so the
      // allowance IS in place by the time create executes. Treat a not-yet-granted-allowance
      // revert here as expected (never fatal): otherwise the isolated pre-flight would spuriously
      // fail and permanently block first-time creators (a fresh passkey account has 0 allowance
      // and no way to pre-approve, so it can never get past this check). Every other revert
      // (Silver-tier gate, bad deadlines, resolved condition, …) is still surfaced for all users.
      onProgress({ step: 'create', message: 'Validating…' })
      try {
        await readContract(execChainId, {
          address: registryAddr,
          abi: WAGER_REGISTRY_ABI,
          functionName: 'createOpenWager',
          args,
          account: getAddress(String(actor)),
        })
      } catch (sim) {
        const raw = revertReasonFrom(sim)
        const isAllowanceRevert = /(exceeds|insufficient) allowance/i.test(raw)
        if (!(isAllowanceRevert && allowance < stakeWei)) {
          throw new Error(translateOpenCreateRevert(raw), { cause: sim })
        }
      }

      let receipt
      if (signer && !isPasskey) {
        if (allowance < stakeWei) {
          onProgress({ step: 'approve', message: 'Approving token spend…' })
          await (
            await signer.sendTransaction({
              to: tokenAddr,
              data: erc20Call('approve', [getAddress(String(registryAddr)), maxUint256]),
            })
          ).wait()
        }
        onProgress({ step: 'create', message: 'Confirm in your wallet…' })
        const tx = await signer.sendTransaction({
          to: registryAddr,
          data: registryCall('createOpenWager', args),
        })
        receipt = await tx.wait()
      } else {
        if (typeof sendCalls !== 'function') {
          throw new Error('This wallet cannot submit open challenges on the current transaction rail.')
        }
        const calls = []
        if (allowance < stakeWei) {
          onProgress({ step: 'approve', message: 'Approving token spend…' })
          calls.push({
            target: tokenAddr,
            data: erc20Call('approve', [getAddress(String(registryAddr)), maxUint256]),
            value: 0n,
          })
        }
        onProgress({ step: 'create', message: 'Confirm in your wallet…' })
        calls.push({
          target: registryAddr,
          data: registryCall('createOpenWager', args),
          value: 0n,
        })
        const sent = await sendCalls(calls, {
          onState: (s) => {
            if (s?.state === OP_STATE.SUBMITTED) onProgress({ step: 'create', message: 'Submitted — confirming on-chain…' })
          },
        })
        // Honest terminal state (spec 041 FR-017): a passkey batch resolves to included | failed | stalled
        // and sendCalls NEVER throws on a stalled/never-included UserOp. A userOpHash is NOT a transaction
        // hash — reconciling it via getTransactionReceipt polls forever and would then hand out a one-time
        // claim code for a challenge that was never created on-chain. So branch on the state honestly.
        if (sent?.state === OP_STATE.FAILED) {
          throw new Error(sent.reason || 'Creation reverted on-chain.')
        }
        if (sent?.state && sent.state !== OP_STATE.INCLUDED) {
          throw new Error(
            'Your challenge was submitted but hasn’t confirmed on-chain yet. Check “My Wagers” in a moment — if it doesn’t appear there, you can safely retry.'
          )
        }
        // Included (or a legacy/classic-shaped result carrying a real txHash): use the on-chain hash.
        const txHash = sent?.state === OP_STATE.INCLUDED ? sent.txHash : (sent?.txHash ?? sent?.userOpHash ?? sent?.intentId)
        if (!txHash) throw new Error('Creation submitted but no transaction hash was returned.')
        for (let i = 0; i < 20; i += 1) {
          receipt = await readProvider.getTransactionReceipt(txHash)
          if (receipt) break
          await new Promise((res) => setTimeout(res, 1500))
        }
        if (!receipt) return { code: normalizeCode(code), wagerId: null, txHash }
      }
      if (!receipt || receipt.status === 0) throw new Error('Creation reverted on-chain.')

      const ev = (receipt.logs || [])
        .map((l) => {
          try {
            const { eventName, args: a } = decodeEventLog({
              abi: REGISTRY_ABI_PARSED,
              topics: l.topics,
              data: l.data,
            })
            return { name: eventName, args: a }
          } catch {
            return null
          }
        })
        .find((p) => p && p.name === 'OpenWagerCreated')
      const wagerId = ev ? ev.args.wagerId : null

      return { code: normalizeCode(code), wagerId, txHash: receipt.hash }
    } catch (e) {
      setError(e.message)
      throw e
    } finally {
      setBusy(false)
    }
  }, [signer, provider, chainId, address, account, sendCalls, isPasskey])

  return { createOpenChallenge, busy, error }
}

/** Map known createOpenWager reverts to friendly messages. */
export function translateOpenCreateRevert(reason) {
  const r = String(reason)
  // Compliance screening (spec 007 FR-054) — `createOpenWager` opens with `_screen(msg.sender)`
  // (contracts/wagers/WagerRegistry.sol), so the acting member is the only account screened here.
  // Without this the same revert #1292 reports reached the member as the raw "unknown custom error".
  if (r.includes('SanctionedAddress')) return screenedActorMessage('the open challenge was not created')
  if (r.includes('InsufficientMembershipTier')) return 'Creating an open challenge requires a Silver membership or above. Upgrade your tier to post one.'
  if (r.includes('MembershipDenied')) return 'An active membership is required to create a challenge.'
  if (r.includes('OpenResolutionTypeNotAllowed')) return 'Open challenges can use Either-side, third-party arbitrator, or an oracle — not single-party self-resolution.'
  if (r.includes('ClaimAuthorityInUse')) return 'That claim code is already in use by a live challenge. Generating a new one…'
  if (r.includes('ZeroClaimAuthority')) return 'Internal error: the claim code did not derive an authority. Please retry.'
  if (r.includes('ArbitratorRequired')) return 'A third-party challenge needs a named arbitrator address.'
  if (r.includes('ArbitratorDisallowed')) return 'This resolution type does not take an arbitrator.'
  if (r.includes('BadDeadlines')) return 'The accept/resolve deadlines are outside the allowed window.'
  if (r.includes('NotAllowedToken')) return 'That stake token is not allowed.'
  if (r.includes('ZeroStake')) return 'Enter a stake greater than zero.'
  // Oracle-linked open challenges (spec 041).
  if (r.includes('ConditionAlreadyResolved')) return 'That market has already resolved — pick a market that is still live.'
  if (r.includes('PolymarketRequired')) return 'Pick a Polymarket market to link this challenge to.'
  if (r.includes('PolymarketDisallowed')) return 'A market can only be linked when the challenge is oracle-settled.'
  if (r.includes('AdapterNotSet') || r.includes('OracleAdapterNotSet')) return 'Polymarket settlement isn’t available on this network yet.'
  if (r.includes('OracleConditionRequired')) return 'Pick an oracle condition to link this challenge to.'
  return reason || 'Could not create the open challenge. Please try again.'
}

export default useOpenChallengeCreate
