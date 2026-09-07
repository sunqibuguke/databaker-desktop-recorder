#!/usr/bin/env python3
"""Build the screenshot-led DataBaker operator manual PDF."""

from pathlib import Path

from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Frame, NextPageTemplate, PageBreak, PageTemplate, Spacer

import build_manual as b


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
CAP = ROOT / "captures"
OUT = REPO / "output" / "pdf" / "标贝音频采集_详细操作手册_2026-09-07.pdf"
APP_VERSION = "0.2.0"


def cover(canv, doc) -> None:
    canv.saveState()
    canv.setFillColor(b.DARK)
    canv.rect(0, 0, b.PAGE_W, b.PAGE_H, fill=1, stroke=0)
    hero = b.FIG / "cover-hero.jpg"
    reader = ImageReader(str(hero))
    iw, ih = reader.getSize()
    target_h = b.PAGE_H * 0.47
    scale = max(b.PAGE_W / iw, target_h / ih)
    dw, dh = iw * scale, ih * scale
    canv.drawImage(reader, (b.PAGE_W - dw) / 2, b.PAGE_H - dh + 8, dw, dh, mask="auto")
    canv.setFillColor(Color(0.06, 0.07, 0.07, alpha=0.46))
    canv.rect(0, b.PAGE_H - target_h, b.PAGE_W, target_h, fill=1, stroke=0)
    canv.setFillColor(b.ACCENT)
    canv.rect(0, b.PAGE_H * 0.47 - 42 * mm, 4 * mm, 42 * mm, fill=1, stroke=0)
    if b.LOGO.exists():
        canv.drawImage(str(b.LOGO), 22 * mm, b.PAGE_H - 28 * mm, 14 * mm, 14 * mm, mask="auto")
    canv.setFillColor(white)
    canv.setFont("PF-M", 11)
    canv.drawString(40 * mm, b.PAGE_H - 21.5 * mm, "标贝 DataBaker")
    canv.setFillColor(HexColor("#8FD4CF"))
    canv.setFont("PF", 9)
    canv.drawString(40 * mm, b.PAGE_H - 26.5 * mm, "PROFESSIONAL AUDIO COLLECTION")
    y = b.PAGE_H * 0.47 - 8 * mm
    canv.setFillColor(HexColor("#8FD4CF"))
    canv.setFont("PF-M", 10)
    canv.drawString(22 * mm, y, "采录人员版 · 当前界面截图")
    canv.setFillColor(white)
    canv.setFont("Song-B", 33)
    canv.drawString(22 * mm, y - 16 * mm, "标贝音频采集")
    canv.setFont("Song-B", 27)
    canv.drawString(22 * mm, y - 29 * mm, "详细操作手册")
    canv.setFillColor(HexColor("#C9CDCC"))
    canv.setFont("PF", 10.5)
    canv.drawString(22 * mm, y - 42 * mm, "任务 · 录制 · 问题处理 · 恢复 · 导出交付")
    canv.setStrokeColor(HexColor("#2A2E2F"))
    canv.setLineWidth(0.6)
    canv.line(22 * mm, 28 * mm, b.PAGE_W - 22 * mm, 28 * mm)
    canv.setFillColor(HexColor("#9AA0A0"))
    canv.setFont("PF", 8.5)
    canv.drawString(22 * mm, 20 * mm, f"产品版本 {APP_VERSION} · 采录人员操作手册")
    canv.drawRightString(b.PAGE_W - 22 * mm, 20 * mm, "文档版本 2026-09-07")
    canv.restoreState()


def body(canv, doc) -> None:
    canv.saveState()
    canv.setFillColor(b.PAPER)
    canv.rect(0, 0, b.PAGE_W, b.PAGE_H, fill=1, stroke=0)
    canv.setStrokeColor(b.LINE)
    canv.setLineWidth(0.4)
    canv.line(b.LEFT, 11 * mm, b.PAGE_W - b.RIGHT, 11 * mm)
    canv.setFillColor(b.MUTED)
    canv.setFont("PF", 8)
    canv.drawString(b.LEFT, 6.2 * mm, f"{APP_VERSION} · 2026-09-07 · 采录人员版")
    canv.drawRightString(b.PAGE_W - b.RIGHT, 6.2 * mm, f"{doc.page}")
    canv.restoreState()


