/**
 * MiniAppReviewTab (spec 073 T038, US4 · FR-004, FR-004a, FR-004b, FR-022) — the curator's
 * review queue for the on-chain mini-app registry.
 *
 * This is the surface where a human decides which third-party code a member's browser is
 * allowed to execute. Four rules shape every line of it, and each is a hole if reversed.
 *
 * **1. A DECISION NAMES THE BYTES THAT WERE REVIEWED (FR-004a).** `approveApp` and
 * `rejectProposal` are content-committed: they carry the `manifestHash` the curator saw, and
 * the chain reverts `StaleProposal` if the record no longer holds it. That guard only works
 * if the hash this UI submits is the hash it DISPLAYED, so the tuple is captured from the
 * rendered record and passed through unmodified. A vendor can otherwise swap the package while
 * a multisig collects signatures — or simply front-run the approving transaction — and have
 * unreviewed code marked Approved. `StaleProposal` is consequently a FIRST-CLASS outcome here,
 * not an error toast: it means "the vendor changed the package", so the record is refreshed,
 * the stale verification is discarded, and the curator must re-review before the control comes
 * back.
 *
 * **2. VERIFICATION HAPPENS BEFORE APPROVAL, AND IT NEVER EXECUTES THE PACKAGE (FR-022).**
 * `verifyMiniAppPackage` runs the launch path's own fetch → keccak(manifest) → parse →
 * per-file sha-256 chain (it is literally the same function, minus the final Blob `import()`),
 * so "verified" here means the same thing the host will mean at launch. Approving bytes nobody
 * could verify is the failure mode this platform exists to prevent, so a proven hash mismatch
 * BLOCKS approval outright — that tuple could never launch — and any other failure requires an
 * explicit, recorded acknowledgement.
 *
 * **3. AUTHORITY COMES FROM THE REGISTRY, NOT FROM BEING AN ADMIN.** `APP_CURATOR_ROLE`
 * administers itself on-chain precisely so a platform administrator cannot grant it. Controls
 * are therefore offered only on a definite `hasRole` yes (`registryAuthority.js`), and the
 * three ways of not getting them — no account, an unread registry, a definite no — say which
 * one happened. An unread registry must never render as "you are not a curator": that sends a
 * curator hunting for a permissions problem that does not exist.
 *
 * **4. STATUS IS NOT THE SERVING DECISION.** `status` is the REVIEW state; `launchable` is the
 * chain's answer to "may a host run this?". A Pending record CAN be launchable — a live app
 * with an update in review, still serving its last reviewed package (FR-003) — so both are
 * displayed, separately and labelled, and neither is derived from the other. A reviewer
 * suspending an app needs to know it is live right now; a reviewer approving one needs to know
 * what is live versus what is being asked for.
 *
 * The registry lives on ONE chain (`miniAppChainId()`, FR-025), so there is no network picker:
 * reads always go to that chain, and a write requires the wallet to be there — re-checked at
 * submit time, not only in the disabled attribute, because a wallet that switched networks
 * between render and click would otherwise sign against a registry the curator was not looking
 * at.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { encodeFunctionData } from 'viem'
import { errorParser } from '../../lib/evm/revertParser'
import { normalizeAbi } from '../../lib/chains/readContract'

import { APP_CATEGORY_LABELS, AppStatus, MINI_APP_REGISTRY_ABI } from '../../abis/miniAppRegistry'
import { captureMiniAppLog } from '../../data/ledger/sources/miniAppSource'
import { extractRevert } from '../../lib/chain/revertError'
import { networkName } from '../../lib/chains/estate'
import { VERIFICATION_FAILURE, verifyMiniAppPackage } from '../../lib/miniapps/loader'
import {
  CURATOR_AUTHORITY,
  UNVERIFIED_REASON,
  readCuratorAuthority,
} from '../../lib/miniapps/registryAuthority'
import {
  REGISTRY_STATUS,
  UNREACHABLE_REASON,
  appNamespaceKey,
  appSlug,
  clearCatalogCache,
  fetchCatalog,
  registryLocation,
} from '../../lib/miniapps/registryClient'
// The mini-app section's shared stylesheet. Imported here for the `.miniapp-review` block at its
// foot, which fixes the contrast of the admin `warning-text` treatment on this surface — see the
// comment there for why the fix is scoped rather than applied to every admin tab.
import '../miniapps/miniapps.css'

/** Review-state labels. Never used to decide whether an app is being served — see rule 4. */
const STATUS_LABELS = {
  [AppStatus.PENDING]: 'Pending review',
  [AppStatus.APPROVED]: 'Approved',
  [AppStatus.SUSPENDED]: 'Suspended',
  [AppStatus.DEPRECATED]: 'Retired',
}

/**
 * The four lifecycle writes, as the audit trail names them.
 *
 * `host:` prefixed because these are entries the HOST wrote about an app, not entries an app
 * wrote about itself — the same reservation `hostContext.jsx` enforces, which is what keeps
 * "a curator did this" distinguishable from "the app claims this happened".
 */
const AUDIT_KIND = Object.freeze({
  approve: 'host:curator_approved',
  reject: 'host:curator_rejected',
  suspend: 'host:curator_suspended',
  deprecate: 'host:curator_deprecated',
})

/** Addresses and digests are shown short, with the full value on the element. */
function shortHex(value, lead = 10, tail = 8) {
  const text = typeof value === 'string' ? value : ''
  return text.length > lead + tail + 1 ? `${text.slice(0, lead)}…${text.slice(-tail)}` : text || '—'
}

/** A `uint64` block timestamp as something a reviewer can read, or an honest dash. */
function formatTimestamp(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return new Date(value * 1000).toLocaleString()
}

