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
OUT = REPO / "output" / "pdf" / "标贝音频采集_详细操作手册_2026-08-28.pdf"
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
    canv.drawRightString(b.PAGE_W - 22 * mm, 20 * mm, "文档版本 2026-08-28")
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
    canv.drawString(b.LEFT, 6.2 * mm, f"{APP_VERSION} · 2026-08-28 · 采录人员版")
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


def story() -> list:
    s: list = [PageBreak()]

    page(s, 1, "先看这一页：标准工作流", "第一次使用时，先掌握从脚本到交付的完整路径。")
    s.append(steps([
        "点击“新建录制”并选择脚本；需要核对时点击“查看预览”。",
        "选择设备、通道、采样参数和判定方式；创建后保持稳定。",
        "完成环境检测，再逐句执行“开始录音 - 完成本句 - 确认并录下一句”。",
        "口误时重录；完成后只决定是否使用本次重录。",
        "在问题工作台清空阻断项，再选择交付范围并复验复制结果。",
    ]))
    s.append(b.callout("tip", "开工前 60 秒检查", "耳机已接好；麦克风和通道正确；没有其他软件占用声卡；脚本标签含义明确；保存位置空间充足。"))

    page(s, 2, "任务列表与进入任务", "首页只做三件事：新建录制、继续录制、查看历史结果。")
    s.extend(b.figure(CAP / "01-home.jpg", "录制任务首页", max_h=91 * mm))
    s.append(b.table("任务列表怎么看", ["区域", "内容", "建议操作"], [
        ["筛选", "全部 / 已完成 / 未完成", "按现场目标缩小范围"],
        ["任务行", "任务名、脚本、进度、更新时间、状态", "先核对任务名再进入"],
        ["保存位置", "任务根目录", "更改前先退出已打开任务"],
        ["状态", "完成、未完成、异常中断等", "异常中断必须进入检查"],
    ], [28 * mm, 66 * mm, b.CONTENT_W - 94 * mm]))
    s.append(b.callout("note", "“已完成”仍需复核", "任务完成表示句子流程结束，不自动等于交付成功；交付前还要查看问题与导出面板。"))

    page(s, 3, "新建录制", "脚本、输入设备、采集格式和判定方式都在创建前确认。")
    s.extend(b.figure(CAP / "02-setup.png", "新建录制页面：导入成功后可直接创建，需要时再查看预览", max_h=96 * mm))
    s.append(steps([
        "浏览并选择 CSV、TSV 或 TXT 脚本。",
        "选择输入设备、输入通道、采样率和采集格式。",
        "选择 VAD 或电平门；新任务默认推荐 VAD。",
        "检查检测策略、任务名和保存位置，再创建任务。",
    ]))
    s.append(b.callout("warn", "不要凭文件名判断脚本", "同名文件可能来自不同批次。导入成功后可直接创建；需要核对时，点击“查看预览”检查总条数、前 10 行和标签统计。"))

    page(s, 4, "三列脚本与导入预览", "CSV/TSV 固定为“序号、正文、标签”；TXT 用于无标签兼容。")
    s.extend(b.figure(CAP / "03-import-preview.png", "点击“查看预览”后，检查条数、空标签、标签种类、标签切换和前 10 行", max_h=96 * mm))
    s.append(b.table("脚本格式", ["格式", "要求", "创建规则"], [
        ["CSV / TSV", "三列：序号、正文、标签；兼容有/无表头", "缺第三列阻止；单行空标签允许"],
        ["TXT", "每行一条正文，自动生成序号，标签为空", "允许，并显示无标签兼容模式"],
        ["正文含逗号", "CSV 用双引号包住正文；TXT 无需处理", "正确转义后允许"],
    ], [29 * mm, 76 * mm, b.CONTENT_W - 105 * mm]))
    s.append(b.bullets([
        "重复序号、缺列或解析失败：修改源文件后重新选择，不要忽略。",
        "长标签会在左侧列表省略显示，但完整内容仍可查看，不影响保存。",
    ]))

    page(s, 5, "设备、格式与判定方式", "专业录制的第一原则是：参数在开录前确认，开录后保持稳定。")
    s.append(b.table("采集参数", ["项目", "建议", "注意"], [
        ["输入设备", "选择实际 USB 麦克风或声卡", "不要只看系统默认"],
        ["输入通道", "按话筒物理接入选择", "选错可能只有底噪或无声"],
        ["采样率/位深", "严格按项目要求", "不要在任务中更改系统格式"],
        ["VAD", "按语音活动判断", "异常会明确降级并标记受影响句"],
        ["电平门", "按音量阈值判断", "风扇、键盘声可能触发续接"],
    ], [28 * mm, 68 * mm, b.CONTENT_W - 96 * mm]))
    s.extend(b.figure(b.FIG / "params.png", "设备、通道、格式与静音判定的关系", max_h=85 * mm))
    s.append(b.callout("tip", "录制开始后锁定判定方式", "VAD 与电平门不会在录制中静默互换。检测器不可用时，软件会明确提示。"))

    page(s, 6, "环境检测", "环境检测用于发现选错设备、房间过吵和输入异常，不是形式步骤。")
    s.extend(b.figure(CAP / "04-workspace.jpg", "环境噪声检测", max_h=94 * mm))
    s.append(steps([
        "保持正式录制时的坐姿和麦克风距离。",
        "保持安静，不碰桌面、不敲键盘、不移动麦克风。",
        "确认实时 RMS 稳定低于上限，并等待多个时间窗连续合格。",
        "未通过时先处理环境、增益或输入设备，再重新检测。",
    ]))
    s.append(b.callout("warn", "不要用放宽阈值掩盖现场问题", "持续高噪声、底噪突变或无输入，应先排查麦克风、声卡、线材和系统占用。"))

    page(s, 7, "录制工作台怎么读", "左侧找句子，中间完成录制，右侧处理监听、检测、任务、导出和问题。")
    s.extend(b.figure(CAP / "12-monitor.jpg", "录制工作台全貌", max_h=95 * mm))
    s.append(b.table("工作台分区", ["区域", "职责", "重点"], [
        ["左侧", "句子定位、标签与状态", "当前句、待确认、需重录、标签边界"],
        ["中间", "正文、波形和录制控制", "按当前按钮文案完成一步"],
        ["右侧", "监听、检测、任务、导出、问题", "导出前清空阻断项"],
        ["底栏", "引擎与现场提示", "红色或异常提示先处理"],
    ], [26 * mm, 67 * mm, b.CONTENT_W - 93 * mm]))

    page(s, 8, "普通首录：两次点击", "普通录制保持熟悉节奏：结束一次、确认一次；同标签下一句随后立即开录。")
    s.append(steps([
        "核对正文和标签，按 Space 或点击“开始录音”。",
        "说完本句并满足尾静音后，按 Space 或点击“完成本句”。",
        "检查无误后，按 Space 或点击“确认并录下一句”。",
        "目标标签相同且规则允许时，下一句立即开始录音。",
    ]))
    s.extend(b.figure(b.FIG / "silence-timeline.png", "一句录音：首静音、有效语音、尾静音", max_h=83 * mm))
    s.append(b.callout("tip", "为什么分两步", "“完成本句”只结束录音；“确认并录下一句”才把结果纳入交付并继续，避免口误直接成为成品。"))
    s.append(b.callout("note", "最后一句", "末句确认后停留在末句并提示到达末尾，不会绕回第一句自动开录。"))

    page(s, 9, "标签变化：只提示", "紫色只表达标签变化；普通标签不会把整列染成紫色。")
    s.extend(b.figure(CAP / "05-label-change.jpg", "标签变化提示：只显示“标签已变化”", max_h=98 * mm))
    s.append(b.bullets([
        "不显示“从某标签变成某标签”的长文案。",
        "主界面和领读面板同步提示；标签文字只做一次轻微动效。",
        "默认不增加点击，仍按普通首录节奏继续。",
        "如项目要求强制确认，可在检测面板开启“标签变化时暂停”。",
    ]))
    s.append(b.callout("tip", "比较规则", "去掉首尾空格后按完整字符串比较；第一句不算变化；空标签与非空标签之间切换也算变化。"))

    page(s, 10, "重录：只处理本次", "完成重录后，只决定是否使用本次结果，操作保持直接。")
    s.extend(b.figure(CAP / "06-retake-decision.jpg", "本次重录处理区", max_h=98 * mm))
    s.append(steps([
        "在当前句点击“重录”或按 R，重新录制完整句子。",
        "完成后可“试听本次重录”。",
        "满意时“使用本次重录”；不满意时再次重录或“放弃本次重录”。",
        "处理完成后选中物理下一句，但不会自动开录。",
        "下一句也是已确认句时，主按钮显示“重录本句”；准备好后按 Space，不用每句再按 R。",
    ]))
    s.append(b.callout("note", "想停在这里", "点右侧“完成采集”即可结束；到末句后主按钮也会恢复为完成采集。"))
    s.append(b.callout("tip", "只聚焦本次重录", "重录区只保留试听、使用、放弃和再次重录，不增加与当前任务无关的比较操作。"))

    page(s, 11, "问题工作台与需重录", "所有影响交付的问题集中在“问题”面板；定位问题不会自动开始录音。")
    s.extend(b.figure(CAP / "07-issues.jpg", "问题工作台：阻断、警告和定位", max_h=97 * mm))
    s.append(b.table("常见问题", ["类型", "含义", "处理"], [
        ["待首录确认", "已经录完但未确认", "检查后确认或重录"],
        ["重录待确认", "本次重录尚未决定", "使用、放弃或再录"],
        ["必须重录", "当前句没有可交付结果", "定位后重新录完整句"],
        ["沿用原结果", "本次重录异常，仍有可用结果", "保持警告并按项目复核"],
        ["链路提示", "驱动提示但没有真实缺帧", "正常确认并继续下一句"],
        ["真实缺帧", "当前 attempt 已受损且不可交付", "先继续下一句，稍后补录"],
        ["任务级故障", "存储、检测器或状态问题", "先暂停，按提示排查"],
    ], [33 * mm, 72 * mm, b.CONTENT_W - 105 * mm]))
    s.append(b.callout("tip", "自动切句不等于合格", "真实缺帧时只把采集焦点移到下一物理句，受损 attempt 仍保留为“需重录”，不会进入确认切片或交付。母音频继续写入；末句则停在末句提示重录。"))

    page(s, 12, "检测面板与 VAD", "检测面板管理静音阈值、时长和自动化规则；判定方式开始后锁定。")
    s.extend(b.figure(CAP / "09-detection.jpg", "检测面板", max_h=95 * mm))
    s.append(b.table("VAD 状态", ["状态", "现场表现", "操作"], [
        ["正常", "分析跟得上输入", "继续录制"],
        ["lagging", "短时积压，非阻断提示", "降低系统负载并观察"],
        ["degraded", "队列满、分类器异常或刷新超时", "母轨继续，活动句完成后必须重录"],
        ["unavailable", "工作线程断开", "暂停并恢复，不能静默改用电平门"],
    ], [27 * mm, 74 * mm, b.CONTENT_W - 101 * mm]))
    s.append(b.callout("tip", "母轨优先", "检测异常时仍优先写入持续母音频。没有活动句时只记任务诊断，不污染下一句。"))

    page(s, 13, "暂停、退出与恢复", "退出不等于删除；重启后恢复上下文，但完整应用重启不会自动录音。")
    s.append(b.table("恢复场景", ["场景", "恢复结果", "重新进入"], [
        ["正常暂停", "保存当前位置与任务状态", "检查设备后继续"],
        ["退出任务", "任务留在首页", "从任务行进入，不自动开录"],
        ["完整应用重启", "恢复当前句、筛选和侧栏", "保持非录音状态"],
        ["界面刷新", "以录音引擎真实状态为准", "不伪造停止，不产生幽灵开录"],
        ["异常中断", "优先扫描母轨和事件", "先处理阻断再继续"],
    ], [33 * mm, 67 * mm, b.CONTENT_W - 100 * mm]))
    s.append(b.callout("note", "退出前", "先停止当前录音，再暂停采集或退出任务；不要在显示正在录音时拔掉声卡或移动任务目录。"))

    page(s, 14, "导出：先选范围", "母轨保全与逐句交付是两件事；导出面板会分别给出就绪度。")
    s.extend(b.figure(CAP / "08-export.jpg", "导出面板：仅已确认、完整任务和状态汇总", max_h=98 * mm))
    s.append(b.table("导出类型", ["类型", "包含", "规则"], [
        ["整轨 WAV", "持续母音频", "用于保全，不代表逐句合格"],
        ["时间戳 JSON", "句子、范围、诊断和任务信息", "用于审计和恢复"],
        ["仅已确认", "状态稳定且已确认的句子", "未完成项进入排除清单"],
        ["完整任务", "每句都有安全可用结果", "跳过、待确认、待处理、需重录均阻断"],
    ], [31 * mm, 71 * mm, b.CONTENT_W - 102 * mm]))
    s.append(b.callout("warn", "阻断不能绕过", "选中结果悬空、范围越界、物理帧不符、来源不覆盖或未知问题码时，两种逐句导出都不允许。"))

    page(s, 15, "复制到外部存储", "看到“交付成功”前，会完成来源绑定、流式复制、哈希校验和回执复验。")
    s.append(steps([
        "先在任务内生成导出产物，再选择目标目录。",
        "复制期间保持目标盘连接；需要停止时使用取消。",
        "等待哈希与回执校验，复验通过后才算交付成功。",
        "重启后若显示“待复验”，连接原目标盘并重新复验。",
    ]))
    s.append(b.bullets([
        "空间不足、读写错误、断开或取消：任务内源产物仍保留，可重试。",
        "同名文件不会静默覆盖；复制完成后再原子发布。",
        "U 盘、FAT 或 exFAT 无法保证突然断电时绝对持久，完成后仍需安全弹出。",
    ]))

    page(s, 16, "任务参数与应用设置", "右侧任务面板用于复核固定参数；应用设置用于语言、保存位置和日志。")
    s.append(b.two_figures(
        (CAP / "10-task.jpg", "任务参数"),
        (CAP / "11-settings.jpg", "应用设置"),
        "任务面板与应用设置",
    ))
    s.append(b.table("入口说明", ["入口", "用途", "注意"], [
        ["监听", "确认输入、Peak 和 RMS", "监听状态不等于开始录音"],
        ["任务", "核对设备、通道和格式", "发现不一致先暂停"],
        ["设置", "语言、默认位置、引擎、日志", "任务打开时不能改保存位置"],
        ["运行日志", "排查引擎、文件与操作异常", "随任务保存"],
    ], [25 * mm, 72 * mm, b.CONTENT_W - 97 * mm]))

    page(s, 17, "领读面板与字体", "领读面板只呈现领读员需要的信息，并与主控端同步正文、标签和提醒。")
    s.extend(b.figure(b.ANN / "prompter.png", "领读面板", max_h=100 * mm, max_w=140 * mm))
    s.append(b.bullets([
        "正文字号和标签字号分别调整；标签为 12-40 px，步长 2 px。",
        "设置持久化并双向同步；左侧句子列表保持紧凑，不随正文放大。",
        "标签变化时只提示“标签已变化”，并做一次轻微动效。",
        "领读面板断开会明确显示；录制状态仍以录音引擎为准。",
    ]))
    s.append(b.callout("tip", "现场分工", "采录员负责录制、波形、问题和导出；领读员只关注当前句、标签与节奏。"))

    page(s, 18, "键盘操作", "快捷键减少鼠标移动，但始终服从当前状态门禁。")
    s.append(b.table("快捷键", ["按键", "动作", "安全说明"], [
        ["Space", "开始 / 完成 / 确认并录下一句 / 继续重录", "以主按钮当前文案为准"],
        ["R", "开始第一句重录", "后续已确认句改用 Space，且不自动开录"],
        ["P", "试听当前允许试听的录音", "异常录音可能禁止试听"],
        ["S", "跳过当前句", "完整任务会被跳过句阻断"],
        ["方向键", "上一句 / 下一句", "问题定位与恢复不自动录音"],
        ["Esc", "关闭当前弹层", "不会绕过停止和确认流程"],
    ], [24 * mm, 72 * mm, b.CONTENT_W - 96 * mm]))
    s.append(b.callout("note", "防止快捷键穿透", "确认框、导入预览或设置弹层打开时先看焦点；关闭后再执行录制快捷键。"))

    page(s, 19, "常见问题与现场处置", "先判断属于输入、录制、状态还是交付，再按最短路径处理。")
    s.append(b.table("常见情况", ["现象", "可能原因", "处理"], [
        ["没有波形", "设备/通道错误、占用、线材断开", "暂停，刷新设备并核对物理通道"],
        ["环境噪声一直高", "房间噪声、振动、增益过高", "处理声源和摆位，不盲目放宽阈值"],
        ["链路 warning 后待确认", "驱动提示但没有真实缺帧", "正常确认，并按规则继续下一句"],
        ["本句需重录且已切句", "检测到真实缺帧", "继续采集；稍后从问题面板补录"],
        ["一句完成后停住", "待确认、重录待处理或已到末句", "看主按钮和问题面板，不连续按 Space"],
        ["标签提示频繁", "真实频繁变化或数据列错位", "对照预览和项目标签规则"],
        ["本次重录不能使用", "校验未完或录音异常", "等待校验或再次重录"],
        ["仅已确认可导出", "完整任务仍有未完成/跳过/阻断", "按导出汇总逐项处理"],
        ["复制后待复验", "重启或目标盘暂不可识别", "连接同一目标盘并复验"],
    ], [43 * mm, 65 * mm, b.CONTENT_W - 108 * mm]))
    s.append(b.callout("tip", "需要技术支持时", "提供任务名、时间、句子序号、完整界面截图和运行日志；不要只描述“录不了”。"))

    page(s, 20, "收工与交付检查单", "每次任务结束都按同一顺序收尾，避免现场完成、交付失败。")
    s.append(b.table("交付检查", ["检查项", "合格标准", "确认"], [
        ["问题工作台", "阻断为 0；警告已按项目规则复核", "□"],
        ["句子统计", "已确认、需重录、跳过与现场记录一致", "□"],
        ["母轨与诊断", "保全导出完成，文件可读取", "□"],
        ["逐句范围", "已选仅已确认或完整任务，清单已核对", "□"],
        ["复制与哈希", "目标复制完成，哈希与回执复验通过", "□"],
        ["现场备份", "按项目要求保留源产物与第二副本", "□"],
        ["退出与设备", "任务正常退出，声卡停止后断开设备", "□"],
    ], [38 * mm, b.CONTENT_W - 56 * mm, 18 * mm]))
    s.append(Spacer(1, 10))
    s.append(b.callout("tip", "最终判断", "软件显示成功、交付清单一致、目标文件复验通过，三者同时满足才算完成。"))
    s.append(Spacer(1, 14))
    s.append(b.P("— 结束 —", "center_muted"))
    s.append(b.P("若界面与本手册不一致，以当前软件按钮文案和任务内状态为准。", "center_muted"))
    return s


