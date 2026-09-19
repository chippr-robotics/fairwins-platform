import { expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import * as matchers from 'vitest-axe/matchers'

// Extend expect with axe matchers
expect.extend(matchers)

// Mock ResizeObserver globally as a proper class
class MockResizeObserver {
  constructor(callback) {
    this.callback = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver

// Mock IntersectionObserver globally as a proper class
class MockIntersectionObserver {
  constructor(callback) {
    this.callback = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
global.IntersectionObserver = MockIntersectionObserver

// Polyfill the Pointer Events API — jsdom does not implement PointerEvent or
// element pointer-capture, which drag-based components (e.g. the deadline
// timeline, spec 038) rely on for dot-dragging.
if (typeof global.PointerEvent === 'undefined') {
  class MockPointerEvent extends MouseEvent {
    constructor(type, params = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 0
      this.pointerType = params.pointerType ?? 'mouse'
    }
  }
  global.PointerEvent = MockPointerEvent
  window.PointerEvent = MockPointerEvent
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}

// Cleanup after each test
afterEach(() => {
  cleanup()
})

// Mock fetch globally to prevent real network requests
global.fetch = vi.fn().mockImplementation(async (url, _options) => {
  // Mock CoinGecko API for price conversion. Match through the path separator: a bare
  // host prefix also matches https://api.coingecko.com.evil.test, and a test double that
  // answers for a look-alike host teaches the suite the wrong thing.
  if (url.startsWith('https://api.coingecko.com/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        'ethereum-classic': {
          usd: 25.50
        }
      })
    }
  }
  
  // Mock any RPC endpoints
  if (url.includes('rpc') || url.includes('etccooperative')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: '0x0de0b6b3a7640000' // 1 native token in wei
      })
    }
  }
  
  // Default mock response
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => ''
  }
})

// Mock ethers.js providers to prevent real network calls
vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers')
  
  // Create mock provider that returns valid responses
  class MockBrowserProvider {
    constructor() {}
    
    async getBalance() {
      return actual.ethers.parseEther('1.0')
    }
    
    async getNetwork() {
      return {
        chainId: 61n,
        name: 'ethereum-classic'
      }
    }
    
    async getBlockNumber() {
      return 1000000
    }
    
    getSigner() {
      return {
        getAddress: async () => '0x1234567890123456789012345678901234567890',
        signMessage: async () => '0xmocksignature'
      }
    }
  }
  
  class MockJsonRpcProvider {
    constructor() {}
    
    async getBalance() {
      return actual.ethers.parseEther('1.0')
    }
    
    async getNetwork() {
      return {
        chainId: 61n,
        name: 'ethereum-classic'
      }
    }
    
    async getBlockNumber() {
      return 1000000
    }
    
    async call() {
      // Return a mock response for contract calls (1000 tokens with 18 decimals)
      return actual.ethers.toBeHex(actual.ethers.parseEther('1000'))
    }
  }
  
  // Mock Contract class to return mock values
  class MockContract {
    constructor(address, abi, provider) {
      this.address = address
      this.abi = abi
      this.provider = provider
    }
    
    async balanceOf() {
      return actual.ethers.parseEther('1000')
    }
    
    async allowance() {
      return actual.ethers.parseEther('1000')
    }
    
    async totalSupply() {
      return actual.ethers.parseEther('1000000')
    }
    
    async hasRole() {
      return false
    }
    
    async getRoleMember() {
      return '0x0000000000000000000000000000000000000000'
    }
    
    async getRoleMemberCount() {
      return 0n
    }
  }
  
  return {
    ...actual,
    BrowserProvider: MockBrowserProvider,
    JsonRpcProvider: MockJsonRpcProvider,
    Contract: MockContract
  }
})

