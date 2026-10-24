// Spec 102 (US5, FR-011) — one owner of a vault, cross-referenced against the member's identity
// sources in the mandated priority: address book > callsign > ENS > generated. The connected
// wallet reads "You"; every other owner shows its resolved name, WHERE the name came from, and
// its short address. An owner absent from the address book gets an inline "Add to address book"
// that creates the contact on every network the vault lives on (the member's explicit tap).

import { useState } from 'react'
import PropTypes from 'prop-types'
import { useOpponentName } from '../../hooks/useOpponentName'
import { useAddressBook } from '../../hooks/useAddressBook'
import { shortAccountAddr } from '../../hooks/useAccountSwitcher'

const SOURCE_LABEL = {
  addressBook: 'address book',
  callsign: 'callsign',
  ens: 'ENS',
  generated: 'generated',
}

export default function VaultOwnerRow({ address, chainIds, isYou = false }) {
  const resolved = useOpponentName(address, { chainId: chainIds?.[0] })
  const { addContact } = useAddressBook()
  // After a successful add the row shows the contact it just wrote, without waiting for a
  // store round-trip — the write IS the fact, and the resolver re-reads the book on its next
  // recompute anyway.
  const [added, setAdded] = useState(null)
  const [error, setError] = useState(null)

  const displayName = added?.nickname ?? resolved.displayName
  const source = added ? 'addressBook' : resolved.source
  const lower = String(address).toLowerCase()

  const add = () => {
    setError(null)
    try {
      const contact = addContact({
        nickname: resolved.displayName,
        addresses: (chainIds || []).map((chainId) => ({ address, chainId: Number(chainId), notes: '' })),
      })
      setAdded({ nickname: contact?.nickname ?? resolved.displayName })
    } catch (e) {
      setError(e?.message || 'Could not add this owner to the address book.')
    }
  }

  return (
    <li className="vault-owner-row" data-testid="vault-owner-row" data-address={lower} data-source={isYou ? 'you' : source}>
      {isYou ? (
        <span className="vault-owner-row__name">You</span>
      ) : (
        <>
          <span className="vault-owner-row__name">{displayName}</span>
          <span className="vault-owner-row__source">{SOURCE_LABEL[source] || source}</span>
        </>
      )}
      <span className="vault-owner-row__addr">{shortAccountAddr(address)}</span>
      {!isYou && source !== 'addressBook' && (
        <button type="button" className="vault-owner-row__add" onClick={add} data-testid="vault-owner-add-book">
          Add to address book
        </button>
      )}
      {error && (
        <span className="custody-error" role="alert">
          {error}
        </span>
      )}
    </li>
  )
}

VaultOwnerRow.propTypes = {
  address: PropTypes.string.isRequired,
  /** Every chain on which this address is an owner of the vault. */
  chainIds: PropTypes.array,
  isYou: PropTypes.bool,
}
