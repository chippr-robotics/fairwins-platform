#!/usr/bin/env node
/**
 * IaC guardrail gate (spec 087, contracts/guardrails.md).
 *
 * WHY THIS EXISTS
 * Generic Terraform linters do not know the three facts that make this estate dangerous:
 *
 *   1. `chippr-bots-site-wp` is SHARED. It hosts a public WordPress VM plus clearpath-*,
 *      fukuii-* and kings-edge-*. `google_project_iam_binding` is one word away from the safe
 *      `google_project_iam_member` and is authoritative for its role PROJECT-WIDE — it silently
 *      strips that role from every other principal. The resulting plan diff looks small and
 *      ordinary, and under automatic apply nobody has to click anything for it to happen.
 *   2. Some resources are UNRECOVERABLE: KMS key versions, secret payloads, and the static IPs
 *      pinned in Cloudflare DNS.
 *   3. One service must stay DECOMMISSIONED. Re-declaring the Cloud Run alto bundler puts two
 *      executors on one EOA — colliding nonces, stuck bundles, both instances reporting healthy,
 *      and no in-band detection.
 *
 * This gate is ONE OF TWO LAYERS. The other is the CI service account not holding the permissions
 * (specs/087-infrastructure-as-code/contracts/ci-identity.md), which is what still holds when this
 * gate is bypassed or wrong. Neither layer is sufficient alone.
 *
 * HCL is scanned textually with brace-aware block extraction rather than a real parser, so the gate
 * runs anywhere Node runs — no Terraform binary, no provider download, no network. That is a
 * deliberate trade: it can be fooled by sufficiently strange formatting, and it is checked in CI
 * alongside `terraform validate`, which catches what a text scan cannot.
 *
 * Usage:
 *   node scripts/infra/check-iac-guardrails.js [--root <dir>] [--json]
 *
 * Exit code 0 = pass, 1 = at least one violation. Warnings never fail the build on their own.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

// ── configuration ──────────────────────────────────────────────────────────────────────────────

/** Resources whose destruction or replacement is unrecoverable, or breaks public DNS. */
const PROTECTED_TYPES = new Set([
  "google_kms_key_ring",
  "google_kms_crypto_key",
  "google_secret_manager_secret",
  "google_compute_address",
  "google_storage_bucket",
  "google_artifact_registry_repository",
]);

/** Cloud Run service types whose artifact is owned by the build pipeline, not Terraform. */
const CLOUD_RUN_TYPES = new Set(["google_cloud_run_v2_service", "google_cloud_run_service"]);

/**
 * The exact ignore_changes entries a Cloud Run service must carry (G-07). Without these, every
 * pipeline image deploy reports as drift, which trains reviewers to ignore drift reports — and a
 * drift report nobody reads is worse than none, because it is cited as evidence.
 */
const REQUIRED_CLOUD_RUN_IGNORES = [
  "template[0].containers[0].image",
  "template[0].revision",
  "client",
  "client_version",
];

/**
 * G-10 works as an ALLOW-LIST, not a deny-list.
 *
 * It used to enumerate other people's workloads (`clearpath-`, `fukuii-`, `kings-edge-`) and reject
 * references to them. That is unbounded and was already incomplete: the shared project also hosts
 * the company website, and any future workload would be missed by construction. A deny-list of other
 * people's things can only ever be as current as the last person who remembered to update it.
 *
 * So the rule is inverted. Every literal resource NAME must match something this repository owns.
 * An unrecognised name fails — which is the correct default in a shared project, and means a new
 * FairWins resource has to be declared here deliberately rather than a foreign one slipping through.
 */
const OWNED_NAME_PATTERNS = [
  /^fairwins[-_]/, // VPC, subnet, IPs, firewall rules, VMs, service accounts
  /^prediction-dao-research$/, // the production SPA service
  /^staging(-testnet)?$/, // the two staging cohort services
  /^cloud-run-source-deploy$/, // the Artifact Registry repository
  /^origin-lock-secret$/,
  /^alto-executor-key-137$/,
  /^relay-(webhook-secret|engine-api-key)$/,
  /^POLYMARKET_/, // gateway feature credentials, named in their upstream's convention
  /^QUICKNODE_(POLYGON|AMOY)_(API|WSS)$/, // QuickNode Multi-Chain RPC credentials (one token, chain by hostname infix)
  // The numbered MULTICHAIN endpoint family (001=eth, 002=matic, 003=sol, 004=btc, 005=zec — the
  // scheme is documented on managed_secret_ids in prod's terraform.tfvars) plus the account admin
  // key. Bounded to three digits deliberately: a new endpoint number extends the estate, and this
  // gate's job is to make that a decision here rather than a foreign name slipping through.
  /^QUICKNODE_(ADMIN_API|RPC_\d{3}_(API|WSS))$/,
  /^github-actions$/, // the WIF pool
];

