#!/usr/bin/env python3
"""Six-page illustrated guide for operators learning the September update."""
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether
from reportlab.graphics.shapes import Drawing, Rect, String, Line
import build_manual as b

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent.parent / 'output/pdf/标贝音频采集_新增功能快速上手_2026-09-07.pdf'
W = 174 * mm
TEAL = colors.HexColor('#277E79')
INK = colors.HexColor('#202B30')
MUTED = colors.HexColor('#556368')
PALE = colors.HexColor('#EAF4F2')
AMBER = colors.HexColor('#FFF2D8')
RED = colors.HexColor('#FBE9E6')
ST = {}

def p(text, kind='body'):
    return Paragraph(text, ST[kind])

def note(title, text, color=PALE):
    t = Table([[p(title, 'cardtitle')], [p(text, 'body')]], colWidths=[W])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),color),('BOX',(0,0),(-1,-1),.4,colors.HexColor('#D5E3E0')),('LEFTPADDING',(0,0),(-1,-1),11),('RIGHTPADDING',(0,0),(-1,-1),11),('TOPPADDING',(0,0),(-1,0),10),('BOTTOMPADDING',(0,-1),(-1,-1),10)]))
    return t

def rows(data, widths=None, header=None):
    result = []
    if header: result.append([p(x,'th') for x in header])
    result += [[p(x,'cell') for x in r] for r in data]
    t = Table(result,colWidths=widths or [W*.29,W*.71],hAlign='LEFT')
    commands=[('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9),('LINEBELOW',(0,0),(-1,-1),.5,colors.HexColor('#DDE4E3'))]
    if header: commands += [('BACKGROUND',(0,0),(-1,0),TEAL)]
    t.setStyle(TableStyle(commands))
    return t

def title(s, n, name, lead):
    if s: s.append(PageBreak())
    s.extend([p(f'新增功能快速上手  /  {n:02d}', 'eyebrow'), Spacer(1,8),p(name,'title'),Spacer(1,8),p(lead,'lead'),Spacer(1,12)])

def pic(name, caption, height):
    return [b.img(ROOT/'captures'/name, max_w=W, max_h=height*mm),Spacer(1,5),p(caption,'caption'),Spacer(1,10)]

def footer(c,doc):
    c.setStrokeColor(TEAL); c.setLineWidth(3);c.line(18*mm,282*mm,192*mm,282*mm)
    c.setFont('PF-M',8);c.setFillColor(MUTED)
    c.drawString(18*mm,11*mm,'标贝音频采集 · 0.2.0 · 2026-09-07')
    c.drawRightString(192*mm,11*mm,f'{doc.page} / 6')

def timeline():
    d=Drawing(W,107)
    for x,w,color,label in [(0,148,TEAL,'读：你好小贝'),(152,172,colors.HexColor('#DCEAE7'),'安静满 1 秒'),(328,W-328,colors.HexColor('#E8E9EC'),'之后再说的话')]:
        d.add(Rect(x,49,w,35,fillColor=color,strokeColor=None,rx=4))
        d.add(String(x+w/2,61,label,fontName='PF-M',fontSize=11,fillColor=colors.white if x==0 else INK,textAnchor='middle'))
    d.add(Line(326,32,326,96,strokeColor=colors.HexColor('#C7523F'),strokeWidth=2))
    d.add(String(326,12,'本句终点固定',fontName='PF-M',fontSize=11,fillColor=INK,textAnchor='middle'))
    d.add(String(74,30,'进入本句',fontName='PF-M',fontSize=10,fillColor=MUTED,textAnchor='middle'))
    d.add(String(411,30,'不再进入本句切片',fontName='PF-M',fontSize=10,fillColor=MUTED,textAnchor='middle'))
    return d

def story():
    s=[]
    title(s,1,'这次更新，先记住两件事','录唤醒词时，软件可以提醒音量异常，也可以在读完后自动停句。')
    s.append(rows([
        ['人声幅值检查','声音太小或太大时，及时提醒你。<br/>录完后可试听、重录，或确认保留。'],
        ['短句自动结束','读完并安静到设定时长，软件自动结束本句。<br/>停下后等你确认，才按原规则进入下一句。'],
    ],header=['新增功能','能帮你做什么']))
    s.extend([Spacer(1,16),note('两个开关都默认关闭，可以分别开启','只想检查音量，就只开「人声幅值检查」。录唤醒词时，可按项目需要同时开启两个开关。'),Spacer(1,18),p('第一次使用，照这 4 步做','section'),Spacer(1,7)])
    s.append(rows([
        ['① 打开设置','新建录制时设置；已有任务在右侧「设置」中修改。 → 第 2 页'],
        ['② 先试录一句','按项目要求确定幅值阈值，试听正常后再批量录制。 → 第 3 页'],
        ['③ 读完保持安静','开启自动结束后，等软件停句，不要马上重复读。 → 第 4 页'],
        ['④ 检查后确认','看提示、听录音，再决定确认或重录。 → 第 5 页'],
    ]))
    s.extend([Spacer(1,15),note('特别注意：自动停句仍可能录进多读内容','两次发声之间停顿不够，或一直不停顿地多读，仍会录进同一句。软件不判断你读了什么、读了几遍。',AMBER)])

    title(s,2,'在哪里打开？怎么保存？','找到「人声检查与短句录制」，再按需要勾选。')
    s.extend(pic('14-new-recording-policy.png','新建录制：勾选所需开关后，按原流程创建任务。图示为两个开关均已开启。',57))
    s.append(p('已有任务：右侧「设置」→ 修改 → 保存录制设置','section'))
    s.append(Spacer(1,8))
    left=[p('① 开启需要的功能','cardtitle'),p('两项互不影响；不需要哪项，就关闭哪项。'),Spacer(1,9),p('② 填写幅值参考值','cardtitle'),p('初始为 RMS 下限 −30、PEAK 上限 −3 dBFS。先按项目要求试录确定。'),Spacer(1,9),p('③ 调整静音时长','cardtitle'),p('点击「调整静音时长」。范围 0.2～5 秒，默认 1 秒。'),Spacer(1,9),p('④ 点击「保存录制设置」','cardtitle'),p('从下一次开始录制本句生效。正在录的这一遍沿用开始时的设置。')]
    t=Table([[left,b.img(ROOT/'captures/17-task-recording-policy.png',max_w=57*mm,max_h=96*mm)]],colWidths=[113*mm,61*mm])
    t.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),8)]));s.append(t)
    s.extend([Spacer(1,12),note('修改后什么时候生效？','两个新开关和幅值阈值，从下一次录制生效。短句模式下，相关静音参数也从下一次录制生效；历史录音不重新判定。')])

    title(s,3,'提示音量异常，先试听再决定','黄色图标及「声音偏小」「声音过大」显示在正文上方固定区域，并说明异常原因；领读面板同步提醒。')
    s.extend(pic('18-warning-confirmation.png','异常录音的处理按钮。黄色警告及阈值说明位于正文上方，正常结果不会显示警告标识。',34))
    s.append(rows([
        ['声音偏小','先试听是否清楚。检查话筒距离和声卡增益，调整后可重录。'],
        ['声音过大','先试听是否失真。降低声卡增益或适当调整距离，再试录。'],
        ['听起来可用','按项目要求核对后，点击「确认保留并录下一句」。软件会记下人工保留记录。'],
    ],header=['看到什么','怎么处理']))
    s.extend([Spacer(1,15),p('两个数值怎么理解？','section'),Spacer(1,5),rows([
        ['RMS 下限 −30','看人声的整体音量。−40 低于 −30，会触发偏小检查。'],
        ['PEAK 上限 −3','看人声最响的峰值。−1 高于 −3，会触发过大提醒。'],
    ]),Spacer(1,12),note('−30 / −3 dBFS 是参考值，不是验收标准','阈值应按项目要求确定；等于边界不算异常。软件只统计检测器识别的人声区间，首尾静音不会拉低人声 RMS。',AMBER),Spacer(1,10),p('提示时机：偏小使用 200 毫秒窗口，持续低于下限达 300 毫秒时提醒；峰值超限立即提醒。结束后还会检查整句，短促人声也会检查，录制中出现过的提醒仍保留。','small')])

    title(s,4,'读完后安静，软件自动停句','以下以「静音时长 1 秒」为例。只在已经检测到有效人声后，才开始判断是否自动结束。')
    s.append(timeline())
    s.extend([Spacer(1,9),note('看到待确认，就先停止朗读','本句已经结束。先检查录音，再点击确认；自动结束本身不会确认录音，也不会自动开始下一句。'),Spacer(1,16),p('同样多读一次，结果可能不同','section'),Spacer(1,7)])
    s.append(rows([
        ['停顿只有 0.5 秒','「你好小贝」→ 停 0.5 秒 → 再读一次<br/>静音还没满 1 秒，两次发声可能都录进本句。再次发声后重新累计静音。'],
        ['静音已满 1 秒','「你好小贝」→ 安静满 1 秒 → 再发声<br/>本句终点已固定。后面的声音不会进入已结束的本句切片。'],
        ['一直没有开口','不会自动生成空录音。先检查设备和通道，再开始朗读。'],
    ],header=['现场情况','会发生什么']))
    s.extend([Spacer(1,14),note('停顿短于设定时长，或连续多读，仍可能录进去','这项功能不识别朗读内容，也不判断重复次数。请提醒发音人：一遍读完后，保持安静，等待采录人员确认。',AMBER),Spacer(1,10),p('需要手动结束时，仍可点击「完成本句」或按 Space。母音频持续保存；自动停句固定的是本句切片终点。','small')])

    title(s,5,'停句以后，按当前按钮处理','先看本句状态，再选择试听、重录或确认。')
    s.append(rows([
        ['没有幅值提醒','检查无误，点击「确认并录下一句」。'],
        ['有幅值提醒','先试听，再决定重录，或按项目要求「确认保留并录下一句」。'],
        ['最后一句 / 关闭连续录制','确认后停下等待；有幅值提醒时，按钮可能显示「确认保留本句」。以当前按钮文案为准。'],
        ['提示「需重录」','按提示补录。音频中断、写盘失败、检测失败等问题，不能用人工保留绕过。'],
    ],header=['本句状态','下一步'],widths=[W*.33,W*.67]))
    s.extend([Spacer(1,17),p('已有合格录音，再重录时这样做','section'),Spacer(1,7),rows([
        ['① 重录并试听','新的录音作为另一版本保留，原版本不会被覆盖。'],
        ['② 满意就使用','点击「使用本次重录」；有幅值提醒时，先核对后再决定。'],
        ['③ 不满意就保留原录音','选择「保留原录音」，或再录一次。异常版本不会自动替换原合格版本。'],
    ]),Spacer(1,14),note('确认记录会保存下来','幅值指标、提醒、当次检测设置和人工保留记录随录音保存，重新打开任务后仍在。旧录音没有新检测结果，表示当时未检查，不代表达标。'),Spacer(1,10),p('确认后是否立即开录，仍由原来的连续录制和标签暂停设置决定。短句自动结束不会跳过人工确认。','small')])

    title(s,6,'遇到这些情况，照着处理','本页集中说明这次更新涉及的保存、授权和导出变化。')
    s.append(rows([
        ['设置改了，这一遍没变','正常。新设置从下一次录制生效；短句模式下，相关静音参数也遵循这一规则。'],
        ['整句数值正常，仍有提醒','录制中曾发生的幅值异常会保留。先试听，再按项目要求决定是否保留。'],
        ['录制中提示授权失效','立即停止朗读。等软件安全停止并封存后进入激活页；处理中不要强退或拔盘。失败时检查存储，按提示重试。'],
        ['激活页有待封存任务','处理页面列出的任务；目录异常时先核对原保存位置。外接盘更换后，不要仅凭相同盘符就继续录制。'],
        ['系统时间 / 授权记录异常','先核对系统时间；仍异常时保留原文件并联系管理员处理。'],
        ['带幅值提醒，能否导出？','可以，但本句须先人工确认，且没有其他阻断问题。幅值提醒本身不阻止导出。'],
        ['时间戳文件叫什么？','timestamps.json，包含录音检测和人工保留等记录。外部 WAV 切分也应使用它，不能用导出状态文件代替。'],
    ],header=['遇到什么','怎么做'],widths=[W*.34,W*.66]))
    s.extend([Spacer(1,15),note('开始批量录制前，用一句唤醒词检查这 4 项','① 设置已保存　② 试录并试听正常<br/>③ 若开启自动结束，停句后应待确认<br/>④ 确认后才按原规则进入下一句'),Spacer(1,11),p('本手册只介绍此次新增和调整的操作。截图为当前界面演示；完整录制与交付步骤请查阅《详细操作手册》。外部 WAV 切分的参数和命令另见《外部设备WAV切分脚本使用说明》。','small')])
    return s

