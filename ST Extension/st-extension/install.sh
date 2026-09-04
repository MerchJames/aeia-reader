#!/usr/bin/env bash
#
# Put the Aeia Bridge into SillyTavern.
#
#   ./install.sh
#   ./install.sh /path/to/SillyTavern
#   ./install.sh /path/to/SillyTavern other-user
#
# Copies one folder. Touches nothing else in SillyTavern, and prints every path
# it is going to use before it uses it.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$here/aeia-bridge"
user="${2:-default-user}"

if [ ! -f "$source_dir/manifest.json" ]; then
  echo "Could not find aeia-bridge/manifest.json next to this script." >&2
  echo "Run it from inside the st-extension folder." >&2
  exit 1
fi

# Does this look like a SillyTavern install? `data` is the giveaway — every
# version since 1.12 keeps per-user folders under it.
looks_like_st() {
  [ -n "${1:-}" ] && [ -d "$1/data" ] && { [ -f "$1/server.js" ] || [ -f "$1/package.json" ]; }
}

st="${1:-}"
if [ -z "$st" ]; then
  for guess in \
    "$HOME/SillyTavern" \
    "$HOME/sillytavern" \
    "$HOME/SillyTavern-Launcher/SillyTavern" \
    "/opt/SillyTavern"
  do
    if looks_like_st "$guess"; then st="$guess"; break; fi
  done
fi

if ! looks_like_st "$st"; then
  echo "Could not find SillyTavern." >&2
  echo "Run this again with the folder that contains its 'data' directory:" >&2
  echo "  ./install.sh /path/to/SillyTavern" >&2
  exit 1
fi

extensions="$st/data/$user/extensions"
target="$extensions/aeia-bridge"

echo "SillyTavern  : $st"
echo "Installing to: $target"

mkdir -p "$extensions"

if [ -e "$target" ]; then
  # Replaced, not merged: a half-old half-new extension is a bug report nobody
  # can read. Only this one folder is removed.
  echo "Replacing the existing copy."
  rm -rf "$target"
fi

cp -r "$source_dir" "$target"
echo
echo "Installed."
echo "Now: reload SillyTavern in your browser, then open Extensions and look for 'Aeia Bridge'."
