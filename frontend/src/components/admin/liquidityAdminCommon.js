/**
 * Shared helpers behind the two spec-067 operator control surfaces — the Bridge tab and the
 * Supply tab (US4, FR-040…FR-052). The cards they render live in `liquidityAdminCards.jsx`.
 *
 * The two tabs drive two different routers, but several things about them are identical, and
 * each is an HONESTY rule rather than a convenience. They live here so the two tabs cannot
 * drift apart on any of them:
 *
 *   1. **Scope is a NETWORK, not the wallet's network.** Control state is per-network (FR-050)
 *      and there are five of them. Gating an admin surface on the connected chain hides four
 *      fifths of the control state from an operator who is simply connected somewhere else. So
 *      reads span every capable network via that network's own RPC (`readProviderFor`), and
 *      only WRITES require the wallet to be there — the same split ClearPath already uses.
 *
 *   2. **A number is shown in units we can prove.** `tokenMeta` resolves a symbol and decimals
 *      only for tokens this build actually configures; everything else renders in RAW UNITS and
 *      says so. A mis-scaled limit is a silent, member-facing failure (a cap of 1 wei refuses
 *      every transfer), so `parseLimit` refuses rather than guessing a scale.
 *
 *   3. **`0` is not one thing.** A LIMIT of 0 is "uncapped"; an AMOUNT of 0 is zero. They get
 *      separate formatters precisely so a column of member transfer sizes can never print
 *      "uncapped".
 *
 *   4. **An unreadable read is never a zero.** `loadRouterHistory` distinguishes "no events" from
 *      "this RPC would not answer", because those are different statements to an operator
 *      auditing a control surface (FR-046).
 *
 *   5. **Authority is read from the router in scope, never inferred.** `readRouterAuthority` asks
 *      the specific router on the specific network whether THIS account holds the role — see its
 *      own doc-comment for why the app-wide role flags cannot answer that question.
 */
import { keccak256, stringToHex, zeroAddress, zeroHash } from 'viem'
import { isAddress } from '../../lib/evm/address'
import { formatUnits, parseUnits } from '../../lib/evm/units'
import { readContract } from '../../lib/chains/readContract'
import { eventScanHandle } from '../../lib/chains/eventScan'
import { getLogsRange } from '../../lib/chains/logRange'
import { getPublicClient } from '../../lib/chains/publicClient'

/** keccak256 over a role name's UTF-8 bytes — byte-identical to ethers v6 `id()`. */
const roleId = (name) => keccak256(stringToHex(name))
import { NETWORKS, listSupportedChainIds } from '../../config/networks'
import { networkName as estateNetworkName, readProviderFor as estateReadProviderFor } from '../../lib/chains/estate'

// Spec 071: the generic halves of this module now live in `lib/chains/estate.js`, because
// non-component callers (role sync, purchase preflight) need them too. They are re-exported
// here so this module stays the one import site for the Bridge and Supply tabs.
//
// `readProviderFor` gained a fix in the move: it used to build a provider straight from
// `NETWORKS[chainId].rpcUrl`, which bypassed `resolveRpcEndpoints` and so ignored the member's
// configured endpoint and failover for every read these two tabs make (a live spec-069
// violation). It now resolves through `getReadProvider`. Behaviour these tabs depend on —
// reuse the wallet provider for the connected chain, null for a chain with no endpoint — is
// unchanged.

/** How far back the history/ops event scans look. Bounded — public RPCs refuse open ranges. */
export const HISTORY_LOOKBACK_BLOCKS = 200_000
/** Most rows either table renders. The explorer link carries the rest. */
export const HISTORY_LIMIT = 25

export function shortAddr(a) {
  return a && a !== zeroAddress ? `${a.substring(0, 6)}...${a.substring(a.length - 4)}` : ''
}

/**
 * A settable address must be a real, non-zero address — the routers reject `ZeroAddress`.
 *
 * `isAddress` comes from the address SEAM, not from viem directly (spec 110 divergence d). viem's
 * own `isAddress` defaults to `strict: true`, which REFUSES an ALL-UPPERCASE address — and an
 * all-uppercase address carries no EIP-55 checksum information, so there is nothing to verify and
 * it is perfectly valid. An operator pasting one from a tool that upper-cases hex was told their
 * token address was not an address. The seam reproduces ethers' rule: no checksum in the casing ⇒
 * accept; mixed case ⇒ it must verify.
 *
 * The other half of that pair lives at the ENCODERS — see divergence 16. viem's
 * `encodeFunctionData` refuses the same uppercase address this now accepts, so every caller
 * normalises through `getAddress` before encoding.
 */
export const isValidAddr = (a) => isAddress(a) && a !== zeroAddress

/** Display name for a chain, or an honest placeholder — never a guessed one. */
export const networkName = estateNetworkName