def main():
    b.register_fonts()
    pdfmetrics.registerFontFamily('PF-M',normal='PF-M',bold='PF-M',italic='PF-M',boldItalic='PF-M')
    spec={
        'body':(11.2,18,INK),'cell':(10.5,17,INK),'th':(10.5,16,colors.white),
        'title':(25,33,INK),'lead':(12,20,MUTED),'section':(15,22,INK),
        'eyebrow':(10,14,TEAL),'cardtitle':(12,19,TEAL),'caption':(9,14,MUTED),'small':(9.6,15,MUTED),
    }
    for name,(size,leading,color) in spec.items():
        ST[name]=ParagraphStyle(name,fontName='PF-M',fontSize=size,leading=leading,textColor=color,wordWrap='CJK',alignment=TA_LEFT,spaceAfter=0)
    OUT.parent.mkdir(parents=True,exist_ok=True)
    doc=SimpleDocTemplate(str(OUT),pagesize=b.A4,leftMargin=18*mm,rightMargin=18*mm,topMargin=23*mm,bottomMargin=20*mm,title='标贝音频采集 · 新增功能快速上手',author='DataBaker',subject='人声幅值提醒、短句自动结束与相关操作变化')
    doc.build(story(),onFirstPage=footer,onLaterPages=footer)
    from pypdf import PdfReader
    pages=len(PdfReader(OUT).pages)
    assert pages==6,f'Unexpected pagination: {pages}'
    print(f'{OUT}: {pages} pages, {OUT.stat().st_size} bytes')

if __name__=='__main__': main()