/**
 * Attributes carrying a resource's real name. These are what get compared against the allow-list;
 * an interpolated or variable-driven value is skipped, because it is not a literal claim about
 * which resource is being touched.
 */
const NAME_ATTRIBUTES = ["name", "secret_id", "repository_id", "account_id", "workload_identity_pool_id"];

/** Known-foreign prefixes. Retained ONLY to give a clearer message than "unrecognised name". */
const FOREIGN_MARKERS = ["clearpath-", "fukuii-", "kings-edge-", "default-allow-"];

/** The service that must stay decommissioned (G-11). */
const DECOMMISSIONED_SERVICES = ["fairwins-alto-bundler"];

/** Literals that must not be hardcoded inside a module body (G-08). */
const ENVIRONMENT_LITERALS = ["chippr-bots-site-wp", "us-central1-a", "us-central1"];

/** Roots permitted to run without a remote backend (G-12). */
const LOCAL_STATE_ALLOWED = new Set(["bootstrap"]);

// ── HCL scanning ───────────────────────────────────────────────────────────────────────────────

/**
 * Strip comments while preserving string contents and line numbering.
 *
 * Comment characters inside a quoted string are not comments — a naive `line.split("#")[0]` would
 * mangle `description = "uses # as a separator"` and, worse, could hide a violation behind one.
 * Replaced text becomes spaces so every reported line number still matches the source file.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let inString = false;
  let inBlockComment = false;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (inBlockComment) {
      if (c === "*" && next === "/") {
        out += "  ";
        i += 2;
        inBlockComment = false;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (inString) {
      out += c;
      if (c === "\\") {
        out += next === undefined ? "" : next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      inBlockComment = true;
      continue;
    }
    if (c === "#" || (c === "/" && next === "/")) {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/** Line number (1-indexed) of a character offset. */
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

/**
 * Extract top-level blocks with their bodies by brace matching.
 *
 * Returns `{ kind, labels, body, line }` — e.g. kind "resource", labels
 * ["google_compute_address", "gateway"]. Braces inside strings are skipped so a value containing
 * `{` cannot end a block early.
 */
