#!/usr/bin/env python3
"""Build the DataBaker desktop recorder operator handbook."""

from __future__ import annotations

from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Frame,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
ANN = ROOT / "annotated"
FIG = ROOT / "figures"
CAP = ROOT / "captures"
FONTS = ROOT / "build" / "fonts"
LOGO = REPO / "assets" / "brand" / "databaker-recorder-logo.png"
OUT = ROOT / "标贝音频采集_使用手册.pdf"

PAGE_W, PAGE_H = A4
LEFT = 18 * mm
RIGHT = 18 * mm
TOP = 18 * mm
BOTTOM = 16 * mm
CONTENT_W = PAGE_W - LEFT - RIGHT

INK = HexColor("#1C1E1F")
INK2 = HexColor("#4A4E50")
MUTED = HexColor("#7A7E80")
LINE = HexColor("#D8D4CC")
PAPER = HexColor("#F6F4F0")
ACCENT = HexColor("#2F8F8A")
ACCENT_SOFT = HexColor("#D7EDEC")
CORAL = HexColor("#E0523E")
AMBER = HexColor("#C48A2A")
AMBER_SOFT = HexColor("#F4E7C8")
RED_SOFT = HexColor("#F6D6D4")
GREEN = HexColor("#2E8A62")
DARK = HexColor("#141516")
DARK2 = HexColor("#1E2021")


