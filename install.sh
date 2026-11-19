#!/usr/bin/env bash
# Riyeser Accounting installer (macOS / Linux)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${RIYESER_PREFIX:-$HOME/.riyeser/app}"
command -v python3 >/dev/null || { echo "Python 3.10+ is required: https://www.python.org/downloads/"; exit 1; }
echo "Installing Riyeser Accounting into $PREFIX ..."
python3 -m venv "$PREFIX"
"$PREFIX/bin/pip" install --quiet --upgrade pip
"$PREFIX/bin/pip" install --quiet "$HERE"
mkdir -p "$HOME/.local/bin"
ln -sf "$PREFIX/bin/riyeser" "$HOME/.local/bin/riyeser"
echo
echo "Done. Start it with:   riyeser"
echo "(If 'riyeser' is not found, add \$HOME/.local/bin to your PATH or run $PREFIX/bin/riyeser)"
