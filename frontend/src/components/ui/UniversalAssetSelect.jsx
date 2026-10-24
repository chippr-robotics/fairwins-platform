import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import AssetLogo from '../wallet/AssetLogo'
import SensitiveValue from '../common/SensitiveValue'
import { matchesAssetQuery } from '../../lib/assets/assetSearch'
import { formatDecimalForDisplay } from '../../lib/format/amount'
import './UniversalAssetSelect.css'

/**
 * UniversalAssetSelect (spec 064) — one reusable asset dropdown for the home
 * Pay/Request/Wager surfaces AND the wallet Transfer ("trade") view. Each option
 * carries the Earn-page NESTED asset logo (the asset glyph + its network sub-badge,
 * via the shared AssetLogo artwork) so a member can tell at a glance WHAT the asset
 * is and WHICH chain it lives on — the core of this feature (FR-003).
 *
 * Purely presentational (FR-001): it renders whatever activity-scoped `options` the
 * caller passes (built by useSelectableAssets) and never derives eligibility, the
 * asset list, or routing. Gasless truth is passed in via `isGasless` so this
 * component never re-derives it (FR-005).
 *
 * Accessible (FR-015): listbox/option roles, keyboard operable, and the decorative
 * logo is aria-hidden — the symbol + network text always carry the meaning.
 *
 * Spec 067 (research R11) adds two things and changes nothing else — with neither
 * prop set the component behaves exactly as it did before:
 *
 *   - SEARCH (FR-064). Five networks' assets in one list multiplies the option count,
 *     so the open list narrows on the three fields a member can actually see: asset
 *     symbol, asset name, and network name. The rule itself lives in
 *     `lib/assets/assetSearch.js` so the Trade ticket's pair pickers narrow on
 *     exactly the same fields. Search only narrows what is already eligible, so
 *     typing never changes what the trigger shows as selected.
 *
 *   - An optional `pin` + `pinPredicate` pair (FR-062/FR-063). The CALLER owns the
 *     rule — `lib/assets/networkPin.js` ships both predicates (`samePair` for pairs,
 *     `bridgeDest` for the bridge destination) — and this component only applies the
 *     one it is handed, so eligibility is still never derived here. When a pin leaves
 *     no valid option the component states plainly why and what would change it
 *     (FR-065) rather than pairing a bare empty dropdown with a silently disabled
 *     control; callers pass their own wording via `pinEmptyMessage`.
 */

/** AssetLogo only badges numeric EVM chains; a Bitcoin option (string id) renders its glyph alone. */
const evmBadgeChainId = (chainId) => (typeof chainId === 'number' ? chainId : null)

/**
 * Fallback empty-counterpart copy (FR-065). Deliberately rule-neutral — the component
 * doesn't know whether the caller pinned a same-network pair or a bridge destination —
 * so it names the pinned asset from the pin's own display fields and states what would
 * change the outcome. Surfaces that can be more specific pass `pinEmptyMessage`.
 */
const defaultPinEmptyMessage = (pin) => {
  const pinned = [pin?.pinnedSymbol, pin?.pinnedNetworkName].filter(Boolean).join(' on ')
  return `No asset in this list can be used with ${pinned || 'the asset you picked'}. Choose a different asset above, or add one that qualifies, and it will appear here.`
}

