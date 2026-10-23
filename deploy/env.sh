#!/usr/bin/env bash

# Shared local deployment configuration. Scripts source this file; it is also useful
# interactively (`source deploy/env.sh`) when running ssh, rsync, or curl by hand.
if [ -z "${WBRU_REPO_ROOT:-}" ]; then
  WBRU_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
WBRU_ENV_FILE="${WBRU_ENV_FILE:-${WBRU_REPO_ROOT}/.env}"

if [ -f "$WBRU_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$WBRU_ENV_FILE"
fi

export WBRU_SSH_USER="${WBRU_SSH_USER:-root}"
export WBRU_APP_DIR="${WBRU_APP_DIR:-/srv/wbru/app}"
export WBRU_CLIPS_DIR="${WBRU_CLIPS_DIR:-/srv/wbru/clips}"
export WBRU_SERVICE_SCOPE="${WBRU_SERVICE_SCOPE:-system}"
export WBRU_REMOTE_ENV_FILE="${WBRU_REMOTE_ENV_FILE:-/etc/wbru-visualizer.env}"
export WBRU_ROLLBACK_DIR="${WBRU_ROLLBACK_DIR:-/srv/wbru/rollbacks}"
export WBRU_REPO_ROOT WBRU_ENV_FILE

if [ -n "${WBRU_VISUALIZER_HOST:-}" ]; then
  export WBRU_VISUALIZER_HOST
  export WBRU_VISUALIZER_SSH="${WBRU_SSH_USER}@${WBRU_VISUALIZER_HOST}"
  export WBRU_VISUALIZER_ORIGIN="${WBRU_VISUALIZER_ORIGIN:-http://${WBRU_VISUALIZER_HOST}}"
fi
if [ -n "${WBRU_TV_HOST:-}" ]; then
  export WBRU_TV_HOST
  export WBRU_TV_SSH="${WBRU_SSH_USER}@${WBRU_TV_HOST}"
  export WBRU_TV_ORIGIN="${WBRU_TV_ORIGIN:-http://${WBRU_TV_HOST}}"
fi

# Resolve a named deployment role to the configured SSH destination.
wbru_ssh_target() {
  case "${1:-}" in
    visualizer)
      printf '%s\n' "${WBRU_VISUALIZER_SSH:?Set WBRU_VISUALIZER_HOST in .env}"
      ;;
    tv)
      printf '%s\n' "${WBRU_TV_SSH:?Set WBRU_TV_HOST in .env}"
      ;;
    *)
      echo "Unknown deployment target: ${1:-<missing>} (use visualizer or tv)" >&2
      return 2
      ;;
  esac
}
