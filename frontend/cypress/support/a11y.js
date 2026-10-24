// =============================================================================
// Accessibility scanning (spec 094, FR-021..FR-023)
//
// Runs the ALREADY-INSTALLED axe-core against the surface on screen. No cypress-axe: that package
// is a thin wrapper over what is below, and adding it means touching the lockfile — which in this
// repo has a measured failure mode (spec 075: an incremental install silently dropping the
// platform binary every Vite build needs, from node_modules AND the lockfile).
//
// axe-core is a devDependency already present for vitest-axe's component checks, so the ruleset
// version is pinned and in the tree. It is INJECTED by the runner and must never be imported by
// frontend/src — frontend/src/test/e2e-policy/harnessBoundary.test.js asserts that.
// =============================================================================

/** Impacts that fail the build. Where WCAG 2.1 AA lands in axe's taxonomy, and where the signal
 *  stays usable — moderate/minor are logged instead. */
const BLOCKING_IMPACTS = ['serious', 'critical']

/** Inject axe into the application window. Idempotent within a page load. */
function injectAxe() {
  return cy.window({ log: false }).then((win) => {
    if (win.axe) return
    return cy.task('axeSource', null, { log: false }).then((source) => {
      if (!source) {
        // Never silently skip: an accessibility check that did nothing is a green gate over an
        // absent test, which is the defect this whole feature exists to remove.
        throw new Error('a11yScan: could not load axe-core source via the `axeSource` task')
      }
      win.eval(source)
      if (!win.axe) throw new Error('a11yScan: axe-core did not install itself on the app window')
    })
  })
}

function formatViolations(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `      - ${n.target.join(' ')}`).join('\n')
      return `  [${v.impact}] ${v.id} — ${v.help}\n    ${v.helpUrl}\n${nodes}`
    })
    .join('\n\n')
}

/**
 * cy.a11yScan({ context, rules, disableRules })
 *
 * `context` scopes the scan. Pass the modal root when a modal is open: the app portals its modals,
 * so a document-wide scan reports the page BEHIND the modal and attributes those violations to the
 * modal under test — the same defect as an unscoped `cy.contains`.
 *
 * `disableRules` entries MUST name the issue tracking them: [{ rule: 'color-contrast', issue: '#1019' }].
 * Suppressions without an owner become permanent; naming one keeps them countable.
 */
Cypress.Commands.add('a11yScan', (options = {}) => {
  const { context = null, disableRules = [], runOnly = null, label = null } = options

  for (const entry of disableRules) {
    if (!entry || !entry.rule || !/^#\d+$/.test(entry.issue || '')) {
      throw new Error(
        `a11yScan: every disableRules entry needs a rule and a tracking issue, e.g. ` +
          `{ rule: 'color-contrast', issue: '#1019' }. Got: ${JSON.stringify(entry)}`
      )
    }
  }

  return injectAxe().then(() =>
    cy.window({ log: false }).then((win) => {
      /*
       * SETTLE FINITE ANIMATIONS FIRST. Surfaces animate in (e.g. the
       * dashboard's 400ms fadeInUp runs opacity 0→1), and axe computes text
       * color AS RENDERED — a scan that lands mid-fade sees semi-transparent
       * text blended toward the background and reports a color-contrast
       * violation that no member ever sees for more than a frame. That was
       * the phone-profile "wagers dashboard" flake on #1388: identical CSS,
       * verdict decided by scan timing. Infinite animations (loading pulses)
       * are skipped — their `finished` promise never resolves, and an
       * element that permanently blinks below contrast is a REAL finding the
       * scan must keep catching.
       */
      const settling = win.document.getAnimations
        ? Promise.all(
            win.document.getAnimations()
              .filter((a) => {
                const timing = a.effect?.getTiming?.()
                return timing && timing.iterations !== Infinity
              })
              .map((a) => a.finished.catch(() => {}))
          )
        : Promise.resolve()

      const axeOptions = {
        resultTypes: ['violations'],
        rules: Object.fromEntries(disableRules.map((d) => [d.rule, { enabled: false }])),
      }
      if (runOnly) axeOptions.runOnly = runOnly

      const target = context || win.document
      const run = settling.then(() => win.axe.run(target, axeOptions))
      return cy.wrap(run, { log: false, timeout: 30000 }).then((results) => {
        const where = label || (typeof context === 'string' ? context : 'document')
        const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.includes(v.impact))
        const advisory = results.violations.filter((v) => !BLOCKING_IMPACTS.includes(v.impact))

        /*
         * `Cypress.log`, NOT `cy.log`. `cy.log` enqueues a command, and a `.then()` callback that
         * invokes a cy command and then returns a value is the "mixing async and sync code" error —
         * which is exactly how this command failed on its first CI run, in all four of its own
         * tests. The distinction is invisible until it isn't.
         */
        if (advisory.length) {
          Cypress.log({
            name: 'a11y',
            message: `${where}: ${advisory.length} moderate/minor violation(s) — not blocking`,
          })
          console.log(`a11y advisory for ${where}:\n${formatViolations(advisory)}`)
        }
        if (disableRules.length) {
          Cypress.log({
            name: 'a11y',
            message: `${where}: suppressed ${disableRules.map((d) => `${d.rule} (${d.issue})`).join(', ')}`,
          })
        }

        expect(
          blocking,
          `${blocking.length} serious/critical accessibility violation(s) in ${where}:\n\n${formatViolations(blocking)}\n`
        ).to.have.length(0)

        return results
      })
    })
  )
})
