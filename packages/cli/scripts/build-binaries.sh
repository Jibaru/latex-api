#!/usr/bin/env bash
# Builds self-contained executables of the CLI with Bun for GitHub Releases.
# Usage: bash scripts/build-binaries.sh [version]
# Requires: bun >= 1.1 (https://bun.sh), and `pnpm build` having produced dist/cli.mjs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

version="${1:-$(node -p "require('./package.json').version")}"
entry="dist/cli.mjs"
out="release"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required: https://bun.sh" >&2
  exit 1
fi
if [ ! -f "$entry" ]; then
  echo "Missing $entry. Run 'pnpm --filter @jibaru/latex-api-cli build' first." >&2
  exit 1
fi

rm -rf "$out"
mkdir -p "$out"

targets=(
  "bun-linux-x64:latex-api-linux-x64"
  "bun-linux-arm64:latex-api-linux-arm64"
  "bun-darwin-x64:latex-api-darwin-x64"
  "bun-darwin-arm64:latex-api-darwin-arm64"
  "bun-windows-x64:latex-api-windows-x64.exe"
)

for pair in "${targets[@]}"; do
  target="${pair%%:*}"
  name="${pair##*:}"
  echo "==> $name ($target)"
  bun build "$entry" --compile --minify --target="$target" --outfile "$out/$name"
done

(
  cd "$out"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum latex-api-* > "checksums-$version.txt"
  else
    shasum -a 256 latex-api-* > "checksums-$version.txt"
  fi
)

echo
echo "Binaries for v$version:"
ls -la "$out"
