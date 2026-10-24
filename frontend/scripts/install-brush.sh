#!/bin/bash
# Downloads the Brush splat trainer (macOS Apple Silicon build) into frontend/bin,
# verifying it against the release's published SHA-256.
set -euo pipefail

VERSION="v0.3.0"
ASSET="brush-app-aarch64-apple-darwin.tar.xz"
SHA256="65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c"
URL="https://github.com/ArthurBrussee/brush/releases/download/${VERSION}/${ASSET}"

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Brush ${VERSION}…"
curl -fsSL -o "$TMP/$ASSET" "$URL"
echo "${SHA256}  $TMP/$ASSET" | shasum -a 256 -c -
tar -xJf "$TMP/$ASSET" -C "$TMP"
install -m 755 "$TMP/brush-app-aarch64-apple-darwin/brush_app" "$BIN_DIR/brush_app"
echo "Installed $BIN_DIR/brush_app ($("$BIN_DIR/brush_app" --version))"
