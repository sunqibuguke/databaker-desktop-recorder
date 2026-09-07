#!/usr/bin/env python3

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path


SCRIPT = Path(__file__).with_name("cut_external_wav.py")
SPEC = importlib.util.spec_from_file_location("cut_external_wav", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def write_test_wav(path: Path, sample_rate: int = 44_100, seconds: int = 4) -> None:
    with wave.open(str(path), "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        for frame in range(sample_rate * seconds):
            value = (frame % 20_000).to_bytes(2, "little", signed=False)
            target.writeframesraw(value + value)


def write_timestamps(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "audio_format": {"sample_rate": 48_000},
                "exported": [
                    {
                        "id": "001",
                        "start_sample": 48_000,
                        "end_sample": 96_000,
                        "file": "sentences/001.wav",
                    },
                    {
                        "id": "002",
                        "start_sample": 96_000,
                        "end_sample": 144_000,
                        "file": "sentences/002.wav",
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


class CutExternalWavTests(unittest.TestCase):
    def test_input_and_aliases_are_never_overwrite_targets(self) -> None:
        for alias in ('same-name', 'symlink', 'hardlink', 'json-input'):
            with self.subTest(alias=alias), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / 'source.wav'
                timestamps = root / 'timestamps.wav'
                write_test_wav(source, seconds=1)
                destination = source if alias == 'same-name' else root / 'alias.wav'
                if alias == 'symlink':
                    try:
                        destination.symlink_to(source)
                    except OSError:
                        continue  # Windows without symlink permission.
                elif alias == 'hardlink':
                    os.link(source, destination)
                elif alias == 'json-input':
                    destination = timestamps
                timestamps.write_text(json.dumps({
                    'audio_format': {'sample_rate': 44_100},
                    'exported': [{'id': '001', 'file': destination.name,
                                  'start_sample': 0, 'end_sample': 100}],
                }))
                original_audio, original_json = source.read_bytes(), timestamps.read_bytes()
                result = subprocess.run([
                    sys.executable, str(SCRIPT), str(source), str(timestamps),
                    '-o', str(root), '--overwrite',
                ], capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('不能覆盖输入文件', result.stderr)
                self.assertEqual(source.read_bytes(), original_audio)
                self.assertEqual(timestamps.read_bytes(), original_json)
                self.assertFalse(list(root.glob('.*.tmp')))

    def test_distribution_copies_match(self) -> None:
        for copy in ['doc/cut_external_wav.py', 'doc/切段脚本示例/cut_external_wav.py']:
            self.assertEqual((SCRIPT.parent.parent / copy).read_bytes(), SCRIPT.read_bytes())

    def test_cli_maps_json_samples_to_different_wav_sample_rate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "external.wav"
            timestamps = root / "timestamps.json"
            output = root / "cuts"
            write_test_wav(source)
            write_timestamps(timestamps)

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(source), str(timestamps), "-o", str(output)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in ("001.wav", "002.wav"):
                with wave.open(str(output / name), "rb") as cut:
                    self.assertEqual(cut.getframerate(), 44_100)
                    self.assertEqual(cut.getnchannels(), 2)
                    self.assertEqual(cut.getnframes(), 44_100)

    def test_offset_moves_cut_in_external_wav(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "external.wav"
            timestamps = root / "timestamps.json"
            output = root / "cuts"
            write_test_wav(source)
            write_timestamps(timestamps)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    str(source),
                    str(timestamps),
                    "-o",
                    str(output),
                    "--offset-seconds",
                    "0.25",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            with wave.open(str(source), "rb") as original, wave.open(str(output / "001.wav"), "rb") as cut:
                original.setpos(44_100 + 11_025)
                self.assertEqual(cut.readframes(1), original.readframes(1))

    def test_status_json_is_rejected_with_actionable_message(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            status = Path(temporary) / "status-timestamps-json.json"
            status.write_text(
                json.dumps({"status": "complete", "export_id": "example"}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(MODULE.CutError, "timestamps.json"):
                MODULE.load_timestamps(status)

    def test_out_of_range_fails_before_creating_output_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "external.wav"
            timestamps = root / "timestamps.json"
            output = root / "cuts"
            write_test_wav(source, seconds=2)
            write_timestamps(timestamps)

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(source), str(timestamps), "-o", str(output)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("--offset-seconds/--time-scale", result.stderr)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
