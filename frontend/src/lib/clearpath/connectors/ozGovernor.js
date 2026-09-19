import { ethers } from 'ethers'
import { getLogsRange as scanLogsBisecting } from '../../chains/logRange'
import {
  GOVERNOR_READ_ABI,
  VOTING_TOKEN_READ_ABI,
  ERC20_BALANCE_ABI,
  GOVERNOR_PROPOSAL_ABI,
  GOVERNOR_WRITE_ABI,
} from '../../../abis/externalDAORegistry'

/**
 * Per-DAO extra treasury vaults that are NOT the OZ timelock. Some platforms (Olympia) hold funds in a separate
 * vault contract; the generic Governor connector can't infer it, so known vaults are overlaid here by
 * (chainId → governor-address-lowercased). Keep this small + verified — never guess an address.
 */
const EXTRA_TREASURIES = {
  63: {
    // Olympia DAO on Mordor — OlympiaTreasury (basefee vault), separate from the Governor's TimelockController.
    '0xb85dbc899472756470ef4033b9637ff8fa2fd23d': [
      { label: 'Olympia Treasury', address: '0x035b2e3c189B772e52F4C3DA6c45c84A3bB871bf' },
    ],
  },
}

/** Known extra (non-timelock) treasury vaults for a DAO, or [] if none. */
export function extraTreasuries(chainId, governorAddr) {
  const byChain = EXTRA_TREASURIES[Number(chainId)] || {}
  return byChain[String(governorAddr).toLowerCase()] || []
}

// Spec 030 (US3/US5) — the ClearPath connector for OpenZeppelin Governor DAOs. Reads any external (or native)
// Governor via the standard IGovernor ABI, so the same surface serves Olympia and any Governor-based DAO. All
// reads are real on-chain calls; nothing is fabricated. ClearPath holds no authority — management actions (a
// later step) are constructed here for the user to sign against the DAO's own contract.

/**
 * Pre-validate (client-side) that `address` looks like a Governor — mirrors the on-chain `_isGovernor` check the
 * registry enforces, so the UI can give fast feedback before the user pays for a register tx. The contract is
 * the source of truth. Returns `{ ok, name, reason }`.
 */
export async function validateGovernor(reader, address) {
  if (!reader) return { ok: false, reason: 'No provider available.' }
  if (!ethers.isAddress(address)) return { ok: false, reason: 'Not a valid address.' }
  const code = await reader.getCode(address)
  if (!code || code === '0x') return { ok: false, reason: 'No contract at this address (looks like a wallet).' }
  const gov = new ethers.Contract(address, GOVERNOR_READ_ABI, reader)
  // A real Governor answers these standard views; a random contract reverts.
  try {
    const mode = await gov.COUNTING_MODE()
    await gov.votingPeriod()
    let name = ''
    try { name = await gov.name() } catch { name = '' }
    if (!mode || mode.length === 0) return { ok: false, reason: 'Not a recognized governance contract.' }
    return { ok: true, name, reason: '' }
  } catch {
    return { ok: false, reason: 'Not a recognized governance contract (no IGovernor interface).' }
  }
}

/**
 * Read a Governor's live summary for the tracking view. Each field is read independently and degrades to null on
 * a missing/optional method (e.g. a Governor without a timelock), so a non-standard Governor still renders
 * truthfully rather than failing wholesale.
 */
