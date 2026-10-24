/**
 * Reading the ESTATE — the platform's deployed state across every chain this build may read.
 *
 * Promoted here from `components/admin/liquidityAdminCommon.js` (spec 067), which had these
 * helpers for two admin tabs. Spec 071 generalizes them to the whole operations control plane,
 * so they belong in `lib/` — non-component callers (role sync, purchase preflight) use them too.
 *
 * The rules below are not conveniences; each one exists because its absence was, or would be, a
 * specific dishonesty.
 *
 *   1. **Scope is a NETWORK, not the wallet's network.** Control state is per-network and there
 *      are many. Gating an operator surface on the connected chain hides most of an estate from
 *      an operator who is simply connected somewhere else. Reads span the cohort; only WRITES
 *      require the wallet to be on the target chain.
 *
 *   2. **The cohort bounds everything.** `cohortChainIds()` — never `listSupportedChainIds()`,
 *      which spans both cohorts. Constitution III forbids reading across the testnet/mainnet
 *      boundary, and that is the mechanism.
 *
 *   3. **An unreadable read is never a zero.** Every read returns a three-state result
 *      (`chainReadResult.js`). One dead endpoint never fails a batch and never renders as 0.
 *
 *   4. **Authority is read from the contract that will enforce it**, never inferred from an
 *      app-wide role flag — see `readAuthority` for the defect that rule comes from.
 *
 * ── PROVIDERS: WHY THIS FILE DOES NOT TOUCH `NETWORKS[chainId].rpcUrl` ──────────────────────
 * The version of `readProviderFor` this replaces built its provider straight from
 * `NETWORKS[chainId].rpcUrl`. That bypasses `resolveRpcEndpoints`, so the member's configured
 * endpoint and its failover were ignored for every read those two admin tabs made — a live
 * spec-069 violation ("never hand-build a provider from NETWORKS[chainId].rpcUrl"). Generalizing
 * the helper to the rest of the console would have spread that bug across every operator view,
 * so it is fixed here: providers come from `getReadProvider(chainId)`, full stop.
 */
import { keccak256, stringToHex, zeroHash } from 'viem'
import { NETWORKS, cohortChainIds, isInCohort } from '../../config/networks'
import { getReadProvider } from '../../utils/rpcProvider'
import { readContract } from './readContract'
import { readOk, notDeployed, unreadable } from './chainReadResult'

/** keccak256 over a role name's UTF-8 bytes — byte-identical to ethers v6 `id()`. */
const roleId = (name) => keccak256(stringToHex(name))

/** Display name for a chain, or an honest placeholder — never a guessed one. */
export function networkName(chainId) {
  return NETWORKS[chainId]?.name || `Chain ${chainId}`
}

/**
 * The chains an operator view lists: this build's cohort, optionally narrowed to those carrying
 * a capability, mainnets first.
 *
 * Derived from config, not asserted, so the roster stays true as deployments land. A network
 * appears because it COULD carry the thing — whether FairWins has actually deployed there is a
 * separate question the per-chain read answers. Listing only deployed networks would hide the
 * ones an operator most needs to see: the ones still waiting for a deployment.
 */
export function estateNetworks(capability = null) {
  return cohortChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net && (!capability || net.capabilities?.[capability]))
}

/**
 * A read connection for `chainId`, or null when the chain has no endpoint at all.
 *
 * Reuses the wallet's own provider when the scope happens to BE the connected chain — cheaper,
 * and it is already the transport the member chose. Otherwise `getReadProvider` resolves the
 * member's endpoint, headers and failover for that chain (see the file header).
 *
 * NOT for an event-log scan — that wallet-provider preference is precisely wrong there. Use
 * `scanProviderFor` below, which explains why.
 *
 * Returns null rather than throwing; the caller reports that as `unreadable`, never as empty.
 */
