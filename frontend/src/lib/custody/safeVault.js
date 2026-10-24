// Spec 043 — Safe (v1.4.1) vault create/load/read. Deploys a new Safe via SafeProxyFactory.createProxyWithNonce
// (deterministic CREATE2 address, previewable before signing), and reads live vault state (owners, threshold,
// nonce, version, native balance). No Safe Transaction Service involved. See contracts/vault-transactions.md.

import {
  AbiCoder,
  Contract,
  Interface,
  ZeroAddress,
  getAddress,
  getCreate2Address,
  isAddress,
  keccak256,
  solidityPackedKeccak256,
} from 'ethers'
import { SAFE_ABI } from '../../abis/Safe'
import { SAFE_PROXY_FACTORY_ABI, SAFE_SETUP_ABI } from '../../abis/SafeProxyFactory'
import { getSafeContracts } from '../../config/safeContracts'
import { getProvider } from '../../utils/blockchainService'

const setupIface = new Interface(SAFE_SETUP_ABI)
const factoryIface = new Interface(SAFE_PROXY_FACTORY_ABI)

/**
 * Encode the Safe.setup initializer (no gas refunds). By default there is no setup delegatecall —
 * the encoding is byte-identical to the original policy-less initializer (spec 049 FR-010/SC-007).
 * Pass `policySetup` (`{setupTo, setupData}` from spec 049's `buildEnablePolicySetup`) to attach a
 * policy guard atomically at creation.
 */
export function buildSetupInitializer(owners, threshold, fallbackHandler, policySetup = {}) {
  const { setupTo = ZeroAddress, setupData = '0x' } = policySetup || {}
  const cleanOwners = owners.map((o) => getAddress(o))
  return setupIface.encodeFunctionData('setup', [
    cleanOwners,
    BigInt(threshold),
    getAddress(setupTo), // to (setup delegatecall target; ZeroAddress = none)
    setupData, // data (setup delegatecall payload; '0x' = none)
    getAddress(fallbackHandler),
    ZeroAddress, // paymentToken
    0n, // payment
    ZeroAddress, // paymentReceiver
  ])
}

/**
 * Approvals a vault of `n` owners is offered by default: a simple majority (release 1.14.0).
 * A default of 1 makes every co-owner decorative — the vault reads as shared control while any
 * single key still moves everything — and a default of n locks the vault the first time somebody
 * loses a phone. The member can still set any value the Safe accepts.
 */
export function suggestedThreshold(ownerCount) {
  return Math.max(1, Math.ceil(Math.max(1, Number(ownerCount) || 1) / 2))
}

/** Validate owners + threshold (FR-005). Throws with a user-facing message on invalid input. */
export function validateVaultConfig(owners, threshold) {
  const seen = new Set()
  for (const o of owners) {
    let a
    try {
      a = getAddress(o)
    } catch {
      throw new Error(`Invalid owner address: ${o}`)
    }
    if (seen.has(a)) throw new Error(`Duplicate owner: ${a}`)
    seen.add(a)
  }
  if (owners.length === 0) throw new Error('At least one owner is required')
  const t = Number(threshold)
  if (!Number.isInteger(t) || t < 1) throw new Error('Threshold must be at least 1')
  if (t > owners.length) throw new Error('Threshold cannot exceed the number of owners')
}

/**
 * Pure CREATE2 computation matching SafeProxyFactory.createProxyWithNonce:
 * salt = keccak256(keccak256(initializer) ‖ saltNonce); initCode = proxyCreationCode ‖ abi.encode(singleton).
 * Separated out so it is deterministically unit-testable without a provider.
 * @returns {string} checksummed predicted address
 */
export function computeVaultAddress({ proxyFactory, singleton, initializer, saltNonce, creationCode }) {
  const salt = solidityPackedKeccak256(['bytes32', 'uint256'], [keccak256(initializer), BigInt(saltNonce)])
  // SafeProxyFactory appends the singleton to the proxy creation code as a single 32-byte word
  // (abi.encodePacked(creationCode, uint256(uint160(singleton)))). Encoding the address here yields the same
  // 32-byte left-padded word, so the CREATE2 preimage matches the on-chain factory exactly.
  const deploymentData =
    creationCode + AbiCoder.defaultAbiCoder().encode(['address'], [getAddress(singleton)]).slice(2)
  return getCreate2Address(getAddress(proxyFactory), salt, keccak256(deploymentData))
}