export async function readGovernorSummary(reader, address) {
  const gov = new ethers.Contract(address, GOVERNOR_READ_ABI, reader)
  const safe = async (p) => { try { return await p } catch { return null } }

  const [name, tokenAddr, timelock, votingDelay, votingPeriod, proposalThreshold, countingMode, clockMode] =
    await Promise.all([
      safe(gov.name()),
      safe(gov.token()),
      safe(gov.timelock()),
      safe(gov.votingDelay()),
      safe(gov.votingPeriod()),
      safe(gov.proposalThreshold()),
      safe(gov.COUNTING_MODE()),
      safe(gov.CLOCK_MODE()),
    ])

  let tokenName = null
  let tokenSymbol = null
  if (tokenAddr && ethers.isAddress(tokenAddr) && tokenAddr !== ethers.ZeroAddress) {
    const t = new ethers.Contract(tokenAddr, VOTING_TOKEN_READ_ABI, reader)
    tokenName = await safe(t.name())
    tokenSymbol = await safe(t.symbol())
  }

  // Treasury = the timelock's native balance (the OZ Governor pattern: the timelock holds + executes funds).
  let treasuryNative = null
  if (timelock && ethers.isAddress(timelock) && timelock !== ethers.ZeroAddress) {
    treasuryNative = await safe(reader.getBalance(timelock))
  }

  return {
    name,
    tokenAddr,
    tokenName,
    tokenSymbol,
    timelock,
    treasuryNative,
    votingDelay: votingDelay != null ? votingDelay.toString() : null,
    votingPeriod: votingPeriod != null ? votingPeriod.toString() : null,
    proposalThreshold: proposalThreshold != null ? proposalThreshold.toString() : null,
    countingMode,
    clockMode,
  }
}

/**
 * Read native + USDC balances for a DAO's treasury vault(s) — the Governor's timelock plus any known extra vault
 * (e.g. OlympiaTreasury). Real on-chain reads; each balance degrades to null independently.
 */
export async function readTreasuries(reader, vaults, usdcAddr) {
  const safe = async (p) => { try { return await p } catch { return null } }
  let usdcDecimals = 6
  let usdcSymbol = 'USDC'
  let usdc = null
  if (usdcAddr && ethers.isAddress(usdcAddr)) {
    usdc = new ethers.Contract(usdcAddr, ERC20_BALANCE_ABI, reader)
    const d = await safe(usdc.decimals())
    if (d != null) usdcDecimals = Number(d)
    const s = await safe(usdc.symbol())
    if (s) usdcSymbol = s
  }
  return Promise.all(
    vaults.map(async (v) => {
      const native = await safe(reader.getBalance(v.address))
      const usdcBal = usdc ? await safe(usdc.balanceOf(v.address)) : null
      return {
        label: v.label,
        address: v.address,
        native,
        usdc: usdcBal,
        usdcSymbol,
        usdcDecimals,
      }
    })
  )
}

const PROPOSAL_CREATED_TOPIC = ethers.id(
  'ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)'
)
const PROPOSAL_IFACE = new ethers.Interface(GOVERNOR_PROPOSAL_ABI)

/**
 * Decode a `ProposalCreated` log into a plain proposal object (without the live state/votes enrichment).
 *
 * Uses POSITIONAL destructuring, never named field access: the event's 4th argument is literally named
 * `values`, which on an ethers v6 `Result` shadows `Array.prototype.values` (a function) — so `args.values`
 * returns that function and `args.values.map(...)` throws "values.map is not a function". Positional access
 * sidesteps that (and any other reserved-name collision). Exported for unit testing. Throws if the log is not
 * a parseable `ProposalCreated`.
 */
export function parseProposalLog(log) {
  const parsed = PROPOSAL_IFACE.parseLog(log)
  // order: proposalId, proposer, targets, values, signatures, calldatas, voteStart, voteEnd, description
  const [id, proposer, targets, values, , calldatas, voteStart, voteEnd, description] = parsed.args
  return {
    id: id.toString(),
    proposer,
    description,
    targets: Array.from(targets),
    values: Array.from(values, (v) => v.toString()),
    calldatas: Array.from(calldatas),
    descriptionHash: ethers.id(description),
    voteStart: voteStart.toString(),
    voteEnd: voteEnd.toString(),
  }
}

/**
 * `eth_getLogs` over [from, to] that is resilient to RPC block-range caps. Public ETC/Mordor nodes (and many
 * wallet RPC backends) reject a `getLogs` window wider than some provider-specific limit. On any failure we
 * bisect the range and retry each half, down to `minSpan` blocks — so a single oversized chunk degrades to a
 * few smaller requests instead of losing the whole scan. Throws only if even a `minSpan`-wide window is
 * rejected, letting the caller decide partial-vs-fail. Exported for unit testing.
 */
