import { useState, useEffect, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { isAddress } from 'viem'
import { useWallet } from '../hooks/useWalletManagement'
import { useVouchers } from '../hooks/useVouchers'
import { useTierPrices } from '../hooks/useTierPrices'
import { TIER_NAMES, TIER_COLORS } from '../hooks/useRoleDetails'
import { MEMBERSHIP_VOUCHERS_TERMS_PATH } from '../constants/legalLinks'
import { getCurrentDocument } from '../utils/legalDocs'
import Button from '../components/ui/Button'
import AddressInput from '../components/ui/AddressInput'
import AddressBookButton from '../components/ui/AddressBookButton'
import QRScanner from '../components/ui/QRScanner'
import MembershipAttestation from '../components/compliance/MembershipAttestation'
import { extractAddressFromScan } from '../lib/addressBook/scanAddress'
import './vouchers.css'

const TIER_ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM']
const MAX_QUANTITY = 50

/**
 * VouchersPage (spec 026): buy membership vouchers — a quantity at once, optionally gifted directly to another
 * address — or redeem one you hold into a soulbound membership for the connected wallet. The redeem section
 * lists the wallet's held vouchers (on-chain) so the user picks one instead of typing a token id. Addresses/
 * ABIs come from synced config (Principle V); privacy is disclosed honestly.
 */
export default function VouchersPage() {
  const { account, isConnected, openConnectModal } = useWallet()
  const { getPrice, ROLE_HASHES, TIER_IDS, usingFallbackPrices, isTierActive } = useTierPrices()
  const {
    status, error, lastTxHash, voucherAvailable, batchMintAvailable,
    mintVouchers, redeemVoucher, transferVoucher, listMyVouchers,
  } = useVouchers()
  const { hash } = useLocation()

  // Deep links from the "Get Wager Access" modal (#vch-buy-h / #vch-redeem-h)
  // scroll to the relevant section.
  useEffect(() => {
    if (!hash) return
    const el = document.getElementById(hash.slice(1))
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [hash])

  const [selectedTier, setSelectedTier] = useState('BRONZE')
  const [quantity, setQuantity] = useState(1)
  const [recipient, setRecipient] = useState('')
  const [recipientResolved, setRecipientResolved] = useState('')
  const [minted, setMinted] = useState(null)

  const [myVouchers, setMyVouchers] = useState([])
  const [loadingVouchers, setLoadingVouchers] = useState(false)
  const [selectedVoucherId, setSelectedVoucherId] = useState('')
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [redeemed, setRedeemed] = useState(false)

  // Transfer-a-voucher state (sends the selected held voucher to another wallet).
  const [transferTo, setTransferTo] = useState('')
  const [transferToResolved, setTransferToResolved] = useState('')
  const [transferred, setTransferred] = useState(null)

  // Shared QR scanner for the gift + transfer address fields. `qrTarget` says
  // which field a successful scan should populate.
  const [qrScannerOpen, setQrScannerOpen] = useState(false)
  const [qrTarget, setQrTarget] = useState(null) // 'gift' | 'transfer'

  const role = ROLE_HASHES.WAGER_PARTICIPANT
  const busy = status === 'minting' || status === 'redeeming' || status === 'transferring'

  // Deep links from the "Get Wager Access" modal (#vch-buy-h / #vch-redeem-h) scroll to the section.
  useEffect(() => {
    if (!hash) return
    const el = document.getElementById(hash.slice(1))
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [hash])

  const refreshVouchers = useCallback(async () => {
    if (!voucherAvailable || !account) {
      setMyVouchers([])
      return
    }
    setLoadingVouchers(true)
    try {
      const held = await listMyVouchers()
      setMyVouchers(held)
      // Drop a selection that's no longer held (e.g. after redeeming it).
      setSelectedVoucherId((cur) => (held.some((v) => v.tokenId === cur) ? cur : ''))
    } finally {
      setLoadingVouchers(false)
    }
  }, [voucherAvailable, account, listMyVouchers])

  // Load the wallet's vouchers on mount and whenever the wallet/network changes.
  useEffect(() => {
    refreshVouchers()
  }, [refreshVouchers])

  // Arriving at #vch-transfer (the portfolio asset sheet's Send / Gift deep link) means the
  // member came to SEND: preselect the first held voucher so they land on a usable form, not a
  // disabled Transfer button. Only fills an EMPTY selection — it never overrides a choice, and a
  // plain visit (no hash) keeps selection an explicit act.
  useEffect(() => {
    if (hash !== '#vch-transfer') return
    if (myVouchers.length === 0) return
    setSelectedVoucherId((cur) => (cur ? cur : myVouchers[0].tokenId))
  }, [hash, myVouchers])

  /*
   * Minting a voucher runs the SAME tier check the purchase does — `MembershipVoucher.mint`
   * reads the tier config and reverts `TierInactive()` for `active == false`, after the buyer's
   * USDC approval. So a tier the contract has switched off is not offered here either. Only a
   * DEFINITE false is hidden; an unread tier stays listed (an RPC blip must not empty the list)
   * and the estimate warning below already covers that case.
   */
  const activeTiers = useMemo(
    () => TIER_ORDER.filter((tierKey) => isTierActive('WAGER_PARTICIPANT', tierKey) !== false),
    [isTierActive],
  )

  // The default selection is BRONZE — the very tier production had inactive. Never leave a
  // hidden tier selected: it would price and submit a mint the contract refuses.
  useEffect(() => {
    if (activeTiers.length === 0) return
    if (activeTiers.includes(selectedTier)) return
    setSelectedTier(activeTiers[0])
  }, [activeTiers, selectedTier])

  // Disconnected members stay HERE rather than being bounced to the landing
  // page: the app's unlock dialog is already opening over this route, and
  // connecting drops them straight into the vouchers they came for.
  if (!isConnected) {
    return (
      <div className="vch-page">
        <header className="vch-header">
          <h1>Membership Vouchers</h1>
          <p className="vch-sub">Connect an account to buy, gift, or redeem a membership voucher.</p>
        </header>
        <Button onClick={openConnectModal}>Connect</Button>
      </div>
    )
  }

  // Resolve the gift recipient: prefer the ENS-resolved address, else accept a
  // directly-typed hex address. Empty when neither is valid yet.
  const giftAddr = recipientResolved || (isAddress(recipient.trim()) ? recipient.trim() : '')
  const giftMode = recipient.trim().length > 0
  const recipientValid = !giftMode || isAddress(giftAddr)

  // Transfer recipient (same ENS-or-hex resolution as the gift field).
  const transferAddr = transferToResolved || (isAddress(transferTo.trim()) ? transferTo.trim() : '')
  const transferEntered = transferTo.trim().length > 0
  const transferValid = isAddress(transferAddr) && transferAddr.toLowerCase() !== (account || '').toLowerCase()

  const qtyNum = Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(quantity) || 1)))
  const unitPrice = getPrice('WAGER_PARTICIPANT', selectedTier)
  const totalPrice = unitPrice * qtyNum
  // Every tier switched off on-chain: there is nothing to sell, so the buy control must be
  // withheld too. Hiding the tier radios alone left `selectedTier` at its BRONZE default with the
  // Buy button still live — which would mint the very inactive tier this change exists to avoid.
  const nothingOnSale = activeTiers.length === 0

  // Multiple or gifting needs the batch helper; a single self-purchase does not.
  const needsHelper = qtyNum > 1 || giftMode
  const buyBlocked = needsHelper && !batchMintAvailable

  function openQrScanner(target) {
    setQrTarget(target)
    setQrScannerOpen(true)
  }

  function handleQrScanSuccess(decodedText) {
    const addr = extractAddressFromScan(decodedText)
    if (addr) {
      if (qrTarget === 'gift') {
        setRecipient(addr)
        setRecipientResolved(addr)
      } else if (qrTarget === 'transfer') {
        setTransferTo(addr)
        setTransferToResolved(addr)
      }
    }
    setQrScannerOpen(false)
    setQrTarget(null)
  }

  async function onBuy() {
    setMinted(null)
    // Defense in depth behind the disabled button: never submit a tier that is not on offer.
    if (nothingOnSale) return
    try {
      // Pass the resolved 0x address (ENS-resolved or directly typed) so the hook's
      // address check passes for gifts entered as an ENS name.
      const res = await mintVouchers(role, TIER_IDS[selectedTier], qtyNum, giftAddr || recipient)
      setMinted(res)
      // Holdings only change if you bought for yourself.
      if (!res.gift) refreshVouchers()
    } catch {
      /* error surfaced via hook state */
    }
  }

  async function onTransfer() {
    setTransferred(null)
    if (!selectedVoucherId) return
    try {
      const res = await transferVoucher(selectedVoucherId, transferAddr || transferTo)
      setTransferred(res)
      setTransferTo('')
      setTransferToResolved('')
      refreshVouchers()
    } catch {
      /* error surfaced via hook state */
    }
  }

  async function onRedeem() {
    setRedeemed(false)
    if (!selectedVoucherId) return
    try {
      // Spec 026 FR-013/SC-005: record the redeemer's Terms acceptance on-chain, the same way the
      // purchase rail does (PremiumPurchaseModal.jsx) — the in-force Terms hash, resolved from the
      // SAME source (getCurrentDocument('terms')), so redemption and purchase record the identical
      // accepted-terms artifact. The checkboxes above (MembershipAttestation) already gate this
      // button on explicit consent; this just plumbs that consent into the recorded hash instead of
      // discarding it.
      const acceptedTermsHash = getCurrentDocument('terms')?.hash || null
      await redeemVoucher(selectedVoucherId, acceptedTermsHash)
      setRedeemed(true)
      refreshVouchers()
    } catch {
      /* error surfaced via hook state */
    }
  }

  return (
    <div className="vch-page">
      <header className="vch-header">
        <h1>Membership Vouchers</h1>
        <p className="vch-sub">
          A voucher is a transferable token that can be gifted or resold. Redeeming one mints the same
          soulbound membership you would get by buying directly — it just lets someone else buy it for you, or
          you resell it if your plans change.
        </p>
      </header>

      <aside className="vch-privacy" role="note" aria-label="Privacy information">
        <strong>Privacy, honestly:</strong> voucher mints, transfers, and burns are public on-chain. Redeeming
        from a <em>fresh wallet</em> (one that received the voucher) keeps your membership from being linked to
        the wallet that bought it — this is pseudonymity, not cryptographic anonymity.
      </aside>

      {!voucherAvailable && (
        <div className="vch-unavailable" role="status">
          Membership vouchers aren’t available on this network yet. Switch to a supported network or check back
          after the next deployment.
        </div>
      )}

      {/* Live status / errors */}
      <div className="vch-status" role="status" aria-live="polite" aria-atomic="true">
        {status === 'minting' && 'Submitting your purchase…'}
        {status === 'redeeming' && 'Redeeming…'}
        {error && <span className="vch-error">{error}</span>}
        {lastTxHash && !error && <span className="vch-tx">tx: {lastTxHash.slice(0, 10)}…</span>}
      </div>

      <section className="vch-card" aria-labelledby="vch-buy-h">
        <h2 id="vch-buy-h">Buy a voucher</h2>
        {activeTiers.length === 0 && (
          <p className="vch-warn" role="status">
            No voucher tiers are on sale right now — every tier is switched off in the membership
            contract. Nothing was charged.
          </p>
        )}
        <fieldset className="vch-tiers" disabled={!voucherAvailable || busy}>
          <legend>Choose a tier</legend>
          {activeTiers.map((tierKey) => {
            const id = TIER_IDS[tierKey]
            const price = getPrice('WAGER_PARTICIPANT', tierKey)
            return (
              <label key={tierKey} className={`vch-tier ${selectedTier === tierKey ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="voucher-tier"
                  value={tierKey}
                  checked={selectedTier === tierKey}
                  onChange={() => setSelectedTier(tierKey)}
                />
                <span className="vch-tier-badge" style={{ backgroundColor: TIER_COLORS[id] }}>
                  {TIER_NAMES[id]}
                </span>
                <span className="vch-tier-price">${price} USDC</span>
              </label>
            )
          })}
        </fieldset>

        {usingFallbackPrices && (
          <p className="vch-warn" role="status">
            ⚠ Estimated pricing — live tier prices couldn’t be loaded, so these are
            fallback estimates and may differ from the on-chain price. Confirm the
            exact amount in your wallet.
          </p>
        )}

        <div className="vch-buy-row">
          <label className="vch-field">
            <span>Quantity</span>
            <input
              className="vch-input vch-qty"
              type="number"
              min="1"
              max={MAX_QUANTITY}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={!voucherAvailable || busy}
            />
          </label>
        </div>

        {/* Gift recipient on its own single line, with address-book + QR like the
            wager opponent field (voucher testing feedback). Leave blank to buy
            for yourself. */}
        <div className="vch-field">
          <label htmlFor="vch-gift-to">Gift to address <em>(optional)</em></label>
          <div className="fm-input-with-action">
            <div className="fm-address-input-wrap">
              <AddressInput
                id="vch-gift-to"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                onResolvedChange={(addr) => setRecipientResolved(addr || '')}
                placeholder="0x… or ENS — leave blank to buy for yourself"
                disabled={!voucherAvailable || busy}
                error={giftMode && !recipientValid}
              />
            </div>
            <AddressBookButton
              disabled={!voucherAvailable || busy}
              onSelect={(entry) => {
                setRecipient(entry.address)
                setRecipientResolved(entry.address)
              }}
            />
            <button
              type="button"
              className="fm-scan-btn"
              onClick={() => openQrScanner('gift')}
              disabled={!voucherAvailable || busy}
              title="Scan QR code"
              aria-label="Scan recipient QR code"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2z"/>
              </svg>
            </button>
          </div>
        </div>
        {giftMode && !recipientValid && (
          <p className="vch-warn" role="status">That doesn’t look like a valid wallet address.</p>
        )}
        {buyBlocked && (
          <p className="vch-warn" role="status">
            Buying more than one or gifting to another address isn’t available on this network yet — you can
            buy a single voucher for yourself.
          </p>
        )}

        <Button
          variant="primary"
          onClick={onBuy}
          loading={status === 'minting'}
          disabled={!voucherAvailable || busy || buyBlocked || !recipientValid || nothingOnSale}
        >
          {/* With nothing on sale the label must not quote a tier and price that are not being
              offered — `selectedTier` is still its default, and naming it would advertise a
              purchase the contract refuses. */}
          {nothingOnSale
            ? 'No tiers available'
            : giftMode
              ? `Gift ${qtyNum} ${TIER_NAMES[TIER_IDS[selectedTier]]} voucher${qtyNum > 1 ? 's' : ''} ($${totalPrice} USDC)`
              : `Buy ${qtyNum} ${TIER_NAMES[TIER_IDS[selectedTier]]} voucher${qtyNum > 1 ? 's' : ''} ($${totalPrice} USDC)`}
        </Button>
        {minted && (
          <p className="vch-success" role="status">
            {minted.gift
              ? `Sent ${minted.count} voucher${minted.count > 1 ? 's' : ''} to ${minted.recipient.slice(0, 6)}…${minted.recipient.slice(-4)}.`
              : `${minted.count} voucher${minted.count > 1 ? 's' : ''} minted to your wallet. Redeem below, or send to anyone.`}
          </p>
        )}
        <p className="vch-fineprint">
          A small resale royalty (2.5%) is suggested to marketplaces and goes to the treasury. The voucher is a
          utility access token, not an investment.
        </p>
      </section>

      <section className="vch-card" aria-labelledby="vch-redeem-h">
        <h2 id="vch-redeem-h">Redeem a voucher</h2>
        <p className="vch-help">
          Redeeming burns the voucher and grants the membership to <strong>this connected wallet</strong>
          {account ? ` (${account.slice(0, 6)}…${account.slice(-4)})` : ''}. To keep it private, redeem from a
          fresh wallet that you transferred the voucher to.
        </p>

        <div className="vch-myvouchers-head">
          <span className="vch-myvouchers-title">Your vouchers</span>
          <button
            type="button"
            className="vch-refresh"
            onClick={refreshVouchers}
            disabled={!voucherAvailable || loadingVouchers || busy}
          >
            {loadingVouchers ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {loadingVouchers && myVouchers.length === 0 && (
          <p className="vch-help" role="status">Looking up your vouchers…</p>
        )}

        {!loadingVouchers && voucherAvailable && myVouchers.length === 0 && (
          <p className="vch-empty" role="status">
            You don’t have any vouchers to redeem. Buy one above, or ask whoever gifted you a voucher to send it
            to this wallet.
          </p>
        )}

        {myVouchers.length > 0 && (
          <fieldset className="vch-voucher-list" disabled={!voucherAvailable || busy}>
            <legend>Choose a voucher to redeem</legend>
            {myVouchers.map((v) => (
              <label
                key={v.tokenId}
                className={`vch-voucher-item ${selectedVoucherId === v.tokenId ? 'is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="redeem-voucher"
                  value={v.tokenId}
                  checked={selectedVoucherId === v.tokenId}
                  onChange={() => setSelectedVoucherId(v.tokenId)}
                />
                <span className="vch-tier-badge" style={{ backgroundColor: TIER_COLORS[v.tier] }}>
                  {TIER_NAMES[v.tier]}
                </span>
                <span className="vch-voucher-meta">{v.durationDays}-day membership</span>
                <span className="vch-voucher-id">#{v.tokenId}</span>
              </label>
            ))}
          </fieldset>
        )}

        {/* Transfer the selected voucher to someone else instead of redeeming it.
            No membership is granted by transferring — the recipient redeems it
            themselves. Same address entry / address book / QR as the gift field. */}
        {myVouchers.length > 0 && (
          /* `id` is a deep-link anchor: the portfolio's FWMV asset sheet sends its Send / Gift
             action to `/vouchers#vch-transfer` (release 1.14.0 task 9), and the page's hash
             effect scrolls whatever element carries the hash's id into view. */
          <div className="vch-transfer" id="vch-transfer">
            <span className="vch-subhead">Transfer this voucher to someone else</span>
            <p className="vch-help">
              Send the selected voucher to another wallet — they can redeem it for their own membership.
              Transferring doesn’t grant a membership here.
            </p>
            <div className="fm-input-with-action">
              <div className="fm-address-input-wrap">
                <AddressInput
                  id="vch-transfer-to"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                  onResolvedChange={(addr) => setTransferToResolved(addr || '')}
                  placeholder="0x… or ENS — who should receive it"
                  disabled={!voucherAvailable || busy}
                  error={transferEntered && !transferValid}
                />
              </div>
              <AddressBookButton
                disabled={!voucherAvailable || busy}
                onSelect={(entry) => {
                  setTransferTo(entry.address)
                  setTransferToResolved(entry.address)
                }}
              />
              <button
                type="button"
                className="fm-scan-btn"
                onClick={() => openQrScanner('transfer')}
                disabled={!voucherAvailable || busy}
                title="Scan QR code"
                aria-label="Scan recipient QR code"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2z"/>
                </svg>
              </button>
            </div>
            {transferEntered && !transferValid && (
              <p className="vch-warn" role="status">
                Enter a valid wallet address that isn’t this one.
              </p>
            )}
            <Button
              variant="secondary"
              onClick={onTransfer}
              loading={status === 'transferring'}
              disabled={!voucherAvailable || !selectedVoucherId || !transferValid || busy}
            >
              {selectedVoucherId ? `Transfer voucher #${selectedVoucherId}` : 'Transfer voucher'}
            </Button>
            {transferred && (
              <p className="vch-success" role="status">
                Sent voucher #{transferred.tokenId} to {transferred.to.slice(0, 6)}…{transferred.to.slice(-4)}.
              </p>
            )}
          </div>
        )}

        <div className="vch-divider" role="separator" aria-hidden="true" />

        {/* Terms acceptance for redemption uses the SAME attestation block as the
            membership purchase flow (voucher testing feedback), so a redeemer
            confirms the identical eligibility statements. */}
        <MembershipAttestation onChange={setAcceptedTerms} />
        <p className="vch-fineprint">
          Redeeming is also governed by the{' '}
          <a href={MEMBERSHIP_VOUCHERS_TERMS_PATH} target="_blank" rel="noopener noreferrer">
            membership voucher terms
          </a>.
        </p>

        <Button
          variant="primary"
          onClick={onRedeem}
          loading={status === 'redeeming'}
          disabled={!voucherAvailable || !selectedVoucherId || !acceptedTerms || busy}
        >
          Redeem to this wallet
        </Button>
        {redeemed && (
          <p className="vch-success" role="status">
            Redeemed — your membership is now active on this wallet.
          </p>
        )}
      </section>

      <QRScanner
        isOpen={qrScannerOpen}
        onClose={() => { setQrScannerOpen(false); setQrTarget(null) }}
        onScanSuccess={handleQrScanSuccess}
      />
    </div>
  )
}
