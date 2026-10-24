"""Synthesise the guide's narration with Piper (offline neural TTS).

    python3 tools/video/voice.py VOICE.onnx OUT_DIR

Writes OUT_DIR/<id>.wav for each line in narration.json and OUT_DIR/durations.json
(seconds), which guide.mjs reads to give each scene time for its line.
"""
import json
import subprocess
import sys
import wave
from pathlib import Path

voice, out = sys.argv[1], Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
lines = json.loads((Path(__file__).parent / "narration.json").read_text())
durations = {}
for key, text in lines.items():
    wav = out / f"{key}.wav"
    subprocess.run(
        [sys.executable, "-m", "piper", "-m", voice, "-f", str(wav), "--length-scale", "1.0", "--sentence-silence", "0.25"],
        input=text.encode(),
        check=True,
        capture_output=True,
    )
    with wave.open(str(wav)) as w:
        durations[key] = round(w.getnframes() / w.getframerate(), 3)
    print(f"{key:8} {durations[key]:5.2f} s")
(out / "durations.json").write_text(json.dumps(durations, indent=1))
print(f"total {sum(durations.values()):.1f} s")
