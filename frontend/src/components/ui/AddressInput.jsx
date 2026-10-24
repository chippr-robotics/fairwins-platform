import { forwardRef, useEffect, useCallback } from 'react'
import { useEnsResolution, useEnsReverseLookup } from '../../hooks/useEnsResolution'
import { useCallsignResolution } from '../../hooks/useCallsignResolution'
import { formatCallsign, isValidCallsign, normalizeCallsign } from '../../lib/callsigns/normalizeCallsign'
import { CallsignStatus } from '../../lib/callsigns/resolveCallsign'
import ReportCallsignButton from '../callsigns/ReportCallsignButton'
import AddressInputBookAddon from './AddressInputBookAddon'
import { classifyAddress } from '../../lib/bitcoin/addresses'
import styles from './AddressInput.module.css'

// Member-facing labels for recognized Bitcoin destination types (spec 061).
const BTC_TYPE_LABEL = {
  p2pkh: 'Legacy',
  p2sh: 'Script (P2SH)',
  p2wpkh: 'SegWit',
  p2wsh: 'SegWit script',
  p2tr: 'Taproot',
}

/**
 * AddressInput Component
 *
 * An enhanced input field that supports both Ethereum addresses and ENS names.
 * Features:
 * - Real-time ENS name resolution (name -> address)
 * - Reverse ENS lookup for addresses (address -> name display)
 * - Loading indicator during resolution
 * - Error display for invalid/unresolvable inputs
 * - Accessible with proper ARIA attributes
 *
 * @param {Object} props - Component props
 * @param {string} props.value - Input value (address or ENS name)
 * @param {Function} props.onChange - Change handler for raw input value
 * @param {Function} props.onResolvedChange - Callback with resolved address (optional)
 * @param {string} props.placeholder - Placeholder text
 * @param {boolean} props.disabled - Disabled state
 * @param {boolean} props.required - Required field
 * @param {string} props.id - Input ID (required for label association)
 * @param {string} props.className - Additional CSS classes
 * @param {boolean} props.error - External error state
 * @param {string} props.errorMessage - External error message to display
 * @param {string} props.ariaDescribedBy - ID of description element
 * @param {boolean} props.showResolvedAddress - Show resolved address preview
 * @param {string} props.bitcoinNetworkId - Bitcoin mode (spec 061): validate as a
 *   Bitcoin destination for this network id ('bitcoin' | 'bitcoin-testnet')
 *   instead of the EVM/ENS/callsign stack. Accepts every standard type
 *   (legacy, P2SH, bech32, bech32m/taproot) with per-reason rejection
 *   messages; the recognized type is surfaced as a tag.
 */
