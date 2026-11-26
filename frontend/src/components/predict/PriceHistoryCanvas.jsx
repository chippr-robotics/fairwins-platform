/**
 * PriceHistoryCanvas (spec 114, R8) — the recharts internals, isolated so the chart can be lazy-loaded and
 * the browse view never pays for them (the PnlChartCanvas precedent).
 *
 * Colour comes from CSS classes (`.event-chart-s<id>` sets `color` from a `--chart-series-*` token) and every
 * stroke is `currentColor`, so this file states no colour. Series differ by dash pattern as well as colour.
 * Gaps are gaps: `connectNulls={false}`, and the data carries explicit null points where history is missing.
 * Nothing animates, so prefers-reduced-motion has nothing to undo.
 */
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from 'recharts'

const percentTick = (v) => `${Math.round(Number(v) * 100)}%`
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1]

function timeTick(rangeId) {
  return (ms) => {
    const d = new Date(ms)
    if (rangeId === '1h' || rangeId === '1d') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
}

export default function PriceHistoryCanvas({ lines, rangeId, highlightId }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={timeTick(rangeId)}
          minTickGap={40}
        />
        <YAxis type="number" domain={[0, 1]} ticks={Y_TICKS} tickFormatter={percentTick} width={44} allowDataOverflow />
        {lines.map((line) => (
          <Line
            key={line.id}
            className={`event-chart-line event-chart-s${line.styleId}`}
            data={line.data}
            dataKey="p"
            type="linear"
            stroke="currentColor"
            strokeWidth={line.id === highlightId ? 3 : 1.75}
            strokeDasharray={line.dash || undefined}
            dot={false}
            activeDot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
