/**
 * PlayList (spec 115, US3) — the plays the source reported, newest first, as text. A scoring play is marked in
 * WORDS ("Scored:"), not by colour. Shows only what was reported: no invented play, no count, no empty-state
 * apology (an empty list renders nothing).
 */
const MAX_PLAYS = 12

export default function PlayList({ plays }) {
  const list = (Array.isArray(plays) ? plays : []).filter((p) => p && typeof p === 'object').slice(0, MAX_PLAYS)
  if (list.length === 0) return null
  return (
    <ol className="game-plays" aria-label="Recent plays, newest first" data-testid="game-plays">
      {list.map((p, i) => {
        const when = [p.period, p.clock].filter((v) => typeof v === 'string' && v !== '').join(' ')
        const body = typeof p.text === 'string' && p.text !== '' ? p.text : null
        return (
          <li key={p.id ?? i} className="game-play">
            <span className="game-play-when">{when || '—'}</span>
            <span className="game-play-text">
              {p.scoring === true && <strong className="game-play-scored">Scored: </strong>}
              {body ?? 'No description reported'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
