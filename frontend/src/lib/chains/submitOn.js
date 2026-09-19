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
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Is this signer ACTUALLY on `target`, or does it merely exist?
 *
 * A truthy signer is not a settled one. The wallet context's `chainId` updates from the
 * connector's `chainChanged` event, while the chain-scoped signer is rebuilt by an async effect a
 * beat later — so the snapshot can pair the NEW chain with the PRE-switch signer, still bound to a
 * provider whose static network is the old chain. ethers rejects that with `network changed: A =>
 * B` **only after broadcasting**, which is the worst possible moment: the member has signed, and
 * the error arrives with the transaction already gone.
 *
 * This check came from `useWrapNative` (spec 108), which had met the race and written it down.
 * T026 extracted the shared loop from the three hooks that had NOT met it, so the shared one was
 * the weaker of the two; this closes that.
 *
 * A signer with no provider to ask is the ABSENCE of a check, not a failed one — it is accepted,
 * exactly as it was before. Waiting for an answer that can never come would spin to the deadline
 * and refuse a write that was fine.
 */
async function signerIsOn(signer, target) {
  const getNetwork = signer?.provider?.getNetwork
  if (typeof getNetwork !== 'function') return true
  try {
    const net = await signer.provider.getNetwork()
    return num(net?.chainId) === target
  } catch {
    // Provider mid-teardown, or still bound to the old chain. Not an answer — keep waiting.
    return false
  }
}

/**
 * Land the wallet on `chainId`, then return the SETTLED wallet snapshot. Exported because the
 * three hooks that grew their own copy of this loop — `useEarnSend`, `useActiveAccount`,
 * `useVaultDeployment` — do not all end in one `submitOn` payload: a vault deployment settles once
 * and then sends a deploy plus N rule installs off the same signer. They need the loop, not the
 * whole seam, so the loop is the thing that is shared (T026).
 *
 * `readWallet()` must return the CURRENT snapshot, not one captured at tap time: a network switch
 * spans renders, so a closure captured when the button was pressed still holds the pre-switch
 * signer. Every copy of this loop kept a ref for exactly that reason and it is the part most
 * easily lost in a rewrite.
 *
 * A passkey session is not waited on for a chain-scoped signer (`needsSigner: false`) — it has no
 * key in the browser, so waiting for one would spin to the deadline and refuse a write that was
 * fine.
 *
 * @param {number} chainId
 * @param {object} io
 * @param {() => object} io.readWallet
 * @param {(chainId: number) => Promise<unknown>} [io.switchNetwork]
 * @param {(chainId: number|null) => string} io.chainName  strict lookup — never a default-network
 *   fallback, which would name the wrong chain in the one sentence that has to be right.
 * @param {boolean} [io.needsSigner]
 * @param {string} [io.subject]  the noun the refusal opens with ("This proposal", "This
 *   deployment"). The three surfaces were each saying something slightly different and only the
 *   NOUN differed; unifying the sentence and keeping the noun loses nothing a member reads.
 * @param {(ms: number) => Promise<void>} [io.sleep]
 * @returns {Promise<object>} the settled wallet snapshot
 * @throws {ChainSwitchRefused}
 */
export async function settleWalletOn(
  chainId,
  { readWallet, switchNetwork, chainName, needsSigner = true, subject = 'This', sleep = defaultSleep },
) {
  const target = num(chainId)
  const here = num(readWallet()?.chainId)
  if (here === target) return readWallet()

  const refusal = () =>
    new ChainSwitchRefused(
      `${subject} goes to ${chainName(target)}, but the wallet stayed on ${chainName(here)}, so nothing has been signed.`,
      { from: here, to: target },
    )
  if (typeof switchNetwork !== 'function') throw refusal()

  try {
    await switchNetwork(target)
  } catch (cause) {
    const err = refusal()
    err.cause = cause
    throw err
  }

  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  for (;;) {
    const now = readWallet() || {}
    if (num(now.chainId) === target && (!needsSigner || (now.signer && (await signerIsOn(now.signer, target))))) {
      return now
    }
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
 *   the LIVE wallet snapshot (see `settleWalletOn`).
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
  const { readWallet, chainName, sleep = defaultSleep } = io
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

  const settled = await settleWalletOn(target, {
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
