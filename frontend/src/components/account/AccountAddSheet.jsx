/**
 * AccountAddSheet (release 1.14.0) — the chooser behind the carousel's "+" control: the three
 * ways an account can join the member's card list, each an existing surface this sheet only
 * NAVIGATES to (it re-implements none of them):
 *
 *   - a multisig vault        → Protect ▸ On chain   (spec 043/068, card `custody-onchain`)
 *   - a hardware account      → Protect ▸ Off chain  (spec 085,     card `custody-offchain`)
 *   - a legacy account        → Recovery ▸ Legacy account recovery (spec 062, `legacy-recovery`)
 *
 * Targets resolve through `pathForDestination` — the SAME deep-link builder the drawer search
 * uses — so each option lands with the accordion card OPEN (`#card` hash) and the attention
 * flash pointing at it (`focus=<id>`), and this sheet can never drift from where the drawer
 * sends people for the same three surfaces.
 */

import { useNavigate } from 'react-router-dom'
import PropTypes from 'prop-types'
import ActionSheet from './ActionSheet'
import { pathForDestination } from '../../config/navSearchIndex'
import './AccountAddSheet.css'

const OPTIONS = [
  {
    id: 'vault',
    destination: 'custody-onchain',
    label: 'Add a vault',
    description: 'A Safe multisig you co-control with others — created or joined in Protect.',
  },
  {
    id: 'hardware',
    destination: 'custody-offchain',
    label: 'Add a hardware account',
    description: 'Cold storage with a Ledger or Trezor — connected in Protect ▸ Off chain.',
  },
  {
    id: 'legacy',
    destination: 'legacy-recovery',
    label: 'Recover a legacy account',
    description: 'Import an old private key or word list in Recovery, and optionally move its funds.',
  },
]

export default function AccountAddSheet({ open, onClose }) {
  const navigate = useNavigate()

  const go = (destination) => {
    onClose?.()
    navigate(pathForDestination(destination))
  }

  return (
    <ActionSheet open={open} onClose={onClose} title="Add an account" className="account-add-sheet">
      <p className="account-add-sheet__intro">
        Accounts you add show up here as cards you can act as.
      </p>
      <div className="account-add-sheet__options">
        {OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className="account-add-sheet__option"
            onClick={() => go(opt.destination)}
          >
            <span className="account-add-sheet__option-label">{opt.label}</span>
            <span className="account-add-sheet__option-desc">{opt.description}</span>
          </button>
        ))}
      </div>
    </ActionSheet>
  )
}

AccountAddSheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
}
