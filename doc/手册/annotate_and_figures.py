#!/usr/bin/env python3
"""Annotate product screenshots and draw supplementary handbook figures."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "images"
ANN = ROOT / "annotated"
FIG = ROOT / "figures"
FONTS = ROOT / "build" / "fonts"

ACCENT = (88, 184, 178)
INK = (28, 30, 31)
INK2 = (72, 76, 78)
PAPER = (246, 244, 240)
DARK = (22, 22, 22)
PANEL = (37, 37, 37)
LINE = (58, 58, 58)
WHITE = (255, 255, 255)
CORAL = (224, 82, 62)
AMBER = (215, 166, 74)
GREEN = (85, 184, 137)
BLUE = (87, 159, 227)
RED = (224, 91, 100)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, fnt: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        cur = ""
        for ch in para:
            trial = cur + ch
            if draw.textlength(trial, font=fnt) <= max_w:
                cur = trial
            else:
                if cur:
                    lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    return lines


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius: int, fill, outline=None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def annotate(
    src_name: str,
    dst_name: str,
    marks: list[dict],
    max_width: int = 2200,
) -> Path:
    im = Image.open(SRC / src_name).convert("RGBA")
    w, h = im.size
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    r = max(18, int(min(w, h) * 0.018))
    stroke = max(3, int(r * 0.16))
    number_font = font("HeitiSC-Medium.ttf", max(16, int(r * 1.15)))

    for mark in marks:
        n = str(mark["n"])
        x = int(mark["x"] * w)
        y = int(mark["y"] * h)
        tx = int(mark.get("tx", mark["x"]) * w)
        ty = int(mark.get("ty", mark["y"]) * h)
        if (tx, ty) != (x, y):
            draw.line((x, y, tx, ty), fill=(*WHITE, 210), width=max(2, stroke - 1))
            draw.ellipse((tx - 5, ty - 5, tx + 5, ty + 5), fill=(*CORAL, 230))
        # soft halo
        draw.ellipse((x - r - 4, y - r - 4, x + r + 4, y + r + 4), fill=(0, 0, 0, 90))
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(*CORAL, 245), outline=(*WHITE, 255), width=stroke)
        tw = draw.textlength(n, font=number_font)
        th = number_font.size
        draw.text((x - tw / 2, y - th / 2 - 1), n, font=number_font, fill=WHITE)

    composed = Image.alpha_composite(im, overlay).convert("RGB")
    if composed.width > max_width:
        nh = int(composed.height * max_width / composed.width)
        composed = composed.resize((max_width, nh), Image.Resampling.LANCZOS)
    ANN.mkdir(parents=True, exist_ok=True)
    out = ANN / dst_name
    composed.save(out, "PNG", optimize=True)
    return out


def card(w: int, h: int, title: str, subtitle: str = "") -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("RGB", (w, h), PAPER)
    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, w, 10), fill=ACCENT)
    title_f = font("SongtiSC-Bold.ttf", 42)
    sub_f = font("SongtiSC-Regular.ttf", 22)
    draw.text((48, 36), title, font=title_f, fill=INK)
    if subtitle:
        draw.text((48, 92), subtitle, font=sub_f, fill=INK2)
    return im, draw


def draw_workflow() -> Path:
    im, draw = card(1600, 980, "一次标准采集作业", "从授权到导出的完整路径")
    steps = [
        ("01", "激活授权", "复制机器码\n粘贴授权码"),
        ("02", "准备脚本", "CSV / TSV / TXT\nUTF-8 编码"),
        ("03", "新建任务", "选设备与格式\n指定保存位置"),
        ("04", "进入录制", "打开声卡\n环境噪声检测"),
        ("05", "逐句采集", "空格开始/结束\n试听后确认"),
        ("06", "安全退出", "封存母轨\n保留进度"),
        ("07", "导出交付", "整轨 / 时间戳\n分段 ZIP"),
    ]
    box_w, box_h = 176, 210
    gap = 28
    total = len(steps) * box_w + (len(steps) - 1) * gap
    x0 = (1600 - total) // 2
    y = 200
    body = font("SongtiSC-Regular.ttf", 18)
    name_f = font("HeitiSC-Medium.ttf", 22)
    num_f = font("HeitiSC-Medium.ttf", 20)
    for i, (num, name, desc) in enumerate(steps):
        x = x0 + i * (box_w + gap)
        rounded_rect(draw, (x, y, x + box_w, y + box_h), 16, (255, 255, 255), (220, 218, 212), 1)
        draw.ellipse((x + 16, y + 18, x + 54, y + 56), fill=ACCENT)
        tw = draw.textlength(num, font=num_f)
        draw.text((x + 35 - tw / 2, y + 26), num, font=num_f, fill=WHITE)
        draw.text((x + 16, y + 74), name, font=name_f, fill=INK)
        for j, line in enumerate(desc.split("\n")):
            draw.text((x + 16, y + 112 + j * 28), line, font=body, fill=INK2)
        if i < len(steps) - 1:
            ax = x + box_w + 4
            ay = y + box_h // 2
            draw.polygon([(ax, ay - 6), (ax + 16, ay), (ax, ay + 6)], fill=ACCENT)

    notes = [
        ("连续母轨", "整个任务写入一条逻辑连续的样本时轴，句子只是时轴上的区间索引。"),
        ("重录不覆盖", "采录人员只需使用本次重录或保留原录音。底层会追加保存录音，用于异常恢复和交付校验。"),
        ("fail-closed", "写盘故障、磁盘不足或身份冲突时停止标记有效数据，不会假装采集成功。"),
    ]
    ny = 470
    note_w = 470
    title_f = font("HeitiSC-Medium.ttf", 22)
    for i, (t, d) in enumerate(notes):
        x = 48 + i * (note_w + 24)
        rounded_rect(draw, (x, ny, x + note_w, ny + 210), 16, (255, 255, 255), (220, 218, 212), 1)
        draw.rectangle((x, ny, x + 8, ny + 210), fill=ACCENT)
        draw.text((x + 28, ny + 24), t, font=title_f, fill=INK)
        for j, line in enumerate(wrap_text(draw, d, body, note_w - 56)):
            draw.text((x + 28, ny + 70 + j * 30), line, font=body, fill=INK2)

    FIG.mkdir(parents=True, exist_ok=True)
    out = FIG / "workflow.png"
    im.save(out, "PNG")
    return out


def draw_cues() -> Path:
    im, draw = card(1600, 780, "录制状态色", "主界面与领读窗口使用同一套状态色")
    cues = [
        (AMBER, "黄 · 检测中", "环境噪声检测进行中，或句首静音尚未达标。请保持安静，不要开口。"),
        (GREEN, "绿 · 就绪", "可以开始朗读。领读窗口正文会切到可朗读颜色。"),
        (RED, "红 · 录制中", "已检测到有效语音，正在写入当前句。请按脚本完整朗读。"),
        (BLUE, "蓝 · 尾静音达标", "句尾连续静音已满足设定时长，可以结束本句。"),
        ((88, 184, 178), "青 · 待确认", "本句已封闭，进入试听/确认/重录。空格键确认。"),
        (RED, "红 · 立即停止", "输入故障、削波或设备中断。先停止朗读，再按提示处理。"),
    ]
    body = font("SongtiSC-Regular.ttf", 20)
    name_f = font("HeitiSC-Medium.ttf", 24)
    for i, (color, name, desc) in enumerate(cues):
        col, row = i % 3, i // 3
        x = 48 + col * 512
        y = 170 + row * 270
        rounded_rect(draw, (x, y, x + 492, y + 246), 18, WHITE, (220, 218, 212), 1)
        draw.ellipse((x + 28, y + 32, x + 68, y + 72), fill=color)
        draw.text((x + 88, y + 36), name, font=name_f, fill=INK)
        for j, line in enumerate(wrap_text(draw, desc, body, 430)):
            draw.text((x + 28, y + 100 + j * 32), line, font=body, fill=INK2)
    out = FIG / "cue-colors.png"
    im.save(out, "PNG")
    return out


def draw_task_states() -> Path:
    im, draw = card(1600, 720, "任务列表状态", "列表不会静默丢掉异常任务，异常会明确标出")
    states = [
        ((88, 184, 178), "当前录制", "本机正在打开的任务。"),
        (AMBER, "未完成", "仍有待录或待确认句子。"),
        ((90, 90, 90), "已完成", "全部句子已确认或跳过。"),
        (RED, "异常中断", "上次未安全收尾，需先检查。"),
        (CORAL, "需要检查", "快照损坏、身份冲突或只剩音频目录。"),
        ((160, 110, 70), "安全停止中", "正在封存母轨，请勿强关。"),
    ]
    name_f = font("HeitiSC-Medium.ttf", 24)
    body = font("SongtiSC-Regular.ttf", 20)
    for i, (color, name, desc) in enumerate(states):
        col, row = i % 3, i // 3
        x = 48 + col * 512
        y = 170 + row * 240
        rounded_rect(draw, (x, y, x + 492, y + 214), 18, WHITE, (220, 218, 212), 1)
        rounded_rect(draw, (x + 28, y + 36, x + 148, y + 76), 8, color)
        tw = draw.textlength(name, font=font("HeitiSC-Medium.ttf", 16))
        draw.text((x + 88 - tw / 2, y + 44), name, font=font("HeitiSC-Medium.ttf", 16), fill=WHITE)
        draw.text((x + 28, y + 100), name, font=name_f, fill=INK)
        for j, line in enumerate(wrap_text(draw, desc, body, 430)):
            draw.text((x + 28, y + 142 + j * 30), line, font=body, fill=INK2)
    out = FIG / "task-states.png"
    im.save(out, "PNG")
    return out


def draw_script_format() -> Path:
    im, draw = card(1600, 900, "录音脚本格式", "推荐 UTF-8，三列：序号 / 句子正文 / 标签（备注）")
    mono = font("SongtiSC-Regular.ttf", 22)
    head = font("HeitiSC-Medium.ttf", 22)
    body = font("SongtiSC-Regular.ttf", 20)

    rounded_rect(draw, (48, 160, 1552, 430), 16, (32, 32, 32))
    headers = ["序号 id", "句子正文 text", "标签 / 备注 label"]
    rows = [
        ["0001", "今天天气很好，适合出去散步。", "正常语速"],
        ["0002", "请保持自然、清晰的发音。", "无杂音"],
        ["0003", "这是桌面音频采集工具的测试文本。", "慢语速"],
    ]
    cols = [180, 820, 420]
    x = 72
    y = 186
    for i, h in enumerate(headers):
        draw.text((x, y), h, font=head, fill=ACCENT)
        x += cols[i]
    draw.line((72, 226, 1528, 226), fill=(70, 70, 70), width=1)
    y = 248
    for row in rows:
        x = 72
        for i, cell in enumerate(row):
            draw.text((x, y), cell, font=mono, fill=(230, 230, 228))
            x += cols[i]
        y += 48

    tips = [
        ("标准三列", "表头可用 序号/句子正文/标签，或 id/text/label。无表头时按第 1–3 列读取。"),
        ("兼容格式", "历史两列 id,text 可用。纯 TXT 按行导入，自动生成 0001 起的序号。"),
        ("编码与分隔", "请使用 UTF-8 或 UTF-8 BOM。CSV 用逗号，TSV 用 Tab。单元格可用双引号。"),
        ("校验规则", "ID 不能为空或重复，正文不能为空。导入后会固化脚本快照，之后改原文件不影响任务。"),
    ]
    title_f = font("HeitiSC-Medium.ttf", 22)
    for i, (t, d) in enumerate(tips):
        col, row = i % 2, i // 2
        x = 48 + col * 770
        y = 470 + row * 190
        rounded_rect(draw, (x, y, x + 746, y + 174), 16, WHITE, (220, 218, 212), 1)
        draw.text((x + 24, y + 20), t, font=title_f, fill=INK)
        for j, line in enumerate(wrap_text(draw, d, body, 698)):
            draw.text((x + 24, y + 64 + j * 30), line, font=body, fill=INK2)
    out = FIG / "script-format.png"
    im.save(out, "PNG")
    return out


def draw_directory() -> Path:
    im, draw = card(1600, 980, "一份录制就是一个可搬运目录", "音频、进度、脚本快照和导出文件在一起，不依赖外部数据库")
    tree = [
        ("<任务目录>/", True),
        ("    audio/segments/", True),
        ("        master-000001.wav", False),
        ("        master-000002.wav", False),
        ("    metadata/events.jsonl", False),
        ("    metadata/items.snapshot.json", False),
        ("    metadata/session.lock", False),
        ("    preview/*.wav", False),
        ("    script/normalized.json", False),
        ("    session.json", False),
        ("    export/", True),
        ("        full-track.wav", False),
        ("        metadata.json  /  metadata.csv", False),
        ("        sentences/<六位顺序>-<句子ID>.wav", False),
    ]
    notes = {
        "audio/segments/": "分段母轨。默认约 5 分钟一段，逻辑上仍是连续时轴。",
        "metadata/events.jsonl": "带序号的业务事件日志，是恢复进度的权威来源。",
        "export/": "交付物。整轨、时间戳和分段 ZIP 可分别生成。",
        "script/normalized.json": "导入后固化的脚本，避免原文件被改动后索引错位。",
    }
    mono = font("SongtiSC-Regular.ttf", 22)
    note_f = font("SongtiSC-Regular.ttf", 20)
    y = 170
    rounded_rect(draw, (48, 150, 1552, 920), 18, WHITE, (220, 218, 212), 1)
    for line, strong in tree:
        color = INK if strong else INK2
        fnt = font("HeitiSC-Medium.ttf", 22) if strong else mono
        draw.text((80, y), line, font=fnt, fill=color)
        key = line.strip()
        if key in notes:
            draw.text((760, y), notes[key], font=note_f, fill=INK2)
        y += 50
    out = FIG / "directory.png"
    im.save(out, "PNG")
    return out


def draw_keyboard() -> Path:
    im, draw = card(1600, 920, "键盘作业", "按键含义随当前状态变化，与主按钮一致。")
    keys = [
        ("Space", "查看：试听本句\n录制空闲：开始本句\n录制中：结束本句\n待确认：确认并下一句\n全部完成：完成并查看"),
        ("R", "查看：进入录制。\n录制：对当前句重录。\n录制中无动作。"),
        ("P", "试听当前有效录音。\n录制中无动作。"),
        ("S", "跳过当前句。\n需已进入录制且非录制中。"),
        ("← / →", "切换上一句 / 下一句。\n录制中禁止切句。"),
        ("Esc", "关闭确认框。\n退出任务前会走安全暂停流程。"),
    ]
    name_f = font("HeitiSC-Medium.ttf", 26)
    body = font("SongtiSC-Regular.ttf", 20)
    for i, (key, desc) in enumerate(keys):
        col, row = i % 3, i // 3
        x = 48 + col * 512
        y = 180 + row * 330
        rounded_rect(draw, (x, y, x + 492, y + 306), 18, WHITE, (220, 218, 212), 1)
        rounded_rect(draw, (x + 24, y + 24, x + 168, y + 76), 8, (32, 32, 32))
        tw = draw.textlength(key, font=name_f)
        draw.text((x + 96 - tw / 2, y + 34), key, font=name_f, fill=WHITE)
        for j, line in enumerate(desc.split("\n")):
            draw.text((x + 24, y + 104 + j * 34), line, font=body, fill=INK2)
    out = FIG / "keyboard.png"
    im.save(out, "PNG")
    return out


def draw_silence_timeline() -> Path:
    im, draw = card(1600, 780, "一句录音的时间边界", "所有边界都落在整数样本上，不用系统时钟秒数做真值")
    body = font("SongtiSC-Regular.ttf", 20)
    name_f = font("HeitiSC-Medium.ttf", 22)
    rounded_rect(draw, (80, 250, 1520, 370), 12, (32, 32, 32))
    # segments
    segs = [
        (80, 280, "# waiting"),
        (280, 430, "head"),
        (430, 980, "speech"),
        (980, 1280, "tail"),
        (1280, 1520, "closed"),
    ]
    colors = [(70, 70, 70), AMBER, RED, BLUE, ACCENT]
    labels = ["点击开始", "句首静音", "有效语音", "句尾静音", "封闭"]
    for (x0, x1, _), color, label in zip(segs, colors, labels):
        draw.rectangle((x0, 250, x1, 370), fill=color)
        tw = draw.textlength(label, font=name_f)
        draw.text(((x0 + x1) / 2 - tw / 2, 292), label, font=name_f, fill=WHITE)

    marks = [
        (280, "recording_started\n点击开始的样本"),
        (430, "content_started\n首次有效语音"),
        (430, "start_sample\n实际切片起点"),
        (1280, "end_sample\n本句结束样本"),
    ]
    # Avoid overlapping the two 430 marks - combine
    marks = [
        (280, "recording_started_sample\n点击开始"),
        (430, "content_started / start_sample\n开口与切片起点"),
        (1280, "end_sample\n结束并封闭"),
    ]
    for x, text in marks:
        draw.line((x, 250, x, 430), fill=INK, width=2)
        draw.ellipse((x - 6, 244, x + 6, 256), fill=INK)
        lines = text.split("\n")
        for i, line in enumerate(lines):
            tw = draw.textlength(line, font=body)
            draw.text((x - tw / 2, 450 + i * 30), line, font=body, fill=INK)

    note = "导出时同时保留 recording_started_sample、content_started_sample 和 start_sample。后期可按项目规则选用业务时间戳，而不必重录。"
    for i, line in enumerate(wrap_text(draw, note, body, 1440)):
        draw.text((80, 560 + i * 32), line, font=body, fill=INK2)
    note2 = "句首静音默认从点击开始后累计；“请等待 / 请朗读”倒计时是开口提示，不等于首静音本身。句尾静音达到设定时长后状态变蓝，仍可手动提前结束（会标记 forced_without_tail_silence）。"
    for i, line in enumerate(wrap_text(draw, note2, body, 1440)):
        draw.text((80, 640 + i * 32), line, font=body, fill=INK2)
    out = FIG / "silence-timeline.png"
    im.save(out, "PNG")
    return out


def draw_recovery() -> Path:
    im, draw = card(1600, 860, "中断之后怎么处理", "已落盘母音频默认保留。先分清状态，再决定继续录还是只导出。")
    boxes = [
        ((80, 180, 500, 360), AMBER, "未完成", "点「录制」开卡后继续。点「查看」可试听已有句子。"),
        ((560, 180, 980, 360), RED, "异常中断", "先“检查并修复”。系统会收尾 WAV 头和未闭合录音，不覆盖母轨。"),
        ((1040, 180, 1520, 360), CORAL, "需要检查", "目录被替换、快照冲突或只剩音频。可打开原目录，禁止盲目恢复。"),
        ((80, 430, 500, 610), (90, 90, 90), "只读保护", "可检查、试听、导出整轨和 JSON。修复前不能继续录制。"),
        ((560, 430, 980, 610), ACCENT, "安全停止中", "正在封存。请等待完成，不要强制退出或拔盘。"),
        ((1040, 430, 1520, 610), GREEN, "已完成", "全部句子已处理。可重新导出，或沿用脚本创建设备相同的新任务。"),
    ]
    name_f = font("HeitiSC-Medium.ttf", 24)
    body = font("SongtiSC-Regular.ttf", 20)
    for (x0, y0, x1, y1), color, title, desc in boxes:
        rounded_rect(draw, (x0, y0, x1, y1), 16, WHITE, (220, 218, 212), 1)
        draw.rectangle((x0, y0, x0 + 10, y1), fill=color)
        draw.text((x0 + 28, y0 + 22), title, font=name_f, fill=INK)
        for j, line in enumerate(wrap_text(draw, desc, body, x1 - x0 - 56)):
            draw.text((x0 + 28, y0 + 70 + j * 30), line, font=body, fill=INK2)

    foot = "授权失效时如果发现未封存录制，激活页会提示先封存，避免数据停在未封闭状态。"
    for i, line in enumerate(wrap_text(draw, foot, body, 1440)):
        draw.text((80, 660 + i * 32), line, font=body, fill=INK2)
    out = FIG / "recovery.png"
    im.save(out, "PNG")
    return out


def draw_params() -> Path:
    im, draw = card(1600, 820, "推荐采集参数", "采样率和输出位深按客户交付要求选择；驱动输入表示由软件自动匹配")
    rows = [
        ("默认", "48,000 Hz", "16-bit PCM", "Mono", "没有特殊要求时使用"),
        ("兼容交付", "项目指定", "8-bit PCM", "Mono", "仅在客户明确要求时使用"),
        ("高精度 PCM", "项目指定", "24-bit PCM", "Mono", "需要更高整数精度时使用"),
        ("后期处理", "项目指定", "32-bit Float", "Mono", "需要浮点余量时使用"),
    ]
    heads = ["场景", "采样率", "输出 WAV 位深", "声道", "说明"]
    widths = [220, 280, 280, 140, 500]
    name_f = font("HeitiSC-Medium.ttf", 20)
    body = font("SongtiSC-Regular.ttf", 20)
    x, y = 48, 170
    # header
    cx = x
    for h, w in zip(heads, widths):
        draw.rectangle((cx, y, cx + w, y + 56), fill=(32, 32, 32))
        draw.text((cx + 16, y + 16), h, font=name_f, fill=WHITE)
        cx += w
    y = 226
    for i, row in enumerate(rows):
        cx = x
        bg = WHITE if i % 2 == 0 else (237, 235, 230)
        for cell, w in zip(row, widths):
            draw.rectangle((cx, y, cx + w, y + 72), fill=bg)
            draw.text((cx + 16, y + 24), cell, font=body, fill=INK)
            cx += w
        y += 72

    notes = [
        "采集模式、输入通道、采样率和输出位深集中在新建录制的“采集参数”区，开始录制后保持不变。",
        "普通任务设置不显示驱动输入格式。软件自动选择满足输出精度的 i16 / i24 / i32 / f32 输入表示，并记录实际值。",
        "专业声卡优先使用 ASIO；普通麦克风和通用 USB 设备使用 WASAPI。开流失败会明确报错，不会静默降级。",
        "多输入声卡显示“输入 1、输入 2…”。软件从所选硬件通道采集，交付始终是单声道 WAV。",
    ]
    for i, n in enumerate(notes):
        draw.ellipse((60, 562 + i * 58, 76, 578 + i * 58), fill=ACCENT)
        for j, line in enumerate(wrap_text(draw, n, body, 1450)):
            draw.text((92, 554 + i * 58 + j * 28), line, font=body, fill=INK2)
    out = FIG / "params.png"
    im.save(out, "PNG")
    return out


def draw_roles() -> Path:
    im, draw = card(1600, 720, "三种角色，一条本地生产线", "当前版本不登录账号、不领取云端任务、不自动上传")
    roles = [
        ("工位操作员", "导入脚本、选择声卡、逐句朗读、处理重录和跳过、安全退出并导出。"),
        ("项目经理", "签发本机绑定授权码、规定采样格式与脚本规范、抽检导出包。"),
        ("数据工程师", "使用整轨、单句 WAV 和 metadata.json / csv 做质检、切片复核或训练对齐。"),
    ]
    name_f = font("HeitiSC-Medium.ttf", 28)
    body = font("SongtiSC-Regular.ttf", 22)
    for i, (title, desc) in enumerate(roles):
        x = 48 + i * 512
        rounded_rect(draw, (x, 180, x + 492, 560), 20, WHITE, (220, 218, 212), 1)
        draw.ellipse((x + 196, 220, x + 296, 320), fill=ACCENT)
        num_f = font("HeitiSC-Medium.ttf", 36)
        n = f"{i + 1:02d}"
        tw = draw.textlength(n, font=num_f)
        draw.text((x + 246 - tw / 2, 242), n, font=num_f, fill=WHITE)
        draw.text((x + 32, 350), title, font=name_f, fill=INK)
        for j, line in enumerate(wrap_text(draw, desc, body, 420)):
            draw.text((x + 32, 404 + j * 32), line, font=body, fill=INK2)
    out = FIG / "roles.png"
    im.save(out, "PNG")
    return out


def draw_export_artifacts() -> Path:
    im, draw = card(1600, 780, "三种导出产物可独立生成", "导出以当前已安全保存的内容为准，不要求全部句子录完")
    items = [
        ("整轨 WAV", "full-track.wav", "把分段母轨拼成一条连续 WAV。适合存档、抽检整段环境和核对时间轴。"),
        ("时间戳 JSON", "metadata.json", "句子文本、选中 attempt、样本边界、静音策略、设备与风险告警。是后期对齐的权威索引。"),
        ("分段 ZIP", "sentences/*.wav", "按选中 attempt 切出单句 WAV。待录、待确认或无可用录音的句子不会进入切片包。"),
    ]
    name_f = font("HeitiSC-Medium.ttf", 28)
    mono = font("SongtiSC-Regular.ttf", 20)
    body = font("SongtiSC-Regular.ttf", 22)
    for i, (title, file, desc) in enumerate(items):
        x = 48 + i * 512
        rounded_rect(draw, (x, 180, x + 492, 620), 20, WHITE, (220, 218, 212), 1)
        draw.rectangle((x, 180, x + 492, 188), fill=ACCENT)
        draw.text((x + 28, 220), title, font=name_f, fill=INK)
        rounded_rect(draw, (x + 28, 280, x + 464, 332), 8, (32, 32, 32))
        tw = draw.textlength(file, font=mono)
        draw.text((x + 246 - tw / 2, 292), file, font=mono, fill=ACCENT)
        for j, line in enumerate(wrap_text(draw, desc, body, 428)):
            draw.text((x + 28, 370 + j * 34), line, font=body, fill=INK2)
    out = FIG / "export-artifacts.png"
    im.save(out, "PNG")
    return out


def annotate_all() -> None:
    jobs = [
        (
            "任务列表.png",
            "home.png",
            [
                {"n": 1, "x": 0.055, "y": 0.055},
                {"n": 2, "x": 0.965, "y": 0.055},
                {"n": 3, "x": 0.072, "y": 0.175},
                {"n": 4, "x": 0.885, "y": 0.175},
                {"n": 5, "x": 0.048, "y": 0.275},
                {"n": 6, "x": 0.935, "y": 0.275},
                {"n": 7, "x": 0.078, "y": 0.395},
                {"n": 8, "x": 0.68, "y": 0.395},
                {"n": 9, "x": 0.905, "y": 0.395},
                {"n": 10, "x": 0.055, "y": 0.955},
            ],
        ),
        (
            "主界面.png",
            "console.png",
            [
                {"n": 1, "x": 0.11, "y": 0.035},
                {"n": 2, "x": 0.055, "y": 0.22},
                {"n": 3, "x": 0.50, "y": 0.085},
                {"n": 4, "x": 0.30, "y": 0.30},
                {"n": 5, "x": 0.30, "y": 0.66},
                {"n": 6, "x": 0.42, "y": 0.875},
                {"n": 7, "x": 0.905, "y": 0.30},
                {"n": 8, "x": 0.07, "y": 0.97},
            ],
        ),
        (
            "主页面-录制中.png",
            "console-live.png",
            [
                {"n": 1, "x": 0.78, "y": 0.075},
                {"n": 2, "x": 0.048, "y": 0.175},
                {"n": 3, "x": 0.22, "y": 0.575},
                {"n": 4, "x": 0.42, "y": 0.70},
                {"n": 5, "x": 0.48, "y": 0.905},
                {"n": 6, "x": 0.88, "y": 0.32},
                {"n": 7, "x": 0.88, "y": 0.95},
            ],
        ),
        (
            "新建录音任务.png",
            "setup.png",
            [
                {"n": 1, "x": 0.80, "y": 0.145, "tx": 0.74, "ty": 0.145},
                {"n": 2, "x": 0.40, "y": 0.235},
                {"n": 3, "x": 0.78, "y": 0.345, "tx": 0.73, "ty": 0.345},
                {"n": 4, "x": 0.82, "y": 0.48, "tx": 0.77, "ty": 0.48},
                {"n": 5, "x": 0.81, "y": 0.595, "tx": 0.76, "ty": 0.595},
                {"n": 6, "x": 0.80, "y": 0.69, "tx": 0.75, "ty": 0.69},
                {"n": 7, "x": 0.80, "y": 0.79, "tx": 0.75, "ty": 0.79},
                {"n": 8, "x": 0.84, "y": 0.91, "tx": 0.80, "ty": 0.91},
            ],
        ),
        (
            "机器码授权.png",
            "license.png",
            [
                {"n": 1, "x": 0.905, "y": 0.055},
                {"n": 2, "x": 0.42, "y": 0.205},
                {"n": 3, "x": 0.50, "y": 0.295},
                {"n": 4, "x": 0.618, "y": 0.295},
                {"n": 5, "x": 0.50, "y": 0.40},
                {"n": 6, "x": 0.50, "y": 0.505},
            ],
        ),
        (
            "设置.png",
            "settings.png",
            [
                {"n": 1, "x": 0.88, "y": 0.155},
                {"n": 2, "x": 0.88, "y": 0.33},
                {"n": 3, "x": 0.905, "y": 0.50},
                {"n": 4, "x": 0.88, "y": 0.665},
                {"n": 5, "x": 0.88, "y": 0.825},
                {"n": 6, "x": 0.90, "y": 0.945},
            ],
        ),
        (
            "设置-语言.png",
            "settings-language.png",
            [
                {"n": 1, "x": 0.82, "y": 0.18},
            ],
        ),
        (
            "侧栏-监听.png",
            "side-monitor.png",
            [
                {"n": 1, "x": 0.20, "y": 0.095},
                {"n": 2, "x": 0.78, "y": 0.095},
                {"n": 3, "x": 0.22, "y": 0.27},
                {"n": 4, "x": 0.50, "y": 0.54},
                {"n": 5, "x": 0.50, "y": 0.76},
                {"n": 6, "x": 0.935, "y": 0.22},
            ],
        ),
        (
            "侧栏-检测.png",
            "side-detect.png",
            [
                {"n": 1, "x": 0.50, "y": 0.34},
                {"n": 2, "x": 0.50, "y": 0.56},
                {"n": 3, "x": 0.18, "y": 0.73},
                {"n": 4, "x": 0.28, "y": 0.86},
            ],
        ),
        (
            "侧栏-任务.png",
            "side-task.png",
            [
                {"n": 1, "x": 0.50, "y": 0.36},
                {"n": 2, "x": 0.50, "y": 0.66},
                {"n": 3, "x": 0.935, "y": 0.42},
            ],
        ),
        (
            "侧栏-导出.png",
            "side-export.png",
            [
                {"n": 1, "x": 0.50, "y": 0.31},
                {"n": 2, "x": 0.50, "y": 0.50},
                {"n": 3, "x": 0.50, "y": 0.625},
                {"n": 4, "x": 0.50, "y": 0.75},
            ],
        ),
        (
            "领读面板.png",
            "prompter.png",
            [
                {"n": 1, "x": 0.14, "y": 0.08},
                {"n": 2, "x": 0.88, "y": 0.08},
                {"n": 3, "x": 0.12, "y": 0.40},
                {"n": 4, "x": 0.095, "y": 0.925},
            ],
        ),
    ]
    for src, dst, marks in jobs:
        path = annotate(src, dst, marks)
        print("annotated", path.name, Image.open(path).size)


def main() -> None:
    ANN.mkdir(parents=True, exist_ok=True)
    FIG.mkdir(parents=True, exist_ok=True)
    annotate_all()
    makers = [
        draw_workflow,
        draw_cues,
        draw_task_states,
        draw_script_format,
        draw_directory,
        draw_keyboard,
        draw_silence_timeline,
        draw_recovery,
        draw_params,
        draw_roles,
        draw_export_artifacts,
    ]
    for fn in makers:
        path = fn()
        print("figure", path.name, Image.open(path).size)
    crop_figures()


def crop_figures() -> None:
    paper = (246, 244, 240)
    for path in sorted(FIG.glob("*.png")):
        im = Image.open(path).convert("RGB")
        pix = im.load()
        w, h = im.size
        bottom = h - 1
        while bottom > 40:
            # row is still paper-colored
            if any(
                abs(pix[x, bottom][0] - paper[0]) + abs(pix[x, bottom][1] - paper[1]) + abs(pix[x, bottom][2] - paper[2]) > 24
                for x in range(0, w, 8)
            ):
                break
            bottom -= 1
        cut = min(h, bottom + 28)
        if cut < h - 8:
            im.crop((0, 0, w, cut)).save(path)
            print("crop", path.name, (w, h), "->", (w, cut))


if __name__ == "__main__":
    main()
