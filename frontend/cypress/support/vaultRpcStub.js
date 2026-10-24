// =============================================================================
// vaultRpcStub.js — two stub chains for the no-chain tier's Protect vault specs (spec 102).
//
// The vault sheet reads REAL data through the app's own read path: `getProvider(chainId)` for every
// chain the wallet is not on, the wallet's own provider for the one it is. Both resolve their RPC
// endpoint through the spec-069 member override (`fw_global_prefs.network_endpoints`), which is the
// seam this module uses — each stubbed chain is pointed at a loopback URL that nothing listens on,
// and `cy.intercept` answers it. Nothing here needs a server, and every unstubbed custody chain is
// pointed at a loopback URL that answers HTTP 503 at once, so a read there is honestly
// "could not be read" and never a slow real request through the proxy.
//
// The answers are ABI-encoded with the repo's own ethers (the Cypress bundler pulls it in): Safe
// getOwners/getThreshold/nonce/VERSION/isOwner/approvedHashes, the SafeProposalHub's `Proposed`
// logs with VERIFIABLE safeTxHashes (readVerifiedProposals recomputes the EIP-712 hash and drops
// anything that does not match — a hand-typed hash would read as "no proposals"), and empty Safe
// execution outcomes. It is a port of the loopback stub in `scripts/ui/capture-vault-sheet.mjs`,
// so the screenshots and the specs are photographing and asserting the same estate.
//
// Signing is deliberately impossible: `eth_estimateGas` / `eth_sendTransaction` /
// `eth_sendRawTransaction` answer a JSON-RPC error. A spec that reaches them is asserting that the
// failure is STATED — the tier's admission rule is that nothing here can cost a member anything.
// =============================================================================

import { Interface, TypedDataEncoder, getAddress, keccak256, toUtf8Bytes, zeroPadValue } from 'ethers'

export const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
export const OWNER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
export const OWNER_C = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'

/** The multi-network vault: a Safe on Polygon + Base (stubbed) and Optimism (deliberately not). */
export const VAULT = '0xcf76db7aa9fb1bFE08e010468F3344bB458abCDe'
/** A second, single-network vault (watch-only: the member is not an owner). */
export const OTHER_VAULT = '0x8cc5000000000000000000000000000000000000'
/** A Safe the stub reports on BOTH chains but the member has not loaded yet (VS-09). */
export const THIRD_VAULT = '0x9999999999999999999999999999999999999999'
/** HARDHAT/live `safeProposalHub` — the same address on every custody chain (config/contracts.js). */
export const HUB = '0x94b5b38C247CE51F7C42C83B63115998b7e970E7'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

export const WALLET_CHAIN = 137
export const UNSTUBBED_CHAIN = 10 // Optimism: listed as a vault instance, never answered

/** The recorded `safeProposalHub` deploy blocks (config/contracts.js DEPLOYMENT_BLOCKS_BY_CHAIN).
 *  The scan starts THERE, so a head below it — or a log before it — is honestly "none pending":
 *  no eth_getLogs is ever issued. (16645531 is Mordor's, not Polygon's.) */
export const POLYGON_HUB_BLOCK = 90120743
export const BASE_HUB_BLOCK = 49158472

/**
 * chainId → loopback port, head block (just past the recorded hub deploy block so the log scan is
 * ONE chunk), the vault's nonce there, and the Safe version string.
 */
export const STUB_CHAINS = {
  137: { port: 9811, head: POLYGON_HUB_BLOCK + 40, nonce: 5, version: '1.4.1' },
  8453: { port: 9812, head: BASE_HUB_BLOCK + 40, nonce: 2, version: '1.4.1' },
}
/** Every custody chain the app probes (config/safeContracts.js) that this stub does NOT answer. */
export const DEAD_CHAINS = { 10: 9813, 61: 9814, 63: 9815, 42161: 9816 }

export const stubUrl = (port) => `http://127.0.0.1:${port}`
export const rpcUrlFor = (chainId) =>
  stubUrl(STUB_CHAINS[chainId]?.port ?? DEAD_CHAINS[chainId] ?? 0)

/** The failover loopback port for a chain's primary port (spec 069 wants the two to differ). */
export const failoverPort = (port) => port + 100

