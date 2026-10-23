#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${WBRU_APP_DIR:-$REPO_DIR}"
CLIPS_DIR="${WBRU_CLIPS_DIR:-/srv/wbru/clips}"
ENV_FILE=/etc/wbru-visualizer.env
COOKIE_FILE=/etc/wbru-youtube-cookies.txt
CACHE_DIR="$CLIPS_DIR/.yt-dlp-cache"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Require the root-owned runtime environment installed by bootstrap.
if [[ ! -f "${ENV_FILE}" || -L "${ENV_FILE}" ]]; then
  die "${ENV_FILE} must be a regular file created by deploy/bootstrap.sh."
fi
grep -Eq '^TAGGER_DATA_DIR=.+$' "${ENV_FILE}" ||
  die "${ENV_FILE} is missing a non-empty TAGGER_DATA_DIR value."
if [[ "$(stat -c '%U:%G:%a' "${ENV_FILE}")" != root:root:600 ]]; then
  die "${ENV_FILE} must be owned by root:root with mode 600."
fi

# Use the media volume unless root-disk storage is explicitly enabled.
if ! mountpoint -q "$CLIPS_DIR" && [[ "${ALLOW_ROOT_DISK:-0}" != 1 ]]; then
  echo "$CLIPS_DIR is not a mounted volume; refusing a full-channel download." >&2
  echo "Mount the media volume there, or set ALLOW_ROOT_DISK=1 intentionally." >&2
  exit 1
fi

# Install the media tools used by the synchronization service.
apt-get update
apt-get install -y ffmpeg
yt_dlp_download="$(mktemp)"
trap 'rm -f "$yt_dlp_download"' EXIT
curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o "$yt_dlp_download"
chmod 755 "$yt_dlp_download"
"$yt_dlp_download" --version >/dev/null
install -m 755 "$yt_dlp_download" /usr/local/bin/yt-dlp

# Prepare the YouTube library and its service-owned working directories.
install -d -m 755 -o www-data -g www-data "$CLIPS_DIR"
install -d -m 755 -o www-data -g www-data "$CLIPS_DIR/wbru-youtube"
install -d -m 755 -o www-data -g www-data "$CLIPS_DIR/.rejected"
install -d -m 700 -o www-data -g www-data "${CACHE_DIR}"
chown -R www-data:www-data "${CACHE_DIR}"
chmod -R u=rwX,go= "${CACHE_DIR}"

WBRU_APP_DIR="$APP_DIR" WBRU_CLIPS_DIR="$CLIPS_DIR" \
  node "$REPO_DIR/deploy/install-runtime-config.mjs" youtube
systemctl daemon-reload

# Restrict an installed cookie file to the sync service.
if [[ -e "${COOKIE_FILE}" || -L "${COOKIE_FILE}" ]]; then
  [[ -f "${COOKIE_FILE}" && ! -L "${COOKIE_FILE}" ]] ||
    die "${COOKIE_FILE} must be a regular file, not a symlink."
  chown www-data:www-data "${COOKIE_FILE}"
  chmod 600 "${COOKIE_FILE}"
fi

# Enable scheduled downloads once the service can read its credentials.
if runuser -u www-data -- test -r "${COOKIE_FILE}"; then
  systemctl enable --now wbru-youtube-sync.timer
  echo "YouTube sync timer installed and started."
else
  systemctl disable --now wbru-youtube-sync.timer
  echo "YouTube sync timer installed but disabled until its cookie file is readable."
  echo "Install ${COOKIE_FILE} as a regular file, then run this setup again or run:"
  echo "  systemctl enable --now wbru-youtube-sync.timer"
  echo "  systemctl start --no-block wbru-youtube-sync.service"
fi

echo "Watch it with:"
echo "  journalctl -fu wbru-youtube-sync.service"
