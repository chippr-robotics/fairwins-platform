// Spec 111 — the Sigil vendor behind the spec-085 adapter seam.
//
// Sigil is a 2-of-2 MPC ECDSA signer: the cold half is presignature shares on a floppy disk, the
// agent half sits behind `sigil-daemon` on the member's computer, and the browser reaches the daemon
// through `sigil-bridge` on loopback (services/sigil-bridge). The daemon signs a raw 32-byte prehash
// and returns `r||s` — no recovery id, no transaction building, no EIP-191/712 awareness.
//
// That shape decides how this adapter works:
//
//   * EVERY DIGEST IS COMPUTED HERE. keccak(unsigned tx), EIP-191 `hashMessage`, and the EIP-712
//     `0x1901 ‖ domainSeparator ‖ hashStruct` are all built in the browser from the same bytes the
//     rest of the app (and `HardwareSigner`) already builds, so nothing about what is signed depends
//     on Sigil understanding an encoding. Only the 32-byte hash and a human description cross.
//   * `v` IS NEVER TRUSTED FROM THE TRANSPORT — there is none to trust. It is recovered by trying
//     both parities against the disk's public key. A signature that recovers to NEITHER is refused
//     (a wrong disk, a wrong digest, a broken daemon): the adapter itself is a recover-and-verify
//     gate, for messages and typed data as well as for transactions.
//   * ONE ACCOUNT PER DISK. There are no derivation paths; the "path" saved in the spec-085 store is
//     `sigil:<child id>`, which is what lets reconnect say "that is a different disk" instead of
//     "a different address".
//   * Every signature spends one presignature. The count is read and shown before the member saves
//     the account, and an empty disk is refused BY NAME by the bridge before anything is spent.

import {
  concat,
  hashMessage,
  keccak256,
  recoverAddress,
  serializeSignature,
  getAddress,
} from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { HardwareWalletError, HW_ERROR_CODES } from './errors'

export const SIGIL_PATH_PREFIX = 'sigil:'
const STATUS_TIMEOUT_MS = 10_000
// Generous on purpose: with `--confirm` a human answers a terminal prompt before the daemon signs.
const SIGN_TIMEOUT_MS = 180_000

export const sigilPathFor = (childId) => `${SIGIL_PATH_PREFIX}${childId}`
export const childIdFromPath = (path) =>
  typeof path === 'string' && path.startsWith(SIGIL_PATH_PREFIX) ? path.slice(SIGIL_PATH_PREFIX.length) : null

const err = (code, message, cause) => new HardwareWalletError(code, message, { vendor: 'sigil', cause })

/** The EVM address a compressed secp256k1 public key controls. */
export function addressFromCompressedKey(publicKey) {
  const hex = String(publicKey || '').replace(/^0x/i, '')
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(hex)) {
    throw err(HW_ERROR_CODES.UNKNOWN, 'The Sigil disk reported a public key this app cannot read.')
  }
  const uncompressed = secp256k1.Point.fromHex(hex).toHex(false)
  return getAddress(publicKeyToAddress(`0x${uncompressed}`))
}

