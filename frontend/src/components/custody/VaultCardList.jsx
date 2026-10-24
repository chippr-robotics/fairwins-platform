// Spec 102 (US1, FR-001/FR-002) — one compact card per VAULT, in the spec-086 account-card
// language. A Safe at one address on six networks is one card: the network line says how many,
// the meta line carries the threshold, the policy badge and the pending count, and the "Active"
// mark shows which vault the member is acting as. Nothing expands inline; the card and its "⋯"
// both open the vault sheet (VaultSheet).
//
// The card is a `role=option` button (AccountCard). A listbox may own nothing interactive but its
// options, so the "⋯" controls live in a SIBLING overlay layer OUTSIDE the listbox and are pinned
// to each card's measured top-right corner — the AccountCardsCarousel precedent, extended to every
// card. Inside the listbox each card sits in a presentational wrapper (the grid cell).
//
// Honesty (FR-019): a threshold is only shown when a readable instance supplied one; instances
// that disagree read "varies by network"; a vault whose only networks could not be read names
// them — never "0 of 0", never a blank that reads as "no threshold".

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import AccountCard from '../account/AccountCard'
import PolicyBadge from './PolicyBadge'
import { useVaultQueueAcrossChains } from '../../hooks/useVaultQueueAcrossChains'
import { shortAccountAddr } from '../../hooks/useAccountSwitcher'
import { chainDisplayName, listChainNames } from '../../lib/custody/chainName'
import './VaultSheet.css'

const MENU_SIZE = 36
const MENU_INSET = 8

/** The threshold line for a group, or the honest reason there is none. */
function thresholdLine(group) {
  if (group.thresholdVaries) return 'varies by network'
  if (group.threshold && group.threshold.of > 0) return `${group.threshold.value} of ${group.threshold.of}`
  if (group.readable?.length > 0) return null
  const unreachable = group.unreachable || []
  if (unreachable.length > 0) return `${listChainNames(unreachable)} unreachable`
  if ((group.unreadable || []).length > 0) return 'unreadable'
  return null
}

/**
 * The pending count on the card comes from the same cross-chain read the sheet's Queue uses
 * (session-cached log scans, so opening the sheet does not pay for it twice). A chain that could
 * not be read contributes nothing and the count says so with a trailing "+", never a bare number
 * that claims to be the whole estate.
 */
function VaultPendingBadge({ group }) {
  const { pending, missing, loading } = useVaultQueueAcrossChains(group)
  if (loading && pending === 0) return null
  const partial = (missing || []).length > 0
  if (pending === 0 && !partial) return null
  if (pending === 0) return null
  return (
    <span className="vault-card-meta__pending" data-testid="vault-card-pending" data-partial={partial ? 'true' : 'false'}>
      {pending}
      {partial ? '+' : ''} pending
    </span>
  )
}

VaultPendingBadge.propTypes = { group: PropTypes.object.isRequired }

function VaultCardMeta({ group }) {
  const threshold = thresholdLine(group)
  return (
    <span className="vault-card-meta">
      {threshold && <span className="vault-card-meta__threshold">{threshold}</span>}
      <PolicyBadge status={group.policyStatus} summary={group.policySummary} />
      <VaultPendingBadge group={group} />
    </span>
  )
}

VaultCardMeta.propTypes = { group: PropTypes.object.isRequired }

export default function VaultCardList({ groups, actingAddress, onOpen }) {
  const hostRef = useRef(null)
  const itemRefs = useRef({})
  const [positions, setPositions] = useState({})

  // Pin each "⋯" to the MEASURED corner of its card: the overlay is a sibling of the listbox, so
  // CSS alone cannot place it. Re-measured whenever the host resizes (a wrapping label changes a
  // row's height) and when the list changes.
  const measure = useCallback(() => {
    const host = hostRef.current
    if (!host) return
    const hostRect = host.getBoundingClientRect()
    const next = {}
    for (const [key, el] of Object.entries(itemRefs.current)) {
      if (!el) continue
      const r = el.getBoundingClientRect()
      next[key] = { left: r.right - hostRect.left - MENU_SIZE - MENU_INSET, top: r.top - hostRect.top + MENU_INSET }
    }
    setPositions(next)
  }, [])

  const count = groups?.length ?? 0
  useLayoutEffect(() => {
    measure()
    const host = hostRef.current
    const ro = typeof ResizeObserver === 'function' && host ? new ResizeObserver(() => measure()) : null
    ro?.observe(host)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure, count])

  if (!count) {
    return (
      <p className="custody-hint" role="status">
        No vaults yet.
      </p>
    )
  }
  const actingLc = actingAddress ? String(actingAddress).toLowerCase() : null

  const cards = groups.map((group) => {
    const lower = String(group.address).toLowerCase()
    const label = group.label || shortAccountAddr(group.address)
    const networkLine =
      group.networkLine || (group.chainIds?.length === 1 ? chainDisplayName(group.chainIds[0]) : `${group.chainIds?.length ?? 0} networks`)
    return { group, lower, label, networkLine, active: actingLc === lower }
  })

  return (
    <div className="vault-card-list" ref={hostRef}>
      <div className="vault-card-list__options" role="listbox" aria-label="Your vaults">
        {cards.map(({ group, lower, label, networkLine, active }) => (
          <div
            key={group.key || lower}
            role="presentation"
            className="vault-card-list__item"
            data-testid={`vault-card-${lower}`}
            ref={(el) => {
              if (el) itemRefs.current[lower] = el
              else delete itemRefs.current[lower]
            }}
          >
            <AccountCard
              account={{ kind: 'vault', address: group.address, label }}
              active={active}
              network={networkLine}
              balance={<VaultCardMeta group={group} />}
              idleLabel="Tap to open"
              onSelect={() => onOpen(group.address, 'queue')}
            />
          </div>
        ))}
      </div>

      {/* The "⋯" layer: DOM-wise outside the listbox (an option may hold no interactive children,
          and a listbox may own only options), visually on each card's corner. */}
      <div className="vault-card-list__menus">
        {cards.map(({ group, lower, label }) => (
          <button
            key={group.key || lower}
            type="button"
            className="vault-card-menu"
            style={positions[lower] ? { left: positions[lower].left, top: positions[lower].top } : undefined}
            aria-label={`Open ${label} vault`}
            aria-haspopup="dialog"
            data-testid={`vault-menu-${lower}`}
            onClick={() => onOpen(group.address, 'queue')}
          >
            ⋯
          </button>
        ))}
      </div>
    </div>
  )
}

VaultCardList.propTypes = {
  /** VaultGroup[] from useCustodyVaults().groups (lib/custody/vaultGroups). */
  groups: PropTypes.array,
  /** The vault the member is acting as (CustodyContext), or null. */
  actingAddress: PropTypes.string,
  /** (address, view) → open the vault sheet. */
  onOpen: PropTypes.func.isRequired,
}
