/**
 * AssistantToolsPanel (spec 104) — the body of the Assistant tab in Tools.
 *
 * The agent controls used to be two cards in Settings, between "Notifications" and "Markets".
 * They are not appearance preferences: they decide who answers for the member, on whose money,
 * and which of the member's own tools may read their data — things that act on the member's
 * behalf, which is what the Tools group holds. So they got a tab, and the tab is one accordion:
 *
 *   1. Assistant       (card `assistant-prefs`, unchanged id)  — on/off, ANSWERED BY, memory
 *   2. GutterToken key (card `guttertoken-key`)                — the member's own credits
 *   3. API access      (card `api-access`, unchanged id)       — `ApiAccessPanel`, re-mounted as is
 *
 * followed by the "What leaves this device" disclosure, which is the one piece of copy that has to
 * be read as a whole: it now has THREE branches (off / FairWins / GutterToken), and a member choosing
 * between the two rails needs to see them side by side, not one per card.
 *
 * Membership is read ONCE here and handed to the cards: the chooser's three-state reasons and the
 * effective-provider line both need it, and two hooks would be two RPC reads for one fact.
 * (`ApiAccessPanel` keeps its own read — it is another surface's file and is mounted unchanged.)
 */

import { useCallback, useState } from 'react'
import PropTypes from 'prop-types'
import { useWallet } from '../../hooks/useWalletManagement'
import useRoleDetails from '../../hooks/useRoleDetails'
import { isFeatureEnabled } from '../../config/tenant'
import AccordionGroup from '../account/AccordionGroup'
import ApiAccessPanel from '../account/ApiAccessPanel'
import AssistantPreferencesCard from './AssistantPreferencesCard'
import GutterTokenKeyCard from './GutterTokenKeyCard'
import GutterTokenKeySheet from './GutterTokenKeySheet'
import './AssistantToolsPanel.css'

export default function AssistantToolsPanel({ openSection = null }) {
  const { address: account } = useWallet()
  const { getRoleDetails } = useRoleDetails()
  const membership = getRoleDetails('WAGER_PARTICIPANT')

  // The bring-your-own-key rail is a TENANT decision (spec 104's `assistant-byok`, which requires
  // `assistant`). A tenant without it keeps the membership rail only, so the option, the key card
  // and the GutterToken branch of the disclosure are absent rather than offered-and-refused —
  // there is nothing here for a member to do about a rail their instance does not have.
  const byokEnabled = isFeatureEnabled('assistant-byok')

  const [sheetOpen, setSheetOpen] = useState(false)
  const [lastOutcome, setLastOutcome] = useState(null)

  const openSheet = useCallback(() => setSheetOpen(true), [])
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  const onSaved = useCallback((outcome) => setLastOutcome(outcome), [])

  return (
    <div className="assistant-tools" data-testid="assistant-tools-panel">
      <p className="assistant-tools__intro">
        The assistant and your own tools. Choose who answers the assistant and on whose credits, keep
        a GutterToken key, and mint API keys for agents you run yourself. Open a card to change it.
      </p>

      <AccordionGroup openId={openSection}>
        <AssistantPreferencesCard membership={membership} byokEnabled={byokEnabled} />
        {byokEnabled && <GutterTokenKeyCard onAddKey={openSheet} lastOutcome={lastOutcome} />}
        <ApiAccessPanel />
      </AccordionGroup>

      <section className="assistant-tools__disclosure" aria-labelledby="assistant-tools-disclosure-title" data-testid="assistant-disclosure">
        <h4 id="assistant-tools-disclosure-title">What leaves this device</h4>
        <ul>
          <li>
            <strong>While the assistant is off, nothing is sent.</strong> No message, no account data,
            no page you are on.
          </li>
          <li>
            <strong>Answered by FairWins:</strong> your messages and the screen you are on go to the
            FairWins gateway and on to its model provider, which answers them. They are not used to
            train models by us.
          </li>
          {byokEnabled && (
            <li>
              <strong>Answered by GutterToken:</strong> your messages and the screen you are on go from
              this device <em>directly</em> to GutterToken under your own GutterToken agreement, billed to
              your prepaid balance per token. FairWins does not receive or process them and charges
              nothing on this path.
            </li>
          )}
          <li>
            On either rail, the assistant reads your own wagers and membership only after you sign a
            short-lived, read-only grant — and it tells you before asking.
          </li>
          <li>
            The conversation itself stays on this device. It is not backed up, not synced between your
            devices, and you can clear it in the Assistant card.
          </li>
          <li>
            The assistant never signs and never submits anything. Every action still takes your own
            signature, on the screen that action belongs to.
          </li>
        </ul>
        <p>
          <a href="/privacy" className="assistant-tools__link">
            Read the Privacy Policy
          </a>
        </p>
      </section>

      {byokEnabled && (
        <GutterTokenKeySheet open={sheetOpen} onClose={closeSheet} account={account} onSaved={onSaved} />
      )}
    </div>
  )
}

AssistantToolsPanel.propTypes = {
  /** The card a deep link named (`accordionSectionForHash('assistant', hash)`), or null. */
  openSection: PropTypes.string,
}
