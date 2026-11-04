#!/usr/bin/env bash
# Official, pinned SQL Tools Service; no credentials or shell configuration.
set -euo pipefail
umask 077
version=6.0.20261023.1
case "$(uname -m)" in
  x86_64) arch=x64; expected=36439b45f02f7f6d9b2c77ba9f113c55a9da8e7801825a421bbc23a925a8b5e7 ;;
  aarch64|arm64) arch=arm64; expected=758559c370ccb35bb2baffe2cdda7d57c5b72470166bb7aa81accd3b474575fd ;;
  *) printf '%s\n' 'SQL Tools Service supports Linux x86_64 and aarch64.' >&2; exit 1 ;;
esac
root="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/com.quervio.app/components}"
mkdir -p -- "$root/sqltools"
root="$(cd -- "$root" && pwd)"
directory="$root/sqltools/$version-$arch"
executable="$directory/MicrosoftSqlToolsServiceLayer"
temporary="$(mktemp -d "$root/sqltools/.install-XXXXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
if [[ ! -x "$executable" ]]; then
  printf '%s\n' 'Downloading official SQL Tools Service...'
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://github.com/microsoft/sqltoolsservice/releases/download/$version/Microsoft.SqlTools.ServiceLayer-linux-$arch-net10.0.tar.gz" \
    --output "$temporary/service.tar.gz"
  printf '%s  %s\n' "$expected" "$temporary/service.tar.gz" | sha256sum --check --status
  mkdir -- "$temporary/service"
  tar -xzf "$temporary/service.tar.gz" --no-same-owner -C "$temporary/service"
  test -f "$temporary/service/MicrosoftSqlToolsServiceLayer"
  chmod u+x -- "$temporary/service/MicrosoftSqlToolsServiceLayer"
  # A failed previous install is not trusted or overwritten recursively.
  if [[ -e "$directory" ]]; then
    printf '%s\n' "Incomplete component directory: $directory. Remove it before retrying." >&2
    exit 1
  fi
  mv -- "$temporary/service" "$directory"
fi
# Encode a JSON string without requiring Python or jq on the user's machine.
encoded="${executable//\\/\\\\}"
encoded="${encoded//\"/\\\"}"
encoded="${encoded//$'\n'/\\n}"
encoded="${encoded//$'\r'/\\r}"
encoded="${encoded//$'\t'/\\t}"
printf '"%s"\n' "$encoded" > "$temporary/language.json"
mv -f -- "$temporary/language.json" "$root/language.json"
printf 'SQL Tools Service %s installed and selected.\n' "$version"
