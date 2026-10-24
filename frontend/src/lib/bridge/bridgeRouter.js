/**
 * BridgeRouter read + bridge-call layer (spec 067).
 *
 * The Bridge surface reads its on-chain control surface at runtime: which routes are
 * curated, their per-transaction limits, the Across SpokePool in use, and the
 * per-network pause flag (FR-051). When the router is undeployed or unreadable this
 * returns `null` and the caller shows an honest unavailable state
 * (`BRIDGE_UNAVAILABLE.router` in `lib/bridge/bridgeCopy.js`) — availability is
 * withheld, never invented (FR-054). That mirrors `lib/staking/stakingRouter.js`
 * deliberately: same shape, same null-on-failure contract, same "the caller decides
 * the fallback" split.
 *
 * The fee-bearing path is gated separately by `fetchFeeQuote`
 * (`FEE_SERVICES.BRIDGE_TRANSFER`). The rate the member was shown is passed straight
 * back as `maxFeeBps` on submit, so a live rate above it reverts rather than
 * overcharging (FR-028). Never synthesise a `maxFeeBps` here.
 *
 * It also builds the `bridgeWithFee` call as `{ target, data, value }` entries for the
 * spec-041 unified send rail: an ERC-20 route approves the router then calls; a native
 * route has no approve leg and carries `inputAmount` as `value` (Across wraps the
 * native value itself).
 *
 * ---------------------------------------------------------------------------
 * CHAIN IDS. Bitcoin network ids are STRINGS (spec 061) and bridging excludes Bitcoin
 * outright (FR-006). Every entry point here therefore runs `assertEvmChainId` FIRST,
 * so a string id can never reach `getContractAddressForChain` (which would index
 * `NETWORK_CONTRACTS['bitcoin']` and quietly return `undefined`) or wagmi (which would
 * treat it as an unknown chain). The assertion throws rather than returning null on
 * purpose: `null` is this module's honest "unavailable" answer for a *runtime* failure,
 * and a Bitcoin id arriving here is not a runtime failure, it is a caller bug. Surfaces
 * exclude Bitcoin upstream via `isBitcoinNetworkId` / `bridgeUnavailableCopy`.
 * ---------------------------------------------------------------------------
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, zeroAddress } from 'viem'
import { BRIDGE_ROUTER_ABI } from '../../abis/BridgeRouter'
import { getContractAddressForChain } from '../../config/contracts'
import { isBitcoinNetworkId } from '../../config/bitcoinNetworks'
import { readContract, normalizeAbi } from '../chains/readContract'

const ROUTER_ABI = normalizeAbi(BRIDGE_ROUTER_ABI)
const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Assert a chain id is a usable EVM chain id and return it as a number.
 *
 * Strict on purpose — numeric STRINGS are rejected too, matching
 * `lib/assets/networkPin.js#isEvmOption`, so there is exactly one representation of an
 * EVM chain id in the bridge code and no path where `'137'` and `137` behave
 * differently.
 *
 * @param {number} chainId
 * @param {string} [context] Where the bad id came in, for the thrown message.
 * @returns {number}
 */
export function assertEvmChainId(chainId, context = 'bridgeRouter') {
  if (isBitcoinNetworkId(chainId)) {
    throw new Error(`${context}: Bitcoin network "${chainId}" is not an EVM chain and cannot be bridged (FR-006)`)
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`${context}: expected a positive integer EVM chain id, received ${JSON.stringify(chainId)}`)
  }
  return chainId
}

/** True when `chainId` is a usable EVM chain id — the non-throwing form of the assertion. */
export function isEvmChainId(chainId) {
  try {
    assertEvmChainId(chainId)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the router address for a chain, or null when it isn't deployed.
 * Address keys come from the generated config only — never hardcode one.
 * @param {number} chainId
 * @returns {string|null}
 */
export function getBridgeRouterAddress(chainId) {
  assertEvmChainId(chainId, 'getBridgeRouterAddress')
  const addr = getContractAddressForChain('bridgeRouter', chainId)
  return addr && ADDRESS_RE.test(addr) ? addr : null
}

const safe = (p) => p.then((v) => v).catch(() => undefined)

/**
 * Route id, computed exactly as the contract does:
 *
 *   keccak256(abi.encode(inputToken, outputToken, block.chainid, destinationChainId))
 *
 * The origin chain is `block.chainid` on-chain, so it MUST be passed explicitly here —
 * ids are never portable across deployments. `outputToken` is part of the identity:
 * dropping it would collapse two routes that deliver different assets into one id, which
 * is the silent-substitution bug review caught on the contract side. Any change to the
 * field list or order here must be mirrored in
 * `contracts/bridge/BridgeRouter.sol#computeRouteId`.
 *
 * @param {{inputToken: string, outputToken: string, originChainId: number, destinationChainId: number}} args
 * @returns {string} bytes32 hex
 */
export function computeRouteId({ inputToken, outputToken, originChainId, destinationChainId }) {
  assertEvmChainId(originChainId, 'computeRouteId(originChainId)')
  assertEvmChainId(destinationChainId, 'computeRouteId(destinationChainId)')
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
      [inputToken, outputToken, BigInt(originChainId), BigInt(destinationChainId)],
    ),
  )
}

