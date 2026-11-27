/**
 * FootballField (spec 115, US2) — a calm picture of where the ball is. The SVG is decoration (`aria-hidden`);
 * the text line beside it carries every fact the drawing does and is the accessible content (FR-009).
 *
 * Geometry: 120 yards (a 10-yard end zone at each end) at 10 units a yard. Yard line is measured from the HOME
 * goal line (left), per the gateway contract, so a home drive runs left→right and an away drive right→left —
 * that is a property of the axis, not of which way the teams face in a given quarter.
 * Shapes, not colours, tell the markers apart: the ball is a ROUND mark, the line to gain a DIAMOND; direction
 * is an arrow. Nothing animates. No team colours.
 *
 * Draws only what it was given: no yard line, no ball; no line to gain, no diamond.
 */
import { situationSentence } from '../../../lib/sports/describe'

const YD = 10
const END = 10 * YD
const W = 120 * YD
const H = 360
const TOP = 30
const FIELD_H = 300
const MID = TOP + FIELD_H / 2

const inField = (y) => Number.isFinite(y) && y >= 0 && y <= 100
const xOf = (yard) => END + yard * YD

function Marks() {
  const out = []
  for (let y = 10; y <= 90; y += 10) {
    const label = y <= 50 ? y : 100 - y
    out.push(
      <g key={y}>
        <line className="game-field-line" x1={xOf(y)} x2={xOf(y)} y1={TOP} y2={TOP + FIELD_H} />
        <text className="game-field-num" x={xOf(y)} y={TOP + 62} textAnchor="middle">
          {label}
        </text>
        <text className="game-field-num" x={xOf(y)} y={TOP + FIELD_H - 30} textAnchor="middle">
          {label}
        </text>
      </g>,
    )
  }
  return out
}

export default function FootballField({ situation, names = { home: null, away: null }, codes = { home: null, away: null } }) {
  const sentence = situationSentence(situation, names)
  const yard = situation?.yardLine
  const gain = situation?.lineToGain
  const ball = inField(yard)
  const hasDirection = ball && (situation?.possession === 'home' || situation?.possession === 'away')
  const dir = situation?.possession === 'away' ? -1 : 1

  return (
    <div className="game-field" data-testid="game-field">
      {ball && (
        <svg className="game-field-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
          <rect className="game-field-turf" x={END} y={TOP} width={100 * YD} height={FIELD_H} />
          <rect className="game-field-zone" x={0} y={TOP} width={END} height={FIELD_H} />
          <rect className="game-field-zone" x={W - END} y={TOP} width={END} height={FIELD_H} />
          <line className="game-field-goal" x1={END} x2={END} y1={TOP} y2={TOP + FIELD_H} />
          <line className="game-field-goal" x1={W - END} x2={W - END} y1={TOP} y2={TOP + FIELD_H} />
          <rect className="game-field-frame" x={0} y={TOP} width={W} height={FIELD_H} />
          <Marks />
          {codes.home && (
            <text className="game-field-zone-label" transform={`translate(${END / 2 + 14} ${MID}) rotate(-90)`} textAnchor="middle">
              {codes.home}
            </text>
          )}
          {codes.away && (
            <text className="game-field-zone-label" transform={`translate(${W - END / 2 + 14} ${MID}) rotate(90)`} textAnchor="middle">
              {codes.away}
            </text>
          )}
          {inField(gain) && (
            <g>
              <line className="game-field-gain-line" x1={xOf(gain)} x2={xOf(gain)} y1={TOP} y2={TOP + FIELD_H} />
              <polygon
                className="game-field-gain"
                points={`${xOf(gain)},${MID - 26} ${xOf(gain) + 22},${MID} ${xOf(gain)},${MID + 26} ${xOf(gain) - 22},${MID}`}
              />
            </g>
          )}
          <line className="game-field-scrimmage" x1={xOf(yard)} x2={xOf(yard)} y1={TOP} y2={TOP + FIELD_H} />
          {hasDirection && (
            <polygon
              className="game-field-arrow"
              points={`${xOf(yard) + dir * 34},${MID - 70} ${xOf(yard) + dir * 94},${MID - 70} ${xOf(yard) + dir * 94},${MID - 100} ${xOf(yard) + dir * 150},${MID - 55} ${xOf(yard) + dir * 94},${MID - 10} ${xOf(yard) + dir * 94},${MID - 40} ${xOf(yard) + dir * 34},${MID - 40}`}
            />
          )}
          <circle className="game-field-ball" cx={xOf(yard)} cy={MID + 70} r={22} />
        </svg>
      )}
      {ball && (
        <ul className="game-field-legend" aria-hidden="true">
          <li>
            <svg viewBox="0 0 20 20" width="16" height="16" focusable="false">
              <circle className="game-field-ball" cx="10" cy="10" r="7" />
            </svg>
            Ball
          </li>
          {inField(gain) && (
            <li>
              <svg viewBox="0 0 20 20" width="16" height="16" focusable="false">
                <polygon className="game-field-gain" points="10,2 18,10 10,18 2,10" />
              </svg>
              Line to gain
            </li>
          )}
          {hasDirection && (
            <li>
              <span className="game-field-legend-arrow">{dir === 1 ? '→' : '←'}</span>
              Direction of play
            </li>
          )}
        </ul>
      )}
      {sentence && (
        <p className="game-field-text" data-testid="game-field-text">
          {sentence}
        </p>
      )}
    </div>
  )
}

