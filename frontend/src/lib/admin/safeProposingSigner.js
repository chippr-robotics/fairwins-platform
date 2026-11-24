/**
 * A signer-shaped object that turns every admin write into a proposal on the admin Safe.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Every operator role on the live estate is held by a Safe (`deployments/admin-safe.json`), and
 * the Safe's owners are a KMS key, a Ledger and a Trezor. The console used to send each write
 * straight from the connected wallet — `signer.sendTransaction({ to: contract, data })` — so an
 * owner's Ledger signed a `grantRole` AS ITSELF, which holds no role and reverts.
 *
 * All ~100 admin write sites already go through exactly that one call, so the cheapest correct
 * fix is not to touch them: hand them this object instead. Its `sendTransaction` does what a Safe
 * owner must do to act as the Safe —
 *
 *   1. SIMULATE the call from the Safe's address, so a write the Safe itself is not allowed to make
 *      (a missing role, a bad argument) fails on screen BEFORE the device is asked for anything —
 *      the same promise the wallet rail keeps with its pre-send gas estimate — and confirm the
 *      signing key is still an owner, for the same reason;
 *   2. publish the preimage to the SafeProposalHub (device prompt 1) and wait for it to land, so the
 *      second prompt cannot be populated with the same account nonce;
 *   3. record this owner's `approveHash` on the Safe (device prompt 2).
 *
 * It returns a transaction-SHAPED result marked `proposed: true` whose `hash` is the safeTxHash —
 * NOT a transaction that changed anything. `useAdminTx` reads that mark and says "proposed", never
 * "updated": a 2-of-3 Safe has done nothing until a second owner approves and someone executes.
 *
 * It holds no key. It cannot sign a message or typed data — a Safe has no private key, and signing
 * with the owner's key under the Safe's name would prove control of the wrong account (the same
 * refusal Protect ▸ Verify makes for a vault).
 */
import { encodeFunctionData } from 'viem'
import { normalizeAbi } from '../chains/readContract'
import { SAFE_ABI } from '../../abis/Safe'
import { computeSafeTxHash } from '../custody/vaultTransaction'
import { buildActiveAccountSafeTx } from '../custody/submitAsActiveAccount'
import { emitProposal } from '../custody/proposalHub'

const SAFE_ABI_PARSED = normalizeAbi(SAFE_ABI)

/**
 * The nonce a new proposal should take.
 *
 * Same-nonce proposals on a Safe are mutually exclusive — executing one invalidates the rest — so
 * a new admin action must not land on a nonce another real proposal holds. But "real" is the
 * whole question: `SafeProposalHub.propose` is PERMISSIONLESS, and a verified preimage proves only
 * that the hash matches, not that any owner wants it. If every hub entry counted, anyone could
 * publish a zero-approval proposal at nonce 1,000,000 and push every admin action past it, where
 * none could ever execute (a Safe runs strictly in nonce order).
 *
 * So: walk UP from the on-chain nonce, contiguously, skipping only nonces that are taken by an
 * owner-ENDORSED proposal (at least one current owner's approval) or that this session already
 * reserved. An unendorsed entry never moves the allocation; at worst it shares a nonce with ours,
 * and whichever the owners actually approve and execute wins.
 *
 * @param {{ onchainNonce: bigint|number, endorsedNonces?: Array<bigint|number>,
 *   reserved?: Iterable<bigint|number> }} f
 * @returns {bigint}
 */
export function nextFreeNonce({ onchainNonce, endorsedNonces = [], reserved = [] }) {
  const taken = new Set([...endorsedNonces, ...reserved].map((n) => BigInt(n).toString()))
  let next = BigInt(onchainNonce)
  while (taken.has(next.toString())) next += 1n
  return next
}

