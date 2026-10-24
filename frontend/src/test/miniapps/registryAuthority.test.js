/**
 * Curator authority reads (spec 073 T037 · FR-004, FR-022).
 *
 * One property is under test, in five shapes: **an answer we could not get is never rendered as
 * a "no"**. `APP_CURATOR_ROLE` is the platform's supply-chain gate, so the difference between
 * "the registry says you do not hold it" and "the registry did not answer" is the difference
 * between a curator accepting a verdict and a curator hunting for a permissions problem that
 * does not exist. Every failure path therefore has to land on `unverified` with a reason, and
 * `held` has to be true in exactly one case.
 *
 * The last case is the subtle one: `getRoleAdmin` is a DISCLOSURE read (it backs the sentence
 * about curation administering itself), and a failure there must not downgrade a definite
 * `hasRole` yes — that would withdraw a curator's controls over a cosmetic read.
 *
 * The chain SEAM is stubbed rather than a transport: the module's job is to classify what the
 * contract call did, and driving that through a real decoder would test the decoder instead.
 */
import { describe, it, expect, vi } from 'vitest'

const s = vi.hoisted(() => ({
  address: '0xAAaAaA00000000000000000000000000000000aA',
  provider: {},
  hasRole: async () => false,
  getRoleAdmin: async () => '0x00',
}))

vi.mock('../../config/contracts', () => ({ getContractAddressForChain: () => s.address }))
// `provider` is the route: null means this build has no way to reach the registry's chain.
vi.mock('../../lib/chains/publicClient', async (io) => ({
  ...(await io()),
  getPublicClient: () => s.provider,
}))
vi.mock('../../lib/chains/readContract', async (io) => ({
  ...(await io()),
  readContract: (_chainId, { functionName, args = [] }) => {
    if (functionName === 'hasRole') return s.hasRole(...args)
    if (functionName === 'getRoleAdmin') return s.getRoleAdmin(...args)
    throw new Error('unmocked registry read: ' + functionName)
  },
}))

import { APP_CURATOR_ROLE } from '../../abis/miniAppRegistry'
import {
  CURATOR_AUTHORITY,
  UNVERIFIED_REASON,
  readCuratorAuthority,
  readCuratorRoleAdmin,
} from '../../lib/miniapps/registryAuthority'

const ACCOUNT = '0x1111111111111111111111111111111111111111'

describe('readCuratorAuthority outcomes', () => {
  it('no account', async () => {
    const out = await readCuratorAuthority({})
    expect(out.status).toBe(CURATOR_AUTHORITY.NO_ACCOUNT)
    expect(out.held).toBe(false)
    expect(out.verified).toBe(false)
  })

  it('malformed account is treated as no account', async () => {
    expect((await readCuratorAuthority({ account: 'nope' })).status).toBe(CURATOR_AUTHORITY.NO_ACCOUNT)
  })

  it('not deployed', async () => {
    s.address = ''
    expect((await readCuratorAuthority({ account: ACCOUNT })).status).toBe(CURATOR_AUTHORITY.NOT_DEPLOYED)
    s.address = '0xAAaAaA00000000000000000000000000000000aA'
  })

  it('no route is unverified, never a denial', async () => {
    s.provider = null
    const out = await readCuratorAuthority({ account: ACCOUNT })
    expect(out.status).toBe(CURATOR_AUTHORITY.UNVERIFIED)
    expect(out.reason).toBe(UNVERIFIED_REASON.NO_ROUTE)
    expect(out.verified).toBe(false)
    expect(out.role).toBe(APP_CURATOR_ROLE)
    s.provider = {}
  })

  it('held, with self-administration disclosed', async () => {
    s.hasRole = async () => true
    s.getRoleAdmin = async () => APP_CURATOR_ROLE.toUpperCase().replace('0X', '0x')
    const out = await readCuratorAuthority({ account: ACCOUNT })
    expect(out.status).toBe(CURATOR_AUTHORITY.HELD)
    expect(out.held).toBe(true)
    expect(out.verified).toBe(true)
    expect(out.selfAdministering).toBe(true)
  })

  it('a roleAdmin failure does NOT downgrade a definite yes', async () => {
    s.hasRole = async () => true
    s.getRoleAdmin = async () => { throw new Error('nope') }
    const out = await readCuratorAuthority({ account: ACCOUNT })
    expect(out.status).toBe(CURATOR_AUTHORITY.HELD)
    expect(out.held).toBe(true)
    expect(out.roleAdmin).toBeNull()
    expect(out.selfAdministering).toBeNull()
  })

  it('definite no', async () => {
    s.hasRole = async () => false
    s.getRoleAdmin = async () => APP_CURATOR_ROLE
    const out = await readCuratorAuthority({ account: ACCOUNT })
    expect(out.status).toBe(CURATOR_AUTHORITY.NOT_HELD)
    expect(out.held).toBe(false)
    expect(out.verified).toBe(true)
  })

  it('a failed hasRole is UNVERIFIED, not "not a curator"', async () => {
    s.hasRole = async () => { throw new Error('rpc down') }
    const out = await readCuratorAuthority({ account: ACCOUNT })
    expect(out.status).toBe(CURATOR_AUTHORITY.UNVERIFIED)
    expect(out.reason).toBe(UNVERIFIED_REASON.READ_FAILED)
    expect(out.held).toBe(false)
    expect(out.verified).toBe(false)
    expect(out.error).toBeInstanceOf(Error)
  })

  it('readCuratorRoleAdmin reports ok separately from authority', async () => {
    s.getRoleAdmin = async () => APP_CURATOR_ROLE
    const admin = await readCuratorRoleAdmin()
    expect(admin.ok).toBe(true)
    expect(admin.selfAdministering).toBe(true)
    s.getRoleAdmin = async () => { throw new Error('x') }
    const bad = await readCuratorRoleAdmin()
    expect(bad.ok).toBe(false)
    expect(bad.selfAdministering).toBeNull()
  })
})
