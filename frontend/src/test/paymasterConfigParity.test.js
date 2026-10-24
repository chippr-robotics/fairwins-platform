/**
 * The frontend must point at the account stack the deploy actually recorded.
 *
 * WHY THIS EXISTS. `deployments/amoy-chain80002-v2.json` recorded a verifying paymaster
 * (spec 050) at 0xA00A06ae…b6898, but AMOY_CONTRACTS in `config/contracts.js` never gained the
 * key — so the admin console told operators "No verifying paymaster is deployed on Polygon
 * Amoy" while the deployment record, the source of truth (CLAUDE.md: `deployments/` — recorded
 * on-chain addresses), said otherwise. Nothing failed: an absent key is indistinguishable from
 * an honest "not deployed here" until someone compares the two files. This test is that
 * comparison, for the ERC-4337 account stack (verifyingPaymaster / entryPoint /
 * accountFactory), in the same shape as `subgraphNetworksParity.test.js`.
 *
 * The rule is one-directional on purpose:
 *   - a key RECORDED in a deployment record MUST resolve to the same address in the frontend
 *     (a silent mismatch would sign UserOps against, or sponsor from, the wrong contract);
 *   - a key ABSENT from (or null in) the record MAY be absent/empty in contracts.js — absence
 *     is an honest "not deployed on this chain", and the frontend is allowed to say so.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getContractAddressForChain } from '../config/contracts'

const DEPLOYMENTS_DIR = path.resolve(__dirname, '../../../deployments')
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// The spec-041/050 account stack. Keys share names between the deployment records and
// contracts.js, so the map is identity — kept explicit anyway so a future rename on either
// side has to be stated here rather than silently dropping the check.
const ACCOUNT_STACK_KEYS = ['verifyingPaymaster', 'entryPoint', 'accountFactory']

// One v2 record per chain lives at the top of deployments/ (`<network>-chain<id>-v2.json`) —
// the same file `sync:frontend-contracts` prefers (findDeploymentFile). Tenant records under
// deployments/tenants/ resolve through their own generated sets, never contracts.js, so they
// are out of scope here.
const recordFiles = fs
  .readdirSync(DEPLOYMENTS_DIR)
  .filter((f) => /-chain\d+-v2\.json$/.test(f))
  .sort()

const records = recordFiles.map((file) => {
  const record = JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS_DIR, file), 'utf8'))
  return { file, chainId: Number(record.chainId), contracts: record.contracts || {} }
})

const cases = records.flatMap(({ file, chainId, contracts }) =>
  ACCOUNT_STACK_KEYS.filter((key) => contracts[key]).map((key) => ({
    file,
    chainId,
    key,
    recorded: contracts[key],
  })),
)

describe('deployments/*-v2.json ↔ contracts.js account-stack parity (spec 050)', () => {
  it('found v2 deployment records to check', () => {
    expect(recordFiles.length).toBeGreaterThan(0)
  })

  it('every record carries a usable numeric chainId matching its filename', () => {
    for (const { file, chainId } of records) {
      expect(Number.isFinite(chainId), `${file} has no numeric chainId`).toBe(true)
      expect(chainId, `${file} names chain ${file.match(/-chain(\d+)-/)[1]} but records chainId ${chainId}`)
        .toBe(Number(file.match(/-chain(\d+)-/)[1]))
    }
  })

  // At least one chain must actually exercise the paymaster leg — if every record drops the
  // key, the per-key parity below vacuously passes while checking nothing spec-050 cares about.
  it('at least one deployment record carries a verifyingPaymaster', () => {
    expect(
      cases.some((c) => c.key === 'verifyingPaymaster'),
      'no v2 record carries verifyingPaymaster — the spec-050 leg of this gate is checking nothing',
    ).toBe(true)
  })

  it.each(cases)(
    '$file: recorded $key is a real address',
    ({ file, chainId, key, recorded }) => {
      expect(
        ADDRESS_RE.test(recorded),
        `chain ${chainId} (${file}): recorded ${key} "${recorded}" is not a 20-byte hex address`,
      ).toBe(true)
    },
  )

  it.each(cases)(
    '$file: frontend resolves the recorded $key on chain $chainId',
    ({ file, chainId, key, recorded }) => {
      const resolved = getContractAddressForChain(key, chainId)
      // A recorded key the frontend cannot resolve is the Amoy bug: the deploy happened, the
      // record says so, and the app renders "not deployed" — an honest-looking wrong answer.
      expect(
        resolved,
        `chain ${chainId} (${file}): deployment record has ${key}=${recorded} but the frontend ` +
          `NETWORK_CONTRACTS map for chain ${chainId} resolves none — add the key to that chain's ` +
          `block in frontend/src/config/contracts.js`,
      ).toBeTruthy()
      expect(
        String(resolved).toLowerCase(),
        `chain ${chainId} (${file}): frontend ${key} disagrees with the deployment record`,
      ).toBe(String(recorded).toLowerCase())
    },
  )
})
