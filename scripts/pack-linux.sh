#!/usr/bin/env bash
# Build natively on the target architecture. Does not publish or change Git.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if [[ $# != 0 && ( $# != 1 || "$1" != --flatpak ) ]]; then
  printf '%s\n' 'Usage: bash scripts/pack-linux.sh [--flatpak]' >&2
  exit 1
fi
if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'Run this script on Linux (or in a Linux build environment).' >&2
  exit 1
fi
for tool in cargo dotnet pnpm node curl sha256sum tar; do
  command -v "$tool" >/dev/null || { printf 'Missing build tool: %s\n' "$tool" >&2; exit 1; }
done
pnpm install --frozen-lockfile
bash scripts/build-microsoft.sh
bash scripts/install-sqltools.sh "$root/target/linux-components"
service="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))' "$root/target/linux-components/language.json")"
mkdir -p src-tauri/resources/linux/sqltools
cp -a -- "$(dirname -- "$service")/." src-tauri/resources/linux/sqltools/
# Optional CoreCLR LTTng profiling provider, not used by Quervio or SQL
# Extended Events. It links an obsolete liblttng-ust.so.0 on newer hosts and
# makes linuxdeploy reject an otherwise working self-contained runtime.
rm -f -- src-tauri/resources/linux/microsoft/libcoreclrtraceptprovider.so \
  src-tauri/resources/linux/sqltools/libcoreclrtraceptprovider.so
# The component installer deliberately uses private permissions. Distributed
# resources must also be readable/executable when owned by root in a package.
chmod -R u+rwX,go+rX,go-w -- src-tauri/resources/linux/microsoft src-tauri/resources/linux/sqltools
chmod 644 -- scripts/install-sqltools.sh
src-tauri/resources/linux/microsoft/Quervio.MicrosoftBridge --self-test
# Linuxdeploy can extract its own AppImage when FUSE is absent in CI/WSL.
export APPIMAGE_EXTRACT_AND_RUN=1
pnpm tauri build --no-bundle
bash scripts/bundle-linux.sh
if [[ "${1:-}" == --flatpak ]]; then
  bash scripts/pack-flatpak.sh
fi
