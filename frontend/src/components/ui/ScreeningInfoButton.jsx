/**
 * ScreeningInfoButton (Spec 021 iteration 2; issue #1458 amendment) — an info (ⓘ)
 * button that explains how address screening works: every list on every cohort
 * network, green only when all of them answered clear, advisory pre-check, the
 * on-chain guard is the real enforcement, results fail closed. Links to the
 * detailed user-guide doc.
 *
 * Spec 039 rebased it on the shared InfoTip toggletip; the rich content keeps
 * dialog semantics.
 */

import InfoTip from './InfoTip'
import './ScreeningInfo.css'

export default function ScreeningInfoButton({ className = '' }) {
  return (
    <InfoTip
      label="How address screening works"
      bubbleRole="dialog"
      className={`screening-info ${className}`.trim()}
    >
      <h4>How address screening works</h4>
      <ul>
        <li>
          <strong>Every list, every network.</strong> An address is checked against the FairWins
          sanctions guard, the Chainalysis sanctions oracle and the USDC / USDT issuer freeze
          lists on every network this build can read. Expand the pill to see each answer.
        </li>
        <li>
          <strong>Green means all of them answered clear.</strong> One flag from any list is
          <em> Flagged</em>. One list that could not be read is <em>Partly screened</em> — never
          green, because a missing answer is not a clear one.
        </li>
        <li>
          <strong>Advisory only.</strong> The pill is a pre-check. It does <em>not</em> block
          anything by itself; the on-chain guard screens every participant independently, and an
          issuer freeze is enforced by the token itself.
        </li>
        <li>
          <strong>Fails closed.</strong> If no list can be reached, the address shows as
          <em> Unscreened</em> — never as clear.
        </li>
      </ul>
      <p className="ab-info-doc">
        See the{' '}
        <a
          href="https://docs.fairwins.app/user-guide/address-book/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Address Book &amp; screening guide
        </a>{' '}
        for full details.
      </p>
    </InfoTip>
  )
}