export function readProviderFor(chainId, walletChainId, walletProvider, { requireCohort = true } = {}) {
  if (walletProvider && Number(chainId) === Number(walletChainId)) return walletProvider
  // Estate reads are cohort-bounded (FR-002). The spec-067 Bridge/Supply tabs opt out because
  // their routers exist only on mainnets, so a testnet build would otherwise blank them — see
  // the note on `adminNetworks` in components/admin/liquidityAdminCommon.js.
  if (requireCohort && !isInCohort(chainId)) return null
  try {
    return getReadProvider(chainId)
  } catch {
    return null
  }
}

/**
 * A read connection for `chainId` for an EVENT-LOG SCAN — deliberately NEVER the wallet's provider.
 *
 * `readProviderFor` prefers the injected wallet provider whenever the scope is the connected
 * chain. That is right for a point `eth_call`, and WRONG for `eth_getLogs` over history: the
 * transport then belongs to the browser wallet, whose RPC is whatever MetaMask/Brave happens to
 * be pointed at — typically a free pruned node. The admin membership scan on Polygon failed with
 *
 *   "History has been pruned for this block"
 *
 * for exactly that reason, and no amount of member RPC configuration could fix it, because the
 * configured endpoint was never consulted. A scan therefore always goes through
 * `getReadProvider`, which resolves the member's own endpoint + credential header + failover
 * (spec 069) — which is where an archival provider such as QuickNode is configured, and the only
 * place it CAN be configured: a credentialed URL in a `VITE_` variable ships in the public
 * bundle (spec 097).
 *
 * Returns null rather than throwing; the caller reports that as `unreadable`, never as empty.
 */
export function scanProviderFor(chainId, { requireCohort = true } = {}) {
  if (requireCohort && !isInCohort(chainId)) return null
  try {
    return getReadProvider(chainId)
  } catch {
    return null
  }
}

/**
 * Read one thing across the estate, concurrently.
 *
 * NEVER REJECTS. One dead endpoint becomes an `unreadable` entry; its siblings still resolve, so
 * a view is not held hostage by the slowest or the most broken chain (FR-015).
 *
 * @param {object}   opts
 * @param {number[]} [opts.chainIds]   defaults to the whole cohort
 * @param {(chainId:number) => string} opts.addressFor  '' / null ⇒ not deployed on that chain
 * @param {(ctx:{chainId:number, provider:any, address:string}) => Promise<*>} opts.read
 * @param {number}   [opts.walletChainId]
 * @param {*}        [opts.walletProvider]
 * @param {(chainId:number) => object|null} [opts.unitFor]  unit for balance values
 * @returns {Promise<import('./chainReadResult').ChainReadResult[]>}
 */
export function readAcrossEstate({
  chainIds,
  addressFor,
  read,
  walletChainId,
  walletProvider,
  unitFor = () => null,
}) {
  const ids = (chainIds ?? cohortChainIds()).filter(isInCohort)

  return Promise.all(
    ids.map(async (chainId) => {
      let address
      try {
        address = addressFor(chainId)
      } catch (e) {
        return unreadable(chainId, e?.message || 'address lookup failed')
      }
      if (!address) return notDeployed(chainId)

      const provider = readProviderFor(chainId, walletChainId, walletProvider)
      if (!provider) return unreadable(chainId, 'no read connection to this network')

      try {
        const value = await read({ chainId, provider, address })
        return readOk(chainId, value, unitFor(chainId))
      } catch (e) {
        return unreadable(chainId, e?.message || String(e))
      }
    }),
  )
}

/** Minimal AccessControl surface — every contract this asks about exposes it. */
const ACCESS_CONTROL_ABI = ['function hasRole(bytes32 role, address account) view returns (bool)']

/** DEFAULT_ADMIN_ROLE is bytes32(0), not a keccak of a name. */
export const ROLE_HASHES = {
  admin: zeroHash,
  guardian: roleId('GUARDIAN_ROLE'),
  liquidityAdmin: roleId('LIQUIDITY_ADMIN_ROLE'),
  feeAdmin: roleId('FEE_ADMIN_ROLE'),
  stakingAdmin: roleId('STAKING_ADMIN_ROLE'),
  roleManager: roleId('ROLE_MANAGER_ROLE'),
  sanctionsAdmin: roleId('SANCTIONS_ADMIN_ROLE'),
  accountModerator: roleId('ACCOUNT_MODERATOR_ROLE'),
}