/**
 * Passed to every registry write so `runTx` can name the OTHER refusals — `NotVendor`,
 * `InvalidStatus`, `AppNotFound` — instead of reporting "unknown custom error" for a revert this
 * ABI describes (issue #1267). `StaleProposal` is intercepted before that, because it is an
 * outcome with consequences rather than only a message.
 */
const registryTxOptions = Object.freeze({ errorAbi: MINI_APP_REGISTRY_ABI })

/**
 * The registry's own fragments, used to decode a revert the wallet did not decode for us.
 *
 * Built on first failure rather than at import: a curator who never hits a revert never pays for
 * it, and nothing at module scope depends on it.
 */
let registryErrorInterface = null
function registryInterface() {
  if (!registryErrorInterface) registryErrorInterface = errorParser(MINI_APP_REGISTRY_ABI)
  return registryErrorInterface
}

/**
 * Decode `StaleProposal(bytes32 expected, bytes32 actual)` off a failed write, or null.
 *
 * ethers puts a decoded custom error on `error.revert` only when it held the ABI where the call
 * failed — true of a `staticCall`, NOT of a write through the injected wallet, which forwards the
 * node's revert as raw bytes on `error.data` (issue #1267). Reading `.revert` alone therefore lost
 * this message on the exact path a curator uses, so raw bytes are decoded against the registry ABI
 * too — the ABI already carries the fragment, so this is a decode, not new data.
 *
 * Anything that does not decode to `StaleProposal` is NOT a stale proposal — reading a generic
 * revert as one would tell a curator the vendor swapped the package when the transaction in fact
 * ran out of gas.
 */
function decodeStaleProposal(error) {
  const revert = extractRevert(error, registryInterface())
  if (revert?.name !== 'StaleProposal') return null
  const args = revert.args ?? []
  const expected = args[0] != null ? String(args[0]) : null
  const actual = args[1] != null ? String(args[1]) : null
  return { expected, actual }
}

/**
 * The tuple a curator is deciding about, and which action it belongs to.
 *
 * `approveApp` promotes the PROPOSED tuple when there is one, and otherwise reinstates the
 * retained APPROVED tuple (a suspended app coming back). The contract checks the hash of
 * whichever of those it is about to use, so this mirrors that choice exactly — a UI that always
 * sent `proposed.manifestHash` would make reinstating a suspended app impossible, and one that
 * always sent `approved.manifestHash` would fail every real promotion.
 */
function decisionTuple(app) {
  if (app?.proposed?.present) return { ref: app.proposed, kind: 'proposed' }
  if (app?.approved?.present) return { ref: app.approved, kind: 'approved' }
  return { ref: null, kind: 'none' }
}

/** Which lifecycle writes the chain would accept for this record right now. */
function offeredActions(app) {
  const status = Number(app?.status)
  const { ref } = decisionTuple(app)
  const retired = status === AppStatus.DEPRECATED
  return {
    // `approveApp` reverts InvalidStatus on an already-Approved record: approving again would
    // emit a lifecycle event reporting no change.
    approve: !retired && status !== AppStatus.APPROVED && Boolean(ref),
    // FR-004b: refusing a package must not cost the app its live version.
    reject: !retired && Boolean(app?.proposed?.present),
    // Reachable from Pending as well as Approved — a vendor must not be able to shield a live
    // package from a curator by keeping an update open.
    suspend: !retired && status !== AppStatus.SUSPENDED,
    deprecate: !retired,
  }
}

/**
 * Turn a verification outcome into the approval gate.
 *
 * The distinction that carries the weight is `INTEGRITY` versus everything else. An integrity
 * failure is PROVEN: the package at that CID is not the package the record's hash names, so
 * nothing could ever launch from that tuple and approving it would record a lie. It is blocked
 * with no override.
 *
 * Every other failure is "we could not establish that" (a gateway that would not answer) or
 * "the bytes are authentic but the package is defective" (an unreadable manifest, a host API
 * this build cannot honor). Those are judgement calls a curator is entitled to make — a
 * gateway outage must not make approvals impossible — but only deliberately, so they need an
 * explicit acknowledgement first. Silence is never consent here.
 */
function approvalGate(verification) {
  if (!verification || verification.state !== 'done') {
    return { allowed: false, blocked: false, needsAck: false, note: 'Verify the package before approving it.' }
  }
  if (verification.result.ok) return { allowed: true, blocked: false, needsAck: false, note: null }
  if (verification.result.code === VERIFICATION_FAILURE.INTEGRITY) {
    return {
      allowed: false,
      blocked: true,
      needsAck: false,
      note:
        'The package at this content address does not hash to the manifest hash on the record. ' +
        'Nothing could ever launch from this tuple, so it cannot be approved. Ask the vendor to ' +
        're-publish and submit again.',
    }
  }
  return {
    allowed: false,
    blocked: false,
    needsAck: true,
    note:
      'This package could not be verified. Approving it records an on-chain decision about bytes ' +
      'nobody has checked.',
  }
}

