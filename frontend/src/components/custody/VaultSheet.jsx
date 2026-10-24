// Spec 102 (US3/US4/US5, FR-004) — the vault sheet: one bottom sheet per VAULT (an address, on
// every network it lives on) with three views — Queue, Style, Details — as a tablist.
//
// It re-resolves its group from the live list on EVERY render (the Portfolio AssetDetailSheet
// precedent): the list refreshes underneath an open sheet, and a vault that vanished (removed on
// another surface, or the wallet disconnected) closes the sheet rather than showing stale facts.
//
// Built on the shared ActionSheet (focus trap, Escape, scroll lock, mobile bottom sheet). The
// initial view is derived from props DURING render when the sheet opens or retargets (the
// VaultActionSheet `seen` pattern) — an effect would paint the previous view for one frame.

import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import ActionSheet from '../account/ActionSheet'
import AccountAvatar from '../account/AccountAvatar'
import { useCustodyVaults } from '../../hooks/useCustodyVaults'
import { shortAccountAddr } from '../../hooks/useAccountSwitcher'
import { chainDisplayName, isTestnetChain } from '../../lib/custody/chainName'
import VaultQueueView from './VaultQueueView'
import VaultStyleView from './VaultStyleView'
import VaultDetailsView from './VaultDetailsView'
import './VaultSheet.css'

const VAULT_VIEWS = ['queue', 'style', 'details']
const VIEW_LABEL = { queue: 'Queue', style: 'Style', details: 'Details' }

function normalizeView(view) {
  return VAULT_VIEWS.includes(view) ? view : 'queue'
}

export default function VaultSheet({ open, address, initialView = 'queue', onClose, onVaultsChanged }) {
  const custody = useCustodyVaults()
  const groups = custody.groups || []
  const key = address ? String(address).toLowerCase() : null
  const group = key ? groups.find((g) => g.key === key || String(g.address).toLowerCase() === key) || null : null

  const [view, setView] = useState(normalizeView(initialView))
  const [seen, setSeen] = useState({ open, address, initialView })
  if (seen.open !== open || seen.address !== address || seen.initialView !== initialView) {
    setSeen({ open, address, initialView })
    if (open) setView(normalizeView(initialView))
  }

  // A vault that is no longer in the list closes the sheet. Only once the list has actually
  // loaded — an empty list during the first read is "not yet known", not "gone".
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  const vanished = open && Boolean(key) && !custody.loading && !group
  useEffect(() => {
    if (vanished) onCloseRef.current?.()
  }, [vanished])

  // The sheet panel scrolls; a view change must not inherit the previous view's offset.
  const tabsRef = useRef(null)
  useEffect(() => {
    const panel = tabsRef.current?.closest('.action-sheet')
    if (panel) panel.scrollTop = 0
  }, [view])

  if (!open || !group) return null

  const label = group.label || shortAccountAddr(group.address)
  const chainIds = group.chainIds || []
  const testnets = chainIds.filter(isTestnetChain)
  const networkLine =
    chainIds.length === 1 ? chainDisplayName(chainIds[0]) : group.networkLine || `${chainIds.length} networks`

  const onTabKey = (e) => {
    const idx = VAULT_VIEWS.indexOf(view)
    let next = null
    if (e.key === 'ArrowRight') next = VAULT_VIEWS[(idx + 1) % VAULT_VIEWS.length]
    else if (e.key === 'ArrowLeft') next = VAULT_VIEWS[(idx - 1 + VAULT_VIEWS.length) % VAULT_VIEWS.length]
    else if (e.key === 'Home') next = VAULT_VIEWS[0]
    else if (e.key === 'End') next = VAULT_VIEWS[VAULT_VIEWS.length - 1]
    if (!next) return
    e.preventDefault()
    setView(next)
    tabsRef.current?.querySelector(`[data-testid="vault-tab-${next}"]`)?.focus()
  }

  const refreshAll = () => {
    custody.refresh?.()
    onVaultsChanged?.()
  }

  return (
    <ActionSheet open={open} onClose={onClose} title={label} className="vault-sheet">
      <div className="vault-sheet__identity">
        <AccountAvatar address={group.address} size={36} />
        <div className="vault-sheet__identity-text">
          <span className="vault-sheet__label">{label}</span>
          <span className="vault-sheet__addr">{shortAccountAddr(group.address)}</span>
          <span className="vault-sheet__networks" data-testid="vault-sheet-networks">
            {networkLine}
            {testnets.length > 0 ? ` · testnet${testnets.length === chainIds.length ? '' : ' included'}` : ''}
          </span>
        </div>
      </div>

      <div ref={tabsRef} role="tablist" aria-label="Vault views" className="vault-sheet__tabs">
        {VAULT_VIEWS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`vault-tab-${id}`}
            aria-selected={view === id}
            aria-controls={`vault-panel-${id}`}
            tabIndex={view === id ? 0 : -1}
            className="vault-sheet__tab"
            data-testid={`vault-tab-${id}`}
            onClick={() => setView(id)}
            onKeyDown={onTabKey}
          >
            {VIEW_LABEL[id]}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`vault-panel-${view}`}
        aria-labelledby={`vault-tab-${view}`}
        className="vault-sheet__panel"
        data-testid={`vault-panel-${view}`}
      >
        {view === 'queue' && <VaultQueueView group={group} />}
        {view === 'style' && <VaultStyleView group={group} />}
        {view === 'details' && <VaultDetailsView group={group} onClose={onClose} onVaultsChanged={refreshAll} />}
      </div>
    </ActionSheet>
  )
}

VaultSheet.propTypes = {
  open: PropTypes.bool,
  /** The vault address (any case). The sheet resolves the group itself. */
  address: PropTypes.string,
  initialView: PropTypes.oneOf(VAULT_VIEWS),
  onClose: PropTypes.func.isRequired,
  /** Fired after the sheet changes the vault list (remove / probe) so a host list can refresh. */
  onVaultsChanged: PropTypes.func,
}