def register_fonts() -> None:
    # PingFang is CFF and cannot be embedded by reportlab. Use Songti + Heiti.
    pdfmetrics.registerFont(TTFont("PF", str(FONTS / "SongtiSC-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("PF-M", str(FONTS / "HeitiSC-Medium.ttf")))
    pdfmetrics.registerFont(TTFont("PF-B", str(FONTS / "HeitiSC-Medium.ttf")))
    pdfmetrics.registerFont(TTFont("Song-B", str(FONTS / "SongtiSC-Bold.ttf")))


def S(name, **kw) -> ParagraphStyle:
    base = dict(fontName="PF", fontSize=10, leading=16, textColor=INK, wordWrap="CJK")
    base.update(kw)
    return ParagraphStyle(name, **base)


def styles() -> dict[str, ParagraphStyle]:
    return {
        "cover_kicker": S("cover_kicker", fontName="PF-M", fontSize=11, leading=16, textColor=HexColor("#8FD4CF"), alignment=TA_LEFT),
        "cover_title": S("cover_title", fontName="Song-B", fontSize=36, leading=44, textColor=white),
        "cover_sub": S("cover_sub", fontName="PF", fontSize=13, leading=20, textColor=HexColor("#C9CDCC")),
        "h1": S("h1", fontName="Song-B", fontSize=22, leading=28, textColor=INK, spaceBefore=4, spaceAfter=10),
        "h2": S("h2", fontName="PF-B", fontSize=13.5, leading=20, textColor=INK, spaceBefore=14, spaceAfter=6),
        "h3": S("h3", fontName="PF-M", fontSize=11.5, leading=17, textColor=HexColor("#2A5F5C"), spaceBefore=10, spaceAfter=4),
        "body": S("body", fontSize=10, leading=16.5, textColor=INK, alignment=TA_JUSTIFY, spaceAfter=7),
        "lead": S("lead", fontSize=11, leading=18, textColor=INK2, alignment=TA_JUSTIFY, spaceAfter=10),
        "caption": S("caption", fontName="PF-M", fontSize=8.5, leading=12, textColor=INK2, spaceBefore=4, spaceAfter=3),
        "legend": S("legend", fontSize=9, leading=13.5, textColor=INK, spaceAfter=2),
        "cell": S("cell", fontSize=8.5, leading=12.5, textColor=INK),
        "cell_h": S("cell_h", fontName="PF-M", fontSize=8.5, leading=12.5, textColor=white),
        "toc1": S("toc1", fontName="PF-M", fontSize=11, leading=18, textColor=INK),
        "toc2": S("toc2", fontName="PF", fontSize=9.5, leading=15, textColor=INK2, leftIndent=14),
        "footer": S("footer", fontSize=8, leading=10, textColor=MUTED),
        "box_title": S("box_title", fontName="PF-B", fontSize=9, leading=13, textColor=INK),
        "box_body": S("box_body", fontSize=9, leading=13.5, textColor=INK),
        "li": S("li", fontSize=10, leading=15.5, textColor=INK),
        "figlabel": S("figlabel", fontName="PF-M", fontSize=8, leading=11, textColor=ACCENT, spaceBefore=8),
        "chapno": S("chapno", fontName="PF-B", fontSize=10, leading=13, textColor=ACCENT, spaceBefore=0, spaceAfter=2),
        "center_muted": S("center_muted", fontSize=9, leading=13, textColor=MUTED, alignment=TA_CENTER),
    }


STY = styles()
FIG_COUNTER = {"n": 0}
TBL_COUNTER = {"n": 0}


def next_fig(title: str) -> str:
    FIG_COUNTER["n"] += 1
    return f"图 {FIG_COUNTER['n']}  {title}"


def next_tbl(title: str) -> str:
    TBL_COUNTER["n"] += 1
    return f"表 {TBL_COUNTER['n']}  {title}"


def P(text: str, style: str = "body") -> Paragraph:
    return Paragraph(text, STY[style])


def heading(level: int, text: str, bookmark: str | None = None) -> Paragraph:
    key = {1: "h1", 2: "h2", 3: "h3"}[level]
    para = Paragraph(text, STY[key])
    para._toc = (level - 1, text)  # type: ignore[attr-defined]
    para._bookmark = bookmark or text  # type: ignore[attr-defined]
    return para


def bullets(items: list[str]) -> ListFlowable:
    return ListFlowable(
        [ListItem(P(item, "li"), leftIndent=12, bulletColor=ACCENT) for item in items],
        bulletType="bullet",
        start="•",
        leftIndent=14,
        bulletFontName="PF-B",
        bulletFontSize=9,
        spaceBefore=2,
        spaceAfter=8,
    )


def img(path: Path, max_w: float | None = None, max_h: float = 118 * mm) -> Image:
    max_w = max_w or CONTENT_W
    with PILImage.open(path) as im:
        w, h = im.size
    scale = min(max_w / w, max_h / h)
    flow = Image(str(path), width=w * scale, height=h * scale)
    flow.hAlign = "CENTER"
    return flow


def figure(path: Path, title: str, legends: list[str] | None = None, max_h: float = 118 * mm, max_w: float | None = None):
    label = next_fig(title)
    picture = KeepTogether([P(label, "figlabel"), img(path, max_w=max_w, max_h=max_h)])
    bits: list = [picture]
    if legends:
        rows = []
        for i, line in enumerate(legends, 1):
            badge = Paragraph(f"<b>{i}</b>", ParagraphStyle("badge", fontName="PF-B", fontSize=8, leading=11, textColor=white, alignment=TA_CENTER))
            rows.append([badge, P(line, "legend")])
        tbl = Table(rows, colWidths=[7 * mm, CONTENT_W - 7 * mm])
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, -1), CORAL),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (0, -1), 2),
            ("RIGHTPADDING", (0, 0), (0, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ("LEFTPADDING", (1, 0), (1, -1), 8),
            ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ]))
        bits.append(Spacer(1, 3))
        bits.append(tbl)
    bits.append(Spacer(1, 8))
    return bits


def two_figures(left: tuple[Path, str], right: tuple[Path, str], title: str):
    label = next_fig(title)
    gap = 6 * mm
    col = (CONTENT_W - gap) / 2
    a = img(left[0], max_w=col, max_h=105 * mm)
    b = img(right[0], max_w=col, max_h=105 * mm)
    tbl = Table(
        [[a, b], [P(left[1], "caption"), P(right[1], "caption")]],
        colWidths=[col, col],
    )
    tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    return KeepTogether([P(label, "figlabel"), tbl, Spacer(1, 8)])


def callout(kind: str, title: str, body: str):
    colors = {
        "tip": (ACCENT_SOFT, ACCENT),
        "note": (AMBER_SOFT, AMBER),
        "warn": (RED_SOFT, CORAL),
    }
    bg, bar = colors[kind]
    data = [[P(f"<b>{title}</b>", "box_title")], [P(body, "box_body")]]
    tbl = Table(data, colWidths=[CONTENT_W - 4])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, bar),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (0, 0), 8),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return KeepTogether([tbl, Spacer(1, 8)])