export default function MiniAppReviewTab({ signer, account, chainId, runTx, pendingTx }) {
  // The registry's home chain — fixed for the build (FR-025), so this is where every read goes
  // and where a write has to be signed.
  const { chainId: registryChainId, registryAddress } = useMemo(() => registryLocation(), [])
  const onRegistryChain = Number(chainId) === Number(registryChainId)
  /**
   * The wrong-network paragraph's id, so every control it disables can point AT it.
   *
   * A disabled button with its reason written somewhere further up the page is only an
   * explanation for someone who can see both at once. `aria-describedby` is what turns the
   * sentence into the button's own explanation — the same seam `SubmitAppPanel` calls
   * `blockedNote` (T047 · WCAG 3.3.2 / 4.1.2).
   */
  const networkNoteId = useId()

  /**
   * The last completed catalog read, tagged with the request it answered — the CatalogPanel
   * pattern. Pairing the outcome with its key makes "a read is in flight" derived rather than a
   * second piece of state, so a refresh never blanks the queue a curator is reading, and
   * `outcome === null` means exactly "we have never had an answer".
   */
  const [queueRead, setQueueRead] = useState({ key: -1, outcome: null })
  const [reloadKey, setReloadKey] = useState(0)
  const [authority, setAuthority] = useState(null)
  const [authorityKey, setAuthorityKey] = useState(0)

  /**
   * Per-record UI state, all keyed by the MANIFEST HASH the state is about rather than by the
   * record id.
   *
   * That is the whole TOCTOU defence on this side of the wire: when a vendor replaces a package,
   * the refreshed record carries a different hash, so a verification, an acknowledgement or a
   * deprecation confirmation captured against the OLD bytes silently stops applying. Keying by
   * id would leave a green "verified" badge sitting next to a package nobody has looked at.
   */
  const [verifications, setVerifications] = useState({}) // id -> { hash, state, result }
  const [acknowledged, setAcknowledged] = useState({}) // id -> hash the curator accepted unverified
  const [confirmingDeprecate, setConfirmingDeprecate] = useState(null) // id
  const [staleNotices, setStaleNotices] = useState({}) // id -> { expected, actual }

  const outcome = queueRead.outcome
  const refreshing = queueRead.key !== reloadKey

  useEffect(() => {
    let cancelled = false
    async function read() {
      let result
      try {
        // Always forced: a curator queue that served a 60-second memo would show decisions
        // already made and hide submissions just filed. The memo is for browsing.
        result = await fetchCatalog({ force: true })
      } catch (error) {
        // `fetchCatalog` returns outcomes rather than throwing, but a throw from underneath it
        // still means "we could not read the registry" — and the one thing it must never become
        // is an empty queue, which reads as "nothing is awaiting review".
        result = {
          status: REGISTRY_STATUS.UNREACHABLE,
          chainId: registryChainId,
          registryAddress,
          reason: UNREACHABLE_REASON.READ_FAILED,
          error,
          stale: null,
        }
      }
      if (!cancelled) setQueueRead({ key: reloadKey, outcome: result })
    }
    read()
    return () => {
      cancelled = true
    }
  }, [reloadKey, registryChainId, registryAddress])

  useEffect(() => {
    let cancelled = false
    readCuratorAuthority({ account }).then((result) => {
      if (!cancelled) setAuthority(result)
    })
    return () => {
      cancelled = true
    }
  }, [account, authorityKey])

  const isCurator = authority?.status === CURATOR_AUTHORITY.HELD

  /** Every record, newest submission last — the registry's own order is the queue's order. */
  const allApps = outcome?.status === REGISTRY_STATUS.OK ? outcome.allApps : null
  const awaiting = useMemo(
    () => (allApps || []).filter((app) => offeredActions(app).approve || offeredActions(app).reject),
    [allApps],
  )
  const settled = useMemo(() => (allApps || []).filter((app) => !awaiting.includes(app)), [allApps, awaiting])

  const refreshAll = useCallback(() => {
    // Drops the module-level catalog memo as well as re-reading here: after a lifecycle write
    // the MEMBER-facing catalog is stale too, and leaving it memoised would keep a just-suspended
    // app on the Apps tab for up to a minute (`registryClient`: "call after a curator write").
    clearCatalogCache()
    setReloadKey((key) => key + 1)
    setAuthorityKey((key) => key + 1)
  }, [])

  /**
   * Fetch and verify one record's package without executing any of it.
   *
   * The tuple is captured at call time and stored WITH the result, so a verification can never
   * be read as evidence about a different package than the one it checked.
   */
  const verify = useCallback(async (app) => {
    const { ref } = decisionTuple(app)
    if (!ref) return
    const hash = ref.manifestHash
    setVerifications((current) => ({ ...current, [app.id]: { hash, state: 'checking', result: null } }))
    const result = await verifyMiniAppPackage(
      { cid: ref.cid, manifestHash: hash },
      // The listing's own slug: a package claiming to be a different app than the record being
      // reviewed is exactly the substitution a reviewer must see, and without naming the app the
      // manifest-id check is inert.
      { expectedAppId: appSlug(app.name) },
    )
    setVerifications((current) => ({ ...current, [app.id]: { hash, state: 'done', result } }))
  }, [])

  /**
   * Send one lifecycle write.
   *
   * `runTx` owns the wallet prompt, the pending flag and the operator notification, so it stays
   * the transport; the closure below wraps the call only to (a) capture the transaction hash for
   * the audit entry and (b) intercept `StaleProposal` before it becomes a generic failure
   * message. A stale proposal is not "the transaction failed" — it is "the package changed", and
   * it has its own consequence: the record is re-read and the curator has to review again.
   */
  const submitAction = useCallback(
    async (app, action, { expectedHash = null } = {}) => {
      if (!signer) return
      // Re-checked here, not just in the disabled attribute: a wallet that switched networks
      // between render and click would otherwise sign against another chain's registry.
      if (Number(chainId) !== Number(registryChainId)) return
      if (!registryAddress) return

      // Spec 110 T028 — the calldata is built explicitly instead of through an ethers `Contract`.
      // `expectedManifestHash` is a `bytes32`, and fixed-size `bytesN` is one of the places viem
      // and ethers agree exactly: both refuse null, undefined, short, odd-length, non-hex and
      // wrong-length values (measured). The divergence-7 hazard — viem encoding a malformed value
      // where ethers refused — is DYNAMIC `bytes` only, so the content commitment spec 073 relies
      // on here (`approveApp(id, expectedManifestHash)` reverting StaleProposal) cannot be
      // weakened by the swap, and needs no guard invented for it.
      const REGISTRY_ABI = normalizeAbi(MINI_APP_REGISTRY_ABI)
      const callFor = (kind) =>
        kind === 'approve'
          ? { functionName: 'approveApp', args: [app.id, expectedHash] }
          : kind === 'reject'
            ? { functionName: 'rejectProposal', args: [app.id, expectedHash] }
            : kind === 'suspend'
              ? { functionName: 'suspendApp', args: [app.id] }
              : { functionName: 'deprecateApp', args: [app.id] }
      let txHash = null
      let stale = null

      const ok = await runTx(async () => {
        try {
          const tx = await signer.sendTransaction({
            to: registryAddress,
            data: encodeFunctionData({ abi: REGISTRY_ABI, ...callFor(action) }),
          })
          txHash = tx?.hash ?? null
          return tx
        } catch (error) {
          stale = decodeStaleProposal(error)
          if (stale) {
            // Replaced with a sentence a curator can act on. `runTx` renders
            // `shortMessage || message`, and the raw decoded revert would read as a hex pair.
            const replaced = new Error(
              `The vendor replaced this package since you opened it — the registry now holds ` +
                `${shortHex(stale.actual)}, not ${shortHex(stale.expected)}. Nothing was changed. ` +
                `Re-review the new package before deciding.`,
            )
            replaced.shortMessage = replaced.message
            throw replaced
          }
          throw error
        }
      }, actionSummary(action, app, registryChainId), registryTxOptions)

      if (stale) {
        setStaleNotices((current) => ({ ...current, [app.id]: stale }))
        // Discard everything that was about the OLD bytes. Keying by hash would already stop the
        // old verification applying once the record refreshes, but clearing it here means the
        // curator never sees a verified badge blink against a package they have not seen.
        setVerifications((current) => {
          const next = { ...current }
          delete next[app.id]
          return next
        })
        setAcknowledged((current) => {
          const next = { ...current }
          delete next[app.id]
          return next
        })
        setConfirmingDeprecate(null)
        refreshAll()
        return
      }

      if (!ok) return

      // Audit trail (FR-019/FR-020): what was decided, about which package, by which account.
      // Keyed on the transaction hash so a repeat render or a restored backup cannot inflate it.
      // Attribution uses the IMMUTABLE registry id, never the editable display name.
      captureMiniAppLog(account, registryChainId, {
        appId: appNamespaceKey(registryChainId, app.id) || `app-${registryChainId}-${app.id}`,
        kind: AUDIT_KIND[action],
        dedupeKey: txHash,
        refs: {
          registryId: app.id,
          name: app.name,
          vendor: app.vendor,
          manifestHash: expectedHash,
          txHash,
          registry: registryAddress,
        },
      })

      setStaleNotices((current) => {
        const next = { ...current }
        delete next[app.id]
        return next
      })
      setConfirmingDeprecate(null)
      refreshAll()
    },
    [signer, chainId, registryChainId, registryAddress, runTx, account, refreshAll],
  )

  /** One record card, wired to this tab's state. Shared by both sections below. */
  const renderRecord = (app) => (
    <ReviewRecord
      key={app.id}
      app={app}
      isCurator={isCurator}
      // A write needs BOTH: the registry's yes, and the wallet on the registry's chain.
      canWrite={isCurator && onRegistryChain}
      registryChainId={registryChainId}
      pendingTx={pendingTx}
      verification={verifications[app.id]}
      acknowledgedHash={acknowledged[app.id]}
      staleNotice={staleNotices[app.id]}
      confirmingDeprecate={confirmingDeprecate === app.id}
      onVerify={() => verify(app)}
      onAcknowledge={(hash, checked) =>
        setAcknowledged((current) => ({ ...current, [app.id]: checked ? hash : null }))
      }
      onAction={(action, options) => submitAction(app, action, options)}
      onConfirmDeprecate={(open) => setConfirmingDeprecate(open ? app.id : null)}
      // Only when the wallet is elsewhere: an id that resolves to nothing is worse than no
      // description at all, and the paragraph it names is rendered only in that case.
      networkNoteId={onRegistryChain ? undefined : networkNoteId}
    />
  )

  return (
    <section aria-labelledby="miniapp-review-heading" className="admin-card full-width miniapp-review">
      <div className="admin-card-header">
        <h3 id="miniapp-review-heading">Mini-app review</h3>
        {/* `aria-disabled` rather than `disabled` while the queue re-reads (T047): a control the
            member just pressed must not leave the tab order under them, or focus drops to
            <body> and they lose their place in a long queue. The handler refuses re-entry. */}
        <button
          type="button"
          className="refresh-btn"
          onClick={() => {
            if (refreshing) return
            refreshAll()
          }}
          aria-disabled={refreshing || undefined}
          aria-busy={refreshing || undefined}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <p className="card-info">
        Approving a package decides which third-party code members are allowed to run. Every
        decision is recorded on the mini-app registry on {networkName(registryChainId)}
        {registryAddress ? <> (<code title={registryAddress}>{shortHex(registryAddress, 8, 6)}</code>)</> : null}, and
        approval names the exact package hash you reviewed — if a vendor replaces it first, the
        chain refuses the decision rather than approving code nobody read.
      </p>

      <AuthorityNotice
        authority={authority}
        registryChainId={registryChainId}
        onRetry={() => setAuthorityKey((key) => key + 1)}
      />

      {isCurator && !onRegistryChain && (
        <p role="status" className="card-info" id={networkNoteId}>
          You are reading {networkName(registryChainId)} while your wallet is on {networkName(chainId)}.
          Reviewing and verifying packages work from here; recording a decision needs your wallet on{' '}
          {networkName(registryChainId)}.
        </p>
      )}

      {outcome === null && (
        <p role="status" className="card-info">
          Loading the review queue…
        </p>
      )}

      {outcome?.status === REGISTRY_STATUS.NOT_DEPLOYED && (
        <p role="status" className="card-info">
          There is no mini-app registry on {networkName(registryChainId)} in this build, so there is
          nothing to review. This is a deployment gap rather than an outage — retrying will not
          change it.
        </p>
      )}

      {outcome?.status === REGISTRY_STATUS.UNREACHABLE && (
        <p role="alert" className="card-info warning-text">
          The mini-app registry on {networkName(registryChainId)} did not answer, so the review queue
          could not be read. This is not evidence that nothing is waiting: submissions may be queued
          and simply unreadable right now.
        </p>
      )}

      {allApps && (
        <>
          {/* Two sections, one renderer: the ONLY difference between them is which records they
              hold, so wiring each list separately would be two places for a control to go
              missing from. Records awaiting a decision come first — that is the queue. */}
          <QueueSection
            id="miniapp-review-awaiting"
            title={`Awaiting a decision (${awaiting.length})`}
            apps={awaiting}
            emptyNote="The registry answered — no submission is waiting on a curator."
            renderRecord={renderRecord}
          />
          <QueueSection
            id="miniapp-review-listed"
            title={`Listed apps (${settled.length})`}
            apps={settled}
            emptyNote="No other apps are registered."
            renderRecord={renderRecord}
          />
        </>
      )}
    </section>
  )
}

