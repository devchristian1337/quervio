#!/usr/bin/env bash
# Stable public download names, separate from Tauri's versioned build files.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
target="$(cargo metadata --no-deps --format-version 1 | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).target_directory)')"
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
case "$(uname -m)" in
  x86_64) architecture=x64; deb_arch=amd64 ;;
  aarch64|arm64) architecture=arm64; deb_arch=arm64 ;;
  *) printf '%s\n' 'Unsupported release architecture.' >&2; exit 1 ;;
esac
images=("$target/release/bundle/appimage/Quervio_${version}_"*.AppImage)
if [[ ${#images[@]} != 1 || ! -f "${images[0]}" ]]; then
  printf '%s\n' 'Expected one AppImage for this version and architecture.' >&2
  exit 1
fi
destination="$target/linux-release"
mkdir -p "$destination"
cp -- "${images[0]}" "$destination/Quervio-linux-$architecture.AppImage"
cp -- "$target/release/bundle/deb/Quervio_${version}_${deb_arch}.deb" "$destination/Quervio-linux-$architecture.deb"
cp -- "$target/release/bundle/rpm/Quervio-${version}-1.$(uname -m).rpm" "$destination/Quervio-linux-$architecture.rpm"
cp -- "$target/flatpak/Quervio_${version}_$(uname -m).flatpak" "$destination/Quervio-linux-$architecture.flatpak"
cd "$destination"
sha256sum "Quervio-linux-$architecture.AppImage" "Quervio-linux-$architecture.deb" \
  "Quervio-linux-$architecture.rpm" "Quervio-linux-$architecture.flatpak" > "SHA256SUMS-linux-$architecture.txt"