/**
 * Every supported network carrying the capability a tab controls, mainnets first.
 *
 * Derived from config, not asserted, so the roster stays true as deployments land: a network
 * appears here because it has the PROTOCOL (an Across SpokePool / a Uniswap position manager),
 * and whether FairWins has deployed a router there is a separate question the tab answers
 * per-network. Listing only deployed networks would hide the ones an operator most needs to
 * see — the ones still waiting for a deployment.
 *
 * ── DELIBERATELY *NOT* COHORT-BOUNDED (spec 071) ────────────────────────────────────────────
 * Spec 071's `estateNetworks()` narrows a roster to the build's environment cohort, and every
 * NEW estate read uses it. This one does not, and must not: the spec-067 routers exist only on
 * mainnets (1/10/137/8453/42161 for Uniswap, plus Ethereum-only Across LP), so cohort-bounding
 * it would return an EMPTY roster in a testnet build and blank both tabs. The cross-cohort
 * roster here is pre-existing spec-067 behaviour that spec 071 does not change; see the note in
 * specs/071-multi-chain-admin-console/research.md (R10) for why that is being tracked as an
 * open question rather than settled silently in this change.
 *
 * #1265 moved the four MEMBER-facing spec-067 rosters onto `cohortChainIds()` and revisited this
 * one deliberately. It stays as it is, and the two are not the same question: those rosters
 * decide what a MEMBER is shown and which routers get read on their behalf, while this one is an
 * operator's deployment map, read behind an admin gate through the `requireCohort: false` provider
 * below. Cohort-bounding it would blank both tabs in a testnet build — the operator would lose the
 * view precisely where a deployment is missing. If that ever changes, the roster must stay
 * capability-derived (undeployed networks included), or the tabs stop showing what needs doing.
 *
 * @param {'bridge'|'liquidity'} capability
 */
export function adminNetworks(capability) {
  return listSupportedChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net?.capabilities?.[capability])
    .sort((a, b) => Number(a.isTestnet) - Number(b.isTestnet))
}

/**
 * A read connection for `chainId`. See `lib/chains/estate.js`.
 *
 * NOTE: this module's roster (`adminNetworks`) may name a chain outside the build's cohort, and
 * `estateReadProviderFor` refuses those — which is correct for cohort-bounded estate reads but
 * would blank these two tabs. So the cohort check is bypassed here, preserving spec-067
 * behaviour exactly, while still routing through the fixed provider resolution.
 */
export function readProviderFor(chainId, walletChainId, walletProvider) {
  return estateReadProviderFor(chainId, walletChainId, walletProvider, { requireCohort: false })
}

/** Minimal AccessControl surface — every spec-067 router exposes it via UUPSManaged. */
const ACCESS_CONTROL_ABI = ['function hasRole(bytes32 role, address account) view returns (bool)']

/** The three roles that gate a control on these two tabs, by their on-chain hashes. */
export const ROUTER_ROLE_HASHES = {
  // DEFAULT_ADMIN_ROLE is bytes32(0), not a keccak of a name.
  admin: zeroHash,
  guardian: roleId('GUARDIAN_ROLE'),
  liquidityAdmin: roleId('LIQUIDITY_ADMIN_ROLE'),
}

/**
 * Does `account` hold admin / guardian / liquidity-admin on THIS router, on THIS network?
 *
 * ── WHY THE APP-WIDE ROLE FLAGS CANNOT ANSWER THIS ──────────────────────────────────────────────
 * `useRoles()`'s `isAdmin` / `isGuardian` / `isLiquidityAdmin` are a single boolean each, resolved
 * against a candidate list on the WALLET's connected chain. Three separate things break here:
 *
 *   • `isGuardian` means "holds GUARDIAN_ROLE on the WagerRegistry" — a different contract. The
 *     routers check GUARDIAN_ROLE on their own AccessControl instance, and the two sets are
 *     unrelated. An operator with the wager guardianship would be shown an enabled killswitch that
 *     reverts, which is precisely the belief FR-043/FR-044 exist to prevent.
 *   • `isLiquidityAdmin` is an OR across the BridgeRouter and the LiquidityRouter, while the role is
 *     granted per router on purpose (the Roles tab offers them as two separate targets). The OR
 *     showed an operator holding it on one router every write control on the other.
 *   • all of them read the wallet's chain, while these tabs scope to a NETWORK the operator picks.
 *     A Polygon guardian whose wallet sits on Ethereum lost the Polygon controls.
 *
 * So authority is asked of the contract that will enforce it. The role flags remain what they are
 * good for — deciding whether the tab appears at all.
 *
 * ── AND WHY AN UNREADABLE ANSWER IS NOT A DENIAL ────────────────────────────────────────────────
 * `readable: false` means the question could not be put, not that the answer was no. Callers must
 * keep offering the controls in that state and say the authority is unconfirmed: the contract is the
 * real gate and will refuse anything the operator does not hold, whereas withdrawing the killswitch
 * because an RPC timed out is the FR-044 failure — an operator who does hold it concludes there
 * isn't one. `deployed: false` IS a definite answer: there is no router here to hold a role on.
 *
 * @returns {Promise<{readable: boolean, deployed: boolean, admin: boolean, guardian: boolean,
 *                    liquidityAdmin: boolean, reason: string|null}>}
 */
