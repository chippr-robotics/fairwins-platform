// Spec 102 — chain naming helpers for the Protect vault surfaces, re-exported from the grouping
// module so there is ONE strict lookup (`vaultChainName`, never `getNetwork()`, which would relabel
// an unknown chain as the default network — exactly the confusion Protect exists to prevent).

import { NETWORKS } from '../../config/networks'

export { vaultChainName as chainDisplayName, listChainNames } from './vaultGroups'

export function isTestnetChain(chainId) {
  return Boolean(NETWORKS[Number(chainId)]?.isTestnet)
}