/**
 * `fw_global_prefs.network_endpoints` — every custody chain routed to loopback, INCLUDING its
 * failover. Spec 069 puts the build's real RPC behind a member override as the last resort, so an
 * override alone is not isolation: a 503 from the loopback primary fell through to
 * `etc.rivet.link` and friends through the sandbox's egress proxy — slow (15s+ per enrichment),
 * rejected CONNECTs, and the runner dying with `read ECONNRESET` mid-spec. A loopback failover
 * keeps the whole estate on this machine, which is what "no-chain tier" means.
 */
export function stubEndpointOverrides() {
  const out = {}
  for (const [id, c] of Object.entries(STUB_CHAINS)) out[id] = { url: stubUrl(c.port), failoverUrl: stubUrl(failoverPort(c.port)) }
  for (const [id, port] of Object.entries(DEAD_CHAINS)) out[id] = { url: stubUrl(port), failoverUrl: stubUrl(failoverPort(port)) }
  return out
}

/** Exact wei the VS-10 balance case expects the Wrap form to render as `2.0064`. */
export const WRAP_BALANCE_WEI = 2006441459389172406n
export const WRAP_BALANCE_HEX = `0x${WRAP_BALANCE_WEI.toString(16)}`

// ----------------------------------------------------------------------------- ABI + fixtures

const SAFE_IFACE = new Interface([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function isOwner(address owner) view returns (bool)',
  'function VERSION() view returns (string)',
  'function approvedHashes(address owner, bytes32 hash) view returns (uint256)',
])
const HUB_IFACE = new Interface([
  'event Proposed(address indexed safe, address indexed proposer, bytes32 indexed safeTxHash, address to, uint256 value, bytes data, uint8 operation, uint256 nonce)',
])
const ERC20_TRANSFER = new Interface(['function transfer(address to, uint256 amount)'])
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
}
const ZERO = '0x0000000000000000000000000000000000000000'
const lower = (s) => String(s || '').toLowerCase()
const hex = (n) => `0x${BigInt(n).toString(16)}`

/** Owner sets per vault. The member co-owns VAULT and THIRD_VAULT; OTHER_VAULT is view-only. */
const OWNERS = {
  [lower(VAULT)]: [getAddress(TEST_ACCOUNT), OWNER_B, OWNER_C],
  [lower(OTHER_VAULT)]: [OWNER_B, OWNER_C],
  [lower(THIRD_VAULT)]: [getAddress(TEST_ACCOUNT), OWNER_B],
}
const THRESHOLDS = { [lower(VAULT)]: 2n, [lower(OTHER_VAULT)]: 2n, [lower(THIRD_VAULT)]: 1n }

function safeTx({ to, value = 0n, data = '0x', nonce }) {
  return { to, value, data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce }
}
function txHash(chainId, tx) {
  return TypedDataEncoder.hash({ chainId, verifyingContract: getAddress(VAULT) }, SAFE_TX_TYPES, tx)
}

/**
 * Pending work on VAULT. Polygon: one at the current nonce with the member's approval already
 * recorded (needs a second owner), one queued behind it with none. Base: one at its nonce, no
 * approvals — the member is an owner there too, so its row offers Approve.
 */
export const PROPOSALS = {
  137: [
    { tx: safeTx({ to: OWNER_B, value: 1_500_000_000_000_000_000n, nonce: 5 }), approvers: [getAddress(TEST_ACCOUNT)], block: POLYGON_HUB_BLOCK + 12 },
    {
      tx: safeTx({ to: USDC_POLYGON, data: ERC20_TRANSFER.encodeFunctionData('transfer', [OWNER_C, 250_000_000n]), nonce: 6 }),
      approvers: [],
      block: POLYGON_HUB_BLOCK + 20,
    },
  ],
  8453: [{ tx: safeTx({ to: OWNER_C, value: 40_000_000_000_000_000n, nonce: 2 }), approvers: [], block: BASE_HUB_BLOCK + 9 }],
}
for (const [chainId, list] of Object.entries(PROPOSALS)) {
  for (const p of list) p.hash = txHash(Number(chainId), p.tx)
}
export const PENDING_COUNT = Object.values(PROPOSALS).reduce((n, l) => n + l.length, 0)

const PROPOSED_TOPIC = HUB_IFACE.getEvent('Proposed').topicHash

