import { useCallback, useMemo } from 'react'
import { ethers } from 'ethers'
import { useMiniAppHost } from '@fairwins/miniapp-sdk'

import { FEE_READ, FEE_GAS_ONLY, FEE_UNAVAILABLE } from './createDaoFee'
import { STANDARD_DAO_FACTORY_ABI, encodeCreateDAO, parseCreatedDAO } from './standardDaoFactoryAbi'

/**
 * Spec 030 pillar A — launching a native standard DAO from the ClearPath package.
 *
 * The write rail is `host.wallet.submit` and nothing else: a package has no signer, and `submit` is
 * also where the host's sanctions screening happens, so an app-side pre-check would be strictly weaker
 * than what already runs. `submit` resolves at BROADCAST, so confirmation — and reading the created
 * addresses out of the receipt's own log — is this app's job.
 */

/**
 * Upper bound on awaiting a confirmation. `SubmitResult.wait()` takes a confirmation count but NO
 * timeout, and the host waits through the member's own read endpoint, which is a different endpoint
 * from the one the wallet broadcast through — so "not mined yet" and "not visible here yet" are
 * indistinguishable and waiting forever is a real possibility. Matches useClearPath's own bound.
 *
 * A timeout is NOT a failure: creation may still confirm, and the caller must say so.
 */
const CONFIRM_TIMEOUT_MS = 120000

async function waitWithTimeout(result) {
  let timer
  try {
    return await Promise.race([
      result.wait(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error('confirmation timed out')
          e.code = 'TIMEOUT'
          reject(e)
        }, CONFIRM_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function useStandardDao() {
  const host = useMiniAppHost()
  const { chainId, address: account, isConnected } = host.wallet

  /** Declared in the manifest allowlist; a throw here would be a packaging bug, not a chain fact. */
  const resolve = useCallback(
    (name, forChain) => {
      try {
        return host.contracts(name, forChain)
      } catch {
        return null
      }
    },
    [host],
  )

  /**
   * Whether the factory exists on a given chain.
   *
   * `null` from the host means "declared, but not deployed there" — a fact about the estate, which the
   * surface renders as its own honest unavailable state. It is NOT the same as the undeclared-name
   * throw above, and the two must not collapse into one silence.
   */
  const factoryFor = useCallback(
    (targetChainId = chainId) => {
      const addr = resolve('standardDaoFactory', targetChainId)
      return ethers.isAddress(addr || '') ? addr : null
    },
    [resolve, chainId],
  )

  const factoryAddress = useMemo(() => factoryFor(chainId), [factoryFor, chainId])
  const canCreate = Boolean(factoryAddress)

  const iface = useMemo(() => new ethers.Interface(STANDARD_DAO_FACTORY_ABI), [])

  const showNotification = useCallback((message, type) => host.toast.show(message, type), [host])

  /**
   * What this creation will cost the member, estimated against the REAL calldata (issue #1408).
   *
   * Three outcomes and no fourth, because a fee estimate is a read (spec 071's rule, applied here):
   * gas + price, gas alone, or nothing. Nothing NEVER becomes zero — the fee sentence the surface
   * renders does not depend on this call succeeding, so a failed read costs the member a number,
   * never the disclosure.
   *
   * `estimateGas` reverts for real reasons a member should not be told a price despite: below the
   * factory's Silver floor, a votes token that is not `IVotes`, a timelock delay over the maximum.
   * All of them land in `unavailable`, which is honest — this endpoint could not price the call —
   * and the member still meets the true error at signature time from the wallet or the factory.
   *
   * The read goes through `host.readProvider`, never the wallet: pricing must not require a
   * connected signer, and the host's provider is the endpoint the member chose (spec 069).
   */
  const estimateCreateFee = useCallback(
    async (params) => {
      if (!factoryAddress) return { state: FEE_UNAVAILABLE }
      let provider
      let gas
      try {
        provider = host.readProvider(chainId)
        gas = await provider.estimateGas({
          to: factoryAddress,
          data: encodeCreateDAO(iface, params),
          value: 0n,
          // Estimating AS the member: the factory's membership check reads `msg.sender`, so an
          // estimate from nobody in particular would price a call that reverts for everybody.
          ...(account ? { from: account } : {}),
        })
      } catch {
        return { state: FEE_UNAVAILABLE }
      }
      try {
        const feeData = await provider.getFeeData()
        // `maxFeePerGas` is the CEILING the wallet will offer on an EIP-1559 chain, so it is the
        // number the member should budget against; `gasPrice` covers legacy chains. A chain that
        // answers neither leaves gas as the only fact, which is what `gas-only` says.
        const price = feeData?.maxFeePerGas ?? feeData?.gasPrice ?? null
        if (price == null) return { state: FEE_GAS_ONLY, gas: BigInt(gas) }
        return {
          state: FEE_READ,
          gas: BigInt(gas),
          feeWei: BigInt(gas) * BigInt(price),
          decimals: host.network(chainId)?.nativeCurrency?.decimals ?? 18,
        }
      } catch {
        return { state: FEE_GAS_ONLY, gas: BigInt(gas) }
      }
    },
    [factoryAddress, host, chainId, iface, account],
  )

  /**
   * Create a DAO on the CONNECTED chain. Real transaction, honest state.
   *
   * @returns {Promise<{ status: 'created'|'proposed'|'pending', dao?: object, txHash?: string }>}
   *   `created`  — mined, and the addresses were read from the event.
   *   `proposed` — the member is operating as a vault; the Safe still has to approve. Nothing exists yet.
   *   `pending`  — broadcast, but confirmation could not be observed in time, or the event could not be
   *                read. Never reported as a finished DAO (FR-004/FR-017).
   */
  const createDAO = useCallback(
    async (params) => {
      if (!factoryAddress) {
        showNotification('The DAO factory is not deployed on this network.', 'warning')
        throw new Error('no factory')
      }
      try {
        showNotification('Create DAO: confirm in your wallet…', 'info')
        const data = encodeCreateDAO(iface, params)
        const result = await host.wallet.submit({ to: factoryAddress, data, value: 0n, chainId })

        if (result.kind === 'proposed') {
          showNotification('Create DAO proposed — it needs the vault’s approvals.', 'info')
          return { status: 'proposed' }
        }

        showNotification('Create DAO submitted — awaiting confirmation…', 'info')
        const receipt = await waitWithTimeout(result)
        if (receipt && receipt.status === 0) throw new Error('DAO creation reverted on-chain.')

        const dao = parseCreatedDAO(iface, receipt)
        if (!dao) {
          // Mined, but this endpoint did not return the log. Saying "created" with no addresses would
          // be a phantom DAO in the member's list (FR-017); saying "failed" would be false.
          showNotification('DAO created, but its addresses could not be read here. Refresh in a moment.', 'warning')
          return { status: 'pending', txHash: result.txHash }
        }
        showNotification(`Created ${dao.name || 'DAO'}.`, 'success')
        return { status: 'created', dao, txHash: result.txHash }
      } catch (e) {
        if (e?.code === 'TIMEOUT') {
          showNotification(
            'Creating the DAO is taking longer than expected — it may still confirm. Check your wallet or the explorer.',
            'warning',
          )
          return { status: 'pending' }
        }
        const text = e?.userMessage || e?.shortMessage || e?.reason || e?.message || 'Create DAO failed.'
        showNotification(text.length > 150 ? `${text.slice(0, 149)}…` : text, 'error')
        throw e
      }
    },
    [factoryAddress, host, chainId, iface, showNotification],
  )

  return { chainId, account, isConnected, factoryAddress, canCreate, factoryFor, createDAO, estimateCreateFee }
}
