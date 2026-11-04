#!/usr/bin/env bash
# Repackage an existing release binary with fresh component payloads.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
target="$(cargo metadata --no-deps --format-version 1 | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).target_directory)')"
target="$(realpath -- "$target")"
release="$target/release"
test -x "$release/quervio"
test -x src-tauri/resources/linux/microsoft/Quervio.MicrosoftBridge
test -x src-tauri/resources/linux/sqltools/MicrosoftSqlToolsServiceLayer
# Build scripts can leave removed resources in target/. Replace only this
# app's generated component directories and AppImage staging directories.
for directory in "$release/microsoft" "$release/sqltools" \
  "$release/bundle/appimage/Quervio.AppDir" "$release/bundle/appimage_deb"; do
  resolved="$(realpath -m -- "$directory")"
  case "$resolved" in "$release/"*) ;; *) printf 'Unsafe output path: %s\n' "$resolved" >&2; exit 1 ;; esac
  rm -rf -- "$directory"
done
cp -a -- src-tauri/resources/linux/microsoft "$release/microsoft"
cp -a -- src-tauri/resources/linux/sqltools "$release/sqltools"
cp -- scripts/install-sqltools.sh "$release/install-sqltools.sh"
# Optional LTTng tracing is not a dependency of the application's SQL tools.
rm -f -- "$release/microsoft/libcoreclrtraceptprovider.so" "$release/sqltools/libcoreclrtraceptprovider.so"
chmod -R u+rwX,go+rX,go-w -- "$release/microsoft" "$release/sqltools"
chmod 644 -- "$release/install-sqltools.sh"
"$release/microsoft/Quervio.MicrosoftBridge" --self-test
export APPIMAGE_EXTRACT_AND_RUN=1
pnpm tauri bundle --bundles appimage,deb,rpm "$@"
