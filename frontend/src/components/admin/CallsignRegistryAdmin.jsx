import { useState, useEffect, useCallback, useMemo } from 'react'
import { encodeFunctionData, keccak256, stringToBytes, zeroAddress } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { getAddress, isAddress } from '../../lib/evm/address'
import { CALLSIGN_REGISTRY_ABI, CallsignStatus } from '../../abis/callsignRegistry'
import { getContractAddressForChain } from '../../config/contracts'
import { estateNetworks, networkName, readProviderFor } from '../../lib/chains/estate'
import { NetworkScopeCard } from './scopeControls'
import { useScopedChain } from './scopeGate'
import { normalizeCallsign, isValidCallsign, formatCallsign } from '../../lib/callsigns/normalizeCallsign'
import { useCallsignRegistryMetrics } from '../../hooks/useCallsignRegistryMetrics'
import './CallsignRegistryAdmin.css'

/**
 * CallsignRegistryAdmin (spec 054 — operator admin) — the "Callsigns" tab of the platform AdminPanel.
 *
 * Manages the on-chain %callsign naming registry for the operator: live registry metrics from a bounded
 * event scan (no backend), moderation (suspend / verify / reserve — each gated on the caller's role
 * ON THIS contract, which has its OWN AccessControl separate from the main registry), policy-param
 * tuning, and role management. Every write goes through the parent's `runTx` (plain signer, like the
 * other admin tabs — admin actions are not gasless). Reads soft-fail; the tab degrades to a
 * "not deployed on this network" notice when the registry address is unset.
 *
 * Tab contract: { signer, account, contracts, chainId, runTx, pendingTx }.
 */

const STATUS_LABEL = {
  [CallsignStatus.NONE]: 'None',
  [CallsignStatus.ACTIVE]: 'Active',
  [CallsignStatus.REPOINTING]: 'Repointing',
  [CallsignStatus.QUARANTINED]: 'Quarantined',
  [CallsignStatus.SUSPENDED]: 'Suspended',
  [CallsignStatus.LAPSED_RECLAIMABLE]: 'Lapsed (reclaimable)',
}

const TIER_LABEL = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum']

// Policy params: bounds mirror the contract constants (seconds). Used for client-side validation +
// human hints so an operator doesn't submit a value the contract will just revert (ParamOutOfBounds).
const DAY = 86400
const POLICY_FIELDS = [
  { key: 'minCommitmentAge', label: 'Min commitment age', min: 60, max: DAY, hint: '1 min – 1 day' },
  { key: 'maxCommitmentAge', label: 'Max commitment age', min: 61, max: 7 * DAY, hint: '> min, ≤ 7 days' },
  { key: 'quarantinePeriod', label: 'Quarantine period', min: 30 * DAY, max: 365 * DAY, hint: '30 – 365 days' },
  { key: 'changeCooldown', label: 'Change cooldown', min: DAY, max: 365 * DAY, hint: '1 – 365 days' },
  { key: 'repointDelay', label: 'Repoint delay', min: DAY, max: 14 * DAY, hint: '24 h – 14 days' },
  { key: 'lapseGrace', label: 'Lapse grace', min: 30 * DAY, max: 3650 * DAY, hint: '30 – 3650 days' },
]