/**
 * Predict the CREATE2 address of a Safe created with createProxyWithNonce (reads proxyCreationCode on-chain).
 * @returns {Promise<string>} checksummed predicted address
 */
export async function predictVaultAddress({ chainId, initializer, saltNonce, provider }) {
  const safe = getSafeContracts(chainId)
  if (!safe) throw new Error(`Custody is not available on chain ${chainId}`)
  const reader = provider || getProvider(chainId)
  const factory = new Contract(safe.proxyFactory, SAFE_PROXY_FACTORY_ABI, reader)
  const creationCode = await factory.proxyCreationCode()
  return computeVaultAddress({
    proxyFactory: safe.proxyFactory,
    singleton: safe.singletonL2,
    initializer,
    saltNonce,
    creationCode,
  })
}

/**
 * Pure: build the createProxyWithNonce calldata for a new vault (no provider, no predicted address).
 * `policySetup` ({setupTo, setupData}, optional) attaches a policy guard at creation (spec 049 US1).
 * @returns {{ to:string, data:string, value:bigint, initializer:string }}
 */
export function buildCreateVaultCalldata({ chainId, owners, threshold, saltNonce, policySetup }) {
  validateVaultConfig(owners, threshold)
  const safe = getSafeContracts(chainId)
  if (!safe) throw new Error(`Custody is not available on chain ${chainId}`)
  const initializer = buildSetupInitializer(owners, threshold, safe.fallbackHandler, policySetup)
  const data = factoryIface.encodeFunctionData('createProxyWithNonce', [
    getAddress(safe.singletonL2),
    initializer,
    BigInt(saltNonce),
  ])
  return { to: getAddress(safe.proxyFactory), data, value: 0n, initializer }
}

/**
 * Build the createProxyWithNonce transaction plus the deterministic predicted address (reads
 * proxyCreationCode on-chain via `provider`).
 * @returns {{ to:string, data:string, value:bigint, predictedAddress:string }}
 */
export async function buildCreateVaultTx({ chainId, owners, threshold, saltNonce, policySetup, provider }) {
  const { to, data, value, initializer } = buildCreateVaultCalldata({ chainId, owners, threshold, saltNonce, policySetup })
  const predictedAddress = await predictVaultAddress({ chainId, initializer, saltNonce, provider })
  return { to, data, value, predictedAddress }
}

/**
 * Deploy a new vault. Sends createProxyWithNonce with `signer` and returns the deployed proxy address parsed
 * from the ProxyCreation event (falling back to the predicted address).
 */
export async function createVault({ signer, chainId, owners, threshold, saltNonce, policySetup }) {
  const tx = await buildCreateVaultTx({ chainId, owners, threshold, saltNonce, policySetup, provider: signer.provider })
  const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })
  const receipt = await sent.wait()
  let deployed = tx.predictedAddress
  for (const log of receipt.logs || []) {
    try {
      const parsed = factoryIface.parseLog(log)
      if (parsed?.name === 'ProxyCreation') {
        deployed = getAddress(parsed.args.proxy)
        break
      }
    } catch {
      /* not a factory log */
    }
  }
  return { address: deployed, txHash: sent.hash, predictedAddress: tx.predictedAddress }
}

/**
 * Load a vault's live on-chain state. Returns null-ish shape only when the address is not a Safe.
 * @returns {Promise<{address,chainId,owners,threshold,nonce,version,isSafe:boolean}>}
 */
