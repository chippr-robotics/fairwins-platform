import { useState, useEffect } from 'react'

import { ATTESTATIONS } from './attestations'

/**
 * MembershipAttestation (Spec 007 — US5, FR-035/FR-036/FR-037/FR-038)
 *
 * Discrete, individually-ticked, un-pre-ticked eligibility attestations shown at membership
 * purchase/upgrade. Calls onChange(allTicked) so the parent gates its purchase button; the
 * accepted T&C version is recorded on-chain by the purchase tx (purchaseTierWithTerms).
 * WCAG 2.1 AA: fieldset/legend, programmatically-associated checkbox labels.
 */


export default function MembershipAttestation({ onChange }) {
  const [ticks, setTicks] = useState(() => Object.fromEntries(ATTESTATIONS.map((a) => [a.id, false])))

  const allTicked = ATTESTATIONS.every((a) => ticks[a.id])

  useEffect(() => {
    onChange?.(allTicked)
  }, [allTicked, onChange])

  const toggle = (id) => setTicks((t) => ({ ...t, [id]: !t[id] }))

  return (
    <section className="membership-attestation" aria-labelledby="membership-attest-title">
      <h3 id="membership-attest-title">Membership confirmation</h3>
      <p>
        Your membership pass grants access to the FairWins platform. <strong>It is a fee for
        access only.</strong> It is not a wager, a stake, a deposit, an investment, a security,
        or a balance held on your behalf; it confers no ownership interest, no profit
        expectation, and no claim on any pool of funds. Membership fees are not pooled, staked,
        wagered, or returned as winnings, and are <strong>non-refundable</strong> — including if
        you are later restricted, suspended, or unable to access the platform.
      </p>
      <p className="membership-attestation-review">
        Before agreeing, please read the{' '}
        <a href="/terms" target="_blank" rel="noopener noreferrer">Terms &amp; Conditions</a> and{' '}
        <a href="/risk" target="_blank" rel="noopener noreferrer">Risk Disclosure</a>.
      </p>
      <fieldset>
        <legend>By purchasing or upgrading, I confirm and agree:</legend>
        {ATTESTATIONS.map((a) => (
          <div className="attestation-row" key={a.id}>
            <input
              type="checkbox"
              id={`attest-${a.id}`}
              checked={ticks[a.id]}
              onChange={() => toggle(a.id)}
            />
            <label htmlFor={`attest-${a.id}`}>{a.label}</label>
          </div>
        ))}
      </fieldset>
    </section>
  )
}