/**
 * Does `account` hold `roles` on THIS contract, on THIS chain?
 *
 * ── WHY THE APP-WIDE ROLE FLAGS CANNOT ANSWER THIS ─────────────────────────────────────────
 * `useRoles()`'s `isAdmin` / `isGuardian` / … are one boolean each, resolved against a candidate
 * list on the WALLET's chain. Three separate things break:
 *
 *   • `isGuardian` means "holds GUARDIAN_ROLE on the WagerRegistry" — a different contract from
 *     the one a given view drives. The sets are unrelated, so an operator with the wager
 *     guardianship would be shown an enabled killswitch that reverts.
 *   • roles granted per-contract on purpose (LIQUIDITY_ADMIN on each router) collapse into one
 *     OR, showing an operator holding it on one contract every control on the other.
 *   • all of them read the wallet's chain, while views scope to a network the operator picks.
 *     A Polygon guardian whose wallet sits on Ethereum lost the Polygon controls.
 *
 * So authority is asked of the contract that will enforce it. The app-wide flags keep the job
 * they are good for: deciding whether a view appears at all.
 *
 * ── AND WHY AN UNREADABLE ANSWER IS NOT A DENIAL ───────────────────────────────────────────
 * `readable: false` means the question could not be put, not that the answer was no. Callers keep
 * offering the control and say authority is unconfirmed: the contract is the real gate and will
 * refuse anything the operator does not hold, whereas withdrawing a killswitch because an RPC
 * timed out tells an operator who DOES hold it that there isn't one.
 *
 * `deployed: false` IS a definite answer: there is no contract here to hold a role on.
 *
 * `chainId` names the chain the question is put to; `provider` stays exactly what it always was —
 * the AVAILABILITY GATE, whose null means "no read connection to this network". Keeping the gate
 * where it was is deliberate: callers resolve it through `readProviderFor`, which also enforces
 * the cohort bound, so folding the gate into the seam would quietly answer for chains this build
 * must not read (rule 2). The seam only decides which transport asks.
 */
export async function readAuthority({ chainId, provider, address, account, roles = [] }) {
  const none = Object.fromEntries(roles.map((r) => [r, false]))
  if (!address) return { ...none, roles: none, readable: true, deployed: false, reason: null }
  if (!provider || !account || chainId == null) {
    return {
      ...none,
      roles: none,
      readable: false,
      deployed: true,
      reason: !account ? 'no account connected' : 'no read connection to this network',
    }
  }
  try {
    const answers = await Promise.all(
      roles.map((name) =>
        readContract(chainId, {
          address,
          abi: ACCESS_CONTROL_ABI,
          functionName: 'hasRole',
          args: [ROLE_HASHES[name] ?? roleId(name), account],
        }),
      ),
    )
    const held = Object.fromEntries(roles.map((name, i) => [name, Boolean(answers[i])]))
    return { ...held, roles: held, readable: true, deployed: true, reason: null }
  } catch (e) {
    return { ...none, roles: none, readable: false, deployed: true, reason: e?.message || String(e) }
  }
}

/**
 * The two gates a view needs from an authority read, honestly.
 *
 * `allowed` is permissive while authority is UNCONFIRMED and restrictive only on a definite "no";
 * `unconfirmed` lets the view say so once, in words, instead of implying a verdict it lacks.
 */
export function authorityGate(authority, roleNames = []) {
  if (!authority) return { allowed: false, unconfirmed: false, pending: true, deployed: true }
  const unconfirmed = authority.deployed && !authority.readable
  const held = roleNames.some((r) => authority.roles?.[r])
  return {
    allowed: Boolean(held || unconfirmed),
    unconfirmed,
    pending: false,
    deployed: Boolean(authority.deployed),
  }
}
