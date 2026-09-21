#!/usr/bin/env bash
#
# infra/vm/startup.sh — GCE startup script. Fully idempotent and self-provisioning, so the VM is
# cattle: destroying and recreating it reproduces the whole stack from the repo.
#
# Role comes from instance metadata (fairwins-role=gateway|bundler).
#
set -euo pipefail
exec > >(logger -t fairwins-startup) 2>&1

REPO_URL="https://github.com/chippr-robotics/fairwins-platform.git"
REPO_DIR=/opt/fairwins/repo
ROLE="$(curl -fsS -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/fairwins-role)"
[ -n "$ROLE" ] || { echo "FATAL: no fairwins-role metadata"; exit 1; }
echo "provisioning role=${ROLE}"

# ---- packages ---------------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# rsync is NOT present on the Debian 12 GCE image and is used below to sync the repo into
# /opt/fairwins — omitting it cost one provisioning run with a bare "exit status 127".
apt-get install -y -qq ca-certificates curl gnupg git nginx jq python3 rsync

if ! command -v docker >/dev/null; then
  install -m0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker

# Ops Agent — required for VM memory and disk metrics (the default agentless metrics give CPU only).
if ! systemctl is-active --quiet google-cloud-ops-agent; then
  curl -fsS https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh | bash -s -- --also-install
fi

# A missing binary here surfaces as a bare "exit status 127" in the serial console, with no clue
# which command was missing. Name it instead. (gcloud IS present on the Google Debian image; rsync
# is not, which is exactly how this check earned its place.)
missing=""
for c in rsync gcloud git docker jq python3 curl logger; do
  command -v "$c" >/dev/null 2>&1 || missing="${missing} ${c}"
done
[ -x /usr/sbin/nginx ] || missing="${missing} nginx"
if [ -n "$missing" ]; then
  echo "FATAL: required commands missing:${missing}"
  exit 1
fi

# ---- repo + layout ----------------------------------------------------------------------------
mkdir -p /opt/fairwins
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --depth 1 origin main && git -C "$REPO_DIR" reset --hard origin/main
else
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
fi
rsync -a --delete "$REPO_DIR/infra/vm/common/"  /opt/fairwins/common/
rsync -a --delete "$REPO_DIR/infra/vm/${ROLE}/" /opt/fairwins/${ROLE}/
chmod +x /opt/fairwins/common/*.sh /opt/fairwins/${ROLE}/*.sh 2>/dev/null || true

mkdir -p /etc/fairwins
printf 'FW_ROLE=%s\nFW_PROJECT=%s\nFW_REPO=%s\n' "$ROLE" "chippr-bots-site-wp" "$REPO_DIR" > /etc/fairwins/role.env

# Docker pulls private Artifact Registry images using the VM's attached service account.
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet

# ---- host nginx (TLS terminator) ---------------------------------------------------------------
mkdir -p /etc/ssl/fairwins /etc/nginx/fairwins
# The Google uptime prober allow-list for the /__probe/ location. Regenerated on every boot so a
# change to Google's prober fleet is picked up by a reboot.
{
  gcloud monitoring uptime list-ips --format='value(ipAddress)' | sed 's/^/allow /; s/$/;/'
  echo "deny all;"
} > /etc/nginx/fairwins/google-probers.conf

install -m0644 "$REPO_DIR/infra/vm/nginx/fairwins-${ROLE}.conf" /etc/nginx/sites-available/fairwins.conf
ln -sf /etc/nginx/sites-available/fairwins.conf /etc/nginx/sites-enabled/fairwins.conf
rm -f /etc/nginx/sites-enabled/default

# The Origin CA private key is commonly pasted in by hand and lands 0644 by default. Enforce 0600
# on every boot rather than relying on the operator remembering — a world-readable origin key lets
# any local process impersonate this origin to Cloudflare.
if [ -f /etc/ssl/fairwins/origin.key ]; then
  chown root:root /etc/ssl/fairwins/origin.key
  chmod 0600 /etc/ssl/fairwins/origin.key
fi

# nginx must not start before the Origin CA cert exists, or it fails and stays down.
if [ ! -s /etc/ssl/fairwins/origin.pem ] || [ ! -s /etc/ssl/fairwins/origin.key ]; then
  echo "WARNING: Cloudflare Origin CA cert not installed at /etc/ssl/fairwins/origin.{pem,key}."
  echo "         Install it (MANUAL step, see docs/runbooks/vm-migration.md), then: systemctl restart nginx"
  systemctl stop nginx || true
else
  nginx -t && systemctl enable --now nginx && systemctl reload nginx
fi

# ---- systemd units -----------------------------------------------------------------------------
install -m0644 "$REPO_DIR"/infra/vm/systemd/*.service /etc/systemd/system/
install -m0644 "$REPO_DIR"/infra/vm/systemd/*.timer   /etc/systemd/system/
systemctl daemon-reload

# Enable ONLY this VM's role instance. Enabling the other role's template instance would re-run
# fetch-secrets for the wrong role and truncate the tmpfs env files the running stack is using.
systemctl enable --now "fairwins-secrets@${ROLE}.service"
systemctl enable --now "fairwins-stack@${ROLE}.service"
systemctl enable --now "fairwins-probe@${ROLE}.timer"

echo "provisioning complete for role=${ROLE}"
