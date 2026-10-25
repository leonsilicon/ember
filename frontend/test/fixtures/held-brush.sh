#!/bin/bash
# Stands in for a brush_app whose finish a test controls: it writes its first snapshot, then waits
# for a `go` file in its export dir before writing the rest and exiting. Stopped with SIGSTOP, it
# sees no `go` until it's continued. Each one appends its export dir's name to $BRUSH_LOG_FILE as
# it finishes, so a test can check which finished first.
while [ $# -gt 0 ]; do
  case "$1" in
    --export-path) out="$2"; shift ;;
  esac
  shift
done
printf 'ply\nformat binary_little_endian 1.0\nelement vertex 1000\nend_header\n' > "$out/splat_100.ply"
until [ -e "$out/go" ]; do sleep 0.1; done
printf 'ply\nformat binary_little_endian 1.0\nelement vertex 2000\nend_header\n' > "$out/splat_200.ply"
printf 'ply\nformat binary_little_endian 1.0\nelement vertex 3000\nend_header\n' > "$out/splat_300.ply"
if [ -n "$BRUSH_LOG_FILE" ]; then basename "$out" >> "$BRUSH_LOG_FILE"; fi
exit 0
