#!/usr/bin/env bash
# Validate and deploy one committed application release.
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WBRU_REPO_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=deploy/env.sh
source "$HERE/env.sh"

usage() {
  cat <<'EOF'
Usage:
  npm run deploy-code -- <visualizer|tv>
  npm run deploy-code -- <visualizer|tv> --apply
  npm run deploy-code -- <visualizer|tv> --initial
  npm run deploy-code -- <visualizer|tv> --rollback <remote-rollback-directory>

The default command validates HEAD and shows the production rsync plan.
Use --apply to create a verified rollback and deploy that commit.
Use --initial only for an empty host that will be provisioned afterward.
Use --rollback to restore code, dependencies, and built assets without restoring SQLite.
EOF
}

if (( $# < 1 || $# > 3 )); then
  usage >&2
  exit 2
fi

target="${1:-}"
mode="${2:-}"
rollback_path="${3:-}"
case "$mode" in
  '' | --apply | --initial) [[ $# -le 2 ]] || { usage >&2; exit 2; } ;;
  --rollback) [[ -n "$rollback_path" ]] || { usage >&2; exit 2; } ;;
  *) usage >&2; exit 2 ;;
esac
host="$(wbru_ssh_target "$target")"
case "$WBRU_SERVICE_SCOPE" in
  system | user) ;;
  *) echo 'WBRU_SERVICE_SCOPE must be system or user.' >&2; exit 2 ;;
esac

case "$target" in
  visualizer) origin="${WBRU_VISUALIZER_ORIGIN:-}" ;;
  tv) origin="${WBRU_TV_ORIGIN:-}" ;;
  *) usage >&2; exit 2 ;;
esac

# Run each remote step with the service's environment and systemd scope.
remote() {
  local command
  printf -v command '%q ' bash -s -- "$WBRU_SERVICE_SCOPE" "$WBRU_REMOTE_ENV_FILE" "$@"
  {
    cat <<'REMOTE'
set -euo pipefail
service_scope="$1"
env_file="$2"
shift 2
service=(systemctl)
if [[ "$service_scope" == user ]]; then service+=(--user); fi
if [[ -f "$env_file" ]]; then
  set -a
  source "$env_file"
  set +a
fi
REMOTE
    cat
  } | ssh "$host" "$command"
}

# Check the host and runtime paths before any destructive file sync.
preflight() {
  remote "$WBRU_APP_DIR" "$mode" "$(cat "$WBRU_REPO_ROOT/.nvmrc")" \
    "$WBRU_CLIPS_DIR" "$rollback_path" "$WBRU_ROLLBACK_DIR" <<'REMOTE'
set -euo pipefail
app_dir="$1"
mode="$2"
required_version="$3"
clips_dir="$4"
rollback="$5"
rollback_root="$6"
[[ "$service_scope" == user || "$(id -u)" == '0' ]] || {
  echo 'System-service deployment requires a root SSH target.' >&2
  exit 1
}
if [[ "$mode" == '--initial' ]]; then
  if [[ -L "$app_dir" || ( -e "$app_dir" && ! -d "$app_dir" ) ]]; then
    echo "Initial deployment requires an empty directory: $app_dir" >&2
    exit 1
  fi
  if [[ -d "$app_dir" && -n "$(find "$app_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "Initial deployment requires an empty directory: $app_dir" >&2
    exit 1
  fi
  mkdir -p "$app_dir"
  exit 0
fi

cd "$app_dir"
if [[ "$mode" == '--rollback' ]]; then
  required_version="$(cat "$rollback/app/.nvmrc")"
else
  test -f package.json
  "${service[@]}" is-active --quiet wbru-visualizer
  "${service[@]}" is-active --quiet wbru-backup.timer
fi
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "${required_version%%.*}" ]] || {
  echo "Node ${required_version%%.*} is required on the deployment host." >&2
  exit 1
}
data_dir="${TAGGER_DATA_DIR:-$app_dir/server}"
node --input-type=module - "$app_dir" "$data_dir" "${DATABASE_PATH:-$data_dir/program.db}" \
  "${CLIPS_DIR:-$clips_dir}" "${BACKUP_DIR:-$app_dir/backups}" "$rollback_root" <<'JS'
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

// Resolve existing parent directories too, so symlinks cannot hide overlapping paths.
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return resolve(canonicalPath(dirname(path)), basename(path));
  }
}
function overlaps(first, second) {
  if (first === sep || second === sep) return true;
  return first === second || first.startsWith(second + sep) || second.startsWith(first + sep);
}
const [app, dataDir, databasePath, clipsDir, backupDir, rollbackRoot] =
  process.argv.slice(2).map((path) => resolve(path));
