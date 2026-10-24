import { useState } from 'react'
import { useMiniAppHost } from '@fairwins/miniapp-sdk'

import CpAddressField from './CpAddressField'
import { nativeDaoUnavailableReason } from './config/nativeDaoChains'
import { FEE_STATEMENT, describeFeeEstimate, useCreateDaoFee } from './createDaoFee'
import { validateCreateForm, toParams } from './createDaoForm'
import { useStandardDao } from './useStandardDao'

// Spec 030 pillar A (US1) — launch a native standard DAO: an OpenZeppelin Governor + TimelockController
// treasury + a votes source, deployed in ONE transaction the member signs. ClearPath keeps no key over
// the result: the timelock's admin role is the timelock itself and the factory renounces its own before
// the transaction ends. Where the factory is not deployed this surface states WHY and offers nothing —
// a disabled button with no explanation is the failure mode this replaces.

const DEFAULTS = {
  name: '',
  purpose: '',
  tokenMode: 'new',
  tokenName: '',
  tokenSymbol: '',
  initialSupply: '1000000',
  votesToken: '',
  votingDelay: '1',
  votingPeriod: '50400',
  proposalThreshold: '0',
  quorumPercent: '4',
  timelockHours: '48',
}

export default function CreateStandardDao({ hasRegistryFor, track }) {
  const host = useMiniAppHost()
  const { chainId, isConnected, canCreate, createDAO, estimateCreateFee } = useStandardDao()
  const [form, setForm] = useState(DEFAULTS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)
  const [registering, setRegistering] = useState(false)
  const [registered, setRegistered] = useState(false)

  const net = host.network(chainId)
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  /*
   * The network fee, estimated live against the calldata this form would submit (issue #1408).
   *
   * Hooks run before the `canCreate` early return below can be reached — but the hook is inert
   * where there is no factory (`estimateCreateFee` answers `unavailable` without a read), so the
   * not-deployed branch costs nothing. Paused while submitting: the transaction is already priced
   * by then and the member is looking at their wallet, not at this.
   */
  const feeEstimate = useCreateDaoFee({ form, estimateCreateFee, enabled: !busy })

  // NOT DEPLOYED HERE — say which of the two reasons it is. "Pre-Cancun" is permanent (issue #1268);
  // "not deployed" is a state of the estate. Collapsing them would leave an ETC member waiting.
  if (!canCreate) {
    return (
      <div className="cp-card">
        <h4 style={{ marginBottom: '0.6rem' }}>Launch a DAO</h4>
        <div className="cp-notice" role="status">
          {nativeDaoUnavailableReason(chainId, net?.name)}
        </div>
      </div>
    )
  }

  async function onSubmit(e) {
    e.preventDefault()
    const problem = validateCreateForm(form)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setBusy(true)
    try {
      const result = await createDAO(toParams(form))
      // Only a CONFIRMED creation with real addresses is shown as a DAO. `proposed` and `pending` are
      // deliberately not (FR-004): a vault proposal has created nothing yet, and an unread receipt is
      // not a set of addresses.
      if (result.status === 'created') setCreated(result.dao)
    } catch {
      /* the hook already surfaced a truthful notification */
    } finally {
      setBusy(false)
    }
  }

  async function onRegister() {
    setRegistering(true)
    try {
      await track({
        address: created.governor,
        framework: 0, // OpenZeppelin Governor — which is exactly what the factory built
        label: created.name,
        chainId,
      })
      setRegistered(true)
    } catch {
      /* the hook already surfaced a truthful notification */
    } finally {
      setRegistering(false)
    }
  }

  if (created) {
    const onChainRegistry = Boolean(hasRegistryFor?.(chainId))
    return (
      <div className="cp-card">
        <h4 style={{ marginBottom: '0.6rem' }}>{created.name} is live</h4>
        <p className="cp-ok" role="status">✓ Deployed on {net?.name || `chain ${chainId}`}.</p>
        <div className="cp-kv"><span className="k">Governor</span><span className="cp-mono">{created.governor}</span></div>
        <div className="cp-kv"><span className="k">Treasury (timelock)</span><span className="cp-mono">{created.timelock}</span></div>
        <div className="cp-kv">
          <span className="k">{created.tokenDeployed ? 'Governance token (new)' : 'Governance token (existing)'}</span>
          <span className="cp-mono">{created.token}</span>
        </div>
        <p className="cp-intro">
          The DAO governs itself from here — ClearPath holds no key over it. Its treasury can only be moved
          by a proposal that passes and clears the timelock.
        </p>
        {registered ? (
          <p className="cp-ok" role="status">
            ✓ Added to your DAOs — open it to propose, vote, queue and execute.
          </p>
        ) : (
          <div className="cp-row-actions">
            <button type="button" className="cp-btn cp-btn-primary" disabled={registering} onClick={onRegister}>
              {registering
                ? 'Adding…'
                : onChainRegistry
                  ? 'Register in the DAO registry'
                  : 'Track this DAO on this device'}
            </button>
            <button type="button" className="cp-btn" onClick={() => { setCreated(null); setForm(DEFAULTS) }}>
              Launch another
            </button>
          </div>
        )}
        <p className="cp-intro">
          {onChainRegistry
            ? 'Registering records it on-chain so other members can find it. It grants ClearPath nothing.'
            : 'This network has no on-chain DAO registry, so the DAO is tracked on this device.'}
        </p>
      </div>
    )
  }

  return (
    <form className="cp-card" onSubmit={onSubmit}>
      <h4 style={{ marginBottom: '0.6rem' }}>Launch a DAO</h4>
      <p className="cp-intro">
        Deploys a standard OpenZeppelin Governor, a TimelockController treasury and — unless you bring your
        own — a governance token, in one transaction on {net?.name || `chain ${chainId}`}. Requires a Silver
        membership. The contracts are immutable and belong to the DAO: nobody, including FairWins, can
        upgrade or pause them afterwards.
      </p>

      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-name">DAO name</label>
        <input id="cp-dao-name" className="cp-input" value={form.name} onChange={set('name')} disabled={busy} />
      </div>
      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-purpose">Purpose (optional)</label>
        <input id="cp-dao-purpose" className="cp-input" value={form.purpose} onChange={set('purpose')} disabled={busy} />
      </div>

      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-token-mode">Voting power</label>
        <select id="cp-dao-token-mode" className="cp-input cp-select" value={form.tokenMode} onChange={set('tokenMode')} disabled={busy}>
          <option value="new">Create a new governance token</option>
          <option value="existing">Use an existing token or membership NFT</option>
        </select>
      </div>

      {form.tokenMode === 'new' ? (
        <>
          <div className="cp-field">
            <label className="cp-label" htmlFor="cp-dao-token-name">Token name</label>
            <input id="cp-dao-token-name" className="cp-input" value={form.tokenName} onChange={set('tokenName')} disabled={busy} />
          </div>
          <div className="cp-field">
            <label className="cp-label" htmlFor="cp-dao-token-symbol">Token symbol</label>
            <input id="cp-dao-token-symbol" className="cp-input" value={form.tokenSymbol} onChange={set('tokenSymbol')} disabled={busy} />
          </div>
          <div className="cp-field">
            <label className="cp-label" htmlFor="cp-dao-supply">Initial supply</label>
            <input id="cp-dao-supply" className="cp-input" inputMode="numeric" value={form.initialSupply} onChange={set('initialSupply')} disabled={busy} />
            <p className="cp-row-sub">Minted to you and delegated to you, so the DAO can vote immediately.</p>
          </div>
        </>
      ) : (
        <>
          <CpAddressField
            id="cp-dao-votes-token"
            label="Votes token address"
            value={form.votesToken}
            onChange={(v) => setForm((f) => ({ ...f, votesToken: v }))}
            disabled={busy}
          />
          <p className="cp-row-sub">
            Any contract implementing IVotes — an ERC20Votes token or an ERC721Votes / soulbound membership
            NFT. Holders must have delegated before their weight counts.
          </p>
        </>
      )}

      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-voting-delay">Voting delay (blocks)</label>
        <input id="cp-dao-voting-delay" className="cp-input" inputMode="numeric" value={form.votingDelay} onChange={set('votingDelay')} disabled={busy} />
      </div>
      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-voting-period">Voting period (blocks)</label>
        <input id="cp-dao-voting-period" className="cp-input" inputMode="numeric" value={form.votingPeriod} onChange={set('votingPeriod')} disabled={busy} />
      </div>
      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-threshold">Proposal threshold (tokens)</label>
        <input id="cp-dao-threshold" className="cp-input" inputMode="numeric" value={form.proposalThreshold} onChange={set('proposalThreshold')} disabled={busy} />
      </div>
      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-quorum">Quorum (% of supply)</label>
        <input id="cp-dao-quorum" className="cp-input" inputMode="numeric" value={form.quorumPercent} onChange={set('quorumPercent')} disabled={busy} />
      </div>
      <div className="cp-field">
        <label className="cp-label" htmlFor="cp-dao-timelock">Timelock delay (hours)</label>
        <input id="cp-dao-timelock" className="cp-input" inputMode="numeric" value={form.timelockHours} onChange={set('timelockHours')} disabled={busy} />
        <p className="cp-row-sub">How long a passed proposal waits before it can execute. Maximum 720 hours.</p>
      </div>

      {error && <div className="cp-error" role="alert">{error}</div>}

      {/*
        THE FEE DISCLOSURE, DIRECTLY ABOVE THE BUTTON (issue #1408).

        Two parts, and only the second one is conditional. `FEE_STATEMENT` is a fact about the
        transaction and renders whatever the network says; the estimate underneath states a number
        only when one was actually read, and otherwise says plainly that it could not be confirmed.
        A member must never be able to reach the signature without having been told a fee applies —
        which is why this sits at the button rather than in the intro paragraph they scrolled past.
      */}
      <div className="cp-fee">
        <span className="cp-fee-k">Network fee</span>
        <p className="cp-fee-v">{FEE_STATEMENT}</p>
        <p className="cp-fee-est" aria-live="polite">
          {describeFeeEstimate(feeEstimate, { symbol: net?.nativeCurrency?.symbol })}
        </p>
      </div>

      <div className="cp-row-actions">
        <button type="submit" className="cp-btn cp-btn-primary" disabled={busy || !isConnected}>
          {busy ? 'Launching…' : 'Launch DAO'}
        </button>
      </div>
      {!isConnected && (
        <p className="cp-row-sub">Connect a wallet on {net?.name || 'this network'} to launch a DAO.</p>
      )}
    </form>
  )
}
