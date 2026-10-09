# infra/ansible — node configuration for the FairWins nodes

Terraform creates the nodes; Ansible keeps their interiors true. The boundary is published in
`specs/087-infrastructure-as-code/contracts/ownership-boundary.md` — every attribute has exactly one
owner.

## Reaching the nodes

**There is no public SSH.** The firewall opens `:22` to `35.235.240.0/20` (the IAP TCP forwarding
range) and nothing else; `:443/:80` are open to Cloudflare ranges only. `inventory/gcp.yml` proxies
every connection through `gcloud compute start-iap-tunnel`.

If a playbook cannot connect, **fix the tunnel — never the firewall.** A playbook written for direct
SSH cannot reach these hosts at all, and widening the source range to make it work would undo the
network's whole posture.

## Setting up a controller

The controller needs three things, and each one fails in a way that does not name itself.

```bash
# 1. Ansible and the inventory plugin's Python dependencies, in a venv.
#    The dynamic inventory imports google-auth IN THE CONTROLLER's interpreter. Distro Ansible runs
#    on a PEP-668 `EXTERNALLY-MANAGED` /usr/bin/python3 that cannot be pip-installed into, and the
#    apt build of google-auth is years behind what google.cloud 1.15.0 expects — so a venv is the
#    supported path, and it is what CI installs too.
python3 -m venv ~/.venvs/fairwins-ansible
~/.venvs/fairwins-ansible/bin/pip install ansible-core ansible-lint google-auth requests
export PATH="$HOME/.venvs/fairwins-ansible/bin:$PATH"

# 2. Application Default Credentials. `auth_kind: application` reads ADC, which `gcloud auth login`
#    does NOT write — that command authenticates the CLI and leaves the inventory unauthenticated.
gcloud auth application-default login

# 3. The pinned collections, into the path ansible.cfg declares.
ansible-galaxy collection install -r requirements.yml -p collections

ansible-inventory -i inventory/gcp.yml --graph      # both nodes, discovered by label
```

**Seed the SSH key once per workstation.** These nodes do not use OS Login: `ssh-keys` metadata is
owned by gcloud, which injects a short-lived key for your own local username on every
`gcloud compute ssh`. The inventory connects as that same operator and reads
`~/.ssh/google_compute_engine`, so a converge run is attributed to a named human — but the key has to
exist before Ansible can use it, and an expired one reads as `Permission denied (publickey)` from a
host the tunnel already reached:

```bash
gcloud compute ssh fairwins-gateway --zone=us-central1-a --tunnel-through-iap --command=true
ansible all -i inventory/gcp.yml -m ping     # expect SUCCESS / pong from both nodes
```

Do not "fix" a `publickey` denial by adding an `ansible` user to the inventory. There is no such
account on these nodes, and a shared one would attribute every converge run to nobody.


## Running

```bash
ansible-playbook site.yml --check --diff    # dry run
ansible-playbook site.yml                   # converge both nodes, one at a time
ansible-playbook playbooks/gateway.yml      # one role
ansible-playbook playbooks/harden.yml       # OS hardening + patching, deliberately separate
```

`site.yml` runs `serial: 1`: both nodes carry the gasless path, so converging them simultaneously
would mean any restart takes both down at once.

## Idempotency

A second consecutive run against an unchanged node reports `changed=0` and restarts nothing. This is
asserted in CI, not assumed. Two rules keep it true:

- **`state: present`, never `state: latest`.** `latest` reports changed whenever upstream publishes,
  and can upgrade Docker under a running bundler. The engine is version-pinned *and* apt-held.
- **No `shell`/`command` without `creates`, `removes`, or a truthful `changed_when`.**

## Things that will bite you

- **Restart the whole unit, never a container.** Every container on a node shares one network
  namespace (`network_mode: service:<owner>`), reproducing Cloud Run's sidecar namespace. That is
  what makes the `localhost` couplings correct verbatim — `ENGINE_URL`, `REDIS_URL`, the engine's
  webhook URL, and the alto upstream. Recreating the namespace owner invalidates the joiners, so
  acting on one container leaves a stack that looks healthy and is not. The webhook URL is the worst
  case: rewriting it wrong fails **silently**, and intents report `submitted` forever.
- **Secrets are delivered by `infra/vm/common/fetch-secrets.sh`, which this layer invokes rather
  than replaces.** That script enforces per-container scoping, byte-exact payloads (escaping a PEM
  newline breaks KMS signing silently, at first use), refusal to run under `set -x`, and
  REQUIRED-vs-OPTIONAL handling. Reimplementing it in Ansible would mean re-earning all four.
- **Version pins are load-bearing.** `relay-webhook-secret` and `relay-engine-api-key` are pinned to
  version `2`. Both have an enabled v1 *and* v2 today, so "unpinned means latest, and latest is v2"
  is benign right now and silently wrong after the next rotation.
- **The Cloudflare Origin CA certificate is the one genuinely manual step.** It is issued per-origin
  and is not derivable from the repository. nginx is deliberately left stopped without it, because
  starting it would fail and leave it down anyway.
- **The prober allowlist comes from the committed file**, the same one that backs the GCP firewall
  rule. The old startup script regenerated it from `gcloud` on every boot, so it could change with no
  review. Two allowlists that must agree will eventually disagree unless they come from one file.