const realApp = canonicalPath(app);
// These default locations are protected by deploy/rsync-exclude.txt.
const runtimePaths = [
  [dataDir, 'server'],
  [databasePath, 'server/program.db'],
  [clipsDir, 'public/clips'],
  [backupDir, 'backups'],
  [rollbackRoot, null],
];
for (const [path, protectedRelativePath] of runtimePaths) {
  const realPath = canonicalPath(path);
  if (protectedRelativePath && path === resolve(app, protectedRelativePath) &&
      realPath === resolve(realApp, protectedRelativePath)) continue;
  if (overlaps(app, path) || overlaps(realApp, realPath)) {
    console.error('Runtime path overlaps unprotected application files: ' + path);
    process.exit(1);
  }
}
JS
REMOTE
}

# Restore a complete code snapshot; runtime files stay in place.
restore_code() {
  remote "$WBRU_APP_DIR" "$rollback_path" <<'REMOTE'
set -euo pipefail
app_dir="$1"
rollback="$2"
grep -Fx -- "app_dir=$app_dir" "$rollback/manifest" >/dev/null
test -f "$rollback/app/package.json"
test -d "$rollback/app/node_modules"
test -d "$rollback/app/dist"
"${service[@]}" stop wbru-visualizer
rsync -a --checksum --delete \
  --include='/node_modules/***' --include='/dist/***' \
  --exclude-from="$rollback/app/deploy/rsync-exclude.txt" \
  "$rollback/app/" "$app_dir/"
"${service[@]}" start wbru-visualizer
REMOTE
}

# Check the running service and database after deployment or code recovery.
verify_production() {
  remote "$WBRU_APP_DIR" <<'REMOTE' || return
set -euo pipefail
cd "$1"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3001/api/channels >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:3001/api/channels >/dev/null
"${service[@]}" is-active --quiet wbru-visualizer
"${service[@]}" is-active --quiet wbru-backup.timer
data_dir="${TAGGER_DATA_DIR:-$PWD/server}"
database_path="${DATABASE_PATH:-$data_dir/program.db}"
integrity="$(node --input-type=module -e '
  import Database from "better-sqlite3";
  const database = new Database(process.argv[1], { readonly: true, fileMustExist: true });
  const result = database.pragma("integrity_check")[0].integrity_check;
  database.close();
  process.stdout.write(result);
' "$database_path")"
[[ "$integrity" == 'ok' ]]
REMOTE
  if [[ -n "$origin" ]]; then
    curl -fsS "$origin/stream.html" >/dev/null
  fi
}

if [[ "$mode" == '--rollback' ]]; then
  preflight
  restore_code
  verify_production
  echo "Restored code from $rollback_path. The production database was not restored."
  exit 0
fi

cd "$WBRU_REPO_ROOT"
commit="$(git rev-parse HEAD)"

assert_release_source() {
  if [[ "$(git rev-parse HEAD)" != "$commit" ]]; then
    echo "Refusing to deploy: HEAD no longer matches $commit. Run validation again." >&2
    exit 1
  fi
  local status
  status="$(git status --porcelain --untracked-files=normal)"
  if [[ -n "$status" ]]; then
    echo "Refusing to deploy a dirty working tree. Commit or remove local changes first." >&2
    exit 1
  fi
}

assert_release_source
release_dir="$(mktemp -d)"
trap 'rm -rf "$release_dir"' EXIT

echo "==> Validating $commit"
npm test
assert_release_source
npm run lint
assert_release_source
npm run build
assert_release_source

# Build the upload from Git so ignored and uncommitted files cannot enter production.
git archive "$commit" | tar -xf - -C "$release_dir"
# rsync copies the root mode too; nginx and the service need to traverse it.
chmod 755 "$release_dir"
printf '%s\n' "$commit" > "$release_dir/REVISION"

preflight

rsync_args=(
  -av
  --no-owner
  --no-group
  --checksum
  --no-times
  --omit-dir-times
  --delete
  --exclude-from="$HERE/rsync-exclude.txt"
)

