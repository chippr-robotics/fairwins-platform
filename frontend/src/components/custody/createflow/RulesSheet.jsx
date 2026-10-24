// Spec 105 US1 sheet 2 — rules as a tappable tile grid over ONE semantic config (FR-004/FR-005).
// The member never configures rules per network: each network realizes this config in its own
// everyday token (vaultRulesConfig.realizeRules). Tiles edit in place; the summary line always
// states the CURRENT arrangement before anything is signed.

import { useState } from 'react'
import PropTypes from 'prop-types'
import {
  describeSemanticRules,
  describeDuration,
  ALLOWED_MONEY,
  BIG_SENDS,
} from '../../../lib/custody/vaultRulesConfig'

const WAIT_CHOICES = [
  { value: 0, label: 'No wait' },
  { value: 900, label: '15 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 86400, label: '1 day' },
]

export default function RulesSheet({ rules, onRules, ownerCount, presetLabel, thresholdLabel, onNext, onBack }) {
  const [editing, setEditing] = useState(null)
  const set = (patch) => onRules({ ...rules, ...patch })
  const toggle = (tile) => setEditing((cur) => (cur === tile ? null : tile))
  const capOn = Boolean(String(rules.dailyCapAmount || '').trim())

  const tiles = [
    {
      id: 'cap',
      title: 'Daily cap',
      value: capOn ? `$${rules.dailyCapAmount}` : 'No cap',
      hint: capOn ? 'everyday money · every 24 hours' : 'any amount moves',
      editor: (
        <label>
          Daily cap in everyday money (blank for none)
          <input
            inputMode="decimal"
            value={rules.dailyCapAmount}
            onChange={(e) => set({ dailyCapAmount: e.target.value })}
            aria-label="Daily cap amount"
          />
        </label>
      ),
    },
    {
      id: 'wait',
      title: 'Wait between sends',
      value: describeDuration(rules.cooldownSeconds),
      hint: rules.cooldownSeconds > 0 ? 'no back-to-back moves' : 'sends can be back to back',
      editor: (
        <div role="radiogroup" aria-label="Wait between sends">
          {WAIT_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={Number(rules.cooldownSeconds) === c.value}
              onClick={() => set({ cooldownSeconds: c.value })}
            >
              {c.label}
            </button>
          ))}
        </div>
      ),
    },
    {
      id: 'allowed',
      title: 'Allowed money',
      value: rules.allowedMoney === ALLOWED_MONEY.STABLE ? 'Everyday money' : 'Everything',
      hint:
        rules.allowedMoney === ALLOWED_MONEY.STABLE
          ? 'other tokens need a full vote'
          : 'every token moves under the same rules',
      editor: (
        <div role="radiogroup" aria-label="Allowed money">
          <button
            type="button"
            role="radio"
            aria-checked={rules.allowedMoney === ALLOWED_MONEY.STABLE}
            onClick={() => set({ allowedMoney: ALLOWED_MONEY.STABLE })}
          >
            Everyday money only — anything else needs every owner
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={rules.allowedMoney === ALLOWED_MONEY.EVERYTHING}
            onClick={() => set({ allowedMoney: ALLOWED_MONEY.EVERYTHING })}
          >
            Everything — one set of rules for every token
          </button>
        </div>
      ),
    },
    {
      id: 'big',
      title: 'Big sends',
      value: !capOn
        ? 'No cap set'
        : rules.bigSends === BIG_SENDS.EVERYONE
          ? 'Everyone signs'
          : 'Follow allowed money',
      hint: !capOn ? 'set a daily cap first' : 'over the daily cap',
      editor: capOn ? (
        <div role="radiogroup" aria-label="Big sends">
          <button
            type="button"
            role="radio"
            aria-checked={rules.bigSends === BIG_SENDS.EVERYONE}
            onClick={() => set({ bigSends: BIG_SENDS.EVERYONE })}
          >
            Every owner signs a send over the cap
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={rules.bigSends === BIG_SENDS.FOLLOW_ALLOWED}
            onClick={() => set({ bigSends: BIG_SENDS.FOLLOW_ALLOWED })}
          >
            Treat it like any other money movement
          </button>
        </div>
      ) : (
        <p className="custody-hint">Big-send behaviour applies once a daily cap is set.</p>
      ),
    },
  ]

  const summary = describeSemanticRules(rules, ownerCount)

  return (
    <div className="create-flow__step" data-testid="create-step-rules">
      <p className="create-flow__kicker">Set rules</p>
      <p className="custody-hint">These kick in on each network as it goes live. Tap a tile to change it.</p>
      <div className="create-flow__tiles">
        {tiles.map((t) => (
          <div key={t.id} className="create-flow__tile-wrap">
            <button
              type="button"
              className={`create-flow__tile${editing === t.id ? ' is-editing' : ''}`}
              aria-expanded={editing === t.id}
              onClick={() => toggle(t.id)}
              data-testid={`rule-tile-${t.id}`}
            >
              <span className="create-flow__tile-title">{t.title}</span>
              <span className="create-flow__tile-value">{t.value}</span>
              <span className="create-flow__tile-hint">{t.hint}</span>
            </button>
            {editing === t.id && <div className="create-flow__tile-editor">{t.editor}</div>}
          </div>
        ))}
      </div>

      <div className="create-flow__summary" role="status" data-testid="rules-summary">
        <p className="create-flow__summary-chip">
          {presetLabel} · {thresholdLabel}
        </p>
        <ul>
          {summary.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="create-flow__nav">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <button type="button" className="create-flow__primary" onClick={onNext}>
          Next: pick networks
        </button>
      </div>
    </div>
  )
}

RulesSheet.propTypes = {
  rules: PropTypes.object.isRequired,
  onRules: PropTypes.func.isRequired,
  ownerCount: PropTypes.number.isRequired,
  presetLabel: PropTypes.string.isRequired,
  thresholdLabel: PropTypes.string.isRequired,
  onNext: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
}
