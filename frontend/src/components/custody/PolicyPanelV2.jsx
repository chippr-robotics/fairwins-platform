// Spec 068 (US2/US4) — the ordered-policy surface: read the live rules, stage a change (add / edit /
// remove / reorder), review a before-and-after, and propose it as the vault's own threshold-approved
// transaction.
//
// Two invariants shape this component:
//   • Nothing here changes policy directly. Every mutation becomes a Safe transaction the vault's
//     owners must approve (FR-017), so the staged list is local until the proposal is approved.
//   • Only ONE policy change may be pending per vault (FR-019). A second staged change while a
//     guard-targeted proposal sits in the queue would leave owners approving two different futures.

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  analyzeShadowing,
  buildAdoptV2Txs,
  buildRulesChangeTx,
  classifyPolicyProposalV2,
  describeRulesV2,
  findBrokenRules,
  fromV1Policy,
  getPolicyStatus,
  isPolicyV2Supported,
  readPolicyV2,
  validateRulesConfig,
} from '../../lib/custody/policyV2'
import { readPolicy } from '../../lib/custody/policy'
import { NETWORKS } from '../../config/networks'
import RuleList from './RuleList'
import RuleComposer from './RuleComposer'
import './Policy.css'

export default function PolicyPanelV2({ vault, onPropose, queue = [] }) {
  // Spec 102: the vault sheet mounts one panel PER NETWORK, so the heading id must be unique per instance.
  const titleId = useId()
  const chainId = vault?.chainId
  const [status, setStatus] = useState(null)
  const [policy, setPolicy] = useState(null)
  const [legacyPolicy, setLegacyPolicy] = useState(null)
  const [readError, setReadError] = useState(null)
  const [draft, setDraft] = useState(null) // null = not editing; else { rules, cooldown }
  const [composing, setComposing] = useState(null) // null | 'new' | index
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const supported = isPolicyV2Supported(chainId)
  const nativeSymbol = NETWORKS[Number(chainId)]?.nativeCurrency?.symbol || 'coin'

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!vault?.address || !chainId) return
      setReadError(null)
      try {
        const next = await getPolicyStatus(vault.address, chainId)
        if (cancelled) return
        setStatus(next)
        if (next === 'managed-v2') {
          const read = await readPolicyV2(vault.address, chainId)
          if (!cancelled) setPolicy(read)
        } else if (next === 'managed') {
          const read = await readPolicy(vault.address, chainId)
          if (!cancelled) setLegacyPolicy(read)
        }
      } catch (e) {
        if (!cancelled) setReadError(e?.message || 'Could not read this vault’s policy')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [vault?.address, chainId, refreshKey])

  // FR-019 — a guard-targeted proposal already awaiting approval blocks staging another.
  const pendingChange = useMemo(
    () => queue.map((p) => classifyPolicyProposalV2(p, chainId, vault?.address)).find(Boolean) || null,
    [queue, chainId, vault?.address],
  )

  const canManage = Boolean(vault?.owner && typeof onPropose === 'function')
  const liveRules = policy?.rules || []
  const draftRules = draft?.rules || []
  const owners = vault?.owners || []

  const describe = useCallback(
    (rules, cooldown) => describeRulesV2(rules, cooldown, { names: vault?.ownerNames }),
    [vault?.ownerNames],
  )

  const startEditing = () => {
    if (status === 'managed') {
      // FR-020 — upgrading from v1 pre-populates the equivalent ordered rules so the member
      // reviews a faithful translation rather than rebuilding their policy from memory.
      setDraft(fromV1Policy(legacyPolicy))
    } else {
      setDraft({ rules: liveRules, cooldown: policy?.cooldown || 0 })
    }
    setActionError(null)
    setNotice(null)
  }

  const submit = async () => {
    setActionError(null)
    setBusy(true)
    try {
      const validated = validateRulesConfig(draft.rules, draft.cooldown, { owners })
      if (status === 'managed-v2') {
        const tx = buildRulesChangeTx(chainId, validated, draft.cooldown)
        await onPropose(tx)
        setNotice('Policy change proposed. It takes effect once the vault’s owners approve it.')
      } else {
        // Attach (none) or upgrade (v1): rules first — inert until the guard is active — then the
        // guard itself, at the next nonce so the chain enforces the order.
        const [rulesTx, guardTx] = buildAdoptV2Txs(vault.address, chainId, validated, draft.cooldown)
        const first = await onPropose(rulesTx)
        await onPropose({ ...guardTx, nonce: first?.nonce != null ? first.nonce + 1 : undefined })
        setNotice(
          'Two proposals created: the rules, then switching this vault to them. Approve both, in order.',
        )
      }
      setDraft(null)
      setRefreshKey((k) => k + 1)
    } catch (e) {
      setActionError(e?.message || 'Could not propose this policy change')
    } finally {
      setBusy(false)
    }
  }

  if (!supported) {
    return (
      <section className="custody-policy" aria-labelledby={titleId}>
        <h5 id={titleId}>Policy</h5>
        <p className="custody-hint" role="status">
          Ordered policy rules aren’t available on this network yet.
        </p>
      </section>
    )
  }

  return (
    <section className="custody-policy" aria-labelledby={titleId}>
      <h5 id={titleId}>Policy</h5>

      {readError && (
        <p className="custody-error" role="alert">
          {readError}
        </p>
      )}
      {notice && (
        <p className="custody-notice" role="status">
          {notice}
        </p>
      )}

      {/* ---------------------------------------------------------------- read view */}
      {!draft && (
        <>
          {status === 'none' && (
            <p className="custody-hint" role="status">
              This vault has no policy: any transaction its owners approve can execute.
            </p>
          )}

          {status === 'foreign' && (
            <p className="custody-hint" role="status">
              This vault is governed by a policy FairWins does not recognize. Manage it with the tool that
              created it.
            </p>
          )}

          {status === 'managed' && (
            <>
              <p className="custody-hint" role="status">
                This vault uses the earlier, unordered rules. They are still enforced exactly as before.
              </p>
              <RuleList
                rules={legacyPolicy?.assetRules || []}
                descriptions={(legacyPolicy?.assetRules || []).map((r) => ({
                  text: `at most ${r.perTxLimit} per transaction`,
                }))}
                legacy
              />
            </>
          )}

          {status === 'managed-v2' && (
            <RuleList
              rules={liveRules}
              descriptions={describe(liveRules, policy?.cooldown || 0)}
              accounting={policy?.accounting}
              broken={findBrokenRules(liveRules, owners)}
              shadowed={analyzeShadowing(liveRules)}
            />
          )}

          {canManage && (
            <div className="custody-actions">
              {pendingChange ? (
                <p className="custody-hint" role="status">
                  A policy change is already waiting for approvals. Approve or reject it before starting another,
                  so owners are never asked to approve two different policies at once.
                </p>
              ) : (
                <button type="button" onClick={startEditing}>
                  {status === 'managed-v2'
                    ? 'Change rules'
                    : status === 'managed'
                      ? 'Upgrade to ordered rules'
                      : 'Add rules'}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------------------- edit view */}
      {draft && (
        <div className="custody-policy-editor">
          <h6>Proposed policy</h6>
          <RuleList
            rules={draftRules}
            descriptions={describe(draftRules, draft.cooldown)}
            broken={findBrokenRules(draftRules, owners)}
            shadowed={analyzeShadowing(draftRules)}
            editable
            onReorder={(rules) => setDraft((d) => ({ ...d, rules }))}
            onEdit={(index) => setComposing(index)}
            onRemove={(index) =>
              setDraft((d) => ({ ...d, rules: d.rules.filter((_, i) => i !== index) }))
            }
          />

          {composing == null ? (
            <button type="button" onClick={() => setComposing('new')}>
              Add a rule
            </button>
          ) : (
            <RuleComposer
              owners={owners}
              chainId={chainId}
              nativeSymbol={nativeSymbol}
              onCancel={() => setComposing(null)}
              onSubmit={(rule) => {
                setDraft((d) => ({
                  ...d,
                  rules: composing === 'new' ? [...d.rules, rule] : d.rules.map((r, i) => (i === composing ? rule : r)),
                }))
                setComposing(null)
              }}
            />
          )}

          <div className="custody-field">
            <label htmlFor="policy-cooldown">Minimum minutes between fund movements</label>
            <input
              id="policy-cooldown"
              type="number"
              min={0}
              value={Math.round((draft.cooldown || 0) / 60)}
              onChange={(e) => setDraft((d) => ({ ...d, cooldown: Math.max(0, Number(e.target.value) || 0) * 60 }))}
            />
          </div>

          {/* FR-018 — before/after, including order, in the member's own language. */}
          <div className="custody-policy-diff">
            <div>
              <h6>Now</h6>
              <RuleList rules={liveRules} descriptions={describe(liveRules, policy?.cooldown || 0)} />
            </div>
            <div>
              <h6>After approval</h6>
              <RuleList rules={draftRules} descriptions={describe(draftRules, draft.cooldown)} />
            </div>
          </div>

          {draftRules.length === 0 && (
            <p className="custody-warning" role="alert">
              With no rules, this policy denies every transaction until the owners change it again. Add at least one
              rule unless you mean to freeze the vault.
            </p>
          )}
          <p className="custody-hint">
            Changing rules restarts their 24-hour windows, and the new policy applies only after the vault’s owners
            approve this proposal.
          </p>

          {actionError && (
            <p className="custody-error" role="alert">
              {actionError}
            </p>
          )}
          <div className="custody-actions">
            <button type="button" onClick={submit} disabled={busy}>
              {busy ? 'Proposing…' : 'Propose policy change'}
            </button>
            <button type="button" className="custody-link" onClick={() => setDraft(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
