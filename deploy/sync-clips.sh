#!/usr/bin/env bash
# Upload clips additively without changing server-managed YouTube state.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WBRU_REPO_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=deploy/env.sh
source "$HERE/env.sh"

usage() {
  echo "Usage: deploy/sync-clips.sh [--dry-run] [<visualizer|tv|user@host> [local-clips-dir]]" >&2
}

dry_run=false
positionals=()
while (($# > 0)); do
  case "$1" in
    --dry-run)
      dry_run=true
      ;;
    --)
      shift
      positionals+=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      positionals+=("$1")
      ;;
  esac
  shift
done

if ((${#positionals[@]} > 2)); then
  usage
  exit 1
fi

host="${positionals[0]:-${WBRU_HOST:-${WBRU_VISUALIZER_SSH:-}}}"
src="${positionals[1]:-public/clips}"

if [ "$host" = visualizer ] || [ "$host" = tv ]; then
  host="$(wbru_ssh_target "$host")"
fi
if [ -z "$host" ]; then
  usage
  exit 1
fi

# Require a real local directory so rsync cannot follow an unexpected source root.
while [[ "$src" != / && "$src" == */ ]]; do
  src="${src%/}"
done
if [ -L "$src" ]; then
  echo "Refusing symlink source root: $src" >&2
  exit 1
fi
if [ ! -d "$src" ]; then
  echo "Source is not a directory: $src" >&2
  exit 1
fi

# Upload new operator-managed clips without replacing files or YouTube-managed state.
rsync_args=(
  -rltvh
  --ignore-existing
  "--chmod=u=rwX,go=rX"
  --exclude=.DS_Store
  --exclude=/wbru-youtube/
  --exclude=/.rejected/
  --exclude=/.yt-dlp-cache/
  --exclude=/.wbru-youtube-download-archive
)
if [ "$dry_run" = true ]; then
  rsync_args+=(--dry-run)
fi

echo "Syncing ${src%/}/ -> ${host}:${WBRU_CLIPS_DIR}/ ..."
rsync "${rsync_args[@]}" "${src%/}/" "${host}:${WBRU_CLIPS_DIR}/"

if [ "$dry_run" = true ]; then
  echo "Dry run complete. Run again without --dry-run to upload new clips."
  exit 0
fi

cat <<EOF

Done. Use Refresh in the production tagger to scan clips and update the catalog.
EOF
