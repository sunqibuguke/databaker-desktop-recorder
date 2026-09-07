# 整体 UI 审计与代码 Review

审计日期：2026-09-07。基线：`0050e89` 加当前工作树中的未提交修改。范围包括新增幅值/短句功能、原有录制和交付流程、Electron 授权与文件边界，以及工作树中已有的外部 WAV 切分脚本。以下保留初次审计时的结论与复现证据。后续已完成 R1–R9、U1 修复，当前状态与验证见[修复验收记录](修复验收记录.md)。

初次审计结论（修复前）：录制主流程和现有自动化回归通过，但仍有 **5 项 P1、4 项 P2，以及 1 项 P3 界面一致性问题**。建议先处理输入音频保护、存储身份与授权边界，再修正提示遮挡。不能用当前绿色测试作为生产发布放行依据。

## 问题清单

### R1 · P1 · 外部切分脚本可能覆盖输入母音频

位置：[scripts/cut_external_wav.py:257](/Users/lilk/projects/databaker/桌面音频采集/scripts/cut_external_wav.py:257)、[main:348](/Users/lilk/projects/databaker/桌面音频采集/scripts/cut_external_wav.py:348)。`doc/cut_external_wav.py` 和 `doc/切段脚本示例/cut_external_wav.py` 与脚本内容完全相同，存在同一问题。

触发条件：输出目录选为输入 WAV 所在目录，时间戳中的切片文件名与输入文件同名，并启用 `--overwrite`。代码只检查普通输出冲突，没有排除输入文件，最后 `os.replace` 会替换正在读取的源路径。

本机隔离复现：构造 8,000 帧的 `source.wav`，切出其中 2,000 帧；程序返回成功，原 `source.wav` 变成 2,000 帧。证据：[复现结果](evidence/source-overwrite-result.json)。这是 macOS 实测结果，不声称 Windows 上也已复现。

修复方向：在任何写入之前，拒绝输出目标与输入 WAV、输入 JSON 指向同一文件；`--overwrite` 只允许覆盖输出切片。比较规范路径，并在目标存在时比较文件身份。补充同名输入、路径别名及三个分发副本的一致性测试。

### R2 · P1 · 激活页的“待封存扫描”会重新绑定保存位置

位置：[electron/main.ts:4464](/Users/lilk/projects/databaker/桌面音频采集/electron/main.ts:4464)、[绑定与持久化:4425](/Users/lilk/projects/databaker/桌面音频采集/electron/main.ts:4425)。这是原有代码中的问题。

当前调用链确认：`license:pending-seals` 调用 `bindAndRememberOutputRoot`；后者读取当前路径的身份，直接写入偏好及 `persistedOutputRoots`。没有先和旧的卷/目录身份比较。若外置盘或同路径目录被替换，仅打开激活页面就可能把替代目录登记成新的可信保存位置，削弱正常录制入口的身份变化保护。

修复方向：扫描只读取并验证已有绑定；身份变化应明确报错，只有用户重新选择保存位置时才能重绑。本项依据当前代码调用链确认，未对用户真实外置盘进行替换实验。

### R3 · P1 · 已安装版本没有限制“禁用授权检查”环境变量

位置：[electron/main.ts:4320](/Users/lilk/projects/databaker/桌面音频采集/electron/main.ts:4320)、[electron/license.ts:83](/Users/lilk/projects/databaker/桌面音频采集/electron/license.ts:83)。这是原有授权模块问题。

`isLicenseCheckDisabled` 只判断环境变量值，调用处没有 `app.isPackaged` 限制。生产与开发使用相同分支，因此启动环境可直接让授权状态变成有效。独立函数复现返回 `environmentBypass: true`；另已核对当前生产调用链。没有将此实验描述成真实安装包实测。

修复方向：把跳过检查限制在明确的非打包开发/测试环境，并分别测试打包和开发分支。当前 Electron 测试主动设置该环境变量，不能覆盖此风险。

### R4 · P1 · 可编辑的本地指纹记录参与机器绑定授权

位置：[electron/license.ts:202](/Users/lilk/projects/databaker/桌面音频采集/electron/license.ts:202)、[读取本地指纹:262](/Users/lilk/projects/databaker/桌面音频采集/electron/license.ts:262)。这是原有授权模块问题。

票据签名校验通过后，即使签名中的机器码与本机不同，只要本地 `componentHashes` 与当前机器足够匹配，也会接受。该本地字段没有签名或其他可信绑定。

隔离复现使用临时测试密钥与虚构机器指纹：机器 B 最初得到 `wrong_machine`；仅修改临时授权文件中的指纹数组后，同一张机器 A 的票据得到 `valid`。未使用或修改用户的真实授权文件。

修复方向：机器迁移/容错证据需要由可信签名绑定，不能让可编辑本地数组覆盖签名中的机器身份。增加跨机器文件编辑回归。

### R5 · P1 · 重新激活会清除时钟回拨保护

位置：[electron/license.ts:293](/Users/lilk/projects/databaker/桌面音频采集/electron/license.ts:293)、[覆盖时间锚点:312](/Users/lilk/projects/databaker/桌面音频采集/electron/license.ts:312)。这是原有授权模块问题。

