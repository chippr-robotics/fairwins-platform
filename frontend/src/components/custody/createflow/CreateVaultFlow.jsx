// Spec 105 US1 — the four-sheet guided creation flow: type → rules → networks + status → done
// (FR-001). Replaces the single-form CreateVaultWizard. The flow's own refusals are stated in
// plain language: the arrangement must validate, and a single-owner single-signature vault with
// no rules is the one configuration this flow will not produce (FR-003 — the same refusal the
// wizard carried, because a "protected" account any one key fully moves reads as protection and
// is not).

import { useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import { validateVaultConfig } from '../../../lib/custody/safeVault'
import { DEFAULT_SEMANTIC_RULES, isEmptySemanticRules } from '../../../lib/custody/vaultRulesConfig'
import useVaultDeployment from '../../../hooks/useVaultDeployment'
import { PRESETS, resolveArrangement, creationChainIds } from './createFlowModel'
import TypeSheet from './TypeSheet'
import RulesSheet from './RulesSheet'
import NetworksSheet from './NetworksSheet'
import DoneSheet from './DoneSheet'
import './CreateVaultFlow.css'

export default function CreateVaultFlow({ connectedAddress, chainId, onDone, onCreated }) {
  const deployment = useVaultDeployment()
  const [step, setStep] = useState('type')
  const [presetType, setPresetType] = useState('joint')
  const [owners, setOwners] = useState([connectedAddress || '', ''])
  const [chosenThreshold, setChosenThreshold] = useState(null)
  const [rules, setRules] = useState(DEFAULT_SEMANTIC_RULES)
  const [label, setLabel] = useState('')
  const [error, setError] = useState(null)
  const [started, setStarted] = useState(false)
  // One salt per flow instance: preview and every network's deploy resolve the same address.
  const [saltNonce] = useState(() => Date.now())

  const available = useMemo(() => creationChainIds(), [])
  const [selected, setSelected] = useState(() => {
    const first = available.includes(Number(chainId)) ? [Number(chainId)] : available.slice(0, 1)
    return first
  })

  const arrangement = useMemo(
    () => resolveArrangement({ presetType, owners, chosenThreshold }),
    [presetType, owners, chosenThreshold],
  )

  const validationError = useMemo(() => {
    try {
      validateVaultConfig(arrangement.owners, arrangement.threshold)
    } catch (e) {
      return e.message
    }
    if (presetType === 'joint' && arrangement.owners.length !== 2) {
      return 'A joint account is exactly two owners — add the second owner.'
    }
    // FR-003 — the refusal, in plain language.
    if (arrangement.owners.length === 1 && arrangement.threshold === 1 && isEmptySemanticRules(rules)) {
      return 'One owner, one signature and no rules is just a wallet wearing a vault badge. Add a second owner or keep at least one rule.'
    }
    return null
  }, [arrangement, presetType, rules])

  const goRules = () => {
    // The solo-no-rules case is decided on the RULES step (the member may add rules); only
    // structural owner problems block leaving the type step.
    try {
      validateVaultConfig(arrangement.owners, arrangement.threshold)
      if (presetType === 'joint' && arrangement.owners.length !== 2) {
        throw new Error('A joint account is exactly two owners — add the second owner.')
      }
      setError(null)
      setStep('rules')
    } catch (e) {
      setError(e.message)
    }
  }

  const goNetworks = () => {
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    setStep('networks')
  }

  const toggleNetwork = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const deploy = async () => {
    setError(null)
    setStarted(true)
    try {
      const res = await deployment.start({
        owners: arrangement.owners,
        threshold: arrangement.threshold,
        saltNonce,
        presetType,
        semanticRules: isEmptySemanticRules(rules) ? null : rules,
        chainIds: selected,
        label,
      })
      onCreated?.(res?.address)
    } catch (e) {
      // Plan/prediction failures land here (per-network failures live in the rows).
      setError(e?.message || 'Deployment could not start')
      setStarted(false)
    }
  }

  const retry = (id) =>
    deployment.retryChain({
      chainId: id,
      owners: arrangement.owners,
      threshold: arrangement.threshold,
      saltNonce,
      semanticRules: isEmptySemanticRules(rules) ? null : rules,
      label,
    })

  const presetLabel = PRESETS.find((p) => p.id === presetType)?.title || presetType
  const thresholdLabel = `${arrangement.threshold} of ${arrangement.owners.length || '?'}`

  return (
    <div className="create-flow" aria-label="Create a vault">
      {error && step !== 'type' && (
        <p className="create-flow__error" role="alert">
          {error}
        </p>
      )}
      {step === 'type' && (
        <TypeSheet
          presetType={presetType}
          onPreset={(p) => {
            setPresetType(p)
            setError(null)
            if (p === 'joint') setOwners((prev) => [prev[0] || connectedAddress || '', prev[1] || ''])
          }}
          owners={owners}
          onOwners={setOwners}
          chosenThreshold={chosenThreshold}
          onThreshold={setChosenThreshold}
          connectedAddress={connectedAddress}
          chainId={chainId}
          label={label}
          onLabel={setLabel}
          error={error}
          onNext={goRules}
        />
      )}
      {step === 'rules' && (
        <RulesSheet
          rules={rules}
          onRules={setRules}
          ownerCount={arrangement.owners.length}
          presetLabel={presetLabel}
          thresholdLabel={thresholdLabel}
          onNext={goNetworks}
          onBack={() => setStep('type')}
        />
      )}
      {step === 'networks' && (
        <>
          <NetworksSheet
            availableChainIds={available}
            selected={selected}
            onToggle={toggleNetwork}
            byChain={deployment.byChain}
            predictedAddress={deployment.predictedAddress}
            running={deployment.running}
            started={started}
            railFor={deployment.railFor}
            onDeploy={deploy}
            onRetry={retry}
            onBack={() => setStep('rules')}
            onDone={() => setStep('done')}
          />
        </>
      )}
      {step === 'done' && (
        <DoneSheet
          address={deployment.predictedAddress}
          selected={selected}
          byChain={deployment.byChain}
          label={label}
          onClose={() => onDone?.()}
        />
      )}
    </div>
  )
}

CreateVaultFlow.propTypes = {
  connectedAddress: PropTypes.string,
  chainId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  onDone: PropTypes.func,
  onCreated: PropTypes.func,
}