const AddressInput = forwardRef(({
  value = '',
  onChange,
  onResolvedChange,
  placeholder = '0x... or ENS name (e.g., vitalik.eth)',
  disabled = false,
  required = false,
  id,
  className = '',
  error: externalError = false,
  errorMessage: externalErrorMessage,
  ariaDescribedBy,
  showResolvedAddress = true,
  label,
  enableAddressBook = false,
  chainId,
  bitcoinNetworkId = null,
  ...props
}, ref) => {
  // Bitcoin mode (spec 061): pure synchronous validation via classifyAddress.
  // The EVM resolver hooks below still mount (rules of hooks) but are fed
  // empty input so they stay inert.
  const isBitcoinMode = Boolean(bitcoinNetworkId)
  const btcTrimmed = isBitcoinMode ? (value || '').trim() : ''
  const btc = isBitcoinMode && btcTrimmed ? classifyAddress(btcTrimmed, bitcoinNetworkId) : null

  // Use ENS resolution hook
  const {
    resolvedAddress,
    isLoading,
    error: resolutionError,
    isEns,
    isAddress
  } = useEnsResolution(isBitcoinMode ? '' : value)

  // Use reverse lookup to show ENS name for addresses
  const {
    ensName,
    isLoading: isLookingUp
  } = useEnsReverseLookup(!isBitcoinMode && isAddress ? value?.trim() : null)

  // Callsign forward-resolution (spec 054). Additive: only engages for callsign-shaped input that is
  // neither an address nor an ENS name. A resolved ACTIVE callsign becomes the effective resolved address;
  // any other status is surfaced as a non-committable message (FR-011/022). Registry unreachable → soft
  // no-op, raw-address entry unaffected (FR-013).
  const callsignRes = useCallsignResolution(isBitcoinMode ? '' : value, { chainId })
  const effectiveResolvedAddress = isBitcoinMode
    ? (btc?.valid ? btcTrimmed : null)
    : ((callsignRes.isCallsign && callsignRes.address) ? callsignRes.address : resolvedAddress)

  // Notify parent of resolved address changes (callsign-resolved address included)
  useEffect(() => {
    if (onResolvedChange) {
      onResolvedChange(effectiveResolvedAddress)
    }
  }, [effectiveResolvedAddress, onResolvedChange])

  const handleChange = useCallback((e) => {
    if (onChange) {
      onChange(e)
    }
  }, [onChange])

  // Select a saved contact: populate the field and notify of the resolved address.
  const handleBookPick = useCallback((addr) => {
    if (onChange) onChange({ target: { value: addr } })
    if (onResolvedChange) onResolvedChange(addr)
  }, [onChange, onResolvedChange])

  // Determine error state. A callsign-shaped input suppresses the ENS "invalid address/name" error and
  // instead surfaces the callsign's own status ("No such callsign", "address changing", etc.) when non-ACTIVE.
  const callsignError = !isBitcoinMode && callsignRes.isCallsign && !callsignRes.isLoading && !!callsignRes.message && callsignRes.status !== CallsignStatus.ACTIVE
  const bitcoinError = isBitcoinMode && Boolean(btc) && !btc.valid
  const hasError = externalError || bitcoinError || callsignError || (!isBitcoinMode && value && !isLoading && !callsignRes.isCallsign && resolutionError)
  const displayError = externalErrorMessage || (bitcoinError ? btc.message : (callsignError ? callsignRes.message : (!callsignRes.isCallsign ? resolutionError : undefined)))

  /*
   * Status indicator (#1431).
   *
   * `showLoading` is RESOLUTION busy — the work that decides whether there is an address at all.
   * The reverse ENS lookup is deliberately NOT part of it. That lookup only decides whether to
   * DECORATE the field with a name, and it is a live call to a third-party mainnet RPC
   * (`useEnsReverseLookup` → `useEnsName({ chainId: mainnet.id })`, routed by wagmi.js at
   * ethereum-rpc.publicnode.com) fired for ANY pasted address.
   *
   * Gating the tick on it meant the field withheld confirmation of something it already knew:
   * for a raw address `useEnsResolution` returns the resolved value synchronously, with no
   * network involved. A member pasting a valid address watched a spinner for as long as a
   * mainnet RPC took to answer — indefinitely on a slow or blocked network — and the on-chain
   * e2e tier inherited that as a flake, because whether the tick appeared inside 15s was a
   * property of the runner's internet rather than of the code under test.
   */
  const showLoading = isLoading || callsignRes.isLoading
  const showSuccess = effectiveResolvedAddress && !hasError && !showLoading
  // The ENS name is decoration: it appears when (and if) the lookup lands, and its absence never
  // holds anything else back.
  const showEnsLabel = isEns && !isLoading
  const showCallsignResolved = callsignRes.isCallsign && !!callsignRes.address && !showLoading && !hasError

  // Canonical form of a resolved callsign (no `%`), for display + the abuse-report affordance.
  let canonicalCallsign = ''
  if (showCallsignResolved) {
    try {
      canonicalCallsign = normalizeCallsign(value)
    } catch {
      canonicalCallsign = ''
    }
  }

  // Format address for display
  const formatAddress = (addr) => {
    if (!addr || addr.length < 10) return addr
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  // Combine classes
  const inputClasses = [
    styles.input,
    hasError ? styles.inputError : '',
    showSuccess ? styles.inputSuccess : '',
    showLoading ? styles.inputLoading : '',
    className
  ].filter(Boolean).join(' ')

  // Generate unique IDs for ARIA
  const errorId = id ? `${id}-error` : undefined
  const resolvedHintId = id ? `${id}-resolved-hint` : undefined
  const ensNameHintId = id ? `${id}-ens-hint` : undefined
  const describedBy = [
    ariaDescribedBy,
    hasError && errorId,
    (showResolvedAddress && isEns && resolvedAddress && !isLoading && !hasError) && resolvedHintId,
    (showResolvedAddress && isAddress && ensName && !isLookingUp) && ensNameHintId
  ]
    .filter(Boolean)
    .join(' ') || undefined

  return (
    <div className={styles.container}>
      {label && (
        <label htmlFor={id} className={styles.label}>
          {label}
          {required && <span className={styles.required}> *</span>}
        </label>
      )}

      <div className={styles.inputWrapper}>
        <input
          ref={ref}
          type="text"
          id={id}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          className={inputClasses}
          aria-required={required}
          aria-invalid={hasError}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck="false"
          {...props}
        />

        {/* Status indicators */}
        <div className={styles.statusContainer}>
          {showLoading && (
            <span className={styles.spinner} role="status" aria-label="Resolving..." />
          )}
          {showSuccess && !showLoading && (
            <span className={styles.successIcon} role="img" aria-label="Valid address">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          )}
          {showEnsLabel && !showLoading && (
            <span className={styles.ensLabel} role="img" aria-label="ENS name detected">ENS</span>
          )}
          {isBitcoinMode && btc?.valid && (
            <span className={styles.ensLabel} role="img" aria-label={`Bitcoin ${BTC_TYPE_LABEL[btc.type]} address`}>
              {BTC_TYPE_LABEL[btc.type]}
            </span>
          )}
        </div>
      </div>

      {/* Resolved address preview */}
      {showResolvedAddress && isEns && resolvedAddress && !isLoading && !hasError && (
        <div id={resolvedHintId} className={styles.resolvedHint}>
          <span className={styles.resolvedLabel}>Resolves to:</span>
          <code className={styles.resolvedAddress}>{formatAddress(resolvedAddress)}</code>
        </div>
      )}

      {/* Show ENS name for direct address input */}
      {showResolvedAddress && isAddress && ensName && !isLookingUp && (
        <div id={ensNameHintId} className={styles.resolvedHint}>
          <span className={styles.ensNameLabel}>{ensName}</span>
        </div>
      )}

      {/* Callsign resolved preview (spec 054): show the callsign + full resolved address for confirmation
          before any value-bearing action (FR-011), with the verification marker for verified callsigns. */}
      {showResolvedAddress && showCallsignResolved && (
        <div className={styles.resolvedHint}>
          <span className={styles.resolvedLabel}>
            {isValidCallsign(value) ? formatCallsign(value.trim().replace(/^%/, '').toLowerCase()) : 'Callsign'} resolves to:
          </span>
          <code className={styles.resolvedAddress}>{formatAddress(callsignRes.address)}</code>
          {callsignRes.verified && (
            <span className={styles.ensLabel} role="img" aria-label="Verified business callsign" title="Verified">✓</span>
          )}
          {canonicalCallsign && (
            <ReportCallsignButton
              callsign={canonicalCallsign}
              address={callsignRes.address}
              chainId={chainId}
              className={styles.reportLink}
            />
          )}
        </div>
      )}

      {/* Error message */}
      {hasError && displayError && (
        <div id={errorId} className={styles.errorMessage} role="alert">
          {displayError}
        </div>
      )}

      {/* Address-book search/select + inline restriction warning (opt-in) */}
      {enableAddressBook && (
        <AddressInputBookAddon
          query={value}
          chainId={chainId}
          resolvedAddress={resolvedAddress || (isAddress ? value?.trim() : null)}
          onPick={handleBookPick}
        />
      )}
    </div>
  )
})

AddressInput.displayName = 'AddressInput'

export default AddressInput