export async function readRouterAuthority({ chainId, provider, routerAddress, account }) {
  const none = { admin: false, guardian: false, liquidityAdmin: false, reason: null }
  if (!routerAddress) return { ...none, readable: true, deployed: false }
  // `provider` stays the availability gate — these tabs resolve it through `readProviderFor`,
  // which is also where the spec-067 cohort opt-out lives, so the gate must keep deciding.
  if (!provider || !account || chainId == null) {
    return {
      ...none,
      readable: false,
      deployed: true,
      reason: !account ? 'no account connected' : 'no read connection to this network',
    }
  }
  try {
    const hasRole = (role) =>
      readContract(chainId, {
        address: routerAddress,
        abi: ACCESS_CONTROL_ABI,
        functionName: 'hasRole',
        args: [role, account],
      })
    const [admin, guardian, liquidityAdmin] = await Promise.all([
      hasRole(ROUTER_ROLE_HASHES.admin),
      hasRole(ROUTER_ROLE_HASHES.guardian),
      hasRole(ROUTER_ROLE_HASHES.liquidityAdmin),
    ])
    return {
      readable: true,
      deployed: true,
      admin: Boolean(admin),
      guardian: Boolean(guardian),
      liquidityAdmin: Boolean(liquidityAdmin),
      reason: null,
    }
  } catch (e) {
    return { ...none, readable: false, deployed: true, reason: e?.message || String(e) }
  }
}

/**
 * Turn an authority read into the two gates a tab needs, honestly.
 *
 * `pause` and `config` are permissive while authority is UNCONFIRMED (see `readRouterAuthority`) and
 * restrictive only on a definite "no". `unconfirmed` lets the caller say so once, in words, instead
 * of implying a verdict it does not have.
 */
export function authorityGates(authority) {
  if (!authority) return { pause: false, config: false, unconfirmed: false, pending: true }
  const unconfirmed = authority.deployed && !authority.readable
  return {
    pause: Boolean(authority.admin || authority.guardian || unconfirmed),
    config: Boolean(authority.admin || authority.liquidityAdmin || unconfirmed),
    unconfirmed,
    pending: false,
  }
}

/**
 * Symbol + decimals for a token this build actually knows on this network, or null.
 *
 * Deliberately config-only (the network's stablecoin and its wrapped native) rather than an
 * on-chain `symbol()`/`decimals()` read: an admin table that has to make two RPC calls per
 * token before it can render a limit is a table that shows nothing when one RPC is slow. An
 * unknown token is not a failure — it renders in RAW UNITS and SAYS it is raw units, which is
 * the honest reading of a number whose scale we cannot confirm.
 */
export function tokenMeta(chainId, address) {
  const net = NETWORKS[chainId]
  if (!net || !address) return null
  const a = String(address).toLowerCase()
  const stable = net.stablecoin
  if (stable?.address && String(stable.address).toLowerCase() === a) {
    return { symbol: stable.symbol, decimals: Number(stable.decimals) }
  }
  const wnative = net.dex?.wnative
  if (wnative && String(wnative).toLowerCase() === a) {
    return { symbol: `W${net.nativeCurrency?.symbol || ''}`, decimals: 18 }
  }
  return null
}

/** `"USDC"` for a token this build knows, else its short address — never a made-up ticker. */
export function tokenLabel(chainId, address) {
  if (!address || address === zeroAddress) return '—'
  return tokenMeta(chainId, address)?.symbol || shortAddr(address)
}

/**
 * A limit rendered for operators. `0` is UNCAPPED on both routers, and saying so in words
 * matters more here than anywhere else: "0" in a max-amount column reads as "nothing may pass".
 */
export function formatLimit(chainId, address, raw) {
  const value = BigInt(raw ?? 0n)
  if (value === 0n) return 'uncapped'
  const meta = tokenMeta(chainId, address)
  if (!meta) return `${value} (raw units)`
  return `${formatUnits(value, meta.decimals)} ${meta.symbol}`
}

/**
 * An AMOUNT rendered for operators — deliberately separate from `formatLimit`, because `0`
 * means opposite things in the two places. A limit of 0 is "uncapped"; an amount of 0 is zero.
 * Reusing one formatter for both would print "uncapped" in a column of member transfer sizes.
 */
