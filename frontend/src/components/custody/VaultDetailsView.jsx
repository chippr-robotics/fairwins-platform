// Spec 102 (US5) + spec 105 (US2/US3) — the vault sheet's Details view is ONE card. Address (copy)
// · a compact ROW per network (status + arrangement; a cohort network the vault is not on renders
// as "Not deployed" with an inline Deploy gated on the creation record — FR-015/FR-018) · the
// shared facts stated ONCE with per-network drift NAMED (FR-012/FR-013) · owners cross-referenced
// · the acting-account chooser · "Remove from Protect". The repeated per-network article with its
// up-front switch prompt is gone; a network switch is asked for at the moment an action needs it.
//
// Reads span chains; writes never do. The policy block for a network is proposable only on the
// instance the wallet is connected to (spec 068 FR-004); the others render read-only with the
// switch prompt VaultDetail already carries.

import { useState } from 'react'
import PropTypes from 'prop-types'
import { useWallet } from '../../hooks'
import { useCustodyVaults } from '../../hooks/useCustodyVaults'
import { useVaultProposals } from '../../hooks/useVaultProposals'
import { useAccountSwitcher, ACCOUNT_KIND_TAG, shortAccountAddr } from '../../hooks/useAccountSwitcher'
import { useActiveAccount } from '../../hooks/useActiveAccount'
import { useClipboard } from '../../hooks/useClipboard'
import { chainDisplayName, listChainNames } from '../../lib/custody/chainName'
import VaultDetail from './VaultDetail'
import NetworkPill from '../ui/NetworkPill'
import useVaultDeployment from '../../hooks/useVaultDeployment'
import { getCreationRecord } from '../../lib/custody/vaultCreationRecords'
import { creationChainIds, statusLabelFor } from './createflow/createFlowModel'
import VaultOwnerRow from './VaultOwnerRow'
import OwnersThresholdPanel from './OwnersThresholdPanel'

const lc = (a) => String(a || '').toLowerCase()

function probeChainIds(list) {
  return (list || []).map((x) => (x && typeof x === 'object' ? x.chainId : x)).filter((x) => x != null)
}

function NetworkRow({ instance, connected, onSwitch }) {
  const chainId = Number(instance.chainId)
  const name = instance.chainName || chainDisplayName(chainId)
  const readable = instance.isSafe === true
  let status
  if (instance.reachable === false) status = 'Could not be read'
  else if (instance.isSafe === false) status = 'Not a Safe here'
  else status = 'Live'
  return (
    <li className="vault-details__net-row" data-testid="vault-network" data-chain-id={chainId}>
      <NetworkPill chainId={chainId} name={name} />
      <span className={`vault-details__net-status${instance.reachable === false ? ' is-unreadable' : ''}`}>
        {status}
        {readable && instance.threshold != null ? ` · ${instance.threshold} of ${instance.owners?.length ?? 0}` : ''}
        {readable ? ` · ${instance.owner ? 'Owner' : 'View-only'}` : ''}
      </span>
      {!connected && readable && typeof onSwitch === 'function' && (
        <button type="button" className="vault-details__net-action" onClick={() => onSwitch(chainId)}>
          Switch
        </button>
      )}
      {connected && <span className="vault-details__net-here">Wallet here</span>}
    </li>
  )
}

NetworkRow.propTypes = {
  instance: PropTypes.object.isRequired,
  connected: PropTypes.bool,
  onSwitch: PropTypes.func,
}

/**
 * Spec 105 FR-013 — a shared fact is stated once when every READ network agrees; where a network
 * differs it is NAMED. Coverage is honest: the statement claims only the networks actually read.
 */
