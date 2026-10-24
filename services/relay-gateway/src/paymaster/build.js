/**
 * Sponsored-paymaster wire format (spec 050). Builds the digest the sponsorship signer signs and
 * packs the v0.6 `paymasterAndData`.
 *
 * `getHash` MUST stay **byte-identical** to `FairWinsVerifyingPaymaster.getHash` (Solidity) — the
 * cross-check test (test/account/*crosscheck*) deploys the contract and asserts equality. A drift
 * here silently produces `AA34`/rejected UserOps.
 */
import { ethers } from 'ethers'

// paymasterAndData layout (v0.6): [paymaster(20)] [validUntil(6)] [validAfter(6)] [signature(65)]
export const PAYMASTER_AND_DATA_MIN_LEN = 20 + 6 + 6 + 65 // 97 bytes
// Fixed 65-byte dummy sig for gas estimation (pm_getPaymasterStubData): valid length, invalid sig.
export const STUB_SIGNATURE = '0x' + 'ff'.repeat(64) + '1b'

const coder = ethers.AbiCoder.defaultAbiCoder()

/**
 * @param {object} userOp v0.6 UserOperation fields (sender, nonce, initCode, callData, gas limits, fees)
 * @param {{paymaster: string, chainId: number|bigint, validUntil: number, validAfter: number}} ctx
 * @returns {string} 32-byte keccak digest (pre eth-signed-message wrap)
 */
export function getHash(userOp, { paymaster, chainId, validUntil, validAfter }) {
  const encoded = coder.encode(
    [
      'address', 'uint256', 'bytes32', 'bytes32',
      'uint256', 'uint256', 'uint256', 'uint256', 'uint256',
      'uint256', 'address', 'uint48', 'uint48',
    ],
    [
      ethers.getAddress(userOp.sender),
      BigInt(userOp.nonce),
      ethers.keccak256(userOp.initCode ?? '0x'),
      ethers.keccak256(userOp.callData ?? '0x'),
      BigInt(userOp.callGasLimit),
      BigInt(userOp.verificationGasLimit),
      BigInt(userOp.preVerificationGas),
      BigInt(userOp.maxFeePerGas),
      BigInt(userOp.maxPriorityFeePerGas),
      BigInt(chainId),
      ethers.getAddress(paymaster),
      validUntil,
      validAfter,
    ]
  )
  return ethers.keccak256(encoded)
}

export function packPaymasterAndData({ paymaster, validUntil, validAfter, signature }) {
  return ethers.solidityPacked(
    ['address', 'uint48', 'uint48', 'bytes'],
    [ethers.getAddress(paymaster), validUntil, validAfter, signature]
  )
}

/** Stub data for `pm_getPaymasterStubData` — real length so verificationGasLimit estimates match. */
export function stubPaymasterAndData({ paymaster, validUntil, validAfter }) {
  return packPaymasterAndData({ paymaster, validUntil, validAfter, signature: STUB_SIGNATURE })
}

/** Total declared gas of a UserOp (for the per-op gas-units ceiling). */
export function totalGas(userOp) {
  return BigInt(userOp.callGasLimit) + BigInt(userOp.verificationGasLimit) + BigInt(userOp.preVerificationGas)
}

/** Worst-case native cost of a UserOp (for the per-op cost ceiling): totalGas × maxFeePerGas. */
export function estCostWei(userOp) {
  return totalGas(userOp) * BigInt(userOp.maxFeePerGas)
}

/**
 * Worst-case prefund the EntryPoint demands of the PAYMASTER for a v0.6 op: with a paymaster
 * present, `verificationGasLimit` counts THREE times (EntryPoint v0.6 `mul = 3`), so this is
 * deliberately larger than `estCostWei` — `AA31 paymaster deposit too low` fires against THIS
 * number, not against `totalGas`. Used by the deposit gate; the configured per-op ceilings keep
 * their original `estCostWei` semantics.
 */
export function requiredPrefundWei(userOp) {
  const gas =
    BigInt(userOp.callGasLimit) + BigInt(userOp.verificationGasLimit) * 3n + BigInt(userOp.preVerificationGas)
  return gas * BigInt(userOp.maxFeePerGas)
}
