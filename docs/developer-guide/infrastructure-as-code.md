# Infrastructure as Code

**Spec**: [087-infrastructure-as-code](https://github.com/chippr-robotics/fairwins-platform/tree/main/specs/087-infrastructure-as-code) · **Issue**: #1177

The FairWins cloud estate is described declaratively: **Terraform** provisions cloud resources,
**Ansible** converges node interiors. The goal is that the environment can be reconstructed or
audited from repository contents alone — no manual console changes, no undocumented drift.

## Read this first

Three facts shape every decision here. Each has already caused, or nearly caused, a real incident.

### 1. The GCP project is shared

`chippr-bots-site-wp` hosts a public WordPress VM on the default network, plus `clearpath-*`,
`fukuii-*` and `kings-edge-*`. Nothing in this repository may describe, reference, or authoritatively
overwrite anything outside its own inventory.

The concrete trap:

| Resource | Semantics | Effect here |
|---|---|---|
| `google_project_iam_member` | additive — one (role, member) pair | safe |
| `google_project_iam_binding` | **authoritative for that role** | strips the role from every other principal, project-wide |
| `google_project_iam_policy` | **authoritative for the whole policy** | removes every grant not declared here, including the owners' own |

The names differ by one word and the resulting plan diff looks small and ordinary. Under automatic
apply, nobody has to click anything for it to happen. `npm run check:iac` rejects both
authoritative forms (G-01, G-02), and the CI identity is not granted project IAM admin so the same
mistake also fails at the API. Two layers, because either alone has a way to be wrong.

### 2. Some resources cannot be recreated

KMS key versions, secret payloads, and the static IPs pinned in Cloudflare DNS. These carry
`prevent_destroy` **and** sit outside the CI identity's permissions. `prevent_destroy` is a
configuration guard — a change that deletes the resource block deletes the guard with it — so the
permission layer is what holds in that case.

### 3. One service must stay decommissioned

`cloudbuild.yaml` no longer builds or deploys the Cloud Run alto bundler. That deletion is
load-bearing: re-arming it alongside the VM bundler puts **two executors on one EOA** — colliding
nonces, stuck bundles, both instances reporting healthy, and no in-band detection.
`single-alto-gate.sh` detects the condition within 60s and refuses to start the VM's alto, but it
cannot prevent it. Guardrail G-11 rejects any attempt to declare the service.

## Layout

```
infra/terraform/
  bootstrap/                 run-once trust root. Local state, committed. Not in the apply workflow.
  modules/                   network, edge-node, cloud-run-service, cloudflare-zone, monitoring
  environments/prod/         state prefix: prod
  environments/staging/      state prefix: staging
infra/ansible/               roles, playbooks, dynamic inventory over IAP
scripts/infra/               the guardrail gate, the plan renderer, the prober generator
.github/workflows/           infra-plan.yml, infra-apply.yml, infra-drift.yml
```

One root per environment, separate state prefixes: a prod apply cannot reach staging state at all.
That is a harder boundary than `-target`, which applies a subgraph without refreshing the rest and
so leaves recorded state no longer describing reality (guardrail G-14 rejects it).

## Who owns what

Every managed attribute has exactly **one** owner. Two owners on one attribute produces permanent
false drift, and false drift is how real drift gets ignored.

| Attribute class | Owner |
|---|---|
| VPC, subnet, firewall rules, static IPs | Terraform |
| VM existence, machine type, labels, tags, attached SA, shielded settings | Terraform |
| Packages, OS hardening, nginx config, systemd units, container stack, runtime secrets | Ansible |
| Cloud Run scaling, CPU, ingress, SA, secret wiring, invoker IAM, domain mapping | Terraform |
| Cloud Run **image tag and revision** | **Cloud Build** |
| Secret containers + access bindings | Terraform |
| Secret **payloads and rotation** | out of band |
| KMS rings, keys, IAM | Terraform |
| KMS **key versions** | out of band — never managed |
| DNS, WAF ruleset, transform ruleset | Terraform |
| Monitoring channels, checks, policies, log metrics | Terraform |

Full table with rationale: `specs/087-infrastructure-as-code/contracts/ownership-boundary.md`.

## Tooling

Terraform and Ansible are not part of the npm toolchain — install them separately.

```bash
# Terraform 1.15.x
curl -fsSL -o tf.zip https://releases.hashicorp.com/terraform/1.15.8/terraform_1.15.8_linux_amd64.zip
unzip tf.zip && sudo mv terraform /usr/local/bin/

# Ansible
pip install ansible-core ansible-lint
cd infra/ansible && ansible-galaxy collection install -r requirements.yml
```

`npm run check:iac` needs only Node, so the guardrail gate runs anywhere.

## Everyday tasks

### Change a service's configuration

1. Edit the relevant module call in `infra/terraform/environments/<env>/main.tf`.
2. Open a PR. `infra-plan.yml` posts a redacted plan summary showing the blast radius, with
   replacements called out separately from in-place updates.
3. Merge. `infra-apply.yml` applies **the plan that was reviewed** — not a fresh one.

### Add a resource

Declare it in the appropriate module (or add a module), then:

```bash
npm run check:iac
terraform -chdir=infra/terraform/environments/prod fmt -check
terraform -chdir=infra/terraform/environments/prod validate
```

If the resource already exists in the cloud, add an `import` block instead of letting Terraform
create a second one — see below.

### Adopt an existing resource

```hcl
import {
  to = module.network.google_compute_address.origin["fairwins-gateway-ip"]
  id = "projects/chippr-bots-site-wp/regions/us-central1/addresses/fairwins-gateway-ip"
}
```

Then:

```bash
terraform plan -generate-config-out=generated.tf   # a STARTING POINT, never committed raw
# review, reshape into the module, delete generated.tf
terraform plan          # must say "will be imported", never "must be replaced"
terraform apply
terraform plan          # must say "No changes."
```

**The last step is the definition of done.** If the plan is not clean, the *configuration* is wrong
— fix it in the repository. Never apply to force live infrastructure to match a generated body.

`import` blocks stay in the repository after adoption. They are the audit record of how each
resource came under management, and the recovery path if state is ever lost.

### Converge a node

```bash
cd infra/ansible
ansible-playbook site.yml --check --diff   # dry run
ansible-playbook site.yml                  # both nodes, one at a time
```

The nodes have **no public SSH** — the inventory tunnels through IAP. If a playbook cannot connect,
fix the tunnel, never the firewall.

A second consecutive run must report `changed=0`. If it does not, something in a role is
non-idempotent — usually `state: latest` or a `shell` task without a truthful `changed_when`.

## Secrets

Terraform manages secret **containers** and who may read them. It never manages payloads: a
`google_secret_manager_secret_version` resource writes the value into state in plaintext, and
guardrail G-04 rejects it.

There is **one accepted exception**, documented rather than hidden: the origin-lock header value is
read through a `google_secret_manager_secret_version` *data source* so the Cloudflare transform rule
and the origin nginx carry the same value. Data-source results *are* written to state —
`sensitive = true` hides a value from output, not from state. The alternative was a placeholder plus
a manual dashboard step, which reintroduces exactly the drift this feature removes. The gate warns
on every data-source use so the exception stays countable.

## Gates

| Gate | Proves |
|---|---|
| `npm run check:iac` | the fifteen repository-specific rules in `contracts/guardrails.md` |
| `npm run test:iac-guardrails` | that each rule still fires — a gate that passes everything gets cited as evidence |
| `terraform fmt -check` / `validate` | syntax and provider schema |
| `tflint` | invalid arguments, deprecated usage, dead declarations |
| `ansible-lint` + syntax check | playbook correctness |
| double-run idempotency | a converge run changes nothing the second time |
| scheduled drift | the running estate still matches the repository |

All fail the pipeline on error. `continue-on-error` is forbidden on them (constitution IV).

## Shared modules

Modules live in **[`chippr-robotics/chippr-tf-modules`](https://github.com/chippr-robotics/chippr-tf-modules)**
(private) and are consumed by pinned commit SHA:

```hcl
source = "git::https://github.com/chippr-robotics/chippr-tf-modules.git//modules/network?ref=70498e2a2860f2e65cd2ce3919ca85d29678a1e3"
```

A SHA rather than a tag, because a tag can be repointed and a commit cannot. Guardrail **G-16**
rejects any external module source that is unpinned or pinned to a branch.

Because the repo is private, `terraform init` needs a credential — the workflows rewrite git's config
with `TF_MODULES_TOKEN` before `init`. A missing token shows up as `repository not found`, not as a
permission error, because GitHub returns 404 for private repos the caller cannot see.

### The token must be owned by the ORGANISATION

A fine-grained PAT's **resource owner** is chosen when the token is created and **cannot be edited
afterwards**. A token owned by a personal account can never see `chippr-robotics` repositories — no
scope setting, no organisation policy, and no approval changes that.

GitHub reports this as **404 Not Found**, not 403, because a repository you cannot see is
indistinguishable from one that does not exist. That reads as "the repo is missing" or "the scope is
wrong", so it sends you to fix things that were never broken. It cost four rounds here.

When creating the token, the **Resource owner** dropdown must be set to `chippr-robotics`. The token
page then shows *"Access on the chippr-robotics organization"*. If it does not say that, the token
cannot be repaired — generate a new one.

Required settings:

| Field | Value |
|---|---|
| Resource owner | `chippr-robotics` |
| Repository access | Only select repositories → `chippr-tf-modules` |
| Repository permissions | Contents: **Read-only** |

The organisation must also permit fine-grained PATs, and may hold the token in a pending-approval
queue. Verify before storing the secret:

```bash
git ls-remote https://x-access-token:<TOKEN>@github.com/chippr-robotics/chippr-tf-modules.git HEAD
```

It should print the commit the modules are pinned to.

### Never paste a token into a screenshot or a chat

Treat any token that has appeared in an image, a transcript, or a log as compromised and revoke it.
The secret store is the only place a token belongs.

**Add new modules there, not to `infra/terraform/modules/`.** A module kept locally is invisible to
the other Chippr projects sharing this estate and drifts from its shared twin. That directory now
holds only a pointer.

See `specs/087-infrastructure-as-code/contracts/module-interfaces.md`.

## Related

- `docs/runbooks/infrastructure-operations.md` — bootstrap, recovery, drift response, rotation
- `infra/ansible/README.md` — node configuration specifics
- `docs/runbooks/vm-migration.md` — how the nodes came to be
- `specs/087-infrastructure-as-code/` — spec, research, plan, contracts, quickstart