function proposedLog(chainId, p) {
  const { data, topics } = HUB_IFACE.encodeEventLog('Proposed', [
    getAddress(VAULT),
    getAddress(TEST_ACCOUNT),
    p.hash,
    p.tx.to,
    p.tx.value,
    p.tx.data,
    p.tx.operation,
    p.tx.nonce,
  ])
  return {
    address: HUB,
    topics,
    data,
    blockNumber: hex(p.block),
    blockHash: keccak256(toUtf8Bytes(`block-${chainId}-${p.block}`)),
    transactionHash: keccak256(toUtf8Bytes(`tx-${chainId}-${p.hash}`)),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  }
}

const rpcError = (message, code = -32000) => ({ __error: { code, message } })

/** ERC-20 `balanceOf(address)` — answered as zero for ANY contract, so a token read on a stubbed
 *  chain (the Wrap view's wrapped-coin balance, the header's USDC chip) is a real zero rather than
 *  an unreadable "—" that would hide the one balance VS-10 is about. */
const BALANCE_OF_SELECTOR = '0x70a08231'

function ethCall(chainId, call) {
  const to = lower(call?.to)
  const data = call?.data || '0x'
  const selector = data.slice(0, 10)
  if (selector === BALANCE_OF_SELECTOR) return `0x${'0'.repeat(64)}`
  const owners = OWNERS[to]
  if (!owners) return rpcError(`stub chain ${chainId}: no contract at ${to}`)
  const fn = SAFE_IFACE.fragments.find((f) => f.type === 'function' && SAFE_IFACE.getFunction(f.name).selector === selector)
  if (!fn) return rpcError(`stub chain ${chainId}: unknown Safe selector ${selector}`)
  const cfg = STUB_CHAINS[chainId]
  switch (fn.name) {
    case 'getOwners':
      return SAFE_IFACE.encodeFunctionResult('getOwners', [owners])
    case 'getThreshold':
      return SAFE_IFACE.encodeFunctionResult('getThreshold', [THRESHOLDS[to]])
    case 'nonce':
      return SAFE_IFACE.encodeFunctionResult('nonce', [BigInt(to === lower(VAULT) ? cfg.nonce : 0)])
    case 'VERSION':
      return SAFE_IFACE.encodeFunctionResult('VERSION', [cfg.version])
    case 'isOwner': {
      const [owner] = SAFE_IFACE.decodeFunctionData('isOwner', data)
      return SAFE_IFACE.encodeFunctionResult('isOwner', [owners.map(lower).includes(lower(owner))])
    }
    case 'approvedHashes': {
      const [owner, hash] = SAFE_IFACE.decodeFunctionData('approvedHashes', data)
      const p = to === lower(VAULT) ? (PROPOSALS[chainId] || []).find((x) => lower(x.hash) === lower(hash)) : null
      const approved = p?.approvers.map(lower).includes(lower(owner))
      return SAFE_IFACE.encodeFunctionResult('approvedHashes', [approved ? 1n : 0n])
    }
    default:
      return rpcError(`stub chain ${chainId}: unhandled ${fn.name}`)
  }
}

function getLogs(chainId, filter) {
  const address = Array.isArray(filter?.address) ? filter.address.map(lower) : [lower(filter?.address)]
  if (!address.includes(lower(HUB))) return []
  const topic0 = filter?.topics?.[0]
  const wants = Array.isArray(topic0) ? topic0.map(lower) : topic0 ? [lower(topic0)] : null
  if (wants && !wants.includes(lower(PROPOSED_TOPIC))) return []
  const safeTopic = filter?.topics?.[1]
  const wantSafe = Array.isArray(safeTopic) ? safeTopic.map(lower) : safeTopic ? [lower(safeTopic)] : null
  if (wantSafe && !wantSafe.includes(lower(zeroPadValue(VAULT, 32)))) return []
  // Honour the block range like a real node. The app's log scanner (lib/chain/logScan.js) keeps a
  // per-filter cursor and APPENDS what each new range returns; a stub that answered every range
  // with every log would hand it the same proposals again on each refresh (measured: 191 rows
  // for 3 proposals), which is a fact about the stub, not the product.
  const from = blockArg(filter?.fromBlock, 0)
  const to = blockArg(filter?.toBlock, STUB_CHAINS[chainId].head)
  return (PROPOSALS[chainId] || []).filter((p) => p.block >= from && p.block <= to).map((p) => proposedLog(chainId, p))
}

