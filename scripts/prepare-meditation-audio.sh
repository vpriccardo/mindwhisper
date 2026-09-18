#!/usr/bin/env bash
set -euo pipefail

# Source (large, full track) stays in source-audio/ — not required at runtime.
# Production derivative is the trimmed loop shipped with the acoustic PWA.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INPUT="${ROOT}/source-audio/583998__stanrams__meditation-one.mp3"
# Acoustic app is served at /acoustic/ — place the asset next to other audio worklets.
OUTPUT="${ROOT}/acoustic/audio/meditation-loop-v1.mp3"
# Mirror under public/audio for the documented project layout / credits folder.
PUBLIC_OUT="${ROOT}/public/audio/meditation-loop-v1.mp3"

if [ ! -f "$INPUT" ]; then
  echo "Missing source audio: $INPUT" >&2
  echo "Place the Freesound download at that path before running this script." >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "FFmpeg is required (brew install ffmpeg)" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$PUBLIC_OUT")"

ffmpeg \
  -y \
  -ss 20 \
  -to 64 \
  -i "$INPUT" \
  -vn \
  -map_metadata -1 \
  -ar 44100 \
  -ac 2 \
  -codec:a libmp3lame \
  -b:a 96k \
  "$OUTPUT"

cp "$OUTPUT" "$PUBLIC_OUT"

BYTES=$(wc -c < "$OUTPUT" | tr -d ' ')
echo "Created $OUTPUT (${BYTES} bytes)"
echo "Mirrored $PUBLIC_OUT"

if [ "$BYTES" -gt 665600 ]; then
  echo "WARNING: output exceeds 650 KB (${BYTES} bytes)" >&2
  exit 1
fi