/**
 * @param {object} cfg
 * @param {string} cfg.safeAddress
 * @param {number} cfg.chainId                 the chain the Safe tx is hashed for (the owner's chain)
 * @param {object} cfg.ownerSigner             ethers-shaped signer of a Safe OWNER (wallet or device)
 * @param {string|undefined} cfg.hubAddress    SafeProposalHub on this chain
 * @param {object|undefined} cfg.safeContracts Safe v1.4.1 set on this chain
 * @param {() => Promise<void>} [cfg.assertOwner] refuse unless the signing key owns the Safe NOW
 * @param {() => Promise<bigint>} cfg.reserveNonce
 * @param {(nonce: bigint) => void} [cfg.releaseNonce] undo a reservation whose proposal never landed
 * @param {(call: {from:string,to:string,data:string,value:bigint}) => Promise<unknown>} cfg.simulate
 * @param {(step: {step: 'publish'|'approve', of: 2}) => void} [cfg.onStep]
 * @param {(result: {safeTxHash:string, nonce:bigint}) => void} [cfg.onProposed]
 */
export function createSafeProposingSigner({
  safeAddress,
  chainId,
  ownerSigner,
  hubAddress,
  safeContracts,
  assertOwner,
  reserveNonce,
  releaseNonce,
  simulate,
  onStep,
  onProposed,
}) {
  if (!safeAddress || !ownerSigner) return null

  const refuseKeyless = () => {
    throw new Error(
      'A Safe has no private key, so it cannot sign a message. Nothing has been signed — switch the console back to acting as your own account to sign.',
    )
  }

  return {
    isProposingSigner: true,
    safeAddress,
    chainId,
    ownerSigner,
    provider: ownerSigner.provider ?? null,

    async getAddress() {
      return safeAddress
    },

    signMessage: refuseKeyless,
    signTypedData: refuseKeyless,

    async sendTransaction(tx = {}) {
      if (!hubAddress) {
        throw new Error('Safe proposals are not configured on this network, so nothing was proposed.')
      }
      if (!safeContracts) {
        throw new Error('Safe contracts are not available on this network, so nothing was proposed.')
      }
      const to = tx.to
      const data = tx.data ?? '0x'
      const value = BigInt(tx.value ?? 0)

      // 1. Would the SAFE be allowed to do this? A revert here is rethrown untouched so the
      //    caller's revert decoder can name it ("Refused on-chain: AccessControlUnauthorizedAccount").
      await simulate({ from: safeAddress, to, data, value })

      // A key that does not own the Safe would pay to publish, then have `approveHash` revert.
      // Asked of the chain at submit time, not taken from what the bar showed on render.
      if (assertOwner) await assertOwner()

      const nonce = await reserveNonce()
      let safeTxHash
      try {
        const safeTx = buildActiveAccountSafeTx({ to, value, data }, { nonce, multiSendCallOnly: safeContracts.multiSendCallOnly })
        safeTxHash = computeSafeTxHash(safeAddress, chainId, safeTx)

        // 2. Publish the preimage so the other owners can see and verify it.
        onStep?.({ step: 'publish', of: 2 })
        const published = await emitProposal({ hubAddress, safe: safeAddress, safeTx, safeTxHash, signer: ownerSigner })
        if (published?.wait) await published.wait()

        // 3. This owner's approval, recorded on the Safe itself.
        onStep?.({ step: 'approve', of: 2 })
        const approval = await ownerSigner.sendTransaction({
          to: safeAddress,
          data: encodeFunctionData({ abi: SAFE_ABI_PARSED, functionName: 'approveHash', args: [safeTxHash] }),
        })
        if (approval?.wait) await approval.wait()
      } catch (err) {
        // A rejected device prompt must not leave the nonce reserved: the next proposal would
        // take N+1 with nothing at N, and a Safe executes strictly in nonce order, so it could
        // never run. Releasing is safe even if the publish DID land — the queue then lists the
        // proposal at N and `nextFreeNonce` steps past it.
        releaseNonce?.(nonce)
        onStep?.(null)
        throw err
      }

      onProposed?.({ safeTxHash, nonce })
      const result = { status: 1, proposed: true, safeTxHash, hash: safeTxHash, nonce }
      return {
        hash: safeTxHash,
        safeTxHash,
        nonce,
        proposed: true,
        async wait() {
          return result
        },
      }
    },
  }
}