function extractBlocks(stripped) {
  const blocks = [];
  const header = /(^|\n)\s*([a-zA-Z_][a-zA-Z0-9_]*)((?:\s+"[^"]*")*)\s*\{/g;
  let m;

  while ((m = header.exec(stripped)) !== null) {
    const kind = m[2];
    const labels = (m[3].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1));
    const openIdx = stripped.indexOf("{", m.index + m[0].length - 1);
    let depth = 0;
    let i = openIdx;
    let inString = false;

    for (; i < stripped.length; i += 1) {
      const c = stripped[i];
      if (inString) {
        if (c === "\\") i += 1;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    blocks.push({
      kind,
      labels,
      body: stripped.slice(openIdx + 1, i),
      line: lineAt(stripped, m.index + (m[1] ? m[1].length : 0)),
    });
    header.lastIndex = m.index + m[0].length;
  }
  return blocks;
}

/** Find a nested block by name inside a body (e.g. "lifecycle"). Returns its body or null. */
function nestedBlock(body, name) {
  const found = extractBlocks(`\n${body}`).find((b) => b.kind === name && b.labels.length === 0);
  return found ? found.body : null;
}

/** Read an `attr = value` scalar from a body. Returns the raw right-hand side, trimmed. */
function attr(body, name) {
  const re = new RegExp(`(^|\\n)\\s*${name}\\s*=\\s*([^\\n]*)`);
  const m = body.match(re);
  return m ? m[2].trim() : null;
}

// ── file walking ───────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", ".terraform", "__fixtures__"]);

function walk(dir, filter, acc = [], allowFixtures = false) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) && !(allowFixtures && entry.name === "__fixtures__")) continue;
      walk(path.join(dir, entry.name), filter, acc, allowFixtures);
    } else if (filter(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const isTf = (n) => n.endsWith(".tf");
const isShellOrWorkflow = (n) => n.endsWith(".sh") || n.endsWith(".yml") || n.endsWith(".yaml");

// ── the gate ───────────────────────────────────────────────────────────────────────────────────

/**
 * Run every rule against a directory tree.
 *
 * @param {string} tfRoot Terraform tree to scan.
 * @param {string[]} scriptRoots Trees scanned for shell/workflow rules (G-14, G-15).
 * @param {{includeFixtures?: boolean}} opts Walk __fixtures__ too. Only the test suite sets this —
 *        a default run must never scan the gate's own deliberately-violating fixtures.
 * @returns {{violations: object[], warnings: object[]}}
 */
function check(tfRoot, scriptRoots, { includeFixtures = false } = {}) {
  const violations = [];
  const warnings = [];
  const rel = (f) => path.relative(ROOT, f) || f;
  const fail = (rule, file, line, message) => violations.push({ rule, file: rel(file), line, message });
  const warn = (rule, file, line, message) => warnings.push({ rule, file: rel(file), line, message });

  const tfFiles = walk(tfRoot, isTf, [], includeFixtures);

  for (const file of tfFiles) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    const blocks = extractBlocks(src);
    const posix = file.split(path.sep).join("/");
    const inModule = posix.includes("/modules/");

    for (const block of blocks) {
      const [type, name] = block.labels;

      if (block.kind === "provider" && inModule) {
        fail(
          "G-09",
          file,
          block.line,
          "provider block inside a module: blocks for_each/count and cannot be cleanly versioned"
        );
      }

      if (block.kind !== "resource" || !type) continue;

      if (/_iam_policy$/.test(type)) {
        fail(
          "G-01",
          file,
          block.line,
          `${type} is AUTHORITATIVE for the entire policy on its target — it removes every grant not declared here, including other workloads' and the owners' own. Use ${type.replace(/_iam_policy$/, "_iam_member")}.`
        );
      }
      if (/_iam_binding$/.test(type)) {
        fail(
          "G-02",
          file,
          block.line,
          `${type} is AUTHORITATIVE for that role on its target — it strips the role from every principal outside this repo. Use ${type.replace(/_iam_binding$/, "_iam_member")}.`
        );
      }
      if (type === "google_project") {
        fail("G-03", file, block.line, "the project is an input (var.project_id), never a managed resource");
      }
      if (type === "google_secret_manager_secret_version") {
        fail(
          "G-04",
          file,
          block.line,
          "a secret version resource writes the payload into state in plaintext (FR-014/FR-015). Manage the container and its access bindings only."
        );
      }
      if (type === "google_project_service") {
        for (const a of ["disable_on_destroy", "disable_dependent_services"]) {
          if (attr(block.body, a) !== "false") {
            fail(
              "G-05",
              file,
              block.line,
              `google_project_service must set ${a} = false — the enabled API set is shared, and removing this block would otherwise disable the API for every other workload in the project`
            );
          }
        }
      }
      if (PROTECTED_TYPES.has(type)) {
        const lifecycle = nestedBlock(block.body, "lifecycle");
        if (!lifecycle || attr(lifecycle, "prevent_destroy") !== "true") {
          fail(
            "G-06",
            file,
            block.line,
            `${type}.${name} is unrecoverable or DNS-pinned and must carry lifecycle { prevent_destroy = true }`
          );
        }
      }
      if (CLOUD_RUN_TYPES.has(type)) {
        const lifecycle = nestedBlock(block.body, "lifecycle") || "";
        const missing = REQUIRED_CLOUD_RUN_IGNORES.filter((k) => !lifecycle.includes(k));
        if (missing.length) {
          fail(
            "G-07",
            file,
            block.line,
            `Cloud Run service must ignore pipeline-owned attributes; missing from ignore_changes: ${missing.join(", ")}. Without them every image deploy reports as drift.`
          );
        }
        const serviceName = attr(block.body, "name") || "";
        for (const dead of DECOMMISSIONED_SERVICES) {
          if (serviceName.includes(dead)) {
            fail(
              "G-11",
              file,
              block.line,
              `${dead} must stay decommissioned — a second bundler against the VM bundler's EOA means colliding nonces and stuck bundles, with both instances reporting healthy and no in-band detection`
            );
          }
        }
      }

      for (const marker of FOREIGN_MARKERS) {
        if (block.body.includes(marker)) {
          fail(
            "G-10",
            file,
            block.line,
            `references "${marker}" — a workload this project does not own (FR-003)`
          );
        }
      }

      // Allow-list check, GCP resources only. The shared-project hazard is specific to
      // `chippr-bots-site-wp`: Cloudflare is scoped by zone id and a zone-scoped token, a different
      // boundary, and its `name` fields are human-readable rule labels rather than identifiers.
      //
      // Only literal values are judged: an interpolated or variable-driven name is not a claim about
      // which specific resource is being touched.
      const gcpResource = type.startsWith("google_");
      for (const key of gcpResource ? NAME_ATTRIBUTES : []) {
        const raw = attr(block.body, key);
        if (!raw) continue;
        const literal = raw.match(/^"([^"$]*)"$/);
        if (!literal) continue;
        const value = literal[1];
        if (!OWNED_NAME_PATTERNS.some((re) => re.test(value))) {
          fail(
            "G-10",
            file,
            block.line,
            `${type}.${name} declares ${key} = "${value}", which is not a name this repository owns. The GCP project is SHARED — an unrecognised name is rejected by default. If this really is ours, add it to OWNED_NAME_PATTERNS with a comment saying what it is.`
          );
        }
      }
    }

    if (inModule) {
      const lines = src.split("\n");
      lines.forEach((text, idx) => {
        for (const literal of ENVIRONMENT_LITERALS) {
          if (text.includes(`"${literal}"`) || text.includes(`"${literal}-`)) {
            fail(
              "G-08",
              file,
              idx + 1,
              `hardcoded "${literal}" inside a module — every environment-specific value must be an input, or extraction to chippr-tf-modules becomes a rewrite`
            );
            break;
          }
        }
      });
    }

    // Data-source uses of secret versions are permitted and counted, so the one accepted exception
    // (the origin-lock header value) stays visible rather than becoming a habit.
    for (const block of blocks) {
      if (block.kind === "data" && block.labels[0] === "google_secret_manager_secret_version") {
        warn(
          "G-04",
          file,
          block.line,
          "secret value read via data source — permitted, but data-source results ARE written to state (sensitive=true hides a value from output, not from state). Keep this countable."
        );
      }
    }
  }

  // G-16: a module source resolving outside this repository must be pinned to an immutable ref.
  // Unpinned, or pinned to a branch, makes a plan a function of when someone last ran `init` — the
  // deployed infrastructure then depends on timing rather than on the commit under review.
  for (const file of tfFiles) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const block of extractBlocks(src)) {
      if (block.kind !== "module") continue;
      const raw = attr(block.body, "source");
      if (!raw) continue;
      const literal = raw.match(/^"([^"]*)"$/);
      if (!literal) continue;
      const source = literal[1];

      // A relative path resolves within this repository, so the commit pins it already.
      if (source.startsWith("./") || source.startsWith("../")) continue;

      const ref = source.match(/[?&]ref=([^&]+)$/);
      if (!ref) {
        fail(
          "G-16",
          file,
          block.line,
          `module "${block.labels[0]}" has an external source with no ?ref= pin. Without one, the plan depends on when \`terraform init\` last ran rather than on the commit under review.`
        );
        continue;
      }
      const value = ref[1];
      const immutable = /^[0-9a-f]{40}$/.test(value) || /^v\d+\.\d+\.\d+$/.test(value);
      if (!immutable) {
        fail(
          "G-16",
          file,
          block.line,
          `module "${block.labels[0]}" is pinned to "${value}", which is not immutable. Use a 40-character commit SHA (strictest — a tag can be moved, a SHA cannot) or a semver tag.`
        );
      }
    }
  }

  // G-12 / G-13: every root directory (one holding a `terraform {}` block) needs a remote backend
  // and a committed provider lockfile.
  // A ROOT is a directory Terraform is run from. Modules also carry a `terraform` block (they must
  // declare required_providers), so the presence of one is not enough to identify a root — a module
  // directory has no backend and needs none.
  const rootDirs = new Set(
    tfFiles
      .filter((f) => !f.split(path.sep).join("/").includes("/modules/"))
      .filter((f) => {
        const src = stripComments(fs.readFileSync(f, "utf8"));
        return extractBlocks(src).some((b) => b.kind === "terraform");
      })
      .map((f) => path.dirname(f))
  );
  for (const dir of rootDirs) {
    const dirName = path.basename(dir);
    const bodies = fs
      .readdirSync(dir)
      .filter(isTf)
      .map((n) => stripComments(fs.readFileSync(path.join(dir, n), "utf8")))
      .join("\n");
    const hasBackend = /backend\s+"gcs"/.test(bodies);

    if (!hasBackend && !LOCAL_STATE_ALLOWED.has(dirName)) {
      fail("G-12", path.join(dir, "backend.tf"), 1, `root "${dirName}" has no backend "gcs" block — state would live on a laptop, or be shared across environments`);
    }
    if (hasBackend && !fs.existsSync(path.join(dir, ".terraform.lock.hcl"))) {
      fail(
        "G-13",
        path.join(dir, ".terraform.lock.hcl"),
        1,
        `root "${dirName}" has no committed .terraform.lock.hcl — the same commit would resolve to different provider versions on different machines`
      );
    }
  }

  // G-14 / G-15: shell scripts and workflows.
  for (const scriptRoot of scriptRoots) {
    for (const file of walk(scriptRoot, isShellOrWorkflow, [], includeFixtures)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      let uploadsPlan = false;
      let retention = null;

      lines.forEach((text, idx) => {
        const code = text.replace(/#.*$/, "");
        if (/\bterraform\b[^\n]*\s-target[=\s]/.test(code)) {
          fail(
            "G-14",
            file,
            idx + 1,
            "-target applies a subgraph without refreshing the rest, so recorded state stops describing reality — the exact failure this feature prevents. It is a recovery tool, not a workflow."
          );
        }
        if (/\.tfplan\b/.test(code) && /path:/.test(code)) uploadsPlan = true;
        if (/retention-days:\s*(\d+)/.test(code)) retention = Number(RegExp.$1);
        if (/\.tfplan\b/.test(code) && /(gh\s+pr\s+comment|createComment|comment-body)/.test(code)) {
          fail(
            "G-15",
            file,
            idx + 1,
            "a raw plan file must never be posted as a comment — it embeds prior state values. Post a redacted summary generated from `terraform show -json`."
          );
        }
      });

      if (uploadsPlan && (retention === null || retention > 7)) {
        fail(
          "G-15",
          file,
          1,
          "a plan artifact must set retention-days <= 7 — plan files embed prior state values and must not linger as long-lived artifacts"
        );
      }
    }
  }

  return { violations, warnings };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const tfRoot = rootFlag !== -1 ? path.resolve(argv[rootFlag + 1]) : path.join(ROOT, "infra", "terraform");
  const scriptRoots =
    rootFlag !== -1
      ? [tfRoot]
      : [path.join(ROOT, ".github", "workflows"), path.join(ROOT, "scripts", "infra"), path.join(ROOT, "infra")];

  // Fixtures are scanned only when a --root is given explicitly, i.e. by the test suite. A default
  // run that walked them would report the gate's own deliberate violations as real ones.
  const { violations, warnings } = check(tfRoot, scriptRoots, { includeFixtures: rootFlag !== -1 });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ violations, warnings }, null, 2)}\n`);
  } else {
    for (const w of warnings) console.warn(`  warn  ${w.rule}  ${w.file}:${w.line}  ${w.message}`);
    if (violations.length === 0) {
      console.log(`IaC guardrails: PASS (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
    } else {
      console.error(`\nIaC guardrails: ${violations.length} violation(s)\n`);
      for (const v of violations) console.error(`  ${v.rule}  ${v.file}:${v.line}\n        ${v.message}\n`);
      console.error("See specs/087-infrastructure-as-code/contracts/guardrails.md for each rule's rationale.\n");
    }
  }
  return violations.length === 0 ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, stripComments, extractBlocks, nestedBlock, attr };
