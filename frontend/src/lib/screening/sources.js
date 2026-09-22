/**
 * Address-screening SOURCES — every on-chain list the app can ask about an address, and where.
 *
 * Spec 021 amendment (issue #1458). The original screen asked ONE question — "does the FairWins
 * `SanctionsGuard` on the wallet's chain allow this address?" — and on the four mainnets where
 * FairWins has deployed no guard (Ethereum, Optimism, Arbitrum, Base) that question had no
 * answer, so every address there rendered as *Unscreened*. Meanwhile three public, free,
 * on-chain lists sat readable on those very chains. This registry names them.
 *
 * Three KINDS of source, each an honest fact a member can act on:
 *
 *   fairwins-guard     `SanctionsGuard.isAllowed` — the contract that will actually REFUSE a
 *                      wager/membership/pool action. Chainalysis oracle + the operator deny list,
 *                      fail-closed. Where it says no, the transaction reverts; that is the fact.
 *   chainalysis-oracle `isSanctioned` on the Chainalysis Sanctions Oracle — the OFAC SDN list,
 *                      published on-chain by Chainalysis and maintained by them. Read DIRECTLY so
 *                      the verdict is named to its author, on chains with and without a guard.
 *   issuer-freeze      `isBlacklisted` (Circle USDC) / `isBlackListed` (Tether USDT) — the
 *                      issuer's own freeze list. A frozen address cannot receive or move that
 *                      token: the transfer reverts. This is the "funds frozen" the issue is about,
 *                      and it is a DIFFERENT list from OFAC's (issuers freeze on court orders and
 *                      law-enforcement requests that never reach the SDN list).
 *
 * ── PROVENANCE OF THE TABLES ─────────────────────────────────────────────────────────────────
 * Every address below was verified by a live read on 2026-09-06: `eth_getCode` non-empty, the
 * zero address answering `false`, and a known SDN-listed address (the Ronin-bridge exploiter,
 * `0x098B…2f96`) answering `true` on every row. A row is a CLAIM that the contract at that
 * address exposes that selector; a wrong row does not fabricate a verdict — the call reverts and
 * the source reports `unreadable` — but it would silently cost a member a source, so verify
 * before adding one. Chainalysis publishes the oracle addresses at
 * https://go.chainalysis.com/chainalysis-oracle-docs.html ; the Base deployment is at a
 * different address from the others.
 *
 * ── THE ROSTER IS NOT SIMPLY THE COHORT ──────────────────────────────────────────────────────
 * `screeningChainIds()` is the cohort MINUS local-only sandboxes, and that subtraction is the
 * whole of issue #1458's QA failure. Chain 1337 is `isTestnet: true`, so it sat in every testnet
 * build's cohort; it carries a `sanctionsGuard` in the contracts config; and its endpoint is
 * `http://127.0.0.1:8545`. From a deployed origin that read cannot ever succeed, so the testnet
 * build reported "FairWins sanctions guard on Hardhat could not be read" to every member, on
 * every address, forever — and because an unreadable source can never be a clear one (by design,
 * and rightly), the pill could never reach green there. A source a build can never reach is not
 * a degraded source, it is not a source at all.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────
 *   • No source on Ethereum Classic / Mordor beyond the guard: Chainalysis publishes no oracle
 *     there and no issuer-controlled stablecoin is in the platform's asset list. A chain with no
 *     source is REPORTED as uncovered, never counted as clear.
 *   • No off-chain risk provider (TRM, Chainalysis KYT, Elliptic). The `read(provider, account)`
 *     shape is what a BYO provider source would implement; it goes behind a member-held
 *     credential when it lands, not behind a FairWins key.
 *   • Nothing here is enforcement. The on-chain guard remains the only thing that blocks.
 */
import { getContractAddressForChain, isLocalOnlyChain } from '../../config/contracts'
import { cohortChainIds } from '../../config/networks'
import { readContract } from '../chains/readContract'

export const SOURCE_KINDS = Object.freeze({
  GUARD: 'fairwins-guard',
  ORACLE: 'chainalysis-oracle',
  ISSUER: 'issuer-freeze',
})

/** Chainalysis Sanctions Oracle, per chain. Same bytecode family; Base differs in address. */
export const CHAINALYSIS_ORACLES = Object.freeze({
  1: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
  10: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
  137: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
  42161: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
  8453: '0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B',
})

/**
 * Issuer freeze lists, per chain. `fn` is the exact selector name — Circle's FiatToken spells it
 * `isBlacklisted`, Tether's `isBlackListed`, and the two hash differently.
 *
 * Only NATIVE issuer contracts are listed: a bridged token (Polygon PoS USDT, Arbitrum bridged
 * USDT) is a different contract with no freeze function, and would report unreadable.
 */