def concise_story() -> list:
    """Operator manual: short, practical, and based on visible controls."""
    s: list = [PageBreak()]

    page(s, 1, "快速上手", "按下面顺序做，一次录制任务就能顺利完成。")
    s.extend(b.figure(CAP / "01-home.jpg", "录制任务首页", max_h=88 * mm))
    s.append(steps([
        "点击“新建录制”，选择本次脚本。",
        "脚本导入成功后可直接继续；需要核对时点击“查看预览”。",
        "通过环境检测后开始录制。",
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
        "点击“查看预览”时重点看：总条数、前 10 行、空标签数和标签切换次数。",
        "序号重复、正文为空或列数不对时，回到源文件修改后重新导入。",
        "长标签在左侧会省略显示，但不会丢失。",
    ]))

    page(s, 3, "设备和环境检测", "设备、通道、格式按项目要求选择；检测不过就先解决现场问题。")
    s.append(b.two_figures(
        (CAP / "02-setup.png", "设备与判定方式"),
        (CAP / "04-workspace.jpg", "环境噪声检测"),
        "设备设置与环境检测",
    ))
    s.append(steps([
        "选择实际使用的麦克风或声卡，不要只看“系统默认”。",
        "多通道声卡要核对话筒接入的是输入 1 还是输入 2。",
        "环境检测时保持安静，不碰桌面、不敲键盘、不移动麦克风。",
        "一直不通过时，检查房间噪声、声卡增益、线材和设备占用。",
    ]))
    s.append(b.callout("note", "判定方式", "新任务一般使用 VAD；也可按项目要求选电平门。开始录制后不再切换。"))

    page(s, 4, "录制工作台", "左侧选句，中间录制，右侧看监听、检测、任务、导出和问题。")
    s.extend(b.figure(CAP / "12-monitor.jpg", "录制工作台", max_h=98 * mm))
    s.append(b.table("四个常用区域", ["区域", "用来做什么", "重点看什么"], [
        ["左侧列表", "找句子、看标签和状态", "当前句、待确认、需重录"],
        ["中间正文", "看正文、波形和首尾静音", "正文是否读完整、波形是否正常"],
        ["底部按钮", "开始、完成、确认、重录、跳过", "按当前按钮文案操作"],
        ["右侧工具", "监听、检测、任务、导出、问题", "红色问题先处理"],
    ], [29 * mm, 70 * mm, b.CONTENT_W - 99 * mm]))

    page(s, 5, "普通录制和标签提醒", "普通录制保持两次点击：先结束本句，再确认并录下一句。")
    s.extend(b.figure(CAP / "05-label-change.jpg", "标签变化时的主界面", max_h=97 * mm))
    s.append(steps([
        "核对正文和标签，按 Space 或点击“开始录音”。",
        "读完并安静下来，按 Space 或点击“完成本句”。",
        "检查无误后，再按 Space 或点击“确认并录下一句”。",
        "同标签下一句会直接开始录音；最后一句确认后停在末尾。",
    ]))
    s.append(b.callout("tip", "标签变化", "界面只提示“标签已变化”，标签文字会轻微动一下。默认不增加点击；如项目要求，可在检测面板开启“标签变化时暂停”。"))

    page(s, 6, "重录怎么处理", "只处理本次重录：试听、使用、放弃，或者再录一次。")
    s.extend(b.figure(CAP / "06-retake-decision.jpg", "本次重录处理区", max_h=99 * mm))
    s.append(steps([
        "点击“重录”或按 R，重新录完整句子。",
        "录完后可点击“试听本次重录”。",
        "满意就点“使用本次重录”；不满意就再次重录或“放弃本次重录”。",
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
        ["链路 warning（无缺帧）", "正常确认，继续下一句"],
        ["真实缺帧", "受损句留待重录；先继续采集下一句"],
        ["任务问题", "先暂停，按界面提示检查存储或录音设备"],
    ], [46 * mm, b.CONTENT_W - 46 * mm]))
    s.append(b.callout("tip", "手动定位与自动续录", "手动点击上一条、下一条或需重录定位时不会开录；真实缺帧封闭后，系统会切到下一物理句，并按正常自动续录与标签暂停规则决定是否开始。"))

    page(s, 8, "右侧检测和任务参数", "现场调整主要在“检测”；固定参数在“任务”中复核。")
    s.append(b.two_figures(
        (CAP / "09-detection.jpg", "检测"),
        (CAP / "10-task.jpg", "任务参数"),
        "检测与任务参数",
    ))
    s.append(b.bullets([
        "检测：调整静音阈值、静音时长，以及是否暂停自动续接。",
        "任务：核对麦克风、通道、录音格式和已确认数量。",
        "链路 warning 但没有真实缺帧时，本句仍可正常确认并继续。",
        "检测到真实缺帧时，母轨继续保存；受损句标为需重录且不可交付，系统先切到下一句继续采集。",
        "发现设备或通道不对时先暂停，不要带着错误输入继续录。",
    ]))

    page(s, 9, "暂停、退出和重新打开", "任务不会因为退出而删除；重新打开后也不会自动录音。")
    s.append(b.table("常见情况", ["操作", "会发生什么", "回来后怎么做"], [
        ["暂停采集", "停止声卡，保留当前任务和进度", "检查设备后继续"],
        ["退出任务", "回到任务列表", "从任务行重新进入"],
        ["关闭并重开软件", "恢复当前句和侧栏位置", "保持非录音状态，确认后再开始"],
        ["异常中断", "优先保留已写入的录音", "进入任务，先处理问题提示"],
    ], [34 * mm, 72 * mm, b.CONTENT_W - 106 * mm]))
    s.append(b.callout("warn", "退出前", "先停止当前录音，再暂停或退出。显示正在录音时不要拔声卡，也不要移动任务目录。"))

    page(s, 10, "导出和复制", "先看导出汇总，再决定导出全部完成的任务，还是只导出已经确认的句子。")
    s.extend(b.figure(CAP / "08-export.jpg", "导出面板", max_h=99 * mm))
    s.append(b.table("导出选择", ["项目", "适合什么时候用", "注意"], [
        ["整轨 WAV", "保存完整母音频", "有整轨不代表每句都合格"],
        ["时间戳 JSON", "保存句子范围和任务信息", "建议与整轨一起保存"],
        ["仅已确认", "先交已经确认的句子", "未完成句会列在排除清单"],
        ["完整任务", "整批全部完成后交付", "跳过、待确认或需重录都会阻止"],
    ], [31 * mm, 70 * mm, b.CONTENT_W - 101 * mm]))
    s.append(b.callout("tip", "复制完成后", "等界面明确显示复制和校验完成，再安全弹出移动硬盘或 U 盘。失败时源文件仍留在任务内，可重试。"))

    page(s, 11, "设置、领读面板和快捷键", "设置不常动；领读面板只负责显示当前句和标签。")
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

    page(s, 12, "常见问题和收工检查", "出现问题先看当前按钮和“问题”面板；收工前按清单过一遍。")
    s.append(b.table("现场常见问题", ["现象", "先怎么处理"], [
        ["没有波形", "检查设备、通道、线材和其他软件占用"],
        ["环境检测一直不过", "降低环境噪声，检查增益和麦克风距离"],
        ["只显示链路 warning", "无真实缺帧时正常确认并继续下一句"],
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
