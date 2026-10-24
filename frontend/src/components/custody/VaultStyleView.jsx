// Spec 102 (US4, FR-009) — the vault sheet's Style view: the spec-086 customize body against the
// vault ADDRESS. The profile store keys by address, so one look applies on every network the
// vault lives on; cosmetics never fork per chain.

import PropTypes from 'prop-types'
import AccountCustomizeBody from '../account/AccountCustomizeBody'
import { shortAccountAddr } from '../../hooks/useAccountSwitcher'

export default function VaultStyleView({ group }) {
  const label = group.label || shortAccountAddr(group.address)
  const count = group.chainIds?.length ?? 0
  return (
    <>
      <p className="vault-style__intro" data-testid="vault-style-intro">
        This look applies to {label} on every network{count > 1 ? ` (${count})` : ''}.
      </p>
      <AccountCustomizeBody account={{ address: group.address, label, kind: 'vault' }} />
    </>
  )
}

VaultStyleView.propTypes = {
  group: PropTypes.object.isRequired,
}