export default function UniversalAssetSelect({
  options = [],
  value,
  onChange,
  isGasless = () => false,
  disabled = false,
  label = 'Asset',
  size = 28,
  pin = null,
  pinPredicate = null,
  pinEmptyMessage = null,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)
  const searchRef = useRef(null)
  const listRef = useRef(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const emptyId = `${baseId}-empty`

  // The pin decides what CAN be chosen; the query only decides what is shown right now.
  const eligible = useMemo(
    () => (typeof pinPredicate === 'function' ? options.filter((o) => pinPredicate(o, pin)) : options),
    [options, pin, pinPredicate],
  )
  const visible = useMemo(() => eligible.filter((o) => matchesAssetQuery(o, query)), [eligible, query])

  const selected = eligible.find((o) => o.key === value) || eligible[0] || null
  // Options exist but the pin excludes every one of them — the FR-065 case.
  const pinEmpty = options.length > 0 && eligible.length === 0

  // Every close goes through here so reopening always starts from the full list
  // rather than whatever the member last typed.
  const closeList = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) closeList()
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      closeList()
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closeList])

  const handleSelect = useCallback(
    (option) => {
      onChange?.(option)
      closeList()
    },
    [onChange, closeList],
  )

  const focusOptionAt = useCallback((index) => {
    const items = Array.from(listRef.current?.querySelectorAll('[role="option"]') || [])
    if (!items.length) return
    items[Math.max(0, Math.min(index, items.length - 1))].focus()
  }, [])

  // Keyboard path out of the search field and into the list (FR-064).
  const handleSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusOptionAt(0)
    } else if (e.key === 'Enter') {
      // Never let a stray Enter submit a surrounding form — commit the top match instead.
      e.preventDefault()
      if (visible.length > 0) handleSelect(visible[0])
    }
  }

  const handleListKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(listRef.current?.querySelectorAll('[role="option"]') || [])
    const at = items.indexOf(document.activeElement)
    if (e.key === 'ArrowUp' && at <= 0) {
      searchRef.current?.focus()
      return
    }
    focusOptionAt(at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1))
  }

  // Balances are formatted at render only (spec 102 FR-018). The option object itself — and the
  // `balance` callers read from it for MAX and validation — is handed back untouched.
  const renderBalance = (option) =>
    option?.balance == null ? (
      <span className="uas-pending" aria-label="balance loading">…</span>
    ) : (
      <SensitiveValue>{formatDecimalForDisplay(option.balance) ?? '—'}</SensitiveValue>
    )

  return (
    <div className="uas-select" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="uas-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        aria-describedby={pinEmpty ? emptyId : undefined}
        disabled={disabled || eligible.length === 0}
        onClick={() => (open ? closeList() : setOpen(true))}
      >
        {selected ? (
          <span className="uas-current">
            <AssetLogo
              symbol={selected.symbol}
              chainId={evmBadgeChainId(selected.chainId)}
              showBadge
              size={size}
            />
            <span className="uas-current-text">
              <span className="uas-sym">{selected.symbol}</span>
              <span className="uas-sub">
                {selected.networkName} · Balance: {renderBalance(selected)}
              </span>
            </span>
          </span>
        ) : (
          <span className="uas-sub">{pinEmpty ? 'No eligible asset' : 'No assets available'}</span>
        )}
        <span className="uas-chevron" aria-hidden="true">▾</span>
      </button>

      {/* FR-065: a disabled trigger is only honest when the reason sits next to it. */}
      {pinEmpty && (
        <p className="uas-pin-empty" id={emptyId} role="note">
          {pinEmptyMessage || defaultPinEmptyMessage(pin)}
        </p>
      )}

      {open && eligible.length > 0 && (
        <div className="uas-popover">
          <input
            ref={searchRef}
            type="search"
            className="uas-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search assets or networks"
            aria-label="Search assets"
            aria-controls={visible.length > 0 ? listId : undefined}
            autoFocus
          />
          {/* Announces the narrowing to a screen reader, which can't see the list shrink. */}
          <p className="sr-only" role="status">
            {`${visible.length} of ${eligible.length} assets shown`}
          </p>

          {visible.length > 0 ? (
            <ul
              className="uas-list"
              id={listId}
              role="listbox"
              aria-label={label}
              ref={listRef}
              onKeyDown={handleListKeyDown}
            >
              {visible.map((option) => (
                <li key={option.key} className="uas-li" role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.key === selected?.key}
                    className={`uas-option ${option.key === selected?.key ? 'active' : ''}`}
                    onClick={() => handleSelect(option)}
                  >
                    <AssetLogo
                      symbol={option.symbol}
                      chainId={evmBadgeChainId(option.chainId)}
                      showBadge
                      size={size}
                    />
                    <span className="uas-option-body">
                      <span className="uas-option-top">
                        <span className="uas-sym">{option.symbol}</span>
                        {isGasless(option) && (
                          <span className="uas-gasless" title="Gasless on this network" aria-label="gasless">⚡</span>
                        )}
                      </span>
                      <span className="uas-option-sub">
                        <span className="uas-network">{option.networkName}</span>
                        <span className="uas-bal">Balance: {renderBalance(option)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="uas-no-match" role="note">
              No assets match “{query.trim()}”. Try an asset symbol, an asset name, or a network name.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
