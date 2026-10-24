/**
 * Staking section constants (spec 065 — liquid & delegated staking).
 *
 * Global, chain-independent coordinates for the staking providers the Earn →
 * Stake area surfaces, plus the curated Polygon validator allowlist. Launch
 * chain is Ethereum mainnet (chainId 1): all three options (Lido liquid ETH,
 * sPOL liquid POL, Polygon validator delegation) mint/execute on L1. Per-chain
 * enablement is the presence of a `staking` block on a NETWORKS entry — see
 * config/networks.js and specs/065-liquid-delegated-staking/contracts/staking-config.md.
 *
 * External-protocol addresses are resolved from config the same way spec 050's
 * Morpho/Merkl and the dex config resolve Uniswap — they are NOT FairWins
 * deployments, so the generated `deployments/` sync artifacts do not apply.
 * VERIFY every address at build time (Lido deployed-contracts page,
 * 0xPolygon/spol-contracts, and the live Polygon staking API).
 */
import { getAddress, keccak256, stringToBytes } from 'viem'

// ethers' `id(text)` — keccak256 over the UTF-8 bytes of the label.
const keccakId = (text) => keccak256(stringToBytes(text))

// Position refresh cadence — aligned with usePortfolio / useEarnPositions.
export const STAKING_POLL_MS = 60_000

/**
 * Map a liquid-staking option `kind` to the spec-066 FeeRouter service id the
 * StakingRouter reads to charge that provider's platform fee. Returns `null` for
 * anything that carries no fee — the Polygon validator `delegated` path (fee-free
 * in v1) and any unknown kind — so callers show no fee line and take the direct
 * spec-065 path. The constants above stay the fee-free fallback default.
 *
 * The ids are computed locally (keccak of the label) rather than imported from
 * feeQuote to avoid a config↔lib import cycle; they equal `FEE_SERVICES.STAKE_*`.
 */
export function stakingRouterServiceIdFor(kind) {
  switch (kind) {
    case 'lido':
      return keccakId('stake.lido')
    case 'spol':
      return keccakId('stake.polygon')
    default:
      return null // delegated + unknown kinds are fee-free
  }
}

// Lido APR (7-day SMA) — public, no auth. `data.smaApr` is a PERCENTAGE
// (e.g. 3.2 means 3.2%); fetchLidoApr normalizes it to a fraction (÷100).
export const LIDO_APR_API = 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma'

// Official Polygon staking API v2 — validator list, commission, status. APR is
// NOT a field here; it is estimated separately.
export const POLYGON_STAKING_API = 'https://staking-api.polygon.technology/api/v2/validators'

// Lido V2 contracts on Ethereum mainnet (chainId 1).
export const LIDO_CONTRACTS = {
  steth: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
  wsteth: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  withdrawalQueue: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1',
}

// FairWins attribution address passed to Lido `submit(_referral)`. Tracking
// only — Lido pays no referral revenue (research.md R1). Override via env; the
// zero address is a safe default (a valid, no-op marker).
export const LIDO_REFERRAL =
  import.meta.env?.VITE_LIDO_REFERRAL || '0x0000000000000000000000000000000000000000'

// sPOL — Polygon's official native liquid staking token (research.md R2).
// Canonical mint/unstake on Ethereum L1.
export const SPOL_CONTRACTS = {
  token: '0x3B790d651e950497c7723D47B24E6f61534f7969',
  controller: '0xEaadA411F2600570796c341552b9869DA708a28B',
}

// POL token + Polygon StakeManager on Ethereum L1 (delegation lives on L1).
// Env-overridable + verify at build time (value-path addresses).
export const POL_TOKEN_L1 =
  import.meta.env?.VITE_POL_TOKEN_L1 || '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'
export const POLYGON_STAKE_MANAGER_L1 =
  import.meta.env?.VITE_POLYGON_STAKE_MANAGER || '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908'