/** A JSON-RPC block tag → number (`latest`/`pending`/absent ⇒ the fallback). */
function blockArg(tag, fallback) {
  if (tag == null) return fallback
  if (typeof tag === 'string' && !tag.startsWith('0x')) return fallback
  return Number(BigInt(tag))
}

const NO_SIGNING = new Set(['eth_estimateGas', 'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTransaction'])

/** One JSON-RPC answer for one stubbed chain. Returns `{ __error }` for a JSON-RPC error. */
export function answer(chainId, call, { balanceHex } = {}) {
  const cfg = STUB_CHAINS[chainId]
  const [param] = call?.params || []
  const method = call?.method
  if (NO_SIGNING.has(method)) {
    return rpcError(`stub chain ${chainId}: ${method} is not available in the no-chain tier — nothing here can be signed or broadcast`)
  }
  switch (method) {
    case 'eth_chainId':
      return hex(chainId)
    case 'net_version':
      return String(chainId)
    case 'eth_blockNumber':
      return hex(cfg.head)
    case 'eth_syncing':
      return false
    case 'eth_getBalance':
      return balanceHex || WRAP_BALANCE_HEX
    case 'eth_getTransactionCount':
      return '0x0'
    case 'eth_getCode': {
      const a = lower(param)
      return OWNERS[a] || a === lower(HUB) ? '0x6080604052' : '0x'
    }
    case 'eth_getStorageAt':
      return `0x${'0'.repeat(64)}`
    case 'eth_call':
      return ethCall(chainId, param)
    case 'eth_getLogs':
      return getLogs(chainId, param)
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00'
    case 'eth_feeHistory':
      return { oldestBlock: hex(cfg.head - 1), baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }
    case 'eth_getBlockByNumber':
      return {
        number: hex(cfg.head),
        baseFeePerGas: '0x3b9aca00',
        timestamp: hex(Math.floor(Date.now() / 1000)),
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        hash: keccak256(toUtf8Bytes(`head-${chainId}`)),
        parentHash: `0x${'0'.repeat(64)}`,
        miner: ZERO,
        difficulty: '0x0',
        extraData: '0x',
        nonce: '0x0000000000000000',
        transactions: [],
      }
    default:
      return rpcError(`stub chain ${chainId}: unsupported method ${method}`, -32601)
  }
}

function envelope(chainId, call, opts) {
  const result = answer(chainId, call, opts)
  const base = { jsonrpc: '2.0', id: call?.id ?? 1 }
  return result && typeof result === 'object' && result.__error ? { ...base, error: result.__error } : { ...base, result }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
}

/**
 * Register the intercepts. Call BEFORE `cy.visit` (intercepts are per test).
 *
 * Returns `{ log }` — every JSON-RPC call the page made to a stubbed chain, in order, as
 * `{ chainId, method }` — so a spec can assert what did and did not reach the chain. The array is
 * filled by the intercept handler, which runs in the spec's own process.
 *
 * @param {{ balanceHex?: string }} [opts]
 */
export function installVaultRpcStub(opts = {}) {
  const log = []
  // Primary AND failover ports answer identically — the point is that nothing leaves loopback.
  const portsOf = (port) => `(${port}|${failoverPort(port)})`
  for (const [id, c] of Object.entries(STUB_CHAINS)) {
    const chainId = Number(id)
    cy.intercept({ url: new RegExp(`^http://127\\.0\\.0\\.1:${portsOf(c.port)}(/|$)`) }, (req) => {
      if (req.method === 'OPTIONS') {
        req.reply({ statusCode: 204, headers: CORS })
        return
      }
      let payload = req.body
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload)
        } catch {
          req.reply({ statusCode: 400, headers: CORS, body: 'bad json' })
          return
        }
      }
      const calls = Array.isArray(payload) ? payload : [payload]
      for (const call of calls) log.push({ chainId, method: call?.method })
      const out = Array.isArray(payload) ? calls.map((c) => envelope(chainId, c, opts)) : envelope(chainId, payload, opts)
      req.reply({ statusCode: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(out) })
    }).as(`rpc${chainId}`)
  }
  // Unstubbed custody chains answer 503 at once: to ethers that is a failed request — an honest
  // "could not be read", instantly. Not `forceNetworkError`: Cypress 15 tears the proxied socket
  // down hard, and a burst of those (the load probe fans out to every custody chain) took the
  // whole runner down with `read ECONNRESET` before the failure summary printed.
  for (const [id, port] of Object.entries(DEAD_CHAINS)) {
    cy.intercept({ url: new RegExp(`^http://127\\.0\\.0\\.1:${portsOf(port)}(/|$)`) }, (req) => {
      req.reply({
        statusCode: 503,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ error: `stub chain ${id}: deliberately unreachable in the no-chain tier` }),
      })
    }).as(`rpcDead${id}`)
  }
  return { log }
}

