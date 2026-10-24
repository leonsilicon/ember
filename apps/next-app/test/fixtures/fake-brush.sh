#!/bin/bash
# Stands in for brush_app: writes a snapshot PLY every --export-every steps, with the step
# zero-padded to the width of --total-steps as Brush does (splat_0100.ply for 1000 steps).
# Its arguments go to $BRUSH_ARGS_FILE, for tests that check them.
[ -n "$BRUSH_ARGS_FILE" ] && echo "$@" > "$BRUSH_ARGS_FILE"
while [ $# -gt 0 ]; do
  case "$1" in
    --export-path) out="$2"; shift ;;
    --total-steps) steps="$2"; shift ;;
    --export-every) every="$2"; shift ;;
  esac
  shift
done
for ((i = every; i <= steps; i += every)); do
  name=$(printf "splat_%0${#steps}d.ply" $i)
  printf 'ply\nformat binary_little_endian 1.0\nelement vertex %d\nend_header\n' $((i * 10)) > "$out/$name"
done
