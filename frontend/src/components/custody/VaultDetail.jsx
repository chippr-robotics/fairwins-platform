// Spec 043 (US1) — a single vault's live on-chain state: address, network, owners, threshold, balance.
// Honest state: everything shown here is read from chain (owners/threshold/nonce) or is a local label.
// Spec 049 (US2/US3) — carries the Policy section (PolicyPanel). `onProposePolicy` is the spec 043
// proposal-queue submit (useVaultProposals.propose); when absent (view-only member, wrong network)
// the section is read-only.
// Spec 068 (US1) — the network row names the chain (not a bare id), and a vault on a chain other
// than the connected one renders READ-ONLY with a switch prompt: no state-changing action may be
// offered for a vault the wallet cannot act on (FR-004).
// Spec 102 — `variant="network"`: one INSTANCE's facts + policy block inside the vault sheet's
// Details view, which already shows the address, the owners (cross-referenced) and the remove
// action once for the whole vault — so this variant renders none of those.

import PolicyPanel from './PolicyPanel'
import PolicyPanelV2 from './PolicyPanelV2'
import { isPolicyV2Supported } from '../../lib/custody/policyV2'

export default function VaultDetail({
  vault,
  onForget,
  isActiveIdentity,
  onProposePolicy,
  onSwitchNetwork,
  proposalQueue = [],
  variant = 'default',
}) {
  if (!vault) return null
  const network = variant === 'network'
  const chainLabel = vault.chainName ? `${vault.chainName} (${vault.chainId})` : String(vault.chainId)
  // Default to "on chain" when the flag is absent so legacy call sites keep their behavior.
  const onVaultChain = vault.onVaultChain !== false

  if (vault.reachable === false) {
    return (
      <div className="custody-vault-detail" role="region" aria-label="Vault detail">
        <p className="custody-error" role="alert">
          Could not reach {chainLabel} to read this vault. Its details will appear when the network
          responds; nothing about the vault has changed.
        </p>
        {onForget && (
          <button type="button" onClick={() => onForget(vault.address, vault.chainId)}>
            Remove from list
          </button>
        )}
      </div>
    )
  }

  if (vault.isSafe === false) {
    return (
      <div className="custody-vault-detail" role="region" aria-label="Vault detail">
        <p className="custody-error" role="alert">
          Could not read a Safe at <code>{vault.address}</code> on {chainLabel}.
        </p>
        {onForget && (
          <button type="button" onClick={() => onForget(vault.address, vault.chainId)}>
            Remove from list
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className={`custody-vault-detail${network ? ' custody-vault-detail--network' : ''}`}
      role="region"
      aria-label={network ? `${vault.chainName || `Chain ${vault.chainId}`} detail` : 'Vault detail'}
    >
      {!onVaultChain && (
        <div className="custody-warning" role="status">
          <p>
            This vault lives on {chainLabel}. You are connected to a different network, so it is
            shown read-only.
          </p>
          {onSwitchNetwork && (
            <button type="button" onClick={() => onSwitchNetwork(vault.chainId)}>
              Switch to {vault.chainName || `chain ${vault.chainId}`}
            </button>
          )}
        </div>
      )}
      <dl className="custody-vault-facts">
        {!network && (
          <div>
            <dt>Address</dt>
            <dd>
              <code>{vault.address}</code>
            </dd>
          </div>
        )}
        {variant !== 'network' && (
          <div>
            <dt>Network</dt>
            <dd>
              {chainLabel}
              {vault.isTestnet ? ' · testnet' : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>Threshold</dt>
          <dd>
            {vault.threshold} of {vault.owners?.length} owners
          </dd>
        </div>
        <div>
          <dt>Your role</dt>
          <dd>{vault.owner ? 'Owner (can propose & approve)' : 'View-only'}</dd>
        </div>
        {vault.version && (
          <div>
            <dt>Safe version</dt>
            <dd>{vault.version}</dd>
          </div>
        )}
      </dl>
      {!network && (
        <>
          <h5>Owners</h5>
          <ul className="custody-owner-addresses">
            {(vault.owners || []).map((o) => (
              <li key={o}>
                <code>{o}</code>
                {vault.ownerNames?.[o] && <span className="custody-owner-name"> · {vault.ownerNames[o]}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Policy changes are state-changing, so they are only proposable on the vault's own chain.
          Where the ordered engine (spec 068) is deployed it owns this section — it renders legacy
          v1 policies read-only with an upgrade path, so nothing is hidden from members still on v1;
          elsewhere the v1 panel keeps serving unchanged. */}
      {isPolicyV2Supported(vault.chainId) ? (
        <PolicyPanelV2
          vault={vault}
          onPropose={onVaultChain ? onProposePolicy : undefined}
          queue={proposalQueue}
        />
      ) : (
        <PolicyPanel
          vault={vault}
          onPropose={onVaultChain ? onProposePolicy : undefined}
          ariaLabel={network ? `${vault.chainName || `Chain ${vault.chainId}`} policy` : undefined}
        />
      )}
      {/* A vault is an account you can act as, chosen from the account switcher next to your
          biticon — the same place recovered accounts live. It is not a mode you enter from a
          separate button here, so there is no "Operate as this vault": one way to switch accounts,
          wherever you are in the app. This line just says where. */}
      {!network && vault.owner && onVaultChain && (
        <p className="custody-hint" role="note">
          {isActiveIdentity
            ? 'You are acting as this vault. Switch back from the account menu next to your avatar.'
            : 'To spend from this vault, pick it in the account menu next to your avatar, then use Transfer as usual.'}
        </p>
      )}
      {!network && (
        <div className="custody-actions">
          {onForget && (
            <button type="button" className="custody-link" onClick={() => onForget(vault.address, vault.chainId)}>
              Remove from list
            </button>
          )}
        </div>
      )}
    </div>
  )
}
