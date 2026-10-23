#!/usr/bin/env bash
# Provision or reconcile the non-root OBS desktop on a Vultr A16 GPU host.
# VNC remains loopback-only and stream credentials remain operator-managed.
set -Eeuo pipefail

OBS_USER="${OBS_USER:-obs}"
DISPLAY_GEOMETRY="${DISPLAY_GEOMETRY:-1600x900}"
VNC_PORT="${VNC_PORT:-5900}"
AUTOSTART_OBS="${AUTOSTART_OBS-}"
RESTART_LIGHTDM="${RESTART_LIGHTDM:-0}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BROADCASTER_DIR="${SCRIPT_DIR}/broadcaster"
TEMPLATE_DIR="${BROADCASTER_DIR}/templates"

# Values discovered during provisioning and used by later phases.
OBS_HOME=''
OBS_GROUP=''
lightdm_was_active=0
renderer=''
obs_autostart_status=''

trap 'echo "ERROR: setup failed at line ${LINENO}" >&2' ERR

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# shellcheck source=deploy/broadcaster/render-template.sh
source "${BROADCASTER_DIR}/render-template.sh"

# Validate operator input before changing packages, accounts, or services.
validate_configuration() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Run this script as root."
  fi

  [[ "${OBS_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
    die "OBS_USER must be a valid Linux username."
  [[ "${OBS_USER}" != root ]] ||
    die "OBS_USER must not be root."
  [[ "${DISPLAY_GEOMETRY}" =~ ^[0-9]{3,5}x[0-9]{3,5}$ ]] ||
    die "DISPLAY_GEOMETRY must look like 1600x900."
  [[ "${VNC_PORT}" =~ ^[0-9]+$ ]] ||
    die "VNC_PORT must be numeric."
  ((VNC_PORT >= 1024 && VNC_PORT <= 65535)) ||
    die "VNC_PORT must be between 1024 and 65535."
  [[ -z "${AUTOSTART_OBS}" || "${AUTOSTART_OBS}" == 0 || "${AUTOSTART_OBS}" == 1 ]] ||
    die "AUTOSTART_OBS must be omitted, 0, or 1."
  [[ "${RESTART_LIGHTDM}" == 0 || "${RESTART_LIGHTDM}" == 1 ]] ||
    die "RESTART_LIGHTDM must be 0 or 1."
}

# Confirm the supported host image and remember whether its desktop is already active.
verify_host() {
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 ]]; then
    die "This script supports only Vultr's GPU-prepared Ubuntu 24.04 image."
  fi

  command -v systemctl >/dev/null ||
    die "systemd is required."
  command -v nvidia-smi >/dev/null ||
    die "nvidia-smi is missing. Redeploy with Vultr's GPU-prepared Ubuntu 24.04 image."

  lightdm_was_active=0
  if systemctl is-active --quiet lightdm.service; then
    lightdm_was_active=1
  fi
}

# Refuse setup until the virtual GPU reports an active NVIDIA license.
verify_gpu_license() {
  local licensed=0

  log "Verify NVIDIA hardware and vGPU licensing"
  nvidia-smi -L

  if systemctl list-unit-files nvidia-gridd.service --no-legend 2>/dev/null |
    grep -q '^nvidia-gridd\.service'; then
    systemctl enable --now nvidia-gridd.service
  fi

  for _ in {1..15}; do
    if nvidia-smi -q | grep -Eq 'License Status[[:space:]]*:[[:space:]]*Licensed'; then
      licensed=1
      break
    fi
    sleep 2
  done

  if ((licensed == 0)); then
    cat >&2 <<'EOF'
ERROR: The NVIDIA vGPU is not licensed. Do not run OBS in this state: NVIDIA
will progressively cap its frame rate. Check:

  systemctl status nvidia-gridd --no-pager -l
  nvidia-smi -q | grep -i -A 5 license

On a supported Vultr image, repair the Vultr driver/licensing bundle before
rerunning this script.
EOF
    exit 1
  fi
  nvidia-smi -q | grep -i -A 5 'vGPU Software Licensed Product' || true
}

# Install the desktop, VNC, OBS, and GPU diagnostic packages required by the broadcaster.
install_broadcaster_packages() {
  log "Install Xfce, LightDM, TigerVNC, OBS Studio, and diagnostics"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  printf '%s\n' 'lightdm shared/default-x-display-manager select lightdm' |
    debconf-set-selections
  apt-get install -y \
    accountsservice \
    dbus-x11 \
    ffmpeg \
    lightdm \
    mesa-utils \
    nvidia-xconfig \
    software-properties-common \
    tigervnc-scraping-server \
    tigervnc-tools \
    xclip \
    xdg-utils \
    x11-xserver-utils \
    xfce4 \
    xfce4-terminal

  if ! grep -Rhsq 'ppa.launchpadcontent.net/obsproject/obs-studio' \
    /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
    add-apt-repository -y ppa:obsproject/obs-studio
  fi
  apt-get update
  apt-get install -y obs-studio
}

