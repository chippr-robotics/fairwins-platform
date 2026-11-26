/**
 * useAddressText — a field mirrored in the address must never be overwritten by its own older
 * writes coming back late (the race that emptied Predict's search results on a slow runner).
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAddressText } from '../../hooks/useAddressText'

/** A controllable clock, and a harness whose `address` prop plays the router. */
function setup(initial = '') {
  let clock = 0
  const now = () => clock
  const hook = renderHook(({ address }) => useAddressText(address, { now }), { initialProps: { address: initial } })
  return {
    hook,
    text: () => hook.result.current[0],
    type: (value, written) => act(() => hook.result.current[1](value, written)),
    address: (value) => hook.rerender({ address: value }),
    advance: (ms) => { clock += ms },
  }
}

describe('useAddressText', () => {
  it('starts from the address', () => {
    expect(setup('harbour').text()).toBe('harbour')
  })

  it('a late echo of an OLDER keystroke does not overwrite what was typed since', () => {
    const h = setup('')
    h.type('h')
    h.type('ha')
    h.type('har')
    // The router now delivers the first write, after two more keys were typed.
    h.address('h')
    expect(h.text()).toBe('har')
    h.address('ha')
    expect(h.text()).toBe('har')
    h.address('har')
    expect(h.text()).toBe('har')
  })

  it('tolerates a router that delivers only the last write, or the same one twice', () => {
    const h = setup('')
    h.type('a')
    h.type('ab')
    h.type('abc')
    h.address('abc')
    h.address('abc')
    expect(h.text()).toBe('abc')
  })

  it('handles typing, deleting and retyping the same text', () => {
    const h = setup('')
    h.type('a')
    h.type('', '')
    h.type('a')
    h.address('a')
    h.address('')
    h.address('a')
    expect(h.text()).toBe('a')
  })

  it('follows a change that came from outside (Back, a shared link)', () => {
    const h = setup('rain')
    h.address('harbour')
    expect(h.text()).toBe('harbour')
    h.address('')
    expect(h.text()).toBe('')
  })

  it('an outside change long after typing is followed even if it matches something typed earlier', () => {
    const h = setup('')
    h.type('h')
    h.type('ha')
    h.address('ha')
    h.advance(5000)
    // Back to an entry whose value happens to be one this field wrote a while ago.
    h.address('h')
    expect(h.text()).toBe('h')
  })

  it('records what was WRITTEN when it differs from the text (whitespace is written as empty)', () => {
    const h = setup('')
    h.type('   ', '')
    h.address('')
    expect(h.text()).toBe('   ')
  })

  it('a Clear from code is a write like any other: an older echo arriving after it does not refill the field', () => {
    const h = setup('')
    h.type('abc')
    h.type('', '') // the Clear button
    expect(h.text()).toBe('')
    h.address('abc') // the keystroke's write, arriving late
    expect(h.text()).toBe('')
    h.address('')
    expect(h.text()).toBe('')
  })
})
