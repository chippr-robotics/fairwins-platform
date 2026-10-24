/**
 * Spec 022 — Membership Purchase Progress Indicator.
 *
 * Presentational, stateless render of the purchase step sequence. Receives state
 * from `usePurchaseFlow` and reports user intent via callbacks. Owns no
 * orchestration. See specs/022-membership-purchase-progress/contracts/.
 */

const KIND_LABEL = {
  transaction: 'Transaction — confirm in your wallet (costs gas)',
  signature: 'Signature — sign a message (no funds move, no gas)',
}

const STATE_ICON = {
  pending: '○',
  active: '●',
  confirming: '●',
  completed: '✓',
  skipped: '—',
  failed: '✕',
}

function announce(activeStep) {
  if (!activeStep) return ''
  const stateWord =
    activeStep.state === 'confirming' ? 'confirming on-chain'
      : activeStep.state === 'active' ? 'waiting for your wallet'
        : activeStep.state === 'failed' ? 'failed'
          : activeStep.state
  return `Step: ${activeStep.label}. ${activeStep.kind}. ${stateWord}.`
}

function PurchaseProgressView({
  steps = [],
  activeIndex = null,
  status = 'idle',
  completedCount = 0,
  total = 0,
  progressFraction = 0,
  activeStep = null,
  canContinueAnyway = false,
  onRetry,
  onContinueAnyway,
}) {
  const positionLabel = total > 0 ? `Step ${Math.min(completedCount + 1, total)} of ${total}` : ''

  return (
    <div className="ppm-progress" role="group" aria-label="Purchase progress">
      {/* Live announcement for assistive tech (FR-013) */}
      <div className="ppm-sr-only" role="status" aria-live="polite">
        {announce(activeStep)}
      </div>

      <div className="ppm-progress-header">
        <span className="ppm-progress-position">{positionLabel}</span>
        <div
          className="ppm-progress-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completedCount}
          aria-label="Overall purchase progress"
        >
          <div
            className="ppm-progress-bar-fill"
            style={{ width: `${Math.round(progressFraction * 100)}%` }}
          />
        </div>
      </div>

      <ol className="ppm-progress-steps">
        {steps.map((step, index) => {
          const isActive = index === activeIndex && (step.state === 'active' || step.state === 'confirming')
          const accessibleName = `${step.label}. ${KIND_LABEL[step.kind]}. ${step.state}.`
          return (
            <li
              key={step.id}
              className={`ppm-progress-step ppm-progress-step--${step.state}`}
              aria-current={isActive ? 'step' : undefined}
              aria-label={accessibleName}
            >
              <span className="ppm-progress-step-icon" aria-hidden="true">
                {(step.state === 'active' || step.state === 'confirming')
                  ? <span className="ppm-spinner" />
                  : STATE_ICON[step.state]}
              </span>
              <span className="ppm-progress-step-body">
                <span className="ppm-progress-step-label">{step.label}</span>
                <span className={`ppm-progress-step-kind ppm-progress-step-kind--${step.kind}`}>
                  {step.kind === 'signature' ? 'Signature · no gas' : 'Transaction · in wallet'}
                </span>
                {step.detail && (
                  <span className="ppm-progress-step-detail">{step.detail}</span>
                )}
                {step.state === 'confirming' && (
                  <span className="ppm-progress-step-status" role="status">Waiting for confirmation…</span>
                )}
                {step.state === 'failed' && step.failureReason && (
                  <span className="ppm-progress-step-error">{step.failureReason}</span>
                )}
                {/* A skipped step is not a failure — say why it was skipped rather than
                    leaving a dash the member has to interpret (spec 098 FR-012). */}
                {step.state === 'skipped' && step.failureReason && (
                  <span className="ppm-progress-step-detail">{step.failureReason}</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>

      {status === 'failed' && (
        <div className="ppm-progress-actions">
          <button type="button" className="ppm-btn-primary" onClick={onRetry}>
            Retry
          </button>
          {canContinueAnyway && (
            <button type="button" className="ppm-btn-secondary" onClick={onContinueAnyway}>
              Continue anyway
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default PurchaseProgressView
