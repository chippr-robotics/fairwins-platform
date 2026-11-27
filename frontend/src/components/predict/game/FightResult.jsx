/**
 * FightResult (spec 115 slice 3, FR-019) — the outcome in words, who said it, and the judges' scores.
 *
 * - `win` names the winner (from the fighter order), the method, the ending round and time;
 * - `draw` and `no-contest` exist only from the UFC source and are stated as the source's;
 * - `cancelled` only ever comes from the VENUE, which has been seen to say "Canceled" for a fight that was
 *   fought — so it is attributed, never stated as fact;
 * - judges' scores are a small table of the numbers as given: no sum, no "winner of the round".
 * One sentence that the market settles separately: this is the fight's result, never the market's resolution.
 */
import { outcomeWords, resultSourceName } from '../../../lib/sports/describe'

const label = (n) => n ?? 'Fighter not named'

export default function FightResult({ result, names, sources }) {
  if (!result) return null
  const words = outcomeWords(result, names, sources)
  const detail = [
    result.outcome === 'win' ? result.method : null,
    result.endingRound != null ? `Round ${result.endingRound}` : null,
    result.endingTime,
  ].filter(Boolean)
  const showDetail = (result.outcome === 'win' || result.outcome === 'draw' || result.outcome === 'no-contest') && detail.length > 0
  const drawMethod = result.outcome !== 'win' && result.method ? result.method : null
  return (
    <div className="fight-result" data-testid="fight-result">
      <p className="fight-result-line">{words}</p>
      {showDetail && <p className="fight-result-detail">{detail.join(' · ')}</p>}
      {drawMethod && !showDetail && <p className="fight-result-detail">{drawMethod}</p>}
      {result.outcome !== 'cancelled' && result.source && (
        <p className="game-note">Result from {resultSourceName(result.source, sources)}.</p>
      )}
      {result.judges.length > 0 && (
        <table className="fight-table fight-judges" data-testid="fight-judges">
          <caption>Judges' scores</caption>
          <thead>
            <tr>
              <th scope="col">Judge</th>
              <th scope="col" className="fight-num">{label(names[0])}</th>
              <th scope="col" className="fight-num">{label(names[1])}</th>
            </tr>
          </thead>
          <tbody>
            {result.judges.map((j, i) => (
              <tr key={`${j.name ?? 'judge'}-${i}`}>
                <th scope="row">{j.name ?? 'Judge not named'}</th>
                <td className="fight-num">{j.scores[0]}</td>
                <td className="fight-num">{j.scores[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="game-note">The market settles separately, on the venue's own resolution.</p>
    </div>
  )
}
