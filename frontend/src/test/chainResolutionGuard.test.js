import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression guard for spec 008 (FR-011): user-facing code MUST resolve contract addresses and
 * providers against an EXPLICIT chain — never the build-time default
 * (`getContractAddress(name)` / argless `getProvider()`).
 *
 * ── WHY "EXPLICIT" AND NOT "THE WALLET'S CONNECTED CHAIN" (spec 071) ────────────────────────
 * This comment used to say the rule was "the wallet's CONNECTED chain". That is no longer what
 * the code does, and a guard whose stated reason contradicts the code it guards teaches the next
 * reader to distrust it. There are now three legitimate explicit chains:
 *
 *   • the WALLET's chain      — for wallet-scoped state (balances, the member's own positions)
 *   • the REFERENCE chain     — for membership, which lives in exactly one place per cohort
 *                               (spec 071 FR-003; `membershipChainId()`)
 *   • the SCOPED chain        — for operator views, which read a network the operator picks
 *                               rather than the one the wallet sits on (spec 071 FR-013)
 *
 * The mechanical check below is UNCHANGED and still passes: all three go through
 * `getContractAddressForChain(name, id)` / `getProvider(id)` / `getReadProvider(id)`. What the
 * guard forbids is the build-time default, and that is still forbidden everywhere.
 *
 * This scans the source and fails when a user-facing file contains MORE
 * build-time-bound calls than its documented allowlist baseline. The allowlist
 * captures the only acceptable uses:
 *   - "fallback"  — used solely in a catch / `chainId == null` branch when the
 *                   provider/wallet can't report a chain (disconnected state)
 *   - "resolver"  — the chain-aware resolver's own build-time fallback
 *   - "legacy"    — targets a v1 contract not deployed on v2; migration deferred
 *
 * A NEW build-bound call (count above baseline) or any such call in a
 * not-listed file FAILS this test. When a legacy file is later migrated, its
 * count drops below baseline and the test fails too — forcing the baseline to be
 * tightened (kept honest). Update ALLOW with a justification when intentional.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['hooks', 'components', 'pages', 'utils', 'data', 'contexts']

// getContractAddress( but NOT getContractAddressForChain( (different token), and
// not a `.getContractAddress(` method call.
const RE_ADDR = /(?<![\w.])getContractAddress\(/g
// bare argless getProvider() — not `x.getProvider()` and not getProvider(chainId)
const RE_PROV = /(?<![\w.])getProvider\(\s*\)/g

// file (relative to src/) -> { addr, prov } baseline of accepted occurrences
const ALLOW = {
  // resolver fallbacks (hasRoleOnChain / getUserTierOnChain / fetchFriendMarketsForUser),
  // the generic getContract() helper, and legacy v1 reads (tierRegistry /
  // roleManager / paymentProcessor / registerZKKey) not deployed on v2.
  // +1 (spec 022): checkApprovalNeeded's legacy-path paymentProcessor pre-flight,
  // mirroring purchaseRoleWithStablecoin's own legacy fallback (MM path is
  // chain-aware via getContractAddressForChain).
  'utils/blockchainService.js': { addr: 12, prov: 2 },
  // catch-branch fallbacks in getKeyRegistryContract + registerEncryptionKey
  'utils/keyRegistryService.js': { addr: 4, prov: 0 },
  // catch-branch fallback in screenAddress
  'utils/sanctionsScreen.js': { addr: 1, prov: 0 },
  // expireStaleWagers catch + createFriendMarket resolve() fallback
  'hooks/useFriendMarketCreation.js': { addr: 2, prov: 0 },
  // legacy: treasuryVault not deployed on v2 (module-scope address)
  'hooks/useTreasuryVault.js': { addr: 1, prov: 0 },
  // legacy: nullifierRegistry not deployed on v2 (module-scope address)
  'hooks/useNullifierContracts.js': { addr: 1, prov: 0 },
  // legacy: v1 friendGroupMarketFactory event source (not deployed on v2). The five build-time
  // `getProvider()` calls are GONE since spec 110 — reads name the chain through the seam — and the
  // baseline is tightened to 0 rather than left at 5, because a stale ceiling permits a regression
  // it was only ever meant to record. The remaining `getContractAddress(` is the module-scope
  // address for a contract no live network configures.
  'data/wagers/EventsSource.js': { addr: 1, prov: 0 },
  // open-challenge hooks (spec 024): chain-aware via getContractAddressForChain(name, chainId|execChainId),
  // each with a getContractAddress fallback for the disconnected-wallet case (same pattern as blockchainService).
  'hooks/useOpenChallengeAccept.js': { addr: 2, prov: 0 },
  'hooks/useOpenChallengeCreate.js': { addr: 1, prov: 0 },
}

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'test') continue
      out.push(...walk(full))
    } else if (/\.(jsx?|tsx?)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe('chain resolution guard (spec 008, FR-011)', () => {
  it('no build-time-bound contract/provider resolution beyond the documented allowlist', () => {
    const offenders = []
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(SRC, d))) {
        const rel = file.slice(SRC.length + 1).split('\\').join('/')
        const code = readFileSync(file, 'utf8')
        const addr = (code.match(RE_ADDR) || []).length
        const prov = (code.match(RE_PROV) || []).length
        const allowed = ALLOW[rel] || { addr: 0, prov: 0 }
        if (addr !== allowed.addr || prov !== allowed.prov) {
          offenders.push(
            `${rel}: getContractAddress(=${addr} (allowed ${allowed.addr}), ` +
              `getProvider()=${prov} (allowed ${allowed.prov})`
          )
        }
      }
    }
    expect(
      offenders,
      'Build-time-bound resolution drift detected. Use getContractAddressForChain(name, chainId) ' +
        'or getProvider(chainId); if the change is intentional (a justified fallback or a migration), ' +
        'update the ALLOW baseline in this file:\n  ' + offenders.join('\n  ')
    ).toEqual([])
  })
})
