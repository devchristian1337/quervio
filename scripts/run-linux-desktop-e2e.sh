#!/usr/bin/env bash
# Headless Linux wrapper for WebdriverIO + @wdio/tauri-service real desktop E2E tests.
# Starts an isolated D-Bus session, Xvfb virtual display, and unlocked disposable GNOME Keyring,
# then delegates to scripts/run-desktop-e2e.mjs (which isolates profile data and optional Docker SQL).
set -euo pipefail
umask 077

if [[ "${QUERVIO_LINUX_E2E_SESSION:-}" != 1 ]]; then
  keyring_root="$(mktemp -d)"
  cleanup() {
    rm -rf -- "$keyring_root"
  }
  trap cleanup EXIT
  export GNOME_KEYRING_CONTROL="$keyring_root/keyring-control"
  export XDG_RUNTIME_DIR="$keyring_root/runtime"
  mkdir -p "$GNOME_KEYRING_CONTROL" "$XDG_RUNTIME_DIR"
  dbus-run-session -- xvfb-run -a -s '-screen 0 1600x1000x24' \
    env QUERVIO_LINUX_E2E_SESSION=1 bash "$0" "$@"
  exit $?
fi

printf 'quervio-disposable-e2e-keyring\n' | gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" >/dev/null
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
exec node scripts/run-desktop-e2e.mjs "$@"
