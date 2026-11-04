#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "$(uname -m)" in
  x86_64) runtime=linux-x64 ;;
  aarch64|arm64) runtime=linux-arm64 ;;
  *) printf '%s\n' 'Supported Linux architectures: x86_64 and aarch64.' >&2; exit 1 ;;
esac
dotnet publish "$root/tools/Quervio.MicrosoftBridge/Quervio.MicrosoftBridge.csproj" \
  -c Release -r "$runtime" --self-contained true \
  -o "$root/src-tauri/resources/linux/microsoft"
