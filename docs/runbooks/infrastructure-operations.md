# Runbook: Infrastructure operations

**Spec**: [087-infrastructure-as-code](https://github.com/chippr-robotics/fairwins-platform/tree/main/specs/087-infrastructure-as-code)

Operational procedures for the declarative estate. Design rationale lives in
`docs/developer-guide/infrastructure-as-code.md`; this is what to do when something needs doing.

> **Before any procedure here**: the GCP project is shared with unrelated Chippr workloads, and
> several resources (KMS key versions, secret payloads, the Cloudflare-pinned static IPs) cannot be
> recreated. Nothing below asks you to run `terraform destroy`, and you should not.

## Bootstrap (once, ever)

Creates the state bucket, the federation pool, and the two CI identities. Needs owner rights, which
the CI identities deliberately do not have.

```bash
cd infra/terraform/bootstrap
terraform init          # no backend block — local state by design
terraform apply
git add terraform.tfstate && git commit -m "chore(085): record bootstrap state"
git push
```

**The local state stays local.** Do not run `terraform init -migrate-state`: the bucket cannot store
the state that creates it, and the trust root must not depend on itself. Committing the state file is
safe — bootstrap manages a bucket, a pool and two service accounts, no secrets — and it makes the
establishment of the trust root auditable at any commit.

**`git push`, not just `git commit`.** The 2026-08-28 IAM permission rounds hit "Custom project role
... already exists and must be imported" three separate times, for three different resources
(the WIF pool, then two custom roles) — each one had been created successfully in an *earlier* apply,
but the commit recording it never reached `origin`. A fresh checkout (or a second operator, or the
same operator days later) starts from whatever was last pushed, not whatever was last applied. If
that gap exists, the next `terraform apply` re-attempts a create against something that already
exists live, and the fix each time is `terraform import` for the orphaned resource — annoying but
harmless (bootstrap manages no destroy-sensitive state), and entirely avoidable by finishing the
`git add && git commit && git push` sequence every time, not just the commit.

Then set the repository variables the workflows read:

```bash
terraform output -raw workload_identity_provider   # -> WIF_PROVIDER
terraform output -raw tf_plan_service_account      # -> TF_PLAN_SERVICE_ACCOUNT
terraform output -raw tf_apply_service_account     # -> TF_APPLY_SERVICE_ACCOUNT
```

and the one long-lived credential, `CLOUDFLARE_API_TOKEN`, as a repository secret — zone-scoped
(`Zone.DNS:Edit`, `Zone.WAF:Edit`, `Zone.Zone:Read`), never account-scoped.

## Adopting a surface

Adoption is gated: one surface at a time, each reaching a clean plan before the next begins.

1. Uncomment that surface's `import` blocks in `environments/<env>/imports.tf`.
2. `terraform plan -generate-config-out=generated.tf` — a **starting point**. It emits
   server-populated defaults and computed fields that cannot legally be set; committing it unedited
   produces a configuration that either fails to apply or shows permanent diffs.
3. Reshape the generated bodies into the modules. Delete `generated.tf`.
4. `terraform plan` — every resource must say **`will be imported`**. If anything says
   **`must be replaced`**, stop: the configuration does not match reality, and applying would
   destroy a live resource.
5. `terraform apply`.
6. `terraform plan` — must report **`No changes.`** This is the definition of done.

If step 6 is not clean, the **configuration** is wrong. Fix it in the repository. Never apply to make
live infrastructure match a generated body.

Leave the `import` blocks in place afterwards. They are the audit record and the state-loss recovery
path.

## Responding to a drift report

The scheduled job opens or updates an issue labelled `infrastructure,drift`. It reports; it does not
correct — deciding whether reality or the repository is right is a human call.

1. Read the redacted diff on the issue. Identify the resource and attribute.
2. **If the change was intended** (someone fixed something urgently at the console): declare it in
   the repository and merge. The apply reconciles, and the issue closes on the next clean run.
3. **If it was not intended**: this is the record that it happened. Investigate who and why before
   reverting — an unexplained infrastructure change is a security question, not a tidiness one.
4. **If it recurs every run on the same attribute**: that is a two-owner bug, not drift. Something
   else is writing that attribute — most likely the build pipeline. Fix the ownership boundary
   (`contracts/ownership-boundary.md`), because recurring false drift teaches everyone to ignore the
   report.

## Failed apply (partial state)

Terraform writes state incrementally, so a mid-apply failure leaves some resources created.

**Do not re-run the job.** There is no retry on the apply step, deliberately.

1. Read the failed run's log; identify the last resource that succeeded.
2. `terraform plan` against the environment. This shows the true remaining delta.
3. Decide from the plan, not from the failure message. If the plan is sane, apply it manually from a
   trusted workstation. If it proposes anything destructive, stop and investigate.
4. If state and reality have genuinely diverged, restore the prior state version (below) and re-plan.

## State recovery

Object versioning is on and the bucket is `prevent_destroy` protected.

```bash
# List versions
gsutil ls -a gs://fairwins-tfstate-chippr-bots-site-wp/prod/default.tfstate

# Restore a prior version
gsutil cp gs://fairwins-tfstate-chippr-bots-site-wp/prod/default.tfstate#<generation> \
          gs://fairwins-tfstate-chippr-bots-site-wp/prod/default.tfstate

terraform plan   # reconcile before doing anything else
```

**Total state loss is recoverable**, because the `import` blocks are still in the repository: re-run
them and adoption reproduces. That is the whole reason they are kept.

## Stuck state lock

```bash
terraform force-unlock <lock-id>
```

**Confirm no apply is in flight first.** Force-unlocking a live apply is how state and reality
diverge. Check the Actions tab for a running `Infra Apply` job before touching this. It appears in no
automated path, on purpose.

## The apply refused to run

| Message | Meaning | Fix |
|---|---|---|
| "The reviewed plan does not match the merged configuration" | The infra tree changed between plan and merge — usually another infra PR landed first | Re-run the plan on a fresh PR (an empty commit is enough) and merge that |
| "Saved plan is stale" | State moved since the plan was computed | Same: re-plan and merge |
| "No pull request is associated with this commit" | Someone pushed directly to `main` | Automatic apply executes a plan a reviewer saw. Open a PR |

All three are the system working. A fresh, unreviewed plan applying automatically is exactly what the
design forbids.

## The repository was renamed and every GCP job now fails auth

**Symptom.** Every workflow that federates into GCP — `Plan`, `Apply`, anything using
`google-github-actions/auth` — fails before it does any work:

```
google-github-actions/auth failed with: failed to generate Google Cloud federated token ...
{"error":"unauthorized_client","error_description":"The given credential is rejected by the attribute condition."}
```

**Cause.** Workload Identity Federation pins the repository by name. GitHub puts the CURRENT name in
the OIDC token's `repository` claim, so a rename invalidates two things at once:

| Where | What it holds |
|---|---|
| `google_iam_workload_identity_pool_provider.github.attribute_condition` (`bootstrap/main.tf:96`) | `assertion.repository == "owner/name"` — rejects the token outright |
| the `roles/iam.workloadIdentityUser` members (`bootstrap/main.tf:176`) | `principalSet://.../attribute.repository/owner/name` — would refuse the impersonation even if the token were issued |

Both come from `var.github_repository`.

**Terraform cannot fix this.** Applying requires federating, and federating is what is being refused.
The credential needed to repair the condition is the credential the condition rejects. The live pool
has to be corrected out of band, by a human with admin rights, BEFORE any pipeline works again.

**Recovery.** With an admin credential (`gcloud auth login` as a human, not the CI service account):

```bash
POOL=github-actions
PROVIDER=github-oidc
NEW=chippr-robotics/fairwins-platform      # the repo's CURRENT owner/name
PROJECT_NUMBER=266380754692

# 1. Repoint the provider's attribute condition.
gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" \
  --project=chippr-bots-site-wp --location=global --workload-identity-pool="$POOL" \
  --attribute-condition="assertion.repository == \"$NEW\""

# 2. Grant the new principalSet, for each service account that federates
#    (fairwins-tf-plan@ and the apply identity).
POOL_PATH="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL"
for SA in fairwins-tf-plan fairwins-tf-apply; do
  gcloud iam service-accounts add-iam-policy-binding \
    "$SA@chippr-bots-site-wp.iam.gserviceaccount.com" \
    --project=chippr-bots-site-wp \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/$POOL_PATH/attribute.repository/$NEW"
done
```

Use `add-iam-policy-binding`, never `set-iam-policy`: IAM here is **additive only** (see
`check:iac` and `docs/developer-guide/infrastructure-as-code.md`), and the additive form also leaves
the old binding in place, so a rollback of the rename does not lock everything out.

**Then remove the stale grant** once a plan has run green — the old `attribute.repository/<old-name>`
member should not outlive the rename, and a repository name can be re-registered by someone else.

**Finally**, confirm `var.github_repository` in `infra/terraform/bootstrap/variables.tf` matches the
new name and that a plan comes back **zero-diff**. If the code still names the old repo, the next
apply reverts the console fix and the outage returns.

**Not only GCP.** A rename also detaches anything else keyed on `owner/repo`: verify the Cloud Build
GitHub trigger (`gcloud builds triggers list`) still points at the repository, and that its
`--repo-name` matches.

## Rotating the Cloudflare token

The one long-lived credential in the design.

1. Create a new zone-scoped token in the Cloudflare dashboard with the same three permissions.
2. Update the `CLOUDFLARE_API_TOKEN` repository secret.
3. Trigger `Infra Drift` manually and confirm it runs clean.
4. Revoke the old token.

Rotate before revoking: a revoked token with no replacement leaves the edge unmanageable until
someone notices.

## Refreshing the uptime prober allowlist

```bash
node scripts/infra/generate-prober-cidrs.js       # writes prod + staging
git add infra/terraform/environments/*/prober-cidrs.json && git commit
```

The drift job runs this with `--check` and fails when the committed copy is stale. Google publishes
no Terraform data source for these addresses, so a committed list is the only option — and a
committed list nobody re-checks fails silently: the probers move, checks go red against a healthy
origin, and the team learns to ignore the alert.

Both the GCP firewall rule and the nginx `/__probe/` allowlist read this same file. Two allowlists
that must agree will eventually disagree unless they come from one source.

## Node procedures

### Converge a node

```bash
cd infra/ansible
ansible-playbook site.yml --check --diff   # dry run first
ansible-playbook site.yml                  # both nodes, serial: 1
```

`serial: 1` because both nodes carry the gasless path; converging simultaneously means any restart
takes both down.

### Ansible cannot reach a node

The nodes have no public SSH. `:22` is open to `35.235.240.0/20` (IAP TCP forwarding) only.

```bash
gcloud auth login
gcloud compute start-iap-tunnel fairwins-gateway 22 --zone us-central1-a --local-host-port=localhost:2222
```

**Fix the tunnel, never the firewall.** Widening the source range to make a playbook work undoes the
network's entire posture.

### Rebuild a node

```bash
gcloud compute instances delete <node> --zone us-central1-a
terraform -chdir=infra/terraform/environments/prod apply
```

The startup script bootstraps and then runs the same playbook used for on-demand convergence, so a
recreated node reaches health with no manual step — **except** the Cloudflare Origin CA certificate
(below).

Do not rehearse this on a production node. Use a scratch node.

### Install the Cloudflare Origin CA certificate

The one genuinely manual step (FR-041). It is issued per-origin by Cloudflare and is not derivable
from the repository.

```bash
# on the node, via IAP
sudo install -m0644 origin.pem /etc/ssl/fairwins/origin.pem
sudo install -m0600 origin.key /etc/ssl/fairwins/origin.key
sudo systemctl restart nginx
```

The playbook deliberately leaves nginx stopped without it — starting it would fail and leave it down
anyway. The hardening role re-enforces `0600` on the key on every run, because a world-readable
origin key lets any local process impersonate this origin to Cloudflare.

## Emergency: an edge rule was added by hand

Both Cloudflare rulesets are **authoritative for their phase**. A rule added through the dashboard
during an incident is deleted by the next apply.

If you add one, **declare it in `modules/cloudflare-zone` within the hour**, or it will not survive.
If one has already been lost, the Cloudflare audit log shows what it was.

This is why the edge surface is adopted last, and why it is under CODEOWNERS.

## Things that must never happen

| Never | Because |
|---|---|
| `terraform destroy` on an environment | The estate holds unrecoverable resources; there is no automated path to this and there should not be |
| Add a `*_iam_binding` or `*_iam_policy` | Authoritative — strips access from workloads this repository has never heard of |
| Declare a `google_secret_manager_secret_version` | Writes the payload into state in plaintext |
| Declare the Cloud Run alto bundler | Two executors on one EOA: colliding nonces, stuck bundles, both healthy-looking |
| Use `-target` as a workflow | Applies a subgraph without refreshing the rest; recorded state stops describing reality |
| Widen the SSH firewall to make Ansible work | The IAP-only posture is the design |
| Grant the CI identity `roles/editor` | It includes `serviceAccountKeys.create` and `actAs` — a CI compromise then reaches the paymaster HSM key |

The first four are rejected by `npm run check:iac`. The last is enforced by the identity's role set.
Both layers exist because either alone has a way to be wrong.
