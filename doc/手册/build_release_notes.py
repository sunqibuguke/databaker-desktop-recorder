#!/usr/bin/env python3
"""Formal screenshot-led release notes: change title, screenshot, description."""
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether
from pypdf import PdfReader
import build_manual as b

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent.parent / 'output/pdf/标贝音频采集_功能更新说明_2026-09-08.pdf'
W = 174 * mm
ST = {}

def p(text, style='body'):
    return Paragraph(text, ST[style])

def section(n, title, screenshot, caption, descriptions, height):
    result=[p(f'{n:02d}　{title}','section'),Spacer(1,9)]
    result += [b.img(ROOT/'captures'/screenshot,max_w=W,max_h=height*mm),Spacer(1,5),p(caption,'caption'),Spacer(1,9)]
    for text in descriptions:
        result += [p(text),Spacer(1,5)]
    return result

def page(c, doc):
    c.setFillColor(colors.HexColor('#213C3C'))
    c.setFont('PF-M',11)
    c.drawString(18*mm,282*mm,'标贝音频采集 · 功能更新说明')
    c.setFont('PF-M',8)
    c.setFillColor(colors.HexColor('#697777'))
    c.drawRightString(192*mm,282*mm,'产品版本 0.2.0')
    c.setStrokeColor(colors.HexColor('#39837F'));c.setLineWidth(.8)
    c.line(18*mm,278*mm,192*mm,278*mm)
    c.setStrokeColor(colors.HexColor('#DCE3E1'));c.setLineWidth(.4)
    c.line(18*mm,16*mm,192*mm,16*mm)
    c.drawString(18*mm,10*mm,'文档版本：2026-09-08　｜　截图为当前界面演示')
    c.drawRightString(192*mm,10*mm,f'{doc.page} / 3')

def story():
    s=[]
    s += section(1,'人声检查改用 16-bit samp 峰值','14-new-recording-policy.png','图 1　新建录制中的人声检查与短句录制设置',[
        '新建录制和已有任务均支持开启「人声幅值检查」，默认关闭。默认范围为 3000～20000 samp，上下限均检查人声绝对峰值。当前仅适配 16-bit PCM；其他项目如需 5000～25000 samp，可手动调整。dBFS 保留为单位切换，切换不改变阈值。',
        '系统基于实际保存的单声道音频，按检测器识别的人声区间计算指标，排除非人声区间。取正负采样值中的最大绝对值，不取峰峰值。峰值超过上限立即提示「声音过大」；本句结束时峰值低于下限才提示「声音偏小」。直接比较整数采样值，阈值相等不判为异常。',
    ],51)
    s.append(Spacer(1,15))
    s += section(2,'新增短句自动结束','19-auto-end-review.png','图 2　静音达到设定时长后，本句结束并进入待确认状态',[
        '「短句自动结束」与幅值检查相互独立，默认关闭。开启后，检测到有效人声且连续静音达到任务设定时长，即自动结束本句。静音时长沿用 0.2～5 秒、默认 1 秒的设置；静音达标前再次发声，将重新累计静音。',
        '自动结束时固定本句终点，后续声音不再进入该句切片；母音频持续保存。结束后须人工确认，才按原录制规则进入下一句。「完成本句」及快捷键仍可使用；无有效人声时不会自动生成空录音。停顿不足或连续多读仍可能被录入，本功能不判断朗读内容及重复次数。',
    ],62)
    s.append(PageBreak())
    s += section(3,'增加幅值异常录音确认保留','18-warning-confirmation.png','图 3　幅值异常后的试听、重录与确认保留操作区',[
        '录制结束后在正文上方固定区域显示整句人声峰值；异常以黄色图标、警告文字及本次阈值说明，不挤动正文或波形。录制中的异常提醒也会保留。短促人声也执行最终检查。采录人员可试听、重录，或在按项目要求核对后点击「确认保留并录下一句」；末句或关闭连续录制时，以当前按钮文案为准。',
        '人工保留记录随录音保存，重新打开任务后仍可查看。幅值提醒本身不阻止导出，音频中断、写盘失败等阻断问题仍须处理。重录保留历史版本，不会自动替换原合格录音。检测配置、指标、提醒、人工保留记录及结束原因随录音和导出元数据保存。',
        '截图采用模拟音频；为演示超限，峰值上限临时设为 8000 samp，该值不是项目要求。',
    ],34)
    s.append(Spacer(1,17))
    s += section(4,'同步领读面板幅值提醒','16-prompter-speech-warning.png','图 4　领读面板固定区域显示幅值提醒',[
        '主录制界面的「声音偏小」「声音过大」同步显示在领读面板的固定提示区域。提示不弹窗、不播放提示音，也不改变正文位置和显示空间，便于发音人与采录人员同步了解录制状态。',
        '本句自动结束后，领读面板显示等待状态。下一句仍须由采录人员确认后，按任务的连续录制及标签暂停规则开始。',
    ],83)
    s.append(PageBreak())
    s += section(5,'支持已有任务保存录制设置','17-task-recording-policy.png','图 5　已有任务右侧「设置」中的配置保存入口',[
        '已有任务可在右侧「设置」中修改两个开关及幅值阈值，并点击「保存录制设置」。保存后，从下一次开始录制本句生效；当前录制沿用开始时的配置。短句模式下，相关静音参数的修改也从下一次录制生效。',
        '旧任务保留原 RMS 下限／PEAK 上限规则；保存格式为 16-bit 时，可主动点击「改用 16-bit 峰值检查」。历史录音保留原结果，不补算或重新判定。旧任务缺少设置时按关闭处理；历史录音没有检测结果，表示当时未检查，不代表已达标。',
    ],83)
    s.append(Spacer(1,15))
    s += section(6,'完善授权异常时的录音封存','20-license-safe-seal.png','图 6　授权失效后的安全结束提示（模拟状态演示）',[
        '录制期间授权失效时，系统先安全停止并封存已写入的音频，再进入授权页面。封存期间保留当前录制界面；如需重试，可使用「重试封存」。采录人员应停止朗读，等待处理完成，避免强制退出或拔盘。',
        '授权页面会提示待封存任务。目录、进度数据或外接盘路径异常时，应先核对原保存位置并处理提示；异常录音不会自动确认，也不会覆盖原合格版本。系统时间或授权记录异常时，应核对时间并联系管理员。',
    ],33)
    return s

def main():
    b.register_fonts()
    for name,size,leading,color in [
        ('section',16,23,'#213C3C'),('body',10.3,16.5,'#303A3D'),('caption',8.4,13,'#667575')]:
        ST[name]=ParagraphStyle(name,fontName='PF-M',fontSize=size,leading=leading,textColor=colors.HexColor(color),wordWrap='CJK',alignment=TA_CENTER if name=='caption' else TA_LEFT)
    OUT.parent.mkdir(parents=True,exist_ok=True)
    doc=SimpleDocTemplate(str(OUT),pagesize=b.A4,leftMargin=18*mm,rightMargin=18*mm,topMargin=25*mm,bottomMargin=22*mm,title='标贝音频采集 功能更新说明',author='DataBaker',subject='人声幅值检查、短句自动结束及相关功能更新')
    doc.build(story(),onFirstPage=page,onLaterPages=page)
    r=PdfReader(OUT)
    assert len(r.pages)==3,f'Unexpected pages: {len(r.pages)}'
    print(f'{OUT}: {len(r.pages)} pages, {OUT.stat().st_size} bytes')

if __name__=='__main__': main()
