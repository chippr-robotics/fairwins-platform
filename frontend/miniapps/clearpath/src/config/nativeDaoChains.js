/**
 * Why native DAO creation is unavailable on a chain — the two reasons are NOT the same fact.
 *
 * "Not deployed yet" is a temporary state of the estate. "This chain runs a pre-Cancun EVM" is a
 * permanent architectural exclusion the maintainer decided on issue #1268: OpenZeppelin 5.4.0's
 * `Governor` uses the `mcopy` opcode, which ETC 61 and Mordor 63 do not have, so the contract cannot
 * exist there at all. Rendering both as "not available" would leave an ETC member waiting for a rollout
 * that is never coming.
 *
 * Chain ids rather than host config, and that is allowed here for the same reason `config/knownDaos.js`
 * keys by chain id: this is the PACKAGE's own knowledge about chains, not a copy of the host's address
 * book or network map. The host still supplies every name, deployment address and provider.
 */

/** Chains excluded from native DAO creation by decision (issue #1268). */
export const PRE_CANCUN_CHAIN_IDS = new Set([61, 63])

export function isPreCancunChain(chainId) {
  return PRE_CANCUN_CHAIN_IDS.has(Number(chainId))
}

/**
 * A truthful sentence for a member looking at a chain where they cannot create a DAO.
 *
 * @param {number|string} chainId
 * @param {string} networkName  the host's own name for the chain — never one invented here
 */
export function nativeDaoUnavailableReason(chainId, networkName) {
  const where = networkName || `chain ${chainId}`
  if (isPreCancunChain(chainId)) {
    return (
      `${where} runs a pre-Cancun EVM, which cannot run the OpenZeppelin Governor a standard DAO is ` +
      `built from. Launching a DAO here is not planned — but registering, tracking and governing DAOs ` +
      `on ${where} works normally, on the Register / Track tab.`
    )
  }
  return `Launching a DAO is not available on ${where} — the DAO factory is not deployed there.`
}
