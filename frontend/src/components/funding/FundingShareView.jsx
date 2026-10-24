import { useState } from 'react'
import PropTypes from 'prop-types'
import WagerQRCode from '../ui/WagerQRCode'
import InfoTip from '../ui/InfoTip'
import { buildFundingPoolUrl } from '../../lib/funding/deepLink'

const CopyIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
)
const CheckIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

async function copyText(text, setFlag) {
  try {
    await navigator.clipboard?.writeText(text)
    setFlag(true)
    setTimeout(() => setFlag(false), 1500)
  } catch {
    /* no-op */
  }
}

/**
 * FundingShareView (spec 103, FR-020) — the one link, the four words, and a QR of the link. Used by
 * the create success view and the pool page's share row. `compact` hides the QR behind a toggle.
 */
export default function FundingShareView({ phrase, address, compact = false, title }) {
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedWords, setCopiedWords] = useState(false)
  const [showQr, setShowQr] = useState(!compact)
  const url = buildFundingPoolUrl({ phrase, address })
  return (
    <section className="fp-share" aria-label="Share this pool" data-testid="funding-share">
      {title && <h2 className="fp-h2">{title}</h2>}
      <div className="fp-share-link">
        <code className="fp-share-url" data-testid="funding-link">{url}</code>
        <button
          type="button"
          className="fp-icon-btn"
          data-testid="copy-link"
          onClick={() => copyText(url, setCopiedLink)}
          aria-label={copiedLink ? 'Link copied' : 'Copy link'}
          title={copiedLink ? 'Copied' : 'Copy link'}
        >
          {copiedLink ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      {phrase && (
        <div className="fp-share-words">
          <span className="fp-share-words-label">
            Or say the four words
            <InfoTip label="About the four words">
              Anyone who has the words or the link can open the pool and contribute, so share them with the people you mean.
              The words render in your pool-phrase language; the pool resolves the same in every language.
            </InfoTip>
          </span>
          <div className="fp-share-words-row">
            <code className="fp-share-phrase" data-testid="funding-phrase">{phrase}</code>
            <button
              type="button"
              className="fp-icon-btn"
              data-testid="copy-phrase"
              onClick={() => copyText(phrase, setCopiedWords)}
              aria-label={copiedWords ? 'Words copied' : 'Copy words'}
              title={copiedWords ? 'Copied' : 'Copy words'}
            >
              {copiedWords ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
        </div>
      )}
      {compact && (
        <button type="button" className="fp-link" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr} data-testid="toggle-qr">
          {showQr ? 'Hide QR code' : 'Show QR code'}
        </button>
      )}
      {showQr && (
        <div className="fp-share-qr">
          <WagerQRCode value={url} size={168} ariaLabel="QR code that opens this pool" />
          <span className="fp-muted fp-small">Scan to open the pool</span>
        </div>
      )}
    </section>
  )
}

FundingShareView.propTypes = {
  phrase: PropTypes.string,
  address: PropTypes.string,
  compact: PropTypes.bool,
  title: PropTypes.string,
}
