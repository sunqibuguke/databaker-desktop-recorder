#!/usr/bin/env python3
"""按 DataBaker 导出的 timestamps.json 切分另一台设备录制的 WAV。

只使用 Python 标准库，不会生成 ZIP。默认按 timestamps.json 中的
exported 列表切分，即 DataBaker 当时选定且通过安全校验的句子。

时间映射：
    外部 WAV 时间 = DataBaker 时间 * time_scale + offset_seconds

例如，另一台设备比 DataBaker 早 2.35 秒开始录音，使用：
    --offset-seconds 2.35
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
import wave
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence


class CutError(Exception):
    """可直接展示给使用者的输入或切分错误。"""


@dataclass(frozen=True)
class CutPlan:
    item_id: str
    output_name: str
    source_start_sample: int
    source_end_sample: int
    target_start_frame: int
    target_end_frame: int


def parse_fraction(value: str, option_name: str) -> Fraction:
    try:
        parsed = Fraction(value)
    except (ValueError, ZeroDivisionError) as error:
        raise argparse.ArgumentTypeError(
            f"{option_name} 必须是数字，当前值：{value!r}"
        ) from error
    return parsed


def parse_offset(value: str) -> Fraction:
    return parse_fraction(value, "--offset-seconds")


def parse_positive_scale(value: str) -> Fraction:
    parsed = parse_fraction(value, "--time-scale")
    if parsed <= 0:
        raise argparse.ArgumentTypeError("--time-scale 必须大于 0")
    return parsed


def parse_nonnegative_seconds(value: str) -> Fraction:
    parsed = parse_fraction(value, "padding")
    if parsed < 0:
        raise argparse.ArgumentTypeError("前后余量不能小于 0")
    return parsed


def require_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CutError(f"timestamps.json 的 {field} 必须是整数")
    return value


def load_timestamps(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8-sig") as source:
            payload = json.load(source)
    except FileNotFoundError as error:
        raise CutError(f"找不到 JSON：{path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise CutError(f"无法读取 JSON {path}：{error}") from error

    if not isinstance(payload, dict):
        raise CutError("timestamps.json 顶层必须是 JSON 对象")
    if "exported" not in payload:
        if "status" in payload and "export_id" in payload:
            raise CutError(
                f"{path.name} 是导出状态文件，不包含逐句时间点；"
                "请选择 timestamps.json"
            )
        raise CutError("JSON 中缺少 exported 列表；请使用 DataBaker 导出的 timestamps.json")

    audio_format = payload.get("audio_format")
    if not isinstance(audio_format, dict):
        raise CutError("timestamps.json 中缺少 audio_format")
    sample_rate = require_int(audio_format.get("sample_rate"), "audio_format.sample_rate")
    if sample_rate <= 0:
        raise CutError("audio_format.sample_rate 必须大于 0")

    exported = payload.get("exported")
    if not isinstance(exported, list):
        raise CutError("timestamps.json 的 exported 必须是列表")
    if not exported:
        raise CutError("timestamps.json 的 exported 列表为空，没有可切分的已选录音")
    return payload


def round_fraction(value: Fraction) -> int:
    """将有理数四舍五入到最近整数，避免浮点误差累积。"""
    quotient, remainder = divmod(value.numerator, value.denominator)
    if remainder * 2 >= value.denominator:
        quotient += 1
    return quotient


def safe_output_name(row: Dict[str, Any], index: int) -> str:
    declared = row.get("file")
    if isinstance(declared, str) and declared.strip():
        # Path on the JSON-producing machine may use either slash style.
        candidate = declared.replace("\\", "/").rsplit("/", 1)[-1]
    else:
        candidate = f"{index:04d}-{row.get('id', 'item')}.wav"
    candidate = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", candidate).strip(" .")
    if not candidate:
        candidate = f"{index:04d}-item.wav"
    if Path(candidate).suffix.lower() != ".wav":
        candidate += ".wav"
    return candidate


def unique_name(candidate: str, used: set) -> str:
    normalized = candidate.casefold()
    if normalized not in used:
        used.add(normalized)
        return candidate
    path = Path(candidate)
    counter = 2
    while True:
        alternate = f"{path.stem}-{counter}{path.suffix}"
        normalized = alternate.casefold()
        if normalized not in used:
            used.add(normalized)
            return alternate
        counter += 1


def build_plans(
    payload: Dict[str, Any],
    target_sample_rate: int,
    target_total_frames: int,
    offset_seconds: Fraction,
    time_scale: Fraction,
    padding_before: Fraction,
    padding_after: Fraction,
    clip_out_of_range: bool,
) -> List[CutPlan]:
    json_rate = require_int(payload["audio_format"].get("sample_rate"), "audio_format.sample_rate")
    used_names = set()
    plans: List[CutPlan] = []

    for index, raw_row in enumerate(payload["exported"], start=1):
        if not isinstance(raw_row, dict):
            raise CutError(f"exported[{index - 1}] 必须是 JSON 对象")
        start_sample = require_int(raw_row.get("start_sample"), f"exported[{index - 1}].start_sample")
        end_sample = require_int(raw_row.get("end_sample"), f"exported[{index - 1}].end_sample")
        if start_sample < 0 or end_sample <= start_sample:
            raise CutError(
                f"exported[{index - 1}] 时间范围无效："
                f"start_sample={start_sample}, end_sample={end_sample}"
            )

        mapped_start = (
            Fraction(start_sample, json_rate) * time_scale
            + offset_seconds
            - padding_before
        )
        mapped_end = (
            Fraction(end_sample, json_rate) * time_scale
            + offset_seconds
            + padding_after
        )
        target_start = round_fraction(mapped_start * target_sample_rate)
        target_end = round_fraction(mapped_end * target_sample_rate)
        original_target_start = target_start
        original_target_end = target_end

        if clip_out_of_range:
            target_start = max(0, target_start)
            target_end = min(target_total_frames, target_end)
        elif target_start < 0 or target_end > target_total_frames:
            item_id = str(raw_row.get("id", index))
            raise CutError(
                f"句子 {item_id} 映射后超出外部 WAV 范围："
                f"[{target_start}, {target_end}) / {target_total_frames} 帧。"
                "请检查 --offset-seconds/--time-scale，或明确加上 "
                "--clip-out-of-range 允许截断。"
            )
        if target_end <= target_start:
            item_id = str(raw_row.get("id", index))
            raise CutError(
                f"句子 {item_id} 在外部 WAV 中没有可用音频："
                f"映射范围 [{original_target_start}, {original_target_end})"
            )

        plans.append(
            CutPlan(
                item_id=str(raw_row.get("id", index)),
                output_name=unique_name(safe_output_name(raw_row, index), used_names),
                source_start_sample=start_sample,
                source_end_sample=end_sample,
                target_start_frame=target_start,
                target_end_frame=target_end,
            )
        )
    return plans


def ensure_not_input(output_path: Path, protected_inputs: Sequence[Path]) -> None:
    """Never let overwrite permission include either input or its file aliases."""
    resolved = output_path.resolve()
    for source in protected_inputs:
        if resolved == source.resolve() or (
            output_path.exists() and source.exists() and output_path.samefile(source)
        ):
            raise CutError(f"输出切片不能覆盖输入文件：{output_path}")


def ensure_outputs_available(
    output_dir: Path, plans: Iterable[CutPlan], overwrite: bool,
    protected_inputs: Sequence[Path] = (),
) -> None:
    if output_dir.exists() and not output_dir.is_dir():
        raise CutError(f"输出路径已存在且不是文件夹：{output_dir}")
    plans = list(plans)
    for plan in plans:
        ensure_not_input(output_dir / plan.output_name, protected_inputs)
    conflicts = [output_dir / plan.output_name for plan in plans if (output_dir / plan.output_name).exists()]
    if conflicts and not overwrite:
        preview = "\n".join(f"  - {path}" for path in conflicts[:5])
        extra = f"\n  ... 共 {len(conflicts)} 个" if len(conflicts) > 5 else ""
        raise CutError(f"输出文件已存在：\n{preview}{extra}\n如需覆盖，请加 --overwrite")


def write_cut(
    source: wave.Wave_read,
    output_path: Path,
    start_frame: int,
    end_frame: int,
    protected_inputs: Sequence[Path] = (),
) -> None:
    ensure_not_input(output_path, protected_inputs)
    temporary = output_path.with_name(f".{output_path.name}.{uuid.uuid4().hex}.tmp")
    remaining = end_frame - start_frame
    try:
        source.setpos(start_frame)
        with wave.open(str(temporary), "wb") as target:
            target.setnchannels(source.getnchannels())
            target.setsampwidth(source.getsampwidth())
            target.setframerate(source.getframerate())
            target.setcomptype("NONE", "not compressed")
            while remaining > 0:
                frame_count = min(remaining, 1_048_576)
                data = source.readframes(frame_count)
                if not data:
                    raise CutError(f"读取到 WAV 末尾，仍缺少 {remaining} 帧")
                bytes_per_frame = source.getnchannels() * source.getsampwidth()
                frames_read = len(data) // bytes_per_frame
                if frames_read <= 0:
                    raise CutError("WAV 返回了不完整的音频帧")
                target.writeframesraw(data)
                remaining -= frames_read
        ensure_not_input(output_path, protected_inputs)
        os.replace(str(temporary), str(output_path))
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def open_pcm_wav(path: Path) -> wave.Wave_read:
    try:
        source = wave.open(str(path), "rb")
    except (FileNotFoundError, OSError, EOFError, wave.Error) as error:
        raise CutError(
            f"无法打开 WAV {path}：{error}。"
            "脚本支持未压缩 PCM WAV；RF64 或特殊 WAV 容器需先转为标准 PCM WAV。"
        ) from error
    compression_type = source.getcomptype()
    if compression_type != "NONE":
        source.close()
        raise CutError(f"仅支持未压缩 PCM WAV，当前编码：{compression_type}")
    return source


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="按 DataBaker timestamps.json 的已选句子时间点切分外部设备 WAV（不生成 ZIP）。"
    )
    parser.add_argument("input_wav", type=Path, help="另一台设备录制的 PCM WAV")
    parser.add_argument("timestamps_json", type=Path, help="DataBaker 导出的 timestamps.json")
    parser.add_argument("-o", "--output-dir", type=Path, help="输出目录，默认为 <WAV文件名>_cuts")
    parser.add_argument(
        "--offset-seconds",
        type=parse_offset,
        default=Fraction(0),
        metavar="SECONDS",
        help="外部 WAV 中 DataBaker 时间 0 所在的秒数；外部设备早开始时填正数（默认 0）",
    )
    parser.add_argument(
        "--time-scale",
        type=parse_positive_scale,
        default=Fraction(1),
        metavar="RATIO",
        help="另一台设备的时钟比例，用于长录音漂移校正（默认 1）",
    )
    parser.add_argument(
        "--padding-before",
        type=parse_nonnegative_seconds,
        default=Fraction(0),
        metavar="SECONDS",
        help="每段前额外保留秒数（默认 0）",
    )
    parser.add_argument(
        "--padding-after",
        type=parse_nonnegative_seconds,
        default=Fraction(0),
        metavar="SECONDS",
        help="每段后额外保留秒数（默认 0）",
    )
    parser.add_argument(
        "--clip-out-of-range",
        action="store_true",
        help="当切分点超出外部 WAV 时截断到文件边界；默认报错以防止静默丢音频",
    )
    parser.add_argument("--overwrite", action="store_true", help="允许覆盖已存在的同名切片")
    return parser


def run(argv: Sequence[str]) -> int:
    args = build_parser().parse_args(argv)
    input_wav = args.input_wav.expanduser().resolve()
    timestamps_json = args.timestamps_json.expanduser().resolve()
    output_dir = (
        args.output_dir.expanduser().resolve()
        if args.output_dir
        else input_wav.with_name(f"{input_wav.stem}_cuts")
    )

    payload = load_timestamps(timestamps_json)
    source = open_pcm_wav(input_wav)
    try:
        plans = build_plans(
            payload=payload,
            target_sample_rate=source.getframerate(),
            target_total_frames=source.getnframes(),
            offset_seconds=args.offset_seconds,
            time_scale=args.time_scale,
            padding_before=args.padding_before,
            padding_after=args.padding_after,
            clip_out_of_range=args.clip_out_of_range,
        )
        protected_inputs = (input_wav, timestamps_json)
        ensure_outputs_available(output_dir, plans, args.overwrite, protected_inputs)
        output_dir.mkdir(parents=True, exist_ok=True)

        print(
            f"外部 WAV：{source.getframerate()} Hz / {source.getnchannels()} 声道 / "
            f"{source.getsampwidth() * 8}-bit"
        )
        print(
            f"时间映射：external = databaker * {float(args.time_scale):.12g} "
            f"+ {float(args.offset_seconds):.12g} 秒"
        )
        for index, plan in enumerate(plans, start=1):
            output_path = output_dir / plan.output_name
            write_cut(source, output_path, plan.target_start_frame, plan.target_end_frame, protected_inputs)
            duration = (plan.target_end_frame - plan.target_start_frame) / source.getframerate()
            print(f"[{index}/{len(plans)}] {plan.output_name}  {duration:.3f} 秒  (ID: {plan.item_id})")
    finally:
        source.close()

    print(f"完成：已输出 {len(plans)} 个 WAV 到 {output_dir}")
    return 0


def main() -> int:
    try:
        return run(sys.argv[1:])
    except CutError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已取消。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