const shortHash = (h) => (h && h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h || '—')
const shortAddr = (a) => (a && isAddress(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '—')

function humanDuration(seconds) {
  const s = Number(seconds || 0)
  if (!s) return '—'
  if (s % DAY === 0) return `${s / DAY} day${s / DAY === 1 ? '' : 's'}`
  if (s % 3600 === 0) return `${s / 3600} hour${s / 3600 === 1 ? '' : 's'}`
  if (s % 60 === 0) return `${s / 60} min`
  return `${s}s`
}

export default function CallsignRegistryAdmin({ signer, account, contracts, chainId, runTx, pendingTx }) {
  // Spec 071 US4: the registry is per network — a callsign on one chain is not one on another.
  const callsignNetworks = useMemo(() => estateNetworks(), [])
  const { scopeChainId, setScopeChainId } = useScopedChain(callsignNetworks, chainId)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)
  const address = useMemo(
    () => getContractAddressForChain('callsignRegistry', scopeChainId) || (Number(scopeChainId) === Number(chainId) ? contracts?.callsignRegistry : '') || '',
    [scopeChainId, chainId, contracts],
  )
  // Reads come from the scoped chain; only writes use the wallet's signer.
  const provider = useMemo(
    () => readProviderFor(scopeChainId, chainId, signer?.provider || null),
    [scopeChainId, chainId, signer],
  )
  const configured = Boolean(address && isAddress(address))

  /**
   * Reads bound to the SCOPED chain (spec 110). `provider` stays the availability gate —
   * `readProviderFor` is cohort-bounded, so its null means this build may not read that chain at
   * all, which is a different answer from a read that was attempted and failed.
   */
  const reader = useMemo(
    () =>
      configured && provider
        ? (functionName, args = []) =>
            readContract(scopeChainId, {
              address,
              abi: CALLSIGN_REGISTRY_ABI,
              functionName,
              args,
            })
        : null,
    [configured, address, provider, scopeChainId],
  )
  const writer = useCallback(
    () =>
      configured && signer
        ? (functionName, args = []) =>
            signer.sendTransaction({
              to: address,
              data: encodeFunctionData({
                abi: normalizeAbi(CALLSIGN_REGISTRY_ABI),
                functionName,
                args,
              }),
            })
        : null,
    [configured, address, signer],
  )

  // Roles the connected wallet holds ON THIS contract (its own AccessControl).
  const [roles, setRoles] = useState({ curator: false, moderator: false, verifier: false, admin: false })
  const [config, setConfig] = useState(null) // policy params + gate + wired contracts
  const [configError, setConfigError] = useState('')

  const metrics = useCallsignRegistryMetrics({ provider, chainId, address })

  // Moderation lookup + forms.
  const [callsignInput, setCallsignInput] = useState('')
  const [lookup, setLookup] = useState(null) // { canonical, callsignHash, owner, status, verified, reserved } | null
  const [lookupError, setLookupError] = useState('')
  const [policyForm, setPolicyForm] = useState(null)
  const [gateTier, setGateTier] = useState(3)
  const [roleForm, setRoleForm] = useState({ role: 'MODERATOR', address: '' })

  const loadConfig = useCallback(async () => {
    if (!reader || !account) return
    setConfigError('')
    try {
      const [
        curatorRole, moderatorRole, verifierRole, adminRole,
        membershipRole, minTier, membershipManager, sanctionsGuard,
        minCommitmentAge, maxCommitmentAge, quarantinePeriod, changeCooldown, repointDelay, lapseGrace,
      ] = await Promise.all([
        reader('REGISTRY_CURATOR_ROLE'), reader('MODERATOR_ROLE'), reader('VERIFIER_ROLE'), reader('DEFAULT_ADMIN_ROLE'),
        reader('membershipRole'), reader('minTier'), reader('membershipManager'), reader('sanctionsGuard'),
        reader('minCommitmentAge'), reader('maxCommitmentAge'), reader('quarantinePeriod'),
        reader('changeCooldown'), reader('repointDelay'), reader('lapseGrace'),
      ])
      const [curator, moderator, verifier, admin] = await Promise.all([
        reader('hasRole', [curatorRole, account]), reader('hasRole', [moderatorRole, account]),
        reader('hasRole', [verifierRole, account]), reader('hasRole', [adminRole, account]),
      ])
      setRoles({ curator, moderator, verifier, admin })
      const cfg = {
        roleHashes: { curator: curatorRole, moderator: moderatorRole, verifier: verifierRole, admin: adminRole },
        membershipRole,
        minTier: Number(minTier),
        membershipManager,
        sanctionsGuard,
        minCommitmentAge: Number(minCommitmentAge),
        maxCommitmentAge: Number(maxCommitmentAge),
        quarantinePeriod: Number(quarantinePeriod),
        changeCooldown: Number(changeCooldown),
        repointDelay: Number(repointDelay),
        lapseGrace: Number(lapseGrace),
      }
      setConfig(cfg)
      setPolicyForm(Object.fromEntries(POLICY_FIELDS.map((f) => [f.key, String(cfg[f.key])])))
      setGateTier(cfg.minTier)
    } catch (err) {
      setConfigError(`Could not read registry config: ${err?.message || err}`)
    }
  }, [reader, account])

  useEffect(() => { loadConfig() }, [loadConfig])
  useEffect(() => { if (configured && provider) metrics.refresh() /* initial, cache-backed */ }, [configured, provider]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Moderation lookup ----
  const doLookup = useCallback(async () => {
    setLookupError('')
    setLookup(null)
    if (!isValidCallsign(callsignInput)) { setLookupError('Enter a valid callsign (3–20 chars, a–z 0–9, single interior hyphens).'); return }
    if (!reader) { setLookupError('Registry not configured on this network.'); return }
    try {
      const canonical = normalizeCallsign(callsignInput)
      // `keccak256(utf8(canonical))` — byte-identical to the `ethers.id` it replaces, checked over
      // 21 callsign shapes including the length boundaries, rejected forms and unicode. This hash
      // IS the on-chain key: a wrong byte does not throw, it silently looks up nothing and the
      // panel reports the callsign as unregistered.
      const callsignHash = keccak256(stringToBytes(canonical))
      const [info, isReserved] = await Promise.all([reader('getCallsignInfoByHash', [callsignHash]), reader('reserved', [callsignHash])])
      setLookup({
        canonical,
        callsignHash,
        owner: info.owner,
        status: Number(info.status),
        verified: Boolean(info.verified),
        reserved: Boolean(isReserved),
      })
    } catch (err) {
      setLookupError(`Lookup failed: ${err?.message || err}`)
    }
  }, [callsignInput, reader])

  const afterWrite = useCallback(() => {
    loadConfig()
    if (lookup?.callsignHash) doLookup().catch(() => {}) // refresh the open lookup only; don't spuriously error a policy/role action
    metrics.refresh({ force: true })
  }, [loadConfig, doLookup, metrics, lookup])

  // Route a write through the parent's runTx (plain signer), then refresh reads once it settles.
  // Promise.resolve tolerates a runTx that returns undefined; afterWrite is idempotent (pure re-reads).
  const submit = useCallback(
    (functionName, args, msg) => {
      const send = writer()
      if (!send) return
      Promise.resolve(runTx(() => send(functionName, args), msg)).finally(() => afterWrite())
    },
    [writer, runTx, afterWrite],
  )

  const onSuspend = (suspend) =>
    submit('setSuspended', [lookup.callsignHash, Boolean(suspend)], `${suspend ? 'Suspend' : 'Unsuspend'} ${formatCallsign(lookup.canonical)}`)
  const onVerify = (verify) =>
    submit('setVerified', [lookup.callsignHash, Boolean(verify)], `${verify ? 'Verify' : 'Unverify'} ${formatCallsign(lookup.canonical)}`)
  const onReserve = (reserve) =>
    submit('setReserved', [[lookup.callsignHash], Boolean(reserve)], `${reserve ? 'Reserve' : 'Unreserve'} ${formatCallsign(lookup.canonical)}`)

  // ---- Policy ----
  const policyInvalid = useMemo(() => {
    if (!policyForm) return true
    for (const f of POLICY_FIELDS) {
      const v = Number(policyForm[f.key])
      if (!Number.isFinite(v) || v < f.min || v > f.max) return true
    }
    return Number(policyForm.maxCommitmentAge) <= Number(policyForm.minCommitmentAge)
  }, [policyForm])

  const savePolicy = () => {
    if (policyInvalid) return
    const args = POLICY_FIELDS.map((f) => Number(policyForm[f.key]))
    submit('setPolicyParams', args, 'Update policy params')
  }

  const saveGate = () => {
    if (!config) return
    submit('setMembershipGate', [config.membershipRole, gateTier], `Set membership gate → ${TIER_LABEL[gateTier]}`)
  }

  // ---- Role management ----
  const onRoleGrant = (grant) => {
    if (!config) return
    const target = roleForm.address.trim()
    if (!isAddress(target)) return
    const roleHash = config.roleHashes[roleForm.role.toLowerCase()]
    submit(
      grant ? 'grantRole' : 'revokeRole',
      // Normalised before encoding (spec 110 divergence 16): the seam's `isAddress` reproduces
      // ethers' rule and ACCEPTS an all-uppercase address, which viem's encoder refuses.
      [roleHash, getAddress(target)],
      `${grant ? 'Grant' : 'Revoke'} ${roleForm.role} → ${shortAddr(target)}`,
    )
  }

  // ---- Render ----
  if (!configured) {
    return (
      <section aria-labelledby="callsignadmin-heading">
        <h3 id="callsignadmin-heading">Callsign registry</h3>
        <p role="status">The callsign registry is not deployed / configured on this network.</p>
      </section>
    )
  }

  const roleBadges = [
    roles.admin && 'Admin',
    roles.curator && 'Curator',
    roles.moderator && 'Moderator',
    roles.verifier && 'Verifier',
  ].filter(Boolean)

  const m = metrics.data

  return (
    <section aria-labelledby="callsignadmin-heading" className="callsign-admin">
      <NetworkScopeCard
        title="Callsigns"
        description="The callsign registry for one network. A callsign registered on one chain is not registered on another."
        networks={callsignNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('callsignRegistry', id))}
        walletChainId={chainId}
        onRefresh={() => {}}
        lastReadAt={null}
        notDeployedLabel="no CallsignRegistry"
      />
      {!onScopeNetwork && (
        <p className="card-info warning-text" role="status">
          Reading {networkName(scopeChainId)}; your wallet is on {networkName(chainId)}. Changes are
          signed on {networkName(scopeChainId)} — switch your wallet to make one.
        </p>
      )}
      <h3 id="callsignadmin-heading">Callsign registry</h3>
      <p className="callsign-admin__addr">
        Registry: <span title={address}>{shortAddr(address)}</span>
        {roleBadges.length ? (
          <span className="callsign-admin__roles"> — your roles: {roleBadges.map((r) => (
            <span key={r} className="callsign-admin__badge">{r}</span>
          ))}</span>
        ) : (
          <span className="callsign-admin__roles"> — you hold no operator role on this registry (reads only).</span>
        )}
      </p>
      {configError && <p role="alert" className="callsign-admin__error">{configError}</p>}

      {/* -------------------- Metrics -------------------- */}
      <div className="admin-card">
        <div className="callsign-admin__card-head">
          <h4 id="callsignadmin-metrics">Metrics</h4>
          <button type="button" className="confirm-btn" onClick={() => metrics.refresh({ force: true })} disabled={metrics.loading}>
            {metrics.loading ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
        {metrics.error && <p role="alert" className="callsign-admin__error">Metrics scan failed: {metrics.error}</p>}
        {!m && !metrics.loading && !metrics.error && <p role="status">No metrics loaded yet.</p>}
        {m && (
          <>
            <div className="callsign-admin__tiles" aria-labelledby="callsignadmin-metrics">
              <Tile label={m.truncated ? 'Net registrations (window)' : 'Active callsigns'} value={m.netRegistrations} />
              <Tile label="Registrations" value={m.counts.registered} />
              <Tile label="Changes" value={m.counts.changed} />
              <Tile label="Releases" value={m.counts.released} />
              <Tile label="Reclaims" value={m.counts.reclaimed} />
              <Tile label="Repoints (final)" value={m.counts.repointFinalized} />
              <Tile label="Suspended" value={m.suspended.length} />
              <Tile label="Verified" value={m.verified.length} />
              <Tile label="Reserved" value={m.reserved.length} />
            </div>
            {m.truncated && (
              <p role="note" className="callsign-admin__note">
                Showing the most recent block window only — lifetime tallies are for the scanned range,
                not all-time. Query the chain directly (or a future subgraph) for the full history.
              </p>
            )}
            <CallsignChipList title="Currently suspended" items={m.suspended} empty="None suspended." />
            <CallsignChipList title="Currently verified" items={m.verified} empty="None verified." />
            <CallsignChipList title="Currently reserved" items={m.reserved} empty="None reserved (in window)." />

            <h5>Recent activity</h5>
            {m.recent.length === 0 ? (
              <p role="status">No recent registry events in the scanned window.</p>
            ) : (
              <div className="callsign-admin__table-wrap">
                <table>
                  <caption className="sr-only">Recent callsign registry events (newest first)</caption>
                  <thead>
                    <tr><th scope="col">Event</th><th scope="col">Callsign / hash</th><th scope="col">Account</th><th scope="col">Block</th></tr>
                  </thead>
                  <tbody>
                    {m.recent.map((e, i) => (
                      <tr key={`${e.type}-${e.block}-${i}`}>
                        <td>{e.type.replace(/^Callsign/, '')}</td>
                        <td title={e.callsignHash || ''}>{e.callsign ? formatCallsign(e.callsign) : shortHash(e.callsignHash)}</td>
                        <td title={e.owner || ''}>{shortAddr(e.owner)}</td>
                        <td>{e.block}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* -------------------- Moderation -------------------- */}
      <div className="admin-card">
        <h4 id="callsignadmin-moderation">Moderation</h4>
        <p>Look up a callsign, then suspend / verify / reserve it. Each action is gated on-chain by the matching role.</p>
        <div className="callsign-admin__lookup">
          <label htmlFor="callsignadmin-callsign">Callsign</label>
          <div className="callsign-admin__input-row">
            <span aria-hidden="true" className="callsign-admin__prefix">%</span>
            <input
              id="callsignadmin-callsign"
              type="text"
              value={callsignInput}
              onChange={(e) => setCallsignInput(e.target.value.replace(/^%+/, ''))}
              placeholder="chipprbots"
              autoComplete="off"
              spellCheck="false"
            />
            <button type="button" className="confirm-btn" onClick={doLookup} disabled={!onScopeNetwork || pendingTx}>Look up</button>
          </div>
        </div>
        {lookupError && <p role="alert" className="callsign-admin__error">{lookupError}</p>}
        {lookup && (
          <div className="callsign-admin__lookup-result" role="group" aria-label="Callsign status">
            <p>
              <strong>{formatCallsign(lookup.canonical)}</strong> — status <strong>{STATUS_LABEL[lookup.status] ?? lookup.status}</strong>
              {lookup.verified ? <span className="callsign-admin__badge">Verified</span> : null}
              {lookup.reserved ? <span className="callsign-admin__badge">Reserved</span> : null}
              <br />
              Owner: <span title={lookup.owner}>{lookup.owner === zeroAddress ? '— (unregistered)' : shortAddr(lookup.owner)}</span>
              <br />
              <code className="callsign-admin__hash">{lookup.callsignHash}</code>
            </p>
            <div className="callsign-admin__mod-actions">
              <button type="button" className="confirm-btn danger" disabled={!roles.moderator || pendingTx}
                onClick={() => onSuspend(lookup.status !== CallsignStatus.SUSPENDED)}>
                {lookup.status === CallsignStatus.SUSPENDED ? 'Unsuspend' : 'Suspend'}
              </button>
              <button type="button" className="confirm-btn" disabled={!roles.verifier || pendingTx}
                onClick={() => onVerify(!lookup.verified)}>
                {lookup.verified ? 'Remove verification' : 'Verify'}
              </button>
              <button type="button" className="confirm-btn" disabled={!roles.curator || pendingTx}
                onClick={() => onReserve(!lookup.reserved)}>
                {lookup.reserved ? 'Unreserve' : 'Reserve'}
              </button>
            </div>
            {!roles.moderator && !roles.verifier && !roles.curator && (
              <p role="note" className="callsign-admin__note">You hold no moderation role on this registry — actions are disabled.</p>
            )}
          </div>
        )}
      </div>

      {/* -------------------- Policy (admin) -------------------- */}
      {roles.admin && config && policyForm && (
        <div className="admin-card">
          <h4 id="callsignadmin-policy">Policy parameters</h4>
          <div className="callsign-admin__policy-grid">
            {POLICY_FIELDS.map((f) => (
              <div key={f.key} className="callsign-admin__policy-field">
                <label htmlFor={`policy-${f.key}`}>{f.label} <span className="callsign-admin__hint">({f.hint})</span></label>
                <input
                  id={`policy-${f.key}`}
                  type="number"
                  value={policyForm[f.key]}
                  min={f.min}
                  max={f.max}
                  onChange={(e) => setPolicyForm((p) => ({ ...p, [f.key]: e.target.value }))}
                />
                <span className="callsign-admin__hint">= {humanDuration(policyForm[f.key])} (now {humanDuration(config[f.key])})</span>
              </div>
            ))}
          </div>
          <button type="button" className="confirm-btn primary" onClick={savePolicy} disabled={policyInvalid || pendingTx}>
            {pendingTx ? 'Saving…' : 'Save policy'}
          </button>

          <h5>Membership gate</h5>
          <p>Minimum tier required to register a callsign (hard-floored at Gold). Current: <strong>{TIER_LABEL[config.minTier]}</strong>.</p>
          <div className="callsign-admin__gate-row">
            <label htmlFor="callsignadmin-gate">Minimum tier</label>
            <select id="callsignadmin-gate" value={gateTier} onChange={(e) => setGateTier(Number(e.target.value))}>
              <option value={3}>Gold</option>
              <option value={4}>Platinum</option>
            </select>
            <button type="button" className="confirm-btn" onClick={saveGate} disabled={!onScopeNetwork || pendingTx || gateTier === config.minTier}>
              Set gate
            </button>
          </div>
          <p className="callsign-admin__hint">
            Membership manager: <span title={config.membershipManager}>{shortAddr(config.membershipManager)}</span> ·
            Sanctions guard: {config.sanctionsGuard === zeroAddress ? 'disabled' : <span title={config.sanctionsGuard}>{shortAddr(config.sanctionsGuard)}</span>}
          </p>
        </div>
      )}

      {/* -------------------- Roles (admin) -------------------- */}
      {roles.admin && config && (
        <div className="admin-card">
          <h4 id="callsignadmin-roles">Operator roles</h4>
          <p>Grant or revoke the registry's operator roles for an address (requires the registry admin role).</p>
          <div className="callsign-admin__role-form">
            <label htmlFor="callsignadmin-role">Role</label>
            <select id="callsignadmin-role" value={roleForm.role} onChange={(e) => setRoleForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="CURATOR">Curator (reserve terms)</option>
              <option value="MODERATOR">Moderator (suspend)</option>
              <option value="VERIFIER">Verifier (verification badge)</option>
            </select>
            <label htmlFor="callsignadmin-role-addr">Address</label>
            <input
              id="callsignadmin-role-addr"
              type="text"
              value={roleForm.address}
              onChange={(e) => setRoleForm((f) => ({ ...f, address: e.target.value }))}
              placeholder="0x…"
              autoComplete="off"
            />
            <div className="callsign-admin__mod-actions">
              <button type="button" className="confirm-btn primary" onClick={() => onRoleGrant(true)} disabled={!onScopeNetwork || pendingTx || !isAddress(roleForm.address.trim())}>Grant</button>
              <button type="button" className="confirm-btn danger" onClick={() => onRoleGrant(false)} disabled={!onScopeNetwork || pendingTx || !isAddress(roleForm.address.trim())}>Revoke</button>
            </div>
          </div>
          <p className="callsign-admin__hint">Role hashes are the keccak256 of the role names; the curator role also administers the reserved list.</p>
        </div>
      )}
    </section>
  )
}

function Tile({ label, value }) {
  return (
    <div className="callsign-admin__tile">
      <span className="callsign-admin__tile-value">{value}</span>
      <span className="callsign-admin__tile-label">{label}</span>
    </div>
  )
}

function CallsignChipList({ title, items, empty }) {
  return (
    <div className="callsign-admin__chiplist">
      <h5>{title} ({items.length})</h5>
      {items.length === 0 ? (
        <p role="status" className="callsign-admin__hint">{empty}</p>
      ) : (
        <ul className="callsign-admin__chips">
          {items.map((it) => (
            <li key={it.callsignHash} className="callsign-admin__chip" title={it.callsignHash}>
              {it.callsign ? formatCallsign(it.callsign) : shortHash(it.callsignHash)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