# Create the non-root desktop account and its reusable VNC credentials.
configure_broadcaster_account() {
  local new_vnc_password=''
  local confirm_vnc_password=''
  local password_file=''

  log "Create the non-root OBS desktop account"
  if ! id "${OBS_USER}" >/dev/null 2>&1; then
    adduser --disabled-password --gecos '' "${OBS_USER}"
  fi
  usermod -aG audio,video,render "${OBS_USER}"

  OBS_HOME="$(getent passwd "${OBS_USER}" | cut -d: -f6)"
  OBS_GROUP="$(id -gn "${OBS_USER}")"
  [[ -n "${OBS_HOME}" && "${OBS_HOME}" == /* ]] ||
    die "Could not determine the home directory for ${OBS_USER}."

  install -d -m 700 -o "${OBS_USER}" -g "${OBS_GROUP}" "${OBS_HOME}/.vnc"
  install -d -m 755 -o "${OBS_USER}" -g "${OBS_GROUP}" \
    "${OBS_HOME}/.config/autostart"

  if [[ -n "${VNC_PASSWORD:-}" ]]; then
    new_vnc_password="${VNC_PASSWORD}"
  elif [[ -s "${OBS_HOME}/.vnc/passwd" ]]; then
    new_vnc_password=''
    echo "Reusing the existing VNC password."
  elif [[ -t 0 ]]; then
    while :; do
      read -r -s -p 'VNC password (6-8 characters): ' new_vnc_password
      echo
      read -r -s -p 'Confirm VNC password: ' confirm_vnc_password
      echo
      if [[ "${new_vnc_password}" != "${confirm_vnc_password}" ]]; then
        echo "Passwords do not match."
      elif ((${#new_vnc_password} < 6 || ${#new_vnc_password} > 8)); then
        echo "TigerVNC VncAuth passwords must be 6-8 characters."
      else
        break
      fi
    done
  else
    die "Set VNC_PASSWORD for non-interactive setup."
  fi

  if [[ -n "${new_vnc_password}" ]]; then
    ((${#new_vnc_password} >= 6 && ${#new_vnc_password} <= 8)) ||
      die "VNC_PASSWORD must be 6-8 characters."
    password_file="$(mktemp)"
    trap 'rm -f "${password_file:-}"' EXIT
    printf '%s\n' "${new_vnc_password}" | tigervncpasswd -f >"${password_file}"
    install -m 600 -o "${OBS_USER}" -g "${OBS_GROUP}" \
      "${password_file}" "${OBS_HOME}/.vnc/passwd"
    rm -f "${password_file}"
    trap - EXIT
    unset VNC_PASSWORD new_vnc_password confirm_vnc_password
  fi
}

# Configure an unattended Xfce session backed by the NVIDIA headless display.
configure_desktop() {
  local desktop_id
  local display_ready=0

  log "Configure LightDM autologin and the NVIDIA headless Xorg display"
  install_broadcaster_template \
    "${TEMPLATE_DIR}/obs-disable-blanking" \
    /usr/local/bin/obs-disable-blanking \
    755 root root
  install_broadcaster_template \
    "${TEMPLATE_DIR}/obs-disable-blanking.desktop" \
    "${OBS_HOME}/.config/autostart/obs-disable-blanking.desktop" \
    644 root root

  # The unattended autologin session must not start locking or power-management daemons.
  for desktop_id in \
    light-locker.desktop \
    xfce4-power-manager.desktop \
    xfce4-screensaver.desktop; do
    install_broadcaster_template \
      "${TEMPLATE_DIR}/disabled-autostart.desktop" \
      "${OBS_HOME}/.config/autostart/${desktop_id}" \
      644 root root
  done
  chown -R "${OBS_USER}:${OBS_GROUP}" "${OBS_HOME}/.config/autostart"

  install -d -m 755 /etc/lightdm/lightdm.conf.d
  install_broadcaster_template \
    "${TEMPLATE_DIR}/50-obs-autologin.conf" \
    /etc/lightdm/lightdm.conf.d/50-obs-autologin.conf \
    644 root root \
    OBS_USER "${OBS_USER}"

  nvidia-xconfig \
    --allow-empty-initial-configuration \
    --virtual="${DISPLAY_GEOMETRY}"

  systemctl set-default graphical.target
  if ((lightdm_was_active == 1)) && [[ "${RESTART_LIGHTDM}" != 1 ]]; then
    log "Keep the active LightDM desktop running"
    echo "Any LightDM and Xorg changes will apply at the next reboot."
    echo "Set RESTART_LIGHTDM=1 to apply them now; that stops OBS and disconnects VNC."
  else
    if ((lightdm_was_active == 1)); then
      log "Restart LightDM (stops OBS and disconnects VNC)"
    else
      log "Start the LightDM desktop"
    fi
    systemctl restart lightdm.service
  fi

  for _ in {1..30}; do
    if [[ -S /tmp/.X11-unix/X0 && -f "${OBS_HOME}/.Xauthority" ]]; then
      display_ready=1
      break
    fi
    sleep 1
  done

  if ((display_ready == 0)); then
    systemctl status lightdm.service --no-pager -l || true
    die "LightDM did not create display :0."
  fi

  renderer="$(
    runuser -u "${OBS_USER}" -- env \
      DISPLAY=:0 \
      XAUTHORITY="${OBS_HOME}/.Xauthority" \
      glxinfo -B 2>&1
  )"
  echo "${renderer}" | grep -E 'OpenGL vendor|OpenGL renderer'
  echo "${renderer}" | grep -qi nvidia ||
    die "Xorg is not using the NVIDIA renderer."
  if echo "${renderer}" | grep -qi llvmpipe; then
    die "Xorg fell back to the llvmpipe software renderer."
  fi
}

# Expose the active desktop through a loopback-only systemd VNC service.
configure_vnc() {
  local vnc_ready=0

  log "Install a stable, localhost-only VNC service"
  install_broadcaster_template \
    "${TEMPLATE_DIR}/x0tigervnc.service" \
    /etc/systemd/system/x0tigervnc.service \
    644 root root \
    OBS_USER "${OBS_USER}" \
    OBS_HOME "${OBS_HOME}" \
    VNC_PORT "${VNC_PORT}"

  systemctl daemon-reload
  systemctl enable x0tigervnc.service
  systemctl restart x0tigervnc.service
  systemctl is-active --quiet x0tigervnc.service ||
    die "TigerVNC failed to start. Run: journalctl -u x0tigervnc -b --no-pager"

  for _ in {1..10}; do
    if ss -ltn | grep -Eq "127\\.0\\.0\\.1:${VNC_PORT}[[:space:]]"; then
      vnc_ready=1
      break
    fi
    sleep 1
  done
  if ((vnc_ready == 0)); then
    systemctl status x0tigervnc.service --no-pager -l || true
    die "TigerVNC is not listening on loopback port ${VNC_PORT}."
  fi
}

# Install the hardware-accelerated OBS launcher and reconcile its autostart setting.
configure_obs_launcher() {
  local autostart_file

  log "Install the GPU/autoplay OBS launcher"
  install_broadcaster_template \
    "${TEMPLATE_DIR}/obs-gpu" \
    /usr/local/bin/obs-gpu \
    755 root root

  install -d -m 755 -o "${OBS_USER}" -g "${OBS_GROUP}" \
    "${OBS_HOME}/.local/share/applications"
  install_broadcaster_template \
    "${TEMPLATE_DIR}/obs-gpu.desktop" \
    "${OBS_HOME}/.local/share/applications/obs-gpu.desktop" \
    644 "${OBS_USER}" "${OBS_GROUP}"

  autostart_file="${OBS_HOME}/.config/autostart/obs-gpu.desktop"
  case "${AUTOSTART_OBS}" in
    1)
      install_broadcaster_template \
        "${TEMPLATE_DIR}/obs-gpu-autostart.desktop" \
        "${autostart_file}" \
        644 "${OBS_USER}" "${OBS_GROUP}"
      ;;
    0)
      rm -f "${autostart_file}"
      ;;
  esac

  if [[ -f "${autostart_file}" ]]; then
    obs_autostart_status=enabled
  else
    obs_autostart_status=disabled
  fi
}

# Report the installed OBS version, renderer, license, and VNC listener.
verify_broadcaster() {
  log "Verification"
  echo "OBS: $(obs --version)"
  echo "GPU renderer:"
  echo "${renderer}" | grep -E 'OpenGL vendor|OpenGL renderer'
  echo "vGPU license:"
  nvidia-smi -q | grep -i -A 5 'vGPU Software Licensed Product' || true
  echo "VNC listener:"
  ss -ltn | grep -E "127\\.0\\.0\\.1:${VNC_PORT}[[:space:]]"
}

# Print the connection and OBS settings the operator needs after provisioning.
print_next_steps() {
  cat <<EOF

Broadcaster setup complete.

From your Mac, keep this SSH tunnel running:

  ssh -N -L ${VNC_PORT}:127.0.0.1:${VNC_PORT} root@SERVER_IP

Then connect a VNC client to:

  127.0.0.1::${VNC_PORT}

Launch "OBS Studio (GPU)" from the Xfce Applications menu.

In OBS:
  - Settings -> Advanced -> Sources:
      Enable Browser Source Hardware Acceleration
  - Settings -> Output:
      Encoder = Hardware (NVENC, H.264)
  - Settings -> Video:
      FPS = 30
  - Do not enter Twitch credentials in the VPS browser; paste a stream key.

To place your Mac clipboard into the remote desktop:

  pbpaste | ssh root@SERVER_IP \\
    'runuser -u ${OBS_USER} -- env DISPLAY=:0 XAUTHORITY=${OBS_HOME}/.Xauthority xclip -selection clipboard -in'

OBS autostart is ${obs_autostart_status}. Omitting AUTOSTART_OBS preserves this setting;
set it to 1 or 0 to change the setting on a later run.
EOF
}

# Run provisioning in dependency order so each phase can rely on the previous one.
main() {
  validate_configuration
  verify_host
  verify_gpu_license
  install_broadcaster_packages
  configure_broadcaster_account
  configure_desktop
  configure_vnc
  configure_obs_launcher
  verify_broadcaster
  print_next_steps
}

main "$@"
