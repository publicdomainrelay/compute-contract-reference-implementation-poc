#!/usr/bin/env bash
# Install + enable all prod systemd units for the compute-contract reference
# implementation. Symlinks each unit from its source dir into
# /etc/systemd/system, reloads systemd, then enables --now.
#
# Idempotent: re-running re-points symlinks and restarts units.
# Run as a user with sudo. Units run as User=johnandersen777.
set -euo pipefail

PROD_ROOT="${HOME}/prod-compute-contract-reference-implementation-poc"

do_it() {
  if [ ! -d "${PROD_ROOD}" ]; then
    git clone https://github.com/publicdomainrelay/compute-contract-reference-implementation-poc "${PROD_ROOT}"
  fi

  TS="${PROD_ROOT}/src/typescript"
  SYSTEMD_DIR="/etc/systemd/system"

  # unit_file:relative_dir
  UNITS=(
    "bidder-tunnel.service:bidder"
    "bidder.service:bidder"
    "spindle.service:spindle"
    "qemu.service:qemu"
  )

  echo "==> Installing unit symlinks into ${SYSTEMD_DIR}"
  for entry in "${UNITS[@]}"; do
    unit="${entry%%:*}"
    dir="${entry##*:}"
    src="${TS}/${dir}/${unit}"
    if [ ! -f "$src" ]; then
      echo "error: missing unit $src" >&2
      exit 1
    fi
    echo "  ln -sf $src ${SYSTEMD_DIR}/${unit}"
    sudo ln -sf "$src" "${SYSTEMD_DIR}/${unit}"
  done

  echo "==> systemctl daemon-reload"
  sudo systemctl daemon-reload

  echo "==> enable --now"
  for entry in "${UNITS[@]}"; do
    unit="${entry%%:*}"
    echo "  $unit"
    sudo systemctl enable --now "$unit"
  done

  echo "==> status"
  for entry in "${UNITS[@]}"; do
    unit="${entry%%:*}"
    systemctl --no-pager --lines=0 status "$unit" || true
  done

  echo "Done. Tail logs: journalctl -u spindle -u bidder -u qemu -u bidder-tunnel -f"
}

do_it
