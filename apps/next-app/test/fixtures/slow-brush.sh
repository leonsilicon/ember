#!/bin/bash
# Stands in for a brush_app that pauses after its first snapshot, then writes the rest and exits,
# so it finishes while the trainer is still uploading that first snapshot.
while [ $# -gt 0 ]; do
  case "$1" in
    --export-path) out="$2"; shift ;;
  esac
  shift
done
printf 'ply\nformat binary_little_endian 1.0\nelement vertex 1000\nend_header\n' > "$out/splat_100.ply"
sleep 2.5
printf 'ply\nformat binary_little_endian 1.0\nelement vertex 2000\nend_header\n' > "$out/splat_200.ply"
printf 'ply\nformat binary_little_endian 1.0\nelement vertex 3000\nend_header\n' > "$out/splat_300.ply"
