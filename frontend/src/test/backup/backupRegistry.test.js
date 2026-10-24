/**
 * The backup pointer registry's own encoder (spec 032), which until spec 110 T028 had no direct
 * test at all — every suite that touched it mocked the whole module, so nothing checked the bytes
 * it produced or the arguments it accepted.
 *
 * That gap is exactly where the ethers→viem swap could have done silent damage. `setPointer` takes
 * a STRING, and `""` is this contract's documented "clear the pointer" value. `new Interface(...)
 * .encodeFunctionData` threw for any non-string; viem's `encodeFunctionData` STRINGIFIES instead,
 * so `undefined` encodes as `""` (erases the member's backup locator) and `null` as the
 * four-character CID `"null"` (a pointer that resolves to nothing while reading, on every surface,
 * as a backup that exists). Neither throws, neither is visible, and both are unrecoverable by the
 * member. The refusal is restored explicitly and asserted here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Interface } from 'ethers'
import { BACKUP_POINTER_REGISTRY_ABI } from '../../abis/backupPointerRegistry'

const REGISTRY = '0x1111111111111111111111111111111111111111'
const h = vi.hoisted(() => ({ address: null }))
vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: () => h.address,
}))

import { buildSetPointerCall, isBackupAvailable, writePointer } from '../../lib/backup/backupRegistry'

beforeEach(() => {
  h.address = REGISTRY
})

describe('buildSetPointerCall', () => {
  // The ethers Interface is kept here ON PURPOSE as a live cross-library byte check over the exact
  // encoder this migration replaced — converting it to viem would assert that viem agrees with
  // itself. (This file is under src/test/**, outside the import ratchet.)
  const iface = new Interface(BACKUP_POINTER_REGISTRY_ABI)

  it('encodes byte-identically to the ethers Interface it replaced', () => {
    for (const cid of ['', 'Qm', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'a'.repeat(1000)]) {
      expect(buildSetPointerCall(cid).data).toBe(iface.encodeFunctionData('setPointer', [cid]))
    }
  })

  it('targets the configured registry address', () => {
    expect(buildSetPointerCall('Qm').target).toBe(REGISTRY)
  })

  it('REFUSES a non-string cid instead of stringifying it into the member’s pointer', () => {
    for (const bad of [null, undefined, 123, {}, [], true]) {
      expect(() => buildSetPointerCall(bad)).toThrow(TypeError)
    }
  })

  it('still accepts "" — clearing the pointer is a real thing a member does', () => {
    expect(buildSetPointerCall('').data).toBe(iface.encodeFunctionData('setPointer', ['']))
  })

  it('refuses before it encodes, so a bad call never reaches a signer', async () => {
    const signer = { sendTransaction: vi.fn() }
    await expect(writePointer(signer, undefined)).rejects.toThrow(TypeError)
    expect(signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('throws honestly when the registry is not deployed, rather than encoding against nothing', () => {
    h.address = null
    expect(isBackupAvailable()).toBe(false)
    expect(() => buildSetPointerCall('Qm')).toThrow(/not available/i)
  })
})
