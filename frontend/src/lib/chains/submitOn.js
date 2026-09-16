/**
 * `submitOn(chainId, payload)` — the ONE place a write decides which chain it lands on
 * (spec 110 Phase 2, T024 — issue #1593).
 *
 * THE PROBLEM THIS EXISTS FOR. On the read path the chain is already an argument: `readContract`
 * takes it, `eventScanHandle` takes it, and a vault on Base is read on Base whatever the wallet is
 * doing. On the WRITE path the chain has been ambient — whatever network the wallet happens to sit
 * on — so "act on that network" has meant "first go there", and three hooks grew their own copy of
 * the go-there loop. This makes the target an argument on the write path too.
 *
 * ONLY ONE OF THE THREE RAILS NEEDS A SWITCH, and that is the whole multichain win:
 *
 *   passkey   `sendPasskeyBatch({ chainId })` submits a UserOp to the TARGET chain's bundler. The
 *             member's wallet network is irrelevant and is never touched.
 *   intent    A relayed EIP-712 intent is signed against the TARGET chain's domain and handed to
 *             the relayer. Also no switch — the signature names the chain.
 *   signer    A key signs a transaction the wallet broadcasts, and a wallet broadcasts on the
 *             network it is on. This is the only rail that has to move the wallet first.
 *
 * So a passkey member acting on four networks sees no network prompts at all, and a classic wallet
 * sees exactly one per chain change. Routing a rail that does not need a switch through one anyway
 * is a prompt the member did not have to be asked for.
 *
 * REFUSAL RULES, because a half-done switch is worse than a refused one:
 *   · A refusal NAMES BOTH CHAINS — where the wallet is and where the write was going. "Wrong
 *     network" is not actionable; "this goes to Base, the wallet stayed on Polygon" is.
 *   · A refusal SIGNS NOTHING. Every throw below happens before any rail is handed the payload.
 *   · Availability is settled BEFORE the tap wherever the caller asks (`resolveWriteRail`), so the
 *     member is told a rail cannot run instead of discovering it inside a failed submit.
 *
 * THE CONSTANTS ARE DECIDED ONCE HERE. The three copies this replaces disagreed — 20s/150ms in
 * `useActiveAccount` and `useEarnSend`, 30s/250ms in `useVaultDeployment` — which meant the same
 * wallet on the same chain could be given ten extra seconds depending on which button was pressed.
 * Nothing chose that; it is what happens when a loop is copied.
 */

import { RAILS, resolveWriteRail } from './writeRail'

/** How long a wallet is given to land on the target chain after it AGREED to switch. */
export const SETTLE_TIMEOUT_MS = 20_000
/** How often the wallet snapshot is re-read while waiting for it to settle. */
export const SETTLE_POLL_MS = 150

export { RAILS }

/**
 * Raised when the write could not be placed on the target chain. Carries both chains so a surface
 * can render its own sentence without re-deriving them from the message.
 */