/**
 * Seed the member's Protect estate into localStorage. Use from `cy.visit`'s `onBeforeLoad`.
 *
 *   - the RPC overrides above (spec 069) so every custody read goes to the stub
 *   - VAULT on Polygon + Base + Optimism, OTHER_VAULT on Polygon (the reference store, unchanged schema)
 *   - an address book naming both vaults and one owner ("Alice"), so the owner rows have a
 *     known / unknown split to cross-reference
 */
export function seedVaultEstate(win, { account = TEST_ACCOUNT } = {}) {
  const me = lower(account)
  win.localStorage.setItem('fw_global_prefs', JSON.stringify({ network_endpoints: stubEndpointOverrides() }))
  win.localStorage.setItem(
    `fw_user_${me}_custody_vault_references`,
    JSON.stringify([
      { address: VAULT, chainId: 137, label: 'Treasury', addedAt: 1756800000000, role: 'owner' },
      { address: VAULT, chainId: 8453, label: 'Treasury', addedAt: 1756800000000, role: 'owner' },
      { address: VAULT, chainId: UNSTUBBED_CHAIN, label: 'Treasury', addedAt: 1756800000000, role: 'owner' },
      { address: OTHER_VAULT, chainId: 137, label: 'Grants', addedAt: 1756800001000, role: 'watch' },
    ]),
  )
  win.localStorage.setItem(
    `fw_user_${me}_addressBook`,
    JSON.stringify({
      version: 1,
      contacts: [
        { id: 'c-alice', nickname: 'Alice', addresses: [{ address: OWNER_B, chainId: 137, notes: '' }] },
        {
          id: 'c-treasury',
          nickname: 'Treasury',
          addresses: [137, 8453, UNSTUBBED_CHAIN].map((c) => ({ address: VAULT, chainId: c, notes: '' })),
        },
        { id: 'c-grants', nickname: 'Grants', addresses: [{ address: OTHER_VAULT, chainId: 137, notes: '' }] },
      ],
    }),
  )
}

/** Wallet-handled JSON-RPC methods: everything else a real wallet forwards to the chain it is on. */
const WALLET_METHODS = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'net_version',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
])

/**
 * Make the mock wallet forward to the chain it is CURRENTLY on.
 *
 * `cy.mockWeb3Provider` forwards every non-wallet method to ONE `rpcUrl` for the life of the page,
 * whatever chain the wallet has since switched to. For the cross-chain approve that is wrong in
 * the one way that matters: after the wallet moves to Base, the app's wallet-provider reads for
 * Base would be answered by the Polygon stub, whose hub logs verify against chain 137 and vanish on
 * 8453 — the row the member just acted on would disappear, and the failure it must state would have
 * nowhere to render. A real wallet forwards to the chain it is on; this makes the mock do the same,
 * and records every method the page asked the wallet for (`win.__cyWalletLog`).
 *
 * Call AFTER the page has loaded (the mock installs `win.ethereum` at load). ethers' BrowserProvider
 * calls `ethereum.request` on the object per call, so the wrap is seen by every later read.
 */
export function forwardWalletToCurrentChain(win) {
  const eth = win.ethereum
  if (!eth || eth.__cyChainAware) return eth.__cyWalletLog
  const original = eth.request.bind(eth)
  const walletLog = []
  eth.__cyWalletLog = walletLog
  eth.__cyChainAware = true
  eth.request = (args) => {
    const method = args?.method
    walletLog.push(method)
    if (WALLET_METHODS.has(method)) return original(args)
    const chainId = parseInt(eth.chainId, 16)
    const url = rpcUrlFor(chainId)
    return win
      .fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: args?.params || [] }),
      })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.error) {
          const e = new Error(data.error.message || 'RPC error')
          e.code = data.error.code
          throw e
        }
        return data.result
      })
  }
  return walletLog
}

export const SIGNING_METHODS = ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTransaction', 'eth_signTypedData_v4', 'eth_signTypedData', 'personal_sign', 'eth_sign']