def table(title: str, headers: list[str], rows: list[list[str]], widths: list[float] | None = None):
    label = next_tbl(title)
    if widths is None:
        n = len(headers)
        widths = [CONTENT_W / n] * n
    head = [P(h, "cell_h") for h in headers]
    body = [[P(c, "cell") for c in row] for row in rows]
    tbl = Table([head] + body, colWidths=widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), DARK2),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.3, LINE),
    ]
    for i in range(1, len(body) + 1):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), HexColor("#EFECE6")))
        else:
            style.append(("BACKGROUND", (0, i), (-1, i), white))
    tbl.setStyle(TableStyle(style))
    return KeepTogether([P(label, "figlabel"), tbl, Spacer(1, 8)])


def chapter_banner(num: str, title: str, blurb: str):
    h = heading(1, title)
    block = KeepTogether([
        P(f"第 {num} 章", "chapno"),
        h,
        P(blurb, "lead"),
    ])
    return [CondPageBreak(70 * mm), block]


class ManualDoc(BaseDocTemplate):
    def afterFlowable(self, flowable):
        toc = getattr(flowable, "_toc", None)
        if toc:
            level, text = toc
            self.notify("TOCEntry", (level, text, self.page))
            key = f"toc-{level}-{text}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=level, closed=level > 0)


def draw_cover(canv, doc) -> None:
    canv.saveState()
    canv.setFillColor(DARK)
    canv.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    hero = FIG / "cover-hero.jpg"
    if hero.exists():
        reader = ImageReader(str(hero))
        iw, ih = reader.getSize()
        target_h = PAGE_H * 0.46
        scale = max(PAGE_W / iw, target_h / ih)
        dw, dh = iw * scale, ih * scale
        canv.drawImage(reader, (PAGE_W - dw) / 2, PAGE_H - dh + 8, dw, dh, mask="auto")
        canv.setFillColor(Color(0.08, 0.08, 0.09, alpha=0.42))
        canv.rect(0, PAGE_H - target_h, PAGE_W, target_h, fill=1, stroke=0)

    canv.setFillColor(ACCENT)
    canv.rect(0, PAGE_H - 46 * mm - PAGE_H * 0.46 + PAGE_H * 0.46, 4 * mm, 46 * mm, fill=1, stroke=0)

    if LOGO.exists():
        canv.drawImage(str(LOGO), 22 * mm, PAGE_H - 28 * mm, 14 * mm, 14 * mm, mask="auto")
    canv.setFillColor(white)
    canv.setFont("PF-M", 11)
    canv.drawString(40 * mm, PAGE_H - 21.5 * mm, "标贝 DataBaker")
    canv.setFillColor(HexColor("#8FD4CF"))
    canv.setFont("PF", 9)
    canv.drawString(40 * mm, PAGE_H - 26.5 * mm, "DESKTOP RECORDER")

    y = PAGE_H * 0.46 - 8 * mm
    canv.setFillColor(HexColor("#8FD4CF"))
    canv.setFont("PF-M", 10)
    canv.drawString(22 * mm, y, "操作说明")
    canv.setFillColor(white)
    canv.setFont("Song-B", 34)
    canv.drawString(22 * mm, y - 16 * mm, "标贝音频采集")
    canv.setFont("Song-B", 28)
    canv.drawString(22 * mm, y - 28 * mm, "使用手册")

    canv.setFillColor(HexColor("#C9CDCC"))
    canv.setFont("PF", 11)
    canv.drawString(22 * mm, y - 42 * mm, "操作员版")

    canv.setStrokeColor(HexColor("#2A2E2F"))
    canv.setLineWidth(0.6)
    canv.line(22 * mm, 28 * mm, PAGE_W - 22 * mm, 28 * mm)
    canv.setFillColor(HexColor("#9AA0A0"))
    canv.setFont("PF", 8.5)
    canv.drawString(22 * mm, 20 * mm, "产品版本 0.2.0")
    canv.drawRightString(PAGE_W - 22 * mm, 20 * mm, "文档版本 2026.09")
    canv.restoreState()


