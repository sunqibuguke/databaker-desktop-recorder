"""从项目根运行，仅使用新建的临时 WAV 验证源文件覆盖问题。"""
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

with tempfile.TemporaryDirectory(prefix='databaker-cut-audit-') as temp:
    root = Path(temp)
    source = root / 'source.wav'
    timestamps = root / 'timestamps.json'
    with wave.open(str(source), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\x01\x00' * 8000)
    timestamps.write_text(json.dumps({
        'audio_format': {'sample_rate': 8000},
        'exported': [{'id': '001', 'file': 'source.wav', 'start_sample': 0, 'end_sample': 2000}],
    }))
    result = subprocess.run([
        sys.executable, 'scripts/cut_external_wav.py', str(source), str(timestamps),
        '-o', str(root), '--overwrite',
    ], capture_output=True, text=True)
    with wave.open(str(source), 'rb') as audio:
        remaining = audio.getnframes()
    print(json.dumps({'beforeSourceFrames': 8000, 'afterSourceFrames': remaining,
                      'exitCode': result.returncode}, indent=2))
