#!/usr/bin/env bash
# Builds docs/video/how-to-play.mp4: records the guide by driving the real game
# (tools/video/guide.mjs), then encodes the frames.
#
#   pnpm build && (cd apps/web && npx vite preview --port 4174 &)
#   FONTS=path/to/node_modules/@fontsource tools/video/make-guide.sh
#
# With narration: synthesise it first (Piper, offline neural TTS; voices are on
# the rhasspy/piper GitHub releases), then pass the folder as VOICE_DIR. Scenes
# then last as long as their lines, and the voice is mixed in at each scene.
#   pip install piper-tts
#   python3 tools/video/voice.py en-us-lessac-medium.onnx /tmp/cr-voice
#   VOICE_DIR=/tmp/cr-voice FONTS=... tools/video/make-guide.sh
#
# FONTS points at @fontsource/barlow, barlow-condensed and marcellus, used when
# Google Fonts can't be reached. Recording runs at about 0.5 s per frame in
# software WebGL, so a 2-minute video at 20 fps takes roughly 20 minutes.
set -euo pipefail
FPS="${FPS:-20}"
FRAMES="${FRAMES:-/tmp/cr-guide-frames}"
OUTFILE="${OUTFILE:-docs/video/how-to-play.mp4}"
mkdir -p "$(dirname "$OUTFILE")"
FPS="$FPS" OUT="$FRAMES" VOICE_DIR="${VOICE_DIR:-}" node tools/video/guide.mjs
SILENT="${OUTFILE%.mp4}-silent.mp4"
# Duplicate to 30 fps for smooth playback everywhere; H.264 + faststart for the web.
ffmpeg -y -loglevel error -framerate "$FPS" -i "$FRAMES/f%05d.jpg" \
  -vf "fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 20 -movflags +faststart "$SILENT"
if [ -n "${VOICE_DIR:-}" ]; then
  python3 tools/video/mix.py "$SILENT" "$FRAMES" "$VOICE_DIR" "$OUTFILE"
  rm -f "$SILENT"
else
  mv "$SILENT" "$OUTFILE"
fi
echo "wrote $OUTFILE"