def draw_body(canv, doc) -> None:
    canv.saveState()
    canv.setFillColor(PAPER)
    canv.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canv.setFillColor(DARK)
    canv.rect(0, PAGE_H - 11 * mm, PAGE_W, 11 * mm, fill=1, stroke=0)
    canv.setFillColor(ACCENT)
    canv.rect(0, PAGE_H - 11 * mm, 4 * mm, 11 * mm, fill=1, stroke=0)
    canv.setFillColor(HexColor("#D5DBDA"))
    canv.setFont("PF", 8)
    canv.drawString(LEFT, PAGE_H - 7.2 * mm, "标贝音频采集  ·  使用手册")
    canv.drawRightString(PAGE_W - RIGHT, PAGE_H - 7.2 * mm, "DataBaker Recorder 0.2")

    canv.setStrokeColor(LINE)
    canv.setLineWidth(0.4)
    canv.line(LEFT, 11 * mm, PAGE_W - RIGHT, 11 * mm)
    canv.setFillColor(MUTED)
    canv.setFont("PF", 8)
    canv.drawString(LEFT, 6.2 * mm, "操作说明")
    canv.drawRightString(PAGE_W - RIGHT, 6.2 * mm, f"{doc.page}")
    canv.restoreState()


def draw_blank_cover_frame(canv, doc) -> None:
    draw_cover(canv, doc)


