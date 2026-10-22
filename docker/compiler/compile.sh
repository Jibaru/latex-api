#!/bin/sh
# Usage: compile <engine> <entrypoint> [bibliography=auto|bibtex|biber|none] [timeout-seconds]
# Compiles in place inside /work. Output: <jobname>.pdf and <jobname>.log next to the entrypoint.
set -u

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "" ]; then
  echo "usage: compile <pdflatex|xelatex|lualatex> <entrypoint.tex> [auto|bibtex|biber|none] [timeout_s]"
  echo "version: $(cat /etc/latex-compiler-version)"
  exit 0
fi
if [ "${1:-}" = "--version" ]; then cat /etc/latex-compiler-version; exit 0; fi

ENGINE="$1"; MAIN="$2"; BIB="${3:-auto}"; TIMEOUT_S="${4:-0}"

mkdir -p "$HOME" "$TEXMFVAR" "$TEXMFCONFIG" 2>/dev/null || true
cd /work || { echo "latex-api: /work is not mounted" >&2; exit 90; }

DIR=$(dirname -- "$MAIN"); BASE=$(basename -- "$MAIN")
cd "$DIR" || { echo "latex-api: entrypoint directory not found: $DIR" >&2; exit 92; }
[ -f "$BASE" ] || { echo "latex-api: entrypoint not found: $MAIN" >&2; exit 92; }

case "$ENGINE" in
  pdflatex) EOPT="-pdf" ;;
  xelatex)  EOPT="-xelatex" ;;
  lualatex) EOPT="-lualatex" ;;
  *) echo "latex-api: unknown engine: $ENGINE" >&2; exit 91 ;;
esac
case "$BIB" in
  none)   BOPT="-bibtex-" ;;
  bibtex) BOPT="-bibtex" ;;
  biber)  BOPT="-bibtex" ;;
  *)      BOPT="-bibtex-cond1" ;;
esac

# shell escape is already disabled in texmf.cnf; -no-shell-escape makes it explicit.
export max_print_line=10000 error_line=254 half_error_line=238
set -- latexmk "$EOPT" "$BOPT" -norc -interaction=nonstopmode -halt-on-error -file-line-error \
  -pdflatex="pdflatex -no-shell-escape %O %S" \
  -xelatex="xelatex -no-shell-escape %O %S" \
  -lualatex="lualatex -no-shell-escape %O %S" \
  -silent -logfilewarninglist "$BASE"

if [ "$TIMEOUT_S" -gt 0 ] 2>/dev/null; then
  exec timeout -s KILL "$TIMEOUT_S" "$@"
else
  exec "$@"
fi
