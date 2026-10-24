// Spec 068 (US2/US3) — compose ONE policy rule in plain language.
//
// The contract's expressiveness (asset scope, amount banding, K-of-N approvals, destination sets)
// is deliberately NOT exposed as flags. A member picks what the rule is about — who must approve,
// how much, which asset, where funds may go — and the composer emits the rule fields. The kinds
// below are the spec's four rule kinds (FR-009); a rule may combine them (an approver rule with a
// token limit and an approved-contract list is one rule, not three).

import { useMemo, useState } from 'react'
import { parseUnits } from '../../lib/evm/units'
import { ANY_ASSET, NATIVE_ASSET, validateRulesConfig } from '../../lib/custody/policyV2'
import { getServiceCatalog } from '../../config/serviceCatalog'
import CustodyAddressField from './CustodyAddressField'

const SCOPE_NATIVE = 'native'
const SCOPE_TOKEN = 'token'
const SCOPE_ANY = 'any'

export default function RuleComposer({ owners = [], chainId, nativeSymbol = 'coin', initial, onSubmit, onCancel }) {
  const [scope, setScope] = useState(initial?.scope || SCOPE_ANY)
  const [tokenAddress, setTokenAddress] = useState(initial?.tokenAddress || '')
  const [tokenDecimals, setTokenDecimals] = useState(initial?.tokenDecimals ?? 18)
  const [approvers, setApprovers] = useState(initial?.approvers || [])
  const [requireAll, setRequireAll] = useState(initial?.requireAll ?? true)
  const [anyCount, setAnyCount] = useState(initial?.anyCount || 1)
  const [perTx, setPerTx] = useState(initial?.perTx || '')
  const [banded, setBanded] = useState(initial?.banded ?? false)
  const [daily, setDaily] = useState(initial?.daily || '')
  const [targets, setTargets] = useState(initial?.targets || [])
  const [manualTarget, setManualTarget] = useState('')
  const [error, setError] = useState(null)

  const catalog = useMemo(() => getServiceCatalog(chainId), [chainId])
  const decimals = scope === SCOPE_TOKEN ? Number(tokenDecimals) || 18 : 18

  const toggleApprover = (address) =>
    setApprovers((prev) => (prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address]))

  const toggleService = (service) =>
    setTargets((prev) => {
      const has = service.addresses.every((a) => prev.includes(a))
      return has ? prev.filter((a) => !service.addresses.includes(a)) : [...new Set([...prev, ...service.addresses])]
    })

  const buildRule = () => {
    const asset = scope === SCOPE_NATIVE ? NATIVE_ASSET : scope === SCOPE_TOKEN ? tokenAddress : ANY_ASSET
    const rule = {
      asset,
      perTxLimit: perTx ? parseUnits(String(perTx), decimals) : 0n,
      windowLimit: daily ? parseUnits(String(daily), decimals) : 0n,
      approvers,
      approvalsRequired: approvers.length === 0 ? 0 : requireAll ? approvers.length : Number(anyCount),
      banded: banded && Boolean(perTx),
      targets,
    }
    // Validate this rule alone so the member is corrected before it joins the policy.
    const [validated] = validateRulesConfig([rule], 0, { owners })
    return validated
  }

  const submit = () => {
    setError(null)
    try {
      onSubmit(buildRule())
    } catch (e) {
      setError(e?.message || 'This rule is not valid yet')
    }
  }

  const unitLabel = scope === SCOPE_TOKEN ? 'tokens' : scope === SCOPE_NATIVE ? nativeSymbol : 'units'

  return (
    <div className="custody-rule-composer" role="group" aria-label="Rule">
      <fieldset>
        <legend>What can move</legend>
        <label>
          <input type="radio" name="rule-scope" checked={scope === SCOPE_ANY} onChange={() => setScope(SCOPE_ANY)} />
          Any asset
        </label>
        <label>
          <input type="radio" name="rule-scope" checked={scope === SCOPE_NATIVE} onChange={() => setScope(SCOPE_NATIVE)} />
          {nativeSymbol} only
        </label>
        <label>
          <input type="radio" name="rule-scope" checked={scope === SCOPE_TOKEN} onChange={() => setScope(SCOPE_TOKEN)} />
          One token only
        </label>
        {scope === SCOPE_TOKEN && (
          <>
            <CustodyAddressField
              id="rule-token"
              label="Token address"
              value={tokenAddress}
              onChange={setTokenAddress}
              chainId={chainId}
            />
            <div className="custody-field">
              <label htmlFor="rule-token-decimals">Token decimals</label>
              <input
                id="rule-token-decimals"
                type="number"
                min={0}
                max={36}
                value={tokenDecimals}
                onChange={(e) => setTokenDecimals(e.target.value)}
              />
            </div>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Who must approve</legend>
        {owners.length === 0 && <p className="custody-hint">This vault has no owners to name yet.</p>}
        {owners.map((owner) => (
          <label key={owner}>
            <input type="checkbox" checked={approvers.includes(owner)} onChange={() => toggleApprover(owner)} />
            <code>{owner}</code>
          </label>
        ))}
        {approvers.length > 1 && (
          <>
            <label>
              <input
                type="radio"
                name="rule-quorum"
                checked={requireAll}
                onChange={() => setRequireAll(true)}
                aria-label="All named approvers must approve"
              />
              All of them must approve
            </label>
            <label>
              <input
                type="radio"
                name="rule-quorum"
                checked={!requireAll}
                onChange={() => setRequireAll(false)}
                aria-label="Only some of the named approvers must approve"
              />
              Any
              <input
                type="number"
                min={1}
                max={approvers.length}
                value={anyCount}
                onChange={(e) => setAnyCount(e.target.value)}
                aria-label="How many of them must approve"
                disabled={requireAll}
              />
              of them must approve
            </label>
          </>
        )}
        {approvers.length === 0 && (
          <p className="custody-hint">
            No one named — the vault’s usual approval threshold is enough for transactions this rule governs.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>How much</legend>
        <div className="custody-field">
          <label htmlFor="rule-per-tx">Most per transaction ({unitLabel})</label>
          <input id="rule-per-tx" type="text" inputMode="decimal" value={perTx} onChange={(e) => setPerTx(e.target.value)} />
        </div>
        {perTx && (
          <label>
            <input type="checkbox" checked={banded} onChange={(e) => setBanded(e.target.checked)} />
            Only apply this rule up to that amount (larger transactions fall through to the next rule)
          </label>
        )}
        {scope !== SCOPE_ANY && (
          <div className="custody-field">
            <label htmlFor="rule-daily">Most per 24 hours ({unitLabel})</label>
            <input id="rule-daily" type="text" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </div>
        )}
        {scope === SCOPE_ANY && (
          <p className="custody-hint">
            Daily limits need a specific asset — an “any asset” counter would add different tokens together.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Where funds may go</legend>
        <p className="custody-hint">
          Leave empty to allow any destination. Listing destinations also limits which contracts this rule lets the
          vault interact with — the amount limits above still apply to them.
        </p>
        {catalog.length === 0 && <p className="custody-hint">No platform services are available on this network.</p>}
        {catalog.map((service) => (
          <label key={service.id}>
            <input
              type="checkbox"
              checked={service.addresses.every((a) => targets.includes(a))}
              onChange={() => toggleService(service)}
            />
            {service.name}
            {service.description && <span className="custody-hint"> — {service.description}</span>}
          </label>
        ))}
        <CustodyAddressField
          id="rule-target"
          label="Add another address"
          value={manualTarget}
          onChange={setManualTarget}
          chainId={chainId}
          hint="Addresses you add by hand are not checked by FairWins — make sure you trust them."
        />
        <button
          type="button"
          onClick={() => {
            if (manualTarget) setTargets((prev) => [...new Set([...prev, manualTarget])])
            setManualTarget('')
          }}
          disabled={!manualTarget}
        >
          Add destination
        </button>
        {targets.length > 0 && (
          <ul className="custody-target-list" aria-label="Allowed destinations">
            {targets.map((t) => (
              <li key={t}>
                <code>{t}</code>
                <button type="button" onClick={() => setTargets((prev) => prev.filter((x) => x !== t))} aria-label={`Remove destination ${t}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {error && (
        <p className="custody-error" role="alert">
          {error}
        </p>
      )}
      <div className="custody-actions">
        <button type="button" onClick={submit}>
          Save rule
        </button>
        {onCancel && (
          <button type="button" className="custody-link" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
