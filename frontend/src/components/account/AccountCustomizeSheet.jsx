/**
 * Spec 086 (FR-008) — the ONE surface for customizing an account's card, opened from any account
 * card. Changes apply immediately (the store is reactive), so the member watches the header
 * avatar, the switcher and the card itself update live; "Reset card" returns to the defaults.
 *
 * Spec 102 — the body lives in AccountCustomizeBody (the vault sheet's Style view mounts it
 * without this chrome); this component is that body inside the shared ActionSheet, with "Done"
 * as the trailing action and the close gated while a picture is being prepared.
 */

import { useCallback, useState } from 'react'
import PropTypes from 'prop-types'
import ActionSheet from './ActionSheet'
import AccountCustomizeBody from './AccountCustomizeBody'

export default function AccountCustomizeSheet({ open, onClose, account }) {
  const [busy, setBusy] = useState(false)

  const close = useCallback(() => {
    if (busy) return
    onClose?.()
  }, [busy, onClose])

  return (
    <ActionSheet open={open} onClose={close} title="Customize card" closeDisabled={busy} className="action-sheet--customize">
      <AccountCustomizeBody
        account={account}
        onBusyChange={setBusy}
        trailingActions={
          <button type="button" className="btn-primary" onClick={close} disabled={busy} data-testid="acs-done">
            Done
          </button>
        }
      />
    </ActionSheet>
  )
}

AccountCustomizeSheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  /** { address, label } — the account whose card is being customized. */
  account: PropTypes.object,
}
