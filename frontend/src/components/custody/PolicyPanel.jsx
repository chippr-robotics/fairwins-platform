// Spec 049 (US2/US3) — the vault detail's Policy section. Reads the vault's policy status +
// rules straight from chain (FR-005/FR-014) and renders them in plain language with live state
// (window consumption, next-allowed time — FR-006). Owners get the threshold-approved management
// flows (FR-007): "propose change" with a current-vs-proposed comparison, and "attach a policy"
// for policy-less vaults, queued as configureRules FIRST then setGuard (rules are inert without
// the guard, so there is never a half-set active gap). Non-owners see rules, no actions.
// Proposals go through the existing spec 043 queue via the `onPropose` prop
// (useVaultProposals.propose), inheriting FR-009 approval binding.

import { useState, useEffect, useCallback } from 'react'
import { getAddress } from 'viem'
import { formatUnits, parseUnits } from '../../lib/evm/units'
import {
  getPolicyStatus,
  readPolicy,
  describeRules,
  validatePolicyConfig,
  buildPolicyChangeTx,
  buildSetGuardTx,
  NATIVE_ASSET,
  shortAddress,
} from '../../lib/custody/policy'
import './Policy.css'

const COOLDOWN_UNITS = [
  { key: 'minutes', label: 'minutes', seconds: 60 },
  { key: 'hours', label: 'hours', seconds: 3600 },
  { key: 'days', label: 'days', seconds: 24 * 3600 },
]

function formatAmount(asset, amount) {
  if (asset === NATIVE_ASSET) return `${formatUnits(amount, 18)} (native coin)`
  return `${amount} units of ${shortAddress(asset)}`
}

/** Split a cooldown in seconds into the largest clean unit for the edit form. */
function splitCooldown(seconds) {
  const s = Number(seconds) || 0
  if (s === 0) return { value: '', unit: 'hours' }
  for (const u of [...COOLDOWN_UNITS].reverse()) {
    if (s % u.seconds === 0) return { value: String(s / u.seconds), unit: u.key }
  }
  return { value: String(Math.ceil(s / 60)), unit: 'minutes' }
}

/**
 * The policy a config would produce, in `readPolicy` shape, so `describeRules` can render the
 * "Proposed" column. `configureRules` only touches the assets it names, so unnamed current rules
 * carry over.
 */
function projectPolicy(config, current) {
  const byAsset = new Map((current?.assetRules || []).map((r) => [r.asset.toLowerCase(), { ...r }]))
  for (const l of config.limits || []) {
    byAsset.set(String(l.asset).toLowerCase(), {
      asset: l.asset,
      perTxLimit: BigInt(l.perTxLimit ?? 0),
      windowLimit: BigInt(l.windowLimit ?? 0),
      spentInWindow: 0n,
      windowStart: 0,
      remainingInWindow: BigInt(l.windowLimit ?? 0),
    })
  }
  const assetRules = [...byAsset.values()]
  const removes = new Set((config.allowlistRemove || []).map((a) => a.toLowerCase()))
  const kept = (current?.allowlist || []).filter((a) => !removes.has(a.toLowerCase()))
  const adds = (config.allowlistAdd || []).filter((a) => !kept.some((k) => k.toLowerCase() === a.toLowerCase()))
  const allowlist = [...kept, ...adds]
  const cooldown = Number(config.cooldown || 0)
  const hasRules =
    assetRules.some((r) => r.perTxLimit > 0n || r.windowLimit > 0n) || !!config.allowlistEnabled || cooldown > 0
  return {
    hasRules,
    allowlistEnabled: !!config.allowlistEnabled,
    allowlistCount: allowlist.length,
    cooldown,
    nextAllowedAt: 0,
    allowlist,
    assetRules,
  }
}

/**
 * Rule configuration editor + review step. Edit → "Review change" (client-validated, FR-015) →
 * current-vs-proposed side by side (US3-AS1) → submit. Native limits are entered in whole coins;
 * token limits in the token's smallest (base) unit so no decimals guessing can corrupt a rule.
 */