def build_story() -> list:
    s: list = []

    s += [
        NextPageTemplate("body"),
        PageBreak(),
        Paragraph("目录", STY["h1"]),
        P("按界面操作顺序说明。图中红色序号与下文对应。", "lead"),
    ]
    toc = TableOfContents()
    toc.levelStyles = [STY["toc1"], STY["toc2"]]
    s.append(toc)
    s.append(PageBreak())

    s += [
        heading(1, "激活"),
        P("首次打开、授权过期、换机或系统时间异常时，显示激活页。复制本机机器码，将收到的授权码粘贴后点「激活」。"),
    ]
    s.extend(figure(
        ANN / "license.png",
        "激活页",
        [
            "界面语言。",
            "当前状态标题。",
            "本机机器码。",
            "复制机器码。",
            "授权码输入框。",
            "激活。",
        ],
    ))
    s.append(P("激活页也可能提示先封存未完成录制：授权失效后不能继续录，可先封闭已写入的音频。"))

    s += [
        heading(1, "任务列表"),
        P("激活后进入任务列表。可筛选、打开、导出、打开目录、检查修复或删除任务。"),
    ]
    s.extend(figure(
        ANN / "home.png",
        "任务列表",
        [
            "产品名称。",
            "应用设置。",
            "页面标题。",
            "新建录制。",
            "筛选：全部 / 已完成 / 未完成。",
            "保存位置，可更改或刷新。",
            "任务名称、脚本和格式。",
            "状态。",
            "打开、导出、打开目录、更多。",
            "录音引擎连接状态。",
        ],
    ))
    s.append(table(
        "任务状态",
        ["状态", "含义"],
        [
            ["当前录制", "本机正在打开的任务"],
            ["未完成", "仍有待录或待确认的句子"],
            ["已完成", "全部句子已确认或跳过"],
            ["异常中断", "上次未正常结束"],
            ["需要检查", "目录或进度数据异常"],
            ["安全停止中", "正在保存母轨，等待完成"],
            ["只读保护", "可查看、试听；修复前不能继续录"],
        ],
        [36 * mm, CONTENT_W - 36 * mm],
    ))
    s.append(heading(2, "行内操作"))
    s.append(bullets([
        "查看：进入查看，不打开声卡。可选句、看该句波形、试听；导出在右侧栏。",
        "录制：打开声卡进入录制。未完成任务以此为主按钮；已完成任务用来补录。",
        "点任务名等于查看。进行中的任务只显示返回录制。",
        "异常任务的主按钮为「检查并修复」；修复后回到首页重新计算状态，不会自动进入任务或打开声卡。",
        "文件夹：在资源管理器中打开任务目录。",
        "更多 · 打开导出目录 / 重置任务 / 删除。危险操作会先要求确认。",
    ]))

    s += [
        heading(1, "新建录制"),
        P("在任务列表点「新建录制」。分三步：导入脚本、确认采集参数、命名并选择保存位置。采集模式、输入通道、采样率和输出位深集中在同一个参数区；检测策略只管理静音判定与检测规则。页面底部的就绪状态和「创建录制任务」始终可见，表单内容单独滚动。创建后进入查看，此时声卡未打开。"),
    ]
    s.extend(figure(
        ANN / "setup.png",
        "新建录制",
        [
            "选择 CSV / TSV / TXT 脚本。",
            "导入后的行内「查看预览」按钮。",
            "采集预设。",
            "输入设备；刷新按钮用于重新扫描声卡。",
            "采集模式、输入通道、采样率和输出位深；不支持的组合会直接列出原因。",
            "连续录制方式。",
            "检测策略（高级）：静音阈值、时长、VAD / 电平门和检测规则。",
            "固定在页面底部的就绪状态与创建按钮。",
        ],
    ))
    s.append(heading(2, "脚本"))
    s.append(P("推荐 UTF-8。CSV / TSV 固定三列：序号 / 句子正文 / 标签（备注）；表头可用中文或 id / text / label，无表头时按第 1–3 列读取。缺少第三列会阻止创建，但单行空标签允许。TXT 按每行一条正文导入，自动生成序号并使用空标签。解析成功后已直接导入，需要核对时点“查看预览”，不需要再确认导入。ID 不能为空或重复，正文不能为空。导入后任务使用固化副本，改原文件不影响已创建的任务。"))
    s.extend(figure(FIG / "script-format.png", "脚本格式", max_h=95 * mm))
    s.append(heading(2, "音频输入"))
    s.append(bullets([
        "采集预设：保存或套用本机常用的设备、通道、采样率与输出位深组合。",
        "Windows 采集模式：独占，或系统混音。独占失败会报错，不会改成混音后仍显示独占。",
        "采样率：在采集参数区按客户要求选择；不再放在检测策略中。",
        "输出位深：默认 16-bit PCM，可选 8-bit PCM、16-bit PCM、24-bit PCM 或 32-bit Float；该选项同时决定母音频和导出 WAV 的位深。",
        "驱动输入格式不作为普通任务选项展示。软件自动选择满足所选输出精度的 i16 / i24 / i32 / f32 输入表示，并把实际值写入任务元数据。",
        "多通道声卡按「输入 1、输入 2…」选择通道，导出为单声道 WAV。",
        "静音阈值默认约 −42 dBFS（越靠近 −72 越敏感，越靠近 −12 越抗噪）。前后静音时长 0.2–5.0 秒，默认 1.0 秒。进入任务后仍可改，不改采集预设。",
    ]))
    s.append(P("部分界面若显示「系统采集（本机开发）」，表示当前不是 Windows 正式采集。Windows 上同一位置为「独占」和「系统混音」。"))

    s += [
        heading(1, "录制界面"),
        P("查看进入后不打开声卡：选句会返显该句波形，主按钮为试听，整页右下角为「进入录制」。进入录制后才打开声卡，底部按钮恢复为试听、重录、主按钮和跳过。"),
    ]
    s.extend(figure(
        ANN / "console.png",
        "录制界面",
        [
            "返回任务列表。未结束时会先确认暂停或结束。",
            "句子列表与状态：待录 / 待确认 / 已确认 / 已跳过。",
            "上一句 / 下一句、累计时长、打开领读面板。录制中不能切句。",
            "当前句子：标签和正文。",
            "查看时显示当前句波形；录制中显示实时波形、Peak / RMS。",
            "查看：试听 P、试听本句；右下角进入录制。录制：试听、重录、主按钮、跳过。",
            "右侧栏：监听、检测、设置、任务、导出。",
            "状态栏。红色文字需先处理。",
        ],
    ))
    s.append(heading(2, "进入录制、环境检测与输入试听"))
    s.append(P("查看时主按钮为「试听本句」，整页右下角为「进入录制」，其下为「退出查看」。点「进入录制」或任务列表的「录制」后打开声卡并开始写母轨。新建或恢复开卡后，先按任务规则做约 3 秒环境噪声检测，再在第一句前完成 10 秒输入试听。试听面板首次打开时，右下角提供「跳过试听」和「开始 10 秒试听」；开始后只保留常态可点击的「结束并跳过试听」，点击会结束测试录音并把任务记为「已跳过」。右上角 × 为「取消试听」，只退出面板，不记录为已跳过；完成或明确跳过前不能开始正式录音。录满 10 秒后自动回放，回放出现后「声音正常，开始录制」即可点击，不要求完整播放一次；也可直接跳过试听，不再出现二次确认。输入试听与环境检测互不替代；同一次应用启动、相同采集配置不重复提示。未进入录制时声卡未打开，查看态显示该句波形或「本句尚无录音」，不把 Peak / RMS 显示成 −∞。"))
    s.append(PageBreak())
    s.append(heading(2, "录一句"))
    s.append(table(
        "一句的操作",
        ["操作", "结果"],
        [
            ["空格或「开始录音」", "进入句首静音；达到后提示请朗读"],
            ["朗读", "检测到语音后进入录制"],
            ["读完后安静", "累计句尾静音；达到设定时长后可结束"],
            ["空格或「完成本句」", "封闭本句，进入待确认"],
            ["空格确认", "本句标为已确认，转到下一句"],
            ["R 重录", "首句按 R；处理后转到下一已确认句，按 Space 继续重录"],
            ["S 跳过", "本句标为已跳过，不进入分段导出"],
            ["← / →", "切换句子；录制中不可用"],
        ],
        [48 * mm, CONTENT_W - 48 * mm],
    ))
    s.extend(figure(
        ANN / "console-live.png",
        "采集中，本句已录、待确认",
        [
            "顶部为「采集中 · 声卡持续开启」。声卡已打开，母轨在写。",
            "当前句状态为待确认。",
            "波形上方的首 / 尾时长。图中尾静音已够。",
            "本句波形。两侧竖线为切片起止。",
            "主按钮为「确认并录下一句」，对应空格。",
            "右侧：本句已录制、首/尾、磁盘。",
            "暂停采集，或退出任务。",
        ],
    ))
    s.append(P("未检测到语音就停止：取消本句，不生成可用录音。已开口但尾静音不够也可以结束，该次录音会标记为尾静音未达标。停句后可查看「首 / 尾」时长；「请等待朗读」是开口提示，不是首静音。设置栏中「首尾静音检查」只控制是否显示该信息。"))
    s.append(P("声卡驱动只要报告输入不连续，本次录音就标为「需重录」且不能交付；能够估算缺帧时，引擎还会插入等长静音保持母音频时间轴。母音频和整批采集不中断，受影响句保留在「问题」面板，稍后再补录。末句发生输入不连续时停在末句提示重录。"))
    s.append(heading(2, "状态显示"))
    s.extend(figure(FIG / "cue-colors.png", "状态色", max_h=88 * mm))
    s.append(heading(2, "暂停与退出"))
    s.append(P("右下角拆成两个动作。「暂停采集」停止声卡并封存母轨，但留在当前任务，可继续查看、导出或重新进入录制。「退出任务」才返回列表。当前句已有语音则先封闭为待确认；未开口则取消这次空录音。全部句子已处理时，主按钮通常为完成采集；如果刚处理完一句重录并转到下一已确认句，主按钮会改为「重录本句」，按 Space 开始，不会自动开录。要结束可点旁边的「完成采集」。确认完成后进入查看模式，不回列表。离开用「退出任务」或查看里的「退出查看」。出现故障时按界面提示安全结束。"))

    s += [
        heading(1, "右侧栏"),
        P("五个页签：监听、检测、设置、任务、导出。出现故障或磁盘告警时会多出「问题」。"),
    ]
    s.append(two_figures(
        (CAP / "09-detection.jpg", "检测：只保留判定参数"),
        (CAP / "13-recording-settings.jpg", "设置：录制行为与提示"),
        "检测与设置",
    ))
    s.extend(figure(
        ANN / "side-monitor.png",
        "监听",
        [
            "检查模式或采集中。",
            "领读面板是否已连接。",
            "输入电平 Peak / RMS。",
            "当前句状态、首/尾静音、磁盘。",
            "静音判定。点「调整」打开检测页。",
            "页签。",
        ],
        max_w=88 * mm,
        max_h=115 * mm,
    ))
    s.extend(figure(
        CAP / "09-detection.jpg",
        "检测",
        [
            "判定方式：VAD 或能量阈值。",
            "静音阈值。滑条上的短线为当前 RMS。",
            "静音时长 0.2–5.0 秒。",
            "已应用到本任务的值；可恢复为进入任务时的值。",
        ],
        max_w=88 * mm,
        max_h=115 * mm,
    ))
    s.append(P("检测页的修改作用于当前任务的当前句和后续句，不改采集预设。"))
    s.append(P("设置页管理当前任务的连续录制、标签变化暂停、录制保护和提示。关闭“确认后自动录下一句”时，“标签变化时先暂停”会置灰但保留选择；行为摘要会直接说明当前是逐句暂停、同标签连续，还是跨标签连续。侧栏修改只保存到当前任务；以后新任务的默认值在顶部“应用设置”中修改。"))
    s.extend(figure(
        CAP / "13-recording-settings.jpg",
        "设置",
        [
            "连续录制：确认后自动下一句，标签变化时可先暂停。",
            "录制保护：强制收尾静音、空录丢弃和环境检测。",
            "提示反馈：首尾静音、过静和峰值偏高。",
            "底部明确显示“只影响当前任务”，并可恢复进入任务时的值。",
        ],
        max_w=88 * mm,
        max_h=115 * mm,
    ))
    s.extend(figure(
        ANN / "side-task.png",
        "任务",
        [
            "本次设备、模式、通道、导出格式、驱动格式、环境检测上限、已确认/已跳过句数。",
            "打开或定位领读面板。有外接屏时放到外接屏。",
            "页签。",
        ],
        max_w=88 * mm,
        max_h=110 * mm,
    ))
    s.extend(figure(
        ANN / "side-export.png",
        "导出",
        [
            "导出目录。默认在任务目录内；另选目录时会再复制一份。",
            "整轨 WAV。",
            "时间戳 JSON。",
            "分段 ZIP。待录、待确认或无可用录音的句子不包含在内。",
        ],
        max_w=88 * mm,
        max_h=115 * mm,
    ))
    s.append(P("正在录某一句时不能导出，需先结束或取消该句。三个产物可分别生成。任务带故障标记时，分段导出可能不可用。"))

    s += [
        heading(1, "领读面板"),
        P("独立窗口，显示当前句子。可从界面顶部或「任务」页打开；已打开时为「定位领读面板」。"),
    ]
    s.extend(figure(
        ANN / "prompter.png",
        "领读面板",
        [
            "句子 ID 与条序。",
            "状态。",
            "朗读正文。",
            "标签备注。",
        ],
    ))
    s.append(P("窗口底部可调正文字号（A− / A+，22–72 px，默认 36）和标签字号（12–40 px，默认 16）。主界面当前句子与标签共用同一套字号。也可在齿轮里微调字号和可朗读颜色（默认绿色）。设置保存在本机，换任务后仍有效。"))

    s += [
        heading(1, "导出"),
        P("可在任务列表点「导出」，或在任务内打开「导出」页。导出内容以已保存数据为准，不要求全部句子录完。"),
    ]
    s.extend(figure(FIG / "export-artifacts.png", "导出内容", max_h=80 * mm))
    s.append(table(
        "导出内容",
        ["项", "文件", "内容"],
        [
            ["整轨 WAV", "full-track.wav", "连续母轨"],
            ["时间戳 JSON", "metadata.json", "句子文本、选中录音、样本起止"],
            ["分段 ZIP", "sentences/*.wav", "已确认且有可用录音的单句"],
        ],
        [32 * mm, 42 * mm, CONTENT_W - 74 * mm],
    ))
    s.append(P("各产物会显示：从未导出、当前、需要重新导出、上次失败。"))

    s += [
        heading(1, "设置"),
    ]
    s.extend(figure(
        ANN / "settings.png",
        "应用设置",
        [
            "语言，立即切换，重启后保持。",
            "默认保存位置。任务打开期间不能改。",
            "录音引擎连接状态。",
            "运行日志。",
            "授权状态。",
            "关闭设置。",
        ],
        max_w=128 * mm,
        max_h=128 * mm,
    ))
    s.extend(figure(
        ANN / "settings-language.png",
        "语言",
        ["可选：中文、英语、泰语、日语、韩语、西班牙语、葡萄牙语。"],
        max_w=140 * mm,
        max_h=48 * mm,
    ))
    s.append(P("运行日志可按全部 / 警告+ / 错误筛选，可搜索、复制、下载。日志随任务保存，删除任务时一并删除。"))

    s += [
        heading(1, "快捷键"),
    ]
    s.extend(figure(FIG / "keyboard.png", "快捷键", max_h=92 * mm))
    s.append(table(
        "快捷键",
        ["按键", "未在录", "录制中", "待确认"],
        [
            ["Space", "查看时试听；录制时开始；连续重录时重录本句；全部完成后结束采集", "结束本句", "确认"],
            ["R", "查看时进入录制；已确认句上开始第一句重录", "无", "再次重录"],
            ["P", "试听", "无", "试听"],
            ["S", "跳过（需已进入录制）", "无", "跳过"],
            ["← / →", "上一句 / 下一句", "不可用", "上一句 / 下一句"],
            ["Esc", "关闭对话框", "打开退出确认", "关闭对话框"],
        ],
        [22 * mm, 52 * mm, 36 * mm, CONTENT_W - 110 * mm],
    ))

    s += [
        heading(1, "常见情况"),
    ]
    s.append(table(
        "界面提示与操作",
        ["情况", "操作"],
        [
            ["Peak / RMS 为 −∞", "先点「进入录制」；检查设备和通道"],
            ["环境检测未通过", "保持安静后重新检测；需要时降低增益"],
            ["输入过载", "降低声卡增益，本句重录"],
            ["几乎无声", "检查通道、接线、系统静音"],
            ["链路 warning（无缺帧）", "受影响句仍需重录；任务可以继续"],
            ["真实缺帧", "本句标为需重录且不可交付；先切下一句继续采集，稍后补录"],
            ["独占失败", "关闭占用声卡的其他软件，或改用系统混音"],
            ["磁盘余量预警 / 紧急", "尽快暂停采集或退出任务，更换保存位置"],
            ["异常中断", "检查并修复后再打开"],
            ["需要检查 / 只读", "可打开原目录查看；修复前不能继续录"],
            ["领读窗口找不到", "点「定位领读面板」"],
            ["不能导出分段", "先检查并修复；整轨和 JSON 仍可能可用"],
            ["引擎离线", "查看日志后重启应用"],
            ["立即停止朗读", "停止朗读，按界面提示处理"],
        ],
        [48 * mm, CONTENT_W - 48 * mm],
    ))

    s.append(Spacer(1, 12))
    s.append(P("标贝音频采集 0.2  ·  2026.09", "center_muted"))
    return s


def main() -> None:
    register_fonts()
    global STY
    STY = styles()
    FIG_COUNTER["n"] = 0
    TBL_COUNTER["n"] = 0

    doc = ManualDoc(
        str(OUT),
        pagesize=A4,
        title="标贝音频采集 使用手册",
        author="DataBaker",
        subject="标贝音频采集 0.2 操作手册",
        creator="DataBaker Handbook Builder",
    )
    cover_frame = Frame(0, 0, PAGE_W, PAGE_H, id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    body_frame = Frame(LEFT, BOTTOM + 4 * mm, CONTENT_W, PAGE_H - TOP - BOTTOM - 6 * mm, id="body")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[cover_frame], onPage=draw_blank_cover_frame),
        PageTemplate(id="body", frames=[body_frame], onPage=draw_body),
    ])
    doc.multiBuild(build_story())
    print("wrote", OUT, "pages", doc.page, "size", OUT.stat().st_size)


if __name__ == "__main__":
    main()
