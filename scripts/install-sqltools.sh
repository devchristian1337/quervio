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
  (cd -- "$temporary" && printf '%s  service.tar.gz\n' "$expected" | sha256sum --check --status)
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
# Encode a JSON string (RFC 8259, including all U+0000..U+001F control chars)
# without requiring Python or jq on the user's machine.
json_escape() {
  local LC_ALL=C s="$1" out="" i ch ord
  for (( i = 0; i < ${#s}; i++ )); do
    ch="${s:i:1}"
    case "$ch" in
      '\') out+='\\' ;;
      '"') out+='\"' ;;
      $'\b') out+='\b' ;;
      $'\f') out+='\f' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      *)
        printf -v ord '%d' "'$ch"
        if (( ord >= 0 && ord < 32 )); then
          printf -v ch '\\u%04x' "$ord"
        fi
        out+="$ch"
        ;;
    esac
  done
  printf '%s' "$out"
}
encoded="$(json_escape "$executable")"
printf '"%s"\n' "$encoded" > "$temporary/language.json"
mv -f -- "$temporary/language.json" "$root/language.json"
printf 'SQL Tools Service %s installed and selected.\n' "$version"
