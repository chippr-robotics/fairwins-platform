// Shared test double for the spec-064 useSelectableAssets hook.
//
// The home Pay/Request/Wager panels and the Transfer view now derive their asset
// list from useSelectableAssets, which transitively needs the WalletProvider /
// portfolio graph. Tests that render those panels for OTHER reasons (challenge
// creation, acting-account wiring, home a11y) stub the DATA hook with this fixture
// so they stay provider-light — the real UniversalAssetSelect component still
// renders, so its markup/a11y remain under test.
//
// Usage (vi.mock is hoisted, so reference this via an async factory import):
//   vi.mock('<rel>/hooks/useSelectableAssets', async () =>
//     await import('<rel>/test/helpers/selectableAssetsMock'))

// Chain 61 (Ethereum Classic) matches the chainId on the global wagmi useAccount() test mock in
// src/test/setup.js, so panels that gate on the connected chain (Wager create) see
// no false network mismatch when they render with this fixture.
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
const CHAIN = 61

const OPTIONS = [
  { key: `${CHAIN}:${USDC}`, chainId: CHAIN, kind: 'erc20', address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, networkName: 'Ethereum Classic', balance: 100 },
  { key: `${CHAIN}:native`, chainId: CHAIN, kind: 'native', address: null, symbol: 'ETC', name: 'Ethereum Classic', decimals: 18, networkName: 'Ethereum Classic', balance: 5 },
]

const API = { options: OPTIONS, defaultKey: `${CHAIN}:${USDC}`, isGasless: () => false }

export const useSelectableAssets = () => API
export default useSelectableAssets