export class ChainSwitchRefused extends Error {
  constructor(message, { from = null, to = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ChainSwitchRefused'
    this.from = from
    this.to = to
  }
}

const num = (v) => (v == null ? null : Number(v))

/**
 * Land the wallet on `target`, then return the SETTLED wallet snapshot.
 *
 * `readWallet()` must return the CURRENT snapshot, not one captured at tap time: a network switch
 * spans renders, so a closure captured when the button was pressed still holds the pre-switch
 * signer. Every copy of this loop kept a ref for exactly that reason and it is the part most
 * easily lost in a rewrite.
 *
 * A passkey session is not waited on for a chain-scoped signer — it has no key in the browser, so
 * waiting for one would always time out.
 */
async function settleOn(target, { readWallet, switchNetwork, chainName, needsSigner, sleep }) {
  const here = num(readWallet()?.chainId)
  if (here === target) return readWallet()

  const refusal = new ChainSwitchRefused(
    `This goes to ${chainName(target)}, but the wallet is on ${chainName(here)}, so nothing has been signed.`,
    { from: here, to: target },
  )
  if (typeof switchNetwork !== 'function') throw refusal

  try {
    await switchNetwork(target)
  } catch (cause) {
    throw new ChainSwitchRefused(refusal.message, { from: here, to: target, cause })
  }

  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  for (;;) {
    const now = readWallet() || {}
    if (num(now.chainId) === target && (!needsSigner || now.signer)) return now
    if (Date.now() > deadline) {
      throw new ChainSwitchRefused(
        `The switch to ${chainName(target)} did not complete, so nothing has been signed.`,
        { from: num(now.chainId), to: target },
      )
    }
    await sleep(SETTLE_POLL_MS)
  }
}

/**
 * Submit `payload` on `chainId`, whatever network the wallet is on.
 *
 * @param {number} chainId  the chain the write lands on. NEVER inferred from the wallet.
 * @param {{calls: Array<{to: string, data?: string, value?: bigint}>}} payload
 * @param {object} io  the seam's dependencies — every one injectable so the rail choice and the
 *   refusal wording are testable with no wallet, no network and no React.
 * @param {() => {chainId: number|null, signer: object|null, provider: object|null}} io.readWallet
 *   the LIVE wallet snapshot (see `settleOn`).
 * @param {(chainId: number) => Promise<unknown>} [io.switchNetwork]
 * @param {string|null} [io.loginMethod]  informational only — the rail comes from the SIGNER
 *   (see `resolveWriteRail`), never from how the member logged in.
 * @param {string|null} [io.address]  the acting account, carried to whichever rail runs.
 * @param {(args: object) => Promise<unknown>} [io.sendPasskeyBatch]
 * @param {(args: object) => Promise<unknown>} [io.submitIntent]  relayed-intent rail, injected
 *   rather than imported so this seam does not pull the unconverted intent client into every
 *   caller's bundle.
 * @param {(args: object) => Promise<unknown>} io.sendWithSigner  broadcast with the settled signer.
 * @param {(chainId: number|null) => string} io.chainName  strict lookup — never a default-network
 *   fallback, which would name the wrong chain in the one sentence that has to be right.
 * @param {boolean} [io.preferIntent]  route to the relayer when it can carry this write.
 * @param {(args: object) => {rail: string, available: boolean, reason: string|null}} [io.resolveRail]
 *   the rail decision, injectable so a test can exercise the ROUTING without depending on which
 *   chains happen to carry a deployed bundler. Defaults to the real `resolveWriteRail`.
 * @returns {Promise<{rail: string, chainId: number, result: unknown}>}
 */
export async function submitOn(chainId, payload, io) {
  const target = num(chainId)
  const { readWallet, chainName, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = io
  if (target == null || !Number.isFinite(target)) {
    throw new Error('submitOn: a write must name the chain it lands on.')
  }
  if (typeof readWallet !== 'function') throw new Error('submitOn: readWallet is required.')
  if (typeof chainName !== 'function') throw new Error('submitOn: chainName is required.')

  const snapshot = readWallet() || {}
  const resolveRail = io.resolveRail ?? resolveWriteRail
  const rail = resolveRail({
    chainId: target,
    signer: snapshot.signer,
    loginMethod: io.loginMethod ?? null,
    chainName: chainName(target),
  })
  // Availability is decided before anything is signed, and the reason is the member-facing one
  // `resolveWriteRail` already wrote — this seam does not invent a second wording for it.
  if (!rail.available) throw new ChainSwitchRefused(rail.reason, { from: num(snapshot.chainId), to: target })

  // --- the two rails that carry the chain in the request, and so never move the wallet ---

  if (io.preferIntent && typeof io.submitIntent === 'function') {
    const result = await io.submitIntent({ chainId: target, address: io.address ?? null, ...payload })
    return { rail: 'intent', chainId: target, result }
  }

  if (rail.rail === RAILS.PASSKEY) {
    if (typeof io.sendPasskeyBatch !== 'function') {
      throw new Error('submitOn: the passkey rail was chosen but no sendPasskeyBatch was provided.')
    }
    const result = await io.sendPasskeyBatch({ chainId: target, address: io.address ?? null, ...payload })
    return { rail: RAILS.PASSKEY, chainId: target, result }
  }

  // --- the one rail that has to move the wallet first ---

  const settled = await settleOn(target, {
    readWallet,
    switchNetwork: io.switchNetwork,
    chainName,
    // A passkey session has no browser key to wait for; anything else must have its chain-scoped
    // signer in hand before it is asked to sign.
    needsSigner: io.loginMethod !== 'passkey',
    sleep,
  })
  if (typeof io.sendWithSigner !== 'function') {
    throw new Error('submitOn: the signer rail was chosen but no sendWithSigner was provided.')
  }
  const result = await io.sendWithSigner({
    chainId: target,
    address: io.address ?? null,
    signer: settled.signer,
    provider: settled.provider,
    ...payload,
  })
  return { rail: RAILS.SIGNER, chainId: target, result }
}
