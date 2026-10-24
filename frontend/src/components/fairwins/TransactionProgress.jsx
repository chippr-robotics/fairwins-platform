import React from 'react'
import { useWalletChainId } from '../../hooks/useWalletChainId'
import { getTransactionUrl } from '../../config/blockExplorer'
import './TransactionProgress.css'

/**
 * TransactionProgress Component
 *
 * Displays a breadcrumb/stepper for multi-step blockchain transactions.
 * Shows the user which step they're on and what's coming next.
 *
 * Steps for friend market creation:
 * 1. Verifying - Role and membership checks
 * 2. Approving - Token approval (ERC20 only)
 * 3. Creating - Market creation transaction
 * 4. Complete - Transaction confirmed
 */

const STEP_CONFIGS = {
  friend_market: [
    { id: 'verify', label: 'Verify Role', description: 'Checking membership status' },
    { id: 'approve', label: 'Approve Token', description: 'Approving token spend', optional: true },
    { id: 'create', label: 'Create Wager', description: 'Confirm transaction in wallet' },
    { id: 'complete', label: 'Complete', description: 'Wager created successfully' }
  ],
  accept_market: [
    { id: 'verify', label: 'Verify', description: 'Checking invitation' },
    { id: 'approve', label: 'Approve Token', description: 'Approving token spend', optional: true },
    { id: 'accept', label: 'Accept Offer', description: 'Confirm transaction in wallet' },
    { id: 'complete', label: 'Complete', description: 'Offer accepted successfully' }
  ]
}

function TransactionProgress({
  type = 'friend_market',
  currentStep,
  error,
  txHash,
  isNativeToken = false,
  onRetry,
  onCancel,
  pendingState = null  // For resuming: { step, txHash, timestamp }
}) {
  const chainId = useWalletChainId()
  const steps = STEP_CONFIGS[type] || STEP_CONFIGS.friend_market

  // Filter out optional steps when not needed (e.g. no token approval needed for the native token).
  const activeSteps = steps.filter(step => {
    if (step.optional && step.id === 'approve' && isNativeToken) {
      return false
    }
    return true
  })

  const currentStepIndex = activeSteps.findIndex(s => s.id === currentStep)
  const currentStepConfig = activeSteps[currentStepIndex]

  // Check for pending/resumable state
  const hasPendingState = pendingState && pendingState.step && pendingState.timestamp

  return (
    <div className="tp-container">
      {/* Pending state recovery banner */}
      {hasPendingState && currentStep === 'idle' && (
        <div className="tp-pending-banner">
          <div className="tp-pending-icon">&#9888;</div>
          <div className="tp-pending-content">
            <strong>Previous transaction in progress</strong>
            <p>You have a pending transaction from {new Date(pendingState.timestamp).toLocaleString()}</p>
            {pendingState.txHash && (
              <a
                href={getTransactionUrl(chainId, pendingState.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="tp-tx-link"
              >
                View Transaction
              </a>
            )}
          </div>
          <div className="tp-pending-actions">
            <button className="tp-btn-secondary" onClick={onCancel}>
              Start Fresh
            </button>
            <button className="tp-btn-primary" onClick={onRetry}>
              Resume
            </button>
          </div>
        </div>
      )}

      {/* Step Progress Bar */}
      <div className="tp-steps">
        {activeSteps.map((step, index) => {
          const isComplete = index < currentStepIndex || currentStep === 'complete'
          const isCurrent = step.id === currentStep
          const isPending = index > currentStepIndex && currentStep !== 'complete'

          return (
            <div
              key={step.id}
              className={`tp-step ${isComplete ? 'complete' : ''} ${isCurrent ? 'current' : ''} ${isPending ? 'pending' : ''}`}
            >
              <div className="tp-step-indicator">
                {isComplete ? (
                  <span className="tp-check">&#10003;</span>
                ) : isCurrent ? (
                  <span className="tp-spinner"></span>
                ) : (
                  <span className="tp-number">{index + 1}</span>
                )}
              </div>
              <div className="tp-step-label">{step.label}</div>
              {index < activeSteps.length - 1 && (
                <div className={`tp-step-connector ${isComplete ? 'complete' : ''}`}></div>
              )}
            </div>
          )
        })}
      </div>

      {/* Current Step Description */}
      {currentStepConfig && currentStep !== 'idle' && currentStep !== 'complete' && !error && (
        <div className="tp-current-step">
          <div className="tp-step-description">{currentStepConfig.description}</div>
          {currentStep === 'create' || currentStep === 'accept' ? (
            <div className="tp-wallet-prompt">
              <span className="tp-wallet-icon">&#128274;</span>
              <span>Please confirm in your wallet</span>
            </div>
          ) : null}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="tp-error">
          <div className="tp-error-icon">&times;</div>
          <div className="tp-error-content">
            <strong>Transaction Failed</strong>
            <p>{error}</p>
          </div>
          <div className="tp-error-actions">
            <button className="tp-btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button className="tp-btn-primary" onClick={onRetry}>
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* Success State */}
      {currentStep === 'complete' && !error && (
        <div className="tp-success">
          <div className="tp-success-icon">&#10003;</div>
          <div className="tp-success-content">
            <strong>Transaction Complete!</strong>
            {txHash && (
              <a
                href={getTransactionUrl(chainId, txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="tp-tx-link"
              >
                View on Block Explorer
              </a>
            )}
          </div>
        </div>
      )}

      {/* Transaction Hash (while processing) */}
      {txHash && currentStep !== 'complete' && !error && (
        <div className="tp-tx-pending">
          <span className="tp-spinner-small"></span>
          <span>Waiting for confirmation...</span>
          <a
            href={getTransactionUrl(chainId, txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="tp-tx-link"
          >
            View Transaction
          </a>
        </div>
      )}
    </div>
  )
}

export default TransactionProgress
