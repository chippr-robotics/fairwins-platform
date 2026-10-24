/**
 * GroupPayRecipients × AddressInput's resolution contract.
 *
 * The real AddressInput re-announces its resolved address from an effect keyed on
 * BOTH the resolved value and the `onResolvedChange` identity (AddressInput.jsx ~L101).
 * GroupPayRecipients hands it a fresh inline callback every render, so every commit
 * re-fires the announcement. If the row editor commits a new recipients array for an
 * announcement that changed nothing, announce → commit → render → announce becomes an
 * unbounded update loop — and on a slow runner the churn eats keystrokes typed into
 * the controlled amount input (the phone-profile CI failure on 41-group-pay.cy.js).
 *
 * This suite drives the component with a mock that keeps the REAL effect shape, under
 * a stateful parent, and pins two facts: the state settles in a bounded number of
 * renders, and a typed amount survives resolution traffic.
 */
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, fireEvent, act } from '@testing-library/react'

vi.mock('../../components/ui/AddressInput', () => {
  const { useEffect } = require('react')
  return {
    default: ({ id, value, onChange, onResolvedChange, disabled, placeholder }) => {
      const resolved = /^0x[0-9a-fA-F]{40}$/.test(String(value).trim()) ? String(value).trim() : ''
      // Same contract as the real component: re-announce on value OR callback identity.
      useEffect(() => {
        onResolvedChange?.(resolved)
      }, [resolved, onResolvedChange])
      return (
        <input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={onChange}
        />
      )
    },
  }
})
vi.mock('../../components/ui/AddressBookButton', () => ({
  default: () => null,
}))

import GroupPayRecipients from '../../components/wallet/GroupPayRecipients'
import { makeRecipient } from '../../lib/payments/groupPay'

const PAYEE = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'

function makeHarness() {
  const renders = { count: 0 }
  function Harness() {
    const [rows, setRows] = useState(() => [makeRecipient()])
    renders.count += 1
    return (
      <GroupPayRecipients
        recipients={rows}
        onChange={setRows}
        issuesFor={() => []}
        chainId={137}
        symbol="ETH"
        disabled={false}
        idPrefix="pt"
      />
    )
  }
  return { Harness, renders }
}

describe('GroupPayRecipients under resolution announcements', () => {
  it('settles in a bounded number of renders after an address resolves', () => {
    const { Harness, renders } = makeHarness()
    render(<Harness />)

    const addr = document.querySelector('input[id^="pt-gp-addr-"]')
    act(() => {
      fireEvent.change(addr, { target: { value: PAYEE } })
    })

    // One change + one resolution announcement should cost a handful of renders,
    // not an unbounded announce→commit→render loop. React throws "Maximum update
    // depth exceeded" long before 25 if the loop exists; the bound also guards a
    // slow burn that React tolerates.
    expect(renders.count).toBeLessThan(25)
  })

  it('keeps a typed amount through resolution traffic', () => {
    const { Harness } = makeHarness()
    render(<Harness />)

    const addr = document.querySelector('input[id^="pt-gp-addr-"]')
    act(() => {
      fireEvent.change(addr, { target: { value: PAYEE } })
    })
    const amt = document.querySelector('input[id^="pt-gp-amt-"]')
    act(() => {
      fireEvent.change(amt, { target: { value: '2' } })
    })

    expect(document.querySelector('input[id^="pt-gp-amt-"]')).toHaveValue('2')
    expect(document.querySelector('input[id^="pt-gp-addr-"]')).toHaveValue(PAYEE)
  })
})