/**
 * One labelled group of records.
 *
 * The empty state is a SENTENCE, not a blank list: "no submission is waiting on a curator" is a
 * claim about what the registry said, and it only appears on a section whose caller has an
 * answer to report — the unreadable and not-deployed branches never reach here.
 */
function QueueSection({ id, title, apps, emptyNote, renderRecord }) {
  return (
    <>
      <h4 id={id}>{title}</h4>
      {apps.length === 0 ? (
        <p role="status" className="card-info">
          {emptyNote}
        </p>
      ) : (
        <ul className="miniapp-review-list" aria-labelledby={id}>
          {apps.map(renderRecord)}
        </ul>
      )}
    </>
  )
}

/** The success line `runTx` shows. Names the action, the app and the chain it landed on. */
function actionSummary(action, app, registryChainId) {
  const verb =
    action === 'approve'
      ? 'Approved'
      : action === 'reject'
        ? 'Rejected the proposed package for'
        : action === 'suspend'
          ? 'Suspended'
          : 'Retired'
  return `${verb} ${app.name} on ${networkName(registryChainId)}`
}

/**
 * The five authority states, each said out loud.
 *
 * The one that matters most is `unverified`. Spec 067's router tabs stay PERMISSIVE while
 * authority is unconfirmed, on the reasoning that the contract is the real gate and withdrawing
 * an incident killswitch over an RPC timeout is worse than offering one that reverts. This
 * surface deliberately goes the other way: a lifecycle decision is not an incident lever, there
 * is no emergency in withholding it for a few seconds, and offering an approve button we cannot
 * substantiate is exactly the "disabled-looking control that reverts" the review model forbids.
 * What is NOT allowed either way is dressing the uncertainty as a denial — so the copy says the
 * question could not be put, and offers to ask again.
 */
