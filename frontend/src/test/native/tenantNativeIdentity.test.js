import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Spec 102 US6 — one tenant, one app identity, no fallback. The shells carry
// EXACTLY the requested tenant's values (proven over the pure edit builder),
// and both refusal legs are exercised against the real script: an unknown
// tenant and a tenant without a native channel each fail NAMING the tenant —
// never borrowing another tenant's identity. Cross-tenant appId uniqueness is
// gated in scripts/tenants/__tests__/native-block.test.js.
import { buildFileEdits } from '../../../../scripts/native/sync-native-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SYNC = resolve(__dirname, '../../../../scripts/native/sync-native-config.js')

function runSync(tenant) {
  try {
    execFileSync(process.execPath, [SYNC, '--tenant', tenant, '--version', 'v9.9.9', '--check'], { encoding: 'utf8' })
    return { status: 0, stderr: '' }
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr) }
  }
}

describe('tenant native identity', () => {
  it('the edit set carries ONLY the requested tenant, everywhere an identity lands', () => {
    const native = {
      ios: { appId: 'app.acme.wallet' },
      android: { appId: 'app.acme.droid' },
      displayName: 'Acme Wallet',
      iconSource: 'icons/native/',
    }
    const edits = buildFileEdits({ native, version: { semver: '2.0.0', code: 2000000 }, domain: 'acme.example' })
    const replacements = edits.flatMap((e) => e.replacements.map((r) => r.replacement)).join('\n')
    expect(replacements).toContain('app.acme.wallet')
    expect(replacements).toContain('app.acme.droid')
    expect(replacements).toContain('Acme Wallet')
    expect(replacements).toContain('applinks:acme.example')
    expect(replacements).toContain('webcredentials:acme.example')
    expect(replacements).toContain('android:host="acme.example"')
    // Nothing of the default tenant leaks into another tenant's build.
    expect(replacements).not.toContain('fairwins')
    expect(replacements).not.toContain('FairWins')
  })

  it('an UNKNOWN tenant fails loudly naming it — identity never falls back', () => {
    const { status, stderr } = runSync('no-such-tenant')
    expect(status).toBe(1)
    expect(stderr).toMatch(/Unknown tenant "no-such-tenant"/)
    expect(stderr).toMatch(/NEVER falls back/)
  })

  it('a tenant WITHOUT a native block has no native channel, said in its own name', () => {
    const { status, stderr } = runSync('example')
    expect(status).toBe(1)
    expect(stderr).toMatch(/"example" has no `native` block/)
  })
})