export function formatAmount(chainId, address, raw) {
  const value = BigInt(raw ?? 0n)
  const meta = tokenMeta(chainId, address)
  if (!meta) return `${value} (raw units)`
  return `${formatUnits(value, meta.decimals)} ${meta.symbol}`
}

/** The unit an operator is typing a limit in, so the input can label itself honestly. */
export function limitUnitLabel(chainId, address) {
  return tokenMeta(chainId, address)?.symbol || 'raw units'
}

/**
 * Parse an operator-typed limit into the integer the contract takes.
 *
 * Throws with a readable reason rather than returning a wrong number: a mis-scaled limit is a
 * silent, member-facing failure (a cap of 1 wei refuses every transfer), so it is rejected
 * BEFORE the wallet prompt. `0` is accepted and means uncapped, matching the contract.
 */
export function parseLimit(chainId, address, text) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new Error('Enter a limit — 0 means uncapped.')
  const meta = tokenMeta(chainId, address)
  if (!meta) {
    if (!/^\d+$/.test(raw)) {
      throw new Error('This token’s decimals are unknown here, so the limit must be typed in whole raw units (digits only).')
    }
    return BigInt(raw)
  }
  try {
    return parseUnits(raw, meta.decimals)
  } catch {
    throw new Error(`Enter an amount in ${meta.symbol} (up to ${meta.decimals} decimal places).`)
  }
}

/** `1h 30m` / `45s` — the expected-fill window, in the units an operator thinks in. */
export function formatDuration(seconds) {
  const s = Number(seconds || 0)
  if (!Number.isFinite(s) || s <= 0) return '—'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

const safe = (p) => p.then((v) => v).catch(() => undefined)

/**
 * Read a router's decoded change history: what changed, on what, before → after, by whom, when.
 *
 * Never throws. A bounded RPC that refuses the range yields `{ entries: [], error }` and the
 * card says "this RPC bounds event lookups" instead of "no changes" — those are very different
 * statements to an operator auditing a control surface (FR-046).
 *
 * The chain is an ARGUMENT (spec 110): it used to arrive inside an ethers `Contract`'s runner,
 * which is why a caller could not be asked which chain it had scanned. `provider` stays as the
 * AVAILABILITY GATE — `readProviderFor` here passes `requireCohort: false` on purpose, so its null
 * means the chain has no endpoint at all.
 *
 * The scan BISECTS on refusal rather than asking for 200,000 blocks in one `eth_getLogs`: public
 * RPCs cap that at ~10,000, and a refusal used to land in the catch below and render as "this RPC
 * bounds event lookups" on every one of them.
 *
 * @param {{chainId: number, address: string, abi: Array, provider: object,
 *          eventNames: string[], describe: Function}} args
 * @returns {Promise<{entries: Array|null, error: string|null}>}
 */
export async function loadRouterHistory({ chainId, address, abi, provider, eventNames, describe }) {
  if (!address || !provider || chainId == null) return { entries: [], error: 'no read connection' }
  try {
    const handle = eventScanHandle(chainId, { address, abi })
    const client = getPublicClient(chainId)
    if (!handle || !client) return { entries: [], error: 'no read connection' }
    const latest = Number(await handle.provider.getBlockNumber())
    const fromBlock = Math.max(0, latest - HISTORY_LOOKBACK_BLOCKS)
    const all = []
    for (const name of eventNames) {
      const logs = await safe(
        getLogsRange(
          handle.provider,
          address,
          fromBlock,
          latest,
          2000,
          handle.filters[name]().getTopicFilter(),
        ),
      )
      for (const log of logs || []) {
        // A log this ABI cannot decode is SKIPPED, not rendered blank: it would otherwise become a
        // history row with no action and no actor, which reads as a change nobody can account for.
        const parsed = await safe(Promise.resolve().then(() => handle.interface.parseLog(log)))
        if (parsed) all.push({ name, log, args: parsed.args || {} })
      }
    }
    all.sort((a, b) => b.log.blockNumber - a.log.blockNumber || b.log.index - a.log.index)
    const entries = await Promise.all(
      all.slice(0, HISTORY_LIMIT).map(async ({ name, log, args }) => {
        const block = await safe(client.getBlock({ blockNumber: BigInt(log.blockNumber) }))
        const described = describe(name, args) || {}
        return {
          key: `${log.transactionHash}-${log.index}`,
          name,
          action: described.action || name,
          target: described.target || '—',
          before: described.before ?? '—',
          after: described.after ?? '—',
          // `actor` on every config event; OZ's Paused/Unpaused name it `account`.
          actor: args?.actor || args?.account || null,
          at: block ? new Date(Number(block.timestamp) * 1000) : null,
          txHash: log.transactionHash,
        }
      }),
    )
    return { entries, error: null }
  } catch (e) {
    return { entries: [], error: e?.message || String(e) }
  }
}