export async function getLogsRange(reader, governor, from, to, minSpan = 2000, topics = [PROPOSAL_CREATED_TOPIC]) {
  return scanLogsBisecting(reader, governor, from, to, minSpan, topics)
}

const TREASURY_VAULT_ABI = ['function executor() view returns (address)']
const TREASURY_EXECUTOR_ABI = [
  'function treasury() view returns (address)',
  'function timelock() view returns (address)',
]

/**
 * Detect whether a treasury vault is governable through an on-chain executor — the ECIP-1112/1113 pattern used
 * by Olympia and the network treasuries, where funds live in an immutable vault spent via
 * `Governor → Timelock → Executor → Treasury.withdraw`, NOT held by the timelock directly.
 *
 * Verified on-chain, never guessed: the vault must expose `executor()`, and that executor's `treasury()` /
 * `timelock()` must round-trip back to THIS vault and the Governor's own timelock. Returns `{ executor }` for the
 * executor-gated pattern, or null for the plain "timelock holds the funds" pattern (a generic OZ Governor).
 */
export async function detectTreasuryFunding(reader, vault, governorTimelock) {
  try {
    if (!reader || !ethers.isAddress(vault || '') || !ethers.isAddress(governorTimelock || '')) return null
    const executor = await new ethers.Contract(vault, TREASURY_VAULT_ABI, reader).executor()
    if (!ethers.isAddress(executor) || executor === ethers.ZeroAddress) return null
    const ex = new ethers.Contract(executor, TREASURY_EXECUTOR_ABI, reader)
    const [exTreasury, exTimelock] = await Promise.all([ex.treasury(), ex.timelock()])
    const wired =
      exTreasury.toLowerCase() === vault.toLowerCase() &&
      exTimelock.toLowerCase() === governorTimelock.toLowerCase()
    return wired ? { executor } : null
  } catch {
    return null
  }
}

const VOTE_CAST_TOPIC = ethers.id('VoteCast(address,uint256,uint8,uint256,string)')
const VOTE_CAST_IFACE = new ethers.Interface([
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
])

/**
 * Per-user voting state for one proposal, for the member-facing view: whether they've voted, their voting power
 * at the proposal snapshot, and (if they voted) HOW. Standard OZ IGovernor reads with honest degradation — a
 * Governor missing a given view yields `null` for that field (never a fabricated value); `account` null ⇒ all
 * null. Exported for unit testing.
 */
export async function readVoterState(reader, governor, proposal, account) {
  if (!account || !reader) return { hasVoted: null, votingPower: null, support: null }
  const gov = new ethers.Contract(governor, GOVERNOR_READ_ABI, reader)
  const safe = async (p) => { try { return await p } catch { return null } }
  const hasVoted = await safe(gov.hasVoted(proposal.id, account))
  // Voting power is measured at the snapshot (voteStart, in the Governor's clock units).
  const power = proposal.voteStart != null ? await safe(gov.getVotes(account, proposal.voteStart)) : null
  let support = null
  if (hasVoted) support = await readVoteSupport(reader, governor, proposal, account)
  return {
    hasVoted: hasVoted == null ? null : Boolean(hasVoted),
    votingPower: power == null ? null : power.toString(),
    support,
  }
}

/**
 * Recover HOW `account` voted by scanning the proposal's `VoteCast` events (voter is indexed; proposalId is not,
 * so filter client-side), bounded to the voting window via the adaptive range scanner. Returns the support
 * value (0 Against / 1 For / 2 Abstain) or null if not found / unreadable (honest degradation).
 */