function AuthorityNotice({ authority, registryChainId, onRetry }) {
  if (!authority) {
    return (
      <p role="status" className="card-info">
        Checking whether this account holds the curator role…
      </p>
    )
  }

  if (authority.status === CURATOR_AUTHORITY.HELD) {
    return (
      <p role="status" className="card-info">
        This account holds <code>APP_CURATOR_ROLE</code> on the mini-app registry, so lifecycle
        decisions are available.{' '}
        {authority.selfAdministering === true
          ? 'That role administers itself on-chain: platform administrators cannot grant it to themselves, and only an existing curator can add or remove one.'
          : authority.selfAdministering === false
            ? 'Note: on this deployment the curator role is NOT self-administering — another role can grant it, which is weaker than the documented design. Report this to the platform team.'
            : 'Whether the role administers itself could not be read just now.'}
      </p>
    )
  }

  if (authority.status === CURATOR_AUTHORITY.NOT_DEPLOYED) {
    return (
      <p role="status" className="card-info">
        No mini-app registry is configured on {networkName(registryChainId)} in this build, so there
        is no curator role to hold.
      </p>
    )
  }

  if (authority.status === CURATOR_AUTHORITY.NO_ACCOUNT) {
    return (
      <p role="status" className="card-info">
        No account is connected, so nobody has been checked for the curator role. The queue below is
        read-only. Connect the account that holds <code>APP_CURATOR_ROLE</code> to record decisions.
      </p>
    )
  }

  if (authority.status === CURATOR_AUTHORITY.UNVERIFIED) {
    return (
      <div role="alert" className="card-info warning-text">
        <p>
          <strong>Curator role could not be verified.</strong>{' '}
          {authority.reason === UNVERIFIED_REASON.NO_ROUTE
            ? `This build currently has no connection to ${networkName(registryChainId)}, where the mini-app registry lives.`
            : `The mini-app registry on ${networkName(registryChainId)} did not answer.`}{' '}
          This is not a statement that you lack the role — the question could not be put at all.
          Decisions are withheld until the registry answers, so that nothing is offered here that
          would fail at the wallet.
        </p>
        <button type="button" className="confirm-btn" onClick={onRetry}>
          Check again
        </button>
      </div>
    )
  }

  return (
    <p role="status" className="card-info">
      The registry reports that this account does not hold <code>APP_CURATOR_ROLE</code>, so the
      queue below is read-only. That is deliberate: the role administers itself on-chain, so it
      cannot be granted by a platform administrator — an existing curator has to grant it.
    </p>
  )
}