echo "==> Production changes"
rsync "${rsync_args[@]}" --dry-run --itemize-changes \
  "$release_dir/" "$host:$WBRU_APP_DIR/"

if [[ -z "$mode" ]]; then
  echo
  echo "Dry run only. Deploy with: npm run deploy-code -- $target --apply"
  exit 0
fi

if [[ "$mode" == '--initial' ]]; then
  rsync "${rsync_args[@]}" "$release_dir/" "$host:$WBRU_APP_DIR/"
  echo "Initial code synced. Provision the host with deploy/bootstrap.sh."
  exit 0
fi

echo "==> Creating production rollback"
rollback_path="$(
  remote "$WBRU_APP_DIR" "$commit" "$WBRU_ROLLBACK_DIR" <<'REMOTE'
set -euo pipefail
app_dir="$1"
incoming_commit="$2"
rollback_root="$3"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
rollback="$rollback_root/pre-deploy-$timestamp"
outgoing_commit=unknown
if [[ -s "$app_dir/REVISION" ]]; then
  IFS= read -r outgoing_commit < "$app_dir/REVISION"
fi

umask 077
mkdir -p "$rollback_root"
mkdir "$rollback"
mkdir "$rollback/app" "$rollback/database"

# Snapshot deployed code and built assets without copying runtime data or media.
rsync -a \
  --exclude-from="$app_dir/deploy/rsync-exclude.txt" \
  "$app_dir/" "$rollback/app/"
# Include installed dependencies so recovery does not need npm or a network connection.
for directory in dist node_modules; do
  cp -a "$app_dir/$directory" "$rollback/app/$directory"
done

# Resolve the same database path used by the service.
cd "$app_dir"
data_dir="${TAGGER_DATA_DIR:-$app_dir/server}"
database_path="${DATABASE_PATH:-$data_dir/program.db}"
test -s "$database_path"

# Store a consistent SQLite snapshot beside the code rollback.
DATABASE_PATH="$database_path" BACKUP_DIR="$rollback/database" KEEP=100000 \
  node "$app_dir/scripts/backup-data.mjs" >&2
snapshot="$(find "$rollback/database" -mindepth 2 -maxdepth 2 -name program.db -print -quit)"
test -s "$snapshot"

cd "$app_dir"
integrity="$(node --input-type=module -e '
  import Database from "better-sqlite3";
  const database = new Database(process.argv[1], { readonly: true });
  const result = database.pragma("integrity_check")[0].integrity_check;
  database.close();
  process.stdout.write(result);
' "$snapshot")"
[[ "$integrity" == 'ok' ]]

printf 'outgoing_commit=%s\nincoming_commit=%s\ncreated_at=%s\napp_dir=%s\ndatabase=%s\n' \
  "$outgoing_commit" "$incoming_commit" "$created_at" "$app_dir" "$database_path" \
  > "$rollback/manifest"
printf '%s\n' "$rollback"
REMOTE
)"
echo "Rollback ready: $rollback_path"

# A failed upload, build, or health check restores code only, never the database snapshot.
recover_failed_deploy() {
  local status=$?
  trap - ERR
  echo "Deployment failed. Restoring code from $rollback_path." >&2
  if restore_code && verify_production; then
    echo 'Previous code restored. The production database was not restored.' >&2
  else
    echo "Code recovery failed. Rollback preserved at $rollback_path." >&2
    echo "Retry: npm run deploy-code -- $target --rollback $rollback_path" >&2
  fi
  exit "$status"
}
trap recover_failed_deploy ERR

echo "==> Deploying $commit"
rsync "${rsync_args[@]}" "$release_dir/" "$host:$WBRU_APP_DIR/"

echo "==> Building and restarting production"
remote "$WBRU_APP_DIR" "$commit" <<'REMOTE'
set -euo pipefail
app_dir="$1"
commit="$2"
cd "$app_dir"
test "$(cat REVISION)" = "$commit"
umask 022
# Building on the host needs dev dependencies, but not Git hooks.
HUSKY=0 npm ci --include=dev
npm run build
"${service[@]}" restart wbru-visualizer
REMOTE

verify_production
trap - ERR

cat <<EOF

Deployed $commit to $target.
Rollback: $rollback_path
EOF