// The viem read seam (spec 110 Phase 1, #1592) — the twin of the ethers Contract mock above.
// Files converted onto lib/chains/readContract leave MockContract's coverage, so the seam's
// client factory answers with the SAME canned world here: balanceOf/allowance are 1000 tokens,
// totalSupply a million, roles empty, native balance 1, logs empty. An unmocked functionName
// THROWS (exactly as a missing method on MockContract did), so a suite that needs a specific
// read still fails loudly and mocks the seam itself. src/test/chains/* unmocks this to test
// the real factory.
vi.mock('../lib/chains/publicClient', async () => {
  const actual = await vi.importActual('../lib/chains/publicClient')
  const CANNED = {
    balanceOf: () => 1000n * 10n ** 18n,
    allowance: () => 1000n * 10n ** 18n,
    totalSupply: () => 1000000n * 10n ** 18n,
    hasRole: () => false,
    getRoleMember: () => '0x0000000000000000000000000000000000000000',
    getRoleMemberCount: () => 0n,
    getEthBalance: () => 10n ** 18n,
  }
  const fakeClient = {
    async readContract({ functionName }) {
      if (functionName in CANNED) return CANNED[functionName]()
      throw new Error(`mock publicClient: unmocked read '${functionName}' — mock the seam in this suite`)
    },
    async getBalance() {
      return 10n ** 18n
    },
    async getBlockNumber() {
      return 1000000n
    },
    async getLogs() {
      return []
    },
    // eventScanHandle's raw log read (eth_getLogs). Empty history, same as getLogs above.
    async request({ method }) {
      if (method === 'eth_getLogs') return []
      throw new Error(`mock publicClient: unmocked request '${method}' — mock the seam in this suite`)
    },
    async call() {
      // 1000 tokens, the MockJsonRpcProvider.call parity value.
      return { data: `0x${(1000n * 10n ** 18n).toString(16).padStart(64, '0')}` }
    },
  }
  return { ...actual, getPublicClient: () => fakeClient }
})

// Mock wagmi hooks for WalletProvider
vi.mock('wagmi', () => ({
  // Real-wagmi passthrough: createConnector is an identity wrapper (spec 041
  // passkey connector unit tests instantiate the connector function directly).
  createConnector: (createConnectorFn) => createConnectorFn,
  useAccount: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    isConnected: true
  })),
  useConnect: vi.fn(() => ({
    connect: vi.fn(),
    connectors: [{ id: 'injected', name: 'MetaMask' }]
  })),
  useDisconnect: vi.fn(() => ({
    disconnect: vi.fn()
  })),
  useChainId: vi.fn(() => 61), // Unsupported chain — keeps the no-stablecoin path under test
  useSwitchChain: vi.fn(() => ({
    switchChain: vi.fn()
  })),
  // ENS resolution hooks (used by AddressInput). Default to "no resolution" so
  // address fields render without a WagmiProvider/QueryClient in unit tests.
  useEnsAddress: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, error: null })),
  useEnsName: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, error: null })),
  // Real wagmi memoizes `data` (react-query), so the ref is STABLE across renders.
  // Return a singleton — a fresh object each call would make effects that depend on
  // walletClient re-fire every render (infinite loop / OOM in hooks like usePredictOpenOrders).
  useWalletClient: (() => {
    const result = {
      data: {
        account: { address: '0x1234567890123456789012345678901234567890' },
        chain: { id: 61 },
        transport: {}
      }
    }
    return vi.fn(() => result)
  })(),
  WagmiProvider: ({ children }) => children,
  createConfig: vi.fn(() => ({})),
  http: vi.fn(() => ({}))
}))

// Mock wagmi connectors
vi.mock('wagmi/connectors', () => ({
  injected: vi.fn(() => ({ id: 'injected', name: 'MetaMask' })),
  walletConnect: vi.fn(() => ({ id: 'walletConnect', name: 'WalletConnect' }))
}))

// Predict (spec 057): stub the heavy @polymarket/clob-client. The real one bundles viem+axios and OOMs
// jsdom workers on import. Unit tests drive the trade hooks through injected clobSession/geoblock deps, so
// the real SDK is never needed here (it is validated live in Node instead). Note: builder attribution is a
// self-contained gateway-fetch shim in clobSession.js (no @polymarket/builder-signing-sdk in the frontend —
// that SDK statically imports node:crypto and can't be bundled for the browser; it is server-only).
vi.mock('@polymarket/clob-client', () => ({
  ClobClient: class {
    async createOrDeriveApiKey() { return { key: 'k', secret: 's', passphrase: 'p' } }
    async createAndPostOrder() { return { orderID: '0xstub', status: 'matched' } }
    async cancelOrder() { return { canceled: true } }
    async getOpenOrders() { return [] }
  },
  Side: { BUY: 0, SELL: 1 },
  OrderType: { GTC: 'GTC', GTD: 'GTD', FOK: 'FOK', FAK: 'FAK' },
  // Mirrors the real SDK's Polygon contract config (dist/config.js) — passkeyApprovals derives the
  // settlement spenders from it.
  getContractConfig: (chainId) => {
    if (chainId !== 137) throw new Error(`invalid chainId: ${chainId}`)
    return {
      exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
      negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
      negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
      collateral: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    }
  }
}))

