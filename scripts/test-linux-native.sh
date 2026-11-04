#!/usr/bin/env bash
# Real packaged WebKitGTK application, without ?mock or saved user profiles.
# Requires tauri-driver, WebKitWebDriver, xvfb-run and GNOME Keyring.
set -euo pipefail
umask 077
if [[ "${QUERVIO_PRIVATE_NATIVE_TEST:-}" != 1 ]]; then
  if [[ "${QUERVIO_NATIVE_FORMAT:-appimage}" == flatpak ]]; then
    flatpak info --user com.quervio.app >/dev/null
    export QUERVIO_FLATPAK_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
  fi
  profile="$(mktemp -d)"
  cleanup() {
    # The private document portal can still be unmounting as its bus exits.
    if command -v fusermount3 >/dev/null; then fusermount3 -uz "$profile/runtime/doc" 2>/dev/null || true; fi
    rm -rf -- "$profile"
  }
  trap cleanup EXIT
  export QUERVIO_NATIVE_PROFILE="$profile"
  export XDG_DATA_HOME="$profile/data"
  export XDG_CONFIG_HOME="$profile/config"
  export XDG_CACHE_HOME="$profile/cache"
  export XDG_RUNTIME_DIR="$profile/runtime"
  export GNOME_KEYRING_CONTROL="$profile/keyring-control"
  export TMPDIR="$profile/tmp"
  mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$TMPDIR"
  dbus-run-session -- xvfb-run -a -s '-screen 0 1600x1000x24' \
    env QUERVIO_PRIVATE_NATIVE_TEST=1 bash "$0" "$@"
  exit $?
fi
: "${QUERVIO_NATIVE_PROFILE:?Run the outer test wrapper}"
export APPIMAGE_EXTRACT_AND_RUN=1
unset QUERVIO_MICROSOFT_BRIDGE QUERVIO_SQLTOOLS_SERVICE
printf 'quervio-disposable-native-keyring\n' | gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" >/dev/null
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
target="$(cargo metadata --no-deps --format-version 1 | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).target_directory)')"
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
if [[ "${QUERVIO_NATIVE_FORMAT:-appimage}" == flatpak ]]; then
  application="$QUERVIO_NATIVE_PROFILE/flatpak-test-launcher"
  cat > "$QUERVIO_NATIVE_PROFILE/flatpak-app-launcher" <<'APP_LAUNCHER'
#!/bin/sh
# Flatpak sets its own XDG_* variables after applying --env. Override them
# only inside this disposable test process, after entering the sandbox.
export XDG_DATA_HOME="$QUERVIO_TEST_DATA_HOME"
export XDG_CONFIG_HOME="$QUERVIO_TEST_CONFIG_HOME"
export XDG_CACHE_HOME="$QUERVIO_TEST_CACHE_HOME"
export TMPDIR="$QUERVIO_TEST_TMPDIR"
exec /app/bin/quervio "$@"
APP_LAUNCHER
  cat > "$application" <<'LAUNCHER'
#!/usr/bin/env bash
profile_data="$XDG_DATA_HOME"
export XDG_DATA_HOME="$QUERVIO_FLATPAK_DATA_HOME"
exec flatpak run --user --command=/bin/sh --filesystem="$QUERVIO_NATIVE_PROFILE" \
  --env=QUERVIO_TEST_DATA_HOME="$profile_data" --env=QUERVIO_TEST_CONFIG_HOME="$XDG_CONFIG_HOME" \
  --env=QUERVIO_TEST_CACHE_HOME="$XDG_CACHE_HOME" --env=QUERVIO_TEST_TMPDIR="$TMPDIR" \
  --env=TAURI_AUTOMATION=true --env=GDK_BACKEND=x11 \
  --env=WEBKIT_INSPECTOR_SERVER="${WEBKIT_INSPECTOR_SERVER:-}" \
  com.quervio.app "$QUERVIO_NATIVE_PROFILE/flatpak-app-launcher" "$@"
LAUNCHER
  chmod 700 "$application"
else
  images=("$target/release/bundle/appimage/Quervio_${version}_"*.AppImage)
  if [[ $# == 0 && ${#images[@]} != 1 ]]; then
    printf '%s\n' 'Expected one AppImage for the current version.' >&2
    exit 1
  fi
  application="${1:-${images[0]}}"
fi
test -x "$application"
node tests/native/linux-smoke.mjs "$application" "$target/linux-smoke/${QUERVIO_NATIVE_FORMAT:-appimage}"
