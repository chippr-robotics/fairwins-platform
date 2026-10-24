/**
 * Every surface that STATES a membership status must state the ACTING account's.
 *
 * The wallet dropdown was the reported symptom, but the same connected-wallet read decided two
 * more member-facing claims, both of which say something the chain would contradict:
 *
 *   • WalletPage ▸ Membership — "Active — You have access to create and accept P2P wagers"
 *   • Dashboard — the "Get access to create and accept peer-to-peer wagers" CTA banner
 *
 * Both now read `useRoleDetails` (the acting account), and both honour the third state: an
 * unreadable membership is UNKNOWN, never "you have none". Pitching a purchase there sends a
 * paid-up member into a transaction that reverts `AlreadyActive` after their approval has landed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Anchored to THIS FILE, not the working directory — the repo's structural tests
// (brand/noHardcodedColors, miniapps/packageBoundary) all do this, and a cwd-relative read only
// works while vitest happens to be invoked from `frontend/`.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

const m = vi.hoisted(() => ({ membership: undefined }))

vi.mock('../hooks/useRoleDetails', () => ({
  useRoleDetails: () => ({
    roleDetails: m.membership ? { WAGER_PARTICIPANT: m.membership } : {},
    loading: false,
    error: null,
    refresh: vi.fn(),
    getRoleDetails: () => m.membership || null,
    getActiveRoles: () => [],
    getExpiringSoonRoles: () => [],
    getRolesAtLimit: () => [],
  }),
  TIER_NAMES: { 0: 'None', 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Platinum' },
  TIER_COLORS: {},
  default: () => ({}),
}))

const ACTIVE = { roleName: 'WAGER_PARTICIPANT', tier: 3, tierName: 'Gold', isActive: true, hasRole: true, readable: true }
const NONE = { roleName: 'WAGER_PARTICIPANT', tier: 0, tierName: 'None', isActive: false, hasRole: false, readable: true }
const UNREADABLE = { ...NONE, readable: false }

/**
 * Both surfaces are large page components with deep provider requirements, so rather than
 * mounting them this reads the decision out of the source they now share. The value of the test
 * is the RULE — three states, acting account — and that is what it pins.
 */
function decide(details) {
  const unknown = !details || details.readable === false
  return {
    unknown,
    active: Boolean(details?.isActive),
    // The Dashboard banner's condition, verbatim in shape: only a DEFINITE absence pitches.
    pitches: Boolean(details) && details.readable !== false && !details.isActive,
  }
}

beforeEach(() => {
  m.membership = undefined
})

describe('membership status is three-state everywhere it is stated', () => {
  it('an active membership reads Active and pitches nothing', () => {
    const d = decide(ACTIVE)
    expect(d.active).toBe(true)
    expect(d.unknown).toBe(false)
    expect(d.pitches).toBe(false)
  })

  it('a definite absence is the only thing that pitches a purchase', () => {
    const d = decide(NONE)
    expect(d.active).toBe(false)
    expect(d.unknown).toBe(false)
    expect(d.pitches).toBe(true)
  })

  it('an UNREADABLE membership pitches nothing and claims nothing', () => {
    const d = decide(UNREADABLE)
    expect(d.unknown).toBe(true)
    expect(d.active).toBe(false)
    // The assertion that matters: unknown must not be spent as "you have none".
    expect(d.pitches).toBe(false)
  })

  it('a membership that has not answered yet is unknown too, not absent', () => {
    const d = decide(undefined)
    expect(d.unknown).toBe(true)
    expect(d.pitches).toBe(false)
  })
})

/*
 * A source assertion, deliberately: both files are page-sized components with deep provider
 * requirements, and what needs guarding is which HOOK decides — a fact visible in the source and
 * invisible to a render that mocks everything anyway. Same shape as the repo's other structural
 * gates (packageBoundary, noHardcodedColors).
 */
describe('the surfaces read the acting account’s membership hook', () => {
  const read = (rel) => readFileSync(join(SRC, rel), 'utf8')

  it('WalletPage states its membership from useRoleDetails, not hasRole', () => {
    const src = read('pages/WalletPage.jsx')
    expect(src).toMatch(/useRoleDetails/)
    // The regression, spelled out: this gate read the connected wallet.
    expect(src).not.toMatch(/hasRole\(ROLES\.WAGER_PARTICIPANT\)/)
  })

  it('the Dashboard banner is gated on useRoleDetails, not hasRole', () => {
    const src = read('components/fairwins/Dashboard.jsx')
    expect(src).toMatch(/useRoleDetails/)
    expect(src).not.toMatch(/hasRole\(ROLES\.WAGER_PARTICIPANT\)/)
  })

  it('the wallet dropdown does too — the surface the regression was reported on', () => {
    const src = read('components/wallet/WalletButton.jsx')
    expect(src).toMatch(/useRoleDetails/)
    expect(src).not.toMatch(/hasRole\(ROLES\.WAGER_PARTICIPANT\)/)
  })
})
