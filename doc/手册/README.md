# 操作手册维护

当前文档版本：2026-09-08，产品版本：0.2.0。

- `build_manual.py` 生成本目录的《标贝音频采集_使用手册.pdf》，含目录和界面标注。
- `build_detailed_manual_pdf.py` 生成 `output/pdf/标贝音频采集_详细操作手册_2026-09-08.pdf`，按采录步骤分章。
- 两份手册共用 `build_manual.py` 中的 `recording_policy_content`，统一设置、幅值提醒和短句自动结束说明。
- `package.json` 的 `build.extraResources` 决定安装包携带哪一版手册。更新日期文件后应同时更新此引用；已发布安装包不会自动更换手册。

## 本次同步

补充两个默认关闭的独立开关、参考阈值与生效范围、实时与最终幅值检查、人工保留和阻断问题的区别、短句自动结束后的确认流程、多读限制、历史与导出记录，以及授权异常时的安全封存。修正时间戳文件名为 `timestamps.json`，保留旧日期的详细手册作为历史文件。

## 生成与检查

需要 Python 的 `reportlab`、`Pillow`，以及 `build/fonts/` 下的 HeitiSC-Medium.ttf、SongtiSC-Regular.ttf、SongtiSC-Bold.ttf。请使用有相应字体使用权限的构建环境；字体和渲染中间文件不入库。

```sh
python3 doc/手册/build_manual.py
python3 doc/手册/build_detailed_manual_pdf.py
```

用 `pdftoppm -png` 渲染两份输出 PDF，逐页检查截图、分页、表格、中文与页脚；再用 `pypdf` 核对关键文字和安装包资源路径。只验证文字提取不能替代视觉检查。

新增截图通过当前前端和模拟引擎生成，不代表 Windows 外置声卡实录验收：

```sh
node doc/手册/capture_recording_policy.cjs
```

脚本需要项目开发依赖和 Chrome，临时使用本机 5183 端口；结束后关闭浏览器与 Vite。`captures/14` 为新建设置，`15` 为整句待确认示例，`16` 为领读面板，`17` 为已有任务保存设置，`18` 为待确认操作区特写。为触发超限提醒，演示中临时把峰值上限设为 8000 samp；设置示例展示的 3000～20000 samp 为当前项目要求，适用于 16-bit PCM。

## 新增功能快速上手

`build_update_quick_guide.py` 单独生成 `output/pdf/标贝音频采集_新增功能快速上手_2026-09-08.pdf`。这份 6 页专项手册面向采录人员，按设置、音量提醒、短句停句、确认与重录、异常处理展开，包含界面截图和停顿时间示意图。它独立于两份完整手册，不替换现有安装包资源。

```sh
python3 doc/手册/build_update_quick_guide.py
```

## 正式功能更新说明

`build_release_notes.py` 生成 `output/pdf/标贝音频采集_功能更新说明_2026-09-08.pdf`，按“改动标题、界面截图、功能说明”介绍六项变更，共 3 页。新增截图由 `capture_release_notes.cjs` 生成；该脚本沿用录制设置演示，并补充自动结束待确认画面与模拟授权封存状态。授权截图为测试事件触发的实际界面组件，不表示真实授权故障记录。

## 2026-09-08 峰值口径

新建录制默认显示 samp，按 16-bit PCM 人声最大绝对采样值判断，上下限默认 3000／20000；其他项目可改为 5000／25000。dBFS 为显示单位切换，内部保存整数阈值。偏小仅在整句结束后提示，超限立即提示；旧任务保留原 RMS／PEAK 规则，可主动切换，历史结果不重判。

AU 定义参考：<https://helpx.adobe.com/audition/desktop/editing-audio-files/displaying-audio-waveform-editor.html>。对比须使用相同 16-bit 文件及人声范围；本次未进行 AU 软件实机对照。
