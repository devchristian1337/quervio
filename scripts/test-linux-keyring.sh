#!/usr/bin/env bash
# Run in a private D-Bus session: never touches the desktop's real keyring.
set -euo pipefail
umask 077
if [[ "${QUERVIO_PRIVATE_TEST_BUS:-}" != 1 ]]; then
  exec dbus-run-session -- env QUERVIO_PRIVATE_TEST_BUS=1 bash "$0"
fi
profile="$(mktemp -d)"
trap 'rm -rf -- "$profile"' EXIT
export XDG_DATA_HOME="$profile/data"
export XDG_CONFIG_HOME="$profile/config"
export XDG_CACHE_HOME="$profile/cache"
export GNOME_KEYRING_CONTROL="$profile/keyring-control"
export QUERVIO_TEST_KEYRING=1
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
printf 'quervio-disposable-test-keyring\n' | gnome-keyring-daemon --unlock --components=secrets --control-directory="$GNOME_KEYRING_CONTROL" >/dev/null
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cargo test --locked --manifest-path "$root/Cargo.toml" --workspace \
  linux_keyring_round_trip_and_profile_isolation -- --ignored
