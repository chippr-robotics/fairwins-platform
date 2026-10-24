/**
 * Device-loss warning (spec 041, T051 — US5/FR-021).
 *
 * Shown at the three mandated moments — account creation, first funding,
 * membership purchase — whenever the account is protected by a SINGLE
 * device-bound credential. Dismissals are tracked per moment in the local
 * AccountProfile but RE-ARM until a second controller exists: the risk is
 * real until then, so the warning is too.
 *
 * The three mounts (issue #1405):
 *   creation            HomeScreen — the surface the ceremony lands on
 *   first-funding       MyAccountView — the wallet home, once the portfolio
 *                       reports a non-zero balance for this account
 *   membership-purchase PremiumPurchaseModal — the Review step, before the
 *                       member signs
 *
 * WHILE THE CONTROLLER SET IS STILL LOADING NOTHING RENDERS. `controllers`
 * is `[]` before the read answers, so `singleControllerRisk` is true for
 * every account for a moment — including two-key ones, which would see a
 * warning flash that is not true of them. Once the read HAS answered, an
 * empty set is a real answer: a counterfactual account (not yet deployed)
 * genuinely has exactly the one local credential, which is the case FR-021
 * exists for.
 */

import { useState, useCallback } from 'react'
import PropTypes from 'prop-types'
import { usePasskeyAccount } from '../../hooks/usePasskeyAccount'
import { WARNING_MOMENTS, dismissedAt, recordDismissal } from '../../lib/passkey/accountProfile'
import './DeviceLossWarning.css'

function DeviceLossWarning({ moment, onAddController, deps = {} }) {
  const account = usePasskeyAccount(deps)
  // Read the stored dismissal EVERY render, not once in a lazy initializer.
  // The address arrives asynchronously (the controller read resolves after the
  // first paint), so a one-shot initializer runs while `account.address` is
  // still null, answers "not dismissed", and never looks again — which is
  // exactly how a dismissal that IS on disk comes back on the next visit.
  const stored = account.address ? dismissedAt(account.address, moment, deps.storage) : false
  const [dismissedNow, setDismissedNow] = useState(false)
  const dismissed = dismissedNow || stored

  const dismiss = useCallback(() => {
    recordDismissal(account.address, moment, deps.storage)
    setDismissedNow(true)
  }, [account.address, moment, deps.storage])

  if (account.loading || !account.isPasskeySession || !account.singleControllerRisk || dismissed) return null

  return (
    <aside className="device-loss-warning" role="alert" data-testid={`device-loss-warning-${moment}`}>
      <strong>One passkey guards this account.</strong>
      <p>
        If you lose this device (and your platform doesn&apos;t sync passkeys), you lose access to these
        funds — FairWins can&apos;t recover them for you, by design. Add a second passkey or link a
        wallet now.
      </p>
      <div className="device-loss-warning__actions">
        <button type="button" className="btn btn-primary" onClick={onAddController}>
          Add a backup now
        </button>
        <button type="button" className="btn" onClick={dismiss}>
          I understand the risk
        </button>
      </div>
    </aside>
  )
}

DeviceLossWarning.propTypes = {
  moment: PropTypes.oneOf(WARNING_MOMENTS).isRequired,
  onAddController: PropTypes.func,
  deps: PropTypes.object,
}

export default DeviceLossWarning
