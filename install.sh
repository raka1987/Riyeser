#!/usr/bin/env bash
# Riyser Accounting installer (macOS / Linux)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${RIYSER_PREFIX:-$HOME/.riyser/app}"
command -v python3 >/dev/null || { echo "Python 3.10+ is required: https://www.python.org/downloads/"; exit 1; }
echo "Installing Riyser Accounting into $PREFIX ..."
python3 -m venv "$PREFIX"
"$PREFIX/bin/pip" install --quiet --upgrade pip
"$PREFIX/bin/pip" install --quiet "$HERE"
mkdir -p "$HOME/.local/bin"
ln -sf "$PREFIX/bin/riyser" "$HOME/.local/bin/riyser"
echo
echo "Done. Start it with:   riyser"
echo "(If 'riyser' is not found, add \$HOME/.local/bin to your PATH or run $PREFIX/bin/riyser)"