/**
 * Normalize a raw `Route` tuple into plain JS, or null when the struct is zero-filled.
 *
 * `getRoute` on an unknown id does NOT revert — Solidity returns the default-initialised
 * struct — so `inputToken == address(0)` is the only signal that a route does not exist.
 * Treating a zero-filled struct as a real route would offer the member a destination
 * chain of 0 with a native-input flag of false and a limit of "uncapped".
 *
 * @param {string} routeId
 * @param {*} raw ethers Result for the Route tuple
 * @returns {null | {routeId: string, inputToken: string, outputToken: string, destinationChainId: number, maxAmount: bigint, expectedFillSeconds: number, enabled: boolean, nativeInput: boolean}}
 */
export function normalizeRoute(routeId, raw) {
  if (!raw) return null
  const inputToken = raw.inputToken
  if (!inputToken || inputToken === zeroAddress) return null
  return {
    routeId,
    inputToken,
    outputToken: raw.outputToken,
    destinationChainId: Number(raw.destinationChainId),
    maxAmount: BigInt(raw.maxAmount),
    expectedFillSeconds: Number(raw.expectedFillSeconds),
    enabled: Boolean(raw.enabled),
    nativeInput: Boolean(raw.nativeInput),
  }
}

/**
 * Read the router's managed config for a chain: the Across SpokePool + FeeRouter it
 * points at, its own fee ceiling, the pause flag, and every curated route.
 *
 * Returns `null` when no router is deployed OR when the load-bearing `paused()` read
 * fails — an unreadable router means bridging is unavailable on this network, and the
 * caller says so (FR-051/FR-053). One missing optional getter never blanks the whole
 * overlay; a route whose `getRoute` read fails is dropped rather than guessed, and
 * `routesComplete` reports whether the list is whole so a caller never presents a
 * partial list as the full set of destinations.
 *
 * @param {{chainId: number, provider: *}} args
 * @returns {Promise<null | {routerAddress: string, spokePool: *, feeRouter: *, sanctionsGuard: *, bridgeTransferServiceId: *, maxFeeBps: number|null, paused: boolean, routes: Array, routesComplete: boolean}>}
 */
export async function readBridgeRouterConfig({ chainId, provider }) {
  assertEvmChainId(chainId, 'readBridgeRouterConfig')
  const routerAddress = getBridgeRouterAddress(chainId)
  if (!routerAddress || !provider) return null

  // Spec 110 Phase 1: reads go through the chain seam. `provider` stays in the signature as
  // the caller-side availability gate (null still means "do not read") until callers convert.
  const routerRead = (functionName, args) =>
    readContract(chainId, { address: routerAddress, abi: ROUTER_ABI, functionName, args })
  // `paused` is the load-bearing read — if even it fails, treat the router as unreadable
  // and withhold availability (never guess that bridging is open).
  const paused = await safe(routerRead('paused'))
  if (paused === undefined) return null

  const [spokePool, feeRouter, sanctionsGuard, bridgeTransferServiceId, maxFeeBps, count] =
    await Promise.all([
      safe(routerRead('spokePool')),
      safe(routerRead('feeRouter')),
      safe(routerRead('sanctionsGuard')),
      safe(routerRead('bridgeTransferServiceId')),
      safe(routerRead('MAX_FEE_BPS')),
      safe(routerRead('routeCount')),
    ])

  const routes = []
  let routesComplete = count !== undefined
  if (count !== undefined) {
    const n = Number(count)
    const ids = await Promise.all(Array.from({ length: n }, (_, i) => safe(routerRead('routeAt', [BigInt(i)]))))
    const raws = await Promise.all(ids.map((id) => (id ? safe(routerRead('getRoute', [id])) : Promise.resolve(undefined))))
    for (let i = 0; i < n; i += 1) {
      const id = ids[i]
      const raw = raws[i]
      if (!id || raw === undefined) {
        routesComplete = false
        continue
      }
      const route = normalizeRoute(id, raw)
      if (route) routes.push(route)
      // A zero-filled struct at an enumerated id is not an incomplete read — the id is
      // simply no longer a route — so it does not clear `routesComplete`.
    }
  }

  return {
    routerAddress,
    spokePool,
    feeRouter,
    sanctionsGuard,
    bridgeTransferServiceId,
    maxFeeBps: maxFeeBps === undefined ? null : Number(maxFeeBps),
    paused: Boolean(paused),
    routes,
    routesComplete,
  }
}