/** Map a bridge refusal to the one sentence that names its remedy. */
function bridgeFailure(status, body) {
  const code = body?.error?.code
  const serverMessage = body?.error?.message
  switch (code) {
    case 'unauthorized':
      return err(HW_ERROR_CODES.SIGIL_NOT_PAIRED)
    case 'origin_not_allowed': {
      const here = typeof window !== 'undefined' ? window.location.origin : 'this site'
      return err(
        HW_ERROR_CODES.SIGIL_NOT_PAIRED,
        `The Sigil bridge does not allow ${here}. Restart sigil-bridge with --allow-origin ${here}, then try again.`,
      )
    }
    case 'daemon_unreachable':
      return err(HW_ERROR_CODES.SIGIL_DAEMON_DOWN)
    case 'daemon_timeout':
      return err(HW_ERROR_CODES.TIMEOUT, 'The Sigil daemon did not answer in time. Check that it is running, then try again.')
    case 'no_disk':
      return err(HW_ERROR_CODES.SIGIL_NO_DISK)
    case 'disk_exhausted':
      return err(HW_ERROR_CODES.SIGIL_DISK_EXHAUSTED)
    case 'disk_invalid':
      return err(HW_ERROR_CODES.SIGIL_DISK_INVALID)
    case 'wrong_disk':
      return err(HW_ERROR_CODES.SIGIL_WRONG_DISK)
    case 'operator_declined':
      return err(HW_ERROR_CODES.USER_CANCELLED, 'The signature was declined at the Sigil bridge. Nothing was signed.')
    case 'daemon_refused':
      // The daemon's own sentence (e.g. rollback detected) is operator-facing and specific; it is
      // prefixed so the member knows which component refused. It never carries key material.
      return err(HW_ERROR_CODES.UNKNOWN, `The Sigil daemon refused the request: ${String(serverMessage || 'no reason given')}.`)
    default:
      return err(HW_ERROR_CODES.UNKNOWN, `The Sigil bridge answered ${status}${code ? ` (${code})` : ''}. Nothing was signed.`)
  }
}

/**
 * Open a session with the local Sigil bridge.
 * @param {{ url: string, token: string, fetchImpl?: typeof fetch }} config
 */
