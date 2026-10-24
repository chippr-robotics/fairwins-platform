/**
 * Test harness for the ClearPath package (spec 073 T028).
 *
 * Same contract as Token Mint's stub and for the same reason: a stub more permissive than the real
 * host lets the package ship code the host refuses. So `contracts()` throws for a name outside the
 * manifest allowlist, `network()` returns null for a chain it does not know, `submit()` resolves at
 * BROADCAST behind a `wait()`, and `switchChain()` actually moves the stub wallet.
 *
 * ClearPath is NETWORK-AGNOSTIC, so this stub knows several chains and `networks()` returns them —
 * the app filters that roster itself into the chains it can operate on.
 */
import { vi } from 'vitest'

/** Declared in vite.config.js; anything else must throw, exactly as the host does. */
const DECLARED = ['externalDAORegistry', 'standardDaoFactory', 'paymentToken', 'sanctionsGuard']

const DEPLOYMENTS = {
  externalDAORegistry: { 63: '0x00000000000000000000000000000000000000e1' },
  /*
   * Spec 030 pillar A. Present on 137 and ABSENT on 63 on purpose: Mordor is pre-Cancun and never gets
   * this factory (issue #1268), so the stub reproduces the exact asymmetry the app has to render — a
   * declared name that resolves on one chain and answers `null` on another.
   */
  standardDaoFactory: { 137: '0x00000000000000000000000000000000000000da' },
  paymentToken: { 63: '0x00000000000000000000000000000000000000cc' },
  sanctionsGuard: { 63: '0x00000000000000000000000000000000000000ff' },
}

const NETWORKS = {
  63: { chainId: 63, name: 'Mordor', isTestnet: true, nativeCurrency: { symbol: 'METC', decimals: 18 }, explorer: { name: 'Blockscout', baseUrl: 'https://etc-mordor.blockscout.com' }, subgraphUrl: null },
  137: { chainId: 137, name: 'Polygon', isTestnet: false, nativeCurrency: { symbol: 'POL', decimals: 18 }, explorer: { name: 'Polygonscan', baseUrl: 'https://polygonscan.com' }, subgraphUrl: 'https://example.invalid/sg' },
  1: { chainId: 1, name: 'Ethereum', isTestnet: false, nativeCurrency: { symbol: 'ETH', decimals: 18 }, explorer: { name: 'Etherscan', baseUrl: 'https://etherscan.io' }, subgraphUrl: null },
}

class StubHostError extends Error {
  constructor(reason, message, userMessage) {
    super(message)
    this.name = 'MiniAppHostError'
    this.reason = reason
    this.userMessage = userMessage ?? message
  }
}

const ACCOUNT = '0x00000000000000000000000000000000000000a1'
const TX_HASH = '0xabcdef0000000000000000000000000000000000000000000000000000001234'

/** An in-memory stand-in for the namespaced host store, with the same never-throws contract. */
function makeStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get: (key, fallback = null) => (data.has(key) ? data.get(key) : fallback),
    set: (key, value) => { data.set(key, value); return true },
    subscribe: () => () => {},
  }
}

export function makeHost(over = {}) {
  const chainId = over.chainId ?? 63
  const receipt = over.receipt ?? { status: 1, logs: [] }
  const store = over.store ?? makeStore(over.storeData)

  /*
   * ONE PROVIDER PER CHAIN, with a STABLE identity — the real host guarantees this (it caches the
   * guard wrapper per underlying provider), and a stub that handed back a fresh object per call
   * would make every effect keyed on the provider re-run on every render. That is not a test
   * artifact: it is an infinite loop, and it is how the real host's own instability was found.
   */
  const providers = new Map()

  const wallet = {
    address: ACCOUNT,
    connectedAddress: ACCOUNT,
    chainId,
    isConnected: true,
    requestConnect: vi.fn(),
    switchChain: vi.fn(async (target) => {
      if (over.switchRefused) {
        throw new StubHostError('switch_refused', 'declined', `Switch your wallet to network ${target}.`)
      }
      wallet.chainId = Number(target)
    }),
    submit: vi.fn(async (payload) => {
      // The host screens the acting account and refuses before any rail is touched.
      if (over.sanctioned) {
        throw new StubHostError(
          'sanctioned_account',
          'acting account restricted',
          'This wallet is restricted by sanctions screening and cannot send transactions.',
        )
      }
      if (payload?.chainId != null && Number(payload.chainId) !== Number(wallet.chainId)) {
        throw new StubHostError('wrong_chain', 'wrong chain', `Switch your wallet to network ${payload.chainId}.`)
      }
      const kind = over.proposed ? 'proposed' : 'sent'
      const result = {
        kind,
        // A realistic 32-byte hash: surfaces abbreviate it (`0xabcd…1234`), and a short stub value
        // would make those assertions read as nonsense.
        txHash: kind === 'sent' ? (over.txHash ?? TX_HASH) : null,
        safeTxHash: kind === 'proposed' ? '0xsafe' : null,
      }
      Object.defineProperty(result, 'wait', { enumerable: false, value: async () => receipt })
      return Object.freeze(result)
    }),
    ...(over.wallet || {}),
  }

  return Object.freeze({
    appId: 'clearpath',
    wallet: Object.freeze(wallet),
    readProvider: over.readProvider ?? ((forChain = chainId) => {
      if (!providers.has(forChain)) {
        providers.set(forChain, {
          call: vi.fn(async () => '0x'),
          getBlockNumber: vi.fn(async () => 1),
          /*
           * `estimateGas` / `getFeeData` are ordinary provider reads and the real host's guard
           * blocks neither (only `destroy` and `removeAllListeners`), so the stub must offer them
           * — the fee disclosure (issue #1408) is built on exactly these two calls. Overridable
           * per test so the "estimate failed" and "no gas price" branches are reachable without
           * inventing a different provider shape.
           */
          estimateGas: vi.fn(over.estimateGas ?? (async () => 6_340_000n)),
          getFeeData: vi.fn(over.getFeeData ?? (async () => ({ maxFeePerGas: 30_000_000_000n, gasPrice: 30_000_000_000n }))),
        })
      }
      return providers.get(forChain)
    }),
    contracts: over.contracts ?? ((name, forChain = chainId) => {
      if (!DECLARED.includes(name)) {
        throw new StubHostError('undeclared_contract', `"${name}" is not declared`, 'Not approved to use that contract.')
      }
      return DEPLOYMENTS[name]?.[forChain] ?? null
    }),
    network: over.network ?? ((forChain = chainId) => NETWORKS[forChain] ?? null),
    // A realistic cohort, not just the connected chain: ClearPath is network-agnostic, and the
    // app filters this roster itself into the chains it can actually operate on.
    networks: over.networks ?? (() => Object.freeze([1, 63, 137])),
    store,
    audit: over.audit ?? { log: vi.fn() },
    toast: over.toast ?? { show: vi.fn() },
    navigate: over.navigate ?? vi.fn(),
  })
}

/**
 * The mutable host every test in a file shares. `vi.mock` factories are hoisted above module
 * initialisation, so they read `hostRef.current` rather than closing over a const.
 */
export const hostRef = { current: makeHost() }

export function resetHost(over) {
  hostRef.current = makeHost(over)
  return hostRef.current
}
