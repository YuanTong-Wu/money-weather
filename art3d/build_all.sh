#!/bin/sh
# Rebuild every 3D asset from scratch (≈2 min on an M-series Mac). Deterministic: same seeds → same files.
set -e
cd "$(dirname "$0")/.."
B="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
"$B" -b -P art3d/ramps.py        2>&1 | grep -E "RAMP|Error" || true
"$B" -b -P art3d/assets_glb.py   2>&1 | grep -E "GLB|Error" || true
"$B" -b -P art3d/illustrations.py 2>&1 | grep -E "RENDER|POST|manifest|Error" | grep -v "strokes set empty" || true
du -sh web/assets/3d