export const ISSUER_FREEZE_LISTS = Object.freeze({
  1: [
    { symbol: 'USDC', issuer: 'Circle', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', fn: 'isBlacklisted' },
    { symbol: 'USDT', issuer: 'Tether', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', fn: 'isBlackListed' },
  ],
  10: [{ symbol: 'USDC', issuer: 'Circle', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', fn: 'isBlacklisted' }],
  137: [{ symbol: 'USDC', issuer: 'Circle', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', fn: 'isBlacklisted' }],
  8453: [{ symbol: 'USDC', issuer: 'Circle', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', fn: 'isBlacklisted' }],
  42161: [{ symbol: 'USDC', issuer: 'Circle', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', fn: 'isBlacklisted' }],
  // Circle's own Amoy testnet USDC (the platform's Amoy paymentToken) — a real FiatToken.
  80002: [{ symbol: 'USDC', issuer: 'Circle', address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', fn: 'isBlacklisted' }],
})

const GUARD_ABI = [
  'function isAllowed(address account) view returns (bool)',
  'function isDenied(address account) view returns (bool)',
]
const ORACLE_ABI = ['function isSanctioned(address addr) view returns (bool)']
const FREEZE_ABI = {
  isBlacklisted: ['function isBlacklisted(address account) view returns (bool)'],
  isBlackListed: ['function isBlackListed(address account) view returns (bool)'],
}

/**
 * @typedef {object} ScreeningSource
 * @property {string} id        stable, e.g. `chainalysis-oracle:137`
 * @property {string} kind      one of SOURCE_KINDS
 * @property {number} chainId
 * @property {string} address   the contract read
 * @property {string} label     who maintains the list, in words a member can read
 * @property {(provider: any, account: string) => Promise<{flagged: boolean, detail: string|null}>} read
 *   `provider` is the caller's availability gate, not the transport: a source already knows the
 *   chain it speaks for, so since spec 110 the read NAMES that chain rather than inheriting one
 *   from whatever connection it was handed. The signature is unchanged — a BYO provider source
 *   would still implement exactly this.
 */

function guardSource(chainId, address) {
  return {
    id: `${SOURCE_KINDS.GUARD}:${chainId}`,
    kind: SOURCE_KINDS.GUARD,
    chainId,
    address,
    label: 'FairWins sanctions guard',
    async read(provider, account) {
      const guard = (functionName) =>
        readContract(chainId, { address, abi: GUARD_ABI, functionName, args: [account] })
      // `isAllowed` is the verdict; `isDenied` only explains it. A world that answers the first
      // and not the second (the no-chain e2e tier models exactly one selector) still screens.
      const allowed = Boolean(await guard('isAllowed'))
      if (allowed) return { flagged: false, detail: null }
      let denied
      try {
        denied = Boolean(await guard('isDenied'))
      } catch {
        denied = null // the reason is a nicety; the refusal above is the fact
      }
      return {
        flagged: true,
        detail: denied
          ? 'on the FairWins deny list — the guard refuses it on-chain'
          : 'refused by the FairWins guard — a wager, membership or pool action with it reverts',
      }
    },
  }
}

function oracleSource(chainId, address) {
  return {
    id: `${SOURCE_KINDS.ORACLE}:${chainId}`,
    kind: SOURCE_KINDS.ORACLE,
    chainId,
    address,
    label: 'Chainalysis sanctions oracle',
    async read(provider, account) {
      const sanctioned = Boolean(
        await readContract(chainId, {
          address,
          abi: ORACLE_ABI,
          functionName: 'isSanctioned',
          args: [account],
        }),
      )
      return { flagged: sanctioned, detail: sanctioned ? 'on the OFAC sanctions list' : null }
    },
  }
}

function issuerSource(chainId, token) {
  return {
    id: `${SOURCE_KINDS.ISSUER}:${chainId}:${token.symbol}`,
    kind: SOURCE_KINDS.ISSUER,
    chainId,
    address: token.address,
    label: `${token.issuer} ${token.symbol} freeze list`,
    async read(provider, account) {
      const abi = FREEZE_ABI[token.fn]
      if (!abi) throw new Error(`unknown freeze selector ${token.fn}`)
      const frozen = Boolean(
        await readContract(chainId, {
          address: token.address,
          abi,
          // Circle spells it `isBlacklisted`, Tether `isBlackListed`; the two hash differently,
          // so the selector name is carried per token rather than guessed.
          functionName: token.fn,
          args: [account],
        }),
      )
      return {
        flagged: frozen,
        detail: frozen ? `frozen by ${token.issuer} — ${token.symbol} sent here cannot be moved` : null,
      }
    },
  }
}

/**
 * The chains a screen may ask: this build's cohort, minus the local-only sandboxes no shipped
 * build can reach (see the roster note in the file header).
 *
 * Still cohort-bounded — constitution III forbids a testnet build reading mainnet lists and vice
 * versa — this only removes chains whose reads are guaranteed to fail.
 *
 * @returns {number[]}
 */
export function screeningChainIds() {
  return cohortChainIds().filter((id) => !isLocalOnlyChain(id))
}

/**
 * Every source that exists for ONE chain. Empty for a chain with none — which the caller must
 * report as uncovered, not treat as clear. A non-numeric id (Bitcoin `'bitcoin'`, Solana, …) has
 * no EVM contract to read and returns [] for the same reason.
 *
 * @param {number} chainId
 * @returns {ScreeningSource[]}
 */
export function screeningSourcesFor(chainId) {
  const id = Number(chainId)
  if (!Number.isInteger(id) || id <= 0) return []
  const out = []
  let guard
  try {
    guard = getContractAddressForChain('sanctionsGuard', id)
  } catch {
    guard = null
  }
  if (guard) out.push(guardSource(id, guard))
  if (CHAINALYSIS_ORACLES[id]) out.push(oracleSource(id, CHAINALYSIS_ORACLES[id]))
  for (const token of ISSUER_FREEZE_LISTS[id] || []) out.push(issuerSource(id, token))
  return out
}