/**
 * Curated Polygon validator allowlist (spec 065 R8) — the HARD boundary for
 * delegated-staking targets (FR-008). Drawn from the live Polygon staking API
 * and filtered to active/HEALTHY + delegationEnabled + strong uptime +
 * reasonable commission (0–12%) + named operator + entity/size spread. The API
 * only DECORATES these entries with live commission/status; it never expands
 * the list. Re-verify each id (HEALTHY, delegationEnabled, commission) at build
 * time — these values are live per-checkpoint. `validatorShare` is the
 * `buyVoucherPOL` call target.
 */
const RAW_VALIDATORS = [
  { validatorId: 47, name: 'Kiln', validatorShare: '0xD14a87025109013B0a2354a775cB335F926Af65A' },
  { validatorId: 87, name: 'Figment', validatorShare: '0xb929B89153fC2eEd442e81E5A1add4e2fa39028f' },
  { validatorId: 77, name: 'Everstake', validatorShare: '0xF30Cf4ed712D3734161fDAab5B1DBb49Fd2D0E5c' },
  { validatorId: 121, name: 'Stakin', validatorShare: '0xC7757805B983eE1b6272c1840c18e66837dE858E' },
  { validatorId: 162, name: 'P2P.org', validatorShare: '0x15C2b3AdcA66E26B6F230b4023f52a285b7f9995' },
  { validatorId: 123, name: 'stake.fish', validatorShare: '0x11cc04dD962e82D411587c56b815E8f8141Eb7D5' },
  { validatorId: 18, name: 'Luganodes', validatorShare: '0xa6e768fEf2D1aF36c0cfdb276422E7881a83e951' },
  { validatorId: 106, name: 'Chorus One', validatorShare: '0xD9E6987D77bf2c6d0647b8181fd68A259f838C36' },
]

// Checksum-normalize at load as a safety net (the addresses are already
// EIP-55, but this guarantees a bad hand-edit fails loudly per the config doc).
export const CURATED_POLYGON_VALIDATORS = RAW_VALIDATORS.map((v) => ({
  ...v,
  validatorShare: getAddress(v.validatorShare),
}))

/**
 * The staking block for chain 1. Factory (not a shared object) so each network
 * that opts in gets its own copy. Only Ethereum mainnet has one at launch.
 */
export function ethereumStakingConfig() {
  return {
    liquid: [
      {
        kind: 'lido',
        provider: { name: 'Lido', url: 'https://stake.lido.fi' },
        asset: { symbol: 'ETH', decimals: 18 },
        lstSymbol: 'wstETH',
        referral: LIDO_REFERRAL,
        contracts: { ...LIDO_CONTRACTS },
        aprApi: LIDO_APR_API,
        unbonding: { kind: 'queue', instantExit: false },
      },
      {
        kind: 'spol',
        provider: { name: 'sPOL (Polygon)', url: 'https://staking.polygon.technology/lst' },
        asset: { symbol: 'POL', decimals: 18, address: POL_TOKEN_L1 },
        lstSymbol: 'sPOL',
        referral: null,
        contracts: { ...SPOL_CONTRACTS },
        aprApi: null, // derived on-chain from convert* rate drift
        unbonding: { kind: 'checkpoints', instantExit: true },
      },
    ],
    delegated: {
      provider: { name: 'Polygon PoS', url: 'https://staking.polygon.technology' },
      asset: { symbol: 'POL', decimals: 18, address: POL_TOKEN_L1 },
      stakeManager: POLYGON_STAKE_MANAGER_L1,
      stakingApi: POLYGON_STAKING_API,
      validators: CURATED_POLYGON_VALIDATORS,
    },
  }
}

/**
 * Build a deep link into the Earn → Stake area.
 * `/wallet?tab=earn&view=stake[&chain=<id>][&token=<sym>]`
 * `chain` is a hint (the section operates on the active wallet network and
 * prompts a switch when they differ); `token` prefilters the option list
 * (ETH → liquid; POL → liquid + delegated).
 */
export function stakingPath({ chainId, tokenSymbol } = {}) {
  const params = new URLSearchParams({ tab: 'earn', view: 'stake' })
  if (chainId != null) params.set('chain', String(chainId))
  if (tokenSymbol) params.set('token', tokenSymbol)
  return `/wallet?${params.toString()}`
}
