import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'

/*
 * THE AUDIT-CLAIM GATE (issue #1613).
 *
 * Nobody has audited these contracts. No firm was engaged, no report exists.
 * The README lede nonetheless said the platform runs "on audited,
 * deterministically deployed smart contracts", the tenants section promised
 * "the same audited contracts", `docs/index.md` repeated it, and the LIVE
 * landing page told visitors their money would "run self-custody on audited
 * contracts".
 *
 * That is not marketing enthusiasm, it is a false statement about a security
 * property, made to people deciding whether to put funds at risk — the one
 * claim a platform that escrows money must never make loosely.
 *
 * Removing the four sentences was the easy half. The hard half is that this
 * kind of copy regrows: someone writes a confident sentence about the
 * contracts, "audited" is the word that sounds right, and nothing objects. A
 * convention decays; a gate does not. So the word is refused in the four
 * member-facing surfaces unless it is plainly about SOMEONE ELSE'S audit.
 *
 * WHAT IS ALLOWED, and why the allowance is narrow:
 *   · third-party subjects (OpenZeppelin, Safe, Lido, @noble, @scure, …) —
 *     those projects really are audited, and saying so is true and useful;
 *   · "audit log", "audit trail", "auditable", "audit records" — a different
 *     word entirely, about record-keeping, not assurance;
 *   · the README's own Assurance status section, which exists to state that
 *     NO audit has happened and must therefore be able to use the word.
 *
 * WHAT IS REFUSED: any sentence putting "audited" next to our own contracts.
 *
 * If an audit is ever commissioned, this gate is not the obstacle — add the
 * firm, date, scope and report link to the README's Assurance status section
 * and extend ALLOWED_SUBJECTS. The point is that the claim costs a deliberate
 * edit, not an adjective.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../../..')

/** The surfaces a prospective member or customer actually reads. */
const GUARDED = [
  'README.md',
  'docs/index.md',
  'frontend/src/components/LandingPage.jsx',
  'frontend/src/legal/risk-disclosure.md',
]

/**
 * Third parties whose audits are real. A line naming one of these is making a
 * claim about THEM, which is true, and is left alone.
 */
const ALLOWED_SUBJECTS = [
  'openzeppelin', 'oz ', 'safe v1.4.1', 'safe multisig', 'lido', 'polygon',
  '@noble', '@scure', 'entrypoint', 'eth-infinitism', 'morpho', 'uniswap',
  'across', 'chainalysis', 'third-party', 'third party',
]

/** "audit log" / "audit trail" / "auditable" are record-keeping, not assurance. */
const RECORD_KEEPING = /audit(?:\s+(?:log|trail|record|entry|entries))|auditab(?:le|ility)|audited\s+to\s+the/i

/** The one place that must be able to say the word, because it says NO. */
const DISCLAIMER = /not\s+been\s+audited|no\s+(?:external|third[- ]party)\s+(?:firm|audit)|an\s+audit,\s+if\s+any/i

/**
 * The README's "Assurance status" section is skipped WHOLESALE, not line by line.
 *
 * It is the section whose entire job is to say no audit has happened, so it uses the word
 * repeatedly and most of its lines carry no disclaimer phrase of their own ("...and no audit
 * report exists", "audits, not to ours"). Matching per line would either fail the gate on the
 * one section that is telling the truth, or force a disclaimer clause into every sentence of it.
 *
 * Skipping the section is safe because of what bounds it: it ends at the next heading, so a new
 * claim written anywhere ELSE in the README is still caught. Deleting the section does not
 * disable the gate either — it just removes the exemption.
 */
const SECTION_START = /^#{2,4}\s+Assurance status\s*$/
const SECTION_END = /^#{1,4}\s+/

function withoutAssuranceSection(lines) {
  const out = []
  let inside = false
  for (const entry of lines) {
    if (!inside && SECTION_START.test(entry.line)) { inside = true; continue }
    if (inside) {
      if (SECTION_END.test(entry.line)) inside = false
      else continue
    }
    out.push(entry)
  }
  return out
}

function offendingLines(text) {
  return withoutAssuranceSection(
    text.split('\n').map((line, i) => ({ line, n: i + 1 })),
  )
    .filter(({ line }) => /\baudit(ed|s|ing)?\b/i.test(line))
    .filter(({ line }) => !RECORD_KEEPING.test(line))
    .filter(({ line }) => !DISCLAIMER.test(line))
    .filter(({ line }) => {
      const lower = line.toLowerCase()
      return !ALLOWED_SUBJECTS.some((s) => lower.includes(s))
    })
}

describe('no unsupported audit claims (#1613)', () => {
  for (const rel of GUARDED) {
    it(`${rel} does not claim our own contracts are audited`, () => {
      const full = resolve(REPO, rel)
      // A guarded file that has moved is a gate that silently stopped guarding.
      expect(existsSync(full), `${rel} is missing — update GUARDED`).toBe(true)

      const offenders = offendingLines(readFileSync(full, 'utf8'))
      const report = offenders
        .map(({ line, n }) => `  ${relative(REPO, full)}:${n}  ${line.trim()}`)
        .join('\n')

      expect(
        offenders,
        offenders.length
          ? `Unsupported audit claim — no third-party audit of these contracts exists.\n` +
            `Say what is true ("internally reviewed", "Slither/Medusa in CI"), or, if an\n` +
            `audit was commissioned, record firm/date/scope/report in the README's\n` +
            `"Assurance status" section and extend ALLOWED_SUBJECTS here.\n\n${report}\n`
          : '',
      ).toEqual([])
    })
  }

  /*
   * NON-VACUITY. Every assertion above passes on an empty file, so without this
   * the gate would keep reporting success after a regex change silently stopped
   * matching anything — the failure mode that makes a guard worse than none.
   */
  it('still catches the sentences this gate was built for', () => {
    const sentences = [
      'on audited, deterministically deployed smart contracts',
      'tenant-salted deployments of the same audited contracts',
      'Payments, trading, custody, and yield run self-custody on audited contracts',
      'Our contracts have been fully audited.',
    ]
    for (const s of sentences) {
      expect(offendingLines(s), `should have been refused: ${s}`).toHaveLength(1)
    }
  })

  it('leaves true third-party and record-keeping uses alone', () => {
    const fine = [
      'Idle assets deployed into audited third-party lending vaults, liquid staking',
      'built on audited OpenZeppelin Governor + Timelock',
      'All authority stays in the audited Safe v1.4.1 contracts',
      'activity is auditable end to end',
      'immutable audit records',
      'with a proposal flow and full audit trail',
      '**These contracts have not been audited by a third party.**',
      'An audit, if any, reduces but does not eliminate this risk.',
    ]
    for (const s of fine) {
      expect(offendingLines(s), `should have been allowed: ${s}`).toHaveLength(0)
    }
  })
})
