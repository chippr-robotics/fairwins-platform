import { useState } from 'react'
import PropTypes from 'prop-types'
import AmountKeypad from '../ui/AmountKeypad'

/**
 * ContributeControl (spec 103, US2) — the amount pad + the one primary action. The parent owns
 * submission; this only enforces "an amount above zero" and disables while a transaction is in flight.
 */
export default function ContributeControl({ summary, onContribute, busy, isConnected, onConnect }) {
  const [amount, setAmount] = useState('')
  const valid = Number.isFinite(Number(amount)) && Number(amount) > 0
  return (
    <section className="fp-contribute" aria-label="Contribute" data-testid="contribute-control">
      <AmountKeypad
        value={amount}
        onChange={setAmount}
        prefix="$"
        token={summary.tokenSymbol}
        disabled={busy}
        ariaLabel="Amount to contribute"
        id="fp-amount"
      />
      {!isConnected ? (
        <button type="button" className="fm-btn-primary fp-primary" onClick={onConnect}>Connect wallet to contribute</button>
      ) : (
        <button
          type="button"
          className="fm-btn-primary fp-primary"
          data-testid="contribute"
          disabled={!valid || busy}
          onClick={() => onContribute(amount).then(() => setAmount(''), () => {})}
        >
          {busy ? 'Contributing…' : valid ? `Contribute ${amount} ${summary.tokenSymbol}` : 'Contribute'}
        </button>
      )}
      <p className="fp-muted fp-small">Any amount. You can contribute more than once. Contributions are refundable only if the pool is refunded.</p>
    </section>
  )
}

ContributeControl.propTypes = {
  summary: PropTypes.shape({ tokenSymbol: PropTypes.string }).isRequired,
  onContribute: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  isConnected: PropTypes.bool,
  onConnect: PropTypes.func,
}