export async function readVoteSupport(reader, governor, proposal, account) {
  try {
    const from = Number(proposal.voteStart)
    const to = Number(proposal.voteEnd)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
    const voterTopic = ethers.zeroPadValue(ethers.getAddress(account), 32)
    const logs = await getLogsRange(reader, governor, from, to, 2000, [VOTE_CAST_TOPIC, voterTopic])
    for (const log of logs) {
      let parsed
      try { parsed = VOTE_CAST_IFACE.parseLog(log) } catch { continue }
      if (parsed.args.proposalId.toString() === proposal.id) return Number(parsed.args.support)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Limited LIVE on-chain indexing for chains without a subgraph (Mordor/ETC): a bounded, chunked `eth_getLogs`
 * scan of the Governor's `ProposalCreated` events, newest-first, enriched with live `state` + `proposalVotes`.
 * Resilient: if the RPC rejects a chunk it stops and returns what it has (marked `partial`) rather than failing
 * wholesale; only a first-chunk failure yields `{ ok: false }`. Never fabricates — returns exactly what chain has.
 */
export async function fetchGovernorProposals(reader, governor, { lookbackBlocks = 500000, chunk = 50000, max = 50 } = {}) {
  if (!reader) return { ok: false, error: 'No provider.', proposals: [] }
  let current
  try {
    current = await reader.getBlockNumber()
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not read block number.', proposals: [] }
  }
  const floor = Math.max(0, current - lookbackBlocks)
  const govRead = new ethers.Contract(governor, [...GOVERNOR_READ_ABI, ...GOVERNOR_PROPOSAL_ABI], reader)
  const raw = []
  let scannedFrom = current
  let partial = false
  let firstChunk = true
  for (let to = current; to >= floor; to -= chunk) {
    const from = Math.max(floor, to - chunk + 1)
    try {
      const logs = await getLogsRange(reader, governor, from, to)
      raw.push(...logs)
      scannedFrom = from
      firstChunk = false
    } catch (e) {
      if (firstChunk) return { ok: false, error: e?.shortMessage || e?.message || 'RPC rejected getLogs.', proposals: [] }
      partial = true
      break
    }
    if (raw.length >= max) { partial = true; break }
  }

  // newest first, enrich with live state + votes
  raw.reverse()
  const proposals = []
  for (const log of raw.slice(0, max)) {
    // Decode is fault-isolated per proposal: a single un-parseable/odd log is skipped, never aborting the
    // whole scan (which previously hid every proposal behind one decode error).
    let base
    try { base = parseProposalLog(log) } catch { continue }
    const state = await (async () => { try { return Number(await govRead.state(base.id)) } catch { return null } })()
    const votes = await (async () => {
      try {
        const [against, forV, abstain] = await govRead.proposalVotes(base.id)
        return { against: against.toString(), for: forV.toString(), abstain: abstain.toString() }
      } catch { return null }
    })()
    proposals.push({ ...base, state, votes })
  }
  return { ok: true, proposals, scannedFrom, scannedTo: current, partial }
}

/**
 * The timelock execution ETA for a queued proposal (unix seconds), or null if unavailable / not queued. A
 * queued OZ-Governor proposal can only be executed once `block.timestamp >= eta`; executing earlier reverts
 * with the timelock's `TimelockUnexpectedOperationState` custom error.
 */
export async function readProposalEta(reader, governor, proposalId) {
  try {
    const gov = new ethers.Contract(governor, GOVERNOR_READ_ABI, reader)
    const eta = await gov.proposalEta(proposalId)
    const n = Number(eta)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// Custom-error selectors the frontend ABI doesn't carry, so a revert shows as "unknown custom error". Map the
// ones a member realistically hits when voting/queuing/executing to a plain explanation. (selector = first 4
// bytes of keccak256 of the error signature.)
const TX_ERROR_BY_SELECTOR = {
  '0x5ead8eb5': 'The timelock delay hasn’t elapsed yet — this proposal can only be executed after its execution time (ETA).',
  '0x31b75e4d': 'The proposal isn’t in a state that allows this action (it may already be executed/defeated, or not yet queued).',
  '0xe450d38c': 'The executing treasury (timelock) doesn’t hold enough token balance to fund this proposal.',
  '0xcd786059': 'The executing treasury (timelock) doesn’t hold enough native balance to fund this proposal.',
  '0x1425ea42': 'An inner call failed during execution — most often the executing treasury (timelock) can’t fund the transfer.',
  '0x6ad06075': 'No such proposal on this Governor.',
}

/**
 * Turn a tx/call error into a human message, decoding the known Governor/Timelock custom errors that otherwise
 * surface as "execution reverted (unknown custom error)". Falls back to ethers' own message.
 */
export function explainTxError(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data
  const sel = typeof data === 'string' && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null
  if (sel && TX_ERROR_BY_SELECTOR[sel]) return TX_ERROR_BY_SELECTOR[sel]
  return e?.shortMessage || e?.reason || e?.message || 'Transaction failed.'
}

// --- US5: user-signed management actions (the member signs; the external DAO's own rules gate authorization) ---

function writeContract(signer, governor) {
  return new ethers.Contract(governor, GOVERNOR_WRITE_ABI, signer)
}

export function castVote(signer, governor, proposalId, support) {
  return writeContract(signer, governor).castVote(proposalId, support)
}
export function queueProposal(signer, governor, p) {
  return writeContract(signer, governor).queue(p.targets, p.values, p.calldatas, p.descriptionHash)
}
export function executeProposal(signer, governor, p) {
  return writeContract(signer, governor).execute(p.targets, p.values, p.calldatas, p.descriptionHash)
}
export function proposeAction(signer, governor, { targets, values, calldatas, description }) {
  return writeContract(signer, governor).propose(targets, values, calldatas, description)
}

// Spec 043 (US3, FR-022a): encode a management action's calldata (to the governor) so it can be proposed as a
// vault transaction when operating as a Safe. Spec 041/050 reuses the same encoding for the passkey smart-account
// rail (sendCalls). `propose` is included so the ProposalBuilder's passkey path can encode the framework-correct
// OZ propose(targets, values, calldatas, description) without re-deriving the signature. Returns { to, data }.
export function encodeManagementAction(governor, action, args) {
  const iface = new ethers.Interface(GOVERNOR_WRITE_ABI)
  let data
  if (action === 'castVote') data = iface.encodeFunctionData('castVote', [args.proposalId, args.support])
  else if (action === 'queue') data = iface.encodeFunctionData('queue', [args.p.targets, args.p.values, args.p.calldatas, args.p.descriptionHash])
  else if (action === 'execute') data = iface.encodeFunctionData('execute', [args.p.targets, args.p.values, args.p.calldatas, args.p.descriptionHash])
  else if (action === 'propose') data = iface.encodeFunctionData('propose', [args.targets, args.values, args.calldatas, args.description])
  else throw new Error(`Unsupported vault governance action: ${action}`)
  return { to: governor, data }
}

// --- Spec 042: pluggable connector object (framework 0 = OpenZeppelin Governor) ---
// One implementation of the shared connector interface (specs/042 contracts/connector-interface.md) so the
// ClearPath UI, daoDataSource, and daoSource stay framework-agnostic. It wraps the functions above; adding a
// framework (e.g. GovernorBravo) is a new module + a resolver entry, with no UI change (SC-006).
export const ozGovernorConnector = {
  framework: 0,
  // `matches` is the OZ probe used by detectFramework: a real OZ Governor answers COUNTING_MODE()+votingPeriod()
  // (validateGovernor). GovernorBravo does NOT implement COUNTING_MODE, so this cleanly discriminates OZ.
  matches: async (reader, address) => (await validateGovernor(reader, address)).ok,
  validate: validateGovernor,
  readSummary: readGovernorSummary,
  readTreasuries,
  extraTreasuries,
  detectTreasuryFunding,
  fetchProposals: fetchGovernorProposals,
  readVoterState,
  readProposalEta,
  castVote,
  queue: queueProposal,
  execute: executeProposal,
  propose: proposeAction,
  encode: encodeManagementAction,
  explainTxError,
}
