/**
 * The membership eligibility attestations (Spec 007 — US5, FR-035…FR-038).
 * Lives beside MembershipAttestation.jsx in its own module so the component
 * file exports only the component (react-refresh/only-export-components).
 */
export const ATTESTATIONS = [
  { id: 'age', label: 'I am at least 21 years of age.' },
  { id: 'jurisdiction', label: 'I am not located, resident, or established in any Restricted Jurisdiction defined in the Terms.' },
  { id: 'sanctions', label: 'I am not, and do not act on behalf of, any person subject to sanctions or named on any restricted-party list (including the OFAC SDN list).' },
  { id: 'norecourse', label: 'I understand FairWins is not a registered exchange, broker, or regulated gambling operator, that there is no regulator or authority to which I can appeal a dispute, and that wager outcomes are settled by smart contract and the published dispute-resolution mechanism.' },
  { id: 'risk', label: 'I understand I may lose the entire amount of any wager, that I bear sole responsibility for my own tax reporting, and that I have sole control of my wallet and private keys.' },
  { id: 'novpn', label: 'I have not used, and will not use, any VPN, proxy, or other means to circumvent eligibility or geographic restrictions.' },
  { id: 'terms', label: 'I have read and agree to the Terms & Conditions and the Risk Disclosure.' },
]
