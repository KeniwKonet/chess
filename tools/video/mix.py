"""Lay the narration under the recorded video at the cue times guide.mjs logged.

    python3 tools/video/mix.py VIDEO.mp4 FRAMES_DIR VOICE_DIR OUT.mp4
"""
import json
import subprocess
import sys
from pathlib import Path

video, frames, voice, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
cues = json.loads((frames / "cues.json").read_text())
args = ["ffmpeg", "-y", "-loglevel", "error", "-i", video]
for c in cues:
    args += ["-i", str(voice / f"{c['id']}.wav")]
parts = []
for i, c in enumerate(cues, start=1):
    ms = round(c["t"] * 1000)
    parts.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
mix = "".join(f"[a{i}]" for i in range(1, len(cues) + 1))
# Mono voice to both ears, mixed without level-halving, then gentle loudness levelling.
parts.append(f"{mix}amix=inputs={len(cues)}:normalize=0:dropout_transition=0,volume=-2dB,loudnorm=I=-16:TP=-1.5:LRA=11,aformat=channel_layouts=stereo[voice]")
args += [
    "-filter_complex", ";".join(parts),
    "-map", "0:v", "-map", "[voice]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-shortest", "-movflags", "+faststart", out,
]
subprocess.run(args, check=True)
print(f"mixed {len(cues)} lines into {out}")