/**
 * One package tuple, shown in full so a reviewer can compare it with what is live.
 *
 * The prop is `tuple`, deliberately not `ref`: React reserves `ref` on every element, so a
 * `ref` prop on a function component is intercepted rather than delivered — the tuple would
 * arrive `undefined` and the card would render "no package" for a record that has one.
 */
function PackageTuple({ label, tuple, emptyNote }) {
  if (!tuple?.present) {
    return (
      <div className="miniapp-review-tuple">
        <h6>{label}</h6>
        <p className="card-info">{emptyNote}</p>
      </div>
    )
  }
  return (
    <div className="miniapp-review-tuple">
      <h6>{label}</h6>
      <dl>
        <div>
          <dt>Version</dt>
          <dd>v{tuple.version}</dd>
        </div>
        <div>
          <dt>Content id</dt>
          <dd>
            <code title={tuple.cid}>{shortHex(tuple.cid, 12, 8)}</code>
          </dd>
        </div>
        <div>
          <dt>Manifest hash</dt>
          <dd>
            <code title={tuple.manifestHash}>{shortHex(tuple.manifestHash)}</code>
          </dd>
        </div>
      </dl>
    </div>
  )
}

/** The result of a verification run, in the terms a curator decides on. */
function VerificationResult({ verification, decision }) {
  if (!verification) return null
  if (verification.state === 'checking') {
    return (
      <p role="status" className="card-info">
        Fetching the package and checking it against the hash on the record…
      </p>
    )
  }

  // Keyed by hash, so a result about superseded bytes is shown as what it is rather than as a
  // verdict on the package now on the record.
  if (decision.ref && verification.hash !== decision.ref.manifestHash) {
    return (
      <p role="alert" className="card-info warning-text">
        This verification was run against a different package than the record now holds. Verify
        again before deciding.
      </p>
    )
  }

  const { result } = verification
  if (result.ok) {
    return (
      <div role="status" className="miniapp-review-verified">
        <p>
          <strong>Package verified.</strong> The manifest at this content address hashes to the
          manifest hash on the record, and every file it declares matches its recorded digest.
          Nothing was executed — the package was checked, not run.
        </p>
        <dl>
          <div>
            <dt>Manifest id</dt>
            <dd>
              <code>{result.manifest.id}</code>
            </dd>
          </div>
          <div>
            <dt>Manifest version</dt>
            <dd>{result.manifest.version}</dd>
          </div>
          <div>
            <dt>Host API</dt>
            <dd>{result.manifest.hostApi}</dd>
          </div>
          <div>
            <dt>Declared permissions</dt>
            <dd>{result.manifest.permissions.length ? result.manifest.permissions.join(', ') : 'none'}</dd>
          </div>
          <div>
            <dt>Shared-state keys</dt>
            <dd>{result.manifest.storeKeys.length ? result.manifest.storeKeys.join(', ') : 'none'}</dd>
          </div>
          <div>
            <dt>Served by</dt>
            <dd>
              <code>{result.gateway}</code>
            </dd>
          </div>
        </dl>
        <table className="miniapp-review-files">
          <caption>Files checked ({result.files.length})</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Role</th>
              <th scope="col">SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {result.files.map((file) => (
              <tr key={file.path}>
                <td>
                  <code>{file.path}</code>
                </td>
                <td>{file.role}</td>
                <td>
                  <code title={file.sha256}>{shortHex(file.sha256)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div role="alert" className="card-info warning-text">
      <p>
        <strong>
          {result.code === VERIFICATION_FAILURE.INTEGRITY
            ? 'Package does NOT match the recorded hash.'
            : 'Package could not be verified.'}
        </strong>{' '}
        {result.userMessage}
      </p>
      <p>
        <span className="miniapp-review-code">{result.code}</span>
        {result.reason ? ` · ${result.reason}` : ''}
        {result.path ? ` · ${result.path}` : ''}
      </p>
      {result.expected && result.actual && (
        <p>
          Recorded <code title={result.expected}>{shortHex(result.expected)}</code>, package hashes to{' '}
          <code title={result.actual}>{shortHex(result.actual)}</code>.
        </p>
      )}
    </div>
  )
}

/** One registry record: what is live, what is proposed, and the decisions available. */
function ReviewRecord({
  app,
  isCurator,
  canWrite,
  registryChainId,
  pendingTx,
  verification,
  acknowledgedHash,
  staleNotice,
  confirmingDeprecate,
  networkNoteId,
  onVerify,
  onAcknowledge,
  onAction,
  onConfirmDeprecate,
}) {
  const decision = decisionTuple(app)
  const actions = offeredActions(app)
  const decisionHash = decision.ref?.manifestHash ?? null
  const acked = Boolean(decisionHash) && acknowledgedHash === decisionHash
  const checking = verification?.state === 'checking'

  // Per-record ids for the two sentences that explain a withheld control, so the control can name
  // its own reason (T047 · WCAG 3.3.2). Ids are per-record because the queue renders many cards
  // and a duplicated id would point every card's button at the first card's sentence.
  const gateNoteId = `miniapp-review-${app.id}-gate-note`
  const noPackageNoteId = `miniapp-review-${app.id}-no-package`

  /**
   * Retirement's two-step confirmation, made keyboard-survivable (T047 · WCAG 2.4.3).
   *
   * "Retire permanently…" REPLACES itself with the confirmation block, so the element holding
   * focus is destroyed by the press that opened it — focus lands on `<body>` and a keyboard
   * curator is thrown to the top of the admin page, with the warning they were meant to read now
   * somewhere below them. Cancel does the same in reverse. So focus follows the disclosure: into
   * the warning when it opens (the container, not the destructive button — the point of the
   * second step is that the curator reads it and then chooses, not that Enter twice retires an
   * app), and back to the trigger when it closes.
   */
  const confirmRef = useRef(null)
  const deprecateTriggerRef = useRef(null)
  const wasConfirming = useRef(false)
  useEffect(() => {
    if (confirmingDeprecate) confirmRef.current?.focus()
    // Only on a real close, never on mount: every card in the queue would otherwise fight for
    // focus on first render.
    else if (wasConfirming.current) deprecateTriggerRef.current?.focus()
    wasConfirming.current = confirmingDeprecate
  }, [confirmingDeprecate])
  // A verification only counts as evidence about the tuple it actually checked. Anything else —
  // a result left over from the package a vendor has since replaced — is discarded HERE, before
  // the gate sees it, so the gate can never report "allowed" about bytes that are no longer on
  // the record and the button can never be disabled without a sentence saying why.
  const verificationApplies = Boolean(decisionHash) && verification?.hash === decisionHash
  const gate = approvalGate(verificationApplies ? verification : null)
  // The DURABLE half of the approval gate only. `pendingTx` is deliberately not folded in here
  // any more: a write in flight is transient and is carried by `aria-disabled` on the button, so
  // the control the curator just pressed keeps focus. See the note above the buttons.
  const canApprove = canWrite && actions.approve && (gate.allowed || (gate.needsAck && acked))
  // An on-chain enum may gain values ahead of this build's label map. Naming the raw ordinal is
  // honest; folding an unknown category into a familiar one would misfile the app.
  const categoryLabel = APP_CATEGORY_LABELS[app.category] ?? `Category ${app.category}`

  return (
    <li className="miniapp-review-record">
      <div className="miniapp-review-record-head">
        <h5>{app.name}</h5>
        <span className="state-badge">{STATUS_LABELS[app.status] ?? `Status ${app.status}`}</span>
        {/* Review state and serving decision are different questions (rule 4). Both are shown,
            because suspending an app that is live right now is a different act from suspending
            one that has never served. */}
        <span className="state-badge">{app.launchable ? 'Serving members now' : 'Not being served'}</span>
      </div>

      <dl className="miniapp-review-meta">
        <div>
          <dt>Registry id</dt>
          <dd>{app.id}</dd>
        </div>
        <div>
          <dt>Vendor</dt>
          <dd>
            <code title={app.vendor || undefined}>{shortHex(app.vendor, 8, 6)}</code>
          </dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{categoryLabel}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>{formatTimestamp(app.submittedAt)}</dd>
        </div>
        <div>
          <dt>Last approved</dt>
          <dd>{formatTimestamp(app.approvedAt)}</dd>
        </div>
        <div>
          <dt>Last changed</dt>
          <dd>{formatTimestamp(app.updatedAt)}</dd>
        </div>
      </dl>

      {app.description && <p className="miniapp-review-description">{app.description}</p>}

      <div className="miniapp-review-tuples">
        <PackageTuple
          label="Proposed — awaiting your decision"
          tuple={app.proposed}
          emptyNote="No package is awaiting a decision on this record."
        />
        <PackageTuple
          label="Approved — what members run today"
          tuple={app.approved}
          emptyNote="No version of this app has ever been approved, so nothing is being served."
        />
      </div>

      {staleNotice && (
        <div role="alert" className="card-info warning-text">
          <p>
            <strong>The vendor replaced this package.</strong> The decision was refused on-chain and
            nothing changed: the registry now holds{' '}
            <code title={staleNotice.actual || undefined}>{shortHex(staleNotice.actual)}</code>, not the{' '}
            <code title={staleNotice.expected || undefined}>{shortHex(staleNotice.expected)}</code> you
            reviewed. The record above has been re-read — review the new package before deciding
            again.
          </p>
        </div>
      )}

      <div className="miniapp-review-actions">
        {/* Two different reasons this control can be inoperable, treated differently. A record
            with no package is a DURABLE fact — `disabled` is right, and the sentence beside it is
            named by `aria-describedby` so the refusal is reachable rather than merely adjacent. A
            verification in flight is TRANSIENT and was caused by this very press, so it stays
            focusable under `aria-disabled` and reports itself with `aria-busy`; dropping focus to
            <body> for the length of a gateway fetch is how a curator loses their place. */}
        <button
          type="button"
          className="confirm-btn"
          onClick={() => {
            if (checking) return
            onVerify()
          }}
          disabled={!decision.ref}
          aria-disabled={checking || undefined}
          aria-busy={checking || undefined}
          aria-describedby={decision.ref ? undefined : noPackageNoteId}
        >
          {checking
            ? 'Verifying…'
            : decision.kind === 'proposed'
              ? 'Verify proposed package'
              : 'Verify approved package'}
        </button>
        {!decision.ref && (
          <p className="card-info" id={noPackageNoteId}>
            This record holds no package to check — its vendor has not submitted one.
          </p>
        )}
      </div>

      <VerificationResult verification={verification} decision={decision} />

      {/* Controls exist only for a definite curator. A non-curator sees the whole record and the
          verification result — transparency is the point — but never a button that would revert. */}
      {!isCurator ? (
        <p className="card-info">Decisions are recorded by curators; this view is read-only.</p>
      ) : (
        <div className="miniapp-review-decisions">
          {/* Deprecation is terminal on-chain, so a curator looking at a retired record has no
              decisions left. Saying so is better than an empty space that reads as a rendering
              bug — and better than a disabled button that implies the state is recoverable. */}
          {Number(app.status) === AppStatus.DEPRECATED && (
            <p className="card-info">
              This app was permanently retired. The registry accepts no further lifecycle changes on
              this record, and its name stays reserved so nobody can take its identity.
            </p>
          )}

          {gate.note && actions.approve && (
            <p
              id={gateNoteId}
              className={gate.blocked ? 'card-info warning-text' : 'card-info'}
              role={gate.blocked ? 'alert' : undefined}
            >
              {gate.note}
            </p>
          )}

          {/* `gate.needsAck` is already scoped to a verification that applies to the tuple on the
              record (see `gate` above), so the box can never appear for a superseded result. */}
          {actions.approve && gate.needsAck && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={acked}
                onChange={(event) => onAcknowledge(decisionHash, event.target.checked)}
              />
              <span className="checkbox-text">
                I understand this package could not be verified, and I am approving it anyway.
              </span>
            </label>
          )}

          {/* Every lifecycle control below follows one rule (T047). `disabled` carries the
              DURABLE refusals — no curator role, the wrong wallet network, an unverified
              package — because those are states the curator has to leave before the control
              means anything, and each is named through `aria-describedby` so the reason is the
              button's own rather than a sentence that happens to be nearby. `aria-disabled`
              carries the TRANSIENT one, a write already in flight: that state was caused by the
              press itself, and a control that leaves the tab order under the finger that
              activated it drops focus to <body>. The handlers refuse re-entry, so a second
              press during a write is a no-op rather than a second transaction. */}
          {actions.approve && (
            <button
              type="button"
              className="confirm-btn primary"
              disabled={!canApprove}
              aria-disabled={pendingTx || undefined}
              aria-describedby={[gate.note ? gateNoteId : null, networkNoteId].filter(Boolean).join(' ') || undefined}
              onClick={() => {
                if (pendingTx) return
                onAction('approve', { expectedHash: decisionHash })
              }}
            >
              {decision.kind === 'proposed'
                ? `Approve v${decision.ref.version} on ${networkName(registryChainId)}`
                : `Reinstate on ${networkName(registryChainId)}`}
            </button>
          )}

          {actions.reject && (
            <button
              type="button"
              className="confirm-btn"
              disabled={!canWrite}
              aria-disabled={pendingTx || undefined}
              aria-describedby={networkNoteId}
              onClick={() => {
                if (pendingTx) return
                onAction('reject', { expectedHash: app.proposed.manifestHash })
              }}
            >
              Reject proposed v{app.proposed.version}
            </button>
          )}

          {actions.reject && (
            <p className="card-info">
              Rejecting discards the proposed package only. Any previously approved version keeps
              serving, and the vendor can submit again.
            </p>
          )}

          {actions.suspend && (
            <>
              <button
                type="button"
                className="confirm-btn danger"
                disabled={!canWrite}
                aria-disabled={pendingTx || undefined}
                aria-describedby={networkNoteId}
                onClick={() => {
                  if (pendingTx) return
                  onAction('suspend')
                }}
              >
                Suspend
              </button>
              <p className="card-info">
                {app.launchable
                  ? 'Suspending takes this app offline immediately: it disappears from the catalog and any launch — including one already in progress — is refused. It is reversible: approving the app again reinstates its approved package.'
                  : 'Suspending blocks this app from being served. It is reversible: approving the app again reinstates its approved package.'}
              </p>
            </>
          )}

          {actions.deprecate && !confirmingDeprecate && (
            <button
              type="button"
              ref={deprecateTriggerRef}
              className="confirm-btn danger"
              disabled={!canWrite}
              aria-disabled={pendingTx || undefined}
              aria-describedby={networkNoteId}
              onClick={() => {
                if (pendingTx) return
                onConfirmDeprecate(true)
              }}
            >
              Retire permanently…
            </button>
          )}

          {/* Deprecation is TERMINAL on-chain — there is no un-deprecate — so it gets a second,
              explicit step that says so in words rather than a button that looks like the others.
              `tabIndex={-1}` makes it a focus TARGET rather than a focus stop: the effect above
              sends focus here when it opens, so the warning is what a curator lands on and reads,
              and it is still not reachable by Tab from anywhere else. */}
          {actions.deprecate && confirmingDeprecate && (
            // Deliberately unnamed: `role="alert"` announces its SUBTREE, and giving the
            // container an `aria-label` is how you get some screen readers to read the label
            // instead of the warning it exists to deliver.
            <div
              role="alert"
              ref={confirmRef}
              tabIndex={-1}
              className="card-info warning-text miniapp-review-confirm"
            >
              <p>
                <strong>Retiring {app.name} is permanent.</strong> The registry has no way to undo it:
                the app can never be approved, reinstated or resubmitted under this record again, its
                pending submission is discarded, and its name stays reserved so nobody else can take
                its identity. If you only want it offline for now, suspend it instead.
              </p>
              <button
                type="button"
                className="confirm-btn danger"
                disabled={!canWrite}
                aria-disabled={pendingTx || undefined}
                aria-describedby={networkNoteId}
                onClick={() => {
                  if (pendingTx) return
                  onAction('deprecate')
                }}
              >
                Yes, retire {app.name} permanently
              </button>
              <button type="button" className="confirm-btn" onClick={() => onConfirmDeprecate(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}
