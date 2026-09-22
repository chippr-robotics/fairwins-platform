/**
 * Spec 073 T024 — the mini-app workspace, plus the app-identity binding it
 * exists to establish.
 *
 * The interesting assertions here are all about what happens BEFORE a package
 * gets to render:
 *
 *  - the URL slug is resolved against the CHAIN on every mount, so a record that
 *    changed between browsing and launching is caught (FR-010);
 *  - `launchable` — not `status` — decides, so a live app with an update in
 *    review still launches (FR-003) while a suspended one does not;
 *  - the app is NAMED before it is loaded: the loader is handed the slug derived
 *    from the record's on-chain name, which is what turns its `manifest.id` check
 *    from a no-op into a real refusal (the last block drives the REAL loader to
 *    prove exactly that);
 *  - the store namespace and audit attribution key on the immutable registry id
 *    plus chain, never on the mutable name;
 *  - every refusal is its own specific message, and a mini-app that throws is
 *    contained to its own surface (FR-015).
 */
import { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { keccak256 } from 'ethers'

import { AppStatus } from '../../abis/miniAppRegistry'
import { sha256Hex } from '../../lib/miniapps/integrity'
import { MANIFEST_SCHEMA, SUPPORTED_HOST_API } from '../../lib/miniapps/manifest'

const CHAIN = 137
const REGISTRY = '0x1111111111111111111111111111111111111111'
const VENDOR = '0x2222222222222222222222222222222222222222'
const ACCOUNT = '0xAbCd000000000000000000000000000000000073'
const CID = 'bafybeigdyrztfairwinsminiapppackagecidexampleaaaaaaaaaaaaaaaaaaaa'
const SLUG = 'token-mint'
const NAME = 'Token Mint'
/** id 7 on chain 137 — the identity the store and the audit trail key on. */
const NAMESPACE = 'app-137-7'

const G1 = 'https://gateway.example'

// Mutable doubles for every seam the workspace reaches through. `vi.hoisted` so
// the mock factories (which run before this file's top-level statements) can
// reach them.
const m = vi.hoisted(() => ({
  /** What `fetchAppBySlug` answers. */
  outcome: null,
  /** Slugs the workspace asked for, in order. */
  requested: [],
  /** `(record, options, realLoadMiniApp) => result`. */
  load: null,
  /** Options the workspace handed the loader on the last call. */
  loadOptions: null,
  loadCalls: 0,
  /** `appId` the host provider was mounted with. */
  providerAppId: null,
  account: null,
  audit: { launch: [], integrity: [], log: [] },
}))

vi.mock('../../lib/miniapps/registryClient', async (importOriginal) => {
  // `appSlug` / `appNamespaceKey` stay REAL: they are the identity derivation
  // under test, and stubbing them would prove nothing about the binding.
  const actual = await importOriginal()
  return {
    ...actual,
    fetchAppBySlug: vi.fn(async (slug) => {
      m.requested.push(slug)
      return m.outcome
    }),
  }
})

vi.mock('../../lib/miniapps/loader', async (importOriginal) => {
  // The typed error classes stay REAL so the workspace's `instanceof` mapping is
  // exercised rather than mimicked.
  const actual = await importOriginal()
  return {
    ...actual,
    loadMiniApp: vi.fn(async (record, options) => {
      m.loadCalls += 1
      m.loadOptions = options
      return m.load(record, options, actual.loadMiniApp)
    }),
  }
})

vi.mock('../../lib/miniapps/hostContext', () => ({
  MiniAppHostProvider: ({ appId, children }) => {
    m.providerAppId = appId
    return <div data-testid="host-provider">{children}</div>
  },
  useMiniAppHost: () => ({ appId: m.providerAppId }),
}))

vi.mock('../../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => ({ address: m.account }),
}))

vi.mock('../../data/ledger/sources/miniAppSource', () => ({
  captureMiniAppLaunch: (...args) => m.audit.launch.push(args),
  captureMiniAppIntegrityFailure: (...args) => m.audit.integrity.push(args),
  captureMiniAppLog: (...args) => m.audit.log.push(args),
}))