/**
 * Read one route directly by its (inputToken, outputToken, destinationChainId) identity.
 *
 * Used to re-read a route at submit time, so a route disabled or re-limited between the
 * quote and the signature is caught before the member signs. Returns `null` for both
 * "does not exist" (zero-filled struct) and "could not read" — the caller's honest
 * answer is the same in both cases: this route is not on offer right now.
 *
 * @param {{chainId: number, provider: *, inputToken: string, outputToken: string, destinationChainId: number}} args
 * @returns {Promise<null | object>} normalized route
 */
export async function readBridgeRoute({ chainId, provider, inputToken, outputToken, destinationChainId }) {
  assertEvmChainId(chainId, 'readBridgeRoute')
  assertEvmChainId(destinationChainId, 'readBridgeRoute(destinationChainId)')
  const routerAddress = getBridgeRouterAddress(chainId)
  if (!routerAddress || !provider) return null

  const routeId = computeRouteId({ inputToken, outputToken, originChainId: chainId, destinationChainId })
  const raw = await safe(
    readContract(chainId, { address: routerAddress, abi: ROUTER_ABI, functionName: 'getRoute', args: [routeId] }),
  )
  if (raw === undefined) return null
  return normalizeRoute(routeId, raw)
}

/**
 * Find an already-read route in a config's list. Pure — no RPC — so the selector can
 * filter destinations from one `readBridgeRouterConfig` snapshot.
 *
 * Matches on the full identity (input asset, delivered asset, destination chain);
 * addresses are compared case-insensitively because checksum casing varies by source.
 *
 * @param {Array} routes
 * @param {{inputToken: string, outputToken: string, destinationChainId: number}} match
 * @returns {object|null}
 */
export function findRoute(routes, { inputToken, outputToken, destinationChainId }) {
  if (!Array.isArray(routes)) return null
  const a = String(inputToken || '').toLowerCase()
  const b = String(outputToken || '').toLowerCase()
  return (
    routes.find(
      (r) =>
        String(r.inputToken).toLowerCase() === a &&
        String(r.outputToken).toLowerCase() === b &&
        Number(r.destinationChainId) === Number(destinationChainId),
    ) || null
  )
}

/**
 * Build the `bridgeWithFee` call(s) for the unified send rail.
 *
 * ERC-20 route: approve the router for `inputAmount`, then call with `value: 0n` — the
 * contract rejects native value on an ERC-20 route outright (`UnexpectedNativeValue`).
 * Native route: no approve leg, `value: inputAmount` — Across wraps it itself, which is
 * why the route still names the WRAPPED token as `inputToken`.
 *
 * `maxFeeBps` MUST be the rate the member was shown on the quote (FR-028). It is a
 * required argument with no default precisely so a caller cannot omit it and silently
 * consent to any rate.
 *
 * @param {{routerAddress: string, route: object, inputAmount: bigint, outputAmount: bigint, recipient: string, quoteTimestamp: number, fillDeadline: number, exclusivityDeadline?: number, exclusiveRelayer?: string, maxFeeBps: number}} args
 * @returns {{calls: Array<{target: string, data: string, value: bigint}>, requiresApproval: boolean}}
 */
export function buildBridgeCalls({
  routerAddress,
  route,
  inputAmount,
  outputAmount,
  recipient,
  quoteTimestamp,
  fillDeadline,
  exclusivityDeadline = 0,
  exclusiveRelayer = zeroAddress,
  maxFeeBps,
}) {
  if (!routerAddress) throw new Error('buildBridgeCalls: routerAddress is required')
  if (!route?.routeId) throw new Error('buildBridgeCalls: a route read from the router is required')
  // A disabled route reverts on-chain (`RouteDisabled`). Refusing to build the calldata
  // keeps the member from signing a transaction that cannot succeed.
  if (!route.enabled) throw new Error('buildBridgeCalls: route is disabled')
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) {
    throw new Error('buildBridgeCalls: maxFeeBps must be the quoted rate in basis points (FR-028)')
  }

  const amount = BigInt(inputAmount)
  const bridgeCall = {
    target: routerAddress,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'bridgeWithFee',
      args: [
        route.routeId,
        amount,
        BigInt(outputAmount),
        recipient,
        BigInt(quoteTimestamp),
        BigInt(fillDeadline),
        BigInt(exclusivityDeadline),
        exclusiveRelayer,
        BigInt(maxFeeBps),
      ],
    }),
    value: route.nativeInput ? amount : 0n,
  }

  if (route.nativeInput) {
    return { calls: [bridgeCall], requiresApproval: false }
  }
  return {
    calls: [
      {
        target: route.inputToken,
        data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [routerAddress, amount] }),
        value: 0n,
      },
      bridgeCall,
    ],
    requiresApproval: true,
  }
}