// Mock window.ethereum for Web3 tests
window.ethereum = window.ethereum || {}

// Create a mock that returns proper responses for ethers.js
const mockEthereumProvider = {
  request: vi.fn().mockImplementation(async ({ method, params: _params }) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return ['0x1234567890123456789012345678901234567890']
      case 'eth_chainId':
        return '0x3d' // Chain ID 61 (unsupported)
      case 'eth_getBalance':
        // Return a valid hex string for 1 unit in wei (1e18)
        return '0x0de0b6b3a7640000'
      case 'eth_call':
        // Return a valid hex response for contract calls (simulating balance of 1000 tokens with 18 decimals)
        return '0x00000000000000000000000000000000000000000000003635c9adc5dea00000'
      case 'net_version':
        return '61'
      case 'eth_blockNumber':
        return '0x1000000'
      default:
        return '0x0'
    }
  }),
  on: vi.fn(),
  removeListener: vi.fn(),
  isMetaMask: true,
  selectedAddress: '0x1234567890123456789012345678901234567890',
  // Mock methods needed by ethers BrowserProvider
  send: vi.fn().mockImplementation(async (method, _params) => {
    switch (method) {
      case 'eth_accounts':
        return ['0x1234567890123456789012345678901234567890']
      case 'eth_getBalance':
        return '0x0de0b6b3a7640000'
      case 'eth_call':
        return '0x00000000000000000000000000000000000000000000003635c9adc5dea00000'
      case 'eth_chainId':
        return '0x3d'
      case 'net_version':
        return '61'
      case 'eth_blockNumber':
        return '0x1000000'
      default:
        return '0x0'
    }
  })
}

window.ethereum = mockEthereumProvider

// Mock matchMedia for responsive design tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock DeviceOrientationEvent for tilt-to-hide tests (spec 047). jsdom has no
// orientation sensor; tests dispatch a plain Event with beta/gamma attached, or
// use dispatchOrientation() below. requestPermission is left UNDEFINED by default
// so the non-iOS path is exercised; tests that need the iOS gesture flow set
// window.DeviceOrientationEvent.requestPermission themselves.
if (typeof window.DeviceOrientationEvent === 'undefined') {
  window.DeviceOrientationEvent = class DeviceOrientationEvent extends Event {
    constructor(type, init = {}) {
      super(type)
      this.beta = init.beta ?? null
      this.gamma = init.gamma ?? null
      this.alpha = init.alpha ?? null
    }
  }
}

// Helper: dispatch a synthetic 'deviceorientation' event with the given angles.
global.dispatchOrientation = ({ beta, gamma = 0, alpha = 0 } = {}) => {
  const event = new Event('deviceorientation')
  event.beta = beta
  event.gamma = gamma
  event.alpha = alpha
  window.dispatchEvent(event)
}

// Create clipboard mock
const writeTextMock = vi.fn(() => Promise.resolve())
const readTextMock = vi.fn(() => Promise.resolve(''))

// Mock clipboard API globally
Object.defineProperty(navigator, 'clipboard', {
  writable: true,
  configurable: true,
  value: {
    writeText: writeTextMock,
    readText: readTextMock,
  },
})

// Reset clipboard mocks before each test
beforeEach(() => {
  writeTextMock.mockClear()
  readTextMock.mockClear()
})

// Mock HTMLCanvasElement.getContext for QR code and accessibility tests
HTMLCanvasElement.prototype.getContext = function(contextType) {
  if (contextType === '2d') {
    return {
      fillStyle: '',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn(() => ({ data: [] })),
      putImageData: vi.fn(),
      createImageData: vi.fn(() => []),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      rotate: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
      transform: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
    }
  }
  return null
}
