// Spec 085 — reconnect a SAVED hardware account into a live, device-backed signer so the app can
// "act as" it (the spec-062 operate-as recipe). The device re-derives the address for the saved
// path and it MUST match the saved address: a different device (or a different passphrase on the
// same device) yields a different account, and silently acting as the wrong one is exactly the
// failure this check exists to prevent.
//
// Spec 110 T028 — the network is named by CHAIN ID, not handed in as a provider. The signer
// resolves its own client through the spec-069 seam, which is the same endpoint every read uses.

import { connectHardware } from './adapters'
import { HardwareSigner } from './hardwareSigner'
import { HardwareWalletError, HW_ERROR_CODES } from './errors'

const lower = (a) => String(a || '').toLowerCase()

/**
 * @param {object} opts
 * @param {{ address: string, vendor: string, path: string }} opts.entry
 * @param {number} [opts.chainId] the network the signer will act on; omitted, it can sign but not send
 * @param {import('viem').PublicClient} [opts.client] injectable for tests
 * @returns {Promise<HardwareSigner>}
 */
export async function connectHardwareAccount({ entry, chainId, client }) {
  if (!entry?.address || !entry.vendor || !entry.path) {
    throw new HardwareWalletError(HW_ERROR_CODES.UNKNOWN, 'This saved hardware account is incomplete.')
  }
  const session = await connectHardware(entry.vendor)
  let derived
  try {
    derived = (await session.getAddress(entry.path)).address
  } catch (err) {
    await session.close().catch(() => {})
    throw err
  }
  if (lower(derived) !== lower(entry.address)) {
    await session.close().catch(() => {})
    throw new HardwareWalletError(
      HW_ERROR_CODES.UNKNOWN,
      'The connected device does not hold this account — it derives a different address for the saved path. Check that it is the same device (and passphrase, if you use one).',
    )
  }
  return new HardwareSigner(session, { path: entry.path, address: entry.address }, { chainId, client })
}