export async function loadVault(address, chainId, provider) {
  const addr = getAddress(address)
  const reader = provider || getProvider(chainId)
  const code = await reader.getCode(addr)
  if (!code || code === '0x') {
    return { address: addr, chainId: Number(chainId), isSafe: false, reason: 'no-contract' }
  }
  const safe = new Contract(addr, SAFE_ABI, reader)
  try {
    const [owners, threshold, nonce] = await Promise.all([
      safe.getOwners(),
      safe.getThreshold(),
      safe.nonce(),
    ])
    let version = ''
    try {
      version = await safe.VERSION()
    } catch {
      /* older/foreign Safe without VERSION() */
    }
    if (!owners.length || threshold === 0n) {
      return { address: addr, chainId: Number(chainId), isSafe: false, reason: 'not-a-safe' }
    }
    return {
      address: addr,
      chainId: Number(chainId),
      isSafe: true,
      owners: owners.map((o) => getAddress(o)),
      threshold: Number(threshold),
      nonce: Number(nonce),
      version,
    }
  } catch {
    return { address: addr, chainId: Number(chainId), isSafe: false, reason: 'not-a-safe' }
  }
}

/**
 * Spec 068 — EIP-3770 shortNames (lowercased) → chainId, for the custody chains plus the aliases
 * members actually meet in Safe UIs: the ETC Cooperative's Safe fork displays vault and owner
 * addresses as "ETC:0x…" (Classic) and "ETCM:0x…" (Mordor), and members paste them verbatim —
 * the raw string would fail address validation before any chain was ever searched.
 */
export const CHAIN_SHORTNAMES = {
  etc: 61,
  etcm: 63,
  mordor: 63,
  matic: 137, // Polygon's registered EIP-3770 shortName
  pol: 137,
  oeth: 10, // Optimism
  base: 8453,
  arb1: 42161, // Arbitrum One
}

/**
 * Split an optionally chain-prefixed address input ("ETCM:0xabc…" → address + chain hint).
 * A recognized prefix becomes a chain hint; an unrecognized one is stripped without a hint
 * (better to search everywhere than to reject a paste over its label). Validation of the
 * address itself stays with the caller so error copy is consistent.
 */
export function parseVaultAddressInput(raw) {
  const trimmed = String(raw || '').trim()
  const m = /^([A-Za-z0-9-]+):(.+)$/.exec(trimmed)
  if (!m || !isAddress(m[2].trim())) return { address: trimmed, chainHint: null }
  return { address: m[2].trim(), chainHint: CHAIN_SHORTNAMES[m[1].toLowerCase()] ?? null }
}

/**
 * Spec 068 — find a vault by address across EVERY custody chain, in parallel.
 *
 * A member holding a vault address does not necessarily know which chain it lives on, and asking
 * them to guess (by switching networks until one sticks) is a bad way to find out. Loading by
 * address therefore searches all custody chains rather than only the connected one.
 *
 * Crucially this distinguishes "not there" from "could not look": a chain whose RPC fails is
 * reported as `unreachable`, never as absent — otherwise a single dead endpoint would tell a member
 * their vault does not exist.
 *
 * @returns {{matches: Array, unreachable: Array<{chainId:number, error:string}>, searched: number[]}}
 */
export async function findVaultAcrossChains(address, chainIds, { providerFor, load = loadVault } = {}) {
  const addr = getAddress(address)
  const results = await Promise.all(
    chainIds.map(async (chainId) => {
      try {
        const reader = providerFor ? providerFor(chainId) : undefined
        const state = await load(addr, chainId, reader)
        return { chainId: Number(chainId), state }
      } catch (e) {
        return { chainId: Number(chainId), error: e?.message || 'read failed' }
      }
    }),
  )
  return {
    matches: results.filter((r) => r.state?.isSafe).map((r) => r.state),
    unreachable: results.filter((r) => r.error).map((r) => ({ chainId: r.chainId, error: r.error })),
    searched: chainIds.map(Number),
  }
}

/** Read a vault's native-asset balance (token balances are layered in by the vault detail hook). */
export async function readVaultNativeBalance(address, chainId, provider) {
  const reader = provider || getProvider(chainId)
  return reader.getBalance(getAddress(address))
}

/** Whether a connected address is one of a loaded vault's owners (determines owner vs view-only). */
export function isVaultOwner(vault, account) {
  if (!vault?.isSafe || !account) return false
  const a = getAddress(account)
  return (vault.owners || []).some((o) => getAddress(o) === a)
}
