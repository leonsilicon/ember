#!/bin/bash
# Sets up the live reconstruction's depth worker: downloads Apple's Core ML build of
# Depth Anything V2 Small (pinned revision, SHA-256-checked), compiles it into models/,
# and builds depth-worker/ into bin/depth_worker (all under frontend). Needs Xcode (macOS 14+).
set -euo pipefail

REPO="apple/coreml-depth-anything-v2-small"
REVISION="cfef6f6f2a70783dedc0bfae40cecbc2052285d3"
PACKAGE="DepthAnythingV2SmallF16.mlpackage"
FILES=(
  "Manifest.json 2883ae290c48fe916dc5ececac03a7d847fa277165a49ef5652fa1d2b9cb55f7"
  "Data/com.apple.CoreML/model.mlmodel 44ac97a3efcfd52113183fb2862ff59cd0368e9ec2e30a90a54980dd11407042"
  "Data/com.apple.CoreML/weights/weight.bin fa60d9b6a155734f59029ebb882fd54e549bfaee3539c1a9cbd2cbbab64a0fed"
)

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="$SERVER_DIR/models"
BIN_DIR="$SERVER_DIR/bin"
mkdir -p "$MODELS_DIR" "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${PACKAGE} (~50 MB)…"
for entry in "${FILES[@]}"; do
  read -r file sha <<<"$entry"
  mkdir -p "$TMP/$PACKAGE/$(dirname "$file")"
  curl -fsSL -o "$TMP/$PACKAGE/$file" "https://huggingface.co/${REPO}/resolve/${REVISION}/${PACKAGE}/${file}"
  echo "${sha}  $TMP/$PACKAGE/$file" | shasum -a 256 -c - >/dev/null
done
rm -rf "$MODELS_DIR/${PACKAGE%.mlpackage}.mlmodelc"
xcrun coremlcompiler compile "$TMP/$PACKAGE" "$MODELS_DIR" >/dev/null
echo "Installed $MODELS_DIR/${PACKAGE%.mlpackage}.mlmodelc"

echo "Building the depth worker…"
swift build -c release --package-path "$SERVER_DIR/depth-worker" 2>&1 | tail -1
install -m 755 "$(swift build -c release --package-path "$SERVER_DIR/depth-worker" --show-bin-path)/depth_worker" "$BIN_DIR/depth_worker"
echo "Installed $BIN_DIR/depth_worker"
