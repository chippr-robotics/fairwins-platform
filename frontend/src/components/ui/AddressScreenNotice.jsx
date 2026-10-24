/**
 * AddressScreenNotice — the screening state of ONE entered address: a verdict pill, a segmented
 * bar showing the scan, and one short line. The per-source detail is one tap away, inside the
 * pill's own expansion.
 *
 * Spec 021 iteration 2 rendered this only for a restricted or unscreenable address, and only
 * against the guard on one chain. The issue-#1458 amendment made it render for every valid
 * address against every list on every cohort chain — and its QA round then found the notice had
 * become a paragraph: on a build where several sources were unreachable a member met four
 * contract names before learning the one thing that mattered, and the ⓘ explaining the rules
 * opened a bubble taller than the phone, clipped by the scrolling modal it sat in.
 *
 * So the specifics moved to where someone who wants them can ask: the bar shows the shape of the
 * scan, the pill says the verdict in a word, the line gives the counts, and the expansion names
 * every source with its answer. Flagged is the one case that still names its lists in the line
 * itself — a member about to send value needs that without a tap — and is the one case that
 * carries `role="alert"`.
 *
 * `chainId` is the network the surrounding flow acts on. It does not narrow the screen — the
 * whole cohort is always asked — it marks that network's rows in the detail.
 */
import { NETWORKS } from '../../config/networks'
import { useEstateScreening } from '../../hooks/useEstateScreening'
import { isValidAddress } from '../../lib/addressBook/addressBookStore'
import { describeVerdict, VERDICTS } from '../../lib/screening/verdict'
import ScreeningPill from './ScreeningPill'
import ScreeningStatusBar from './ScreeningStatusBar'

const networkName = (chainId) => NETWORKS[chainId]?.name || `Chain ${chainId}`

export default function AddressScreenNotice({ address, chainId }) {
  const valid = Boolean(address) && isValidAddress(address)
  const { status, result } = useEstateScreening(valid ? address : null)

  if (!valid) return null

  const done = status === 'done' && result
  const flagged = done && result.verdict === VERDICTS.FLAGGED
  const text = done ? describeVerdict(result, networkName) : 'Checking the sanctions and issuer freeze lists…'

  return (
    <div
      className={`ab-screen-notice${done ? ` ab-screen-notice-${result.verdict}` : ''}`}
      role={flagged ? 'alert' : 'status'}
      data-screen-verdict={done ? result.verdict : 'loading'}
    >
      <div className="ab-screen-notice-head">
        <ScreeningPill result={done ? result : null} loading={!done} chainId={chainId} />
        <span className="ab-screen-notice-text">{text}</span>
      </div>
      <ScreeningStatusBar result={done ? result : null} loading={!done} label={text} />
    </div>
  )
}
