#!/usr/bin/env bash

# Render a text template only when every requested placeholder is valid and present.
render_broadcaster_template() {
  if (($# == 0 || $# % 2 == 0)); then
    echo "ERROR: render_broadcaster_template expects a template and placeholder/value pairs." >&2
    return 1
  fi

  local template_path="$1"
  shift

  if [[ ! -r "${template_path}" ]]; then
    echo "ERROR: broadcaster template is not readable: ${template_path}" >&2
    return 1
  fi

  local rendered placeholder value token
  rendered="$(<"${template_path}")"

  while (($#)); do
    placeholder="$1"
    value="$2"
    shift 2

    if [[ ! "${placeholder}" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      echo "ERROR: invalid broadcaster placeholder name: ${placeholder}" >&2
      return 1
    fi

    token="{{${placeholder}}}"
    if [[ "${rendered}" != *"${token}"* ]]; then
      echo "ERROR: ${template_path} does not contain ${token}." >&2
      return 1
    fi
    while [[ "${rendered}" == *"${token}"* ]]; do
      rendered="${rendered%%"${token}"*}${value}${rendered#*"${token}"}"
    done
  done

  if [[ "${rendered}" == *'{{'*'}}'* ]]; then
    echo "ERROR: unresolved placeholder in ${template_path}." >&2
    return 1
  fi

  printf '%s\n' "${rendered}"
}

# Render to a temporary file, then install it with explicit ownership and mode.
install_broadcaster_template() (
  if (($# < 5 || $# % 2 == 0)); then
    echo "ERROR: install_broadcaster_template received invalid arguments." >&2
    return 1
  fi

  local template_path="$1"
  local destination="$2"
  local mode="$3"
  local owner="$4"
  local group="$5"
  shift 5

  local rendered_file
  rendered_file="$(mktemp)"
  trap 'rm -f "${rendered_file}"' EXIT
  render_broadcaster_template "${template_path}" "$@" >"${rendered_file}" || return 1

  if [[ -n "${owner}" || -n "${group}" ]]; then
    [[ -n "${owner}" && -n "${group}" ]] || {
      echo "ERROR: template owner and group must be set together." >&2
      return 1
    }
    install -m "${mode}" -o "${owner}" -g "${group}" "${rendered_file}" "${destination}"
  else
    install -m "${mode}" "${rendered_file}" "${destination}"
  fi
)
