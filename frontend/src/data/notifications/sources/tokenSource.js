/**
 * Token-administration activity source (spec 031, FR-028). For tokens the user administers (those they issued
 * via the factory — the enumerable, honest set), it snapshots the user's role surface + the token's paused
 * flag each cycle and emits informational entries on a CHANGE (role granted/revoked to you, paused/unpaused).
 * Pure snapshot-diff (first-sight = baseline). No hooks; read-only provider.
 *
 * Documented + omitted (no backend/subgraph): historical role/pause/mint EVENTS and role grants on tokens the
 * user did NOT issue are not enumerable client-side — only live changes from first-sight onward are detected.
 */
import { isAddress } from 'viem'
import { getPublicClient } from '../../../lib/chains/publicClient'
import { readContract } from '../../../lib/chains/readContract'
import { getContractAddressForChain } from '../../../config/contracts'

const FACTORY_ABI = [
  'function getTokensByIssuer(address issuer) view returns (uint256[])',
  'function getToken(uint256 id) view returns (tuple(uint256 id, uint8 standard, address tokenAddress, address issuer, string name, string symbol, string metadataURI, bool isBurnable, bool isPausable, tuple(address identityRegistry, address compliance, address claimTopicsRegistry, address trustedIssuersRegistry) suite, uint64 createdAt))',
]
const TOKEN_ABI = [
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function PAUSER_ROLE() view returns (bytes32)',
  'function BURNER_ROLE() view returns (bytes32)',
  'function paused() view returns (bool)',
]
const ROLE_NAMES = ['admin', 'minter', 'pauser', 'burner']
const ROLE_LABEL = { admin: 'admin', minter: 'minter', pauser: 'pauser', burner: 'burner' }
const ROLE_GETTER = { admin: 'DEFAULT_ADMIN_ROLE', minter: 'MINTER_ROLE', pauser: 'PAUSER_ROLE', burner: 'BURNER_ROLE' }

/**
 * Read a token's role/pause snapshot. CRITICAL (honest-state): a TRANSIENT read failure must NOT be substituted
 * with a value that looks like a real change — it THROWS so the caller carries the prior snapshot and emits
 * nothing. A v1/Ownable token (no AccessControl) is detected structurally (DEFAULT_ADMIN_ROLE reverts) and
 * returned as `{ v2:false }` — a stable shape that never produces role entries. paused() is only read for
 * pausable tokens (structural), so a non-pausable token doesn't look like a transient failure.
 */
async function readToken(addr, account, chainId, isPausable) {
  const c = (functionName, args) =>
    readContract(chainId, { address: addr, abi: TOKEN_ABI, functionName, args })
  let adminRole
  try {
    adminRole = await c('DEFAULT_ADMIN_ROLE')
  } catch {
    return { v2: false } // v1/Ownable — no role surface to track (stable; never diffs)
  }
  const ids = {
    admin: adminRole,
    minter: await c('MINTER_ROLE'),
    pauser: await c('PAUSER_ROLE'),
    burner: await c('BURNER_ROLE'),
  }
  const roles = {}
  for (const name of ROLE_NAMES) roles[name] = await c('hasRole', [ids[name], account]) // throws on transient failure
  const paused = isPausable ? await c('paused') : null
  return { v2: true, roles, paused }
}

function entriesForChange(refId, sym, prev, next, nowMs) {
  const out = []
  const mk = (type, message, severity) => ({
    id: `token:${refId}:${type}:${nowMs}`, domain: 'token', refId, type, message, severity,
    actionable: false, link: { to: '/wallet', state: { tab: 'tokens', token: refId } }, createdAt: nowMs, read: false,
  })
  for (const name of ROLE_NAMES) {
    if (prev.roles?.[name] === false && next.roles[name] === true) out.push(mk('role-granted', `You were granted the ${ROLE_LABEL[name]} role on ${sym}`, 'info'))
    if (prev.roles?.[name] === true && next.roles[name] === false) out.push(mk('role-revoked', `Your ${ROLE_LABEL[name]} role on ${sym} was revoked`, 'warning'))
  }
  if (prev.paused === false && next.paused === true) out.push(mk('paused', `${sym} was paused`, 'warning'))
  if (prev.paused === true && next.paused === false) out.push(mk('unpaused', `${sym} was unpaused`, 'info'))
  return out
}

export const tokenSource = {
  key: 'token',
  label: 'Token',
  async detect({ account, chainId, nowMs, prior }) {
    const factoryAddr = getContractAddressForChain('tokenFactory', chainId)
    if (!factoryAddr || !isAddress(factoryAddr)) {
      return { ok: true, entries: [], nextSnapshots: {}, currentIds: [], actionNeededById: {} }
    }
    // The seam is the availability gate: no route, no read, and the caller keeps its prior slice.
    if (!getPublicClient(chainId)) return { ok: false }

    let ids = []
    let metaById = {}
    try {
      const factory = (functionName, args) =>
        readContract(chainId, { address: factoryAddr, abi: FACTORY_ABI, functionName, args })
      const tokenIds = await factory('getTokensByIssuer', [account])
      for (const tid of tokenIds) {
        const info = await factory('getToken', [tid])
        const addr = String(info.tokenAddress).toLowerCase()
        ids.push(addr)
        metaById[addr] = { symbol: info.symbol || info.name || 'token', isPausable: !!info.isPausable }
      }
    } catch {
      return { ok: false } // can't enumerate the user's tokens — retain prior slice
    }

    const entries = []
    const nextSnapshots = {}
    const currentIds = []
    for (const addr of ids) {
      currentIds.push(addr)
      let snap
      try {
        snap = await readToken(addr, account, chainId, metaById[addr]?.isPausable)
      } catch {
        // transient read failure — carry the prior snapshot, emit nothing (never fabricate a change)
        if (prior.snapshots?.[addr]) nextSnapshots[addr] = prior.snapshots[addr]
        continue
      }
      const prev = prior.snapshots?.[addr]
      nextSnapshots[addr] = { ...snap, snappedAt: nowMs }
      // Only diff when BOTH prior and next were fully-read v2 snapshots (first-sight + v1 = baseline, no entries).
      if (prev?.v2 && snap.v2) entries.push(...entriesForChange(addr, metaById[addr]?.symbol || 'token', prev, snap, nowMs))
    }

    // Token activity is informational only — no action-needed kind (FR-028).
    return { ok: true, entries, nextSnapshots, currentIds, actionNeededById: {} }
  },
}

export default tokenSource