def manual_page(canv, doc) -> None:
    if doc.page == 1:
        cover(canv, doc)
    else:
        body(canv, doc)


def page(story: list, num: int, title: str, lead: str) -> None:
    if story and not isinstance(story[-1], PageBreak):
        story.append(PageBreak())
    story.extend([
        b.P(f"第 {num:02d} 章", "chapno"),
        b.heading(1, title),
        b.P(lead, "lead"),
    ])


def steps(rows: list[str]):
    return b.table(
        "操作步骤",
        ["步骤", "操作"],
        [[f"{i:02d}", row] for i, row in enumerate(rows, 1)],
        [18 * mm, b.CONTENT_W - 18 * mm],
    )


def concise_story() -> list:
    """Operator manual: short, practical, and based on visible controls."""
    s: list = [PageBreak()]

    page(s, 1, "快速上手", "按下面顺序做，一次录制任务就能顺利完成。")
    s.extend(b.figure(CAP / "01-home.jpg", "录制任务首页", max_h=88 * mm))
    s.append(steps([
        "点击“新建录制”，选择本次脚本。",
        "脚本导入成功后可直接继续；需要核对时点击“查看预览”。",
        "通过环境检测并完成 10 秒输入试听后开始录制；必要时可明确跳过试听。",
        "逐句录制；有口误就重录，有问题就到“问题”面板处理。",
        "结束后先看导出汇总，再生成文件并复制到目标位置。",
    ]))
    s.append(b.callout("tip", "开录前检查", "耳机已接好；麦克风和通道选对；房间安静；保存位置空间充足。"))

    page(s, 2, "新建录制和导入脚本", "创建前把脚本和设备选对，后面就不用反复返工。")
    s.append(b.two_figures(
        (CAP / "02-setup.png", "导入后可直接创建"),
        (CAP / "03-import-preview.png", "点击按钮查看导入预览"),
        "新建录制与导入预览",
    ))
    s.append(b.table("脚本要求", ["格式", "怎么准备", "注意"], [
        ["CSV / TSV", "三列：序号、正文、标签", "缺第三列不能创建；单行标签可为空"],
        ["TXT", "每行一条正文", "自动生成序号，按无标签方式导入"],
    ], [30 * mm, 68 * mm, b.CONTENT_W - 98 * mm]))
    s.append(b.bullets([
        "导入后不用再点“确认导入”，其他配置已就绪时可直接创建任务。",
        "“查看预览”是导入框下方的紧凑行内按钮；点击后重点看总条数、前 10 行、空标签数和标签切换次数。",
        "序号重复、正文为空或列数不对时，回到源文件修改后重新导入。",
        "长标签在左侧会省略显示，但不会丢失。",
        "页面只有表单内容滚动；底部就绪状态和“创建录制任务”始终可见。",
    ]))

    page(s, 3, "设备、采集参数和环境检测", "设备与通道按实际接线选择；采样率和输出位深按客户要求确认，检测不过就先解决现场问题。")
    s.append(b.two_figures(
        (CAP / "02-setup.png", "设备与判定方式"),
        (CAP / "04-workspace.jpg", "环境噪声检测"),
        "设备设置与环境检测",
    ))
    s.append(steps([
        "选择实际使用的麦克风或声卡，不要只看“系统默认”。",
        "多通道声卡要核对话筒接入的是输入 1 还是输入 2。",
        "在同一采集参数区确认采集模式、输入通道、采样率和输出位深；默认输出位深为 16-bit PCM，可选 8/16/24/32。",
        "普通任务设置不显示驱动输入格式；软件自动选择满足输出精度的输入表示，并把实际值写入任务元数据。",
        "“检测策略（高级）”只管理 VAD / 电平门、静音阈值、静音时长和检测规则。",
        "环境检测时保持安静，不碰桌面、不敲键盘、不移动麦克风。",
        "试听面板先选择“跳过试听”或“开始 10 秒试听”；开始后右下角仅保留可随时点击的“结束并跳过试听”。",
        "右上角 × 仅取消试听、不记录跳过；录满 10 秒后自动回放，回放出现后可立即确认。",
        "一直不通过时，检查房间噪声、声卡增益、线材和设备占用。",
    ]))
    s.append(b.callout("note", "判定方式", "新任务一般使用 VAD；也可按项目要求选电平门。开始录制后不再切换。"))

    page(s, 4, "录制工作台", "左侧选句，中间录制，右侧看监听、检测、设置、任务、导出和问题。")
    s.extend(b.figure(CAP / "12-monitor.jpg", "录制工作台", max_h=98 * mm))
    s.append(b.table("四个常用区域", ["区域", "用来做什么", "重点看什么"], [
        ["左侧列表", "找句子、看标签和状态", "当前句、待确认、需重录"],
        ["中间正文", "看正文、波形和首尾静音", "正文是否读完整、波形是否正常"],
        ["底部按钮", "开始、完成、确认、重录、跳过", "按当前按钮文案操作"],
        ["右侧工具", "监听、检测、设置、任务、导出、问题", "红色问题先处理"],
    ], [29 * mm, 70 * mm, b.CONTENT_W - 99 * mm]))

    page(s, 5, "普通录制和标签提醒", "关闭短句自动结束时：先手动结束本句，再人工确认。")
    s.extend(b.figure(CAP / "05-label-change.jpg", "标签变化时的主界面", max_h=97 * mm))
    s.append(steps([
        "核对正文和标签，按 Space 或点击“开始录音”。",
        "读完并安静下来，按 Space 或点击“完成本句”。",
        "检查无误后，再按 Space 或点击“确认并录下一句”。",
        "开启确认后自动录下一句时，同标签下一句直接开始；否则停下等待。最后一句确认后停在末尾。",
    ]))
    s.append(b.callout("tip", "标签变化", "界面只提示“标签已变化”，标签文字会轻微动一下。默认不增加点击；如项目要求，可在设置面板开启“标签变化时先暂停”。"))

    page(s, 6, "重录怎么处理", "只处理本次重录：试听、使用、放弃，或者再录一次。")
    s.extend(b.figure(CAP / "06-retake-decision.jpg", "本次重录处理区", max_h=99 * mm))
    s.append(steps([
        "点击“重录”或按 R，重新录完整句子。",
        "录完后可点击“试听本次重录”。",
        "满意就点“使用本次重录”；不满意就再次重录或“保留原录音”。",
        "处理完成后会选中下一句，但不会自动开录。",
        "如果下一句也已确认，主按钮显示“重录本句”；按 Space 继续，不用再按 R。",
    ]))
    s.append(b.callout("tip", "要结束", "点旁边的“完成采集”；到末句后也会自动恢复为完成按钮。"))
    s.append(b.callout("note", "按钮暂时不可点", "说明软件还在检查本次录音。稍等片刻；若出现明确异常，按提示重新录制。"))

    page(s, 7, "问题和需重录", "“问题”面板会把当前任务需要处理的句子集中列出来。")
    s.extend(b.figure(CAP / "07-issues.jpg", "问题面板", max_h=98 * mm))
    s.append(b.table("问题处理", ["看到什么", "怎么做"], [
        ["待录确认", "检查本句后确认，或重新录制"],
        ["重录待确认", "使用、放弃或再次重录"],
        ["必须重录", "点进去，重新录完整句"],
        ["警告", "按项目要求复核；有可用录音时不一定阻止导出"],
        ["链路 warning（无缺帧）", "受影响句仍需重录；任务可继续"],
        ["真实缺帧", "受损句留待重录；先继续采集下一句"],
        ["任务问题", "先暂停，按界面提示检查存储或录音设备"],
    ], [46 * mm, b.CONTENT_W - 46 * mm]))
    s.append(b.callout("tip", "手动定位与自动续录", "手动点击上一条、下一条或需重录定位时不会开录；真实缺帧封闭后，系统会切到下一物理句，并按正常自动续录与标签暂停规则决定是否开始。"))

    page(s, 8, "右侧检测、设置和任务参数", "判定参数在“检测”调整，录制行为在“设置”调整，固定参数在“任务”复核。")
    s.append(b.two_figures(
        (CAP / "09-detection.jpg", "检测"),
        (CAP / "13-recording-settings.jpg", "本次录制设置"),
        "检测与本次录制设置",
    ))
    s.append(b.bullets([
        "检测：只调整判定方式、静音阈值和静音时长。",
        "设置：调整连续录制、标签变化暂停、录制保护与提示；新增人声幅值检查和短句自动结束，详见后两章。侧栏只影响当前任务。",
        "短句模式下，静音参数修改从下一次录制生效；本次录制使用开始时的配置。",
        "任务：核对麦克风、通道、录音格式和已确认数量。",
        "链路 warning 即使没有检测到真实缺帧，受影响句仍需重录；任务可以继续。",
        "检测到真实缺帧时，母轨继续保存；受损句标为需重录且不可交付，系统先切到下一句继续采集。",
        "发现设备或通道不对时先暂停，不要带着错误输入继续录。",
    ]))

    for num, title, lead, kind in [
        (9, "人声检查与短句设置", "两个独立开关默认关闭；新建时选择，已有任务也可保存修改。", "settings"),
        (10, "幅值提醒与人工保留", "提醒用于及时复核；请先试听，再决定重录或确认保留。", "amplitude"),
        (11, "短句自动结束", "适用于唤醒词等短句；自动停句后仍须人工确认。", "auto"),
    ]:
        page(s, num, title, lead)
        s.extend(b.recording_policy_content(kind))

    page(s, 12, "暂停、退出和重新打开", "任务不会因为退出而删除；重新打开后也不会自动录音。")
    s.append(b.table("常见情况", ["操作", "会发生什么", "回来后怎么做"], [
        ["暂停采集", "停止声卡，保留当前任务和进度", "检查设备后继续"],
        ["退出任务", "回到任务列表", "从任务行重新进入"],
        ["关闭并重开软件", "恢复当前句和侧栏位置", "保持非录音状态，确认后再开始"],
        ["异常中断", "优先保留已写入的录音", "进入任务，先处理问题提示"],
    ], [34 * mm, 72 * mm, b.CONTENT_W - 106 * mm]))
    s.append(b.callout("warn", "退出前", "先停止当前录音，再暂停或退出。显示正在录音时不要拔声卡，也不要移动任务目录。"))

    page(s, 13, "导出和复制", "先看导出汇总，再决定导出全部完成的任务，还是只导出已经确认的句子。")
    s.extend(b.figure(CAP / "08-export.jpg", "导出面板", max_h=99 * mm))
    s.append(b.table("导出选择", ["项目", "适合什么时候用", "注意"], [
        ["整轨 WAV", "保存完整母音频", "有整轨不代表每句都合格"],
        ["时间戳 JSON", "保存句子范围和任务信息", "建议与整轨一起保存"],
        ["仅已确认", "先交已经确认的句子", "未完成句会列在排除清单"],
        ["完整任务", "整批全部完成后交付", "跳过、待确认或需重录都会阻止"],
    ], [31 * mm, 70 * mm, b.CONTENT_W - 101 * mm]))
    s.append(b.callout("tip", "复制完成后", "等界面明确显示复制和校验完成，再安全弹出移动硬盘或 U 盘。失败时源文件仍留在任务内，可重试。"))

    s.append(b.P("时间戳文件为 timestamps.json，保存当次检测配置、人声指标、幅值提醒、人工保留和结束原因。历史缺少结果表示未检查，不代表达标。外部设备 WAV 切分另见《外部设备WAV切分脚本使用说明》；不要使用导出状态文件代替时间戳文件。"))

    page(s, 14, "应用设置、领读面板和快捷键", "应用设置管理以后新任务的默认值；领读面板只负责显示当前句和标签。")
    s.append(b.two_figures(
        (CAP / "11-settings.jpg", "应用设置"),
        (b.ANN / "prompter.png", "领读面板"),
        "应用设置与领读面板",
    ))
    s.append(b.table("常用快捷键", ["按键", "动作", "注意"], [
        ["Space", "开始 / 完成 / 确认并录下一句 / 继续重录", "以当前主按钮文案为准"],
        ["R", "开始第一句重录", "后续已确认句改用 Space，且不自动开录"],
        ["P", "试听", "不能试听时按界面提示处理"],
        ["S", "跳过", "完整任务导出会被跳过句阻止"],
        ["Esc", "关闭当前弹层", "录音中不会跳过停止步骤"],
    ], [24 * mm, 75 * mm, b.CONTENT_W - 99 * mm]))

    page(s, 15, "授权异常与安全封存", "录制中出现授权提示时，先停止朗读，让软件保存已写入的音频。")
    s.append(steps([
        "看到授权失效或领读面板提示立即停止朗读时，不再继续读句子。",
        "软件先安全停止并封存，再进入激活页。处理中保留当前界面；不要强退、拔盘或移动任务目录。",
        "封存失败时检查存储连接和可用空间，按页面提示重试；未完成前不能开始新录制。",
        "在激活页处理所有待封存任务，包括较早的任务。目录或进度数据异常时按提示核对，不要忽略。",
        "确认授权与封存问题已解决后，再打开任务检查进度、试听并补录；异常版本不会自动成为已确认版本。",
    ]))
    s.append(b.callout("warn", "外接盘路径变了", "先接回原任务所在磁盘并核对目录。盘符或路径相同也可能已换成另一块盘；不要把新盘当成原任务直接继续录制。按界面要求明确选择正确位置。"))
    s.append(b.P("系统时间异常时先恢复正确的系统时间。提示本机授权记录无法验证时，保留原文件并联系管理员检查系统安全存储或恢复授权；不要通过回拨时间、删除记录来继续使用。"))

    page(s, 16, "常见问题和收工检查", "出现问题先看当前按钮和“问题”面板；收工前按清单过一遍。")
    s.append(b.table("现场常见问题", ["现象", "先怎么处理"], [
        ["没有波形", "检查设备、通道、线材和其他软件占用"],
        ["环境检测一直不过", "降低环境噪声，检查增益和麦克风距离"],
        ["只显示链路 warning", "受影响句仍需重录；任务可以继续"],
        ["本句需重录且已切句", "真实缺帧；继续采集，稍后从问题面板补录"],
        ["一句完成后停住", "看是否待确认、需重录或正在处理本次重录"],
        ["标签提示很多", "对照导入预览，确认脚本标签列没有错位"],
        ["完整任务不能导出", "按导出汇总和问题面板逐项处理"],
        ["复制显示待复验", "连接原目标盘，重新执行复验"],
    ], [58 * mm, b.CONTENT_W - 58 * mm]))
    s.append(b.table("收工检查", ["检查项", "合格标准", "确认"], [
        ["问题", "阻断为 0；警告已复核", "□"],
        ["句子", "已确认、需重录、跳过数量已核对", "□"],
        ["导出", "范围和排除清单已核对", "□"],
        ["复制", "目标文件已完成校验", "□"],
        ["退出", "任务正常退出后再断开设备", "□"],
    ], [34 * mm, b.CONTENT_W - 52 * mm, 18 * mm]))
    s.append(b.callout("tip", "需要技术支持时", "提供任务名、发生时间、句子序号、完整界面截图和运行日志。"))
    s.append(Spacer(1, 10))
    s.append(b.P("— 结束 —", "center_muted"))
    return s


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    b.register_fonts()
    b.STY = b.styles()
    b.FIG_COUNTER["n"] = 0
    b.TBL_COUNTER["n"] = 0
    doc = b.ManualDoc(
        str(OUT),
        pagesize=b.A4,
        title="标贝音频采集 详细操作手册",
        author="DataBaker",
        subject="专业音频采录软件采录人员操作手册",
        creator="DataBaker Manual Builder",
    )
    manual_frame = Frame(
        b.LEFT,
        b.BOTTOM + 4 * mm,
        b.CONTENT_W,
        b.PAGE_H - b.TOP - b.BOTTOM - 6 * mm,
        id="manual",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="manual", frames=[manual_frame], onPage=manual_page)])
    doc.multiBuild(concise_story())
    print("wrote", OUT, "pages", doc.page, "size", OUT.stat().st_size)


if __name__ == "__main__":
    main()