`activate()` 不读取既有 `lastSeenAt`，校验票据时也不传入该时间，随后用当前时间覆盖原记录。隔离实验中，正常激活后把注入时钟调早 10 天，`evaluate()` 返回 `clock_rollback`；重新激活同一张票据后立即恢复 `valid`。

修复方向：激活也必须校验并保留可信的历史时间锚点；同时处理本地时间字段可编辑的问题，避免只补一个比较分支。

R3–R5 的当前复现输出：[license-result.json](evidence/license-result.json)，[独立复现脚本](evidence/reproduce-license.cjs)。

### R6 · P2 · 主窗口幅值提醒遮挡字号按钮并拦截点击

位置：[src/styles.css:638](/Users/lilk/projects/databaker/桌面音频采集/src/styles.css:638)。这是新增长期幅值提示与原有浮层布局组合产生的问题。

在 1366×768 和 1080×700 窗口中，提醒显示在录制文本工具栏上方。1366×768 下覆盖“减小正文字号”“增大正文字号”等按钮。独立浏览器点击复现失败，错误明确为 `speech-quality-banner ... intercepts pointer events`。提示会保留到本句确认，遮挡也持续存在。

修复方向：使用固定、预留的状态区域，使提示与按钮不重叠；纯提示不应拦截鼠标。仅关闭点击拦截仍不能解决视觉遮挡。证据：[截图](evidence/review-warning-1366.png)、[点击日志](evidence/ui-click.txt)、[几何数据](evidence/ui-geometry.json)。

![幅值提醒覆盖主窗口字号控件](/Users/lilk/projects/databaker/桌面音频采集/doc/审计/2026-09-07/evidence/review-warning-1366.png)

### R7 · P2 · 小尺寸提词器的幅值提醒覆盖长句首行

位置：[src/styles.css:1154](/Users/lilk/projects/databaker/桌面音频采集/src/styles.css:1154)、[提词器正文布局:1096](/Users/lilk/projects/databaker/桌面音频采集/src/styles.css:1096)。这是新增提示布局问题。

提词器允许缩至 520×360。在此尺寸下，提醒范围为 y=40～70，长句正文从 y=53 开始，首行被覆盖。幅值检查与短句模式相互独立，所以长句模式开启幅值检查也是有效使用场景。

修复方向：在最小尺寸下仍为提醒预留独立空间，并保持出现前后正文位置稳定；验证短句、长句、增大字号和多语言。证据：[几何数据](evidence/prompter-geometry.json)。

![提词器提醒遮挡长句首行](/Users/lilk/projects/databaker/桌面音频采集/doc/审计/2026-09-07/evidence/prompter-long-warning-520.png)

### R8 · P2 · 运行中授权失效后，界面没有同步进入处理流程

位置：[electron/main.ts:4325](/Users/lilk/projects/databaker/桌面音频采集/electron/main.ts:4325)、[src/ActivateLicense.tsx:52](/Users/lilk/projects/databaker/桌面音频采集/src/ActivateLicense.tsx:52)。这是原有问题，当前调用链仍存在。

主进程后续 IPC 校验能够检测过期/回拨并抛错；前端只在挂载时读取授权状态，并监听 `license:changed`。当前该事件只在激活成功时发送，失效时没有发送。因此长时间打开的应用可能继续展示已授权录制界面，操作却持续被拒绝，无法在当前流程中进入重新激活。

修复方向：主进程发布授权状态变化，前端提供明确处理入口；录制中失效时先协调安全结束和封存，不能直接卸载录制页面。此项为当前调用链审查结论，没有通过修改真实授权或系统时钟演示。

### R9 · P2 · 授权失效页面只扫描前 200 个任务的待封存录音

位置：[electron/main.ts:4469](/Users/lilk/projects/databaker/桌面音频采集/electron/main.ts:4469)。这是原有问题。

待封存列表只调用一次 `listRecordings(root, 0, HISTORY_PAGE_MAX_SIZE)`，没有继续翻页；常量为 200。当较旧的异常录制排在其后时，激活页没有该任务的紧急封存入口。文件仍保留，但界面会漏报待处理任务。

修复方向：扫描全部分页，或直接扫描所有需要封存的状态；在 201 个以上任务、异常任务位于后页的条件下验证。依据当前分页调用链确认。

### U1 · P3 · “恢复进入任务时的设置”不覆盖新增设置

位置：[src/Recorder.tsx:5527](/Users/lilk/projects/databaker/桌面音频采集/src/Recorder.tsx:5527)、[恢复函数:1714](/Users/lilk/projects/databaker/桌面音频采集/src/Recorder.tsx:1714)。属于新增表单与原设置面板的范围表达问题。

仅把 RMS 下限从 −10 改成 −20 并保存，恢复按钮仍禁用；处理函数只恢复旧的 `automationRules`。当前布局把两类设置放在同一个“设置”页，按钮名称却没有说明它只恢复下方旧规则。