function sharedFact(readable, pick) {
  const values = new Map()
  for (const inst of readable) {
    const v = pick(inst)
    const key = JSON.stringify(v)
    if (!values.has(key)) values.set(key, { value: v, chains: [] })
    values.get(key).chains.push(Number(inst.chainId))
  }
  const entries = [...values.values()]
  if (entries.length === 0) return { state: 'unknown' }
  if (entries.length === 1) return { state: 'shared', value: entries[0].value }
  entries.sort((a, b) => b.chains.length - a.chains.length)
  return { state: 'drift', value: entries[0].value, differing: entries.slice(1) }
}

function FactLine({ label, fact, render }) {
  if (!fact || fact.state === 'unknown') return null
  return (
    <p className="vault-details__fact" data-testid={`vault-fact-${label.toLowerCase()}`}>
      <strong>{label}:</strong> {render(fact.value)}
      {fact.state === 'drift' && (
        <span className="vault-details__fact-drift" role="status">
          {' '}Differs on{' '}
          {fact.differing
            .map((d) => `${listChainNames(d.chains)} (${render(d.value)})`)
            .join('; ')}
          .
        </span>
      )}
    </p>
  )
}

FactLine.propTypes = {
  label: PropTypes.string.isRequired,
  fact: PropTypes.object,
  render: PropTypes.func.isRequired,
}

