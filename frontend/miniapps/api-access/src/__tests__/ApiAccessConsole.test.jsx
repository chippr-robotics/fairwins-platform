import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { hostRef, resetHost } from './_host'
import { CONSOLE_KEY } from '../consoleStore'
import { jsonResponse, MEMBER_API_DOC } from './_fixtures'

vi.mock('@fairwins/miniapp-sdk', () => ({ useMiniAppHost: () => hostRef.current }))

import ApiAccessConsole from '../ApiAccessConsole'

// Spec 095 — the console end to end against the stub host and a mocked `fetch`.
//
// Two invariants carry most of the weight here:
//   1. THE TOKEN NEVER REACHES THE STORE. It is a credential; the store rides the member's
//      encrypted backup. There is no code path that writes one, and this asserts it stays that way.
//   2. A FAILED READ RENDERS NO RESULT. An unreachable gateway is not an API with no endpoints.

const A_TOKEN = 'fw1.eyJ2IjoxfQ.c2lnbmF0dXJl'

function stubFetch(handler) {
  const fetchMock = vi.fn(handler)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The default: every request answers with the member-API description. */
function specServed() {
  return stubFetch(async () => jsonResponse(MEMBER_API_DOC))
}

describe('ApiAccessConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetHost()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('renders with no token, and says the token is held in memory only', async () => {
    specServed()
    render(<ApiAccessConsole />)

    expect(screen.getByLabelText(/api token/i)).toHaveValue('')
    expect(screen.getByText(/Held in memory only, and cleared when you leave this app/i)).toBeInTheDocument()
    // Introspection is offered but not possible without a token, and says which.
    expect(screen.getByRole('button', { name: /check this token/i })).toBeDisabled()
    expect(screen.getByText(/Paste a token in the connection card above/i)).toBeInTheDocument()

    // The description still loads — it needs no credential.
    expect(await screen.findByText('FairWins Member API')).toBeInTheDocument()
  })

  it('starts at the public default when nothing is saved, and says nothing is saved', async () => {
    const fetchMock = specServed()
    render(<ApiAccessConsole />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('https://relay.fairwins.app/v1/member/openapi.json')
  })

  it('reads the saved gateway address out of the app store at mount', async () => {
    resetHost({ storeData: { [CONSOLE_KEY]: { baseUrl: 'https://gw.example' } } })
    const fetchMock = specServed()

    render(<ApiAccessConsole />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('https://gw.example/v1/member/openapi.json')
    expect(screen.getByLabelText(/gateway address/i)).toHaveValue('https://gw.example')
  })

  it('persists a saved gateway address under the single declared store key, normalised', async () => {
    const fetchMock = specServed()
    const user = userEvent.setup()
    render(<ApiAccessConsole />)

    const field = screen.getByLabelText(/gateway address/i)
    await user.clear(field)
    await user.type(field, 'gw.example/api/')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(hostRef.current.store.set).toHaveBeenCalledWith(CONSOLE_KEY, { baseUrl: 'https://gw.example/api' })
    expect(hostRef.current.toast.show).toHaveBeenCalledWith('Gateway address saved.', 'success')
    // And the console now reads from there.
    await waitFor(() => {
      expect(fetchMock.mock.calls.at(-1)[0]).toBe('https://gw.example/api/v1/member/openapi.json')
    })
  })

  it('refuses an address that is not a web address, and saves nothing', async () => {
    specServed()
    const user = userEvent.setup()
    render(<ApiAccessConsole />)

    const field = screen.getByLabelText(/gateway address/i)
    await user.clear(field)
    await user.type(field, 'ws://example.test')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    expect(screen.getByRole('alert')).toHaveTextContent(/ws:\/\/ is not supported/)
    expect(hostRef.current.store.set).not.toHaveBeenCalled()
  })

  it('never writes the token to the store', async () => {
    specServed()
    const user = userEvent.setup()
    render(<ApiAccessConsole />)

    await user.type(screen.getByLabelText(/api token/i), A_TOKEN, { delay: null })
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    for (const call of hostRef.current.store.set.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(A_TOKEN)
    }
    // Nothing else was handed the token either — `audit.log` takes refs, and a token is not one.
    expect(hostRef.current.audit.log).not.toHaveBeenCalled()
  })

  it('clears the token on request', async () => {
    specServed()
    const user = userEvent.setup()
    render(<ApiAccessConsole />)

    const field = screen.getByLabelText(/api token/i)
    await user.type(field, A_TOKEN, { delay: null })
    expect(field).toHaveValue(A_TOKEN)

    await user.click(screen.getByRole('button', { name: /^clear$/i }))
    expect(field).toHaveValue('')
  })

  it('renders the endpoint roster when the description loads', async () => {
    specServed()
    render(<ApiAccessConsole />)

    expect(await screen.findByText('/v1/member/me')).toBeInTheDocument()
    expect(screen.getByText('/v1/member/wagers')).toBeInTheDocument()
  })

  it('renders an alert and no roster when the gateway cannot be reached', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    render(<ApiAccessConsole />)

    expect(await screen.findByText('The API description could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText('/v1/member/me')).not.toBeInTheDocument()
    // The try-it picker is built from the same document, so it degrades with it rather than
    // offering endpoints nobody confirmed exist.
    expect(screen.getByText(/The endpoint list comes from the API description above/i)).toBeInTheDocument()
  })

  it('deep-links key creation into the host app, because a package cannot sign', async () => {
    specServed()
    const user = userEvent.setup()
    render(<ApiAccessConsole />)

    await user.click(screen.getByRole('button', { name: /open api access settings/i }))

    expect(hostRef.current.navigate).toHaveBeenCalledWith('/wallet?tab=settings#api-access')
  })

  it('survives a full token typed as one synchronous burst without tripping the update limit', () => {
    // The shard-0 crash on PR #1386: IntrospectionPanel invalidated its answer via an effect keyed
    // on [token, baseUrl], which scheduled one extra update per keystroke. Cypress types with
    // `delay: 0` — every character lands in a single synchronous flush — and ~68 of those nested
    // updates trip React's depth limit, killing the whole console mid-type. Invalidation is now
    // DERIVED (the answer records what it was asked about and retires itself in render), so a
    // burst costs exactly one update per character. jsdom reproduces the crash the same way the
    // browser did; with the effect shape restored this test fails with "Maximum update depth
    // exceeded".
    specServed()
    render(<ApiAccessConsole />)
    const input = document.querySelector('#aa-token')

    act(() => {
      let value = ''
      for (const ch of `${A_TOKEN}.${A_TOKEN}`) {
        value += ch
        fireEvent.change(input, { target: { value } })
      }
    })

    expect(input.value).toBe(`${A_TOKEN}.${A_TOKEN}`)
  })
})