export async function connectSigil({ url, token, fetchImpl } = {}) {
  if (!url || !token) throw err(HW_ERROR_CODES.SIGIL_NOT_PAIRED, 'Pair with your Sigil bridge first: enter its address and pairing token.')
  const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a))

  async function call(route, body, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await doFetch(`${url}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
        // The bridge is on this computer; never send cookies or follow a redirect elsewhere.
        credentials: 'omit',
        redirect: 'error',
      })
    } catch (e) {
      if (e?.name === 'AbortError') throw err(HW_ERROR_CODES.TIMEOUT, 'The Sigil bridge did not answer in time. Nothing was signed.', e)
      throw err(HW_ERROR_CODES.SIGIL_BRIDGE_UNREACHABLE, undefined, e)
    } finally {
      clearTimeout(timer)
    }
    let json = null
    try {
      json = await res.json()
    } catch {
      /* a non-JSON answer is handled as a bare status below */
    }
    if (!res.ok || !json?.ok) throw bridgeFailure(res.status, json)
    return json
  }

  let account = null // { childId, publicKey, address }

  async function readDisk() {
    const { disk } = await call('/v1/status', {}, STATUS_TIMEOUT_MS)
    if (!disk?.detected) throw err(HW_ERROR_CODES.SIGIL_NO_DISK)
    if (!disk.publicKey) throw err(HW_ERROR_CODES.SIGIL_DAEMON_OUTDATED)
    const address = addressFromCompressedKey(disk.publicKey)
    return { ...disk, address }
  }

  async function accountFor(path) {
    const disk = await readDisk()
    const wanted = childIdFromPath(path)
    if (wanted && wanted !== disk.childId) throw err(HW_ERROR_CODES.SIGIL_WRONG_DISK)
    account = { childId: disk.childId, publicKey: disk.publicKey, address: disk.address }
    return { disk, account }
  }

  let lastPresigIndex = null

  /** Ask Sigil to sign a 32-byte digest; return `{ r, s, yParity }` verified against the disk key. */
  async function signDigest(path, digest, { chainId = 0, description }) {
    const { account: acct } = account && childIdFromPath(path) === account.childId
      ? { account }
      : await accountFor(path)
    const res = await call(
      '/v1/sign',
      { digest, chainId: Number(chainId) || 0, description, expectedPublicKey: acct.publicKey },
      SIGN_TIMEOUT_MS,
    )
    const sig = String(res.signature || '').replace(/^0x/i, '')
    if (!/^[0-9a-fA-F]{128}$/.test(sig)) throw err(HW_ERROR_CODES.UNKNOWN, 'The Sigil bridge returned an unreadable signature.')
    const r = `0x${sig.slice(0, 64)}`
    const s = `0x${sig.slice(64)}`
    for (const yParity of [0, 1]) {
      const recovered = await recoverAddress({ hash: digest, signature: { r, s, yParity } })
      if (getAddress(recovered) === acct.address) {
        lastPresigIndex = Number.isInteger(res.presigIndex) ? res.presigIndex : null
        return { r, s, yParity, presigIndex: res.presigIndex, presigsRemaining: res.presigsRemaining ?? null }
      }
    }
    throw err(
      HW_ERROR_CODES.UNKNOWN,
      'The Sigil signature does not verify against this disk’s key. Nothing was broadcast.',
    )
  }

  // Connecting reads the disk once so the connect step can fail with the real reason (no bridge,
  // not paired, no disk, outdated daemon) instead of at the first signature.
  const initial = await readDisk()
  account = { childId: initial.childId, publicKey: initial.publicKey, address: initial.address }

  return {
    vendor: 'sigil',
    transport: 'sigil-bridge',

    async getAddress(path) {
      const { account: acct } = await accountFor(path)
      return { address: acct.address }
    },

    async getAddresses(paths) {
      const { disk } = await accountFor(null)
      return paths.map((path) => ({ path, address: disk.address }))
    },

    /**
     * Sigil has one account per disk, so the add flow shows it with its budget instead of paging
     * through derivation paths. Optional in the adapter interface; the sheet checks for it.
     */
    async describeAccounts() {
      const { disk } = await accountFor(null)
      return [
        {
          path: sigilPathFor(disk.childId),
          address: disk.address,
          detail: {
            childId: disk.childId,
            presigsRemaining: disk.presigsRemaining,
            presigsTotal: disk.presigsTotal,
            daysUntilExpiry: disk.daysUntilExpiry,
            valid: disk.valid,
          },
        },
      ]
    },

    async signPersonalMessage(path, messageBytes) {
      const digest = hashMessage({ raw: messageBytes })
      const { r, s, yParity } = await signDigest(path, digest, {
        description: `personal_sign (EIP-191), ${messageBytes.length} bytes`,
      })
      return serializeSignature({ r, s, yParity })
    },

    async signTransaction(path, unsignedSerialized, txFields = {}) {
      const digest = keccak256(unsignedSerialized)
      const to = txFields.to ? String(txFields.to) : 'contract creation'
      const value = txFields.value ? BigInt(txFields.value).toString() : '0'
      const hasData = txFields.data && txFields.data !== '0x'
      const { r, s, yParity } = await signDigest(path, digest, {
        chainId: txFields.chainId,
        description: `tx chain ${txFields.chainId ?? '?'} to ${to} value ${value} wei${hasData ? ' +calldata' : ''}`,
      })
      // HardwareSigner normalizes v through yParityFrom(); a 0/1 parity is accepted on every type.
      return { r, s, v: yParity }
    },

    async signTypedData(path, { domainSeparator, hashStructMessage, primaryType, domain }) {
      const digest = keccak256(concat(['0x1901', domainSeparator, hashStructMessage]))
      const { r, s, yParity } = await signDigest(path, digest, {
        chainId: domain?.chainId != null ? Number(domain.chainId) : 0,
        description: `typed data (EIP-712) ${primaryType || ''} for ${domain?.name || 'unnamed domain'}`.trim(),
      })
      return serializeSignature({ r, s, yParity })
    },

    /**
     * Best-effort: write the broadcast hash into the disk's usage log for the presignature that
     * signed it, so reconciliation at the mother device can match every burn to a transaction.
     * Never throws — a failed note never un-sends a transaction.
     */
    async noteBroadcast(txHash) {
      const presigIndex = lastPresigIndex
      lastPresigIndex = null
      if (presigIndex == null || !/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) return false
      try {
        await call('/v1/tx-hash', { presigIndex, txHash }, STATUS_TIMEOUT_MS)
        return true
      } catch {
        return false
      }
    },

    async close() {},
  }
}
