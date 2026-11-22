/**
 * Acting as the admin Safe from the operations console, signed by an owner's key.
 *
 * The live estate's operator roles are all held by a 2-of-3 Safe whose owners include a Ledger and
 * a Trezor. The console used to ask only what the CONNECTED key held and send every write from it,
 * so an owner was refused entry and any write would have reverted. These tests pin the pieces that
 * replace that: the proposing signer, nonce reservation, the role sweep for an arbitrary address,
 * the decoder that says what an approval commits to, and the console's honest "proposed, not
 * applied" wording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, renderHook, act } from '@testing-library/react'
import { encodeFunctionData, keccak256, parseAbi, stringToHex, decodeFunctionData } from 'viem'
import { createSafeProposingSigner, nextFreeNonce } from '../../lib/admin/safeProposingSigner'
import { describeAdminCall, deviceCheck, ROLE_BY_HASH } from '../../lib/admin/describeAdminCall'
import { sweepAdminRoles } from '../../lib/admin/adminRoleSweep'
import { AdminActingContext } from '../../components/admin/adminActing/AdminActingContext'

const m = vi.hoisted(() => ({ notify: vi.fn(), roles: [], estateRead: { read: [137], unreadable: [], notDeployed: [], swept: true } }))
vi.mock('../../hooks/useUI', () => ({ useNotification: () => ({ showNotification: m.notify }) }))
vi.mock('../../hooks/useWeb3', () => ({
  useWeb3: () => ({ account: '0x1215185387E70a48b07D73AcB67002A073F18575', chainId: 137, signer: { wallet: true } }),
}))
vi.mock('../../hooks/useRoles', () => ({
  useRoles: () => ({
    hasRole: (r) => m.roles.includes(r),
    hasAnyRole: (rs) => rs.some((r) => m.roles.includes(r)),
    estateRead: m.estateRead,
    chainsForRole: () => [],
    loadRoles: vi.fn(),
  }),
}))
vi.mock('../../lib/miniapps/registryAuthority', () => ({
  readCuratorAuthority: () => Promise.resolve({ held: false, outcome: 'not-held' }),
}))

import { useAdminTx } from '../../components/admin/useAdminTx'
import { useAdminAccess } from '../../components/admin/useAdminAccess'
import AdminSafeQueue from '../../components/admin/adminActing/AdminSafeQueue'

const SAFE = '0xcf76db7aa9Fb1BFe08E010468F3344bB45830447'
const OWNER = '0x1215185387E70a48b07D73AcB67002A073F18575'
const OTHER = '0x48cBca63f764615f3f372e62d480a98F56462275'
const HUB = '0x' + '11'.repeat(20)
const TARGET = '0x' + '22'.repeat(20)
const UPGRADER = keccak256(stringToHex('UPGRADER_ROLE'))
const ACL = parseAbi(['function revokeRole(bytes32 role, address account)', 'function grantRole(bytes32 role, address account)'])
const SAFE_APPROVE = parseAbi(['function approveHash(bytes32 hashToApprove)'])

beforeEach(() => {
  m.notify.mockClear()
  m.roles = []
})

describe('nextFreeNonce — a new proposal queues BEHIND everything waiting', () => {
  it('uses the on-chain nonce when nothing is queued', () => {
    expect(nextFreeNonce({ onchainNonce: 7n })).toBe(7n)
  })
  it('goes past the highest queued nonce (same-nonce proposals cancel each other)', () => {
    expect(nextFreeNonce({ onchainNonce: 7n, queuedNonces: [7n, 9n, 8n] })).toBe(10n)
  })
  it('never reuses a nonce this session already reserved', () => {
    expect(nextFreeNonce({ onchainNonce: 7n, queuedNonces: [], lastReserved: 7n })).toBe(8n)
  })
})

describe('createSafeProposingSigner', () => {
  function setup({ simulate = vi.fn().mockResolvedValue({ data: '0x' }) } = {}) {
    const calls = []
    const ownerSigner = {
      provider: { tag: 'owner-provider' },
      sendTransaction: vi.fn(async (tx) => {
        calls.push(tx)
        return { hash: `0x${calls.length}`, wait: vi.fn().mockResolvedValue({ status: 1 }) }
      }),
    }
    const signer = createSafeProposingSigner({
      safeAddress: SAFE,
      chainId: 137,
      ownerSigner,
      hubAddress: HUB,
      safeContracts: { multiSendCallOnly: '0x' + '33'.repeat(20) },
      reserveNonce: vi.fn().mockResolvedValue(41n),
      simulate,
    })
    return { signer, ownerSigner, calls, simulate }
  }

  it('simulates FROM the Safe, publishes the preimage, then records the owner approval', async () => {
    const { signer, calls, simulate } = setup()
    const data = encodeFunctionData({ abi: ACL, functionName: 'revokeRole', args: [UPGRADER, OTHER] })
    const tx = await signer.sendTransaction({ to: TARGET, data })

    expect(simulate).toHaveBeenCalledWith({ from: SAFE, to: TARGET, data, value: 0n })
    expect(calls).toHaveLength(2)
    expect(calls[0].to.toLowerCase()).toBe(HUB) // 1 of 2: publish to the hub
    expect(calls[1].to).toBe(SAFE) // 2 of 2: approveHash on the Safe
    const approved = decodeFunctionData({ abi: SAFE_APPROVE, data: calls[1].data })
    expect(approved.args[0]).toBe(tx.safeTxHash)

    expect(tx.proposed).toBe(true)
    expect(tx.nonce).toBe(41n)
    expect(await tx.wait()).toMatchObject({ proposed: true, safeTxHash: tx.safeTxHash })
  })

  it('asks the device for NOTHING when the Safe itself could not make the call', async () => {
    const revert = Object.assign(new Error('execution reverted'), { data: '0xe2517d3f' })
    const { signer, ownerSigner } = setup({ simulate: vi.fn().mockRejectedValue(revert) })
    await expect(signer.sendTransaction({ to: TARGET, data: '0x1234' })).rejects.toBe(revert)
    expect(ownerSigner.sendTransaction).not.toHaveBeenCalled()
  })

  it('hands the nonce back when the device prompt is rejected, so no gap is left', async () => {
    const releaseNonce = vi.fn()
    const ownerSigner = { sendTransaction: vi.fn().mockRejectedValue(new Error('rejected on device')) }
    const signer = createSafeProposingSigner({
      safeAddress: SAFE, chainId: 137, ownerSigner, hubAddress: HUB,
      safeContracts: { multiSendCallOnly: '0x' + '33'.repeat(20) },
      reserveNonce: vi.fn().mockResolvedValue(41n), releaseNonce, simulate: vi.fn().mockResolvedValue({}),
    })
    await expect(signer.sendTransaction({ to: TARGET, data: '0x' })).rejects.toThrow(/rejected on device/)
    expect(releaseNonce).toHaveBeenCalledWith(41n)
  })

  it('reports the Safe as its address and refuses to sign messages (a Safe has no key)', async () => {
    const { signer } = setup()
    expect(await signer.getAddress()).toBe(SAFE)
    expect(() => signer.signMessage('hi')).toThrow(/no private key/)
  })

  it('refuses where the proposal hub is not configured, before any prompt', async () => {
    const ownerSigner = { sendTransaction: vi.fn() }
    const signer = createSafeProposingSigner({
      safeAddress: SAFE, chainId: 61, ownerSigner, hubAddress: undefined,
      safeContracts: {}, reserveNonce: vi.fn(), simulate: vi.fn(),
    })
    await expect(signer.sendTransaction({ to: TARGET, data: '0x' })).rejects.toThrow(/not configured/)
    expect(ownerSigner.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('describeAdminCall — what an approval commits to', () => {
  it('names a role revocation and flags UPGRADER as sensitive', () => {
    const data = encodeFunctionData({ abi: ACL, functionName: 'revokeRole', args: [UPGRADER, OTHER] })
    const d = describeAdminCall({ to: TARGET, data }, { chainId: 137, safeAddress: SAFE })
    expect(d.title).toBe('Revoke UPGRADER_ROLE')
    expect(d.detail).toMatch(/0x48cB…2275/)
    expect(d.critical).toBe(true)
    expect(d.recognised).toBe(true)
  })

  it('knows DEFAULT_ADMIN_ROLE is the zero hash', () => {
    expect(ROLE_BY_HASH['0x' + '00'.repeat(32)]).toBe('DEFAULT_ADMIN_ROLE')
  })

  it('says it does not recognise a call rather than guessing', () => {
    const d = describeAdminCall({ to: TARGET, data: '0xdeadbeef00' }, { chainId: 137 })
    expect(d.recognised).toBe(false)
    expect(d.title).toBe('Call 0xdeadbeef on 0x2222…2222')
  })

  it('gives the device check: approveHash selector + the hash tail', () => {
    expect(deviceCheck('0x' + 'ab'.repeat(28) + '0123abcd')).toEqual({ calldataPrefix: '0xd4d9bdcd', tail: '0123abcd' })
  })
})

describe('sweepAdminRoles — any address, three-state, no side effects', () => {
  it('finds a role held by the Safe and where', async () => {
    const probe = vi.fn(async (addr, role, chainId) =>
      role === 'ADMIN' && chainId === 137 ? { held: true, readable: true, deployed: true } : { held: false, readable: true, deployed: true },
    )
    const r = await sweepAdminRoles(SAFE, { firstChainId: 137, chains: [137, 1], probe })
    expect(r.roles).toEqual(['ADMIN'])
    expect(r.roleChains).toEqual({ ADMIN: [137] })
    expect(r.estateRead).toMatchObject({ read: [137, 1], unreadable: [], swept: true })
  })

  it('reports an unreachable chain as unreadable, never as "holds nothing"', async () => {
    const probe = vi.fn(async (addr, role, chainId) => {
      if (chainId === 1) throw new Error('timeout')
      return { held: false, readable: true, deployed: true }
    })
    const r = await sweepAdminRoles(SAFE, { chains: [137, 1], probe })
    expect(r.estateRead.unreadable).toEqual([1])
    expect(r.estateRead.read).toEqual([137])
  })
})

describe('the console speaks for the account it ACTS as', () => {
  const wrapperWith = (acting) =>
    function Wrapper({ children }) {
      return <AdminActingContext.Provider value={acting}>{children}</AdminActingContext.Provider>
    }

  it('grants entry on the Safe\'s roles when the owner key holds none of its own', () => {
    m.roles = [] // the Ledger itself holds nothing
    const acting = {
      actingAccount: SAFE,
      actingSigner: {},
      roleSweep: { roles: ['ADMIN'], roleChains: { ADMIN: [137] }, estateRead: { read: [137], unreadable: [], notDeployed: [], swept: true } },
      retrySweep: vi.fn(),
    }
    const { result } = renderHook(() => useAdminAccess(), { wrapper: wrapperWith(acting) })
    expect(result.current.entryState).toBe('granted')
    expect(result.current.flags.isAdmin).toBe(true)
  })

  it('without the provider, nothing changes: the wallet\'s own roles decide', () => {
    m.roles = []
    const { result } = renderHook(() => useAdminAccess())
    expect(result.current.entryState).toBe('denied')
  })

  it('says "proposed — not applied" for a Safe proposal, never the success message', async () => {
    const acting = { mode: 'safe', actingAccount: SAFE, actingSigner: {}, roleSweep: null }
    const { result } = renderHook(() => useAdminTx(), { wrapper: wrapperWith(acting) })
    let ok
    await act(async () => {
      ok = await result.current.runTx(
        async () => ({ proposed: true, nonce: 41n, wait: async () => ({ proposed: true, nonce: 41n }) }),
        'Role revoked',
      )
    })
    expect(ok).toBe('proposed') // truthy, but never mistaken for APPLIED
    expect(m.notify).not.toHaveBeenCalledWith('Role revoked', 'success')
    expect(m.notify).toHaveBeenCalledWith(expect.stringMatching(/Proposed to the admin Safe at nonce 41 — not applied yet/), 'info')
  })

  it('tells a Safe-mode operator with no owner key what is missing', async () => {
    const acting = { mode: 'safe', actingAccount: SAFE, actingSigner: null, roleSweep: null }
    const { result } = renderHook(() => useAdminTx(), { wrapper: wrapperWith(acting) })
    let ok
    await act(async () => {
      ok = await result.current.runTx(async () => ({}), 'x')
    })
    expect(ok).toBe(false)
    expect(m.notify).toHaveBeenCalledWith(expect.stringMatching(/key that owns the admin Safe/), 'error')
  })
})

describe('AdminSafeQueue', () => {
  const grant = encodeFunctionData({ abi: ACL, functionName: 'grantRole', args: [UPGRADER, OTHER] })
  const hash = '0x' + 'ab'.repeat(28) + '0123abcd'
  const proposal = (over = {}) => ({
    safeTxHash: hash, to: TARGET, value: 0n, data: grant, operation: 0, nonce: 41n,
    proposer: OTHER, approvers: [OTHER], approvals: 1, threshold: 2, status: 'pending',
    safeTx: { to: TARGET, value: 0n, data: grant, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
      gasToken: '0x' + '00'.repeat(20), refundReceiver: '0x' + '00'.repeat(20), nonce: 41n },
    ...over,
  })
  const acting = (over = {}) => ({
    safeAddress: SAFE, ownerAddress: OWNER, ownerSigner: { sendTransaction: vi.fn() }, chainId: 137,
    safeFacts: { state: 'read', value: { owners: [OWNER, OTHER], threshold: 2, nonce: 41n, isOwner: true } },
    refreshSafe: vi.fn(),
    proposals: { queue: [proposal()], loading: false, error: null, partial: false, refresh: vi.fn(), approve: vi.fn(), execute: vi.fn() },
    ...over,
  })

  it('shows what the approval commits to and the hash tail to check on the device', () => {
    render(<AdminSafeQueue acting={acting()} />)
    expect(screen.getByText(/Grant UPGRADER_ROLE/)).toBeTruthy()
    expect(screen.getByText('Sensitive')).toBeTruthy()
    expect(screen.getByText('…0123abcd')).toBeTruthy()
  })

  it('offers ONE transaction to the owner whose approval reaches the threshold', () => {
    render(<AdminSafeQueue acting={acting()} />)
    expect(screen.getByRole('button', { name: 'Approve and execute' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve only' })).toBeTruthy()
  })

  it('is view-only for a key that does not own the Safe', () => {
    const a = acting({ safeFacts: { state: 'read', value: { owners: [OTHER], threshold: 2, nonce: 41n, isOwner: false } } })
    render(<AdminSafeQueue acting={a} />)
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    expect(screen.getByText(/is not an owner of this Safe/)).toBeTruthy()
  })

  it('says a queue that failed to read failed — never "nothing pending"', () => {
    const a = acting({ proposals: { queue: [], loading: false, error: 'rpc down', partial: false, refresh: vi.fn() } })
    render(<AdminSafeQueue acting={a} />)
    expect(screen.getByRole('alert').textContent).toMatch(/could not be read: rpc down/)
    expect(screen.queryByText(/Nothing is waiting/)).toBeNull()
  })
})
