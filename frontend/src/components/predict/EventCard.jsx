/**
 * EventCard (spec 114, US1) — one event, however many markets it holds.
 *
 * Honest by construction:
 *  - a null `displayPrice` renders "—", never 0% (FR-012); a null outcome price renders "—" and its
 *    button is disabled;
 *  - movement is a glyph AND words ("up since the last update") — never colour alone (FR-014);
 *  - rows are never drawn as shares of a whole: there is no stacked bar or total, because a
 *    `mutuallyExclusive: false` event's markets are independent and probabilities are not rescaled (FR-008);
 *  - a null volume prints no figure; a null end date prints no closing line.
 *  - an event in play says "In play" with the venue's own score and period, as plain text: no animation, no
 *    colour-only meaning, nothing more urgent than the venue's words (FR-002c, FR-028).
 * Trading is not built here: choosing a row hands (event, row) to `onOpen` — or, when the caller has the
 * amount-first ticket (`onOpenTicket`, a gateway with live readings), (event, row, the outcome pressed) to that
 * instead; the title hands the event to `onOpenEvent` when the caller has an event page to open (else it opens
 * the first tradable row, as before).
 */
import { categoryLabel } from '../../lib/predict/categories'
import { defaultRow } from '../../lib/predict/eventAdapters'
import { formatPercent, formatCents, formatVolume, formatClosing, formatInPlay } from '../../lib/predict/format'
import './EventCard.css'

const MOVE_TEXT = { up: 'up since the last update', down: 'down since the last update' }
const MOVE_GLYPH = { up: '▲', down: '▼' }

function Row({ event, row, single, direction, onOpen, onOpenTicket }) {
  const label = single ? row.outcomes?.map((o) => o.name).join(' / ') || 'Outcome' : row.label
  const percent = formatPercent(row.displayPrice)
  const [first, second] = row.outcomes || []
  return (
    <li className="event-card-row">
      <span className="event-card-row-label">{label}</span>
      <span className="event-card-row-prob">
        {direction && (
          <>
            <span className={'event-card-move event-card-move--' + direction} aria-hidden="true">
              {MOVE_GLYPH[direction]}
            </span>
            <span className="sr-only">{MOVE_TEXT[direction]}, </span>
          </>
        )}
        <span className="event-card-pct">{percent}</span>
        <span className="sr-only"> chance</span>
      </span>
      <span className="event-card-actions">
        {[first, second].map((o, i) =>
          o ? (
            <button
              key={o.tokenId ?? i}
              type="button"
              className={'event-card-side ' + (i === 0 ? 'event-card-side--yes' : 'event-card-side--no')}
              disabled={o.price == null}
              aria-haspopup="dialog"
              aria-label={o.name + ' ' + formatCents(o.price) + (o.price == null ? ' (price unavailable)' : '') + ', ' + label}
              onClick={() => (onOpenTicket ? onOpenTicket(event, row, o) : onOpen(event, row))}
            >
              {o.name} {formatCents(o.price)}
            </button>
          ) : null,
        )}
      </span>
    </li>
  )
}

export default function EventCard({ event, directions = {}, onOpen, onOpenEvent, onOpenTicket }) {
  const rows = event.markets || []
  const single = (Number(event.marketCount) || rows.length) <= 1
  const more = Math.max(0, (Number(event.marketCount) || 0) - rows.length)
  const volume = formatVolume(event.volume)
  const closes = formatClosing(event.endDate)
  const category = categoryLabel(event.category)
  const opener = defaultRow(event)
  const inPlay = formatInPlay(event.live)

  return (
    <li className="event-card" data-slug={event.slug}>
      {(category || inPlay) && (
        <span className="event-card-kicker">
          {category && <span className="event-card-category">{category}</span>}
          {inPlay && <span className="event-card-live">{inPlay}</span>}
        </span>
      )}
      {onOpenEvent ? (
        // The title opens the event's own page (its address is `event=<slug>`); a row's Yes/No still opens the sheet.
        <button type="button" className="event-card-title" onClick={() => onOpenEvent(event)}>
          {event.title}
        </button>
      ) : opener ? (
        <button type="button" className="event-card-title" aria-haspopup="dialog" onClick={() => onOpen(event, opener)}>
          {event.title}
        </button>
      ) : (
        <span className="event-card-title event-card-title--static">{event.title}</span>
      )}
      <ul className="event-card-rows">
        {rows.map((row) => (
          <Row
            key={row.conditionId}
            event={event}
            row={row}
            single={single}
            direction={directions[row.conditionId] ?? null}
            onOpen={onOpen}
            onOpenTicket={onOpenTicket}
          />
        ))}
      </ul>
      {more > 0 && <span className="event-card-more">+{more} more</span>}
      {(volume || closes) && (
        <span className="event-card-footer">
          {volume && <span>{volume} traded</span>}
          {closes && <span>closes {closes}</span>}
        </span>
      )}
    </li>
  )
}
