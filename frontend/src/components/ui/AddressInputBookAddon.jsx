/**
 * AddressInputBookAddon (Spec 021, US3) — the hook-driven address-book affordance
 * attached to AddressInput. Kept separate so AddressInput only pays for the
 * address-book hooks (which require a connected wallet context) when the feature
 * is explicitly enabled.
 */

import { useState, useMemo, useCallback } from 'react'
import { useAddressBook } from '../../hooks/useAddressBook'
import { useEstateScreeningMany } from '../../hooks/useEstateScreening'
import { getNetwork } from '../../config/networks'
import { isValidAddress } from '../../lib/addressBook/addressBookStore'
import { VERDICTS } from '../../lib/screening/verdict'
import AddressBookPicker from './AddressBookPicker'
import RestrictionTag from '../account/RestrictionTag'
import './AddressBookField.css'

const netName = (id) => getNetwork(id)?.name || `Chain ${id}`

export default function AddressInputBookAddon({ query = '', chainId, resolvedAddress, onPick }) {
  const { search } = useAddressBook()
  const [open, setOpen] = useState(false)

  const entries = useMemo(() => search(query), [search, query])

  // Estate verdicts, so a saved address reads the same here as it does in the notice under the
  // field and in the address book (issue #1458): three surfaces, one sweep, one vocabulary.
  const screenAddr =
    resolvedAddress && isValidAddress(resolvedAddress) ? resolvedAddress : null
  const screened = useMemo(
    () => [...entries.map((e) => e.address), ...(screenAddr ? [screenAddr] : [])],
    [entries, screenAddr],
  )
  const { getVerdictOn } = useEstateScreeningMany(screened)

  const handleSelect = useCallback(
    (entry) => {
      onPick?.(entry.address)
      setOpen(false)
    },
    [onPick],
  )

  const status = screenAddr ? getVerdictOn(screenAddr, chainId) : null

  return (
    <div className="ab-field-addon">
      <div className="ab-field-addon-row">
        <button
          type="button"
          className="ab-btn ab-btn-xs"
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((o) => !o)}
        >
          Address book
        </button>
        {screenAddr &&
          (status === VERDICTS.FLAGGED ||
            status === VERDICTS.PARTIAL ||
            status === VERDICTS.UNSCREENED) && <RestrictionTag status={status} />}
      </div>
      {open &&
        (entries.length ? (
          <AddressBookPicker
            entries={entries}
            getStatus={getVerdictOn}
            networkName={netName}
            onSelect={handleSelect}
          />
        ) : (
          <p className="ab-picker-empty" role="note">
            No saved contacts match.
          </p>
        ))}
    </div>
  )
}
