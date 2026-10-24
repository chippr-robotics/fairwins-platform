/**
 * Staging environment (spec 087, and spec 076 FR-023/FR-026).
 *
 * TWO SERVICES FROM ONE COMMIT, and that is the design rather than an accident of convenience.
 * Vite folds VITE_NETWORK_ID into the bundle at build time, so ONE IMAGE RESOLVES EXACTLY ONE
 * cohort. Reaching every cohort therefore means two images and two services — not one service with
 * a runtime cohort switch, which would put a testnet/mainnet seam into code that also ships to
 * production and would make constitution III's boundary a runtime value instead of a build-time
 * fact.
 *
 *   staging          mainnet cohort (Polygon 137)  — the promotion mirror, what main will run next
 *   staging-testnet  testnet cohort (Amoy 80002)   — safe rehearsal, no real funds
 *
 * ⚠ THE MAINNET STAGING SERVICE TOUCHES REAL FUNDS. It has its own funded accounts, gas wallet,
 * paymaster deposit and origin-lock secret, and holds NO admin or deployer key — but the
 * transactions it sends are real.
 *
 * Staging has NO nodes, NO VPC and NO edge configuration: the long-running gasless nodes exist once,
 * in prod. State is a separate prefix, so a staging apply cannot reach prod state at all.
 */

module "staging_mainnet" {
  count = var.manage_staging_services ? 1 : 0

  source = "git::https://github.com/chippr-robotics/chippr-tf-modules.git//modules/cloud-run-service?ref=838c250b6dc8542fd0730b12ec7050462387bc53"

  project_id = var.project_id
  region     = var.region
  # The LIVE service is `prediction-dao-research-staging`. This read `"staging"`, and the module
  # passes `name` through verbatim — so the plan was not adopting the staging service, it was
  # proposing a SECOND, public, unmanaged one beside it. That apply would have SUCCEEDED.
  name = "prediction-dao-research-staging"

  # A static bundle needs no GCP access, so it runs as an account that HAS none. This is not
  # hardening for its own sake: managing the service at all requires `actAs` on whatever runtime
  # account it uses, and the alternative — the Cloud Run default compute account — carries
  # roles/editor project-wide in a shared project. See the variable, and bootstrap/main.tf.
  service_account_email = var.run_noperm_service_account

  # Required by the provider, then ignored — Cloud Build owns the artifact.
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repository}/prediction-dao-research/staging:latest"

  min_instances = 0
  max_instances = var.staging_max_instances

  # Read off the LIVE service, not chosen here: gcloud turned startup CPU boost on at deploy time.
  # The module could not express it until chippr-tf-modules ce0ed29, and a module that cannot
  # express a setting does not preserve it on import — it resets it to the provider default.
  # Stating it is what makes this an adoption rather than a quiet reconfiguration.
  startup_cpu_boost     = true
  cpu                   = "1"
  memory                = "512Mi"
  cpu_idle              = true
  allow_unauthenticated = true

  secret_env = var.staging_secret_env
}

module "staging_testnet" {
  count = var.manage_staging_services ? 1 : 0

  source = "git::https://github.com/chippr-robotics/chippr-tf-modules.git//modules/cloud-run-service?ref=838c250b6dc8542fd0730b12ec7050462387bc53"

  project_id = var.project_id
  region     = var.region
  name       = "prediction-dao-research-staging-testnet"

  # Same reasoning as the mainnet service above.
  service_account_email = var.run_noperm_service_account

  image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repository}/prediction-dao-research/staging-testnet:latest"

  min_instances = 0
  max_instances = var.staging_max_instances

  # Read off the LIVE service, not chosen here: gcloud turned startup CPU boost on at deploy time.
  # The module could not express it until chippr-tf-modules ce0ed29, and a module that cannot
  # express a setting does not preserve it on import — it resets it to the provider default.
  # Stating it is what makes this an adoption rather than a quiet reconfiguration.
  startup_cpu_boost     = true
  cpu                   = "1"
  memory                = "512Mi"
  cpu_idle              = true
  allow_unauthenticated = true

  secret_env = var.staging_testnet_secret_env
}

/**
 * MCP server, staging (spec 095).
 *
 * ⚠ OFF UNTIL THE IMAGE EXISTS — `manage_mcp_server` defaults to false and terraform.tfvars states
 * it. Nothing in this repository publishes `fairwins-mcp-server-staging` either:
 * cloudbuild.staging.yaml builds the two SPA cohort images and nothing else, and
 * container-build.yml's MCP job tags a local `:ci` image it never pushes. Ungated, a merge to main
 * would have this environment's unattended apply try to create a Cloud Run service from an image
 * that is not in the registry. See the module comment in environments/prod/main.tf for the full
 * reasoning and the ungate order.
 *
 * ONE SERVICE, NOT TWO, and the reason is the same reason the SPA needs two. The cohort split above
 * exists because Vite folds VITE_NETWORK_ID into the bundle: the cohort is a build-time fact there.
 * This service folds nothing — it reads its upstream from `FAIRWINS_API_URL` at runtime, and both
 * staging SPAs already point at the same relay host (cloudbuild.staging.yaml). A second copy would
 * be two identical services, which is a maintenance seam bought for no isolation.
 *
 * Stateless and secretless exactly as in prod: no `secret_env`, and the member's own capability
 * token — never anything held here — is what authorizes a call. See the comment on
 * `module "mcp_server"` in environments/prod/main.tf for the full reasoning.
 *
 * It does carry a runtime account, and that is a CORRECTION rather than a change of mind: needing
 * no GCP permission is why it runs as `run_noperm`, which HAS none. Terraform cannot manage a Cloud
 * Run service without `actAs` on its runtime account, so "leave it on the default" was never the
 * no-grant option — it was a grant on an account holding roles/editor project-wide.
 *
 * ⚠ THIS POINTS AT THE MAINNET-COHORT STAGING RELAY, which touches real funds. It is a rehearsal of
 * the production wiring, not a sandbox.
 */
module "mcp_server_staging" {
  count = var.manage_mcp_server ? 1 : 0

  source = "git::https://github.com/chippr-robotics/chippr-tf-modules.git//modules/cloud-run-service?ref=838c250b6dc8542fd0730b12ec7050462387bc53"

  project_id = var.project_id
  region     = var.region
  name       = "fairwins-mcp-server-staging"

  # Set BEFORE this module is ever ungated, so the flag flip is a flag flip. Without it the first
  # apply after `manage_mcp_server = true` would fail exactly as `Apply staging` did on 2026-09-08:
  # 403 actAs denied on the default compute account.
  service_account_email = var.run_noperm_service_account

  # Required by the provider, then ignored — but it must still RESOLVE on the first create, and
  # nothing publishes this path today. `:latest` here is an instruction to whoever publishes the
  # image first, not a description of an existing pipeline.
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repository}/fairwins-mcp-server/fairwins-mcp-server-staging:latest"

  # Mirrors production's ceiling rather than `var.staging_max_instances`: a promotion mirror should
  # reproduce the shape it is rehearsing, and 4 is already the smaller of the two numbers.
  min_instances         = 0
  max_instances         = 4
  cpu                   = "1"
  memory                = "256Mi"
  cpu_idle              = true
  allow_unauthenticated = true

  env = {
    FAIRWINS_API_URL = "https://relay-staging.fairwins.app"
  }
}
