#!/usr/bin/env bash
# Builds docs/video/how-to-play.mp4: records the guide by driving the real game
# (tools/video/guide.mjs), then encodes the frames.
#
#   pnpm build && (cd apps/web && npx vite preview --port 4174 &)
#   FONTS=path/to/node_modules/@fontsource tools/video/make-guide.sh
#
# FONTS points at @fontsource/barlow, barlow-condensed and marcellus, used when
# Google Fonts can't be reached. Recording runs at about 0.5 s per frame in
# software WebGL, so a 2-minute video at 20 fps takes roughly 20 minutes.
set -euo pipefail
FPS="${FPS:-20}"
FRAMES="${FRAMES:-/tmp/cr-guide-frames}"
OUTFILE="${OUTFILE:-docs/video/how-to-play.mp4}"
mkdir -p "$(dirname "$OUTFILE")"
FPS="$FPS" OUT="$FRAMES" node tools/video/guide.mjs
# Duplicate to 30 fps for smooth playback everywhere; H.264 + faststart for the web.
ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES/f%05d.jpg" \
  -vf "fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 20 -movflags +faststart "$OUTFILE"
echo "wrote $OUTFILE"
