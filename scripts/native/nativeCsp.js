/**
 * Native CSP derivation (spec 102, research R7).
 *
 * The native builds serve bundled assets, so their CSP rides a <meta> tag in
 * the built index.html rather than an nginx header. To keep the two channels
 * from drifting, the native policy is DERIVED from the web policy in
 * frontend/nginx.conf — parsed, transformed by the explicit rules below, and
 * re-serialized. There is no second hand-written policy to fall out of sync;
 * `frontend/src/test/native/nativeCspParity.test.js` gates the transform's
 * invariants (script-src keeps `blob:` for verified mini-app bytes and NEVER
 * gains `https:`; connect-src keeps the spec-069 scheme + loopback grants).
 *
 * Transform rules (all of them):
 *  1. Directives a <meta> CSP cannot express (frame-ancestors, report-uri,
 *     report-to, sandbox) are dropped — listed explicitly so a future addition
 *     to the nginx policy fails the parity gate instead of silently vanishing.
 *  2. Everything else is carried VERBATIM. 'self' resolves to the app's local
 *     origin in the WebView, which is exactly the bundled-asset origin.
 */
const META_UNSUPPORTED = ["frame-ancestors", "report-uri", "report-to", "sandbox"];

/** Extract the CSP value from an nginx config's add_header line. */
function parseNginxCsp(nginxConfContent) {
  const match = /add_header\s+Content-Security-Policy\s+"([^"]+)"/.exec(nginxConfContent);
  if (!match) throw new Error("No Content-Security-Policy add_header found in nginx config");
  return match[1];
}

/** Policy string -> Map(directive -> source list string). Order-preserving. */
function parsePolicy(policy) {
  const directives = new Map();
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/\s+/);
    directives.set(name, sources.join(" "));
  }
  return directives;
}

/** Derive the native <meta> policy from the web policy. */
function buildNativePolicy(webPolicy) {
  const directives = parsePolicy(webPolicy);
  for (const name of META_UNSUPPORTED) directives.delete(name);
  return Array.from(directives.entries())
    .map(([name, sources]) => (sources ? `${name} ${sources}` : name))
    .join("; ");
}

const META_TAG_RE = /<meta http-equiv="Content-Security-Policy"[^>]*>/;

/** Inject (or replace) the CSP meta tag in a built index.html. Idempotent. */
function injectMetaCsp(indexHtml, policy) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (META_TAG_RE.test(indexHtml)) return indexHtml.replace(META_TAG_RE, tag);
  const headOpen = /<head[^>]*>/.exec(indexHtml);
  if (!headOpen) throw new Error("index.html has no <head> to carry the CSP meta tag");
  const at = headOpen.index + headOpen[0].length;
  return `${indexHtml.slice(0, at)}\n    ${tag}${indexHtml.slice(at)}`;
}

module.exports = { META_UNSUPPORTED, parseNginxCsp, parsePolicy, buildNativePolicy, injectMetaCsp };