import {
  AppNotLaunchableError,
  GatewayUnavailableError,
  HostApiError,
  IntegrityError,
  MANIFEST_REFUSAL,
  ManifestError,
  loadMiniApp,
} from '../../lib/miniapps/loader'
import { fetchAppBySlug } from '../../lib/miniapps/registryClient'
import MiniAppWorkspace from '../../components/miniapps/MiniAppWorkspace'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A normalized registry record, as `registryClient` hands one to the launch path. */
function record({ id = 7, name = NAME, status = AppStatus.APPROVED, launchable = true, cid = CID, manifestHash = `0x${'ab'.repeat(32)}` } = {}) {
  return Object.freeze({
    id,
    vendor: VENDOR,
    name,
    description: `${name} description`,
    category: 1,
    status,
    approved: Object.freeze({ cid, manifestHash, version: 3, present: true }),
    proposed: Object.freeze({ cid: '', manifestHash: `0x${'0'.repeat(64)}`, version: 0, present: false }),
    submittedAt: 1_700_000_000,
    approvedAt: 1_700_000_500,
    updatedAt: 1_700_000_900,
    launchable,
  })
}

/** The `{status:'ok'}` shape `fetchAppBySlug` returns around a record. */
function found(app) {
  return { status: 'ok', app, slug: SLUG, fetchedAt: Date.now(), chainId: CHAIN, registryAddress: REGISTRY }
}

/** What the loader returns for a verified package. */
function loaded({ name = NAME, version = '3.1.0', component, styles = [] } = {}) {
  return {
    manifest: { id: SLUG, name, version, entry: 'entry.js', styles: styles.map((s) => s.path) },
    module: { default: component },
    component: component ?? (() => <p>token mint surface</p>),
    styles,
    gateway: G1,
    cid: CID,
    manifestHash: `0x${'ab'.repeat(32)}`,
  }
}

