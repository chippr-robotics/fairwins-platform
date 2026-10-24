import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from './Header'
import Footer from './Footer'
import { tenantBrand, tenantLinks, isFeatureEnabled } from '../config/tenant'
import { useIsMobile } from '../hooks/useMediaQuery'
import { resolveLandingPath } from '../utils/landingViewPreference'
import './LandingPage.css'

// Hero social icons by manifest social key (spec 072 — links come from the
// tenant manifest; keys without an icon here are simply not rendered).
const SOCIAL_ICONS = {
  x: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  ),
  discord: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
    </svg>
  ),
  github: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
    </svg>
  ),
  instagram: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
    </svg>
  ),
}

function LandingPage() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [visibleSections, setVisibleSections] = useState(new Set())
  const brand = tenantBrand()
  const { support, social } = tenantLinks()

  const handleGetStarted = () => {
    navigate(resolveLandingPath(isMobile))
  }

  // Intersection observer for scroll-triggered animations
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisibleSections(prev => new Set([...prev, entry.target.id]))
          }
        })
      },
      { threshold: 0.15 }
    )

    const sections = document.querySelectorAll('[data-animate]')
    sections.forEach(section => observer.observe(section))

    return () => observer.disconnect()
  }, [])

  const isVisible = (id) => visibleSections.has(id)

  return (
    <div className="landing-page">
      <Header hideWalletButton={true} />

      {/* Hero Section - Full impact */}
      <section className="hero-section" id="hero">
        <div className="hero-bg-effects">
          <div className="hero-orb hero-orb-1" />
          <div className="hero-orb hero-orb-2" />
          <div className="hero-orb hero-orb-3" />
          <div className="hero-grid-pattern" />
        </div>

        <div className="hero-content">
          <div className="hero-badge">
            <span className="hero-badge-dot" />
            Self-Custody · Multi-Chain · White-Label
          </div>

          <h1 className="hero-headline">
            Digital Asset<br />
            <span className="hero-headline-accent">Infrastructure.</span><br />
            Your Brand.
          </h1>

          <p className="hero-subtitle">
            {brand.displayName} is the platform layer for digital asset products:
            embedded wallets, policy-governed custody, payments and settlement,
            markets connectivity, and built-in compliance — across major networks,
            with keys your users hold.
          </p>

          <div className="hero-actions">
            <button onClick={handleGetStarted} className="hero-cta-primary">
              <span>Launch App</span>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
            <button onClick={() => {
              const el = document.getElementById('features')
              if (el) el.scrollIntoView({ behavior: 'smooth' })
            }} className="hero-cta-secondary">
              Explore the Platform
            </button>
          </div>

          <div className="hero-social">
            {Object.entries(social)
              .filter(([key, url]) => url && SOCIAL_ICONS[key])
              .map(([key, url]) => (
                <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="hero-social-link" aria-label={key === 'x' ? 'Twitter/X' : key.charAt(0).toUpperCase() + key.slice(1)}>
                  {SOCIAL_ICONS[key]}
                </a>
              ))}
          </div>
        </div>

        {/* Floating preview card */}
        <div className="hero-preview">
          <div className="preview-card">
            <div className="preview-card-header">
              <div className="preview-status-live" />
              <span className="preview-label">Vault Transfer</span>
            </div>
            <div className="preview-question">Transfer 25,000 USDC · Operations vault</div>
            <div className="preview-stakes">
              <div className="preview-stake">
                <span className="preview-stake-label">Approvals</span>
                <span className="preview-stake-value">2 of 3</span>
              </div>
              <div className="preview-vs">→</div>
              <div className="preview-stake">
                <span className="preview-stake-label">Policy check</span>
                <span className="preview-stake-value">Passed</span>
              </div>
            </div>
            <div className="preview-resolution">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Signed by vault owners · settled on-chain
            </div>
          </div>
        </div>
      </section>

      {/* The Platform - Capability Pillars */}
      <section className={`value-section ${isVisible('value-props') ? 'visible' : ''}`} id="features">
        <div className="container" id="value-props" data-animate>
          <div className="section-header">
            <span className="section-tag">The Platform</span>
            <h2 className="section-title">Everything a digital asset product needs,<br />in one stack</h2>
            <p className="section-subtitle">
              {brand.displayName} combines the components you would otherwise assemble
              from multiple vendors — wallets, custody, payments, markets, and
              compliance — in one self-custody platform spanning Ethereum and its L2s,
              Polygon, Ethereum Classic, and Bitcoin.
            </p>
          </div>

          <div className="value-grid">
            <div className="value-card value-card-featured">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h3>Unified custody &amp; portfolio</h3>
              <p>
                Every on-chain asset — tokens, stablecoins, positions, and collectibles —
                organized and priced in one portfolio view, with a complete activity
                ledger. Users sign every action with their own keys; the platform never
                takes custody of funds.
              </p>
            </div>

            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </div>
              <h3>Payments &amp; settlement</h3>
              <p>Stablecoin transfers and requests with QR codes, address book, and gasless rails — recipients settle in USDC without holding a gas token, and every transfer is screened before it moves.</p>
            </div>

            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              </div>
              <h3>Embedded wallets</h3>
              <p>Passkey smart accounts open with a fingerprint or face — no seed phrases, no extensions, optional sponsored gas — alongside support for external wallets and hardware signers via WalletConnect.</p>
            </div>

            {(isFeatureEnabled('predict') || isFeatureEnabled('wagers')) && (
            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                  <polyline points="17 6 23 6 23 12" />
                </svg>
              </div>
              <h3>Markets connectivity</h3>
              <p>Direct order flow into Polymarket prediction markets and escrowed peer-to-peer settlement with oracle resolution (Polymarket, Chainlink, UMA) — user wallets sign every order, and every fee is disclosed before commitment.</p>
            </div>
            )}

            {isFeatureEnabled('collect') && (
            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </div>
              <h3>Digital collectibles</h3>
              <p>NFT holdings with live floor prices and best offers, listed and sold through OpenSea from inside the platform — valuation and liquidity in the same view as the rest of the portfolio.</p>
            </div>
            )}

            {isFeatureEnabled('earn') && (
            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M7 20h10" />
                  <path d="M12 20v-8" />
                  <path d="M12 12c-3 0-5-2-5-5 3 0 5 2 5 5z" />
                  <path d="M12 12c3 0 5-2 5-5-3 0-5 2-5 5z" />
                </svg>
              </div>
              <h3>Yield</h3>
              <p>Idle assets deployed into audited third-party lending vaults, liquid staking, and supplied liquidity — positions stay withdrawable, rates and fees are disclosed before signature.</p>
            </div>
            )}

            {isFeatureEnabled('swap') && (
            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
              </div>
              <h3>Trading &amp; liquidity</h3>
              <p>Token execution through the right venue per network — Uniswap on Ethereum, L2s, and Polygon; ETCswap on Ethereum Classic — with honest venue labeling on every quote.</p>
            </div>
            )}

            {isFeatureEnabled('bridge') && (
            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 18V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10" />
                  <path d="M2 18h20" />
                  <path d="M8 18v-4M12 18v-6M16 18v-4" />
                </svg>
              </div>
              <h3>Cross-chain</h3>
              <p>Asset bridging via Across with a no-custody router: deposits that cannot be filled refund straight to the sender, and platform contracts never hold funds in flight.</p>
            </div>
            )}

            {isFeatureEnabled('bitcoin') && (
            <div className="value-card">
              <div className="value-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9 8h4a2 2 0 0 1 0 4H9zM9 12h4.5a2 2 0 0 1 0 4H9zM10 6v2M10 16v2" />
                </svg>
              </div>
              <h3>Bitcoin</h3>
              <p>A native Bitcoin wallet beside the EVM accounts — rotating receive addresses, honest fee quotes before signing, and keys derived and held on the user&apos;s device.</p>
            </div>
            )}
          </div>
        </div>
      </section>

      {/* White-label offering - Visual Timeline */}
      <section className={`steps-section ${isVisible('steps-area') ? 'visible' : ''}`} id="how-it-works">
        <div className="container" id="steps-area" data-animate>
          <div className="section-header">
            <span className="section-tag">White-Label</span>
            <h2 className="section-title">Your platform, from configuration</h2>
          </div>

          <div className="steps-timeline">
            <div className="timeline-line" />

            <div className="step-item">
              <div className="step-marker">
                <span>1</span>
              </div>
              <div className="step-content">
                <h3>Provision</h3>
                <p>
                  Stand up a branded instance from a validated configuration manifest:
                  your identity, theme, domain, feature set, and networks — with a
                  dedicated, isolated contract deployment where assets and
                  administration must be yours alone.
                </p>
              </div>
            </div>

            <div className="step-item">
              <div className="step-marker">
                <span>2</span>
              </div>
              <div className="step-content">
                <h3>Onboard</h3>
                <p>
                  Users create passkey wallets in seconds or connect wallets they
                  already hold. Sanctions screening and jurisdiction gating are built
                  into every value flow — not bolted on.
                </p>
              </div>
            </div>

            <div className="step-item">
              <div className="step-marker">
                <span>3</span>
              </div>
              <div className="step-content">
                <h3>Operate</h3>
                <p>
                  Payments, trading, custody, and yield run self-custody on
                  open-source contracts, while your operations console reads the whole estate —
                  every network, every balance, every control — with honest state.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Custody Options - Distinct Visual */}
      <section className={`resolution-section ${isVisible('resolution-area') ? 'visible' : ''}`} id="custody">
        <div className="container" id="resolution-area" data-animate>
          <div className="section-header">
            <span className="section-tag">Custody, Your Way</span>
            <h2 className="section-title">Keys stay with your users. Always.</h2>
            <p className="section-subtitle">
              {brand.displayName} never custodies funds. Accounts range from a simple
              passkey to policy-governed multisig vaults — all self-custody, all
              recoverable.
            </p>
          </div>

          <div className="resolution-grid">
            <div className="resolution-card resolution-either">
              <div className="resolution-accent" />
              <div className="resolution-icon-badge">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              </div>
              <h3>Passkey Accounts</h3>
              <p>A fingerprint or face creates an on-chain smart account — no seed phrase, no extensions. Everyday actions can run gas-sponsored, with fees always disclosed when they&apos;re not.</p>
              <span className="resolution-use-case">Best for: Mainstream onboarding</span>
            </div>

            <div className="resolution-card resolution-initiator">
              <div className="resolution-accent" />
              <div className="resolution-icon-badge">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <path d="M16 12h.01" />
                </svg>
              </div>
              <h3>External Wallets</h3>
              <p>Browser extensions, mobile wallets, and hardware signers connect over WalletConnect. {brand.displayName} is an interface to keys your users already control.</p>
              <span className="resolution-use-case">Best for: Existing crypto users</span>
            </div>

            <div className="resolution-card resolution-receiver">
              <div className="resolution-accent" />
              <div className="resolution-icon-badge">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h3>Policy-Governed Vaults</h3>
              <p>Safe multisig vaults with an on-chain policy engine: spending rules, approver requirements, and thresholds enforced by contract — moving funds takes the approvals your policy demands.</p>
              <span className="resolution-use-case">Best for: Treasuries &amp; funds</span>
            </div>

            <div className="resolution-card resolution-thirdparty">
              <div className="resolution-accent" />
              <div className="resolution-icon-badge">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h3>Encrypted Backup &amp; Recovery</h3>
              <p>Address books, vault references, and settings sync end-to-end encrypted; accounts recover on any device. Legacy keys can be imported, stored encrypted, and swept — nothing readable ever leaves the client.</p>
              <span className="resolution-use-case">Best for: Operational resilience</span>
            </div>
          </div>
        </div>
      </section>

      {/* Use Cases - Scenario Stories */}
      <section className={`scenarios-section ${isVisible('scenarios-area') ? 'visible' : ''}`} id="use-cases">
        <div className="container" id="scenarios-area" data-animate>
          <div className="section-header">
            <span className="section-tag">Who It&apos;s For</span>
            <h2 className="section-title">Built for digital asset businesses</h2>
          </div>

          <div className="scenario-grid">
            <div className="scenario-card">
              <div className="scenario-emoji">&#127970;</div>
              <h3>Fintechs &amp; Neo-brokers</h3>
              <p className="scenario-setup">"We want a digital asset offering without building custody from scratch."</p>
              <p className="scenario-resolution">
                Launch a branded instance from configuration — your domain, your theme, your feature set — on a dedicated, isolated contract deployment.
              </p>
            </div>
            <div className="scenario-card">
              <div className="scenario-emoji">&#127974;</div>
              <h3>Corporate Treasury</h3>
              <p className="scenario-setup">"No single employee should be able to move funds."</p>
              <p className="scenario-resolution">
                Policy-governed multisig vaults enforce approver sets and spending rules on-chain, with a proposal flow and full audit trail.
              </p>
            </div>
            <div className="scenario-card">
              <div className="scenario-emoji">&#128184;</div>
              <h3>Payments Operations</h3>
              <p className="scenario-setup">"Settle in stablecoins without teaching anyone about gas."</p>
              <p className="scenario-resolution">
                Gasless USDC transfer rails with QR-based request flows, address books, and sanctions screening on every movement.
              </p>
            </div>
            <div className="scenario-card">
              <div className="scenario-emoji">&#128202;</div>
              <h3>Trading Desks</h3>
              <p className="scenario-setup">"One venue view across chains, with fees we can defend."</p>
              <p className="scenario-resolution">
                Market connectivity into Polymarket, per-network DEX execution, and oracle-resolved settlement — every fee disclosed before signature.
              </p>
            </div>
            <div className="scenario-card">
              <div className="scenario-emoji">&#128737;&#65039;</div>
              <h3>Compliance Teams</h3>
              <p className="scenario-setup">"Screening has to be structural, not a checkbox."</p>
              <p className="scenario-resolution">
                Chainalysis sanctions screening is enforced at the contract layer, jurisdiction gating at the edge, and activity is auditable end to end.
              </p>
            </div>
            <div className="scenario-card">
              <div className="scenario-emoji">&#128273;</div>
              <h3>Product Teams</h3>
              <p className="scenario-setup">"Onboarding dies at the seed phrase."</p>
              <p className="scenario-resolution">
                Embedded passkey wallets open with a fingerprint, run gas-sponsored, and recover across devices — self-custody without the sharp edges.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="final-cta">
        <div className="final-cta-bg">
          <div className="cta-orb cta-orb-1" />
          <div className="cta-orb cta-orb-2" />
        </div>
        <div className="final-cta-content">
          <h2>Ready to see the platform<br />in action?</h2>
          <p>Step into the live app, or talk to us about a branded instance of your own.</p>
          <button onClick={handleGetStarted} className="hero-cta-primary cta-large">
            <span>Get Started</span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
          {support.email && (
            <p className="cta-contact">
              Platform &amp; white-label inquiries: <a href={`mailto:${support.email}`}>{support.email}</a>
            </p>
          )}
        </div>
      </section>

      {/* Footer */}
      <Footer />
    </div>
  )
}

export default LandingPage
