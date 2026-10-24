import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ETHERS_ALLOWLIST } from '../../../eslint-ethers-allowlist.js'

// The ethers import ratchet's hygiene gate (spec 110, Phase 0 — issue #1591).
//
// The lint rule in eslint.config.js already fails a NEW ethers import outside the allowlist.
// What lint cannot see is the other direction: a file that was converted but left ON the list
// is headroom — a place where an ethers import could quietly return without any gate firing.
// So: every allowlist entry must still import ethers (no stale entries), and — belt beside the
// lint suspender — every shipped src file importing ethers must be listed.

// vitest runs with cwd = frontend (the workspace member root)
const frontendRoot = process.cwd()

const importsEthers = (path) => /from\s+['"]ethers['"]/.test(readFileSync(path, 'utf8'))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!p.includes(`${join('src', 'test')}`)) walk(p, out)
    } else if (/\.(js|jsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

describe('ethers import ratchet (eslint-ethers-allowlist.js)', () => {
  it('carries no stale entries — a converted file leaves the list in the same PR', () => {
    const stale = ETHERS_ALLOWLIST.filter((rel) => !importsEthers(join(frontendRoot, rel)))
    expect(stale).toEqual([])
  })

  it('lists every shipped src file that still imports ethers', () => {
    const listed = new Set(ETHERS_ALLOWLIST)
    const unlisted = walk(join(frontendRoot, 'src'))
      .map((p) => p.slice(frontendRoot.length + 1).replace(/\\/g, '/'))
      .filter((rel) => !listed.has(rel) && importsEthers(join(frontendRoot, rel)))
    expect(unlisted).toEqual([])
  })

  it('only ever shrinks from the Phase 0 baseline', () => {
    expect(ETHERS_ALLOWLIST.length).toBeLessThanOrEqual(134)
  })
})
