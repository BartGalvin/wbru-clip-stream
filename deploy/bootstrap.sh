#!/usr/bin/env bash
# Provision or reconcile an Ubuntu application host.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${WBRU_APP_DIR:-$REPO_DIR}"
CLIPS_DIR="${WBRU_CLIPS_DIR:-/srv/wbru/clips}"
DATA_DIR=/srv/wbru/data
BACKUP_DIR=/srv/wbru/backups
ENV_FILE=/etc/wbru-visualizer.env
DEPLOY_OWNER="${SUDO_USER:-root}"
DEPLOY_GROUP="$(id -gn "$DEPLOY_OWNER")"

echo "==> System packages"
apt-get update
apt-get install -y curl nginx rsync build-essential python3 apache2-utils ffmpeg
# Match the Node version used by development and CI.
curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
apt-get install -y nodejs

echo "==> Build the app"
install -d -o www-data -g www-data -m 0755 "$CLIPS_DIR"
install -d -o www-data -g www-data -m 0750 "$DATA_DIR" "$BACKUP_DIR"
cd "$APP_DIR"
node scripts/check-node.mjs
npm ci
npm run build

echo "==> nginx"
# Keep one operator password file across repeated bootstrap runs.
if [ ! -f /etc/nginx/wbru-htpasswd ]; then
  echo "==> Set the operator password (user 'wbru')"
  htpasswd -B -c /etc/nginx/wbru-htpasswd wbru
fi
WBRU_APP_DIR="$APP_DIR" WBRU_CLIPS_DIR="$CLIPS_DIR" \
  node "$REPO_DIR/deploy/install-runtime-config.mjs" core
# Preserve any TLS and domain settings in an existing nginx site.
if [ ! -e /etc/nginx/sites-available/wbru ]; then
  WBRU_APP_DIR="$APP_DIR" WBRU_CLIPS_DIR="$CLIPS_DIR" \
    node "$REPO_DIR/deploy/install-runtime-config.mjs" web
fi
ln -sf /etc/nginx/sites-available/wbru /etc/nginx/sites-enabled/wbru
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> API service"
touch "$ENV_FILE"
# Add required defaults without overwriting operator settings.
ensure_env_default() {
  local name="$1"
  local value="$2"
  if ! grep -q "^$name=" "$ENV_FILE"; then
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
}
ensure_env_default TAGGER_DATA_DIR "$DATA_DIR"
ensure_env_default BACKUP_DIR "$BACKUP_DIR"
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Give the service its data directories and keep application code read-only.
chown -R www-data:www-data "$DATA_DIR" "$BACKUP_DIR"
chown -R "${DEPLOY_OWNER}:${DEPLOY_GROUP}" "$APP_DIR"
chmod -R go-w "$APP_DIR"
systemctl daemon-reload
systemctl enable --now wbru-visualizer wbru-backup.timer

echo "==> Hardening (firewall + fail2ban)"
apt-get install -y ufw fail2ban
# Allow only SSH and HTTP(S) traffic.
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
# Block repeated authentication failures at the nginx operator gate.
cat > /etc/fail2ban/jail.d/wbru.local <<'EOF'
[nginx-http-auth]
enabled = true
logpath = /var/log/nginx/error.log
maxretry = 6
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

echo
echo "Done."
echo "  App:    http://<droplet-ip>/"
echo "  Clips:  put files in $CLIPS_DIR/  (DB urls must be /clips/<file>)"
echo "  Data:   $DATA_DIR"
echo "  Backup: $BACKUP_DIR"
echo "  Logs:   journalctl -u wbru-visualizer -f"
echo "  API:    curl 'http://127.0.0.1:3001/api/program/upcoming?limit=3'"