function PolicyConfigEditor({ currentPolicy, attach, threshold, busy, onSubmit, onCancel }) {
  const nativeRule = (currentPolicy?.assetRules || []).find((r) => r.asset === NATIVE_ASSET)
  const tokenRules = (currentPolicy?.assetRules || []).filter((r) => r.asset !== NATIVE_ASSET)
  const initialCooldown = splitCooldown(currentPolicy?.cooldown)

  const [nativePerTx, setNativePerTx] = useState(nativeRule && nativeRule.perTxLimit > 0n ? formatUnits(nativeRule.perTxLimit, 18) : '')
  const [nativeWindow, setNativeWindow] = useState(nativeRule && nativeRule.windowLimit > 0n ? formatUnits(nativeRule.windowLimit, 18) : '')
  const [tokenRows, setTokenRows] = useState(
    tokenRules.map((r) => ({ address: r.asset, perTx: r.perTxLimit.toString(), window: r.windowLimit.toString() })),
  )
  const [cooldownValue, setCooldownValue] = useState(initialCooldown.value)
  const [cooldownUnit, setCooldownUnit] = useState(initialCooldown.unit)
  const [allowlistEnabled, setAllowlistEnabled] = useState(!!currentPolicy?.allowlistEnabled)
  const [removals, setRemovals] = useState([]) // existing entries ticked for removal
  const [additions, setAdditions] = useState([])
  const [newRecipient, setNewRecipient] = useState('')
  const [formError, setFormError] = useState(null)
  const [reviewConfig, setReviewConfig] = useState(null)

  const currentAllowlist = currentPolicy?.allowlist || []

  const toggleRemoval = (addr) =>
    setRemovals((r) => (r.includes(addr) ? r.filter((a) => a !== addr) : [...r, addr]))

  const addRecipient = () => {
    setFormError(null)
    try {
      const a = getAddress(newRecipient.trim())
      if (
        additions.some((x) => x.toLowerCase() === a.toLowerCase()) ||
        currentAllowlist.some((x) => x.toLowerCase() === a.toLowerCase())
      ) {
        setFormError('That recipient is already on the allowlist')
        return
      }
      setAdditions((list) => [...list, a])
      setNewRecipient('')
    } catch {
      setFormError('Enter a valid recipient address')
    }
  }

  const buildConfig = () => {
    const limits = []
    if (nativePerTx.trim() || nativeWindow.trim() || nativeRule) {
      limits.push({
        asset: NATIVE_ASSET,
        perTxLimit: nativePerTx.trim() ? parseUnits(nativePerTx.trim(), 18) : 0n,
        windowLimit: nativeWindow.trim() ? parseUnits(nativeWindow.trim(), 18) : 0n,
      })
    }
    for (const row of tokenRows) {
      if (!row.address.trim()) continue
      limits.push({
        asset: getAddress(row.address.trim()),
        perTxLimit: BigInt(row.perTx.trim() || '0'),
        windowLimit: BigInt(row.window.trim() || '0'),
      })
    }
    const cooldown = cooldownValue.trim()
      ? Number(cooldownValue.trim()) * (COOLDOWN_UNITS.find((u) => u.key === cooldownUnit)?.seconds || 1)
      : 0
    const config = {
      limits,
      cooldown,
      allowlistEnabled,
      allowlistAdd: additions,
      allowlistRemove: removals,
      allowlistAlreadyPopulated: currentAllowlist.length - removals.length > 0,
    }
    if (allowlistEnabled && currentAllowlist.length - removals.length + additions.length === 0) {
      throw new Error('Enable the allowlist with at least one recipient — an empty allowlist would block everything')
    }
    validatePolicyConfig(config)
    return config
  }

  const review = () => {
    setFormError(null)
    try {
      setReviewConfig(buildConfig())
    } catch (e) {
      setFormError(e?.message || 'Invalid policy configuration')
    }
  }

  if (reviewConfig) {
    const proposed = projectPolicy(reviewConfig, currentPolicy)
    const proposedLines = describeRules(proposed)
    const currentLines = currentPolicy?.hasRules ? describeRules(currentPolicy) : []
    return (
      <div className="custody-policy-review" role="region" aria-label="Review policy change">
        <div className="custody-policy-compare">
          <div className="custody-policy-compare-col">
            <h6>Current policy</h6>
            {currentLines.length > 0 ? (
              <ul className="custody-policy-rules">
                {currentLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="custody-hint">No rules — approvals only.</p>
            )}
          </div>
          <div className="custody-policy-compare-col">
            <h6>Proposed policy</h6>
            {proposedLines.length > 0 ? (
              <ul className="custody-policy-rules">
                {proposedLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="custody-hint">No rules — approvals only.</p>
            )}
          </div>
        </div>
        {attach ? (
          <p className="custody-hint">
            This queues two vault transactions, in order: first configure the rules (inert until the
            policy engine is attached), then activate the policy engine. Each needs
            {threshold ? ` ${threshold}` : ' the vault’s threshold of'} owner approval{threshold === 1 ? '' : 's'};
            the rules only take effect once the second transaction executes.
          </p>
        ) : (
          <p className="custody-hint">
            The change takes effect only after the vault’s approval threshold is met — co-owners will
            see this exact current-vs-proposed comparison on the queued transaction.
          </p>
        )}
        <div className="custody-actions">
          <button type="button" onClick={() => onSubmit(reviewConfig)} disabled={busy}>
            {busy ? 'Proposing…' : attach ? 'Queue both transactions' : 'Propose this change'}
          </button>
          <button type="button" className="custody-link" onClick={() => setReviewConfig(null)} disabled={busy}>
            Back to editing
          </button>
        </div>
      </div>
    )
  }

  return (
    <form className="custody-policy-editor" onSubmit={(e) => e.preventDefault()} aria-label={attach ? 'Attach a policy' : 'Edit policy rules'}>
      <fieldset>
        <legend>Spending limits — native coin</legend>
        <div className="custody-field">
          <label htmlFor="policy-native-pertx">Per-transaction limit (blank for none)</label>
          <input
            id="policy-native-pertx"
            type="text"
            inputMode="decimal"
            value={nativePerTx}
            onChange={(e) => setNativePerTx(e.target.value)}
          />
        </div>
        <div className="custody-field">
          <label htmlFor="policy-native-window">24-hour window limit (blank for none)</label>
          <input
            id="policy-native-window"
            type="text"
            inputMode="decimal"
            value={nativeWindow}
            onChange={(e) => setNativeWindow(e.target.value)}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Spending limits — tokens (amounts in the token’s smallest unit)</legend>
        {tokenRows.map((row, i) => (
          <div className="custody-policy-token-row" key={`token-row-${i}`}>
            <div className="custody-field">
              <label htmlFor={`policy-token-addr-${i}`}>Token address</label>
              <input
                id={`policy-token-addr-${i}`}
                type="text"
                placeholder="0x…"
                value={row.address}
                onChange={(e) => setTokenRows((rows) => rows.map((r, j) => (j === i ? { ...r, address: e.target.value } : r)))}
              />
            </div>
            <div className="custody-field">
              <label htmlFor={`policy-token-pertx-${i}`}>Per-transaction limit</label>
              <input
                id={`policy-token-pertx-${i}`}
                type="text"
                inputMode="numeric"
                value={row.perTx}
                onChange={(e) => setTokenRows((rows) => rows.map((r, j) => (j === i ? { ...r, perTx: e.target.value } : r)))}
              />
            </div>
            <div className="custody-field">
              <label htmlFor={`policy-token-window-${i}`}>24-hour window limit</label>
              <input
                id={`policy-token-window-${i}`}
                type="text"
                inputMode="numeric"
                value={row.window}
                onChange={(e) => setTokenRows((rows) => rows.map((r, j) => (j === i ? { ...r, window: e.target.value } : r)))}
              />
            </div>
            <button
              type="button"
              className="custody-link"
              onClick={() => setTokenRows((rows) => rows.filter((_, j) => j !== i))}
            >
              Remove token row
            </button>
          </div>
        ))}
        <div className="custody-actions">
          <button type="button" onClick={() => setTokenRows((rows) => [...rows, { address: '', perTx: '', window: '' }])}>
            Add token limit
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Recipient allowlist</legend>
        <label>
          <input type="checkbox" checked={allowlistEnabled} onChange={(e) => setAllowlistEnabled(e.target.checked)} />
          Only allow transfers to approved recipients
        </label>
        {currentAllowlist.length > 0 && (
          <ul className="custody-policy-allowlist" aria-label="Current allowlist entries">
            {currentAllowlist.map((a) => (
              <li key={a}>
                <label>
                  <input type="checkbox" checked={removals.includes(a)} onChange={() => toggleRemoval(a)} />
                  Remove <code>{a}</code>
                </label>
              </li>
            ))}
          </ul>
        )}
        {additions.length > 0 && (
          <ul className="custody-policy-allowlist" aria-label="Recipients to add">
            {additions.map((a) => (
              <li key={a}>
                <code>{a}</code>{' '}
                <button type="button" className="custody-link" onClick={() => setAdditions((list) => list.filter((x) => x !== a))}>
                  Undo add
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="custody-field">
          <label htmlFor="policy-allowlist-new">Add recipient</label>
          <input
            id="policy-allowlist-new"
            type="text"
            placeholder="0x…"
            value={newRecipient}
            onChange={(e) => setNewRecipient(e.target.value)}
          />
        </div>
        <div className="custody-actions">
          <button type="button" onClick={addRecipient}>
            Add recipient
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Transaction delay</legend>
        <div className="custody-policy-cooldown">
          <div className="custody-field">
            <label htmlFor="policy-cooldown-value">Minimum time between transactions (blank for none)</label>
            <input
              id="policy-cooldown-value"
              type="number"
              min={0}
              value={cooldownValue}
              onChange={(e) => setCooldownValue(e.target.value)}
            />
          </div>
          <div className="custody-field">
            <label htmlFor="policy-cooldown-unit">Unit</label>
            <select id="policy-cooldown-unit" value={cooldownUnit} onChange={(e) => setCooldownUnit(e.target.value)}>
              {COOLDOWN_UNITS.map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      {formError && (
        <p className="custody-error" role="alert">
          {formError}
        </p>
      )}

      <div className="custody-actions">
        <button type="button" onClick={review} disabled={busy}>
          Review {attach ? 'policy' : 'change'}
        </button>
        <button type="button" className="custody-link" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// `ariaLabel` (spec 102): the vault sheet's Details view mounts one panel PER NETWORK, and two
// landmarks with the same name are indistinguishable to a screen reader — the caller names each.
export default function PolicyPanel({ vault, onPropose, ariaLabel = 'Vault policy' }) {
  const [status, setStatus] = useState(null) // null = loading
  const [policy, setPolicy] = useState(null)
  const [readError, setReadError] = useState(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const address = vault?.address
  const chainId = vault?.chainId

  useEffect(() => {
    if (!address || chainId == null) return undefined
    let cancelled = false
    ;(async () => {
      try {
        const s = await getPolicyStatus(address, chainId)
        const p = s === 'managed' ? await readPolicy(address, chainId) : null
        if (!cancelled) {
          setStatus(s)
          setPolicy(p)
          setReadError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setStatus(null)
          setReadError(e?.message || 'Could not read the vault policy')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [address, chainId, refreshKey])

  const submit = useCallback(
    async (config) => {
      setActionError(null)
      setNotice(null)
      setBusy(true)
      try {
        if (status === 'none') {
          // Attach flow (US3-AS4): configureRules FIRST (inert without the guard), setGuard SECOND
          // (activates). The second is pinned to the next Safe nonce so it can only ever execute
          // after the rules transaction — the order is enforced on-chain, not just visually.
          const rulesTx = buildPolicyChangeTx(chainId, config)
          const guardTx = buildSetGuardTx(address, chainId)
          const first = await onPropose(rulesTx)
          const nextNonce = first?.nonce != null ? Number(first.nonce) + 1 : undefined
          await onPropose(nextNonce != null ? { ...guardTx, nonce: nextNonce } : guardTx)
          setNotice(
            'Two transactions are queued: (1) configure the rules, (2) activate the policy engine. Both need co-owner approval; the rules only take effect once the second executes.',
          )
        } else {
          await onPropose(buildPolicyChangeTx(chainId, config))
          setNotice('Policy change proposed — it takes effect once the vault’s approval threshold approves it.')
        }
        setEditing(false)
        setRefreshKey((k) => k + 1)
      } catch (e) {
        setActionError(e?.message || 'Could not propose the policy change')
      } finally {
        setBusy(false)
      }
    },
    [status, chainId, address, onPropose],
  )

  if (!vault || vault.isSafe === false) return null

  const canManage = !!vault.owner && typeof onPropose === 'function'

  return (
    <div className="custody-policy" role="region" aria-label={ariaLabel}>
      <h5>Policy</h5>

      {readError && (
        <p className="custody-error" role="alert">
          {readError}
        </p>
      )}

      {!readError && status === null && <p className="custody-hint">Checking policy…</p>}

      {status === 'unsupported' && (
        <p className="custody-hint">
          Policy rules aren’t supported on this network. Custody works as usual — transactions need
          owner approvals only.
        </p>
      )}

      {status === 'foreign' && (
        <p className="custody-hint">
          This vault has rules set by another interface — manage them with the interface that
          created them.
        </p>
      )}

      {status === 'none' && (
        <>
          <p className="custody-hint">No policy — transactions need owner approvals only.</p>
          {canManage && !editing && (
            <div className="custody-actions">
              <button type="button" onClick={() => setEditing(true)}>
                Attach a policy
              </button>
            </div>
          )}
        </>
      )}

      {status === 'managed' && policy && !editing && (
        <>
          {policy.hasRules ? (
            <ul className="custody-policy-rules" aria-label="Active policy rules">
              {describeRules(policy).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="custody-hint">The policy engine is attached but no rules are configured.</p>
          )}

          {policy.assetRules.some((r) => r.windowLimit > 0n) && (
            <>
              <h6 className="custody-policy-subtitle">Current 24-hour window</h6>
              <ul className="custody-policy-live" aria-label="Window consumption">
                {policy.assetRules
                  .filter((r) => r.windowLimit > 0n)
                  .map((r) => (
                    <li key={r.asset}>
                      {formatAmount(r.asset, r.spentInWindow)} of {formatAmount(r.asset, r.windowLimit)} used ·{' '}
                      {formatAmount(r.asset, r.remainingInWindow)} remaining
                    </li>
                  ))}
              </ul>
            </>
          )}

          {policy.nextAllowedAt > 0 && policy.nextAllowedAt * 1000 > Date.now() && (
            <p className="custody-hint">
              Transaction delay active — next transaction allowed at{' '}
              {new Date(policy.nextAllowedAt * 1000).toLocaleString()}.
            </p>
          )}

          {policy.allowlistEnabled && policy.allowlist.length > 0 && (
            <>
              <h6 className="custody-policy-subtitle">Approved recipients</h6>
              <ul className="custody-policy-allowlist" aria-label="Approved recipients">
                {policy.allowlist.map((a) => (
                  <li key={a}>
                    <code>{a}</code>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="custody-hint">
            Spending windows cover 24 hours: a window opens with the first counted spend and resets
            24 hours later. Limits cover the native coin and any tokens listed above; other assets
            pass through limit rules unvalued but stay subject to the allowlist and delay.
          </p>

          {canManage && !editing && (
            <div className="custody-actions">
              <button type="button" onClick={() => setEditing(true)}>
                Propose change
              </button>
            </div>
          )}
        </>
      )}

      {canManage && editing && (status === 'managed' || status === 'none') && (
        <PolicyConfigEditor
          currentPolicy={status === 'managed' ? policy : null}
          attach={status === 'none'}
          threshold={vault.threshold}
          busy={busy}
          onSubmit={submit}
          onCancel={() => setEditing(false)}
        />
      )}

      {actionError && (
        <p className="custody-error" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className="custody-hint" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}