function renderWorkspace(slug = SLUG) {
  return render(
    <MemoryRouter initialEntries={[`/apps/${slug}`]}>
      <Routes>
        <Route path="/apps/:slug" element={<MiniAppWorkspace />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Wait for the refusal panel and return its machine code. */
async function refusalCode() {
  const alert = await screen.findByRole('alert')
  return alert.getAttribute('data-refusal')
}

beforeEach(() => {
  m.outcome = found(record())
  m.requested = []
  m.load = () => loaded()
  m.loadOptions = null
  m.loadCalls = 0
  m.providerAppId = null
  m.account = ACCOUNT
  m.audit = { launch: [], integrity: [], log: [] }
  vi.mocked(fetchAppBySlug).mockClear()
  vi.mocked(loadMiniApp).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('slug resolution and app identity', () => {
  it('resolves the route slug against the registry and mounts the package', async () => {
    renderWorkspace()

    expect(await screen.findByText('token mint surface')).toBeInTheDocument()
    expect(m.requested).toEqual([SLUG])
  })

  it('names the app to the loader from the record’s on-chain name', async () => {
    // THE BINDING. `expectedAppId` is derived from the registry NAME (unique
    // on-chain), not read off the record and not taken from the URL blindly —
    // that is what gives the loader's `manifest.id` check something real to
    // compare against.
    m.outcome = found(record({ name: '  TOKEN   MINT  ' }))

    renderWorkspace()

    await waitFor(() => expect(m.loadOptions).not.toBeNull())
    expect(m.loadOptions.expectedAppId).toBe('token-mint')
  })

  it('keys the store namespace and audit attribution on the registry id + chain', async () => {
    renderWorkspace()

    await screen.findByText('token mint surface')
    // NOT the slug: a vendor can rename a listing, and id 7 exists on every
    // chain the registry is deployed to.
    expect(m.providerAppId).toBe(NAMESPACE)
    expect(m.audit.launch).toHaveLength(1)
    expect(m.audit.launch[0][0]).toBe(ACCOUNT)
    expect(m.audit.launch[0][1]).toBe(CHAIN)
    expect(m.audit.launch[0][2]).toMatchObject({ appId: NAMESPACE, version: '3.1.0', cid: CID })
  })

  it('refuses a listing whose name cannot be a stable app address', async () => {
    // No slug means no binding: the package's self-declared id would go
    // unchecked. Refuse rather than launch something unbound.
    m.outcome = found(record({ name: 'Token Mint!' }))

    renderWorkspace()

    expect(await refusalCode()).toBe('unidentifiable')
    expect(loadMiniApp).not.toHaveBeenCalled()
  })
})

describe('the record is re-read at launch (FR-010)', () => {
  it('reads the registry itself rather than accepting a browsed record', async () => {
    renderWorkspace()
    await screen.findByText('token mint surface')
    expect(fetchAppBySlug).toHaveBeenCalledTimes(1)
  })

  it('re-reads on every mount, so a remount cannot serve a stale decision', async () => {
    const first = renderWorkspace()
    await screen.findByText('token mint surface')
    first.unmount()

    renderWorkspace()
    await screen.findByText('token mint surface')
    expect(fetchAppBySlug).toHaveBeenCalledTimes(2)
  })

  it('refuses an app that was suspended after the member browsed it', async () => {
    // The exact window a curator uses on a compromised app.
    m.outcome = found(record({ status: AppStatus.SUSPENDED, launchable: false }))

    renderWorkspace()

    expect(await refusalCode()).toBe('suspended')
    expect(screen.getByRole('alert')).toHaveTextContent(/none of its package was downloaded/i)
    expect(loadMiniApp).not.toHaveBeenCalled()
  })

  it('still launches a live app whose vendor has an update in review (FR-003)', async () => {
    // Pending AND launchable: the last reviewed package keeps serving. Gating on
    // `status === Approved` here would hand every vendor an offline switch for
    // their own live app.
    m.outcome = found(record({ status: AppStatus.PENDING, launchable: true }))

    renderWorkspace()

    expect(await screen.findByText('token mint surface')).toBeInTheDocument()
    expect(loadMiniApp).toHaveBeenCalledTimes(1)
  })
})

describe('every refusal says what actually happened', () => {
  it('distinguishes a build with no registry from a registry it cannot read', async () => {
    m.outcome = { status: 'not-deployed', chainId: CHAIN, registryAddress: null }
    const first = renderWorkspace()
    expect(await refusalCode()).toBe('registry-not-deployed')
    expect(screen.getByRole('alert')).toHaveTextContent(/no mini-app registry is configured/i)
    first.unmount()

    m.outcome = {
      status: 'unreachable',
      chainId: CHAIN,
      registryAddress: REGISTRY,
      reason: 'read-failed',
      error: new Error('rpc down'),
      stale: null,
    }
    renderWorkspace()
    expect(await refusalCode()).toBe('registry-unreachable')
    // An unread registry is never reported as "nothing is approved".
    expect(screen.getByRole('alert')).toHaveTextContent(/nothing is launched without that check/i)
  })

  it('says no such app when the registry answered and holds none', async () => {
    m.outcome = { status: 'not-found', slug: SLUG, chainId: CHAIN, registryAddress: REGISTRY }
    renderWorkspace()
    expect(await refusalCode()).toBe('not-found')
  })

  it('separates retired from suspended from never-reviewed', async () => {
    m.outcome = found(record({ status: AppStatus.DEPRECATED, launchable: false }))
    const first = renderWorkspace()
    expect(await refusalCode()).toBe('deprecated')
    expect(screen.getByRole('alert')).toHaveTextContent(/will not return/i)
    first.unmount()

    m.outcome = found(record({ status: AppStatus.PENDING, launchable: false }))
    renderWorkspace()
    expect(await refusalCode()).toBe('never-approved')
    expect(screen.getByRole('alert')).toHaveTextContent(/no version of this app has been approved yet/i)
  })

  it('reports an integrity failure as a supply-chain event and audits it', async () => {
    m.load = () => {
      throw new IntegrityError('manifest_hash_mismatch', 'manifest bytes do not match the chain', {
        path: null,
        expected: `0x${'ab'.repeat(32)}`,
        actual: `0x${'cd'.repeat(32)}`,
      })
    }

    renderWorkspace()

    expect(await refusalCode()).toBe('integrity')
    expect(screen.getByRole('alert')).toHaveTextContent(/does not match the version approved on-chain/i)
    // Recorded whether or not the member ever reports it (FR-011/FR-019).
    expect(m.audit.integrity).toHaveLength(1)
    expect(m.audit.integrity[0][2]).toMatchObject({ appId: NAMESPACE, reason: 'manifest_hash_mismatch' })
  })

  it('reports a package that claims to be a different app', async () => {
    m.load = () => {
      throw new ManifestError(MANIFEST_REFUSAL.IDENTITY_MISMATCH, 'id mismatch', { field: 'id' })
    }

    renderWorkspace()

    expect(await refusalCode()).toBe('identity-mismatch')
    expect(screen.getByRole('heading', { name: /this package is not this app/i })).toBeInTheDocument()
  })

  it('reports an unreadable package separately from an unbindable one', async () => {
    m.load = () => {
      throw new ManifestError(MANIFEST_REFUSAL.UNKNOWN_SCHEMA, 'unknown schema', { field: 'schema' })
    }
    renderWorkspace()
    expect(await refusalCode()).toBe('package-invalid')
  })

  it('tells the member to update the platform when the package is too new', async () => {
    m.load = () => {
      throw new HostApiError(SUPPORTED_HOST_API + 1, SUPPORTED_HOST_API)
    }
    renderWorkspace()
    expect(await refusalCode()).toBe('host-api')
    expect(screen.getByRole('alert')).toHaveTextContent(/needs a newer version of the platform/i)
  })

  it('reports a gateway outage as availability, with a retry', async () => {
    m.load = () => {
      throw new GatewayUnavailableError('manifest.json', [{ gateway: G1, reason: 'network_error', status: null }])
    }

    renderWorkspace()

    expect(await refusalCode()).toBe('gateway')
    expect(screen.getByRole('alert')).toHaveTextContent(/every configured gateway is unreachable/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('says so when no gateway is configured at all', async () => {
    m.load = () => {
      throw new GatewayUnavailableError('manifest.json', [])
    }
    renderWorkspace()
    expect(await refusalCode()).toBe('gateway')
    expect(screen.getByRole('alert')).toHaveTextContent(/no app package gateway is configured/i)
  })

  it('offers no retry for a refusal retrying cannot fix', async () => {
    m.outcome = found(record({ status: AppStatus.SUSPENDED, launchable: false }))
    renderWorkspace()
    await refusalCode()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  it('re-runs the whole verification when the member retries', async () => {
    m.load = () => {
      throw new GatewayUnavailableError('manifest.json', [{ gateway: G1, reason: 'timeout', status: null }])
    }
    renderWorkspace()
    await refusalCode()

    m.load = () => loaded()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByText('token mint surface')).toBeInTheDocument()
    // The retry is a fresh launch read, not a replay of the previous decision.
    expect(fetchAppBySlug).toHaveBeenCalledTimes(2)
  })

  it('never puts a raw exception in front of the member', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    m.load = () => {
      throw new TypeError('cannot read properties of undefined (reading ‘secretInternals’)')
    }

    renderWorkspace()

    expect(await refusalCode()).toBe('unexpected')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/something went wrong while preparing this app/i)
    expect(alert.textContent).not.toMatch(/secretInternals/)
    // The detail is not lost — it goes where it can be diagnosed.
    expect(consoleError).toHaveBeenCalled()
  })
})

describe('a mini-app failure is contained (FR-015)', () => {
  it('keeps the host alive and offers a restart', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let shouldThrow = true
    const Flaky = () => {
      if (shouldThrow) throw new Error('mini-app blew up during render')
      return <p>recovered surface</p>
    }
    m.load = () => loaded({ component: Flaky })

    renderWorkspace()

    // The app's slot shows the failure; the workspace chrome around it survives.
    expect(await screen.findByRole('heading', { name: /this app stopped working/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: NAME })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: `${NAME} app` })).toBeInTheDocument()
    // The host records the crash; the app cannot decline to report it.
    expect(m.audit.log).toHaveLength(1)
    expect(m.audit.log[0][2]).toMatchObject({ appId: NAMESPACE, kind: 'host:app_crashed' })

    shouldThrow = false
    await userEvent.click(screen.getByRole('button', { name: /restart app/i }))

    // Remounted from the already-verified package — no second launch read.
    expect(await screen.findByText('recovered surface')).toBeInTheDocument()
    expect(fetchAppBySlug).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})

/**
 * NOTE ON THE NOISE THESE CASES PRODUCE. jsdom's CSSOM predates `@scope` (and
 * CSS nesting), so attaching any sheet using it logs "Could not parse CSS
 * stylesheet" through jsdom's own virtual console — not through `console.error`,
 * so no spy can quiet it. The element is still in the DOM with its text intact,
 * which is what these assertions read; only jsdom's ability to APPLY the rules
 * is missing, and nothing here depends on that.
 */
describe('package styles are confined to the workspace (FR-014/FR-016)', () => {
  it('scopes an injected stylesheet to the workspace root', async () => {
    m.load = () => loaded({ styles: [{ path: 'style.css', css: '.title { color: rebeccapurple }' }] })

    const { container } = renderWorkspace()
    await screen.findByText('token mint surface')

    const style = container.querySelector('style')
    const root = container.querySelector('[id^="miniapp-root-"]')
    expect(style).not.toBeNull()
    expect(style.textContent).toContain(`@scope (#${root.id})`)
    expect(style.textContent).toContain('rebeccapurple')
    // The style element lives inside the root it scopes, so leaving the
    // workspace takes the rules with it.
    expect(root.contains(style)).toBe(true)
  })

  it('drops a stylesheet that would break out of its scope', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A stray closing brace would end the `@scope` block early and let the rest
    // apply to the host's own chrome.
    m.load = () =>
      loaded({ styles: [{ path: 'style.css', css: '.title { color: red } } body { display: none }' }] })

    const { container } = renderWorkspace()
    await screen.findByText('token mint surface')

    expect(container.querySelector('style')).toBeNull()
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })

  it('keeps a brace inside a string or comment from reading as structure', async () => {
    m.load = () =>
      loaded({
        styles: [{ path: 'style.css', css: '/* } not a brace */ .t::after { content: "}" }' }],
      })

    const { container } = renderWorkspace()
    await screen.findByText('token mint surface')

    expect(container.querySelector('style')).not.toBeNull()
  })

  it('removes the app’s rules when the workspace unmounts', async () => {
    m.load = () => loaded({ styles: [{ path: 'style.css', css: '.title { color: red }' }] })

    const { container, unmount } = renderWorkspace()
    await screen.findByText('token mint surface')
    expect(container.querySelector('style')).not.toBeNull()

    unmount()
    expect(container.querySelector('style')).toBeNull()
  })
})

describe('accessibility (WCAG 2.1 AA)', () => {
  it('has no violations while an app is mounted', async () => {
    const { container } = renderWorkspace()
    await screen.findByText('token mint surface')
    expect(await axe(container)).toHaveNoViolations()
  })

  /**
   * T047 — a launch is a route change with a wait in the middle, and React Router moves focus for
   * neither half. Left alone, the member who pressed "Launch" is standing on `<body>` by the time
   * there is anything to read, and the polite "Verifying and loading…" region simply disappears:
   * a whole new surface arrives announced by nothing. Focus lands on the heading of whatever
   * settled instead — which announces it AND puts the member at the top of the surface rather
   * than the top of the host chrome.
   */
  describe('focus follows the launch', () => {
    it('lands on the app heading once the package is mounted', async () => {
      renderWorkspace()
      await screen.findByText('token mint surface')
      const heading = screen.getByRole('heading', { name: NAME })
      // `waitFor`, because focus ARRIVING is the claim and the instant it arrives is not.
      // `findByText` resolves on the commit that rendered the package; the focus move is a
      // separate effect gated on `launch.phase`, so the two are different moments. Asserting
      // synchronously here pinned an ordering that holds on an idle machine and does not hold
      // under a full 828-file run — it went red exactly once, in CI, on a commit that touches
      // nothing this file can reach. The sibling test below already makes the same claim this
      // way; this one was the outlier.
      await waitFor(() => expect(document.activeElement).toBe(heading))
      // Focusable as a target, never as a Tab stop.
      expect(heading).toHaveAttribute('tabindex', '-1')
    })

    it('lands on the refusal heading when the launch is refused', async () => {
      m.outcome = found(record({ status: AppStatus.SUSPENDED, launchable: false }))
      renderWorkspace()
      const heading = await screen.findByRole('heading', { name: /this app is suspended/i })
      await waitFor(() => expect(document.activeElement).toBe(heading))
    })

    it('follows a retry rather than leaving the member on the button it destroyed', async () => {
      // "Try again" re-keys the whole launch, so the button holding focus is unmounted by the
      // press that used it.
      m.outcome = { status: 'unreachable', chainId: CHAIN, registryAddress: REGISTRY, reason: 'read_failed' }
      renderWorkspace()
      await screen.findByRole('button', { name: /try again/i })

      m.outcome = found(record())
      await userEvent.click(screen.getByRole('button', { name: /try again/i }))

      await screen.findByText('token mint surface')
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: NAME }))
    })

    it('lands on the crash notice when the package throws under the member', async () => {
      // A crash the member CAUSED, which is the case the notice exists for: the control they
      // pressed goes down with the app, so without this they are left on <body>, a page-length
      // of Tab away from the restart control. (A package that throws on its very first render is
      // slightly different — the workspace's own ready-focus effect runs last in that commit and
      // wins, leaving focus on the app heading with the crash still announced by its `alert`.)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const Flaky = () => {
        const [boom, setBoom] = useState(false)
        if (boom) throw new Error('mini-app blew up during render')
        return (
          <button type="button" onClick={() => setBoom(true)}>
            break the app
          </button>
        )
      }
      m.load = () => loaded({ component: Flaky })

      renderWorkspace()
      await userEvent.click(await screen.findByRole('button', { name: 'break the app' }))

      const heading = await screen.findByRole('heading', { name: /this app stopped working/i })
      await waitFor(() => expect(document.activeElement).toBe(heading))
      consoleError.mockRestore()
    })
  })

  it('has no violations on a refusal, and announces it', async () => {
    m.outcome = found(record({ status: AppStatus.SUSPENDED, launchable: false }))
    const { container } = renderWorkspace()
    // `role="alert"` so the refusal reaches a screen-reader user who was
    // waiting for the app rather than reading the page.
    await screen.findByRole('alert')
    expect(await axe(container)).toHaveNoViolations()
  })
})

/**
 * The identity gap, closed end to end.
 *
 * These two cases drive the REAL loader (its network and module-loader seams
 * injected) with the options the workspace itself chose, so what is proven is
 * not "the workspace passes a string" but "the string the workspace passes makes
 * the manifest-id check refuse a package that is not this app".
 */
describe('the manifest-id check actually fires', () => {
  const utf8 = (text) => Uint8Array.from(new TextEncoder().encode(text))
  const ENTRY = 'export default function App() { return null }\n'

  /** Build a package exactly as `tools/miniapp-build/` would. */
  function buildPackage(manifestId) {
    const entryBytes = utf8(ENTRY)
    const manifest = {
      schema: MANIFEST_SCHEMA,
      id: manifestId,
      name: NAME,
      version: '3.1.0',
      entry: 'entry.js',
      styles: [],
      hostApi: SUPPORTED_HOST_API,
      sharedDeps: ['react'],
      permissions: ['toast'],
      storeKeys: [],
      files: { 'entry.js': { sha256: sha256Hex(entryBytes) } },
    }
    const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`)
    return {
      manifestHash: keccak256(manifestBytes),
      files: { 'manifest.json': manifestBytes, 'entry.js': entryBytes },
    }
  }

  /** Serve one package from one gateway; anything else 404s. */
  function serve(pkg) {
    return vi.fn(async (url) => {
      const path = String(url).split(`${CID}/`)[1]
      const bytes = pkg.files[path]
      if (!bytes) return { ok: false, status: 404, headers: { get: () => null } }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(bytes.byteLength) : null) },
        arrayBuffer: async () => bytes.slice().buffer,
      }
    })
  }

  /** Run the real loader with the workspace's own options plus injected seams. */
  function driveRealLoader(pkg, importImpl) {
    m.load = (rec, options, real) =>
      real(rec, {
        ...options,
        gateways: [G1],
        fetchImpl: serve(pkg),
        importImpl,
        createObjectURL: () => 'blob:miniapp-test',
        revokeObjectURL: () => {},
      })
  }

  it('mounts a package whose manifest id is this app', async () => {
    const pkg = buildPackage(SLUG)
    m.outcome = found(record({ manifestHash: pkg.manifestHash }))
    driveRealLoader(pkg, async () => ({ default: () => <p>bound surface</p> }))

    renderWorkspace()

    expect(await screen.findByText('bound surface')).toBeInTheDocument()
  })

  it('REFUSES a package that identifies itself as a different app', async () => {
    // Two listings shipping the same manifest id used to be indistinguishable —
    // and would have shared one store namespace and one audit attribution.
    const pkg = buildPackage('some-other-app')
    m.outcome = found(record({ manifestHash: pkg.manifestHash }))
    const importImpl = vi.fn(async () => ({ default: () => <p>impostor surface</p> }))
    driveRealLoader(pkg, importImpl)

    renderWorkspace()

    expect(await refusalCode()).toBe('identity-mismatch')
    // The security property: the impostor's bytes were never executed.
    expect(importImpl).not.toHaveBeenCalled()
    expect(screen.queryByText('impostor surface')).not.toBeInTheDocument()
  })
})