export default function VaultDetailsView({ group, onClose, onVaultsChanged }) {
  const { address: connectedAddress, chainId: walletChainId, switchNetwork } = useWallet()
  const custody = useCustodyVaults()
  const connectedInstance = group.connectedInstance || null
  const proposals = useVaultProposals(connectedInstance)
  const switcher = useAccountSwitcher()
  const { identity, operateAsPersonal } = useActiveAccount()
  const clipboard = useClipboard()

  const [probe, setProbe] = useState({ busy: false, message: null })
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState(null)
  const [govBusy, setGovBusy] = useState(false)
  const [govError, setGovError] = useState(null)

  // Spec 068 FR-004 — re-checked at SUBMIT time: the wallet may have left the vault's network while
  // the sheet was open, and a governance change must never be sent to another chain.
  const proposeOnConnected = async (...args) => {
    setGovError(null)
    setGovBusy(true)
    try {
      if (!connectedInstance || Number(walletChainId) !== Number(connectedInstance.chainId)) {
        throw new Error('Your wallet is no longer on this vault\'s network. Switch back and try again.')
      }
      await proposals.propose(...args)
    } catch (e) {
      setGovError(e?.message || 'Could not propose the change.')
    } finally {
      setGovBusy(false)
    }
  }

  const instances = group.instances || []
  const chainIds = group.chainIds || instances.map((i) => Number(i.chainId))
  const owners = group.owners || []
  const readable = group.readable || instances.filter((i) => i.isSafe === true)
  const me = lc(connectedAddress)

  // Spec 105 — deploy-later state. The creation record gates the inline Deploy on missing rows
  // (FR-018); the deployment hook is the SAME orchestration creation uses (FR-015).
  const deployment = useVaultDeployment()
  const creationRecord = connectedAddress ? getCreationRecord(connectedAddress, group.address) : null
  const heldChainIds = new Set(chainIds.map(Number))
  const missingChains = creationChainIds().filter((cid) => !heldChainIds.has(Number(cid)))
  const [deployTarget, setDeployTarget] = useState(null)
  const [deployStarted, setDeployStarted] = useState(false)
  const liveOwnerSet = readable[0]?.owners || []
  const ownerDrift = Boolean(
    creationRecord &&
      (liveOwnerSet.length !== creationRecord.owners.length ||
        !creationRecord.owners.every((o) => liveOwnerSet.some((l) => lc(l) === lc(o)))),
  )
  const runDeployLater = async () => {
    if (!creationRecord || deployTarget == null) return
    setDeployStarted(true)
    try {
      await deployment.start({
        owners: creationRecord.owners,
        threshold: creationRecord.threshold,
        saltNonce: creationRecord.saltNonce,
        presetType: creationRecord.presetType,
        semanticRules: creationRecord.rules,
        chainIds: [Number(deployTarget)],
        label: group.label || '',
      })
      onVaultsChanged?.()
    } catch {
      /* per-network failure state renders from deployment.byChain */
    }
  }

  // Shared facts over the networks that actually answered (FR-013).
  const unreadChainIds = instances.filter((i) => i.isSafe !== true).map((i) => Number(i.chainId))
  const unreadCount = unreadChainIds.length
  const arrangementFact = sharedFact(readable, (i) => ({
    threshold: i.threshold ?? null,
    ownerCount: i.owners?.length ?? 0,
  }))
  const rulesFact = sharedFact(readable, (i) => ({
    policyStatus: i.policyStatus || 'none',
    policySummary: i.policySummary || '',
  }))

  const ownerChains = (owner) =>
    readable.filter((i) => (i.owners || []).some((o) => lc(o) === lc(owner))).map((i) => Number(i.chainId))

  const doSwitch = (chainId) => {
    if (!switchNetwork) return
    Promise.resolve(switchNetwork(chainId)).catch(() => {})
  }

  const runProbe = async () => {
    setProbe({ busy: true, message: null })
    try {
      const res = await custody.probeVault?.(group.address)
      const added = probeChainIds(res?.added)
      const unreachable = probeChainIds(res?.unreachable)
      const parts = []
      parts.push(added.length > 0 ? `Added on ${listChainNames(added)}.` : 'No new networks found.')
      if (unreachable.length > 0) parts.push(`Not checked on ${listChainNames(unreachable)} — try again later.`)
      setProbe({ busy: false, message: parts.join(' ') })
      if (added.length > 0) onVaultsChanged?.()
    } catch (e) {
      setProbe({ busy: false, message: e?.message || 'Could not check other networks.' })
    }
  }

  const actingAsThis = identity?.mode === 'vault' && lc(identity.vaultAddress) === lc(group.address)

  const remove = async () => {
    setRemoving(true)
    setRemoveError(null)
    try {
      await custody.forgetVault?.(group.address)
      if (actingAsThis) operateAsPersonal?.()
      onVaultsChanged?.()
      onClose?.()
    } catch (e) {
      setRemoveError(e?.message || 'Could not remove this vault.')
      setRemoving(false)
    }
  }

  return (
    <div className="vault-details" data-testid="vault-details">
      {/* (a) Address */}
      <section className="vault-details__section" aria-labelledby="vault-details-address">
        <h4 id="vault-details-address">Address</h4>
        <div className="vault-details__address">
          <code>{group.address}</code>
          <button type="button" onClick={() => clipboard.copy(group.address)} data-testid="vault-copy-address">
            {clipboard.copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {chainIds.length > 1 && (
          <p className="custody-hint" data-testid="vault-same-address">
            Same address on every network.
          </p>
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {clipboard.copied ? 'Address copied' : ''}
        </span>
        {clipboard.error && (
          <p className="custody-error" role="alert">
            {clipboard.error}
          </p>
        )}
      </section>

      {/* (b) Networks — one compact row per network; a cohort network the vault is not on is a
          "Not deployed" row with an inline Deploy (spec 105 FR-015), gated on the creation record
          (FR-018 — absence gets the honest reason, never a dead control). */}
      <section className="vault-details__section" aria-labelledby="vault-details-networks">
        <h4 id="vault-details-networks">Networks</h4>
        <ul className="vault-details__net-rows">
          {instances.map((instance) => (
            <NetworkRow
              key={Number(instance.chainId)}
              instance={instance}
              connected={Number(walletChainId) === Number(instance.chainId)}
              onSwitch={doSwitch}
            />
          ))}
          {missingChains.map((cid) => (
            <li className="vault-details__net-row" data-testid="vault-network-missing" data-chain-id={cid} key={cid}>
              <NetworkPill chainId={cid} name={chainDisplayName(cid)} />
              <span className="vault-details__net-status">Not deployed</span>
              {creationRecord ? (
                <button
                  type="button"
                  className="vault-details__net-action vault-details__net-deploy"
                  data-testid={`vault-deploy-${cid}`}
                  onClick={() => setDeployTarget(cid)}
                >
                  Deploy
                </button>
              ) : (
                <span className="custody-hint">needs this vault&rsquo;s creation details, which this app does not hold</span>
              )}
            </li>
          ))}
        </ul>

        {deployTarget != null && creationRecord && (
          <div className="vault-details__deploy" data-testid="vault-deploy-panel">
            {ownerDrift && !deployStarted && (
              <p className="custody-hint" role="note" data-testid="vault-deploy-original-owners">
                This vault&rsquo;s owners have changed since it was created. {chainDisplayName(deployTarget)} will start
                from the ORIGINAL arrangement — {creationRecord.threshold} of {creationRecord.owners.length}:{' '}
                {creationRecord.owners.map((o) => shortAccountAddr(o)).join(', ')} — and can be brought in line
                through the queue afterwards.
              </p>
            )}
            {!deployStarted ? (
              <div className="custody-actions">
                <button type="button" data-testid="vault-deploy-confirm" onClick={runDeployLater}>
                  Deploy to {chainDisplayName(deployTarget)}
                </button>
                <button type="button" onClick={() => setDeployTarget(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <p className="custody-hint" role="status" data-testid="vault-deploy-status">
                {chainDisplayName(deployTarget)}: {statusLabelFor(deployment.byChain[deployTarget])}
                {deployment.byChain[deployTarget]?.reason ? ` — ${deployment.byChain[deployTarget].reason}` : ''}
              </p>
            )}
          </div>
        )}

        <div className="custody-actions">
          <button type="button" onClick={runProbe} disabled={probe.busy} data-testid="vault-probe">
            {probe.busy ? 'Checking…' : 'Check other networks'}
          </button>
        </div>
        {probe.message && (
          <p className="custody-hint" role="status" data-testid="vault-probe-result">
            {probe.message}
          </p>
        )}
      </section>

      {/* (b2) Shared facts — stated once; drift NAMED, coverage honest (spec 105 FR-012/FR-013). */}
      <section className="vault-details__section" aria-labelledby="vault-details-facts">
        <h4 id="vault-details-facts">Arrangement &amp; rules</h4>
        {readable.length === 0 ? (
          <p className="custody-hint" role="status">
            No network could be read, so the vault&rsquo;s arrangement cannot be shown right now.
          </p>
        ) : (
          <>
            <FactLine
              label="Approvals"
              fact={arrangementFact}
              render={(v) => `${v.threshold} of ${v.ownerCount} owners`}
            />
            <FactLine
              label="Rules"
              fact={rulesFact}
              render={(v) => (v.policyStatus === 'none' || !v.policyStatus ? 'No rules — any transaction its owners approve can execute.' : v.policySummary || 'Rules are active.')}
            />
            {unreadCount > 0 && (
              <p className="custody-hint" role="status" data-testid="vault-facts-coverage">
                Covers the {readable.length} network{readable.length === 1 ? '' : 's'} that answered;{' '}
                {listChainNames(unreadChainIds)} could not be read.
              </p>
            )}
          </>
        )}
        {connectedInstance?.isSafe === true && (
          <details className="vault-details__manage-rules" data-testid="vault-manage-rules">
            <summary>Manage rules on {chainDisplayName(Number(connectedInstance.chainId))}</summary>
            <VaultDetail
              vault={{ ...connectedInstance, onVaultChain: true }}
              variant="network"
              onProposePolicy={connectedInstance.owner ? proposals?.propose : undefined}
              proposalQueue={proposals?.queue ?? []}
            />
          </details>
        )}
      </section>

      {/* (c) Owners */}
      <section className="vault-details__section" aria-labelledby="vault-details-owners">
        <h4 id="vault-details-owners">Owners</h4>
        {owners.length === 0 ? (
          <p className="custody-hint" role="status">
            {readable.length === 0 ? 'Owners could not be read on any network.' : 'No owners.'}
          </p>
        ) : (
          <ul className="vault-details__owners">
            {owners.map((owner) => (
              <VaultOwnerRow key={lc(owner)} address={owner} chainIds={ownerChains(owner)} isYou={Boolean(me) && lc(owner) === me} />
            ))}
          </ul>
        )}
        {/* Governance (spec 043 US4) kept its home beside the owner list: adding/removing an owner or
            changing the threshold is an ordinary proposal on the CONNECTED network's instance, so the
            panel renders only where the wallet is on a network the member co-owns — the same
            submit-time chain check VaultProposalsPanel applies, and the queue tab shows the result. */}
        {connectedInstance?.isSafe === true && connectedInstance.owner && typeof proposals?.propose === 'function' && (
          <div className="vault-details__governance" data-testid="vault-governance">
            <h5 className="vault-details__subheading">Owners &amp; threshold</h5>
            <p className="custody-hint" role="note">
              Changes are proposed on {chainDisplayName(Number(connectedInstance.chainId))} and wait in the queue for the
              other owners.
            </p>
            <OwnersThresholdPanel vault={connectedInstance} onPropose={proposeOnConnected} busy={govBusy} />
            {govError && (
              <p className="custody-error" role="alert">
                {govError}
              </p>
            )}
          </div>
        )}
      </section>

      {/* (d) Acting account */}
      <section className="vault-details__section" aria-labelledby="vault-details-acting">
        <h4 id="vault-details-acting">Acting account</h4>
        <div className="vault-details__acting" role="radiogroup" aria-label="Act as">
          {(switcher.accounts || []).map((acc) => {
            const current = acc.id === switcher.currentId
            const isThisVault = acc.kind === 'vault' && lc(acc.address) === lc(group.address)
            return (
              <button
                key={acc.id}
                type="button"
                role="radio"
                aria-checked={current}
                className={`vault-details__act-as${isThisVault ? ' is-this-vault' : ''}`}
                data-testid={`vault-act-as-${acc.id}`}
                onClick={() => {
                  if (!current) switcher.choose(acc)
                }}
              >
                <span>{acc.label || shortAccountAddr(acc.address)}</span>
                {acc.kind !== 'personal' && (
                  <span className="vault-details__act-as-kind">{ACCOUNT_KIND_TAG[acc.kind] || acc.kind}</span>
                )}
                <span className="vault-details__act-as-addr">{shortAccountAddr(acc.address)}</span>
              </button>
            )
          })}
        </div>
        <p className="custody-hint" role="note">
          Switching is instant and address-only; signing happens when you send.
        </p>
      </section>

      {/* (e) Danger */}
      <section className="vault-details__section" aria-labelledby="vault-details-danger">
        <h4 id="vault-details-danger">Remove</h4>
        <div className="vault-details__danger">
          {!confirmRemove ? (
            <button type="button" className="vault-details__danger-btn" onClick={() => setConfirmRemove(true)} data-testid="vault-remove">
              Remove from Protect
            </button>
          ) : (
            <>
              <p className="custody-hint">
                This forgets the vault on {listChainNames(chainIds)}. Nothing on chain changes; you can load it again later.
              </p>
              <button type="button" className="vault-details__danger-btn" onClick={remove} disabled={removing} data-testid="vault-remove-confirm">
                {removing ? 'Removing…' : `Remove on ${chainIds.length} network${chainIds.length === 1 ? '' : 's'}`}
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)} disabled={removing}>
                Cancel
              </button>
            </>
          )}
        </div>
        {removeError && (
          <p className="custody-error" role="alert">
            {removeError}
          </p>
        )}
      </section>
    </div>
  )
}

VaultDetailsView.propTypes = {
  /** VaultGroup (lib/custody/vaultGroups). */
  group: PropTypes.object.isRequired,
  onClose: PropTypes.func,
  /** Fired after the list changed (probe added a network / vault removed). */
  onVaultsChanged: PropTypes.func,
}
