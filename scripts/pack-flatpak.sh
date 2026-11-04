#!/usr/bin/env bash
# A self-contained GNOME runtime also covers hosts with older system libraries.
# Requires a Linux DEB built by pack-linux.sh, flatpak, flatpak-builder and dpkg.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
target="$(cargo metadata --no-deps --format-version 1 | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).target_directory)')"
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf '%s\n' 'Supported architectures: x86_64 and aarch64.' >&2; exit 1 ;;
esac
package="$target/release/bundle/deb/Quervio_${version}_${arch}.deb"
test -f "$package"
work="$(mktemp -d "$target/quervio-flatpak-XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
dpkg-deb --extract "$package" "$work/payload"
cp packaging/linux/com.quervio.app.json "$work/com.quervio.app.json"
mkdir -p "$target/flatpak"
flatpak-builder --user --force-clean --state-dir="$target/flatpak/state" --repo="$target/flatpak/repo" \
  "$work/build" "$work/com.quervio.app.json"
flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo "$target/flatpak/repo" \
  "$target/flatpak/Quervio_${version}_$(uname -m).flatpak" com.quervio.app