建议：要么将新增任务策略纳入进入时快照和恢复操作，要么明确把按钮改为只恢复对应规则组的名称。该项不造成历史音频丢失。证据记录在 `ui-geometry.json` 的 `restore-new-policy` 条目。

## 整体界面审计覆盖

| 页面/状态 | 本轮证据与结论 |
| --- | --- |
| 首页、全局设置、授权页 | 实际渲染检查；全局设置连续 25 次 Tab 未逃逸到背景；授权失效状态链存在 R8、R9 |
| 新建任务、脚本导入、两个新增开关 | 检查默认和启用状态；1080×700、1366×768 下创建操作可达；参考值说明存在 |
| 输入试听、跳过、重试 | 实际截图和真实 Electron 回归覆盖；没有把试听片段当作句子录音 |
| 录制中、幅值提醒、自动待确认 | 实际页面和真实引擎回归；R6 影响提示期间的控件可用性 |
| 试听、重录、保留原版本、确认下一句 | 真实 Electron 回归覆盖；新增警告显式保留、版本标识与终点检查通过 |
| 任务设置、静音检测、问题面板、导出面板 | 实际页面检查；设置页存在 U1；不同设置组的生效和恢复范围还需统一表达 |
| 提词器 | 检查短句和长句、最小尺寸；发现 R7；告警不是声音提示 |
| 历史恢复、离线版本选择、交付重启核验 | 真实 Electron 回归覆盖；陈旧版本选择被拒绝；恢复后无幽灵录制 |
| 长列表、缩放 | 现有真实 Electron 用例覆盖 320/1000 条、目标分辨率和模拟 Windows 125% 缩放；不等于真实 Windows 显示器验收 |

布局方向可以保留：正文为主、左侧任务列表、右侧工具面板，主要操作集中于底部。此次最需要改善的是固定提示区域与信息层级，而不是整体换皮。另建议在“短句自动结束”旁直接显示当前静音时长及调整入口，避免操作员跨页查找决定切分行为的参数；这是可用性建议，不是阻断性缺陷。

## 代码审查覆盖与已验证保护

- React 状态与操作：开始/结束/确认/重录、快捷键、自动事件提前到达与去重、输入试听、历史查看、设置保存和页面切换。
- Electron：命令校验、录音版本协调、离线任务身份与代次、授权、输出根目录、预览、删除/重置、交付复制和回执。
- Rust：实际单声道 PCM 幅值、人声区间、短促音频最终检查、锁定采样终点、命令与自动封存串行、写入确认、VAD 失败、中断恢复和导出元数据。
- 文件工具：外部 WAV 映射、越界处理、输出冲突和临时文件发布；发现 R1。

本轮没有在测试覆盖范围内发现：自动结束后擅自确认下一句、旧结束请求结束新版本、异常重录覆盖原合格版本、幅值提醒绕过中断保护。相关断言在真实引擎和 Electron 测试中通过。

历史审计中的旧版导出复制风险已重新检查：当前 `export-deliver.ts` 使用文件身份检查、独占目标创建/发布和交付核验，相关测试通过；没有把旧的“直接复制到已有符号链接”结论照搬为当前缺陷。

可维护性风险：`Recorder.tsx` 5,661 行、`electron/main.ts` 5,671 行，`engine.rs` 22,392 行（包含大量测试）。录制状态、提示、表单和事件收敛集中在较大文件内，容易遗漏交叉状态。建议优先提取任务策略状态与录音事件协调逻辑，并用真实协议测试保护；不建议为了拆文件先重写录制引擎。

## 本轮重新执行的验证

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:electron` | 通过；含历史、授权单测、导出、IPC、录制流程、国际化和界面契约 |
| `cargo test --features system-test`（通过项目脚本） | 274 项引擎测试通过、1 项吞吐测试按默认标记忽略；11 项存储测试通过 |
| `npm run test:e2e:electron` | 18 项真实 Electron 集成测试通过 |
| `python3 scripts/test-cut-external-wav.py` | 原有 4 项测试通过，未覆盖 R1 |
| 独立审计复现 | 授权三个分支、输入 WAV 覆盖、提示拦截点击、提词器首行遮挡、恢复按钮范围 |
| 浏览器审计 | 未捕获页面异常；通过不代表不存在视觉遮挡，R6、R7 已实际发现 |

日志和截图保存在本目录的 [evidence](evidence/) 中。UI 复现使用模拟引擎；录制主流程另由真实 Electron + Rust 测试引擎验证，两者没有混称。

## 验证边界与处理顺序

本轮是代码与桌面界面的审计，不是发布认证。未执行真实 Windows 外置声卡试录、拔插、驱动延迟与断电实测；未对真实客户授权文件或真实采录数据做破坏性实验；没有做第三方依赖/供应链的完整安全评估。多语言键值回归通过，但未人工逐一验收所有语言的每个屏幕。

处理顺序建议：R1 输入母音频保护 → R2 保存位置身份 → R3–R5 授权边界 → R6–R7 提示布局 → R8–R9 失效后的安全处理与任务发现 → U1 设置范围一致性。修复后应补针对性回归；已有绿色测试不足以证明这些缺陷已消除。
