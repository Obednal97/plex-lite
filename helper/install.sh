#!/bin/sh
# Install or update the Plex Lite home helper on Debian 12 (or any systemd Linux with Node 18+).
# Run as root from a clone of the repo:
#   git clone https://github.com/Obednal97/plex-lite /opt/plex-lite
#   sh /opt/plex-lite/helper/install.sh
# Update later: cd /opt/plex-lite && git pull && sh helper/install.sh
# The settings file is created once (with DRY_RUN=1) and never overwritten.
set -eu

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_DIR=/etc/plexlite-helper
ENV_FILE=$ENV_DIR/helper.env
UNIT=/etc/systemd/system/plexlite-helper.service

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js (Debian's nodejs package)…"
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "Node 18 or newer is needed (found $(node --version))." >&2
  exit 1
fi

# the service runs as a dynamic user: the code must be readable by everyone
chmod -R a+rX "$REPO_DIR/helper"

install -d -m 0755 "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  install -m 0600 -o root -g root "$REPO_DIR/helper/helper.env.example" "$ENV_FILE"
  SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -i "s/^WEBHOOK_SECRET=.*/WEBHOOK_SECRET=$SECRET/" "$ENV_FILE"
  echo "Created $ENV_FILE with DRY_RUN=1 and a random WEBHOOK_SECRET."
  echo "Fill in the service addresses and API keys, then: systemctl restart plexlite-helper"
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

sed "s#/opt/plex-lite#$REPO_DIR#g" "$REPO_DIR/helper/plexlite-helper.service" > "$UNIT"
chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl enable plexlite-helper >/dev/null 2>&1
systemctl restart plexlite-helper
sleep 1
if systemctl is-active --quiet plexlite-helper; then
  echo "plexlite-helper is running. Log: journalctl -u plexlite-helper -f"
  echo "Health: curl -s http://127.0.0.1:$(sed -n 's/^PORT=//p' "$ENV_FILE" | head -1 | grep . || echo 8787)/healthz"
else
  echo "plexlite-helper did not start. See: journalctl -u plexlite-helper -n 50" >&2
  echo "In an LXC, status=226/NAMESPACE means the container needs nesting (Proxmox: Options → Features → Nesting)." >&2
  exit 1
fi
